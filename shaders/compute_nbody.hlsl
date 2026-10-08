/* Copyright (c) 2019-2026, Sascha Willems
 * Copyright 2020 Google LLC
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 the "License";
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Port of Vulkan-Samples' compute_nbody shaders (particle.vert/frag, particle_calculate.comp,
// particle_integrate.comp) to Donut's bindings, in one file.

// Donut's matrices (PlanarViewConstants) are row-major, for mul(vector, matrix).
#pragma pack_matrix(row_major)

#include <donut/shaders/binding_helpers.hlsli>
#include <donut/shaders/view_cb.h>

struct Particle
{
    float4 pos; // xyz = position, w = mass
    float4 vel; // xyz = velocity, w = gradient texture position
};

// --- Simulation ------------------------------------------------------------------------------

struct SimulationConstants
{
    float deltaT;
    int particleCount;
};
DECLARE_PUSH_CONSTANTS(SimulationConstants, g_Simulation, 0, 0);
RWStructuredBuffer<Particle> u_Particles : register(u0);

#define WORKGROUP_SIZE 256
// The sample's stride over the particles: each step loads only the first WORKGROUP_SIZE of every
// SHARED_DATA_SIZE particles, so a body feels a quarter of the light ones (and all the heavy
// centers, which sit at multiples of 1024). The sample looks the way it does with that; set it to
// WORKGROUP_SIZE for the full sum.
#define SHARED_DATA_SIZE 1024
// The sample's specialization constants (Vulkan only), fixed.
#define GRAVITY 0.002
#define POWER 0.75
#define SOFTEN 0.05
#define TIME_FACTOR 0.05

// Share data between compute shader invocations to speed up calculations.
groupshared float4 s_SharedData[WORKGROUP_SIZE];

// First pass: the particles' velocities, from the gravity of the others.
[numthreads(WORKGROUP_SIZE, 1, 1)]
void calculate_cs(uint3 globalId : SV_DispatchThreadID, uint3 localId : SV_GroupThreadID)
{
    const uint index = globalId.x;
    const uint particleCount = uint(g_Simulation.particleCount);
    // Out-of-range threads still take part in the group's loads and barriers.
    const bool active = index < particleCount;

    const float4 position = active ? u_Particles[index].pos : float4(0, 0, 0, 0);
    float4 acceleration = float4(0, 0, 0, 0);

    for (uint i = 0; i < particleCount; i += SHARED_DATA_SIZE)
    {
        if (i + localId.x < particleCount)
        {
            s_SharedData[localId.x] = u_Particles[i + localId.x].pos;
        }
        else
        {
            s_SharedData[localId.x] = float4(0, 0, 0, 0);
        }
        GroupMemoryBarrierWithGroupSync();

        for (int j = 0; j < WORKGROUP_SIZE; j++)
        {
            const float4 other = s_SharedData[j];
            const float3 len = other.xyz - position.xyz;
            acceleration.xyz += GRAVITY * len * other.w / pow(dot(len, len) + SOFTEN, POWER);
        }
        GroupMemoryBarrierWithGroupSync();
    }

    if (!active)
        return;

    u_Particles[index].vel.xyz += g_Simulation.deltaT * TIME_FACTOR * acceleration.xyz;

    // Gradient texture position
    u_Particles[index].vel.w += 0.1 * TIME_FACTOR * g_Simulation.deltaT;
    if (u_Particles[index].vel.w > 1.0)
    {
        u_Particles[index].vel.w -= 1.0;
    }
}

// Second pass: Euler integration of the positions.
[numthreads(WORKGROUP_SIZE, 1, 1)]
void integrate_cs(uint3 globalId : SV_DispatchThreadID)
{
    const uint index = globalId.x;
    if (index >= uint(g_Simulation.particleCount))
        return;

    u_Particles[index].pos += g_Simulation.deltaT * TIME_FACTOR * u_Particles[index].vel;
}

// --- Rendering -------------------------------------------------------------------------------

cbuffer c_View : register(b1)
{
    PlanarViewConstants g_View;
};
StructuredBuffer<Particle> t_Particles : register(t0);

// The sample draws point sprites, which D3D12 doesn't have (nor NVRHI's primitive types): each
// particle here is a screen-aligned quad of 6 vertices, pulled from the particle buffer. Clockwise
// on screen, the front faces of NVRHI's default (back face culling) raster state.
static const float2 c_QuadCorners[6] = {
    float2(-1, -1), float2(-1, 1), float2(1, 1),
    float2(-1, -1), float2(1, 1), float2(1, -1)
};

void main_vs(
    uint i_vertex : SV_VertexID,
    out float4 o_position : SV_Position,
    out float2 o_spriteCoord : TEXCOORD0,
    out float o_gradientPos : TEXCOORD1)
{
    const Particle particle = t_Particles[i_vertex / 6];
    const float2 corner = c_QuadCorners[i_vertex % 6];

    // Point size influenced by mass (stored in pos.w)
    const float spriteSize = 0.005 * particle.pos.w;
    const float4 eyePos = mul(float4(particle.pos.xyz, 1.0), g_View.matWorldToView);
    const float4 projectedCorner = mul(float4(0.5 * spriteSize, 0.5 * spriteSize, eyePos.z, eyePos.w), g_View.matViewToClip);
    const float pointSize = clamp(g_View.viewportSize.x * projectedCorner.x / projectedCorner.w, 1.0, 128.0);

    // pointSize pixels across: pointSize / viewportSize in NDC either side of the center.
    o_position = mul(eyePos, g_View.matViewToClip);
    o_position.xy += corner * pointSize * g_View.viewportSizeInv * o_position.w;

    o_spriteCoord = corner;
    o_gradientPos = particle.vel.w;
}

// The sample's textures (KTX 1, which Donut doesn't load), as tables: particle_gradient_rgba.ktx at
// every 16th texel, and particle_rgba.ktx (a gray glow) averaged at 17 distances from the center.
static const float3 c_Gradient[17] = {
    float3(0.000, 0.663, 0.878), float3(0.027, 0.541, 0.792), float3(0.075, 0.369, 0.675),
    float3(0.169, 0.224, 0.580), float3(0.357, 0.145, 0.545), float3(0.624, 0.106, 0.557),
    float3(0.855, 0.090, 0.553), float3(0.922, 0.086, 0.482), float3(0.922, 0.086, 0.357),
    float3(0.922, 0.118, 0.231), float3(0.933, 0.247, 0.176), float3(0.992, 0.510, 0.176),
    float3(0.992, 0.788, 0.176), float3(0.957, 0.914, 0.180), float3(0.655, 0.867, 0.227),
    float3(0.275, 0.722, 0.286), float3(0.012, 0.620, 0.329)
};
static const float c_Glow[17] = {
    0.931, 0.826, 0.633, 0.484, 0.377, 0.290, 0.241, 0.207, 0.175,
    0.150, 0.132, 0.111, 0.098, 0.079, 0.054, 0.030, 0.008
};

float3 SampleGradient(float u)
{
    const float x = saturate(u) * 16.0;
    const int i = min(int(x), 15);
    return lerp(c_Gradient[i], c_Gradient[i + 1], x - i);
}

float SampleGlow(float r)
{
    // The quad's corners: black, rather than the texture's faint square edges.
    if (r >= 1.0)
        return 0.0;

    const float x = r * 16.0;
    const int i = min(int(x), 15);
    return lerp(c_Glow[i], c_Glow[i + 1], x - i);
}

float4 main_ps(
    float4 i_position : SV_Position,
    float2 i_spriteCoord : TEXCOORD0,
    float i_gradientPos : TEXCOORD1) : SV_Target0
{
    const float3 color = SampleGradient(i_gradientPos);
    return float4(SampleGlow(length(i_spriteCoord)) * color, 1);
}

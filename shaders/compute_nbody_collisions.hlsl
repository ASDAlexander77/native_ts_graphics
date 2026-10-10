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

// compute_nbody.hlsl with particle collisions: the particles are spheres that bounce off each
// other (and off the heavy centers) instead of passing through.

// Donut's matrices (PlanarViewConstants) are row-major, for mul(vector, matrix).
#pragma pack_matrix(row_major)

#include <donut/shaders/binding_helpers.hlsli>
#include <donut/shaders/view_cb.h>

struct Particle
{
    float4 pos;  // xyz = position, w = mass
    float4 vel;  // xyz = velocity, w = gradient texture position
    float4 info; // x = collision radius, y = collision flash (1 on impact, fading to 0)
};

// What collide_cs found for a particle, applied by integrate_cs.
struct Contact
{
    float4 velocity; // xyz = velocity change, w = flash
    float4 shift;    // xyz = position correction
};

// --- Simulation ------------------------------------------------------------------------------

struct SimulationConstants
{
    float deltaT;
    int particleCount;
    // 0: the particles pass through each other (compute_nbody), integrate_cs ignores u_Contacts.
    int collisions;
    int padding;
};
DECLARE_PUSH_CONSTANTS(SimulationConstants, g_Simulation, 0, 0);
RWStructuredBuffer<Particle> u_Particles : register(u0);
RWStructuredBuffer<Contact> u_Contacts : register(u1);

#define WORKGROUP_SIZE 256
// The gravity pass's stride over the particles, as in compute_nbody.hlsl: a body feels a quarter
// of the light ones (and all the heavy centers, which sit at multiples of 1024).
#define SHARED_DATA_SIZE 1024
#define GRAVITY 0.002
#define POWER 0.75
#define SOFTEN 0.05
#define TIME_FACTOR 0.05

// Bounciness: 1 keeps the approach speed along the contact normal, 0 removes it. Below 1, as the
// impulses of several simultaneous contacts add up and could otherwise gain energy.
#define RESTITUTION 0.8
// Share of an overlap pushed out per frame: gravity keeps pressing the particles that rest on a
// heavy center into it, and velocity changes alone would let them sink.
#define SEPARATION 0.5
// Velocity change that makes a full flash: resting contacts (gravity's pull, undone each frame)
// stay dark, and so do the heavy centers, which a light particle hardly moves.
#define FLASH_SPEED 20.0
// Seconds a full flash takes to fade.
#define FLASH_SECONDS 0.4

// Share data between compute shader invocations to speed up calculations.
groupshared float4 s_SharedData[WORKGROUP_SIZE];
// collide_cs: the other particles' velocity (xyz) and radius (w), next to their position and mass
// in s_SharedData.
groupshared float4 s_SharedVelocity[WORKGROUP_SIZE];

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

// Second pass: collisions, against every other particle (unlike gravity, none can be skipped).
// Each particle reads the others' positions and velocities as calculate_cs left them and writes
// only its own Contact, so the order the groups run in doesn't matter; integrate_cs applies them.
// For each touching pair still approaching, the particle takes its part of the impulse of an
// elastic collision between spheres, so it bounces off along the contact normal: the lighter
// the particle, the more its direction changes (off a heavy center, it is a reflection).
[numthreads(WORKGROUP_SIZE, 1, 1)]
void collide_cs(uint3 globalId : SV_DispatchThreadID, uint3 localId : SV_GroupThreadID)
{
    const uint index = globalId.x;
    const uint particleCount = uint(g_Simulation.particleCount);
    const bool active = index < particleCount;

    const float4 position = active ? u_Particles[index].pos : float4(0, 0, 0, 0);
    const float3 velocity = active ? u_Particles[index].vel.xyz : float3(0, 0, 0);
    const float radius = active ? u_Particles[index].info.x : 0.0;

    float3 velocityChange = float3(0, 0, 0);
    float3 shift = float3(0, 0, 0);
    float flash = 0.0;

    for (uint i = 0; i < particleCount; i += WORKGROUP_SIZE)
    {
        if (i + localId.x < particleCount)
        {
            const Particle other = u_Particles[i + localId.x];
            s_SharedData[localId.x] = other.pos;
            s_SharedVelocity[localId.x] = float4(other.vel.xyz, other.info.x);
        }
        GroupMemoryBarrierWithGroupSync();

        for (uint j = 0; j < WORKGROUP_SIZE && i + j < particleCount; j++)
        {
            if (i + j == index)
                continue;

            const float4 otherPosition = s_SharedData[j];
            const float4 otherVelocity = s_SharedVelocity[j];

            // From the other particle to this one.
            const float3 offset = position.xyz - otherPosition.xyz;
            const float reach = radius + otherVelocity.w;
            const float distanceSquared = dot(offset, offset);
            if (distanceSquared >= reach * reach || distanceSquared < 1e-12)
                continue;

            const float dist = sqrt(distanceSquared);
            const float3 normal = offset / dist;
            // This particle's share of the pair's change: the other's mass over the total.
            const float share = otherPosition.w / (position.w + otherPosition.w);

            // Negative while the two close in. Pairs already separating keep their velocities,
            // or a pair would bounce back and forth while it still overlaps.
            const float approach = dot(velocity - otherVelocity.xyz, normal);
            if (approach < 0.0)
            {
                const float bounce = -(1.0 + RESTITUTION) * share * approach;
                velocityChange += bounce * normal;
                flash = max(flash, saturate(bounce / FLASH_SPEED));
            }

            shift += SEPARATION * share * (reach - dist) * normal;
        }
        GroupMemoryBarrierWithGroupSync();
    }

    if (!active)
        return;

    // In a dense pile the corrections of many neighbors add up: at most a radius per frame, or a
    // particle can land deep inside others and pump energy into the pile.
    const float shiftLength = length(shift);
    if (shiftLength > radius)
    {
        shift *= radius / shiftLength;
    }

    Contact contact;
    contact.velocity = float4(velocityChange, flash);
    contact.shift = float4(shift, 0.0);
    u_Contacts[index] = contact;
}

// Last pass: the collisions, then Euler integration of the positions.
[numthreads(WORKGROUP_SIZE, 1, 1)]
void integrate_cs(uint3 globalId : SV_DispatchThreadID)
{
    const uint index = globalId.x;
    if (index >= uint(g_Simulation.particleCount))
        return;

    Particle particle = u_Particles[index];

    if (g_Simulation.collisions != 0)
    {
        const Contact contact = u_Contacts[index];
        particle.vel.xyz += contact.velocity.xyz;
        particle.pos.xyz += contact.shift.xyz;
        particle.info.y = max(particle.info.y, contact.velocity.w);
    }

    particle.pos.xyz += g_Simulation.deltaT * TIME_FACTOR * particle.vel.xyz;
    particle.info.y = max(particle.info.y - g_Simulation.deltaT / FLASH_SECONDS, 0.0);

    u_Particles[index] = particle;
}

// --- Rendering -------------------------------------------------------------------------------

cbuffer c_View : register(b1)
{
    PlanarViewConstants g_View;
};
StructuredBuffer<Particle> t_Particles : register(t0);

// The sprite's half size, in collision radii: the solid ball fills the inner half, its glow the rest.
#define SPRITE_EXTENT 2.0

// Each particle is a screen-aligned quad of 6 vertices, pulled from the particle buffer. Clockwise
// on screen, the front faces of NVRHI's default (back face culling) raster state.
static const float2 c_QuadCorners[6] = {
    float2(-1, -1), float2(-1, 1), float2(1, 1),
    float2(-1, -1), float2(1, 1), float2(1, -1)
};

void main_vs(
    uint i_vertex : SV_VertexID,
    out float4 o_position : SV_Position,
    out float2 o_spriteCoord : TEXCOORD0,
    out float o_gradientPos : TEXCOORD1,
    out float o_flash : TEXCOORD2)
{
    const Particle particle = t_Particles[i_vertex / 6];
    const float2 corner = c_QuadCorners[i_vertex % 6];

    // Sized in the world, unlike compute_nbody's mass-sized sprites, so that the balls touch on
    // screen when they collide. At least a pixel across, so distant ones don't flicker.
    const float4 eyePos = mul(float4(particle.pos.xyz, 1.0), g_View.matWorldToView);
    o_position = mul(eyePos, g_View.matViewToClip);
    const float halfSize = SPRITE_EXTENT * particle.info.x;
    const float2 ndcHalfSize = max(halfSize * float2(g_View.matViewToClip[0][0], g_View.matViewToClip[1][1]) / o_position.w,
        2.0 * g_View.viewportSizeInv);
    o_position.xy += corner * ndcHalfSize * o_position.w;

    o_spriteCoord = corner;
    o_gradientPos = particle.vel.w;
    o_flash = particle.info.y;
}

// compute_nbody's textures (particle_gradient_rgba.ktx at every 16th texel, and particle_rgba.ktx
// averaged at 17 distances from the center), as tables.
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
    if (r >= 1.0)
        return 0.0;

    const float x = r * 16.0;
    const int i = min(int(x), 15);
    return lerp(c_Glow[i], c_Glow[i + 1], x - i);
}

float4 main_ps(
    float4 i_position : SV_Position,
    float2 i_spriteCoord : TEXCOORD0,
    float i_gradientPos : TEXCOORD1,
    float i_flash : TEXCOORD2) : SV_Target0
{
    // Flashing white after an impact.
    const float3 color = lerp(SampleGradient(i_gradientPos), float3(1, 1, 1), i_flash);

    const float r = length(i_spriteCoord);
    // Inside the collision radius: a ball, brighter towards its center. Outside: a faint glow.
    const float ballR = r * SPRITE_EXTENT;
    const float brightness = ballR < 1.0
        ? 0.35 + 0.65 * sqrt(1.0 - ballR * ballR)
        : 0.5 * SampleGlow(r);
    return float4(brightness * color, 1);
}

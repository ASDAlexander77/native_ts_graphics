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
    float4 info; // x = collision radius, y = heat (collisions add it, it cools off over time),
                 // z = contacts this frame (count_cs)
};

// What collide_cs found for a particle, applied by integrate_cs.
struct Contact
{
    float4 velocity; // xyz = velocity change, w = heat gained
    float4 shift;    // xyz = position correction
};

// --- Simulation ------------------------------------------------------------------------------

// Only in the compute entries (-D SIMULATION=1 in the .cfg): fxc warns about groupshared in
// the vertex and pixel shaders.
#ifdef SIMULATION

struct SimulationConstants
{
    float deltaT;
    int particleCount;
    // 0: the particles pass through each other (compute_nbody), integrate_cs ignores u_Contacts.
    int collisions;
    // 0: collisions add no heat (the particles still cool off).
    int heating;
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

// Bounciness: 1 keeps the approach speed along the contact normal, 0 removes it.
#define RESTITUTION 0.8
// Share of an overlap pushed out per frame: gravity keeps pressing the particles that rest on a
// heavy center into it, and velocity changes alone would let them sink.
#define SEPARATION 0.5
// The kinetic energy a bounce loses, 1/2 mu (1 - RESTITUTION^2) approach^2 for the pair's reduced
// mass mu, becomes heat. A particle's temperature rises by that over its own mass (heat capacity
// grows with mass): 1/2 share (1 - RESTITUTION^2) approach^2, so a light particle hit hard glows
// and a heavy center, whose share is tiny, stays cold. Resting contacts (gravity's pull, undone
// each frame) approach slowly and add next to nothing.
#define HEAT_FACTOR 0.004
// Seconds for the heat to fall to 1/e: the energy radiates away, it never turns back into speed.
#define COOL_SECONDS 3.0

// Share data between compute shader invocations to speed up calculations.
groupshared float4 s_SharedData[WORKGROUP_SIZE];
// count_cs and collide_cs: the other particles' velocity (xyz) and radius (w), next to their
// position and mass in s_SharedData.
groupshared float4 s_SharedVelocity[WORKGROUP_SIZE];
// collide_cs: the other particles' contact counts.
groupshared float s_SharedContacts[WORKGROUP_SIZE];

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

// Whether a pair touches this step: overlapping now, or apart but closing in so fast that it would
// cross within the step and never be seen overlapping. Then t is the first touch, |offset + motion
// * t| = reach for t in [0, 1]. Both particles of a pair get the same answer (offset and motion
// change sign), so they count the same contacts.
bool FindContact(float3 offset, float3 relativeVelocity, float reach, float step, out bool overlapping, out float t)
{
    const float distanceSquared = dot(offset, offset);
    overlapping = distanceSquared < reach * reach;
    t = 0.0;
    if (distanceSquared < 1e-12)
        return false;
    if (overlapping)
        return true;

    const float3 motion = step * relativeVelocity;
    const float a = dot(motion, motion);
    const float b = dot(offset, motion);
    const float c = distanceSquared - reach * reach;
    const float discriminant = b * b - a * c;
    // Closing in (b < 0) and the line comes within reach (discriminant >= 0).
    if (b >= 0.0 || discriminant < 0.0)
        return false;
    t = (-b - sqrt(discriminant)) / a;
    return t <= 1.0;
}

// Loads WORKGROUP_SIZE particles' positions, velocities and radii into the shared arrays, from i on.
void LoadShared(uint i, uint localId, uint particleCount)
{
    if (i + localId < particleCount)
    {
        const uint other = i + localId;
        s_SharedData[localId] = u_Particles[other].pos;
        s_SharedVelocity[localId] = float4(u_Particles[other].vel.xyz, u_Particles[other].info.x);
    }
}

// Second pass: how many particles each one touches this step, into info.z for collide_cs.
[numthreads(WORKGROUP_SIZE, 1, 1)]
void count_cs(uint3 globalId : SV_DispatchThreadID, uint3 localId : SV_GroupThreadID)
{
    const uint index = globalId.x;
    const uint particleCount = uint(g_Simulation.particleCount);
    const bool active = index < particleCount;

    const float3 position = active ? u_Particles[index].pos.xyz : float3(0, 0, 0);
    const float3 velocity = active ? u_Particles[index].vel.xyz : float3(0, 0, 0);
    const float radius = active ? u_Particles[index].info.x : 0.0;
    const float step = g_Simulation.deltaT * TIME_FACTOR;

    uint contacts = 0;
    for (uint i = 0; i < particleCount; i += WORKGROUP_SIZE)
    {
        LoadShared(i, localId.x, particleCount);
        GroupMemoryBarrierWithGroupSync();

        for (uint j = 0; j < WORKGROUP_SIZE && i + j < particleCount; j++)
        {
            bool overlapping;
            float t;
            if (i + j != index && FindContact(position - s_SharedData[j].xyz, velocity - s_SharedVelocity[j].xyz,
                radius + s_SharedVelocity[j].w, step, overlapping, t))
            {
                contacts++;
            }
        }
        GroupMemoryBarrierWithGroupSync();
    }

    if (active)
    {
        u_Particles[index].info.z = float(contacts);
    }
}

// Third pass: collisions, against every other particle (unlike gravity, none can be skipped).
// Each particle reads the others' positions and velocities as calculate_cs left them and writes
// only its own Contact, so the order the groups run in doesn't matter; integrate_cs applies them.
// For each touching pair still approaching, the particle takes its part of the impulse of an
// elastic collision between spheres, so it bounces off along the contact normal: the lighter
// the particle, the more its direction changes (off a heavy center, it is a reflection).
//
// All the contacts of a step are resolved at once, from the velocities before any of them: a
// particle between two others closing in would take both full impulses, -2.6 times its speed, and
// as the clouds fall into each other the next step multiplies that again (a fast particle sweeps
// past several within one step). So each pair's impulse is divided by the larger contact count of
// the two: a particle's velocity change is at most its largest single bounce, and both particles
// of a pair still take equal and opposite momentum.
[numthreads(WORKGROUP_SIZE, 1, 1)]
void collide_cs(uint3 globalId : SV_DispatchThreadID, uint3 localId : SV_GroupThreadID)
{
    const uint index = globalId.x;
    const uint particleCount = uint(g_Simulation.particleCount);
    const bool active = index < particleCount;

    const float4 position = active ? u_Particles[index].pos : float4(0, 0, 0, 0);
    const float3 velocity = active ? u_Particles[index].vel.xyz : float3(0, 0, 0);
    const float radius = active ? u_Particles[index].info.x : 0.0;
    const float contacts = active ? u_Particles[index].info.z : 0.0;

    // integrate_cs's step: how far a velocity moves a particle this frame.
    const float step = g_Simulation.deltaT * TIME_FACTOR;

    float3 velocityChange = float3(0, 0, 0);
    float3 shift = float3(0, 0, 0);
    // Position corrections of the swept contacts, exact, so not limited as the overlaps' are.
    float3 sweepShift = float3(0, 0, 0);
    float heat = 0.0;

    for (uint i = 0; i < particleCount; i += WORKGROUP_SIZE)
    {
        LoadShared(i, localId.x, particleCount);
        if (i + localId.x < particleCount)
        {
            s_SharedContacts[localId.x] = u_Particles[i + localId.x].info.z;
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
            const float3 relativeVelocity = velocity - otherVelocity.xyz;
            bool overlapping;
            float t;
            if (!FindContact(offset, relativeVelocity, reach, step, overlapping, t))
                continue;

            // This particle's share of the pair's change: the other's mass over the total.
            const float share = otherPosition.w / (position.w + otherPosition.w);
            // And the pair's part of the busier particle's contacts (both counted this one).
            const float impulseShare = share / max(max(contacts, s_SharedContacts[j]), 1.0);

            if (!overlapping)
            {
                // Apart now: bounce the pair at the first touch, with the contact normal and
                // approach speed there.
                const float3 normal = (offset + step * relativeVelocity * t) / reach;
                const float approach = dot(relativeVelocity, normal);
                if (approach >= 0.0)
                    continue;
                const float bounce = -(1.0 + RESTITUTION) * impulseShare * approach;
                velocityChange += bounce * normal;
                heat += HEAT_FACTOR * 0.5 * impulseShare * (1.0 - RESTITUTION * RESTITUTION) * approach * approach;
                // integrate_cs moves the particle the whole step with the new velocity, but it
                // had the old one until the touch: take back that part of the step.
                sweepShift -= t * step * bounce * normal;
                continue;
            }

            const float dist = length(offset);
            const float3 normal = offset / dist;

            // Negative while the two close in. Pairs already separating keep their velocities,
            // or a pair would bounce back and forth while it still overlaps.
            const float approach = dot(relativeVelocity, normal);
            if (approach < 0.0)
            {
                const float bounce = -(1.0 + RESTITUTION) * impulseShare * approach;
                velocityChange += bounce * normal;
                heat += HEAT_FACTOR * 0.5 * impulseShare * (1.0 - RESTITUTION * RESTITUTION) * approach * approach;
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
    contact.velocity = float4(velocityChange, g_Simulation.heating != 0 ? heat : 0.0);
    contact.shift = float4(shift + sweepShift, 0.0);
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
        particle.info.y += contact.velocity.w;
    }

    particle.pos.xyz += g_Simulation.deltaT * TIME_FACTOR * particle.vel.xyz;
    particle.info.y *= exp(-g_Simulation.deltaT / COOL_SECONDS);

    u_Particles[index] = particle;
}

#endif // SIMULATION

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
    out float o_heat : TEXCOORD2)
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
    o_heat = particle.info.y;
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
    float i_heat : TEXCOORD2) : SV_Target0
{
    // Heat saturates here, not where it is added up: a few hard hits still read as hotter than one.
    // The color goes from its own through red-orange and yellow to white, and the ball brightens.
    const float glow = 1.0 - exp(-i_heat);
    float3 color = SampleGradient(i_gradientPos);
    color = lerp(color, float3(1.0, 0.25, 0.04), saturate(glow * 3.0));
    color = lerp(color, float3(1.0, 0.85, 0.5), saturate(glow * 3.0 - 1.0));
    color = lerp(color, float3(1.0, 1.0, 1.0), saturate(glow * 3.0 - 2.0));

    const float r = length(i_spriteCoord);
    // Inside the collision radius: a ball, brighter towards its center. Outside: a faint glow.
    const float ballR = r * SPRITE_EXTENT;
    const float brightness = ballR < 1.0
        ? 0.35 + 0.65 * sqrt(1.0 - ballR * ballR)
        : 0.5 * SampleGlow(r);
    return float4(brightness * (1.0 + 0.3 * glow) * color, 1);
}

// --- Axis gizmo ------------------------------------------------------------------------------

// The orientation axes in a corner of the screen: segments (2D endpoints in pixels from the top
// left, and a color), each drawn as a quad of 6 vertices, computed by the application every frame
// from the camera's rotation.
#define GIZMO_MAX_SEGMENTS 16
// Half the width of a segment, in pixels.
#define GIZMO_HALF_WIDTH 1.5

cbuffer c_Gizmo : register(b2)
{
    float4 g_GizmoHeader; // xy = 1 / viewport size
    float4 g_GizmoPoints[GIZMO_MAX_SEGMENTS]; // x0, y0, x1, y1
    float4 g_GizmoColors[GIZMO_MAX_SEGMENTS];
};

static const uint c_GizmoQuadIndex[6] = { 0, 1, 2, 0, 2, 3 };

void axis_vs(
    uint i_vertex : SV_VertexID,
    out float4 o_position : SV_Position,
    out float4 o_color : TEXCOORD0)
{
    const uint segment = i_vertex / 6;
    const float2 halfViewport = 0.5 / g_GizmoHeader.xy;

    // In pixels from the center of the viewport, y up.
    const float4 points = g_GizmoPoints[segment];
    const float2 p0 = float2(points.x - halfViewport.x, halfViewport.y - points.y);
    const float2 p1 = float2(points.z - halfViewport.x, halfViewport.y - points.w);

    float2 along = p1 - p0;
    const float length_ = length(along);
    along = length_ > 1e-4 ? along / length_ : float2(1, 0);
    // The quad is clockwise on screen (the front faces), and goes past the ends by the half width.
    const float2 across = float2(-along.y, along.x) * GIZMO_HALF_WIDTH;
    along *= GIZMO_HALF_WIDTH;

    const float2 corners[4] = { p0 - along - across, p0 - along + across, p1 + along + across, p1 + along - across };
    const float2 position = corners[c_GizmoQuadIndex[i_vertex % 6]];

    o_position = float4(position * g_GizmoHeader.xy * 2.0, 0.0, 1.0);
    o_color = g_GizmoColors[segment];
}

float4 axis_ps(
    float4 i_position : SV_Position,
    float4 i_color : TEXCOORD0) : SV_Target0
{
    return i_color;
}

// --- Coordinate planes -----------------------------------------------------------------------

// The XY, XZ and YZ planes through the origin, each a square grid of world-space lines, tinted by
// its normal (Z blue, Y green, X red, as the gizmo's axes). Lines are quads of 6 vertices, built
// from the vertex ID alone, and drawn with the view constants (b1) the particles use.
#define PLANE_HALF_LINES 6
#define PLANE_LINES_PER_DIRECTION (2 * PLANE_HALF_LINES + 1)
#define PLANE_LINES_PER_PLANE (2 * PLANE_LINES_PER_DIRECTION)
#define PLANE_LINE_COUNT (3 * PLANE_LINES_PER_PLANE)
// World distance between lines, and half the width of a line in pixels.
#define PLANE_SPACING 2.0
#define PLANE_HALF_WIDTH 0.75
#define PLANE_NEAR 0.1

void plane_vs(
    uint i_vertex : SV_VertexID,
    out float4 o_position : SV_Position,
    out float4 o_color : TEXCOORD0)
{
    const uint line_ = i_vertex / 6;
    const uint plane = line_ / PLANE_LINES_PER_PLANE;
    const uint inPlane = line_ % PLANE_LINES_PER_PLANE;
    const uint direction = inPlane / PLANE_LINES_PER_DIRECTION;
    const int index = int(inPlane % PLANE_LINES_PER_DIRECTION) - PLANE_HALF_LINES;

    // The line at offset u along one in-plane axis, spanning the grid along the other.
    const float u = index * PLANE_SPACING;
    const float extent = PLANE_HALF_LINES * PLANE_SPACING;
    const float2 a = direction == 0 ? float2(u, -extent) : float2(-extent, u);
    const float2 b = direction == 0 ? float2(u, extent) : float2(extent, u);

    // Plane 0 is XY, 1 is XZ, 2 is YZ.
    float3 p0 = plane == 0 ? float3(a.x, a.y, 0) : (plane == 1 ? float3(a.x, 0, a.y) : float3(0, a.x, a.y));
    float3 p1 = plane == 0 ? float3(b.x, b.y, 0) : (plane == 1 ? float3(b.x, 0, b.y) : float3(0, b.x, b.y));

    // To view space, where the depth is w: cut the line at the near plane (a grid reaching behind
    // the camera would otherwise flip across the screen).
    float4 e0 = mul(float4(p0, 1.0), g_View.matWorldToView);
    float4 e1 = mul(float4(p1, 1.0), g_View.matWorldToView);
    if (e0.z < PLANE_NEAR && e1.z < PLANE_NEAR)
    {
        o_position = float4(2, 2, 0, 1);
        o_color = 0;
        return;
    }
    if (e0.z < PLANE_NEAR)
        e0 = lerp(e0, e1, (PLANE_NEAR - e0.z) / (e1.z - e0.z));
    if (e1.z < PLANE_NEAR)
        e1 = lerp(e1, e0, (PLANE_NEAR - e1.z) / (e0.z - e1.z));

    const float4 c0 = mul(e0, g_View.matViewToClip);
    const float4 c1 = mul(e1, g_View.matViewToClip);

    // In pixels from the center of the viewport, y up, then as the gizmo's segments.
    const float2 halfViewport = 0.5 / g_View.viewportSizeInv;
    const float2 s0 = c0.xy / c0.w * halfViewport;
    const float2 s1 = c1.xy / c1.w * halfViewport;
    float2 along = s1 - s0;
    const float length_ = length(along);
    along = length_ > 1e-4 ? along / length_ : float2(1, 0);
    const float2 across = float2(-along.y, along.x) * PLANE_HALF_WIDTH;
    along *= PLANE_HALF_WIDTH;

    const float2 corners[4] = { s0 - along - across, s0 - along + across, s1 + along + across, s1 + along - across };
    const float2 position = corners[c_GizmoQuadIndex[i_vertex % 6]];
    o_position = float4(position * g_View.viewportSizeInv * 2.0, 0.0, 1.0);

    // The outermost lines and the ones through the origin (the axes) stand out.
    const bool emphasized = abs(index) == PLANE_HALF_LINES || index == 0;
    float3 tint = plane == 0 ? float3(0.3, 0.3, 1.0) : (plane == 1 ? float3(0.3, 1.0, 0.3) : float3(1.0, 0.3, 0.3));
    o_color = float4(tint, emphasized ? 0.45 : 0.15);
}

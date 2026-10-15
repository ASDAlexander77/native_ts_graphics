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
    float4 info; // x = collision radius (negative: merged into another particle, gone), y = heat (collisions add it, it cools off over time),
                 // z = contacts this frame (count_cs)
    float4 spin;   // xyz = angular velocity (radians per simulated second)
    float4 marker; // xyz = a direction fixed in the particle, turned by the spin: the render draws
                   // a mark at its two poles, so the spin shows
};

// What collide_cs found for a particle, applied by integrate_cs.
struct Contact
{
    float4 velocity; // xyz = velocity change, w = heat gained
    float4 shift;    // xyz = position correction, w = 1 if the particle is merging with another
    float4 spin;     // xyz = angular velocity change (friction), w = the particle it merges into (its own
                     // index if none dominates it: it absorbs the merging ones that name it)
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
    // Set from the application's UI, which can change them while the simulation runs.
    float timeFactor;
    float gravity;
    // Bounciness: 1 keeps the approach speed along the contact normal, 0 removes it.
    float restitution;
    // Share of the kinetic energy a bounce loses that becomes heat (see collide_cs).
    float heatFactor;
    // Seconds for the heat to fall to 1/e: the energy radiates away, it never turns back into speed.
    float coolSeconds;
    // Coulomb friction between touching particles: the tangential impulse is at most this times the
    // normal one. 0: smooth spheres, which never spin.
    float friction;
    // Particles touching slower than this (relative speed) merge instead of bouncing: the one with
    // more mass (the lower index of two equal ones) absorbs the other, keeping the mass and the
    // momentum. 0: they never merge.
    float mergeSpeed;
    // 0: the gravity pass samples the particles as compute_nbody does (a body feels a quarter of the
    // light ones), which is not symmetric: the total momentum is not kept. 1: every pair, with the
    // same pull both ways, so the momentum and the angular momentum are kept.
    int fullGravity;
};
DECLARE_PUSH_CONSTANTS(SimulationConstants, g_Simulation, 0, 0);
RWStructuredBuffer<Particle> u_Particles : register(u0);
RWStructuredBuffer<Contact> u_Contacts : register(u1);

#define WORKGROUP_SIZE 256
// The gravity pass's stride over the particles, as in compute_nbody.hlsl: a body feels a quarter
// of the light ones (and all the heavy centers, which sit at multiples of 1024). Every pair
// (fullGravity) steps by a workgroup instead.
#define SHARED_DATA_SIZE 1024
#define POWER 0.75
#define SOFTEN 0.05

// Share of an overlap pushed out per frame: gravity keeps pressing the particles that rest on a
// heavy center into it, and velocity changes alone would let them sink.
#define SEPARATION 0.5
// The kinetic energy a bounce loses, 1/2 mu (1 - restitution^2) approach^2 for the pair's reduced
// mass mu, becomes heat. A particle's temperature rises by that over its own mass (heat capacity
// grows with mass): 1/2 share (1 - restitution^2) approach^2, so a light particle hit hard glows
// and a heavy center, whose share is tiny, stays cold. Resting contacts (gravity's pull, undone
// each frame) approach slowly and add next to nothing.

// Share data between compute shader invocations to speed up calculations.
groupshared float4 s_SharedData[WORKGROUP_SIZE];
// count_cs and collide_cs: the other particles' velocity (xyz) and radius (w), next to their
// position and mass in s_SharedData.
groupshared float4 s_SharedVelocity[WORKGROUP_SIZE];
// collide_cs: the other particles' spin.
groupshared float4 s_SharedSpin[WORKGROUP_SIZE];
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

    const uint stride = g_Simulation.fullGravity != 0 ? WORKGROUP_SIZE : SHARED_DATA_SIZE;
    for (uint i = 0; i < particleCount; i += stride)
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
            acceleration.xyz += g_Simulation.gravity * len * other.w / pow(dot(len, len) + SOFTEN, POWER);
        }
        GroupMemoryBarrierWithGroupSync();
    }

    if (!active)
        return;

    u_Particles[index].vel.xyz += g_Simulation.deltaT * g_Simulation.timeFactor * acceleration.xyz;

    // Gradient texture position
    u_Particles[index].vel.w += 0.1 * g_Simulation.timeFactor * g_Simulation.deltaT;
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
        s_SharedSpin[localId] = u_Particles[other].spin;
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
    const float step = g_Simulation.deltaT * g_Simulation.timeFactor;

    uint contacts = 0;
    for (uint i = 0; i < particleCount; i += WORKGROUP_SIZE)
    {
        LoadShared(i, localId.x, particleCount);
        GroupMemoryBarrierWithGroupSync();

        for (uint j = 0; j < WORKGROUP_SIZE && i + j < particleCount; j++)
        {
            bool overlapping;
            float t;
            if (i + j != index && radius >= 0.0 && s_SharedVelocity[j].w >= 0.0
                && FindContact(position - s_SharedData[j].xyz, velocity - s_SharedVelocity[j].xyz,
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

// Coulomb friction at a contact of two solid spheres (inertia 2/5 m r^2), for the particle that
// looks at the pair: `normal` points from the other to it, and the surfaces slip at the contact by
// the velocity difference plus the spins' part, normal x (r w + r' w'). The friction impulse opposes
// the slip, up to friction times the normal impulse, and no more than what stops the slip (an
// impulse over that would reverse it: 3.5 over the reduced mass for spheres). It changes the
// particle's velocity and, by the torque at the surface, its spin, and what it dissipates is heat.
// impulseShare is as in the normal impulse (the particle's share of the pair, over the contacts).
void ApplyFriction(float3 normal, float3 relativeVelocity, float approach, float impulseShare, float radius,
    float3 spin, float otherRadius, float3 otherSpin, inout float3 velocityChange, inout float3 spinChange,
    inout float heat)
{
    const float3 slip = relativeVelocity + cross(normal, radius * spin + otherRadius * otherSpin);
    const float3 tangential = slip - dot(slip, normal) * normal;
    const float slipSpeed = length(tangential);
    if (slipSpeed < 1e-6)
        return;

    const float strength = min(g_Simulation.friction * (1.0 + g_Simulation.restitution) * -approach, slipSpeed / 3.5);
    const float3 direction = tangential / slipSpeed;
    velocityChange -= impulseShare * strength * direction;
    spinChange += 2.5 * impulseShare * strength * cross(normal, direction) / radius;
    heat += g_Simulation.heatFactor * 0.5 * impulseShare * strength * slipSpeed;
}

// Whether particle a (mass and index) takes the other in a merge: more mass, or the lower index.
bool Dominates(float massA, uint indexA, float massB, uint indexB)
{
    return massA > massB || (massA == massB && indexA < indexB);
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
    const float3 spin = active ? u_Particles[index].spin.xyz : float3(0, 0, 0);
    const float radius = active ? u_Particles[index].info.x : 0.0;
    const float contacts = active ? u_Particles[index].info.z : 0.0;

    // integrate_cs's step: how far a velocity moves a particle this frame.
    const float step = g_Simulation.deltaT * g_Simulation.timeFactor;

    float3 velocityChange = float3(0, 0, 0);
    float3 spinChange = float3(0, 0, 0);
    float3 shift = float3(0, 0, 0);
    // Position corrections of the swept contacts, exact, so not limited as the overlaps' are.
    float3 sweepShift = float3(0, 0, 0);
    float heat = 0.0;
    // Merging: the most massive of the touching particles that dominate this one (or itself).
    bool merging = false;
    uint mergeTarget = index;
    float mergeTargetMass = position.w;

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
            if (i + j == index || radius < 0.0 || s_SharedVelocity[j].w < 0.0)
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
                const float bounce = -(1.0 + g_Simulation.restitution) * impulseShare * approach;
                velocityChange += bounce * normal;
                heat += g_Simulation.heatFactor * 0.5 * impulseShare * (1.0 - g_Simulation.restitution * g_Simulation.restitution) * approach * approach;
                ApplyFriction(normal, relativeVelocity, approach, impulseShare, radius, spin, otherVelocity.w,
                    s_SharedSpin[j].xyz, velocityChange, spinChange, heat);
                // integrate_cs moves the particle the whole step with the new velocity, but it
                // had the old one until the touch: take back that part of the step.
                sweepShift -= t * step * bounce * normal;
                continue;
            }

            // Touching slowly enough, the two merge instead (absorb_cs, kill_cs): no bounce or push.
            if (g_Simulation.mergeSpeed > 0.0 && length(relativeVelocity) < g_Simulation.mergeSpeed)
            {
                merging = true;
                if (Dominates(otherPosition.w, i + j, position.w, index)
                    && (mergeTarget == index || Dominates(otherPosition.w, i + j, mergeTargetMass, mergeTarget)))
                {
                    mergeTarget = i + j;
                    mergeTargetMass = otherPosition.w;
                }
                continue;
            }

            const float dist = length(offset);
            const float3 normal = offset / dist;

            // Negative while the two close in. Pairs already separating keep their velocities,
            // or a pair would bounce back and forth while it still overlaps.
            const float approach = dot(relativeVelocity, normal);
            if (approach < 0.0)
            {
                const float bounce = -(1.0 + g_Simulation.restitution) * impulseShare * approach;
                velocityChange += bounce * normal;
                heat += g_Simulation.heatFactor * 0.5 * impulseShare * (1.0 - g_Simulation.restitution * g_Simulation.restitution) * approach * approach;
                ApplyFriction(normal, relativeVelocity, approach, impulseShare, radius, spin, otherVelocity.w,
                    s_SharedSpin[j].xyz, velocityChange, spinChange, heat);
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
    contact.shift = float4(shift + sweepShift, merging ? 1.0 : 0.0);
    contact.spin = float4(spinChange, float(mergeTarget));
    u_Contacts[index] = contact;
}

// A particle's merge: it absorbs the particles that name it as their target, when it is its own
// (nothing touching it dominates it). A particle whose target has a target of its own waits: its
// chain is merged a step at a time. The survivor takes the sum of the masses and the volumes, the
// mass-weighted position, velocity and heat, a spin that keeps the angular momentum about the new
// center (the orbits and the spins), and the translational kinetic energy the merge loses is heat.
// The survivor and the absorbed take their own collision impulses (Contact, from the particles that
// bounce off them) before they merge, and the survivor's are then spent: an absorbed particle's
// would be lost with it, and the particle it bounced off would keep its half of the impulse.
// Only the survivors write, and only the particles they read (the absorbed) are not survivors.
[numthreads(WORKGROUP_SIZE, 1, 1)]
void absorb_cs(uint3 globalId : SV_DispatchThreadID)
{
    const uint index = globalId.x;
    const uint particleCount = uint(g_Simulation.particleCount);
    if (index >= particleCount)
        return;

    const Contact own = u_Contacts[index];
    Particle particle = u_Particles[index];
    if (own.shift.w == 0.0 || uint(own.spin.w) != index || particle.info.x < 0.0)
        return;

    float mass = particle.pos.w;
    float3 position = particle.pos.xyz + own.shift.xyz;
    float3 velocity = particle.vel.xyz + own.velocity.xyz;
    float3 spin = particle.spin.xyz + own.spin.xyz;
    float heat = particle.info.y + own.velocity.w;
    float volume = particle.info.x * particle.info.x * particle.info.x;
    bool absorbed = false;

    for (uint j = 0; j < particleCount; j++)
    {
        const Contact other = u_Contacts[j];
        if (j == index || other.shift.w == 0.0 || uint(other.spin.w) != index)
            continue;
        const Particle victim = u_Particles[j];
        if (victim.info.x < 0.0)
            continue;

        const float victimMass = victim.pos.w;
        const float3 victimPosition = victim.pos.xyz + other.shift.xyz;
        const float3 victimVelocity = victim.vel.xyz + other.velocity.xyz;
        const float3 victimSpin = victim.spin.xyz + other.spin.xyz;
        const float victimHeat = victim.info.y + other.velocity.w;

        const float total = mass + victimMass;
        const float3 lost = velocity - victimVelocity;
        heat = (mass * heat + victimMass * victimHeat) / total;
        if (g_Simulation.heating != 0)
            heat += g_Simulation.heatFactor * 0.5 * (victimMass / total) * dot(lost, lost);
        const float3 newPosition = (mass * position + victimMass * victimPosition) / total;
        const float3 newVelocity = (mass * velocity + victimMass * victimVelocity) / total;
        const float victimVolume = victim.info.x * victim.info.x * victim.info.x;
        const float newRadius = pow(volume + victimVolume, 1.0 / 3.0);

        // The angular momentum about the new center: the two bodies' orbits about it, and their own
        // spins (solid spheres, 2/5 m r^2), all go into the merged sphere's spin.
        const float3 angularMomentum =
            mass * cross(position - newPosition, velocity - newVelocity)
            + victimMass * cross(victimPosition - newPosition, victimVelocity - newVelocity)
            + 0.4 * mass * pow(volume, 2.0 / 3.0) * spin
            + 0.4 * victimMass * victim.info.x * victim.info.x * victimSpin;
        spin = angularMomentum / (0.4 * total * newRadius * newRadius);

        position = newPosition;
        velocity = newVelocity;
        volume += victimVolume;
        mass = total;
        absorbed = true;
    }

    if (!absorbed)
        return;
    particle.pos = float4(position, mass);
    particle.vel.xyz = velocity;
    particle.spin.xyz = spin;
    particle.info.x = pow(volume, 1.0 / 3.0);
    particle.info.y = heat;
    u_Particles[index] = particle;

    // Spent (integrate_cs adds them): keep the flag and the target, which kill_cs reads.
    Contact spent = own;
    spent.velocity = float4(0, 0, 0, 0);
    spent.shift.xyz = float3(0, 0, 0);
    spent.spin.xyz = float3(0, 0, 0);
    u_Contacts[index] = spent;
}

// After absorb_cs: the particles that were absorbed are gone (a negative radius, no mass, nothing
// drawn or collided with).
[numthreads(WORKGROUP_SIZE, 1, 1)]
void kill_cs(uint3 globalId : SV_DispatchThreadID)
{
    const uint index = globalId.x;
    if (index >= uint(g_Simulation.particleCount))
        return;

    const Contact own = u_Contacts[index];
    const uint target = uint(own.spin.w);
    if (own.shift.w == 0.0 || target == index)
        return;
    // Its target is merging into another: this one waits for the next step.
    if (uint(u_Contacts[target].spin.w) != target)
        return;

    Particle particle = u_Particles[index];
    particle.pos.w = 0.0;
    particle.vel.xyz = float3(0, 0, 0);
    particle.spin.xyz = float3(0, 0, 0);
    particle.info = float4(-1.0, 0.0, 0.0, 0.0);
    u_Particles[index] = particle;
}

// Last pass: the collisions, then Euler integration of the positions.
[numthreads(WORKGROUP_SIZE, 1, 1)]
void integrate_cs(uint3 globalId : SV_DispatchThreadID)
{
    const uint index = globalId.x;
    if (index >= uint(g_Simulation.particleCount))
        return;

    Particle particle = u_Particles[index];
    if (particle.info.x < 0.0)
        return;

    if (g_Simulation.collisions != 0)
    {
        const Contact contact = u_Contacts[index];
        particle.vel.xyz += contact.velocity.xyz;
        particle.pos.xyz += contact.shift.xyz;
        particle.info.y += contact.velocity.w;
        particle.spin.xyz += contact.spin.xyz;
    }

    particle.pos.xyz += g_Simulation.deltaT * g_Simulation.timeFactor * particle.vel.xyz;

    // The marker turns about the spin axis (Rodrigues' formula, exact for any step).
    const float spinSpeed = length(particle.spin.xyz);
    if (spinSpeed > 1e-6)
    {
        const float angle = spinSpeed * g_Simulation.deltaT * g_Simulation.timeFactor;
        const float3 axis = particle.spin.xyz / spinSpeed;
        const float3 marker = particle.marker.xyz;
        particle.marker.xyz = normalize(marker * cos(angle) + cross(axis, marker) * sin(angle)
            + axis * dot(axis, marker) * (1.0 - cos(angle)));
    }
    particle.info.y *= exp(-g_Simulation.deltaT / g_Simulation.coolSeconds);

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
    out float o_heat : TEXCOORD2,
    out float3 o_marker : TEXCOORD3)
{
    const Particle particle = t_Particles[i_vertex / 6];
    const float2 corner = c_QuadCorners[i_vertex % 6];
    if (particle.info.x < 0.0)
    {
        // Merged into another particle: a degenerate quad, off screen.
        o_position = float4(2, 2, 0, 1);
        o_spriteCoord = 0;
        o_gradientPos = 0;
        o_heat = 0;
        o_marker = 0;
        return;
    }

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
    o_marker = mul(float4(particle.marker.xyz, 0.0), g_View.matWorldToView).xyz;
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
    float i_heat : TEXCOORD2,
    float3 i_marker : TEXCOORD3) : SV_Target0
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

    // A lit ball: its surface normal in view space (z away from the camera), a light from the upper
    // left in front, and a highlight (white, brighter on the cool ones: a hot ball glows over it).
    // Outside the ball, the faint glow.
    float brightness = 0.5 * SampleGlow(r);
    float highlight = 0.0;
    float mark = 0.0;
    if (ballR < 1.0)
    {
        const float3 normal = float3(i_spriteCoord * SPRITE_EXTENT, -sqrt(1.0 - ballR * ballR));
        const float3 toLight = normalize(float3(-0.45, 0.55, -0.7));
        brightness = 0.2 + 0.9 * saturate(dot(normal, toLight));
        // Half way between the light and the viewer (at -z).
        highlight = 0.5 * pow(saturate(dot(normal, normalize(toLight + float3(0, 0, -1)))), 24.0) * (1.0 - saturate(glow * 3.0));
        // A dark mark at the two poles of the particle's marker direction, so a spinning ball shows it.
        mark = smoothstep(0.8, 0.9, abs(dot(normal, i_marker)));
    }
    return float4(brightness * (1.0 - 0.6 * mark) * (1.0 + 0.3 * glow) * color + highlight, 1);
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

// --- Trails ----------------------------------------------------------------------------------

// A streak behind each particle, along its velocity: a quad of 6 vertices from the head (the
// particle, as wide as its ball on screen) to the tail, narrowing and fading out, in the color of
// the particle's gradient position. The same particle buffer and view constants as the balls (b1,
// t0), and the application's length.
cbuffer c_Trail : register(b3)
{
    // x = the world distance a unit of velocity stretches to (the time scale, times the seconds the
    // trail covers), y = the head's opacity.
    float4 g_Trail;
};

void trail_vs(
    uint i_vertex : SV_VertexID,
    out float4 o_position : SV_Position,
    out float4 o_color : TEXCOORD0)
{
    const Particle particle = t_Particles[i_vertex / 6];
    o_position = float4(2, 2, 0, 1);
    o_color = 0;

    const float4 e0 = mul(float4(particle.pos.xyz, 1.0), g_View.matWorldToView);
    const float4 e1 = mul(float4(particle.pos.xyz - particle.vel.xyz * g_Trail.x, 1.0), g_View.matWorldToView);
    // Not drawn when either end is behind the camera, or the particle has merged away.
    if (e0.z < PLANE_NEAR || e1.z < PLANE_NEAR || particle.info.x < 0.0)
        return;

    const float4 c0 = mul(e0, g_View.matViewToClip);
    const float4 c1 = mul(e1, g_View.matViewToClip);
    const float2 halfViewport = 0.5 / g_View.viewportSizeInv;
    const float2 s0 = c0.xy / c0.w * halfViewport;
    const float2 s1 = c1.xy / c1.w * halfViewport;

    float2 along = s1 - s0;
    const float length_ = length(along);
    // Shorter than a pixel: nothing to see.
    if (length_ < 1.0)
        return;
    along /= length_;

    // The head as wide as the ball (its radius over the depth, in pixels), at least a pixel.
    const float radiusPixels = particle.info.x * g_View.matViewToClip[1][1] / e0.z * halfViewport.y;
    const float2 across = float2(-along.y, along.x) * clamp(0.8 * radiusPixels, 0.75, 8.0);

    const float2 corners[4] = { s0 - across, s0 + across, s1 + across * 0.1, s1 - across * 0.1 };
    const uint corner = c_GizmoQuadIndex[i_vertex % 6];
    o_position = float4(corners[corner] * g_View.viewportSizeInv * 2.0, 0.0, 1.0);
    // Corners 0 and 1 are the head, 2 and 3 the tail.
    o_color = float4(SampleGradient(particle.vel.w), corner < 2 ? g_Trail.y : 0.0);
}

// --- Composite: the HDR frame and its bloom into the back buffer ------------------------------

Texture2D t_Hdr : register(t4);
Texture2D t_Bloom : register(t5);
SamplerState s_Linear : register(s0);

// A triangle over the screen, its vertices winding clockwise on the screen (Donut's front faces).
void composite_vs(uint vertexId : SV_VertexID, out float4 position : SV_Position, out float2 uv : TEXCOORD0)
{
    float2 pos;
    if (vertexId == 0)
        pos = float2(-1.0, -1.0);
    else if (vertexId == 1)
        pos = float2(3.0, -1.0);
    else
        pos = float2(-1.0, 3.0);

    uv = pos * 0.5 + 0.5;
    position = float4(pos.x, -pos.y, 0.0, 1.0);
}

// The particles add up above 1 (a pile of them, a hot one with its glow): a soft shoulder from
// KNEE on, per channel, so the colors below it are as they were and the rest saturates smoothly.
#define KNEE 0.8

float4 composite_ps(float4 position : SV_Position, float2 uv : TEXCOORD0) : SV_Target
{
    const float3 color = t_Hdr.SampleLevel(s_Linear, uv, 0.0).rgb + t_Bloom.SampleLevel(s_Linear, uv, 0.0).rgb;
    const float3 over = max(color - KNEE, 0.0);
    return float4(min(color, KNEE) + (1.0 - KNEE) * (1.0 - exp(-over / (1.0 - KNEE))), 1.0);
}

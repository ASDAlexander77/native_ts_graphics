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
                 // z = contacts this frame, weighted by how much they move it (count_cs), w = the radius
                 // it grows to this step, towards marker.w (collide_cs, integrate_cs)
    float4 spin;   // xyz = angular velocity (radians per simulated second), w = moment of inertia over
                   // the mass: 2/5 r^2 for a solid sphere; a merged particle's is its parts' about
                   // their center of mass (absorb_cs), whatever radius it collides with
    float4 marker; // xyz = a direction fixed in the particle, turned by the spin: the render draws
                   // a mark at its two poles, so the spin shows; w = its true radius, for its volume
                   // (a merged particle grows to it from info.x, see collide_cs)
};

// What collide_cs found for a particle, applied by integrate_cs.
struct Contact
{
    float4 velocity; // xyz = velocity change, w = heat gained
    float4 shift;    // xyz = position correction (swept contacts; overlaps with the contact springs
                     // off), w = 1 if the particle is merging with another
    float4 spin;     // xyz = angular velocity change (friction), w = the particle it merges into (its own
                     // index if none dominates it: it absorbs the merging ones that name it)
    float4 fragment; // w = 1 if the particle breaks in two (fragment_cs); xyz = the direction the halves
                     // fly apart in, times the speed they do
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
    // A particle hit harder than this (approach speed along the contact normal) breaks in two, if
    // there is a free slot for the second half (one merged away, or left free at the start).
    // 0: they never break.
    float fragmentSpeed;
    // 1: overlapping particles push apart by the contact springs; 0: they are moved apart
    // (SEPARATION of the overlap a step), which doesn't keep the angular momentum.
    int contactSprings;
    float pad1;
    float pad2;
};
DECLARE_PUSH_CONSTANTS(SimulationConstants, g_Simulation, 0, 0);
RWStructuredBuffer<Particle> u_Particles : register(u0);
RWStructuredBuffer<Contact> u_Contacts : register(u1);
// The free slots for the fragments: [0] = how many (collect_free_cs), [1] = how many are taken
// (fragment_cs), then their indices. The application zeroes the counts every step.
RWStructuredBuffer<uint> u_Free : register(u2);

#define WORKGROUP_SIZE 256
// The gravity pass's stride over the particles, as in compute_nbody.hlsl: a body feels a quarter
// of the light ones (and all the heavy centers, which sit at multiples of 1024). Every pair
// (fullGravity) steps by a workgroup instead.
#define SHARED_DATA_SIZE 1024
#define POWER 0.75
#define SOFTEN 0.05
// Only particles from FRAGMENT_MIN_RADIUS (the smallest light ones once split are under it, so they
// don't split again) to FRAGMENT_MAX_RADIUS (not the heavy centers) break.
#define FRAGMENT_MIN_RADIUS 0.035
#define FRAGMENT_MAX_RADIUS 0.3

// Overlapping particles push each other apart as with a spring between their centers: equal and
// opposite along the line between them, so the momentum and the angular momentum are kept (moving
// them apart, as before, kept neither the angular momentum nor the energy straight). Its
// stiffness is set by the step: w0 step = sqrt(CONTACT_STIFFNESS) for the spring's angular frequency
// w0 over the pair's reduced mass, so a pair's velocity changes by CONTACT_STIFFNESS overlap / step
// per step, whatever the masses and the time scale. Low enough for the explicit steps to stay stable
// with many contacts at once (w0 step under 2 / sqrt(contacts): 16 at 0.5), high enough that the
// pile's weight presses the particles into each other by a few percent of their reach. The overlap
// it pushes on is at most CONTACT_OVERLAP_MAX of the reach: a particle merged and grown into its
// neighbors is pushed out over several steps, not flung.
#define CONTACT_STIFFNESS 0.25
#define CONTACT_OVERLAP_MAX 0.5
// The spring's damping ratio, while the two part: critical, so a particle pushed out of another
// doesn't fly off, and resting contacts settle. Each pair's damping is divided among the contacts as
// the bounces are, so that over many contacts it stays under the particle's speed (added up, it
// overshot and blew up). What it takes is heat, as a bounce's loss is. Fast impacts bounce before
// they overlap (FindContact), at the bounciness; an overlapping pair that parts loses its speed.
#define CONTACT_DAMPING 1.0
// A merged particle short of its true size grows into its neighbors by this much of its true radius
// per step (collide_cs, absorb_cs), paid from its heat. Per step, as the springs' stiffness and
// damping are: a contact driven every step loses about a third of what the growth pays to the
// step's kick and drift (damping resets the approach each step), so the faster it grows, the more
// energy leaks. At this rate the merges' energy stays within 3%, and merged particles reach their
// true size within a few seconds.
#define GROWTH_PER_STEP 0.004
// With the contact springs off: the share of an overlap pushed out per step, by moving the particles.
#define SEPARATION 0.5
// The kinetic energy a contact loses becomes heat, all of it: a bounce, friction's slip and the
// springs' damping (PairHeat), a merge, less what a break turns back into motion. Of a pair's loss,
// each particle takes its share of the pair's change (the other's mass over the total: the two
// shares add up to 1), and its temperature (info.y) rises by that energy over its mass, times
// heatFactor. So a light particle hit by a heavy one takes nearly all the heat and glows, and a
// heavy center stays cold. Resting contacts (gravity's pull, undone each frame) add next to nothing.

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

    // A particle merged away (negative radius) stays where it was absorbed, which integrate_cs no
    // longer moves: its velocity would only pile up the gravity there, frame after frame.
    if (!active || u_Particles[index].info.x < 0.0)
        return;

    // Kept for collide_cs (which then writes the whole Contact): with the contact springs off, the
    // work its push-outs do against the gravity.
    u_Contacts[index].velocity = float4(acceleration.xyz, 0.0);
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

// Second pass: how many particles each one touches this step, into info.z for collide_cs. Each
// contact counts by how much it moves the particle: min(1, 2 share), its share of the pair's change
// being the other's mass over the total. Two equal masses count 1 each; a light particle on a heavy
// one counts 1, the heavy one next to nothing, so a light particle bouncing off a heavy center that
// touches a hundred others doesn't get a hundredth of its bounce. As min(1, 2 share) >= share, a
// particle's velocity change is still at most a full bounce (see collide_cs).
[numthreads(WORKGROUP_SIZE, 1, 1)]
void count_cs(uint3 globalId : SV_DispatchThreadID, uint3 localId : SV_GroupThreadID)
{
    const uint index = globalId.x;
    const uint particleCount = uint(g_Simulation.particleCount);
    const bool active = index < particleCount;

    const float3 position = active ? u_Particles[index].pos.xyz : float3(0, 0, 0);
    const float mass = active ? u_Particles[index].pos.w : 0.0;
    const float3 velocity = active ? u_Particles[index].vel.xyz : float3(0, 0, 0);
    const float radius = active ? u_Particles[index].info.x : 0.0;
    const float step = g_Simulation.deltaT * g_Simulation.timeFactor;

    float contacts = 0.0;
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
                const float share = s_SharedData[j].w / (mass + s_SharedData[j].w);
                contacts += min(1.0, 2.0 * share);
            }
        }
        GroupMemoryBarrierWithGroupSync();
    }

    if (active)
    {
        u_Particles[index].info.z = contacts;
    }
}

// The heat a pair's loss gives this particle: the pair's relative speed along one direction goes
// from `before` to `after`, which loses 1/2 m_eff (before^2 - after^2) for the pair's effective mass
// along it (`massFactor` times the reduced mass mu = m share). This particle takes share of that
// energy, so its temperature rises by heatFactor share^2 massFactor / 2 (before^2 - after^2).
float PairHeat(float share, float massFactor, float before, float after)
{
    return g_Simulation.heatFactor * 0.5 * share * share * massFactor * max(before * before - after * after, 0.0);
}

// The pair's relative speed along the normal after this particle's part of a bounce: the bounce
// changes it by (1 + e) |approach| divided among the contacts (impulseShare / share of it).
float AfterBounce(float approach, float restitution, float share, float impulseShare)
{
    return approach - (1.0 + restitution) * approach * (impulseShare / share);
}

// Coulomb friction at a contact of two particles, for the particle that looks at the pair: `normal`
// points from the other to it, `offset` is from the other's center to its own; spin.w is each one's
// inertia over its mass (Particle). The contact point is on the line between the centers, split by
// the radii (each lever is its radius over the reach of the offset): so the spins' torques undo the
// pair's orbital torque, offset x impulse, exactly, and the angular momentum is kept even while the
// two overlap. The surfaces slip at the contact by the velocity difference plus the spins' parts.
// The impulse opposes the slip, up to friction times the normal impulse, and no more than what
// stops the slip: an impulse J slows the slip by J / mu times 1 + share r^2 / inertia, for each
// (3.5 for two solid spheres). It changes the particle's velocity and, by the torque at the surface,
// its spin, and what it dissipates is heat, as for an effective mass of mu over that factor.
// impulseShare is as in the normal impulse (the particle's share of the pair, over the contacts).
void ApplyFriction(float3 normal, float3 offset, float reach, float3 relativeVelocity, float approach,
    float restitution, float share, float impulseShare, float radius, float4 spin, float otherRadius,
    float4 otherSpin, inout float3 velocityChange, inout float3 spinChange, inout float heat)
{
    // From each center to the contact point.
    const float3 lever = -offset * (radius / reach);
    const float3 otherLever = offset * (otherRadius / reach);
    const float3 slip = relativeVelocity + cross(spin.xyz, lever) - cross(otherSpin.xyz, otherLever);
    const float3 tangential = slip - dot(slip, normal) * normal;
    const float slipSpeed = length(tangential);
    if (slipSpeed < 1e-6)
        return;

    // The other's share of the pair is 1 - share.
    const float factor = 1.0 + share * dot(lever, lever) / spin.w
        + (1.0 - share) * dot(otherLever, otherLever) / otherSpin.w;
    const float strength = min(g_Simulation.friction * (1.0 + restitution) * -approach, slipSpeed / factor);
    const float3 direction = tangential / slipSpeed;
    velocityChange -= impulseShare * strength * direction;
    // The torque lever x impulse over the inertia, per unit of the particle's mass.
    spinChange -= impulseShare * strength * cross(lever, direction) / spin.w;
    heat += PairHeat(share, 1.0 / factor, slipSpeed, slipSpeed - factor * strength * (impulseShare / share));
}

// Keeps the hardest impact over g_Simulation.fragmentSpeed of a particle that can break: the
// halves part along the contact normal (approach is the negative approach speed along it), at a
// speed w whose kinetic energy, 1/8 m w^2, is half the heat the impact gives the particle (1/2 m
// share^2 (before^2 - after^2), PairHeat): fragment_cs takes it back out of the heat, so breaking
// keeps the energy (at bounciness 1, nothing is lost and the halves don't part).
void RecordImpact(float3 normal, float approach, float restitution, float share, float impulseShare, float radius,
    inout float hardestImpact, inout float3 fragmentVelocity, inout bool fragmenting)
{
    if (g_Simulation.fragmentSpeed <= 0.0 || radius < FRAGMENT_MIN_RADIUS || radius > FRAGMENT_MAX_RADIUS
        || -approach <= hardestImpact)
        return;
    const float after = AfterBounce(approach, restitution, share, impulseShare);
    hardestImpact = -approach;
    fragmentVelocity = normal * (share * sqrt(2.0 * max(approach * approach - after * after, 0.0)));
    fragmenting = true;
}

// The energy the contact springs hold between two particles overlapping by `overlap` (of their
// reach), for their reduced mass mu: the spring pushes with mu CONTACT_STIFFNESS overlap / step^2,
// up to CONTACT_OVERLAP_MAX of the reach, and no harder beyond.
float SpringEnergy(float overlap, float reach, float mu, float step)
{
    if (overlap <= 0.0 || step <= 0.0)
        return 0.0;
    const float stiffness = mu * CONTACT_STIFFNESS / (step * step);
    const float cap = CONTACT_OVERLAP_MAX * reach;
    const float inner = min(overlap, cap);
    return 0.5 * stiffness * inner * inner + stiffness * cap * max(overlap - cap, 0.0);
}

// The spring energy between a particle (position, radius, mass) and another.
float SpringEnergyWith(float3 position, float radius, float mass, Particle other, float step)
{
    const float reach = radius + other.info.x;
    const float overlap = reach - length(position - other.pos.xyz);
    return SpringEnergy(overlap, reach, mass * other.pos.w / (mass + other.pos.w), step);
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
// the two (counted by how much each contact moves the particle, count_cs): a particle's velocity
// change is at most a full bounce, and both particles of a pair still take equal and opposite
// momentum.
[numthreads(WORKGROUP_SIZE, 1, 1)]
void collide_cs(uint3 globalId : SV_DispatchThreadID, uint3 localId : SV_GroupThreadID)
{
    const uint index = globalId.x;
    const uint particleCount = uint(g_Simulation.particleCount);
    const bool active = index < particleCount;

    const float4 position = active ? u_Particles[index].pos : float4(0, 0, 0, 0);
    const float3 velocity = active ? u_Particles[index].vel.xyz : float3(0, 0, 0);
    const float4 spin = active ? u_Particles[index].spin : float4(0, 0, 0, 1);
    const float radius = active ? u_Particles[index].info.x : 0.0;
    const float contacts = active ? u_Particles[index].info.z : 0.0;
    // The room it has to grow into: the nearest other particle's surface.
    float clearance = 1.0e30;
    // A merged particle short of its true size (marker.w) can also grow into its neighbors, by
    // GROWTH_PER_STEP: the energy the contact springs would gain with them then.
    const float trueRadius = active ? u_Particles[index].marker.w : 0.0;
    const float pushedRadius = min(trueRadius, radius + GROWTH_PER_STEP * trueRadius);
    float growthEnergy = 0.0;
    // The gravity's pull on it this step (calculate_cs).
    const float3 gravity = active ? u_Contacts[index].velocity.xyz : float3(0, 0, 0);

    // integrate_cs's step: how far a velocity moves a particle this frame.
    const float step = g_Simulation.deltaT * g_Simulation.timeFactor;

    float3 velocityChange = float3(0, 0, 0);
    float3 spinChange = float3(0, 0, 0);
    // Position corrections of the swept contacts.
    float3 sweepShift = float3(0, 0, 0);
    // With the contact springs off: the overlaps' push-out.
    float3 shift = float3(0, 0, 0);
    float heat = 0.0;
    // Each pair's heat is the energy its impulse takes as if it were the particle's only one, but the
    // impulses of a step add up: the particle's kinetic energy changes by m v . sum + 1/2 m sum^2, not
    // by the pairs' 1/2 m impulse^2 each. The difference (a heavy particle hit from two sides at once,
    // the lights bouncing off it at the speed it no longer has) is taken from the heat, or given to
    // it, after the loop. So: the spring pushes (not impulses: a force, energy of their own), and
    // the sums of the impulses' squares.
    float3 springPushes = float3(0, 0, 0);
    float impulseSquares = 0.0;
    float spinSquares = 0.0;
    // Merging: the most massive of the touching particles that dominate this one (or itself).
    bool merging = false;
    uint mergeTarget = index;
    float mergeTargetMass = position.w;
    // Fragmenting: the hardest impact over fragmentSpeed, its normal and the speed the halves part at.
    float hardestImpact = g_Simulation.fragmentSpeed;
    float3 fragmentVelocity = float3(0, 0, 0);
    bool fragmenting = false;

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
            // Closing in, a neighbor counts where it gets to this step (integrate_cs grows the
            // particle, then moves both).
            const float3 apart = position.xyz - s_SharedData[j].xyz;
            const float gap = length(apart);
            const float closing = gap > 0.0 ? min(dot(velocity - s_SharedVelocity[j].xyz, apart) / gap, 0.0) : 0.0;
            clearance = min(clearance, gap + step * closing - s_SharedVelocity[j].w);
            if (pushedRadius > radius && g_Simulation.contactSprings != 0 && step > 0.0)
            {
                // Not with a slow pair: it merges when they touch, and has no spring.
                const float otherRadius = s_SharedVelocity[j].w;
                const bool merges = g_Simulation.mergeSpeed > 0.0
                    && length(velocity - s_SharedVelocity[j].xyz) < g_Simulation.mergeSpeed;
                if (!merges)
                {
                    const float mu = position.w * s_SharedData[j].w / (position.w + s_SharedData[j].w);
                    growthEnergy += SpringEnergy(pushedRadius + otherRadius - gap, pushedRadius + otherRadius, mu, step)
                        - SpringEnergy(radius + otherRadius - gap, radius + otherRadius, mu, step);
                }
            }

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
            const float3 velocityBefore = velocityChange;
            const float3 spinBefore = spinChange;

            if (!overlapping)
            {
                // Apart now: bounce the pair at the first touch, with the contact normal, approach
                // speed and offset there.
                const float3 touchOffset = offset + step * relativeVelocity * t;
                const float3 normal = touchOffset / reach;
                const float approach = dot(relativeVelocity, normal);
                if (approach >= 0.0)
                    continue;
                const float restitution = g_Simulation.restitution;
                RecordImpact(normal, approach, restitution, share, impulseShare, radius, hardestImpact,
                    fragmentVelocity, fragmenting);
                const float bounce = -(1.0 + restitution) * impulseShare * approach;
                velocityChange += bounce * normal;
                heat += PairHeat(share, 1.0, approach, AfterBounce(approach, restitution, share, impulseShare));
                ApplyFriction(normal, touchOffset, reach, relativeVelocity, approach, restitution, share, impulseShare,
                    radius, spin, otherVelocity.w, s_SharedSpin[j], velocityChange, spinChange, heat);
                // integrate_cs moves the particle the whole step with the new velocity, but it
                // had the old one until the touch: take back that part of the step, for the bounce
                // and the friction both. Then the impulses act where the two touched, which keeps
                // the angular momentum.
                sweepShift -= t * step * (velocityChange - velocityBefore);
                impulseSquares += dot(velocityChange - velocityBefore, velocityChange - velocityBefore);
                spinSquares += dot(spinChange - spinBefore, spinChange - spinBefore);
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
                // With the push-outs (contact springs off), an overlapping pair still closing in stops
                // along the normal instead of bouncing: the push-out lifts it back out without a
                // velocity change, and bouncing off as well gave back the speed gravity's pull put
                // in, every step, which added energy to a resting pile.
                const float restitution = g_Simulation.contactSprings != 0 ? g_Simulation.restitution : 0.0;
                RecordImpact(normal, approach, restitution, share, impulseShare, radius, hardestImpact,
                    fragmentVelocity, fragmenting);
                const float bounce = -(1.0 + restitution) * impulseShare * approach;
                velocityChange += bounce * normal;
                heat += PairHeat(share, 1.0, approach, AfterBounce(approach, restitution, share, impulseShare));
                ApplyFriction(normal, offset, reach, relativeVelocity, approach, restitution, share, impulseShare,
                    radius, spin, otherVelocity.w, s_SharedSpin[j], velocityChange, spinChange, heat);
            }

            if (g_Simulation.contactSprings == 0)
            {
                shift += SEPARATION * share * (reach - dist) * normal;
            }
            else if (step > 0.0)
            {
                const float overlap = min(reach - dist, CONTACT_OVERLAP_MAX * reach);
                // Damped while they part (approach > 0), divided among the contacts (impulseShare).
                const float damping = approach > 0.0 ? 2.0 * CONTACT_DAMPING * sqrt(CONTACT_STIFFNESS) * approach : 0.0;
                const float3 push = share * CONTACT_STIFFNESS * overlap / step * normal;
                springPushes += push;
                velocityChange += push - impulseShare * damping * normal;
                // The parting speed it takes, approach down by d (divided among the contacts), is heat.
                // Only while they part: with no damping, approach^2 - approach^2 can come out a
                // rounding below 0 (fused multiply-add), which made heat negative.
                if (damping > 0.0)
                    heat += PairHeat(share, 1.0, approach, approach - (impulseShare / share) * damping);
                impulseSquares -= 2.0 * dot(velocityChange - velocityBefore, push) - dot(push, push);
            }
            impulseSquares += dot(velocityChange - velocityBefore, velocityChange - velocityBefore);
            spinSquares += dot(spinChange - spinBefore, spinChange - spinBefore);
        }
        GroupMemoryBarrierWithGroupSync();
    }

    if (!active)
        return;
    // The impulses' cross terms (see springPushes): their energy, per unit of mass, comes out of the heat.
    const float3 impulses = velocityChange - springPushes;
    heat -= g_Simulation.heatFactor * 0.5 * (dot(impulses, impulses) - impulseSquares
        + spin.w * (dot(spinChange, spinChange) - spinSquares));

    // The radius integrate_cs gives it (info.w). A merged particle short of its true size grows
    // into the free room around it for nothing; in a pile, where there is none, by GROWTH_PER_STEP
    // into its neighbors, paying the energy that gives their springs from its heat (a merge's heat
    // is what it released). With too little heat it waits; with heating off it grows anyway. Not
    // while it merges (absorb_cs moves it and fits its radius to its new place).
    if (radius >= 0.0)
    {
        float grown = merging ? radius : max(radius, min(trueRadius, clearance));
        if (!merging && pushedRadius > grown)
        {
            const float heatEnergy = g_Simulation.heatFactor > 0.0
                ? (u_Particles[index].info.y + heat) * position.w / g_Simulation.heatFactor : 0.0;
            if (g_Simulation.heating == 0)
            {
                grown = pushedRadius;
            }
            else if (growthEnergy <= heatEnergy)
            {
                grown = pushedRadius;
                heat -= g_Simulation.heatFactor * growthEnergy / position.w;
            }
        }
        u_Particles[index].info.w = grown;
    }

    Contact contact;
    // In a dense pile the push-outs of many neighbors add up: at most a radius per step.
    const float shiftLength = length(shift);
    if (shiftLength > radius)
        shift *= radius / shiftLength;
    // A push-out moves the particle without a velocity change: lifting it against the gravity raises
    // the potential energy by m gravity . -shift, for nothing. Its heat pays for that (and gets what
    // a push-out down the pull frees), so the push-outs don't pump energy into a pile; integrate_cs
    // keeps the heat from going below 0, where the push-out still adds what the heat can't pay.
    heat += g_Simulation.heatFactor * dot(gravity, shift);
    contact.velocity = float4(velocityChange, g_Simulation.heating != 0 ? heat : 0.0);
    contact.shift = float4(shift + sweepShift, merging ? 1.0 : 0.0);
    contact.spin = float4(spinChange, float(mergeTarget));
    // A particle merging this step doesn't also break.
    contact.fragment = float4(fragmentVelocity, fragmenting && !merging ? 1.0 : 0.0);
    u_Contacts[index] = contact;
}

// The gravity's potential energy between two particles a distance apart, from their merged state:
// 2 G m m' ((r^2 + SOFTEN)^(1/4) - SOFTEN^(1/4)), whose slope is the gravity pass's pull. A merge
// releases it, a break creates it.
float PairPotential(float distance, float mass, float otherMass)
{
    return 2.0 * g_Simulation.gravity * mass * otherMass
        * (sqrt(sqrt(distance * distance + SOFTEN)) - sqrt(sqrt(SOFTEN)));
}

// A particle's merge: it absorbs the particles that name it as their target, when it is its own
// (nothing touching it dominates it). A particle whose target has a target of its own waits: its
// chain is merged a step at a time. The survivor takes the sum of the masses and of the true
// volumes (marker.w), the mass-weighted position, velocity and heat, the parts' inertia about the
// new center (spin.w), and a spin that keeps the angular momentum about it (the orbits and the
// spins). The kinetic energy the merge loses (motion and spins) is heat, spread over the merged
// mass, and so is the gravity's potential energy it releases: the pair's own (PairPotential), and
// the change with every other particle as the two masses move to their center.
//
// The merged sphere doesn't take its true size at once, which would reach into particles none of
// the merging ones touched, and the contact springs would push them out with energy from nowhere:
// it keeps the larger of the merging radii, no more than the room at its center, and grows from
// there (collide_cs: into free room, or slowly into its neighbors, paid from its heat). The springs
// the merging particles had with the others end: their energy is heat.
//
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
    float inertia = particle.spin.w;
    float heat = particle.info.y + own.velocity.w;
    float radius = particle.info.x;
    float trueVolume = particle.marker.w * particle.marker.w * particle.marker.w;
    bool absorbed = false;
    // The survivor as it was, for the contact springs it had with the others.
    const float3 survivorPosition = position;
    const float survivorRadius = radius;
    const float survivorMass = mass;
    const float step = g_Simulation.deltaT * g_Simulation.timeFactor;
    const bool springs = g_Simulation.contactSprings != 0 && step > 0.0;
    // The energy in the springs the merging particles had with the others, which the merge ends.
    float springsBefore = 0.0;

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
        const float victimInertia = victim.spin.w;
        const float victimHeat = victim.info.y + other.velocity.w;
        const float victimRadius = victim.info.x;

        const float total = mass + victimMass;
        heat = (mass * heat + victimMass * victimHeat) / total;
        const float3 newPosition = (mass * position + victimMass * victimPosition) / total;
        if (g_Simulation.heating != 0)
        {
            // The gravity's potential energy the merge releases: the pair's own, and what moving the
            // two masses to their center changes with every other particle (the ones absorbed
            // before this one are in `position`). Only with gravity between all pairs: the sampled
            // one has no potential energy.
            const bool potential = g_Simulation.fullGravity != 0;
            float released = potential ? PairPotential(length(victimPosition - position), mass, victimMass) : 0.0;
            for (uint k = 0; k < particleCount; k++)
            {
                if (k == index || k == j)
                    continue;
                const float4 neighbor = u_Particles[k].pos;
                if (u_Particles[k].info.x < 0.0)
                    continue;
                const Contact neighborContact = u_Contacts[k];
                const bool merging = neighborContact.shift.w != 0.0 && uint(neighborContact.spin.w) == index;
                if (k < j && merging)
                    continue;
                if (potential)
                    released += PairPotential(length(position - neighbor.xyz), mass, neighbor.w)
                        + PairPotential(length(victimPosition - neighbor.xyz), victimMass, neighbor.w)
                        - PairPotential(length(newPosition - neighbor.xyz), total, neighbor.w);
                if (springs && !merging)
                    springsBefore += SpringEnergyWith(victimPosition, victimRadius, victimMass, u_Particles[k], step);
            }
            heat += g_Simulation.heatFactor * released / total;
        }
        const float3 newVelocity = (mass * velocity + victimMass * victimVelocity) / total;
        const float newRadius = max(radius, victimRadius);

        // The angular momentum about the new center: the two bodies' orbits about it, and their own
        // spins, all go into the merged particle's spin. Its inertia is the two's about that center
        // (each one's own, and its mass at its distance from it): so the spin never takes more
        // energy than the orbits and the spins had, and what they lose is heat.
        const float3 angularMomentum =
            mass * cross(position - newPosition, velocity - newVelocity)
            + victimMass * cross(victimPosition - newPosition, victimVelocity - newVelocity)
            + mass * inertia * spin
            + victimMass * victimInertia * victimSpin;
        const float newInertia = (mass * (inertia + dot(position - newPosition, position - newPosition))
            + victimMass * (victimInertia + dot(victimPosition - newPosition, victimPosition - newPosition))) / total;
        const float3 newSpin = angularMomentum / (total * newInertia);
        if (g_Simulation.heating != 0)
        {
            const float before = mass * dot(velocity, velocity) + victimMass * dot(victimVelocity, victimVelocity)
                + mass * inertia * dot(spin, spin) + victimMass * victimInertia * dot(victimSpin, victimSpin);
            const float after = total * dot(newVelocity, newVelocity) + total * newInertia * dot(newSpin, newSpin);
            // Never below 0 but for rounding.
            heat += g_Simulation.heatFactor * 0.5 * max(before - after, 0.0) / total;
        }

        spin = newSpin;
        inertia = newInertia;
        position = newPosition;
        velocity = newVelocity;
        radius = newRadius;
        trueVolume += victim.marker.w * victim.marker.w * victim.marker.w;
        mass = total;
        absorbed = true;
    }

    if (!absorbed)
        return;

    // At the center of mass the merged sphere can reach into particles none of the merging ones
    // touched, and the contact springs would push them out with energy from nowhere (an overlap's
    // spring energy grows as 1/step^2). So it takes no more than the room there, up to the nearest
    // other particle's surface (and its true radius); its spin keeps the angular momentum, with the
    // same inertia. What the springs held is heat. Then it takes this step's growth into its
    // neighbors, as collide_cs gives a particle that doesn't merge (it would wait for a step
    // without a merge, and a big one merges nearly every step).
    const float trueRadius = pow(trueVolume, 1.0 / 3.0);
    float clearance = trueRadius;
    for (uint k = 0; k < particleCount; k++)
    {
        const Particle neighbor = u_Particles[k];
        if (k == index || neighbor.info.x < 0.0)
            continue;
        const Contact neighborContact = u_Contacts[k];
        if (neighborContact.shift.w != 0.0 && uint(neighborContact.spin.w) == index)
            continue;
        clearance = min(clearance, length(position - neighbor.pos.xyz) - neighbor.info.x);
        if (springs && g_Simulation.heating != 0)
            springsBefore += SpringEnergyWith(survivorPosition, survivorRadius, survivorMass, neighbor, step);
    }
    // Never vanishing: below a quarter of its size it still overlaps, and pays for that below.
    const float fitted = max(clearance, 0.25 * radius);
    const float pushed = min(trueRadius, fitted + GROWTH_PER_STEP * trueRadius);
    float springsAfter = 0.0;
    float growthEnergy = 0.0;
    if (springs && ((g_Simulation.heating != 0 && fitted > clearance) || pushed > fitted))
    {
        for (uint k = 0; k < particleCount; k++)
        {
            const Particle neighbor = u_Particles[k];
            if (k == index || neighbor.info.x < 0.0)
                continue;
            const Contact neighborContact = u_Contacts[k];
            if (neighborContact.shift.w != 0.0 && uint(neighborContact.spin.w) == index)
                continue;
            const float fittedEnergy = SpringEnergyWith(position, fitted, mass, neighbor, step);
            springsAfter += fittedEnergy;
            // Not with a slow pair, as in collide_cs.
            if (g_Simulation.mergeSpeed <= 0.0 || length(velocity - neighbor.vel.xyz) >= g_Simulation.mergeSpeed)
                growthEnergy += SpringEnergyWith(position, pushed, mass, neighbor, step) - fittedEnergy;
        }
    }
    radius = fitted;
    if (g_Simulation.heating != 0)
    {
        heat += g_Simulation.heatFactor * (springsBefore - springsAfter) / mass;
        const float heatEnergy = g_Simulation.heatFactor > 0.0 ? max(heat, 0.0) * mass / g_Simulation.heatFactor : 0.0;
        if (pushed > fitted && growthEnergy <= heatEnergy)
        {
            heat -= g_Simulation.heatFactor * growthEnergy / mass;
            radius = pushed;
        }
    }
    else
    {
        radius = pushed;
    }

    particle.pos = float4(position, mass);
    particle.vel.xyz = velocity;
    particle.spin = float4(spin, inertia);
    particle.info.x = radius;
    particle.info.y = heat;
    // collide_cs's growth was for where it was: none more this step.
    particle.info.w = radius;
    particle.marker.w = trueRadius;
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
        particle.info.y = max(particle.info.y + contact.velocity.w, 0.0);
        particle.spin.xyz += contact.spin.xyz;

        // A merged particle grows towards its true radius (marker.w), as collide_cs chose (info.w).
        // Its mass stays where it was, and so do its inertia and spin.
        if (particle.marker.w > particle.info.x)
            particle.info.x = min(particle.marker.w, max(particle.info.x, particle.info.w));
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

// Before fragment_cs: the slots of the particles merged away (or left free), listed in u_Free.
[numthreads(WORKGROUP_SIZE, 1, 1)]
void collect_free_cs(uint3 globalId : SV_DispatchThreadID)
{
    const uint index = globalId.x;
    if (index >= uint(g_Simulation.particleCount) || u_Particles[index].info.x >= 0.0)
        return;
    uint slot;
    InterlockedAdd(u_Free[0], 1, slot);
    u_Free[2 + slot] = index;
}

// After integrate_cs: a particle hit hard enough (collide_cs) breaks into two halves of half its
// mass and volume, touching at its center along the impact normal, parting at the speed collide_cs
// chose: one stays in its slot, the other takes a free one (none left: it doesn't break). The
// center of mass, the momentum and the angular momentum of their orbits are the particle's (the
// offsets and the parting velocities are along the same line); the spin keeps its angular momentum
// in the halves' inertia, solid spheres' (2^(2/3) times faster for a sphere's halves). The parting's
// kinetic energy (1/8 m w^2), the spin's change and the gravity's potential energy
// between the halves (PairPotential) come out of the particle's heat, which its impact has just
// raised, and so does the contact springs' energy the halves would add with the neighbors they
// reach into: with too little heat (or heating off), it doesn't break.
// Color and marker are the particle's.
[numthreads(WORKGROUP_SIZE, 1, 1)]
void fragment_cs(uint3 globalId : SV_DispatchThreadID)
{
    const uint index = globalId.x;
    if (index >= uint(g_Simulation.particleCount))
        return;
    const Contact contact = u_Contacts[index];
    Particle particle = u_Particles[index];
    if (contact.fragment.w == 0.0 || particle.info.x < 0.0)
        return;

    // 2^(-1/3): half the volume.
    const float radius = particle.info.x * 0.7937005;
    const float speed = length(contact.fragment.xyz);
    const float3 normal = speed > 1e-6 ? contact.fragment.xyz / speed : float3(1, 0, 0);
    const float3 center = particle.pos.xyz;
    const float3 velocity = particle.vel.xyz;
    // The halves are solid spheres (inertia 2/5 r^2 over the mass), with the particle's angular
    // momentum in their spins.
    const float halfInertia = 0.4 * radius * radius;
    const float3 halfSpin = particle.spin.xyz * particle.spin.w / halfInertia;
    const float spinGain = 0.5 * particle.pos.w * (halfInertia * dot(halfSpin, halfSpin)
        - particle.spin.w * dot(particle.spin.xyz, particle.spin.xyz));
    // The parting, the spin's change, and the gravity's energy between the two halves (PairPotential;
    // with gravity between all pairs only, as in absorb_cs).
    float gained = 0.125 * particle.pos.w * speed * speed + spinGain
        + (g_Simulation.fullGravity != 0 ? PairPotential(2.0 * radius, 0.5 * particle.pos.w, 0.5 * particle.pos.w) : 0.0);
    // The halves reach past the particle along the normal, into neighbors it may not have touched:
    // the contact springs' energy with them, after less before, is paid too.
    const float step = g_Simulation.deltaT * g_Simulation.timeFactor;
    if (g_Simulation.contactSprings != 0 && step > 0.0)
    {
        const uint particleCount = uint(g_Simulation.particleCount);
        for (uint j = 0; j < particleCount; j++)
        {
            const Particle other = u_Particles[j];
            if (j == index || other.info.x < 0.0)
                continue;
            gained += SpringEnergyWith(center + normal * radius, radius, 0.5 * particle.pos.w, other, step)
                + SpringEnergyWith(center - normal * radius, radius, 0.5 * particle.pos.w, other, step)
                - SpringEnergyWith(center, particle.info.x, particle.pos.w, other, step);
        }
    }
    // Paid from the heat; with too little (or heating off), the particle doesn't break.
    const float heatEnergy = g_Simulation.heatFactor > 0.0 ? particle.info.y * particle.pos.w / g_Simulation.heatFactor : 0.0;
    if (g_Simulation.heating == 0 || gained > heatEnergy)
        return;
    particle.info.y -= g_Simulation.heatFactor * gained / particle.pos.w;

    uint taken;
    InterlockedAdd(u_Free[1], 1, taken);
    if (taken >= u_Free[0])
        return;
    const uint slot = u_Free[2 + taken];

    particle.pos = float4(center + normal * radius, 0.5 * particle.pos.w);
    particle.vel.xyz = velocity + 0.5 * contact.fragment.xyz;
    particle.spin = float4(halfSpin, halfInertia);
    particle.info.x = radius;
    particle.info.z = 0.0;
    particle.marker.w *= 0.7937005;
    u_Particles[index] = particle;

    particle.pos.xyz = center - normal * radius;
    particle.vel.xyz = velocity - 0.5 * contact.fragment.xyz;
    u_Particles[slot] = particle;
}

#endif // SIMULATION

// --- Rendering -------------------------------------------------------------------------------

cbuffer c_View : register(b1)
{
    PlanarViewConstants g_View;
};
StructuredBuffer<Particle> t_Particles : register(t0);
// The application's switches and the trails' constants, for the balls (main_vs) and the trails.
cbuffer c_Trail : register(b3)
{
    // x = the world distance a unit of velocity stretches to (the time scale, times the seconds the
    // trail covers), y = the trails' opacity at the head, z = 1: the balls are lit spheres (0: a
    // flat falloff to the edge), w = 1: the balls show their spin marks.
    float4 g_Trail;
};

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
    out float3 o_marker : TEXCOORD3,
    out float o_lit : TEXCOORD4)
{
    const Particle particle = t_Particles[i_vertex / 6];
    const float2 corner = c_QuadCorners[i_vertex % 6];
    o_lit = g_Trail.z;
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
    // No marks: a zero marker is at no pole.
    o_marker = g_Trail.w > 0.5 ? mul(float4(particle.marker.xyz, 0.0), g_View.matWorldToView).xyz : float3(0, 0, 0);
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
    float3 i_marker : TEXCOORD3,
    float i_lit : TEXCOORD4) : SV_Target0
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
        if (i_lit > 0.5)
        {
            const float3 toLight = normalize(float3(-0.45, 0.55, -0.7));
            brightness = 0.2 + 0.9 * saturate(dot(normal, toLight));
            // Half way between the light and the viewer (at -z).
            highlight = 0.5 * pow(saturate(dot(normal, normalize(toLight + float3(0, 0, -1)))), 24.0) * (1.0 - saturate(glow * 3.0));
        }
        else
        {
            // Unlit: brighter towards the center, as the balls were first drawn.
            brightness = 0.35 + 0.65 * sqrt(1.0 - ballR * ballR);
        }
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

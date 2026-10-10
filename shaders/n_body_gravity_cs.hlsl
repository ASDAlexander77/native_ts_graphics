// DirectX-Graphics-Samples' D3D12nBodyGravity nBodyGravityCS.hlsl: the n-body step, each thread one
// particle pulled by all the others (tiles of 128 cached in group shared memory).
//
// The sample's constant buffer (cbCS) is push constants here, its uints as floats (converted back).
// The particle buffers have room for whole tiles: the reads past the particles (zero in the sample,
// as out of bounds reads) read zeroed elements, on Vulkan too.
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).

#include <donut/shaders/binding_helpers.hlsli>

struct PosVelo
{
    float4 pos;
    float4 velo;
};

static float softeningSquared   = 0.0012500000f * 0.0012500000f;
static float g_fG               = 6.67300e-11f * 10000.0f;
static float g_fParticleMass    = g_fG * 10000.0f * 10000.0f;

#define blocksize 128
groupshared float4 sharedPos[blocksize];

//
// Body to body interaction, acceleration of the particle at position
// bi is updated.
//
void bodyBodyInteraction(inout float3 ai, float4 bj, float4 bi, float mass, int particles)
{
    float3 r = bj.xyz - bi.xyz;

    float distSqr = dot(r, r);
    distSqr += softeningSquared;

    float invDist = 1.0f / sqrt(distSqr);
    // precise: DXC's DXIL code would reassociate the products (as (invDist * invDist * mass) *
    // invDist); FXC (the sample's) and DXC's SPIR-V code keep their order. The simulation is chaotic:
    // a last bit's difference shows within a few steps.
    precise float invDistCube = invDist * invDist * invDist;

    precise float s = mass * invDistCube * particles;

    ai += r * s;
}

struct StepConstants
{
    float4  g_param;    // param[0] = MAX_PARTICLES;
                        // param[1] = dimx;
    float4  g_paramf;   // paramf[0] = 0.1f;
                        // paramf[1] = 1;
};

DECLARE_PUSH_CONSTANTS(StepConstants, g_stepConstants, 0, 0);

StructuredBuffer<PosVelo> oldPosVelo    : register(t0);    // SRV
RWStructuredBuffer<PosVelo> newPosVelo  : register(u0);    // UAV

[numthreads(blocksize, 1, 1)]
void CSMain(uint3 Gid : SV_GroupID, uint3 DTid : SV_DispatchThreadID, uint3 GTid : SV_GroupThreadID, uint GI : SV_GroupIndex)
{
    const uint4 g_param = uint4(g_stepConstants.g_param);
    const float4 g_paramf = g_stepConstants.g_paramf;

    // Each thread of the CS updates one of the particles.
    float4 pos = oldPosVelo[DTid.x].pos;
    float4 vel = oldPosVelo[DTid.x].velo;
    float3 accel = 0;
    float mass = g_fParticleMass;

    // Update current particle using all other particles.
    [loop]
    for (uint tile = 0; tile < g_param.y; tile++)
    {
        // Cache a tile of particles unto shared memory to increase IO efficiency.
        sharedPos[GI] = oldPosVelo[tile * blocksize + GI].pos;

        GroupMemoryBarrierWithGroupSync();

        [unroll]
        for (uint counter = 0; counter < blocksize; counter += 8)
        {
            bodyBodyInteraction(accel, sharedPos[counter], pos, mass, 1);
            bodyBodyInteraction(accel, sharedPos[counter+1], pos, mass, 1);
            bodyBodyInteraction(accel, sharedPos[counter+2], pos, mass, 1);
            bodyBodyInteraction(accel, sharedPos[counter+3], pos, mass, 1);
            bodyBodyInteraction(accel, sharedPos[counter+4], pos, mass, 1);
            bodyBodyInteraction(accel, sharedPos[counter+5], pos, mass, 1);
            bodyBodyInteraction(accel, sharedPos[counter+6], pos, mass, 1);
            bodyBodyInteraction(accel, sharedPos[counter+7], pos, mass, 1);
        }

        GroupMemoryBarrierWithGroupSync();
    }

    // g_param.x is the number of our particles, however this number might not
    // be an exact multiple of the tile size. In such cases, out of bound reads
    // occur in the process above, which means there will be tooManyParticles
    // "phantom" particles generating false gravity at position (0, 0, 0), so
    // we have to subtract them here. NOTE, out of bound reads always return 0 in CS.
    const int tooManyParticles = g_param.y * blocksize - g_param.x;
    bodyBodyInteraction(accel, float4(0, 0, 0, 0), pos, mass, -tooManyParticles);

    // Update the velocity and position of current particle using the
    // acceleration computed above.
    vel.xyz += accel.xyz * g_paramf.x;      //deltaTime;
    vel.xyz *= g_paramf.y;                  //damping;
    pos.xyz += vel.xyz * g_paramf.x;        //deltaTime;

    if (DTid.x < g_param.x)
    {
        newPosVelo[DTid.x].pos = pos;
        newPosVelo[DTid.x].velo = float4(vel.xyz, length(accel));
    }
}

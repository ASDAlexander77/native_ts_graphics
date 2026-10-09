//--------------------------------------------------------------------------------------
// Bokeh: the iris texture's energy weights
//
// Advanced Technology Group (ATG)
// Copyright (C) Microsoft Corporation. All rights reserved.
//--------------------------------------------------------------------------------------

// The Xbox ATG Bokeh12 sample's CreateEnergyTexCS.hlsl on Donut's bindings (see bokeh.hlsl).

#define NUM_RADII_WEIGHTS   64

// --- CreateEnergyTexCS.hlsl -------------------------------------------------------------------

Texture2D<float4> g_irisTex : register(t0);
SamplerState g_bilinearSampler : register(s0);

// Port: a structured buffer of 8x8xN floats (the sample's RWTexture3D) and a N x 1 texture (its
// RWTexture1D).
RWStructuredBuffer<float> g_deviceMem : register(u0); // 8x8xN float buffer
RWTexture2D<float> g_energyTex : register(u1); // N float buffer

groupshared float s_groupMem[64];

float LoadGroup(uint2 id)
{
    int index = id.y * 8 + id.x;
    return s_groupMem[index];
}

void StoreGroup(uint2 id, float value)
{
    s_groupMem[id.y * 8 + id.x] = value;
}

// Port: the sample's loop runs while the thread takes part (all(GroupThreadId.xy < (0x8 >> i))),
// behind GroupMemoryBarrier (without a group sync), which on the Xbox's 64-wide waves reads its
// neighbours' stores; on 32-wide waves that races. Every thread runs the loop here, synced, and
// only the sample's threads sum.
void GroupReduceSum(uint3 GroupThreadId)
{
    for (int i = 1; i <= 3; ++i)
    {
        GroupMemoryBarrierWithGroupSync();

        if (all(GroupThreadId.xy < (0x8u >> i)))
        {
            uint offset = 1u << (i - 1);
            uint2 xy = GroupThreadId.xy * (1u << i);

            float v0 = LoadGroup(xy + uint2(0, 0) * offset);
            float v1 = LoadGroup(xy + uint2(1, 0) * offset);
            float v2 = LoadGroup(xy + uint2(0, 1) * offset);
            float v3 = LoadGroup(xy + uint2(1, 1) * offset);

            float fSum = v0 + v1 + v2 + v3;

            StoreGroup(xy, fSum);
        }
    }
    GroupMemoryBarrierWithGroupSync();
}

uint DeviceMemIndex(uint3 id)
{
    return (id.z * 8 + id.y) * 8 + id.x;
}

[numthreads(8, 8, 1)]
void create_energy_tex_cs(uint3 GroupId : SV_GroupID,
            uint GroupIndex : SV_GroupIndex,
            uint3 GroupThreadId : SV_GroupThreadID,
            uint3 DispatchThreadId : SV_DispatchThreadID)
{
    uint slice = GroupId.z;

    // Compute the sample coordinates.
    // This positions the iris at the center of the dispatch block with a cocRadius size (based on the z-component.)
    float cocRadius = (slice + 1) * 0.5f;
    float cocDiam = cocRadius * 2.0f;
    float cocCenter = NUM_RADII_WEIGHTS / 2;
    float bl = cocCenter - cocRadius;

    float2 sampleUV = ((DispatchThreadId.xy + 0.5f) - bl) / cocDiam;
    float level = (1.0f - cocRadius / cocCenter) * 5.0f;

    // Read and store the iris texture value into LDS memory.
    float value = g_irisTex.SampleLevel(g_bilinearSampler, sampleUV, level).x;
    StoreGroup(GroupThreadId.xy, value);

    // Reduce the memory by summation.
    GroupReduceSum(GroupThreadId);

    // Group Thread (0, 0) responsible for saving this out to device memory.
    if (all(GroupThreadId.xy == 0))
    {
        g_deviceMem[DeviceMemIndex(GroupId)] = LoadGroup(GroupThreadId.xy);
    }

    // This problem has been reduced to an 8x8 sum which one group can handle.
    // Release all other groups. Left with 1x1x64 groups.
    if (all(GroupId.xy != 0))
    {
        return;
    }

    // Copy the inter-group memory to LDS memory.
    // (As in the sample, other groups' sums may still be in flight: they are this frame's or the
    // previous frame's, which are the same.)
    DeviceMemoryBarrierWithGroupSync();
    StoreGroup(GroupThreadId.xy, g_deviceMem[DeviceMemIndex(uint3(GroupThreadId.xy, slice))]);

    // Reduce the memory by summation - same way as above.
    GroupReduceSum(GroupThreadId);

    // Group Thread (0, 0) responsible for calculating and saving the final energy value.
    if (all(GroupThreadId.xy == 0))
    {
        float fSum = LoadGroup(GroupThreadId.xy);
        float area = cocDiam * cocDiam;

        g_energyTex[uint2(slice, 0)] = area / fSum;
    }
}

//--------------------------------------------------------------------------------------
// FastBlockCompress: RMS error
//
// Advanced Technology Group (ATG)
// Copyright (C) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
//--------------------------------------------------------------------------------------

// Port of the Xbox ATG FastBlockCompress sample's RMSError.hlsl and RMSReduce.hlsl to Donut's
// bindings (root signature left out, the constant buffer as push constants). Change:
// - The RMS shaders read the values of neighboring threads from group shared memory without a
//   barrier, as their 64 threads were one wavefront on Xbox One; here a barrier comes first (NVIDIA
//   runs 32-thread warps).

#include <donut/shaders/binding_helpers.hlsli>

// --- RMS.hlsli -----------------------------------------------------------------------------

#define RMS_THREADGROUP_WIDTH 64

struct RMSConstants
{
    uint textureWidth;
    uint mipLevel;
    uint reconstructZA;
    uint reconstructZB;
};
DECLARE_PUSH_CONSTANTS(RMSConstants, g_RMS, 0, 0);

#define TEXELS_PER_GROUP (RMS_THREADGROUP_WIDTH * 2)
#define REDUCTION_FACTOR 4

// Reconstruct the Z component of a normal map
float ReconstructZ(float2 v)
{
    v = v * 2 - 1;
    float z = sqrt(max(0, 1 - dot(v, v)));

    return 0.5f*(z + 1);
}

// --- RMSError.hlsl -------------------------------------------------------------------------

Texture2D g_texA : register(t0);
Texture2D g_texB : register(t1);
RWStructuredBuffer<float2> g_buffReduce : register(u0);

// Squared error from each thread: (RGB, A)
groupshared float2 gs_sqError[64];

//--------------------------------------------------------------------------------------
// Compute shader entry point. Each thread reads two pixels, so a single
// threadgroup reads 128 texels along X
//--------------------------------------------------------------------------------------
[numthreads(RMS_THREADGROUP_WIDTH, 1, 1)]
void rms_error_cs(
    uint2 threadIDWithinDispatch : SV_DispatchThreadID,
    uint2 groupIDWithinDispatch : SV_GroupID,
    uint threadIndexWithinGroup : SV_GroupIndex)
{
    // Load the values from two adjacent texels
    uint3 location = int3(threadIDWithinDispatch.x * 2, threadIDWithinDispatch.y, g_RMS.mipLevel);
    float4 error[2];

    float4 a = g_texA.Load(location);
    float4 b = g_texB.Load(location);
    if (g_RMS.reconstructZA) a.z = ReconstructZ(a.xy);
    if (g_RMS.reconstructZB) b.z = ReconstructZ(b.xy);
    error[0] = 255.0f * (a - b);

    a = g_texA.Load(location, int2(1, 0));
    b = g_texB.Load(location, int2(1, 0));
    if (g_RMS.reconstructZA) a.z = ReconstructZ(a.xy);
    if (g_RMS.reconstructZB) b.z = ReconstructZ(b.xy);
    error[1] = 255.0f * (a - b);

    float rgbError = dot(error[0].rgb, error[0].rgb) + dot(error[1].rgb, error[1].rgb);
    float alphaError = error[0].a*error[0].a + error[1].a*error[1].a;
    float2 sqError = float2(rgbError, alphaError);
    gs_sqError[threadIndexWithinGroup] = sqError;

    GroupMemoryBarrierWithGroupSync();

    // Now we take the computed error values in the local store and downsample them, converting
    //  from a 2D texture into a flat list that will be fed into the reduction stage.
    if (!(threadIndexWithinGroup & 1)         // Each even thread (threads 0, 2, 4, ...) combines two values from local store
        && location.x < g_RMS.textureWidth)  // We need to bounds check because we are writing into a 1D buffer
    {
        sqError += gs_sqError[threadIndexWithinGroup + 1];

        uint outputIndex = groupIDWithinDispatch.y * (g_RMS.textureWidth / REDUCTION_FACTOR)
            + groupIDWithinDispatch.x*(TEXELS_PER_GROUP / REDUCTION_FACTOR)
            + threadIndexWithinGroup / 2;
        g_buffReduce[outputIndex] = sqError;
    }
}

// --- RMSReduce.hlsl ------------------------------------------------------------------------

RWStructuredBuffer<float2> g_buffInput : register(u0);
RWStructuredBuffer<float2> g_buffOutput : register(u1);

//--------------------------------------------------------------------------------------
// Compute shader entry point. Each thread reads two pixels, so a single
// threadgroup reads 128 buffer elements along X
//--------------------------------------------------------------------------------------
[numthreads(RMS_THREADGROUP_WIDTH, 1, 1)]
void rms_reduce_cs(
    uint threadIDWithinDispatch : SV_DispatchThreadID,
    uint groupIDWithinDispatch : SV_GroupID,
    uint threadIndexWithinGroup : SV_GroupIndex)
{
    // Combine the values from two adjacent buffer elements
    uint location = threadIDWithinDispatch * 2;
    float2 sqError = g_buffInput[location] + g_buffInput[location + 1];
    gs_sqError[threadIndexWithinGroup] = sqError;

    GroupMemoryBarrierWithGroupSync();

    // Each even thread combines two elements from local store and writes them to the output buffer
    if (!(threadIndexWithinGroup & 1))
    {
        sqError += gs_sqError[threadIndexWithinGroup + 1];

        uint outputIndex = groupIDWithinDispatch * (TEXELS_PER_GROUP / REDUCTION_FACTOR) + threadIndexWithinGroup / 2;
        g_buffOutput[outputIndex] = sqError;
    }
}

//--------------------------------------------------------------------------------------
// RaytracingAO: SSAO depth and normals preparation, part 1
//
// Advanced Technology Group (ATG)
// Copyright (C) Microsoft Corporation. All rights reserved.
//--------------------------------------------------------------------------------------

// The Xbox ATG RaytracingAO_PC12 sample's SSAOPrepareDepthBuffers1CS.hlsl: the depth buffer
// linearized, downsampled to 1/2 and 1/4 and deinterleaved into 16-slice atlases, the normals
// likewise. Port: the normals come from their own G-buffer target (the sample's slice 0), and
// are stored as float4 (Vulkan wants a component for each of the format's channels).

#include "raytracing_ao.hlsli"

Texture2D<float> Depth : register(t0);
Texture2D<float4> GBufferNormals : register(t1);

RWTexture2D<float> LinearZ : register(u0);
RWTexture2D<float2> DS2x : register(u1);
RWTexture2DArray<float> DS2xAtlas : register(u2);
RWTexture2D<float2> DS4x : register(u3);
RWTexture2DArray<float> DS4xAtlas : register(u4);
RWTexture2D<float4> Normals2x : register(u5);
RWTexture2DArray<float4> Normals2xAtlas : register(u6);
RWTexture2D<float4> Normals4x : register(u7);
RWTexture2DArray<float4> Normals4xAtlas : register(u8);

groupshared float g_CacheW[256];
groupshared float3 g_CacheNormals[256];

float3 DecodeNormal(float3 normal)
{
    return normal;
}

float Linearize(uint2 st)
{
    float depth = 1.f - Depth[st];
    float dist = 1.0 / (ZSCALE * depth + 1.0);
    LinearZ[st] = dist;
    return dist;
}

[numthreads(8, 8, 1)]
void main(uint3 Gid : SV_GroupID, uint GI : SV_GroupIndex, uint3 GTid : SV_GroupThreadID, uint3 DTid : SV_DispatchThreadID)
{
    uint2 startST = Gid.xy << 4 | GTid.xy;
    uint destIdx = GTid.y << 4 | GTid.x;
    g_CacheW[destIdx + 0] = Linearize(startST | uint2(0, 0));
    g_CacheW[destIdx + 8] = Linearize(startST | uint2(8, 0));
    g_CacheW[destIdx + 128] = Linearize(startST | uint2(0, 8));
    g_CacheW[destIdx + 136] = Linearize(startST | uint2(8, 8));

    g_CacheNormals[destIdx + 0] = DecodeNormal(GBufferNormals[startST | uint2(0, 0)].xyz);
    g_CacheNormals[destIdx + 8] = DecodeNormal(GBufferNormals[startST | uint2(8, 0)].xyz);
    g_CacheNormals[destIdx + 128] = DecodeNormal(GBufferNormals[startST | uint2(0, 8)].xyz);
    g_CacheNormals[destIdx + 136] = DecodeNormal(GBufferNormals[startST | uint2(8, 8)].xyz);

    GroupMemoryBarrierWithGroupSync();

    uint ldsIndex = (GTid.x << 1) | (GTid.y << 5);

    float w1 = g_CacheW[ldsIndex];
    float3 n1 = g_CacheNormals[ldsIndex];

    uint2 st = DTid.xy;
    uint slice = (st.x & 3) | ((st.y & 3) << 2);
    DS2x[st] = w1;
    DS2xAtlas[uint3(st >> 2, slice)] = w1;
    Normals2x[st] = float4(n1, 0);
    Normals2xAtlas[uint3(st >> 2, slice)] = float4(n1, 0);

    // The sample's (GI & 011): an octal literal, 9.
    if ((GI & 9) == 0)
    {
        st = DTid.xy >> 1;
        slice = (st.x & 3) | ((st.y & 3) << 2);
        DS4x[st] = w1;
        DS4xAtlas[uint3(st >> 2, slice)] = w1;
        Normals4x[st] = float4(n1, 0);
        Normals4xAtlas[uint3(st >> 2, slice)] = float4(n1, 0);
    }
}

//--------------------------------------------------------------------------------------
// RaytracingAO: SSAO depth and normals preparation, part 2
//
// Advanced Technology Group (ATG)
// Copyright (C) Microsoft Corporation. All rights reserved.
//--------------------------------------------------------------------------------------

// The Xbox ATG RaytracingAO_PC12 sample's SSAOPrepareDepthBuffers2CS.hlsl: the 1/4 depth and
// normals downsampled to 1/8 and 1/16 and deinterleaved into 16-slice atlases. Port: the normals
// are stored as float4 (Vulkan wants a component for each of the format's channels).

#include "raytracing_ao.hlsli"

Texture2D<float> DS4x : register(t0);
Texture2D<float3> Normal4x : register(t1);

RWTexture2D<float> DS8x : register(u0);
RWTexture2DArray<float> DS8xAtlas : register(u1);
RWTexture2D<float> DS16x : register(u2);
RWTexture2DArray<float> DS16xAtlas : register(u3);
RWTexture2D<float4> Normals8x : register(u4);
RWTexture2DArray<float4> Normals8xAtlas : register(u5);
RWTexture2D<float4> Normals16x : register(u6);
RWTexture2DArray<float4> Normals16xAtlas : register(u7);

[numthreads(8, 8, 1)]
void main(uint3 Gid : SV_GroupID, uint GI : SV_GroupIndex, uint3 GTid : SV_GroupThreadID, uint3 DTid : SV_DispatchThreadID)
{
    float m1 = DS4x[DTid.xy << 1];
    float3 n1 = Normal4x[DTid.xy << 1];

    uint2 st = DTid.xy;
    uint2 stAtlas = st >> 2;
    uint stSlice = (st.x & 3) | ((st.y & 3) << 2);
    DS8x[st] = m1;
    DS8xAtlas[uint3(stAtlas, stSlice)] = m1;
    Normals8x[st] = float4(n1, 0);
    Normals8xAtlas[uint3(stAtlas, stSlice)] = float4(n1, 0);

    // The sample's (GI & 011): an octal literal, 9.
    if ((GI & 9) == 0)
    {
        uint2 st = DTid.xy >> 1;
        uint2 stAtlas = st >> 2;
        uint stSlice = (st.x & 3) | ((st.y & 3) << 2);
        DS16x[st] = m1;
        DS16xAtlas[uint3(stAtlas, stSlice)] = m1;
        Normals16x[st] = float4(n1, 0);
        Normals16xAtlas[uint3(stAtlas, stSlice)] = float4(n1, 0);
    }
}

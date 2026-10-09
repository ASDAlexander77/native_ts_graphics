//--------------------------------------------------------------------------------------
// RaytracingAO: the SSAO image
//
// Advanced Technology Group (ATG)
// Copyright (C) Microsoft Corporation. All rights reserved.
//--------------------------------------------------------------------------------------

// The Xbox ATG RaytracingAO_PC12 sample's SSAOGBufferRenderCS.hlsl: the G-buffer's diffuse color
// times the SSAO, the background where nothing was drawn. Port: the diffuse color comes from its
// own G-buffer target (the sample's slice 1); the color is stored as float4, opaque (Vulkan wants
// a component for each of the format's channels).

#include "raytracing_ao.hlsli"

Texture2D<float> SsaoBuffer : register(t0);
Texture2D<float4> GBufferDiffuse : register(t1);
Texture2D<float> Depth : register(t2);

RWTexture2D<float4> OutColor : register(u0);

[numthreads(8, 8, 1)]
void main(uint3 DTid : SV_DispatchThreadID)
{
    if (Depth[DTid.xy] != 1.0)
        OutColor[DTid.xy] = float4(GBufferDiffuse[DTid.xy].xyz * SsaoBuffer[DTid.xy], 1);
    else
        OutColor[DTid.xy] = float4(BACKGROUND.xyz, 1);
}

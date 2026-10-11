//*********************************************************
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).
// THIS CODE IS PROVIDED *AS IS* WITHOUT WARRANTY OF
// ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING ANY
// IMPLIED WARRANTIES OF FITNESS FOR A PARTICULAR
// PURPOSE, MERCHANTABILITY, OR NON-INFRINGEMENT.
//
//*********************************************************

// DirectX-Graphics-Samples' D3D12Bundles shaders (shader_mesh_simple_vert.hlsl,
// shader_mesh_simple_pixel.hlsl, shader_mesh_alt_pixel.hlsl), for examples/bundles.ts: one file,
// the alternative pixel shader PSAlt. The vertex shader takes the positions and texture
// coordinates of the vertices only (Vulkan's validation warns about vertex attributes nothing
// reads).

struct VSInput
{
    float3 position    : POSITION;
    float2 uv        : TEXCOORD0;
};

struct PSInput
{
    float4 position    : SV_POSITION;
    float2 uv        : TEXCOORD0;
};

cbuffer cb0 : register(b0)
{
    float4x4 g_mWorldViewProj;
};

Texture2D        g_txDiffuse : register(t0);
SamplerState    g_sampler : register(s0);

PSInput VSMain(VSInput input)
{
    PSInput result;

    result.position = mul(float4(input.position, 1.0f), g_mWorldViewProj);
    result.uv = input.uv;

    return result;
}

float4 PSMain(PSInput input) : SV_TARGET
{
    return g_txDiffuse.Sample(g_sampler, input.uv);
}

float4 PSAlt(PSInput input) : SV_TARGET
{
    float3 color = g_txDiffuse.Sample(g_sampler, input.uv).rgb;

    // Reduce R and B contributions to the output color.
    float3 filter = float3(0.25f, 1.0f, 0.25f);

    return float4(color.xyz * filter, 1.0f);
}

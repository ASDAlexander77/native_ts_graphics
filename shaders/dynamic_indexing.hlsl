// DirectX-Graphics-Samples' D3D12DynamicIndexing shaders (shader_mesh_simple_vert.hlsl,
// shader_mesh_dynamic_indexing_pixel.hlsl): a city drawn many times, each copy's pixel shader
// reading its material from an array of textures by an index set per draw.
//
// The sample gives the vertex shader each copy's matrix in a constant buffer at b0 and the pixel
// shader the material index as a root constant also at b0 (separate root parameters per stage);
// here both are one block of push constants. The material array is the sample's unbounded
// g_txMats[], bounded to its 120 textures.
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).

#include <donut/shaders/binding_helpers.hlsli>

#define CITY_MATERIAL_COUNT 120

// The vertices also have a normal and a tangent, which the sample's vertex shader declares but
// doesn't read: left out here (Vulkan's validation warns of unread attributes).
struct VSInput
{
    float3 position : POSITION;
    float2 uv       : TEXCOORD0;
};

struct PSInput
{
    float4 position : SV_POSITION;
    float2 uv       : TEXCOORD0;
};

struct DrawConstants
{
    float4x4 g_mWorldViewProj;
    float matIndex;   // Dynamically set index for looking up from g_txMats[] (a float here, as the matrix).
};

DECLARE_PUSH_CONSTANTS(DrawConstants, drawConstants, 0, 0);

Texture2D    g_txDiffuse                        : register(t0);
Texture2D    g_txMats[CITY_MATERIAL_COUNT]      : register(t1);
SamplerState g_sampler                          : register(s0);

PSInput VSMain(VSInput input)
{
    PSInput result;

    result.position = mul(float4(input.position, 1.0f), drawConstants.g_mWorldViewProj);
    result.uv = input.uv;

    return result;
}

float4 PSMain(PSInput input) : SV_TARGET
{
    float3 diffuse = g_txDiffuse.Sample(g_sampler, input.uv).rgb;
    float3 mat = g_txMats[uint(drawConstants.matIndex)].Sample(g_sampler, input.uv).rgb;
    return float4(diffuse * mat, 1.0f);
}

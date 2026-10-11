// The D3D12ReservedResources sample's shaders.hlsl: a quad in clip space sampling one level of a
// reserved (tiled) texture. The sample's root constant (the level, a uint) is a push constant here,
// a float as push constants are here.
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).

#include <donut/shaders/binding_helpers.hlsli>

struct PSInput
{
    float4 position : SV_POSITION;
    float2 uv : TEXCOORD;
};

struct RootConstants
{
    float activeMip;
};

DECLARE_PUSH_CONSTANTS(RootConstants, rootConstants, 0, 0);

Texture2D g_texture : register(t0);
SamplerState g_sampler : register(s0);

PSInput VSMain(float4 position : POSITION, float2 uv : TEXCOORD)
{
    PSInput result;

    result.position = position;
    result.uv = uv;

    return result;
}

float4 PSMain(PSInput input) : SV_TARGET
{
    uint activeMip = uint(rootConstants.activeMip);
    return g_texture.SampleLevel(g_sampler, input.uv, activeMip);
}

//--------------------------------------------------------------------------------------
// SimplePBR: the sky box
//
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//--------------------------------------------------------------------------------------

// The Xbox ATG SimplePBR12_UWP sample's sky box (Kits/ATGTK/Skybox: SkyboxEffect_VS.hlsl,
// SkyboxEffect_PS.hlsl): a geosphere around the camera, drawn on the far plane, sampling the
// radiance cube map in the direction of each position.

cbuffer Skybox_Constants : register(b0)
{
    float4x4 Skybox_WorldViewProj;
}

// Port: POSITION (the sample's SV_Position input semantic).
struct VSInputNmTxTangent
{
    float4 Position : POSITION;
};

struct VSOutputPixelLightingTxTangent
{
    float3 TexCoord   : TEXCOORD0;
    float4 PositionPS : SV_Position;
};

struct PSInputPixelLightingTxTangent
{
    float3 TexCoord   : TEXCOORD0;
};

VSOutputPixelLightingTxTangent sky_vs(VSInputNmTxTangent vin)
{
    VSOutputPixelLightingTxTangent vout;

    vout.PositionPS = mul(vin.Position, Skybox_WorldViewProj);
    vout.PositionPS.z = vout.PositionPS.w; // Draw on far plane
    vout.TexCoord = vin.Position.xyz;

    return vout;
}

TextureCube<float4> CubeMap : register(t0);
SamplerState Sampler        : register(s0);

float4 sky_ps(PSInputPixelLightingTxTangent pin) : SV_TARGET0
{
    return CubeMap.Sample(Sampler, normalize(pin.TexCoord));
}

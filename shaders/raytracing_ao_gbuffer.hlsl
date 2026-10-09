//--------------------------------------------------------------------------------------
// RaytracingAO: the SSAO G-buffer
//
// Advanced Technology Group (ATG)
// Copyright (C) Microsoft Corporation. All rights reserved.
//--------------------------------------------------------------------------------------

// The Xbox ATG RaytracingAO_PC12 sample's GBufferVS.hlsl and GBufferPS.hlsl (GBufferH.hlsl). Port:
// the sample draws each mesh twice (instancing), a pass-through geometry shader sending instance 0
// to slice 0 (normals) and instance 1 to slice 1 (diffuse) of a 2-slice R11G11B10 target and depth
// buffer; here one draw writes both into two render targets (SV_Target0 and SV_Target1). The PS's
// switch on the slice becomes the two outputs.

#include "raytracing_ao.hlsli"

struct VSInput
{
    float3 position : POSITION;
    float3 normal : NORMAL;
    float2 texcoord : TEXCOORD;
    float3 tangent : TANGENT;
};

struct PSInput
{
    float4 position : SV_POSITION;
    float3 normal : TEXTURE_1;
    float2 texcoord : TEXCOORD_2;
    float3 tangent : TEXCOORD_3;
};

struct PSOutput
{
    float4 normal : SV_Target0;
    float4 diffuse : SV_Target1;
};

Texture2D<float4> g_diffuse : register(t0);
Texture2D<float4> g_ambient : register(t1);
Texture2D<float4> g_normal : register(t2);

SamplerState samplerLinearCLamp : register(s2);

ConstantBuffer<SceneConstantBuffer> g_sceneCB : register(b0);
ConstantBuffer<MaterialConstantBuffer> g_material : register(b2);

PSInput gbuffer_vs(VSInput input)
{
    PSInput result;
    result.position = mul(float4(input.position, 1.f), g_sceneCB.worldViewProjection);
    result.position.z = result.position.z;

    result.normal = input.normal;
    result.texcoord = input.texcoord;
    result.tangent = input.tangent;

    return result;
}

PSOutput gbuffer_ps(PSInput input)
{
    PSOutput output;

    // case 0:
    float3 normal;

    if (g_material.isNormalTexture)
    {
        normal = g_normal.Sample(samplerLinearCLamp, input.texcoord).xyz * 2.f - 1.f;
        float3 bitangent = cross(input.normal, input.tangent);
        float3x3 tbn = float3x3(input.tangent, bitangent, input.normal);
        normal = normalize(mul(normal, tbn));
    }
    else
        normal = input.normal;

    output.normal = float4(saturate((normal * 0.5) + 0.5), 0.f);

    // default:
    if (g_material.isDiffuseTexture)
        output.diffuse = g_diffuse.Sample(samplerLinearCLamp, input.texcoord);
    else
        output.diffuse = float4(g_material.diffuse, 1);

    return output;
}

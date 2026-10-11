// Vulkan-Samples' shader_debugprintf shaders (scene.vert, scene.frag) in HLSL, for
// examples/shader_debugprintf.ts: a sky sphere and three Phong-lit spheres, the vertex shader
// printing the view space position of every draw's vertex 0 with printf. DXC compiles printf to
// SPIR-V's NonSemantic.DebugPrintf instructions, which the validation layer instruments to write
// the values to a buffer it reads back and formats; D3D shaders have no printf, so SPIR-V only.
//
// Copyright (c) 2024-2025, Sascha Willems
// SPDX-License-Identifier: Apache-2.0

#include <donut/shaders/binding_helpers.hlsli>

struct UBO
{
    float4x4 projection;
    float4x4 modelview;
    float4x4 skyboxModelview;
    float modelscale;
};
ConstantBuffer<UBO> g_Ubo : register(b0);

Texture2D t_EnvMap : register(t0);
SamplerState s_EnvMap : register(s0);

// The object's offset and color, which object it is: 0 the sky sphere, 1 a sphere.
struct PushConstants
{
    float4 offset;
    float4 color;
    int objectType;
};
DECLARE_PUSH_CONSTANTS(PushConstants, g_Push, 1, 0);

struct VSOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
    float3 normal : NORMAL;
    float3 viewVec : TEXCOORD1;
    float3 lightVec : TEXCOORD2;
};

void scene_vs(float3 inPos : POSITION, float3 inNormal : NORMAL, float2 inUV : TEXCOORD, uint vertexIndex : SV_VertexID,
    out VSOutput output)
{
    output = (VSOutput)0;
    float3 outPos = 0;
    switch (g_Push.objectType)
    {
    case 0: // Skysphere
        outPos = mul((float3x3)g_Ubo.skyboxModelview, inPos);
        output.position = mul(g_Ubo.projection, float4(outPos, 1.0));
        break;
    case 1: // Object
        float3 localPos = inPos * g_Ubo.modelscale + g_Push.offset.xyz;
        outPos = mul(g_Ubo.modelview, float4(localPos, 1.0)).xyz;
        output.position = mul(g_Ubo.projection, mul(g_Ubo.modelview, float4(localPos, 1.0)));
        break;
    }
    output.uv = inUV;
    output.normal = mul((float3x3)g_Ubo.modelview, inNormal);
    float3 lightPos = mul((float3x3)g_Ubo.modelview, float3(0.0, -10.0, -10.0));
    output.lightVec = lightPos - outPos;
    output.viewVec = -outPos;

    // Output the vertex position using debug printf.
    if (vertexIndex == 0)
    {
        printf("Position = %v3f", outPos);
    }
}

float4 scene_ps(VSOutput input) : SV_Target
{
    float4 color = 0;
    switch (g_Push.objectType)
    {
    case 0: // Skysphere
        color = t_EnvMap.Sample(s_EnvMap, float2(input.uv.x, 1.0 - input.uv.y));
        break;
    case 1: // Phong shaded objects
        float3 ambient = g_Push.color.rgb * 0.5;
        float3 N = normalize(input.normal);
        float3 L = normalize(input.lightVec);
        float3 V = normalize(input.viewVec);
        float3 R = reflect(-L, N);
        float3 diffuse = max(dot(N, L), 0.0) * g_Push.color.rgb;
        float3 specular = pow(max(dot(R, V), 0.0), 8.0);
        color = float4(ambient + diffuse + specular, 1.0);
        break;
    }
    return float4(color.rgb, 1.0);
}

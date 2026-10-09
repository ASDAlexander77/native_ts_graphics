/* Copyright (c) 2024-2025, Mobica Limited
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 the "License";
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Port of Vulkan-Samples' dynamic_multisample_rasterization shaders (model.vert, model.frag) to
// Donut's bindings: the scene's nodes lit by a light fixed in view space, their textures picked by
// the indices in the push constants. The sample's array of 15 textures is 15 bindings here (an
// index picks one in a switch, so D3D11 runs it too). The TypeScript side gives the sample's
// projection with clip y negated for Donut's y-up clip space.

#include <donut/shaders/binding_helpers.hlsli>

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

cbuffer UBO : register(b0)
{
    float4x4 g_Projection;
    float4x4 g_View;
};

struct PushConstants
{
    float4x4 model;
    float4 base_color_factor;
    float metallic_factor;
    float roughness_factor;
    uint baseTextureIndex;
    uint normalTextureIndex;
    uint metallicRoughnessTextureIndex;
};

DECLARE_PUSH_CONSTANTS(PushConstants, g_PushConstants, 1, 0);

Texture2D t_Texture0 : register(t0);
Texture2D t_Texture1 : register(t1);
Texture2D t_Texture2 : register(t2);
Texture2D t_Texture3 : register(t3);
Texture2D t_Texture4 : register(t4);
Texture2D t_Texture5 : register(t5);
Texture2D t_Texture6 : register(t6);
Texture2D t_Texture7 : register(t7);
Texture2D t_Texture8 : register(t8);
Texture2D t_Texture9 : register(t9);
Texture2D t_Texture10 : register(t10);
Texture2D t_Texture11 : register(t11);
Texture2D t_Texture12 : register(t12);
Texture2D t_Texture13 : register(t13);
Texture2D t_Texture14 : register(t14);
SamplerState s_Sampler : register(s0);

// textures[index] (the index is the same for the whole draw). Each sample in its own branch
// into a color: a switch returning the samples gave 0 on Vulkan (DXC's SPIR-V).
float4 sampleTexture(uint index, float2 uv)
{
    float4 color = float4(0.0, 0.0, 0.0, 0.0);
    if (index == 0) color = t_Texture0.Sample(s_Sampler, uv);
    else if (index == 1) color = t_Texture1.Sample(s_Sampler, uv);
    else if (index == 2) color = t_Texture2.Sample(s_Sampler, uv);
    else if (index == 3) color = t_Texture3.Sample(s_Sampler, uv);
    else if (index == 4) color = t_Texture4.Sample(s_Sampler, uv);
    else if (index == 5) color = t_Texture5.Sample(s_Sampler, uv);
    else if (index == 6) color = t_Texture6.Sample(s_Sampler, uv);
    else if (index == 7) color = t_Texture7.Sample(s_Sampler, uv);
    else if (index == 8) color = t_Texture8.Sample(s_Sampler, uv);
    else if (index == 9) color = t_Texture9.Sample(s_Sampler, uv);
    else if (index == 10) color = t_Texture10.Sample(s_Sampler, uv);
    else if (index == 11) color = t_Texture11.Sample(s_Sampler, uv);
    else if (index == 12) color = t_Texture12.Sample(s_Sampler, uv);
    else if (index == 13) color = t_Texture13.Sample(s_Sampler, uv);
    else color = t_Texture14.Sample(s_Sampler, uv);
    return color;
}

struct VSInput
{
    float3 pos : POSITION;
    float3 normal : NORMAL;
    float2 uv : TEXCOORD;
};

struct VSOutput
{
    float4 position : SV_Position;
    float3 normal : NORMAL;
    float2 uv : TEXCOORD0;
    float3 viewVec : TEXCOORD1;
    float3 lightVec : TEXCOORD2;
    nointerpolation float4 baseColorFactor : TEXCOORD3;
    nointerpolation float metallicFactor : TEXCOORD4;
    nointerpolation float roughnessFactor : TEXCOORD5;
    nointerpolation uint baseTextureIndex : TEXCOORD6;
    nointerpolation uint normalTextureIndex : TEXCOORD7;
    nointerpolation uint metallicRoughnessTextureIndex : TEXCOORD8;
};

// model.vert
VSOutput model_vs(VSInput input)
{
    VSOutput output;
    output.uv = input.uv;
    const float4x4 modelView = mul(g_PushConstants.model, g_View);
    float4 localPos = mul(float4(input.pos, 1.0), modelView);
    output.position = mul(localPos, g_Projection);
    output.normal = mul(input.normal, (float3x3)modelView);
    float3 lightPos = float3(10.0, -10.0, 10.0);
    output.lightVec = lightPos.xyz;
    output.viewVec = -localPos.xyz;
    output.baseColorFactor = g_PushConstants.base_color_factor;
    output.metallicFactor = g_PushConstants.metallic_factor;
    output.roughnessFactor = g_PushConstants.roughness_factor;
    output.baseTextureIndex = g_PushConstants.baseTextureIndex;
    output.normalTextureIndex = g_PushConstants.normalTextureIndex;
    output.metallicRoughnessTextureIndex = g_PushConstants.metallicRoughnessTextureIndex;
    return output;
}

float4 getColor(VSOutput input)
{
    float4 color = input.baseColorFactor;
    if (input.baseTextureIndex != 0xffffffffu)
        color = sampleTexture(input.baseTextureIndex, input.uv);
    return color;
}

float3 getNormal(VSOutput input)
{
    float3 normal = input.normal;
    if (input.normalTextureIndex != 0xffffffffu)
        normal = sampleTexture(input.normalTextureIndex, input.uv).xyz * 2.0 - 1.0;
    return normal;
}

float3 getPBR(VSOutput input)
{
    float3 pbr = float3(input.metallicFactor, input.roughnessFactor, 0.0);
    if (input.metallicRoughnessTextureIndex != 0xffffffffu)
        pbr = sampleTexture(input.metallicRoughnessTextureIndex, input.uv).xyz;
    return pbr;
}

// model.frag
float4 model_ps(VSOutput input) : SV_Target
{
    float3 N = normalize(getNormal(input));
    float3 L = normalize(input.lightVec);
    float3 V = normalize(input.viewVec);
    float3 R = reflect(-L, N);
    float3 ambient = float3(0.25, 0.25, 0.25);
    float3 diffuse = max(dot(N, L), 0.0) * float3(0.75, 0.75, 0.75) * getPBR(input);
    float3 specular = pow(max(dot(R, V), 0.0), 16.0) * float3(0.75, 0.75, 0.75);
    float4 base_color = getColor(input);
    return float4(ambient * base_color.rgb + specular, base_color.a);
}

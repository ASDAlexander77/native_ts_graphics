/* Copyright (c) 2022-2024, Sascha Willems
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

// Port of Vulkan-Samples' graphics_pipeline_library shaders (shared.vert, uber.frag) to Donut's
// bindings: a model lit by one of three lighting models (LIGHTING_MODEL, the sample's
// specialization constant: Phong, toon, none), its color in the push constants. The TypeScript
// side gives the sample's projection with clip y negated for Donut's y-up clip space.

#include <donut/shaders/binding_helpers.hlsli>

#ifndef LIGHTING_MODEL
#define LIGHTING_MODEL 0
#endif

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

cbuffer UBO : register(b0)
{
    float4x4 g_Projection;
    float4x4 g_Model;
    float4 g_LightPos;
};

struct PushConsts
{
    float4 color;
};

DECLARE_PUSH_CONSTANTS(PushConsts, g_PushConsts, 1, 0);

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
    float3 color : COLOR;
    float3 viewVec : TEXCOORD0;
    float3 lightVec : TEXCOORD1;
};

// shared.vert
VSOutput shared_vs(VSInput input)
{
    VSOutput output;
    output.color = g_PushConsts.color.rgb;
    float4 pos = float4(input.pos.xyz, 1.0);
    output.position = mul(mul(pos, g_Model), g_Projection);
    pos = mul(pos, g_Model);
    output.normal = mul(input.normal, (float3x3)g_Model);
    float3 lPos = g_LightPos.xyz;
    output.lightVec = lPos - pos.xyz;
    output.viewVec = -pos.xyz;
    return output;
}

// uber.frag (the toon and unshaded models leave alpha unwritten: 0 here)
float4 uber_ps(VSOutput input) : SV_Target
{
#if LIGHTING_MODEL == 0
    // Phong
    float3 ambient = input.color * float3(0.25, 0.25, 0.25);
    float3 N = normalize(input.normal);
    float3 L = normalize(input.lightVec);
    float3 V = normalize(input.viewVec);
    float3 R = reflect(-L, N);
    float3 diffuse = max(dot(N, L), 0.0) * input.color;
    float3 specular = pow(max(dot(R, V), 0.0), 32.0) * float3(0.75, 0.75, 0.75);
    return float4(ambient + diffuse * 1.75 + specular, 1.0);
#elif LIGHTING_MODEL == 1
    // Toon
    float3 N = normalize(input.normal);
    float3 L = normalize(input.lightVec);
    float intensity = dot(N, L);
    float3 color;
    if (intensity > 0.98)
        color = input.color * 1.5;
    else if (intensity > 0.9)
        color = input.color * 1.0;
    else if (intensity > 0.5)
        color = input.color * 0.6;
    else if (intensity > 0.25)
        color = input.color * 0.4;
    else
        color = input.color * 0.2;
    // Desaturate a bit
    float gray = dot(float3(0.2126, 0.7152, 0.0722), color);
    color = lerp(color, float3(gray, gray, gray), 0.25);
    return float4(color, 0.0);
#else
    // No shading
    return float4(input.color, 0.0);
#endif
}

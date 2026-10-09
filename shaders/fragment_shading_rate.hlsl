/* Copyright (c) 2020-2024, Sascha Willems
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

// Port of Vulkan-Samples' fragment_shading_rate shaders (scene.vert, scene.frag) to Donut's
// bindings. Positions and directions are in the sample's view space; the TypeScript side gives its
// projection with clip y negated for Donut's y-up clip space, so the picture lands as the sample's
// does.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

#include <donut/shaders/binding_helpers.hlsli>

cbuffer c_Ubo : register(b0)
{
    float4x4 g_Projection;
    float4x4 g_ModelView;
    float4x4 g_SkysphereModelView;
    // 1: the shading rates shown.
    int g_ColorShadingRates;
};

// The draw's object: 0 the sky sphere, 1 a cube (offset).
struct PushConstants
{
    float4 offset;
    int objectType;
};
DECLARE_PUSH_CONSTANTS(PushConstants, g_Push, 1, 0);

Texture2D t_EnvMap : register(t0);
SamplerState s_EnvMap : register(s0);
Texture2D t_Sphere : register(t1);
SamplerState s_Sphere : register(s1);

struct VSInput
{
    float3 position : POSITION;
    float3 normal : NORMAL;
    float2 uv : TEXCOORD;
};

struct VSOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
    float3 pos : POSITION;
    float3 normal : NORMAL;
    float3 viewVec : TEXCOORD1;
    float3 lightVec : TEXCOORD2;
};

// scene.vert
VSOutput scene_vs(VSInput input)
{
    VSOutput output;
    if (g_Push.objectType == 0)
    {
        // Skysphere
        output.pos = mul(input.position, (float3x3)g_SkysphereModelView);
        output.position = mul(float4(output.pos, 1.0), g_Projection);
    }
    else
    {
        // Object
        const float3 localPos = input.position + g_Push.offset.xyz;
        output.pos = mul(float4(localPos, 1.0), g_ModelView).xyz;
        output.position = mul(mul(float4(localPos, 1.0), g_ModelView), g_Projection);
    }
    output.uv = input.uv;
    output.normal = mul(input.normal, (float3x3)g_ModelView);
    const float3 lightPos = mul(float3(0.0, -10.0, -10.0), (float3x3)g_ModelView);
    output.lightVec = lightPos - output.pos;
    output.viewVec = -output.pos;
    return output;
}

// scene.frag: the sky sphere's texture or the cubes' Phong shading; or, with the shading rates
// shown, the color's red darker the coarser the rate.
float4 scene_ps(VSOutput input, uint shadingRate : SV_ShadingRate) : SV_Target
{
    float4 color = float4(0.0, 0.0, 0.0, 0.0);
    if (g_Push.objectType == 0)
    {
        // Skysphere
        color = t_EnvMap.Sample(s_EnvMap, float2(input.uv.x, 1.0 - input.uv.y));
    }
    else
    {
        // Phong shading
        const float3 ambient = t_Sphere.Sample(s_Sphere, input.uv).rgb;
        const float3 N = normalize(input.normal);
        const float3 L = normalize(input.lightVec);
        const float3 V = normalize(input.viewVec);
        const float3 R = reflect(-L, N);
        const float3 diffuse = max(dot(N, L), 0.0).xxx;
        const float3 specular = pow(max(dot(R, V), 0.0), 8.0).xxx;
        color = float4(ambient + diffuse + specular, 1.0);
    }

    if (g_ColorShadingRates == 1)
    {
        // Visualize fragment shading rates: SV_ShadingRate bits as gl_ShadingRateEXT's (2 / 4
        // vertical pixels 0x1 / 0x2, 2 / 4 horizontal 0x4 / 0x8).
        int v = 1;
        int h = 1;
        if ((shadingRate & 0x1) == 0x1)
        {
            v = 2;
        }
        if ((shadingRate & 0x2) == 0x2)
        {
            v = 4;
        }
        if ((shadingRate & 0x4) == 0x4)
        {
            h = 2;
        }
        if ((shadingRate & 0x8) == 0x8)
        {
            h = 4;
        }
        if (v == 1 && h == 1)
        {
            return float4(color.rrr * 1.0, 1.0);
        }
        return float4(color.rrr * 1.0 - ((v + h) * 0.05), 1.0);
    }
    return float4(color.rgb, 1.0);
}

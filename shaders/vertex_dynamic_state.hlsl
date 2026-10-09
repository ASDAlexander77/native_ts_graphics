/* Copyright (c) 2022-2024, Mobica Limited
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

// Port of Vulkan-Samples' vertex_dynamic_state shaders (gbuffer.vert, gbuffer.frag; the same as
// dynamic_rendering's, which uses this file too) to Donut's bindings: a skybox of an HDR cube map
// (TYPE 0) and an object reflecting it (TYPE 1, the samples' specialization constant), tone mapped
// by exposure. The TypeScript side gives the sample's projection with clip y negated for Donut's
// y-up clip space.

#ifndef TYPE
#define TYPE 0
#endif

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

cbuffer UBO : register(b0)
{
    float4x4 g_Projection;
    float4x4 g_Modelview;
    float4x4 g_SkyboxModelview;
    float4x4 g_InverseModelview;
    float g_Modelscale;
};

TextureCube t_EnvMap : register(t0);
SamplerState s_EnvMap : register(s0);

struct VSInput
{
    float3 pos : POSITION;
    float3 normal : NORMAL;
};

struct VSOutput
{
    float4 position : SV_Position;
    float3 uvw : TEXCOORD0;
    float3 pos : TEXCOORD1;
    float3 normal : TEXCOORD2;
    float3 viewVec : TEXCOORD3;
    float3 lightVec : TEXCOORD4;
};

// gbuffer.vert
VSOutput gbuffer_vs(VSInput input)
{
    VSOutput output;
    output.uvw = input.pos;
#if TYPE == 0
    // Skybox
    output.pos = mul(input.pos, (float3x3)g_SkyboxModelview);
    output.position = mul(float4(output.pos, 1.0), g_Projection);
#else
    // Object
    output.pos = mul(float4(input.pos * g_Modelscale, 1.0), g_Modelview).xyz;
    output.position = mul(mul(float4(input.pos.xyz * g_Modelscale, 1.0), g_Modelview), g_Projection);
#endif
    output.normal = mul(input.normal, (float3x3)g_Modelview);
    float3 lightPos = float3(0.0f, -5.0f, 5.0f);
    output.lightVec = lightPos.xyz - output.pos.xyz;
    output.viewVec = -output.pos.xyz;
    return output;
}

// gbuffer.frag
float4 gbuffer_ps(VSOutput input) : SV_Target
{
    float4 color;
#if TYPE == 0
    // Skybox
    {
        float3 normal = normalize(input.uvw);
        color = t_EnvMap.Sample(s_EnvMap, normal);
    }
#else
    // Reflect
    {
        float3 wViewVec = mul(normalize(input.viewVec), (float3x3)g_InverseModelview);
        float3 normal = normalize(input.normal);
        float3 wNormal = mul(normal, (float3x3)g_InverseModelview);

        float NdotL = max(dot(normal, input.lightVec), 0.0);

        float3 eyeDir = normalize(input.viewVec);
        float3 halfVec = normalize(input.lightVec + eyeDir);
        float NdotH = max(dot(normal, halfVec), 0.0);
        float NdotV = max(dot(normal, eyeDir), 0.0);
        float VdotH = max(dot(eyeDir, halfVec), 0.0);

        // Geometric attenuation
        float NH2 = 2.0 * NdotH;
        float g1 = (NH2 * NdotV) / VdotH;
        float g2 = (NH2 * NdotL) / VdotH;
        float geoAtt = min(1.0, min(g1, g2));

        const float F0 = 0.6;
        const float k = 0.2;

        // Fresnel (schlick approximation)
        float fresnel = pow(1.0 - VdotH, 5.0);
        fresnel *= (1.0 - F0);
        fresnel += F0;

        // Note: clamp to zero to mitigate any divide by zero
        float spec = max((fresnel * geoAtt) / (NdotV * NdotL * 3.14), 0.0);

        color = t_EnvMap.Sample(s_EnvMap, reflect(-wViewVec, wNormal));

        color = float4(color.rgb * NdotL * (k + spec * (1.0 - k)), 1.0);
    }
#endif

    // Color with manual exposure (the sample leaves alpha unwritten: 0 here)
    const float exposure = 1.f;
    return float4(float3(1.0, 1.0, 1.0) - exp(-color.rgb * exposure), 0.0);
}

/* Copyright (c) 2019-2024, Sascha Willems
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

// Port of Vulkan-Samples' texture_loading shaders (texture.vert, texture.frag) to Donut's
// bindings: a textured quad lit by a light at the eye, its texture sampled with a level of detail
// bias. The TypeScript side gives the sample's projection with clip y negated for Donut's y-up
// clip space.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

cbuffer UBO : register(b0)
{
    float4x4 g_Projection;
    float4x4 g_Model;
    float4 g_ViewPos;
    float g_LodBias;
};

Texture2D t_Color : register(t0);
SamplerState s_Color : register(s0);

struct VSInput
{
    float3 pos : POSITION;
    float2 uv : TEXCOORD;
    float3 normal : NORMAL;
};

struct VSOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
    float lodBias : TEXCOORD1;
    float3 normal : TEXCOORD2;
    float3 viewVec : TEXCOORD3;
    float3 lightVec : TEXCOORD4;
};

// texture.vert
VSOutput texture_vs(VSInput input)
{
    VSOutput output;
    output.uv = input.uv;
    output.lodBias = g_LodBias;
    output.position = mul(mul(float4(input.pos.xyz, 1.0), g_Model), g_Projection);
    float4 pos = mul(float4(input.pos, 1.0), g_Model);
    // mat3(inverse(transpose(model))): the model is a rotation and a translation, so its own
    // rotation.
    output.normal = mul(input.normal, (float3x3)g_Model);
    float3 lightPos = float3(0.0, 0.0, 0.0);
    float3 lPos = mul(lightPos.xyz, (float3x3)g_Model);
    output.lightVec = lPos - pos.xyz;
    output.viewVec = g_ViewPos.xyz - pos.xyz;
    return output;
}

// texture.frag
float4 texture_ps(VSOutput input) : SV_Target
{
    float4 color = t_Color.SampleBias(s_Color, input.uv, input.lodBias);
    float3 N = normalize(input.normal);
    float3 L = normalize(input.lightVec);
    float3 V = normalize(input.viewVec);
    float3 R = reflect(-L, N);
    float3 diffuse = max(dot(N, L), 0.0) * float3(1.0, 1.0, 1.0);
    float specular = pow(max(dot(R, V), 0.0), 16.0) * color.a;
    return float4(diffuse * color.rgb + specular, 1.0);
}

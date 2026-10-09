/* Copyright (c) 2021-2024, Sascha Willems
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

// Port of Vulkan-Samples' texture_compression_basisu shaders (texture.vert, texture.frag) to
// Donut's bindings: a quad with the transcoded texture. The TypeScript side gives the sample's
// projection with clip y negated for Donut's y-up clip space.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

cbuffer UBO : register(b0)
{
    float4x4 g_Projection;
    float4x4 g_Model;
};

Texture2D t_Color : register(t0);
SamplerState s_Color : register(s0);

struct VSInput
{
    float3 pos : POSITION;
    float2 uv : TEXCOORD;
};

struct VSOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
};

// texture.vert
VSOutput texture_vs(VSInput input)
{
    VSOutput output;
    output.uv = input.uv;
    output.position = mul(mul(float4(input.pos.xyz, 1.0), g_Model), g_Projection);
    return output;
}

// texture.frag
float4 texture_ps(VSOutput input) : SV_Target
{
    return t_Color.Sample(s_Color, input.uv);
}

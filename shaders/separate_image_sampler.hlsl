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

// Port of Vulkan-Samples' separate_image_sampler shaders (separate_image_sampler.vert/.frag) to
// Donut's bindings: a textured quad, the image and the sampler bound separately (HLSL's textures
// and samplers always are; the sample's sampler is in a descriptor set of its own, a binding set
// of its own here). The TypeScript side gives the sample's projection with clip y negated for
// Donut's y-up clip space.

#include <donut/shaders/binding_helpers.hlsli>

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

cbuffer UBO : register(b0)
{
    float4x4 g_Projection;
    float4x4 g_Model;
    float4 g_ViewPos;
};

Texture2D t_Texture : register(t0);
// The sampler's own binding layout: descriptor set 1 on Vulkan; register space 0 on D3D (D3D11 has
// no spaces), its slot apart from the first layout's.
SamplerState s_Sampler : register(s0 VK_DESCRIPTOR_SET(1));

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
};

// separate_image_sampler.vert
VSOutput quad_vs(VSInput input)
{
    VSOutput output;
    output.uv = input.uv;
    output.position = mul(mul(float4(input.pos.xyz, 1.0), g_Model), g_Projection);
    return output;
}

// separate_image_sampler.frag: the texture sampled by combining the image and the selected sampler.
float4 quad_ps(VSOutput input) : SV_Target
{
    return t_Texture.Sample(s_Sampler, input.uv);
}

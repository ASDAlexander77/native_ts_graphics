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

// Port of Vulkan-Samples' texture_mipmap_generation shaders (texture.vert, texture.frag) to
// Donut's bindings, and the mip chain's generation: the sample blits each level from the one above
// it with linear filtering (vkCmdBlitImage); here a draw into each level samples the one above,
// bilinearly at the centers of its 2 x 2 texel blocks, in linear color as the blit filters.
// The TypeScript side gives the sample's projection with clip y negated for Donut's y-up clip
// space, so the picture lands as the sample's does.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

// --- The tunnel: texture.vert, texture.frag ----------------------------------------------------

cbuffer c_Ubo : register(b0)
{
    float4x4 g_Projection;
    float4x4 g_ModelView;
    float g_LodBias;
    int g_SamplerIndex;
};

// The texture with its mip chain, and the sample's three samplers: no mip maps (the levels of
// detail clamped to 0), mip maps (bilinear), mip maps with anisotropic filtering.
Texture2D t_Color : register(t0);
SamplerState s_NoMipMaps : register(s0);
SamplerState s_MipMaps : register(s1);
SamplerState s_Anisotropic : register(s2);

struct VSOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
};

// texture.vert
VSOutput main_vs(float3 position : POSITION, float2 uv : TEXCOORD)
{
    VSOutput output;
    output.uv = uv;
    output.position = mul(mul(float4(position, 1.0), g_ModelView), g_Projection);
    return output;
}

// texture.frag: the sampler the UI picks, the level of detail biased.
float4 main_ps(VSOutput input) : SV_Target
{
    const float2 uv = input.uv * float2(2.0, 0.25);
    float3 color;
    if (g_SamplerIndex == 0)
        color = t_Color.SampleBias(s_NoMipMaps, uv, g_LodBias).rgb;
    else if (g_SamplerIndex == 1)
        color = t_Color.SampleBias(s_MipMaps, uv, g_LodBias).rgb;
    else
        color = t_Color.SampleBias(s_Anisotropic, uv, g_LodBias).rgb;
    return float4(color, 1.0);
}

// --- Mip chain generation ------------------------------------------------------------------------

// The level above the one drawn into.
Texture2D t_Source : register(t0);
SamplerState s_Linear : register(s0);

// A triangle over the level drawn into.
void downsample_vs(uint vertexId : SV_VertexID, out float4 position : SV_Position, out float2 uv : TEXCOORD0)
{
    uv = float2((vertexId << 1) & 2, vertexId & 2);
    position = float4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
}

// Each texel: its 2 x 2 texels of the level above, averaged (bilinear at their shared corner).
float4 downsample_ps(float4 position : SV_Position, float2 uv : TEXCOORD0) : SV_Target
{
    return t_Source.SampleLevel(s_Linear, uv, 0.0);
}

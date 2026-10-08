/* Copyright (c) 2023-2025, Mobica Limited
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

// Port of Vulkan-Samples' sparse_image shaders (sparse.vert/frag), plus the mip generation the
// sample does with vkCmdBlitImage. The TypeScript side gives the sample's projection with clip y
// negated for Donut's y-up clip space.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

// --- The textured plane ------------------------------------------------------------------------

struct MvpTransform
{
    float4x4 model;
    float4x4 view;
    float4x4 proj;
};

cbuffer c_Mvp : register(b0)
{
    MvpTransform g_Mvp;
};

struct SettingsData
{
    uint colorHighlight;
    int minLOD;
    int maxLOD;
};

cbuffer c_Settings : register(b1)
{
    SettingsData g_Settings;
};

Texture2D t_Texture : register(t0);
SamplerState s_Texture : register(s0);

struct SceneVSOutput
{
    float4 position : SV_Position;
    float2 texCoord : TEXCOORD0;
};

// sparse.vert
SceneVSOutput scene_vs(float2 inPosition : POSITION, float2 inTexCoord : TEXCOORD0)
{
    SceneVSOutput output;
    output.position = mul(mul(mul(float4(inPosition, 0.0, 1.0), g_Mvp.model), g_Mvp.view), g_Mvp.proj);
    output.texCoord = inTexCoord;
    return output;
}

static const float3 color_blend_table[5] =
{
    float3(1.00, 1.00, 1.00),
    float3(0.80, 0.60, 0.40),
    float3(0.60, 0.80, 0.60),
    float3(0.40, 0.60, 0.80),
    float3(0.20, 0.20, 0.20),
};

// sparse.frag: the most detailed level whose texels are all mapped (sparseTextureLodARB and
// sparseTexelsResidentARB there, a sample's status and CheckAccessFullyMapped here), tinted by
// level with the color highlight.
float4 scene_ps(SceneVSOutput input) : SV_Target
{
    float4 color = 0.0;

    int lod = g_Settings.minLOD;
    uint residencyCode;
    color = t_Texture.SampleLevel(s_Texture, input.texCoord, lod, int2(0, 0), residencyCode);

    for (++lod; (lod <= g_Settings.maxLOD) && !CheckAccessFullyMapped(residencyCode); ++lod)
    {
        color = t_Texture.SampleLevel(s_Texture, input.texCoord, lod, int2(0, 0), residencyCode);
    }

    if (g_Settings.colorHighlight != 0)
    {
        lod -= 1;
        color.xyz = (color.xyz * color_blend_table[lod]);
    }

    return color;
}

// --- Mip generation -----------------------------------------------------------------------------

// The sample fills a level's page from the level above with vkCmdBlitImage, linear, at half the
// size: each texel the average of the 2 x 2 above it, in linear space (the texture is sRGB). Here a
// pass draws the page's rectangle (its viewport) into the level, reading the level above (t0, that
// level alone).

Texture2D t_Above : register(t0);

// A triangle over the viewport.
float4 mip_vs(uint vertexId : SV_VertexID) : SV_Position
{
    const float2 uv = float2((vertexId << 1) & 2, vertexId & 2);
    return float4(uv * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
}

float4 mip_ps(float4 position : SV_Position) : SV_Target
{
    const int2 above = int2(position.xy) * 2;
    return 0.25 * (t_Above.Load(int3(above, 0)) + t_Above.Load(int3(above + int2(1, 0), 0))
        + t_Above.Load(int3(above + int2(0, 1), 0)) + t_Above.Load(int3(above + int2(1, 1), 0)));
}

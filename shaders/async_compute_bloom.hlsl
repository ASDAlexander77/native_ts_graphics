/* Copyright (c) 2021-2026, Arm Limited and Contributors
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

// Port of Vulkan-Samples' async_compute shaders (shadow.vert/frag, forward.vert/frag,
// composite.vert/frag) to Donut's bindings, in one file; the compute shaders, which have push
// constants of their own (one block per file in SPIR-V), are in async_compute_bloom_post.hlsl.
// Positions and directions are in the sample's world (y up); the
// TypeScript side gives its matrices with clip y negated for Donut's y-up clip space, so the
// pictures land as the sample's do.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

#include <donut/shaders/binding_helpers.hlsli>

// --- Scene: shadow map and forward passes ----------------------------------------------------

// The sample's GlobalUniform (minus the model matrix, a push constant here), ShadowUniform and
// directional light.
struct SceneConstants
{
    float4x4 viewProj;
    // The sample's shadow matrix: world to the shadow map's texture coordinates and depth.
    float4x4 shadowMatrix;
    // rgb, w = intensity.
    float4 lightColor;
    float4 lightDirection;
};

cbuffer c_Scene : register(b0)
{
    SceneConstants g_Scene;
};

// Each draw's node transform.
struct DrawConstants
{
    float4x4 model;
};
DECLARE_PUSH_CONSTANTS(DrawConstants, g_Draw, 1, 0);

Texture2D t_BaseColor : register(t0);
SamplerState s_BaseColor : register(s0);
Texture2D<float> t_Shadow : register(t1);
SamplerComparisonState s_Shadow : register(s1);

// shadow.vert
float4 shadow_vs(float3 position : POSITION) : SV_Position
{
    float4 pos = mul(float4(position, 1.0), g_Draw.model);
    return mul(pos, g_Scene.viewProj);
}

// shadow.frag: depth only.
void shadow_ps()
{
}

struct ForwardVSInput
{
    float3 position : POSITION;
    float3 normal : NORMAL;
    float2 texcoord : TEXCOORD;
};

struct ForwardVSOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
    float3 normal : NORMAL;
    float4 shadowClip : TEXCOORD1;
};

// forward.vert
ForwardVSOutput forward_vs(ForwardVSInput input)
{
    ForwardVSOutput output;
    float4 pos = mul(float4(input.position, 1.0), g_Draw.model);
    output.uv = input.texcoord;
    output.normal = mul(input.normal, (float3x3)g_Draw.model);
    output.shadowClip = mul(pos, g_Scene.shadowMatrix);
    output.position = mul(pos, g_Scene.viewProj);
    return output;
}

// The sample's shadow test: textureProjLodOffset with a comparison (greater or equal: reversed
// depth) of the shadow map. NVRHI's comparison samplers test "less", the opposite, so the lit
// fraction is one minus theirs; bilinear filtering averages either the same way.
float shadowTap(float3 coord, int2 offset)
{
    return 1.0 - t_Shadow.SampleCmpLevelZero(s_Shadow, coord.xy, coord.z, offset);
}

// forward.frag, with lighting.h's apply_directional_light.
float4 forward_ps(ForwardVSOutput input) : SV_Target
{
    float3 normal = normalize(input.normal);

    float3 worldToLight = normalize(-g_Scene.lightDirection.xyz);
    float ndotl = saturate(dot(normal, worldToLight));
    float3 lightContribution = ndotl * g_Scene.lightColor.w * g_Scene.lightColor.rgb;

    float3 coord = input.shadowClip.xyz / input.shadowClip.w;
    float shadow = 0.0;
    shadow += shadowTap(coord, int2(0, 0)) / 4.0;
    shadow += shadowTap(coord, int2(-1, 0)) / 8.0;
    shadow += shadowTap(coord, int2(1, 0)) / 8.0;
    shadow += shadowTap(coord, int2(0, -1)) / 8.0;
    shadow += shadowTap(coord, int2(0, 1)) / 8.0;
    shadow += shadowTap(coord, int2(-1, -1)) / 16.0;
    shadow += shadowTap(coord, int2(1, 1)) / 16.0;
    shadow += shadowTap(coord, int2(-1, 1)) / 16.0;
    shadow += shadowTap(coord, int2(1, -1)) / 16.0;
    lightContribution *= shadow;

    float4 baseColor = t_BaseColor.Sample(s_BaseColor, input.uv);

    float3 ambientColor = 0.25 * baseColor.xyz;

    return float4(ambientColor + lightContribution * baseColor.xyz, baseColor.w);
}

// --- Composite: tone mapping into the swap chain ----------------------------------------------

Texture2D t_Hdr : register(t0);
Texture2D t_Bloom : register(t1);
SamplerState s_Linear : register(s0);

// composite.vert: the sample's triangle over the screen (in its clip space, y down), its vertices
// reordered to wind clockwise on the screen, Donut's front faces.
void composite_vs(uint vertexId : SV_VertexID, out float4 position : SV_Position, out float2 uv : TEXCOORD0)
{
    float2 pos;
    if (vertexId == 0)
        pos = float2(-1.0, -1.0);
    else if (vertexId == 1)
        pos = float2(3.0, -1.0);
    else
        pos = float2(-1.0, 3.0);

    uv = pos * 0.5 + 0.5;
    position = float4(pos.x, -pos.y, 0.0, 1.0);
}

// composite.frag
float4 composite_ps(float4 position : SV_Position, float2 uv : TEXCOORD0) : SV_Target
{
    // The most basic tonemap possible.
    float3 col = t_Hdr.SampleLevel(s_Linear, uv, 0.0).rgb + t_Bloom.SampleLevel(s_Linear, uv, 0.0).rgb;
    col = col / (1.0 + col);
    return float4(col, 1.0);
}

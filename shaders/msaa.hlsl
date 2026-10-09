/* Copyright (c) 2019-2025, Arm Limited and Contributors
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

// Port of the scene shaders Vulkan-Samples' msaa draws with, the framework's base.vert/base.frag
// (its forward subpass), to Donut's bindings; the post-processing pass's are in msaa_post.hlsl.
// Positions and directions are in the sample's world (y up); the TypeScript side gives its
// matrices with clip y negated for Donut's y-up clip space, so the pictures land as the sample's do.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

#include <donut/shaders/binding_helpers.hlsli>

// --- Scene: base.vert, base.frag ----------------------------------------------------------------

// The framework's GlobalUniform (minus the model matrix, a push constant here) and the scene's
// lights: Space Module has one directional light (and no point or spot lights, which base.frag
// loops over too).
struct SceneConstants
{
    float4x4 viewProj;
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

struct SceneVSInput
{
    float3 position : POSITION;
    float3 normal : NORMAL;
    float2 texcoord : TEXCOORD;
};

struct SceneVSOutput
{
    float4 position : SV_Position;
    float4 pos : POSITION;
    float2 uv : TEXCOORD0;
    float3 normal : NORMAL;
};

// base.vert
SceneVSOutput scene_vs(SceneVSInput input)
{
    SceneVSOutput output;
    output.pos = mul(float4(input.position, 1.0), g_Draw.model);
    output.uv = input.texcoord;
    output.normal = mul(input.normal, (float3x3)g_Draw.model);
    output.position = mul(output.pos, g_Scene.viewProj);
    return output;
}

// base.frag, with lighting.h's apply_directional_light.
float4 scene_ps(SceneVSOutput input) : SV_Target
{
    float3 normal = normalize(input.normal);

    float3 worldToLight = normalize(-g_Scene.lightDirection.xyz);
    float ndotl = saturate(dot(normal, worldToLight));
    float3 lightContribution = ndotl * g_Scene.lightColor.w * g_Scene.lightColor.rgb;

    float4 baseColor = t_BaseColor.Sample(s_BaseColor, input.uv);

    float3 ambientColor = 0.2 * baseColor.xyz;

    return float4(ambientColor + lightContribution * baseColor.xyz, baseColor.w);
}

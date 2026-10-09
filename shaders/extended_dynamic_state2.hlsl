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

// Port of Vulkan-Samples' extended_dynamic_state2 shaders (baseline, background and tess) to
// Donut's bindings, in one file. Positions and directions are in the sample's world and view spaces
// (y down on the screen); its projection, which the TypeScript side sets up, flips y for Donut's
// y-up clip space.

#include <donut/shaders/binding_helpers.hlsli>

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

cbuffer c_Common : register(b0)
{
    float4x4 g_Projection;
    float4x4 g_View;
};

cbuffer c_Baseline : register(b1)
{
    float4 g_AmbientLightColor;
    float4 g_LightPosition;
    float4 g_LightColor;
    float g_LightIntensity;
};

// The sample's push constants: the node's model matrix and color.
struct NodeConstants
{
    float4x4 model;
    float4 color;
};

DECLARE_PUSH_CONSTANTS(NodeConstants, g_Node, 2, 0);

cbuffer c_Tessellation : register(b3)
{
    float g_TessellationFactor;
};

TextureCube t_EnvMap : register(t0);
SamplerState s_EnvMap : register(s0);

struct VSInput
{
    float3 pos : POSITION;
    float3 normal : NORMAL;
};

// --- baseline: the scene's objects and the restarting cube, lit ------------------------------

struct BaselineVSOutput
{
    float4 position : SV_Position;
    float3 normal : NORMAL;
    float4 color : COLOR;
    float3 lightVec : LIGHT_VEC;
    float3 lightColor0 : LIGHT_COLOR0;
    float3 lightColor1 : LIGHT_COLOR1;
    float3 viewVec : VIEW_VEC;
    float lightIntensity : LIGHT_INTENSITY;
};

BaselineVSOutput baseline_vs(VSInput input)
{
    BaselineVSOutput output;
    output.color = g_Node.color;
    float4x4 modelView = mul(g_Node.model, g_View);
    float4 localPos = mul(float4(input.pos, 1.0), modelView);
    output.position = mul(localPos, g_Projection);
    output.normal = mul(input.normal, (float3x3) modelView);
    float4 positionWorld = mul(float4(input.pos, 1.0), g_Node.model);
    output.lightVec = g_LightPosition.xyz - positionWorld.xyz;
    output.lightColor0 = g_LightColor.xyz * g_LightColor.w;
    output.lightColor1 = g_AmbientLightColor.xyz * g_AmbientLightColor.w;
    output.viewVec = -localPos.xyz;
    output.lightIntensity = g_LightIntensity;
    return output;
}

float4 baseline_ps(BaselineVSOutput input) : SV_Target
{
    float attenuation = 1.0 / dot(input.lightVec, input.lightVec);
    float3 N = normalize(input.normal);
    float3 L = normalize(input.lightVec);
    float3 V = normalize(input.viewVec);
    float3 R = reflect(-L, N);
    float3 diffuse = input.lightColor0 * attenuation * max(dot(N, L), 0) * input.lightIntensity;
    float3 ambient = input.lightColor1;
    float3 specular = pow(max(dot(R, V), 0.0), 16.0) * float3(0.65, 0.65, 0.65);
    return float4((ambient + diffuse) * input.color.rgb + (specular * input.lightIntensity / 50), input.color.a);
}

// --- background: the environment cube map on a cube around the eye ---------------------------

struct BackgroundVSOutput
{
    float4 position : SV_Position;
    float3 uvw : UVW;
};

BackgroundVSOutput background_vs(VSInput input)
{
    BackgroundVSOutput output;
    output.uvw = input.pos;
    output.position = mul(float4(mul(input.pos * 10, (float3x3) g_View), 1.0), g_Projection);
    return output;
}

float4 background_ps(BackgroundVSOutput input) : SV_Target
{
    float3 normal = normalize(input.uvw);
    float4 color = t_EnvMap.Sample(s_EnvMap, normal);
    return float4(color.rgb, 1.0);
}

// --- tess: the geosphere, tessellated (a factor of 1 when off), as a wireframe ---------------

struct TessVSOutput
{
    float4 position : POSITION;
};

TessVSOutput tess_vs(VSInput input)
{
    TessVSOutput output;
    output.position = float4(input.pos, 1.0);
    return output;
}

struct TessFactors
{
    float edges[3] : SV_TessFactor;
    float inside : SV_InsideTessFactor;
};

TessFactors tess_constants()
{
    // Zero sets all tessellation factors to 1.
    float factor = g_TessellationFactor > 0.0 ? g_TessellationFactor : 1.0;
    TessFactors output;
    output.edges[0] = factor;
    output.edges[1] = factor;
    output.edges[2] = factor;
    output.inside = factor;
    return output;
}

[domain("tri")]
[partitioning("integer")]
[outputtopology("triangle_cw")]
[outputcontrolpoints(3)]
[patchconstantfunc("tess_constants")]
TessVSOutput tess_hs(InputPatch<TessVSOutput, 3> patch, uint id : SV_OutputControlPointID)
{
    return patch[id];
}

[domain("tri")]
float4 tess_ds(TessFactors factors, float3 tessCoord : SV_DomainLocation,
    const OutputPatch<TessVSOutput, 3> patch) : SV_Position
{
    float4 pos = tessCoord.x * patch[0].position + tessCoord.y * patch[1].position + tessCoord.z * patch[2].position;
    return mul(mul(mul(pos, g_Node.model), g_View), g_Projection);
}

float4 tess_ps() : SV_Target
{
    return float4(0.6667, 0.1176, 0.1176, 1.0);
}

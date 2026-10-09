/* Copyright (c) 2023-2024, Mobica Limited
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

// Port of Vulkan-Samples' logic_op_dynamic_state shaders (background.vert/frag,
// baseline.vert/frag). The TypeScript side gives the sample's projection with clip y negated for
// Donut's y-up clip space. With UINT_OUTPUT=1 (D3D: D3D12 has logic operations on UINT targets
// only), the cube's logic operation is on a UINT view of the color target, and its pixel shader
// converts its color to the bytes a UNORM target would store; with 0 (Vulkan), it writes the UNORM
// target itself, as the sample does.

#include <donut/shaders/binding_helpers.hlsli>

#ifndef UINT_OUTPUT
#define UINT_OUTPUT 0
#endif

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

struct UBO
{
    float4x4 projection;
    float4x4 view;
};

cbuffer c_UBO : register(b0)
{
    UBO ubo;
};

// --- Background ---------------------------------------------------------------------------------

TextureCube samplerEnvMap : register(t0);
SamplerState s_EnvMap : register(s0);

struct BackgroundVSOutput
{
    float4 position : SV_Position;
    float3 uvw : TEXCOORD0;
};

// background.vert
BackgroundVSOutput background_vs(float3 inPos : POSITION)
{
    BackgroundVSOutput output;
    output.uvw = inPos;
    output.position = mul(float4(mul(inPos * 10, (float3x3)ubo.view), 1.0), ubo.projection);
    return output;
}

// background.frag
float4 background_ps(BackgroundVSOutput input) : SV_Target
{
    float3 normal = normalize(input.uvw);
    float4 color = samplerEnvMap.Sample(s_EnvMap, normal);
    return float4(color.rgb, 1.0);
}

// --- Baseline: the cube -------------------------------------------------------------------------

struct UBOBaseline
{
    float4 ambientLightColor;
    float4 lightPosition;
    float4 lightColor;
    float lightIntensity;
};

cbuffer c_UBOBaseline : register(b1)
{
    UBOBaseline ubo_baseline;
};

struct PushConstants
{
    float4x4 model;
    float4 color;
};

DECLARE_PUSH_CONSTANTS(PushConstants, push_constants, 2, 0);

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

// baseline.vert
BaselineVSOutput baseline_vs(float3 inPos : POSITION, float3 inNormal : NORMAL)
{
    BaselineVSOutput output;
    output.color = push_constants.color;
    const float4x4 modelView = mul(push_constants.model, ubo.view);
    float4 localPos = mul(float4(inPos, 1.0), modelView);
    output.position = mul(localPos, ubo.projection);
    output.normal = mul(inNormal, (float3x3)modelView);
    float4 positionWorld = mul(float4(inPos, 1.0), push_constants.model);
    output.lightVec = ubo_baseline.lightPosition.xyz - positionWorld.xyz;
    output.lightColor0 = ubo_baseline.lightColor.xyz * ubo_baseline.lightColor.w;
    output.lightColor1 = ubo_baseline.ambientLightColor.xyz * ubo_baseline.ambientLightColor.w;
    output.viewVec = -localPos.xyz;
    output.lightIntensity = ubo_baseline.lightIntensity;
    return output;
}

// baseline.frag
#if UINT_OUTPUT
uint4 baseline_ps(BaselineVSOutput input) : SV_Target
#else
float4 baseline_ps(BaselineVSOutput input) : SV_Target
#endif
{
    float attenuation = 1.0 / dot(input.lightVec, input.lightVec);

    float3 N = normalize(input.normal);
    float3 L = normalize(input.lightVec);
    float3 V = normalize(input.viewVec);
    float3 R = reflect(-L, N);

    float3 diffuse = input.lightColor0 * attenuation * max(dot(N, L), 0) * input.lightIntensity;
    float3 ambient = input.lightColor1;
    float3 specular = pow(max(dot(R, V), 0.0), 16.0) * float3(0.65, 0.65, 0.65);
    float4 outColor0 = float4((ambient + diffuse) * input.color.rgb + (specular * input.lightIntensity / 50), input.color.a);
#if UINT_OUTPUT
    // As UNORM: to the nearest of 0..255. (A UNORM target's own conversion may differ by 1: with
    // NVIDIA's Vulkan driver, a fifth of the cube's pixels store one less.)
    return uint4(round(saturate(outColor0) * 255.0));
#else
    return outColor0;
#endif
}

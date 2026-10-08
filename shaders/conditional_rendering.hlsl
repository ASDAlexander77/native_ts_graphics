/* Copyright (c) 2022-2024, Sascha Willems
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

// Port of Vulkan-Samples' conditional_rendering shaders (model.vert/frag). The TypeScript side
// gives the sample's projection with clip y negated for Donut's y-up clip space.

#include <donut/shaders/binding_helpers.hlsli>

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

struct SceneConstants
{
    float4x4 projection;
    float4x4 view;
};

cbuffer c_Scene : register(b0)
{
    SceneConstants g_Scene;
};

// The sample's push constants: the node's world matrix and its material's color.
struct NodeConstants
{
    float4x4 model;
    float4 color;
};

DECLARE_PUSH_CONSTANTS(NodeConstants, g_Node, 1, 0);

struct ModelVSOutput
{
    float4 position : SV_Position;
    float3 normal : NORMAL;
    float3 color : COLOR;
    float3 viewVec : VIEW_VEC;
    float3 lightVec : LIGHT_VEC;
};

// model.vert
ModelVSOutput model_vs(float3 inPos : POSITION, float3 inNormal : NORMAL)
{
    ModelVSOutput output;
    output.color = g_Node.color.rgb;
    const float4x4 modelView = mul(g_Node.model, g_Scene.view);
    const float4 localPos = mul(float4(inPos, 1.0), modelView);
    output.position = mul(localPos, g_Scene.projection);
    output.normal = mul(inNormal, (float3x3)modelView);
    const float3 lightPos = float3(10.0, -10.0, 10.0);
    output.lightVec = lightPos - localPos.xyz;
    output.viewVec = -localPos.xyz;
    return output;
}

// model.frag
float4 model_ps(ModelVSOutput input) : SV_Target
{
    const float3 N = normalize(input.normal);
    const float3 L = normalize(input.lightVec);
    const float3 V = normalize(input.viewVec);
    const float3 R = reflect(-L, N);
    const float3 ambient = 0.25;
    const float3 diffuse = max(dot(N, L), 0.0) * float3(1.0, 1.0, 1.0);
    const float3 specular = pow(max(dot(R, V), 0.0), 16.0) * float3(0.75, 0.75, 0.75);
    return float4((ambient + diffuse) * input.color.rgb + specular, 1.0);
}

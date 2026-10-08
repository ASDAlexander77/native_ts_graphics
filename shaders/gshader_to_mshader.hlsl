/* Copyright (c) 2024-2026, Mobica Limited
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

// Port of Vulkan-Samples' gshader_to_mshader shaders: the lit model (gshader_to_mshader.vert/frag)
// and the geometry shader that draws its normals (gshader_to_mshader_base.vert,
// gshader_to_mshader.geom, gshader_to_mshader_base.frag). The mesh shader that draws them too is in
// gshader_to_mshader_mesh.hlsl: D3D11 has no mesh shaders. The TypeScript side gives the sample's
// projection with clip y negated for Donut's y-up clip space.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

// The sample's three uniform buffers (vertex, geometry, mesh shader) hold the same matrices: one
// constant buffer here, for every stage.
struct SceneConstants
{
    float4x4 model;
    float4x4 view;
    float4x4 projection;
    // transpose(inverse(view * model)).
    float4x4 normal;
};

cbuffer c_Scene : register(b0)
{
    SceneConstants g_Scene;
};

// --- The model, lit ----------------------------------------------------------------------------

struct ModelVSOutput
{
    float4 position : SV_Position;
    float3 normal : NORMAL;
    float3 color : COLOR;
    float3 viewVec : VIEW_VEC;
    float3 lightVec : LIGHT_VEC;
};

// gshader_to_mshader.vert
ModelVSOutput model_vs(float3 inPosition : POSITION, float3 inNormal : NORMAL)
{
    ModelVSOutput output;
    output.color = float3(0.0, 1.0, 1.0);
    output.position = mul(mul(mul(float4(inPosition, 1.0), g_Scene.model), g_Scene.view), g_Scene.projection);

    const float4 fragPos = mul(float4(inPosition, 1.0), g_Scene.model);
    const float3 lightPos = float3(-20.0, 5.0, 5.0);
    const float3 lPos = mul(lightPos, (float3x3)g_Scene.model);
    output.normal = mul(inNormal, (float3x3)g_Scene.normal);

    output.lightVec = lPos - fragPos.xyz;
    output.viewVec = -mul(mul(float4(inPosition, 1.0), g_Scene.model), g_Scene.view).xyz;
    return output;
}

// gshader_to_mshader.frag
float4 model_ps(ModelVSOutput input) : SV_Target
{
    const float ambientStrength = 0.2;
    const float3 ambient = ambientStrength * float3(1.0, 1.0, 1.0);

    const float3 N = normalize(input.normal);
    const float3 L = normalize(input.lightVec);
    const float3 V = normalize(input.viewVec);
    const float3 R = reflect(-L, N);

    const float3 diffuse = max(dot(N, L), 0.0) * float3(1.0, 1.0, 1.0);

    const float3 specular = pow(max(dot(R, V), 0.0), 64.0) * float3(0.65, 0.65, 0.65);

    const float3 result = (ambient + diffuse) * input.color + specular;
    return float4(result, 1.0);
}

// --- The normals, by a geometry shader ---------------------------------------------------------

struct BaseVSOutput
{
    // In model space: the geometry shader transforms what it emits.
    float4 position : SV_Position;
    float3 normal : NORMAL;
};

// gshader_to_mshader_base.vert
BaseVSOutput base_vs(float3 inPosition : POSITION, float3 inNormal : NORMAL)
{
    BaseVSOutput output;
    output.normal = inNormal;
    output.position = float4(inPosition, 1.0);
    return output;
}

struct NormalVertex
{
    float4 position : SV_Position;
    float3 color : COLOR;
};

// gshader_to_mshader.geom: a line per triangle, from its middle along its first vertex's normal.
[maxvertexcount(2)]
void normals_gs(triangle BaseVSOutput input[3], inout LineStream<NormalVertex> output)
{
    const float normalLength = 0.1;

    // middle point of triangle
    const float3 pos = (input[0].position.xyz + input[1].position.xyz + input[2].position.xyz) / 3.0;
    const float3 normal = input[0].normal;

    const float4x4 modelViewProjection = mul(mul(g_Scene.model, g_Scene.view), g_Scene.projection);

    // line vertices
    NormalVertex vertex;
    vertex.position = mul(float4(pos, 1.0), modelViewProjection);
    vertex.color = float3(1.0, 0.0, 0.0);
    output.Append(vertex);

    vertex.position = mul(float4(pos + normal * normalLength, 1.0), modelViewProjection);
    vertex.color = float3(0.0, 0.0, 1.0);
    output.Append(vertex);

    output.RestartStrip();
}

// gshader_to_mshader_base.frag
float4 base_ps(NormalVertex input) : SV_Target
{
    return float4(input.color, 1.0);
}

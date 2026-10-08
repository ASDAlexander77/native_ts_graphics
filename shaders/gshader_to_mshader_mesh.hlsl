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

// Port of Vulkan-Samples' gshader_to_mshader mesh shader (gshader_to_mshader.mesh,
// gshader_to_mshader_mesh.frag): the model's normals as gshader_to_mshader.hlsl's geometry shader
// draws them, a group per meshlet. A file of its own: D3D11 has no mesh shaders.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

// As gshader_to_mshader.hlsl's.
struct SceneConstants
{
    float4x4 model;
    float4x4 view;
    float4x4 projection;
    float4x4 normal;
};

cbuffer c_Scene : register(b0)
{
    SceneConstants g_Scene;
};

#define MESHLET_MAX_VERTICES 64
#define MESHLET_MAX_INDICES 126

// The Vulkan-Samples framework's meshlets (its glTF loader's prepare_meshlets): whole triangles of
// the model's index buffer, at most 96 indices (32 triangles, so 64 line vertices) or 64 different
// vertices each. The indices index the whole model's vertices; `vertices` (those vertices) goes
// unused.
struct Meshlet
{
    uint vertices[MESHLET_MAX_VERTICES];
    uint indices[MESHLET_MAX_INDICES];
    uint vertexCount;
    uint indexCount;
};

StructuredBuffer<Meshlet> t_Meshlets : register(t0);

struct Vertex
{
    float4 position;
    float4 normal;
};

StructuredBuffer<Vertex> t_Vertices : register(t1);

struct MeshVertex
{
    float4 position : SV_Position;
    float4 color : COLOR;
};

// gshader_to_mshader.mesh: one thread per meshlet, a line per triangle, from its middle along its
// first vertex's normal (from blue to red: the geometry shader's colors the other way round).
[numthreads(1, 1, 1)]
[outputtopology("line")]
void normals_ms(
    uint3 groupId : SV_GroupID,
    out indices uint2 lines[MESHLET_MAX_INDICES],
    out vertices MeshVertex verts[MESHLET_MAX_VERTICES])
{
    const uint meshletIndex = groupId.x;
    const uint indexCount = t_Meshlets[meshletIndex].indexCount;
    const uint primitiveCount = indexCount / 3;
    SetMeshOutputCounts(primitiveCount * 2, primitiveCount);

    const float normalLength = 0.1;

    const float4x4 modelViewProjection = mul(mul(g_Scene.model, g_Scene.view), g_Scene.projection);

    uint j = 0;
    uint k = 0;
    for (uint i = 0; i < primitiveCount; ++i)
    {
        // triangle indices
        const uint vi1 = t_Meshlets[meshletIndex].indices[j];
        const uint vi2 = t_Meshlets[meshletIndex].indices[j + 1];
        const uint vi3 = t_Meshlets[meshletIndex].indices[j + 2];

        // middle point of triangle
        const float3 pos = (t_Vertices[vi1].position.xyz + t_Vertices[vi2].position.xyz + t_Vertices[vi3].position.xyz) / 3.0;
        const float3 normal = t_Vertices[vi1].normal.xyz;

        // line vertices
        verts[k].position = mul(float4(pos, 1.0), modelViewProjection);
        verts[k].color = float4(0.0, 0.0, 1.0, 1.0);

        verts[k + 1].position = mul(float4(pos + normal * normalLength, 1.0), modelViewProjection);
        verts[k + 1].color = float4(1.0, 0.0, 0.0, 1.0);

        k = k + 2;
        j = j + 3;
    }

    // indices for line vertices
    k = 0;
    for (uint p = 0; p < primitiveCount; p++)
    {
        lines[p] = uint2(k, k + 1);
        k = k + 2;
    }
}

// gshader_to_mshader_mesh.frag
float4 mesh_ps(MeshVertex input) : SV_Target
{
    return input.color;
}

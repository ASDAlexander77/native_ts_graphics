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

// Port of Vulkan-Samples' mesh_shader_culling shaders (mesh_shader_culling.task/mesh/frag,
// mesh_shader_shared.h). The quads are made in the sample's clip space (y down on the screen); the
// mesh shader negates y for Donut's y-up clip space.

// Number of task shader invocations per task shader workgroup
#define NUM_TASK_INVOCATIONS_X 2
#define NUM_TASK_INVOCATIONS_Y 2

#define NUM_MESH_INVOCATIONS_X 2
#define NUM_MESH_INVOCATIONS_Y 2

struct CullConstants
{
    float cullCenterX;
    float cullCenterY;
    float cullRadius;
    float meshletDensity;
    // The task shader workgroups launched (GLSL's gl_NumWorkGroups, which HLSL doesn't have).
    uint2 numWorkGroups;
};

cbuffer c_Cull : register(b0)
{
    CullConstants g_Cull;
};

// The data shared with the mesh shaders: the position of the whole square, the offsets of the
// sub-rects of this task shader workgroup that are kept, and the size of a sub-rect.
struct SharedData
{
    float2 position;
    float2 offsets[NUM_TASK_INVOCATIONS_X * NUM_TASK_INVOCATIONS_Y];
    float2 size;
};

float square(float x)
{
    return x * x;
}

float square(float2 p)
{
    return p.x * p.x + p.y * p.y;
}

// --- Task (amplification) shader ------------------------------------------------------------------

groupshared SharedData s_SharedData;

// mesh_shader_culling.task: each invocation keeps its sub-rect if all of its corners are within the
// culling circle, and the workgroup launches a mesh shader workgroup per sub-rect kept.
[numthreads(NUM_TASK_INVOCATIONS_X, NUM_TASK_INVOCATIONS_Y, 1)]
void cull_as(uint3 globalInvocationId : SV_DispatchThreadID, uint localInvocationIndex : SV_GroupIndex)
{
    // calculate size and offset of sub-rect per task shader invocation
    const float2 size = 2.0 / float2(g_Cull.numWorkGroups * uint2(NUM_TASK_INVOCATIONS_X, NUM_TASK_INVOCATIONS_Y));
    const float2 offset = float2(globalInvocationId.xy) * size;

    // determine the four corners of the sub-rect and check if it's completely out of the culling circle
    // (ignoring the case that a sub-rect could completely include the culling circle...)

    const float2 position = float2(g_Cull.cullCenterX, g_Cull.cullCenterY);
    const float2 p0 = position + offset;
    const float2 p1 = p0 + float2(size.x, 0.0);
    const float2 p2 = p0 + size;
    const float2 p3 = p0 + float2(0.0, size.y);
    const float squaredRadius = square(g_Cull.cullRadius);
    const bool isValid = (square(p0) < squaredRadius)
                      && (square(p1) < squaredRadius)
                      && (square(p2) < squaredRadius)
                      && (square(p3) < squaredRadius);

    if (isValid)
    {
        // get the next free index into the offsets array (subgroupBallotExclusiveBitCount)
        const uint index = WavePrefixCountBits(isValid);
        s_SharedData.offsets[index] = offset;
    }
    if (localInvocationIndex == 0)
    {
        s_SharedData.position = position;
        s_SharedData.size = size;
    }

    // the actual number of task shader invocations that are determined to display something
    // (subgroupBallotBitCount); the whole workgroup launches the mesh shaders, once
    const uint validCount = WaveActiveCountBits(isValid);
    DispatchMesh(validCount, 1, 1, s_SharedData);
}

// --- Mesh shader ----------------------------------------------------------------------------------

struct MeshVertex
{
    float4 position : SV_Position;
    float3 color : COLOR;
};

// mesh_shader_culling.mesh: each invocation emits a quad (4 vertices, 2 triangles) of its part of
// the sub-rect.
[numthreads(NUM_MESH_INVOCATIONS_X, NUM_MESH_INVOCATIONS_Y, 1)]
[outputtopology("triangle")]
void cull_ms(
    uint3 workGroupId : SV_GroupID,
    uint3 localInvocationId : SV_GroupThreadID,
    uint localInvocationIndex : SV_GroupIndex,
    in payload SharedData sharedData,
    out vertices MeshVertex verts[4 * NUM_MESH_INVOCATIONS_X * NUM_MESH_INVOCATIONS_Y],
    out indices uint3 triangles[2 * NUM_MESH_INVOCATIONS_X * NUM_MESH_INVOCATIONS_Y])
{
    // set the number of vertices and primitives to put out for the complete workgroup
    SetMeshOutputCounts(4 * NUM_MESH_INVOCATIONS_X * NUM_MESH_INVOCATIONS_Y, 2 * NUM_MESH_INVOCATIONS_X * NUM_MESH_INVOCATIONS_Y);

    // determine 4 vertices by combining some global position and offset, as well as some local offset and size
    const float2 globalOffset = sharedData.offsets[workGroupId.x];
    const float2 localSize = sharedData.size / float2(NUM_MESH_INVOCATIONS_X, NUM_MESH_INVOCATIONS_Y);
    const float2 localOffset = float2(localInvocationId.xy) * localSize;
    const float2 v0 = sharedData.position + globalOffset + localOffset;
    const float2 v1 = v0 + float2(localSize.x, 0.0);
    const float2 v2 = v0 + localSize;
    const float2 v3 = v0 + float2(0.0, localSize.y);

    const uint vertexBaseIndex = 4 * localInvocationIndex;
    verts[vertexBaseIndex + 0].position = float4(v0.x, -v0.y, 0.0, 1.0);
    verts[vertexBaseIndex + 1].position = float4(v1.x, -v1.y, 0.0, 1.0);
    verts[vertexBaseIndex + 2].position = float4(v2.x, -v2.y, 0.0, 1.0);
    verts[vertexBaseIndex + 3].position = float4(v3.x, -v3.y, 0.0, 1.0);

    const uint primitiveBaseIndex = 2 * localInvocationIndex;
    triangles[primitiveBaseIndex + 0] = uint3(vertexBaseIndex + 0, vertexBaseIndex + 1, vertexBaseIndex + 2);
    triangles[primitiveBaseIndex + 1] = uint3(vertexBaseIndex + 2, vertexBaseIndex + 3, vertexBaseIndex + 0);

    verts[vertexBaseIndex + 0].color = float3(1.0, 0.0, 0.0);
    verts[vertexBaseIndex + 1].color = float3(0.0, 1.0, 0.0);
    verts[vertexBaseIndex + 2].color = float3(0.0, 0.0, 1.0);
    verts[vertexBaseIndex + 3].color = float3(1.0, 1.0, 0.0);
}

// mesh_shader_culling.frag
float4 cull_ps(MeshVertex input) : SV_Target
{
    return float4(input.color, 1.0);
}

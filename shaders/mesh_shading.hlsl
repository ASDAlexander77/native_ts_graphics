/* Copyright (c) 2023-2024, Holochip Corporation
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

// Port of Vulkan-Samples' mesh_shading shaders (ms.mesh, ps.frag): one mesh shader workgroup
// outputs one triangle, drawn red. Clip y is negated for Donut's y-up clip space.

struct MeshOutput
{
    float4 position : SV_Position;
};

// ms.mesh
[outputtopology("triangle")]
[numthreads(1, 1, 1)]
void triangle_ms(out vertices MeshOutput verts[3], out indices uint3 triangles[1])
{
    uint vertexCount = 3;
    uint triangleCount = 1;
    SetMeshOutputCounts(vertexCount, triangleCount);
    verts[0].position = float4(0.5, 0.5, 0, 1);
    verts[1].position = float4(0.5, -0.5, 0, 1);
    verts[2].position = float4(-0.5, -0.5, 0, 1);
    triangles[0] = uint3(0, 1, 2);
}

// ps.frag
float4 triangle_ps() : SV_Target
{
    return float4(1.0, 0.0, 0.0, 1.0);
}

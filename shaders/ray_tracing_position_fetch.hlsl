/* Copyright (c) 2024-2025, Sascha Willems
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

// Port of Vulkan-Samples' ray_tracing_position_fetch shaders (raygen.rgen, closesthit.rchit,
// miss.rmiss) to Donut's bindings, in one library. The closest hit shader reads the hit triangle's
// vertex positions from the acceleration structure (SPV_KHR_ray_tracing_position_fetch's
// HitTriangleVertexPositionsKHR built-in, as DXC's inline SPIR-V): Vulkan only, D3D12 has it through
// NVAPI only. Positions and directions are in the sample's world, its matrices as they are: the rays
// are the sample's and land in the same pixels.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

RaytracingAccelerationStructure t_TopLevelAS : register(t0);
RWTexture2D<float4> u_Image : register(u0);

cbuffer c_Ubo : register(b0)
{
    float4x4 g_ViewInverse;
    float4x4 g_ProjInverse;
    int g_DisplayMode;
};

struct Payload
{
    float3 hitValue;
};

struct Attributes
{
    float2 bary;
};

// raygen.rgen
[shader("raygeneration")]
void raygen()
{
    const float2 pixelCenter = float2(DispatchRaysIndex().xy) + 0.5;
    const float2 inUV = pixelCenter / float2(DispatchRaysDimensions().xy);
    const float2 d = inUV * 2.0 - 1.0;

    const float4 origin = mul(float4(0.0, 0.0, 0.0, 1.0), g_ViewInverse);
    const float4 target = mul(float4(d.x, d.y, 1.0, 1.0), g_ProjInverse);
    const float4 direction = mul(float4(normalize(target.xyz), 0.0), g_ViewInverse);

    RayDesc ray;
    ray.Origin = origin.xyz;
    ray.Direction = direction.xyz;
    ray.TMin = 0.001;
    ray.TMax = 10000.0;

    Payload payload;
    payload.hitValue = float3(0.0, 0.0, 0.0);
    TraceRay(t_TopLevelAS, RAY_FLAG_FORCE_OPAQUE, 0xff, 0, 0, 0, ray, payload);

    u_Image[DispatchRaysIndex().xy] = float4(payload.hitValue, 0.0);
}

// The hit triangle's vertex positions, in the BLAS geometry's space (its transform applied).
#define HitTriangleVertexPositionsKHR 5335
#define RayTracingPositionFetchKHR 5336

[[vk::ext_extension("SPV_KHR_ray_tracing_position_fetch")]]
[[vk::ext_capability(RayTracingPositionFetchKHR)]]
[[vk::ext_builtin_input(HitTriangleVertexPositionsKHR)]]
static const float3 gl_HitTriangleVertexPositions[3];

// closesthit.rchit
[shader("closesthit")]
void closesthit(inout Payload payload, in Attributes attribs)
{
    // The barycentric coordinates of the hit, for the position there.
    const float3 barycentricCoords = float3(1.0 - attribs.bary.x - attribs.bary.y, attribs.bary.x, attribs.bary.y);

    const float3 pos0 = gl_HitTriangleVertexPositions[0];
    const float3 pos1 = gl_HitTriangleVertexPositions[1];
    const float3 pos2 = gl_HitTriangleVertexPositions[2];
    const float3 currentPos = pos0 * barycentricCoords.x + pos1 * barycentricCoords.y + pos2 * barycentricCoords.z;

    payload.hitValue = float3(0.0, 0.0, 0.0);

    switch (g_DisplayMode)
    {
    case 0:
    {
        // The geometric normal (normal * gl_WorldToObjectEXT: a row vector by the 3 x 4 matrix).
        float3 normal = normalize(cross(pos1 - pos0, pos2 - pos0));
        normal = normalize(mul(normal, WorldToObject3x4()).xyz);
        payload.hitValue = normal;
        break;
    }
    case 1:
        // The vertex position.
        payload.hitValue = currentPos;
        break;
    }
}

// miss.rmiss
[shader("miss")]
void miss(inout Payload payload)
{
    payload.hitValue = float3(0.0, 0.0, 0.2);
}

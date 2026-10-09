/*
 * Copyright (c) 2021-2026, NVIDIA CORPORATION.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
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

// Port of Vulkan-Samples' ray_tracing_reflection shaders (raygen.rgen, closesthit.rchit,
// miss.rmiss, missShadow.rmiss) to Donut's bindings: a ray per pixel bounced up to 64 times off
// the scene's reflective materials, each hit lit by a hard-coded light with a shadow ray. The
// sample reaches each object's buffers by device address (buffer references); here they're one
// buffer of each kind, the object's starts in t_ObjDesc.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

RaytracingAccelerationStructure t_TopLevelAS : register(t0);
RWTexture2D<float4> u_Image : register(u0);

cbuffer CameraProperties : register(b0)
{
    float4x4 g_ViewInverse;
    float4x4 g_ProjInverse;
};

// Per object: its first vertex, first index, first material index and first material.
StructuredBuffer<uint4> t_ObjDesc : register(t1);
// float3 pos, float3 nrm per vertex.
StructuredBuffer<float> t_Vertices : register(t2);
// uint3 per triangle.
StructuredBuffer<uint> t_Indices : register(t3);
// A material index per triangle.
StructuredBuffer<int> t_MatIndices : register(t4);
// float3 diffuse, float3 specular, float shininess per material.
StructuredBuffer<float> t_Materials : register(t5);

struct HitPayload
{
    float3 radiance;
    float3 attenuation;
    int done;
    float3 rayOrigin;
    float3 rayDir;
};

struct ShadowPayload
{
    uint isShadowed;
};

struct WaveFrontMaterial
{
    float3 diffuse;
    float3 specular;
    float shininess;
};

[shader("raygeneration")]
void raygen()
{
    const uint2 launchID = DispatchRaysIndex().xy;
    const uint2 launchSize = DispatchRaysDimensions().xy;
    const float2 pixelCenter = float2(launchID) + float2(0.5, 0.5);
    const float2 inUV = pixelCenter / float2(launchSize);
    float2 d = inUV * 2.0 - 1.0;

    float4 origin = mul(float4(0, 0, 0, 1), g_ViewInverse);
    float4 target = mul(float4(d.x, d.y, 1, 1), g_ProjInverse);
    float4 direction = mul(float4(normalize(target.xyz), 0), g_ViewInverse);

    float tmin = 0.001;
    float tmax = 1e32;

    HitPayload prd;
    prd.rayOrigin = origin.xyz;
    prd.rayDir = direction.xyz;
    prd.radiance = float3(0.0, 0.0, 0.0);
    prd.attenuation = float3(1.0, 1.0, 1.0);
    prd.done = 0;

    float3 hitValue = float3(0, 0, 0);

    for (int depth = 0; depth < 64; depth++)
    {
        RayDesc ray;
        ray.Origin = prd.rayOrigin;
        ray.TMin = tmin;
        ray.Direction = prd.rayDir;
        ray.TMax = tmax;
        TraceRay(t_TopLevelAS, RAY_FLAG_FORCE_OPAQUE, 0xff, 0, 0, 0, ray, prd);
        hitValue += prd.radiance;
        if (prd.done == 1 || length(prd.attenuation) < 0.1)
            break;
    }

    u_Image[launchID] = float4(hitValue, 0.0);
}

[shader("miss")]
void miss(inout HitPayload prd)
{
    prd.radiance = float3(0.3, 0.3, 0.3) * prd.attenuation;
    prd.done = 1;
}

[shader("miss")]
void missShadow(inout ShadowPayload payload)
{
    payload.isShadowed = 0;
}

float3 computeSpecular(WaveFrontMaterial mat, float3 V, float3 L, float3 N)
{
    const float kPi = 3.14159265;
    const float kShininess = max(mat.shininess, 4.0);

    // Specular
    const float kEnergyConservation = (2.0 + kShininess) / (2.0 * kPi);
    V = normalize(-V);
    float3 R = reflect(-L, N);
    float specular = kEnergyConservation * pow(max(dot(V, R), 0.0), kShininess);

    return float3(mat.specular * specular);
}

float3 loadFloat3(StructuredBuffer<float> buffer, uint index)
{
    return float3(buffer[index], buffer[index + 1], buffer[index + 2]);
}

[shader("closesthit")]
void closesthit(inout HitPayload prd, in BuiltInTriangleIntersectionAttributes attribs)
{
    // When contructing the TLAS, we stored the model id in InstanceID(), so the instance can
    // quickly have access to the data

    // Object data
    const uint4 objResource = t_ObjDesc[InstanceID()];

    // Retrieve the material used on this triangle 'PrimitiveIndex'
    int mat_idx = t_MatIndices[objResource.z + PrimitiveIndex()];
    const uint m = (objResource.w + mat_idx) * 7;
    WaveFrontMaterial mat;        // Material for this triangle
    mat.diffuse = loadFloat3(t_Materials, m);
    mat.specular = loadFloat3(t_Materials, m + 3);
    mat.shininess = t_Materials[m + 6];

    // Indices of the triangle
    const uint i = objResource.y + PrimitiveIndex() * 3;
    const uint3 ind = uint3(t_Indices[i], t_Indices[i + 1], t_Indices[i + 2]) + objResource.x;

    // Vertex of the triangle
    const float3 pos0 = loadFloat3(t_Vertices, ind.x * 6);
    const float3 pos1 = loadFloat3(t_Vertices, ind.y * 6);
    const float3 pos2 = loadFloat3(t_Vertices, ind.z * 6);
    const float3 nrm0 = loadFloat3(t_Vertices, ind.x * 6 + 3);
    const float3 nrm1 = loadFloat3(t_Vertices, ind.y * 6 + 3);
    const float3 nrm2 = loadFloat3(t_Vertices, ind.z * 6 + 3);

    // Barycentric coordinates of the triangle
    const float3 barycentrics = float3(1.0f - attribs.barycentrics.x - attribs.barycentrics.y, attribs.barycentrics.x, attribs.barycentrics.y);

    // Computing the normal at hit position
    float3 N = nrm0 * barycentrics.x + nrm1 * barycentrics.y + nrm2 * barycentrics.z;
    N = normalize(mul(N, (float3x3)WorldToObject3x4()));        // Transforming the normal to world space

    // Computing the coordinates of the hit position
    float3 P = pos0 * barycentrics.x + pos1 * barycentrics.y + pos2 * barycentrics.z;
    P = mul(ObjectToWorld3x4(), float4(P, 1.0));        // Transforming the position to world space

    // Hardocded (to) light direction
    float3 L = normalize(float3(1, 1, 1));

    float NdotL = dot(N, L);

    // Fake Lambertian to avoid black
    float3 diffuse = mat.diffuse * max(NdotL, 0.3);
    float3 specular = float3(0, 0, 0);

    // Tracing shadow ray only if the light is visible from the surface
    if (NdotL > 0)
    {
        RayDesc ray;
        ray.Origin = P;
        ray.TMin = 0.001;
        ray.Direction = L;
        ray.TMax = 1e32;        // infinite
        ShadowPayload shadow;
        shadow.isShadowed = 1;
        TraceRay(t_TopLevelAS,
            RAY_FLAG_ACCEPT_FIRST_HIT_AND_END_SEARCH | RAY_FLAG_FORCE_OPAQUE | RAY_FLAG_SKIP_CLOSEST_HIT_SHADER,
            0xFF,        // cullMask
            0,           // sbtRecordOffset
            0,           // sbtRecordStride
            1,           // missIndex
            ray, shadow);

        if (shadow.isShadowed != 0)
            diffuse *= 0.3;
        else
            // Add specular only if not in shadow
            specular = computeSpecular(mat, WorldRayDirection(), L, N);
    }

    prd.radiance = (diffuse + specular) * (1 - mat.shininess) * prd.attenuation;

    // Reflect
    float3 rayDir = reflect(WorldRayDirection(), N);
    prd.attenuation *= float3(mat.shininess, mat.shininess, mat.shininess);
    prd.rayOrigin = P;
    prd.rayDir = rayDir;
}

/* Copyright (c) 2025-2026, Holochip Inc.
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

// Port of Vulkan-Samples' ray_tracing_invocation_reorder shaders (Slang: raygen.rgen, miss.rmiss,
// closesthit_normal/refraction/flame.rchit) to Donut's bindings, in one library, with the bindings
// of ray_tracing_extended's port (the scene is the same). The sample's specialization constants
// (render mode and ray count) come in the constant buffer, its array of 26 textures is a bindless
// one.
//
// SER=1: the primary ray is traced into a hit object, the threads reordered by it, then its hit or
// miss shader invoked (Shader Execution Reordering). D3D12: shader model 6.9's dx::HitObject and
// dx::MaybeReorderThread. Vulkan: SPV_NV_shader_invocation_reorder's instructions, which DXC's
// SPIR-V backend doesn't implement for dx::HitObject, as inline SPIR-V (the sample's Slang output
// uses the same ones). SER=0: plain TraceRay, for devices without hit objects.

#include <donut/shaders/binding_helpers.hlsli>

// Donut's matrices are row-major, for mul(vector, matrix).
#pragma pack_matrix(row_major)

#ifndef SER
#define SER 0
#endif

#define RENDER_DEFAULT 0
#define RENDER_BARYCENTRIC 1
#define RENDER_INSTANCE_ID 2
#define RENDER_DISTANCE 3
#define RENDER_GLOBAL_XYZ 4
#define RENDER_SHADOW_MAP 5
#define RENDER_AO 6

struct CameraProperties
{
    float4x4 viewInverse;
    float4x4 projInverse;
    // The sample's specialization constants.
    uint renderMode;
    uint maxRays;
    int enableSER;
    int useCoherenceHint;
};

ConstantBuffer<CameraProperties> cam : register(b0);

RaytracingAccelerationStructure topLevelAS : register(t0);
// The back buffer's format without sRGB (BGRA with Vulkan), so no format here: written as the sample's
// storage image.
VK_IMAGE_FORMAT_UNKNOWN RWTexture2D<float4> image : register(u0);

StructuredBuffer<float4> vertex_buffer : register(t1);
StructuredBuffer<uint> index_buffer : register(t2);
StructuredBuffer<uint> data_map : register(t3);
StructuredBuffer<float4> dynamic_vertex_buffer : register(t4);
StructuredBuffer<uint> dynamic_index_buffer : register(t5);
SamplerState texture_sampler : register(s0);
VK_BINDING(0, 1) Texture2D textures[] : register(t0, space1);

// Shader model 6.7 on wants the payload's access qualifiers (the SER library is 6.9); every
// field's access everywhere, as the sample's payload (DXC warns that the caller doesn't read every
// field after every trace: -Wno-payload-access-perf in the .cfg).
#if SER
#define PAYLOAD_TYPE struct [raypayload] Payload
#define PAYLOAD_FIELD(type, name) type name : read(caller, closesthit, miss) : write(caller, closesthit, miss)
#else
#define PAYLOAD_TYPE struct Payload
#define PAYLOAD_FIELD(type, name) type name
#endif

PAYLOAD_TYPE
{
    PAYLOAD_FIELD(float4, color);
    PAYLOAD_FIELD(float4, intersection); // {x, y, z, intersectionType}
    PAYLOAD_FIELD(float4, normal);       // {nx, ny, nz, distance}
};

struct Attributes
{
    float2 bary;
};

// --- Hit objects on Vulkan: SPV_NV_shader_invocation_reorder as inline SPIR-V --------------------

#if SER && defined(SPIRV)
using HitObjectNV = vk::SpirvOpaqueType</* OpTypeHitObjectNV */ 5281>;

#define SPV_STORAGE_CLASS_RAY_PAYLOAD 5338

[[vk::ext_extension("SPV_NV_shader_invocation_reorder")]]
[[vk::ext_capability(/* ShaderInvocationReorderNV */ 5383)]]
[[vk::ext_instruction(/* OpHitObjectTraceRayNV */ 5260)]]
void HitObjectTraceRayNV([[vk::ext_reference]] HitObjectNV hitObject, RaytracingAccelerationStructure as, uint rayFlags,
    uint cullMask, uint sbtRecordOffset, uint sbtRecordStride, uint missIndex, float3 origin, float tmin, float3 direction,
    float tmax, [[vk::ext_reference]] [[vk::ext_storage_class(SPV_STORAGE_CLASS_RAY_PAYLOAD)]] Payload payload);

[[vk::ext_instruction(/* OpReorderThreadWithHitObjectNV */ 5279)]]
void ReorderThreadWithHitObjectNV([[vk::ext_reference]] HitObjectNV hitObject);

[[vk::ext_instruction(/* OpReorderThreadWithHitObjectNV */ 5279)]]
void ReorderThreadWithHitObjectNV([[vk::ext_reference]] HitObjectNV hitObject, uint hint, uint bits);

[[vk::ext_instruction(/* OpHitObjectExecuteShaderNV */ 5264)]]
void HitObjectExecuteShaderNV([[vk::ext_reference]] HitObjectNV hitObject,
    [[vk::ext_reference]] [[vk::ext_storage_class(SPV_STORAGE_CLASS_RAY_PAYLOAD)]] Payload payload);

[[vk::ext_instruction(/* OpHitObjectIsHitNV */ 5277)]]
bool HitObjectIsHitNV([[vk::ext_reference]] HitObjectNV hitObject);

[[vk::ext_instruction(/* OpHitObjectGetInstanceIdNV */ 5270)]]
uint HitObjectGetInstanceIdNV([[vk::ext_reference]] HitObjectNV hitObject);

// The hit object instructions take the payload variable itself (Ray Payload storage class).
[[vk::ext_storage_class(SPV_STORAGE_CLASS_RAY_PAYLOAD)]] static Payload g_HitObjectPayload;
#endif

// The primary ray, as the sample traces it with SER: into a hit object, the threads reordered by
// it (hinted by the instance hit, with coherence hints), then its shaders invoked.
void TraceReordered(RayDesc ray, inout Payload payload)
{
#if SER && defined(SPIRV)
    g_HitObjectPayload = payload;
    HitObjectNV hitObj;
    HitObjectTraceRayNV(hitObj, topLevelAS, RAY_FLAG_NONE, 0xff, 0, 0, 0, ray.Origin, ray.TMin, ray.Direction, ray.TMax,
        g_HitObjectPayload);
    if (cam.useCoherenceHint != 0)
    {
        uint hint = 0;
        if (HitObjectIsHitNV(hitObj))
        {
            hint = HitObjectGetInstanceIdNV(hitObj);
        }
        ReorderThreadWithHitObjectNV(hitObj, hint, 8);
    }
    else
    {
        ReorderThreadWithHitObjectNV(hitObj);
    }
    HitObjectExecuteShaderNV(hitObj, g_HitObjectPayload);
    payload = g_HitObjectPayload;
#elif SER
    dx::HitObject hitObj = dx::HitObject::TraceRay(topLevelAS, RAY_FLAG_NONE, 0xff, 0, 0, 0, ray, payload);
    if (cam.useCoherenceHint != 0)
    {
        uint hint = 0;
        if (hitObj.IsHit())
        {
            hint = hitObj.GetInstanceIndex();
        }
        dx::MaybeReorderThread(hitObj, hint, 8);
    }
    else
    {
        dx::MaybeReorderThread(hitObj);
    }
    dx::HitObject::Invoke(hitObj, payload);
#else
    TraceRay(topLevelAS, RAY_FLAG_NONE, 0xff, 0, 0, 0, ray, payload);
#endif
}

// --- Ray generation ---------------------------------------------------------------------------

[shader("raygeneration")]
void raygen()
{
    uint3 launchID = DispatchRaysIndex();
    uint3 launchSize = DispatchRaysDimensions();

    float2 pixelCenter = float2(launchID.xy) + float2(0.5, 0.5);
    float2 inUV = pixelCenter / float2(launchSize.xy);
    float2 d = inUV * 2.0 - 1.0;

    float4 origin = mul(float4(0, 0, 0, 1), cam.viewInverse);
    float4 target = mul(float4(d.x, d.y, 1, 1), cam.projInverse);
    float4 direction = mul(float4(normalize(target.xyz), 0), cam.viewInverse);

    float tmin = 0.001;
    float tmax = 10000.0;

    uint max_rays = cam.maxRays;
    if (cam.renderMode != RENDER_DEFAULT)
    {
        max_rays = 1;
    }

    uint object_type = 100;
    float4 color = float4(0, 0, 0, 0);
    uint current_mode = 0;
    float expectedDistance = -1;

    Payload payload;
    payload.color = float4(0, 0, 0, 0);
    payload.intersection = float4(0, 0, 0, 0);
    payload.normal = float4(0, 0, 0, 0);

    // Loop to trace through multiple objects (flame particles, refractive surfaces)
    // Similar to ray_tracing_extended - continues until alpha is saturated or max rays reached
    for (uint rayIndex = 0; rayIndex < max_rays && current_mode < 100 && color.a < 0.95; ++rayIndex)
    {
        RayDesc ray;
        ray.Origin = origin.xyz;
        ray.Direction = direction.xyz;
        ray.TMin = tmin;
        ray.TMax = tmax;

        // Primary ray - when SER is enabled, reorder with hit objects for the first trace
        if (cam.enableSER != 0 && rayIndex == 0)
        {
            TraceReordered(ray, payload);
        }
        else
        {
            TraceRay(topLevelAS, RAY_FLAG_NONE, 0xff, 0, 0, 0, ray, payload);
        }
        object_type = uint(payload.intersection.w);

        // Secondary rays (shadow and AO)
        float3 object_intersection_pt = payload.intersection.xyz;
        float3 object_normal = payload.normal.xyz;

        if (cam.renderMode != RENDER_DEFAULT)
        {
            color = payload.color;
            break;
        }
        else if (object_type == 0)
        {
            float4 newColor = payload.color;
            // shadow
            {
                const float shadow_mult = 2;
                const float shadow_scale = 0.25;
                float3 lightPt = float3(0, -20, 0);
                float3 currentDirection = lightPt - payload.intersection.xyz;
                float expectedDistance = sqrt(dot(currentDirection, currentDirection));
                currentDirection = normalize(currentDirection);

                RayDesc shadowRay;
                shadowRay.Origin = object_intersection_pt;
                shadowRay.Direction = currentDirection;
                shadowRay.TMin = tmin;
                shadowRay.TMax = tmax;

                TraceRay(topLevelAS, RAY_FLAG_NONE, 0xff, 0, 0, 0, shadowRay, payload);

                float actDistance = payload.normal.w;
                float scale = actDistance < expectedDistance ? shadow_scale : 1.0;
                scale = min(scale * shadow_mult, 1.0);
                newColor.xyz *= scale;
                current_mode = 101;
                if (cam.renderMode == RENDER_SHADOW_MAP)
                {
                    image[launchID.xy] = float4(scale, scale, scale, 1);
                    return;
                }
            }
            // ambient occlusion - standard TraceRay (SER overhead in loops is too high)
            {
                const float ao_mult = 1;
                uint max_ao_each = 2;  // 2x2=4 AO rays
                const float max_dist = 2;
                float accumulated_ao = 0.0;
                float3 u = abs(dot(object_normal, float3(0, 0, 1))) > 0.9 ? cross(object_normal, float3(1, 0, 0)) : cross(object_normal, float3(0, 0, 1));
                float3 v = cross(object_normal, u);
                float accumulated_factor = 0;
                for (uint j = 0; j < max_ao_each; ++j)
                {
                    float phi = 0.5 * (-3.14159 + 2 * 3.14159 * (float(j + 1) / float(max_ao_each + 2)));
                    for (uint k = 0; k < max_ao_each; ++k)
                    {
                        float theta = 0.5 * (-3.14159 + 2 * 3.14159 * (float(k + 1) / float(max_ao_each + 2)));
                        float x = cos(phi) * sin(theta);
                        float y = sin(phi) * sin(theta);
                        float z = cos(theta);
                        float3 dir2 = x * u + y * v + z * object_normal;

                        RayDesc aoRay;
                        aoRay.Origin = object_intersection_pt;
                        aoRay.Direction = dir2;
                        aoRay.TMin = tmin;
                        aoRay.TMax = tmax;

                        // AO rays use standard TraceRay - SER overhead in loops is too high
                        TraceRay(topLevelAS, RAY_FLAG_NONE, 0xff, 0, 0, 0, aoRay, payload);

                        float ao = min(payload.normal.w, max_dist);
                        float factor = 0.2 + 0.8 * z * z;
                        accumulated_factor += factor;
                        accumulated_ao += ao * factor;
                    }
                }
                accumulated_ao /= (max_dist * accumulated_factor);
                accumulated_ao *= accumulated_ao;
                accumulated_ao = max(min((accumulated_ao) * ao_mult, 1), 0);
                if (cam.renderMode == RENDER_AO)
                {
                    image[launchID.xy] = float4(accumulated_ao, accumulated_ao, accumulated_ao, 1);
                    return;
                }

                newColor.xyz *= accumulated_ao;
                const float r = max(0, 1 - color.a);
                color += r * float4(newColor.rgb, 1);
            }
        }
        else if (object_type == 1)
        {
            // Refractive / reflective path - continue ray through the surface
            origin = float4(payload.intersection.xyz, 0);
            float IOR = payload.color.x;
            float max_IOR = 1.01;
            float eta = 1 / IOR;
            float c = abs(dot(object_normal, direction.xyz));
            float t = (IOR - 1) / (max_IOR - 1);
            direction = float4(normalize((1 - t) * direction.xyz + t * (eta * direction.xyz + (eta * c - sqrt(1 - eta * eta * (1 - c * c))) * object_normal)), 0);
        }
        else if (object_type == 2)
        {
            // Flame particle with alpha blending - continue ray through particle
            float4 newColor = payload.color;
            float r = 1 - color.a;
            color.rgb += r * newColor.rgb * newColor.a;
            color.a += 0.1 * r * newColor.a;
            origin = float4(payload.intersection.xyz, 0);
        }
        else
        {
            // Unknown object type or miss - stop tracing
            break;
        }
    }

    image[launchID.xy] = color;
}

// --- Miss -------------------------------------------------------------------------------------

// The sample's miss shader takes a payload of one float3 (its own struct): it writes the first
// three floats of the caller's payload, the color's rgb, and leaves the rest as they were.
[shader("miss")]
void miss(inout Payload payload)
{
    // Simple gradient background
    float3 rayDir = WorldRayDirection();
    float3 skyColor = lerp(float3(0.3, 0.5, 0.8), float3(0.1, 0.2, 0.4), rayDir.y * 0.5 + 0.5);
    payload.color.rgb = skyColor;
}

// --- Closest hits: one hit group per object type -----------------------------------------------

float3 heatmap(float value, float minValue, float maxValue)
{
    float scaled = (min(max(value, minValue), maxValue) - minValue) / (maxValue - minValue);
    float r = scaled * (3.14159265359 / 2.0);
    return float3(sin(r), sin(2.0 * r), cos(r));
}

struct Vertex
{
    float3 pt;
    float3 normal;
    float2 coordinate;
};

Vertex getVertex(uint vertexOffset, uint index, bool isStatic)
{
    uint base_index = 2 * (vertexOffset + index);
    float4 A = isStatic ? vertex_buffer[base_index] : dynamic_vertex_buffer[base_index];
    float4 B = isStatic ? vertex_buffer[base_index + 1] : dynamic_vertex_buffer[base_index + 1];

    Vertex v;
    v.pt = A.xyz;
    v.normal = float3(A.w, B.x, B.y);
    v.coordinate = float2(B.z, B.w);
    return v;
}

uint3 getIndices(uint triangle_offset, uint primitive_id, bool isStatic)
{
    uint base_index = 3 * (triangle_offset + primitive_id);
    uint index0 = isStatic ? index_buffer[base_index] : dynamic_index_buffer[base_index];
    uint index1 = isStatic ? index_buffer[base_index + 1] : dynamic_index_buffer[base_index + 1];
    uint index2 = isStatic ? index_buffer[base_index + 2] : dynamic_index_buffer[base_index + 2];
    return uint3(index0, index1, index2);
}

// The three closest hit shaders' shared part: the debug render modes (true if one wrote the
// color), the hit's point, normal and texture coordinates, and the payload's intersection and
// normal (with objectType).
bool hitCommon(inout Payload hitValue, Attributes attribs, uint objectType, bool isStatic, out float3 worldPt,
    out float3 worldNormal, out float2 texcoord, out uint imageOffset)
{
    const float3 barycentricCoords = float3(1.0f - attribs.bary.x - attribs.bary.y, attribs.bary.x, attribs.bary.y);
    worldPt = 0;
    worldNormal = 0;
    texcoord = 0;
    imageOffset = 0;

    if (cam.renderMode == RENDER_BARYCENTRIC)
    {
        hitValue.color = float4(barycentricCoords, 1);
        return true;
    }
    else if (cam.renderMode == RENDER_INSTANCE_ID)
    {
        hitValue.color = float4(heatmap(InstanceID(), 0, 25), 1);
        return true;
    }
    else if (cam.renderMode == RENDER_DISTANCE)
    {
        hitValue.color = float4(heatmap(log(1 + RayTCurrent()), 0, log(1 + 25)), 1);
        return true;
    }

    uint index = InstanceID();

    uint vertexOffset = data_map[4 * index];
    uint triangleOffset = data_map[4 * index + 1];
    imageOffset = data_map[4 * index + 2];

    uint3 indices = getIndices(triangleOffset, PrimitiveIndex(), isStatic);
    Vertex A = getVertex(vertexOffset, indices.x, isStatic);
    Vertex B = getVertex(vertexOffset, indices.y, isStatic);
    Vertex C = getVertex(vertexOffset, indices.z, isStatic);

    // interpolate and obtain world point
    float alpha = barycentricCoords.x, beta = barycentricCoords.y, gamma = barycentricCoords.z;
    worldPt = WorldRayOrigin() + RayTCurrent() * WorldRayDirection();
    worldNormal = normalize(cross(B.pt - A.pt, C.pt - A.pt));

    texcoord = alpha * A.coordinate + beta * B.coordinate + gamma * C.coordinate;

    hitValue.intersection = float4(worldPt.xyz, objectType);
    hitValue.normal = float4(worldNormal.xyz, RayTCurrent());

    if (cam.renderMode == RENDER_GLOBAL_XYZ)
    {
        hitValue.color = float4(heatmap(worldPt.x, -10, 10), 1);
        return true;
    }
    return false;
}

// closesthit_normal.rchit: diffuse texture lookup with simple lighting for divergence
[shader("closesthit")]
void closesthit_normal(inout Payload hitValue, in Attributes attribs)
{
    float3 worldPt, worldNormal;
    float2 texcoord;
    uint imageOffset;
    if (hitCommon(hitValue, attribs, 0 /* OBJECT_NORMAL */, true, worldPt, worldNormal, texcoord, imageOffset))
    {
        return;
    }

    if (imageOffset < 26)
    {
        float4 tex_value = textures[NonUniformResourceIndex(imageOffset)].SampleLevel(texture_sampler, texcoord, 0);
        float diffuse = max(dot(worldNormal, normalize(float3(0, -1, 0))), 0.0);
        float ambient = 0.3;
        hitValue.color = tex_value * (ambient + 0.7 * diffuse);
    }
}

// closesthit_refraction.rchit: glass, its index of refraction and Fresnel term in the color
[shader("closesthit")]
void closesthit_refraction(inout Payload hitValue, in Attributes attribs)
{
    float3 worldPt, worldNormal;
    float2 texcoord;
    uint imageOffset;
    if (hitCommon(hitValue, attribs, 1 /* OBJECT_REFRACTION */, false, worldPt, worldNormal, texcoord, imageOffset))
    {
        return;
    }

    const float base_IOR = 1.01;
    const float x = texcoord.x, y = texcoord.y;
    const float t = min(min(min(min(x, 1 - x), y), 1 - y), 0.5) / 0.5;
    const float IOR = t * base_IOR + (1 - t) * 1;
    float cosTheta = abs(dot(worldNormal, normalize(WorldRayDirection())));
    float fresnel = pow(1.0 - cosTheta, 5.0);

    hitValue.color = float4(IOR, fresnel, 0, 0);
}

// closesthit_flame.rchit: texture lookup with emission boost
[shader("closesthit")]
void closesthit_flame(inout Payload hitValue, in Attributes attribs)
{
    float3 worldPt, worldNormal;
    float2 texcoord;
    uint imageOffset;
    if (hitCommon(hitValue, attribs, 2 /* OBJECT_FLAME */, true, worldPt, worldNormal, texcoord, imageOffset))
    {
        return;
    }

    if (imageOffset < 26)
    {
        float4 tex_value = textures[NonUniformResourceIndex(imageOffset)].SampleLevel(texture_sampler, texcoord, 0);
        float flicker = 0.8 + 0.2 * sin(worldPt.x * 10.0 + worldPt.y * 15.0);
        float emission = 2.0 * flicker;
        hitValue.color = float4(tex_value.rgb * emission, tex_value.a);
    }
}

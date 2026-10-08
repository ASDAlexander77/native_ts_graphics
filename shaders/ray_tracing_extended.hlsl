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

// Port of Vulkan-Samples' ray_tracing_extended shaders (raygen.rgen, miss.rmiss, closesthit.rchit)
// to Donut's bindings, in one library. The sample's specialization constants (render mode and ray
// count) come in the constant buffer, and its array of 26 textures is a bindless one, indexed by
// the textures' descriptor indices. Everything is in the sample's world space (-y up), which the
// TypeScript side's matrices take the rays to.

#include <donut/shaders/binding_helpers.hlsli>

// Donut's matrices are row-major, for mul(vector, matrix).
#pragma pack_matrix(row_major)

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
};

ConstantBuffer<CameraProperties> cam : register(b0);

RaytracingAccelerationStructure rs : register(t0);
// The back buffer's format without sRGB (BGRA with Vulkan), so no format here: written as the sample's
// B8G8R8A8_UNORM storage image.
VK_IMAGE_FORMAT_UNKNOWN RWTexture2D<float4> image : register(u0);

StructuredBuffer<float4> vertex_buffer : register(t1);
StructuredBuffer<uint> index_buffer : register(t2);
StructuredBuffer<uint> data_map : register(t3);
StructuredBuffer<float4> dynamic_vertex_buffer : register(t4);
StructuredBuffer<uint> dynamic_index_buffer : register(t5);
SamplerState texture_sampler : register(s0);
VK_BINDING(0, 1) Texture2D textures[] : register(t0, space1);

struct Payload
{
    float4 color;
    float4 intersection; // {x, y, z, intersectionType}
    float4 normal; // {nx, ny, nz, distance}
};

struct Attributes
{
    float2 bary;
};

// --- Ray generation ---------------------------------------------------------------------------

[shader("raygeneration")]
void raygen()
{
    uint3 LaunchID = DispatchRaysIndex();
    uint3 LaunchSize = DispatchRaysDimensions();

    const float2 pixelCenter = float2(LaunchID.xy) + float2(0.5, 0.5);
    const float2 inUV = pixelCenter/float2(LaunchSize.xy);
    float2 d = inUV * 2.0 - 1.0;

    float4 origin = mul(float4(0,0,0,1), cam.viewInverse);
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
    // 0 = normal, 1 = shadow, 2 = AO
    uint current_mode = 0;
    float expectedDistance = -1;

    RayDesc rayDesc;
    rayDesc.TMin = tmin;
    rayDesc.TMax = tmax;

    // The sample leaves it uninitialized (a miss only writes the w components).
    Payload hitValue = (Payload)0;

    for (uint i = 0; i < max_rays && current_mode < 100 && color.a < 0.95 && (color.r < 0.99 || color.b < 0.99 || color.g < 0.99); ++i)
    {
        rayDesc.Origin = origin.xyz;
        rayDesc.Direction = direction.xyz;
        TraceRay(rs, RAY_FLAG_FORCE_OPAQUE, 0xff, 0, 0, 0, rayDesc, hitValue);
        object_type = uint(hitValue.intersection.w);
        const float3 object_intersection_pt = hitValue.intersection.xyz;
        const float3 object_normal = hitValue.normal.xyz;
        // As in the sample, this comes first: RENDER_SHADOW_MAP and RENDER_AO show the hit's color too.
        if (cam.renderMode != RENDER_DEFAULT)
        {
            color = hitValue.color;
            break;
        }
        if (object_type == 0)
        {
            float4 newColor = hitValue.color;

            //shadow
            {
                const float shadow_mult = 2;
                const float shadow_scale = 0.25;
                float3 lightPt = float3(0, -20, 0);
                float3 currentDirection = lightPt - hitValue.intersection.xyz;
                expectedDistance = sqrt(dot(currentDirection, currentDirection));
                currentDirection = normalize(currentDirection);
                rayDesc.Origin = object_intersection_pt;
                rayDesc.Direction = currentDirection;
                TraceRay(rs, RAY_FLAG_FORCE_OPAQUE, 0xff, 0, 0, 0, rayDesc, hitValue);
                float actDistance = hitValue.normal.w;
                float scale = actDistance < expectedDistance ? shadow_scale : 1;
                scale = min(scale * shadow_mult, 1);
                newColor.xyz *= scale;
                current_mode = 101;
                if (cam.renderMode == RENDER_SHADOW_MAP)
                {
                    color = float4(scale, scale, scale, 1);
                    break;
                }
            }

            // ambient occlusion
            {
                const float ao_mult = 1;
                uint max_ao_each = 2;
                const float max_dist = 2;
                float accumulated_ao = 0.f;
                float3 u = abs(dot(object_normal, float3(0, 0, 1))) > 0.9 ? cross(object_normal, float3(1, 0, 0)) : cross(object_normal, float3(0, 0, 1));
                float3 v = cross(object_normal, u);
                float accumulated_factor = 0;
                for (uint j = 0; j < max_ao_each; ++j)
                {
                    float phi = 0.5*(-3.14159 + 2 * 3.14159 * (float(j + 1) / float(max_ao_each + 2)));
                    for (uint k = 0; k < max_ao_each; ++k){
                        float theta =  0.5*(-3.14159 + 2 * 3.14159 * (float(k + 1) / float(max_ao_each + 2)));
                        float x = cos(phi) * sin(theta);
                        float y = sin(phi) * sin(theta);
                        float z = cos(theta);
                        float3 aoDirection = x * u + y * v + z * object_normal;
                        rayDesc.Origin = object_intersection_pt;
                        rayDesc.Direction = aoDirection;
                        TraceRay(rs, RAY_FLAG_FORCE_OPAQUE, 0xff, 0, 0, 0, rayDesc, hitValue);
                        float ao = min(hitValue.normal.w, max_dist);
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
                    color = float4(accumulated_ao, accumulated_ao, accumulated_ao, 1);
                    break;
                }

                newColor.xyz *= accumulated_ao;

                const float r = max(0, 1 - color.a);
                color += r * float4(newColor.rgb, 1);
            }

        } else if (object_type == 1)
        {
            origin = float4(hitValue.intersection.xyz, 0);
            const float IOR = hitValue.color.x;
            const float max_IOR = 1.01;
            float eta = 1 / IOR;
            float c = abs(dot(object_normal, direction.xyz));
            float t = (IOR - 1) / (max_IOR - 1);
            direction = normalize((1 - t) * direction + t * (eta * direction + (eta * c - (1 - eta*eta*(1 - c*c)))));
        } else if (object_type == 2)
        {
            float4 newColor = hitValue.color;
            float r = 1 - color.a;
            color.rgb += r * newColor.rgb * newColor.a;
            color.a += 0.1 * r * newColor.a;
            origin = float4(hitValue.intersection.xyz, 0);
        }
    }

    image[int2(LaunchID.xy)] = color;
}

// --- Miss -------------------------------------------------------------------------------------

[shader("miss")]
void miss(inout Payload hitValue)
{
    hitValue.intersection.w = 100;
    hitValue.normal.w = 10000;
}

// --- Closest hit ------------------------------------------------------------------------------

float3 heatmap(float value, float minValue, float maxValue)
{
    float scaled = (min(max(value, minValue), maxValue) - minValue) / (maxValue - minValue);
    float r = scaled * (3.14159265359 / 2.);
    return float3(sin(r), sin(2 * r), cos(r));
}

struct Vertex
{
    float3 pt;
    float3 normal;
    float2 coordinate;
};

Vertex getVertex(uint vertexOffset, uint index, bool is_static)
{
    uint base_index = 2 * (vertexOffset + index);
    float4 A = is_static ? vertex_buffer[base_index] : dynamic_vertex_buffer[base_index];
    float4 B = is_static ? vertex_buffer[base_index + 1] : dynamic_vertex_buffer[base_index + 1];

    Vertex v;
    v.pt = A.xyz;
    v.normal = float3(A.w, B.x, B.y);
    v.coordinate = float2(B.z, B.w);
    return v;
}

uint3 getIndices(uint triangle_offset, uint primitive_id, bool is_static)
{
    uint base_index = 3 * (triangle_offset + primitive_id);
    uint index0 = is_static ? index_buffer[base_index] : dynamic_index_buffer[base_index];
    uint index1 = is_static ? index_buffer[base_index + 1] : dynamic_index_buffer[base_index + 1];
    uint index2 = is_static ? index_buffer[base_index + 2] : dynamic_index_buffer[base_index + 2];

    return uint3(index0, index1, index2);
}

void handleDraw(inout Payload hitValue, float2 attribs)
{
    uint index = InstanceID();

    uint vertexOffset = data_map[4 * index];
    uint triangleOffset = data_map[4*index + 1];
    uint imageOffset = data_map[4 * index + 2];
    uint objectType = data_map[4 * index + 3];
    bool is_static = objectType != 1;

    uint3 indices = getIndices(triangleOffset, PrimitiveIndex(), is_static);
    Vertex A = getVertex(vertexOffset, indices.x, is_static), B = getVertex(vertexOffset, indices.y, is_static), C = getVertex(vertexOffset, indices.z, is_static);

    // interpolate and obtain world point
    const float3 barycentricCoords = float3(1.0f - attribs.x - attribs.y, attribs.x, attribs.y);
    float alpha = barycentricCoords.x, beta = barycentricCoords.y, gamma = barycentricCoords.z;
    float3 worldPt = WorldRayOrigin() + RayTCurrent() * WorldRayDirection();
    float3 normal = normalize(alpha * A.normal + beta * B.normal + gamma * C.normal);
    float3 worldNormal = normalize(cross(B.pt - A.pt, C.pt - A.pt));

    float2 texcoord = alpha * A.coordinate + beta * B.coordinate + gamma * C.coordinate;

    hitValue.intersection = float4(worldPt.xyz, objectType);
    hitValue.normal = float4(worldNormal.xyz, RayTCurrent());
    if (cam.renderMode == RENDER_GLOBAL_XYZ) { // global xyz
        hitValue.color = float4(heatmap(worldPt.x, -10, 10), 1);
        return;
    }
    if ((objectType == 0 || objectType == 2)){
        // obtain texture coordinate
        // NB: texture() is valid here as well as mipmaps are not used in this demo.
        float4 tex_value = textures[NonUniformResourceIndex(imageOffset)].SampleLevel(texture_sampler, texcoord, 0);
        hitValue.color = tex_value;
    } else {
        // the refraction itself is colorless, so
        // encode the index of refraction in the color
        const float base_IOR = 1.01;
        const float x = texcoord.x, y = texcoord.y;
        const float t = min(min(min(min(x, 1-x), y), 1-y), 0.5) / 0.5;
        const float IOR = t * base_IOR + (1 - t) * 1;
        hitValue.color = float4(IOR, 0, 0, 0);
        hitValue.normal = float4(normal.x, normal.y, normal.z, RayTCurrent());
    }
}

[shader("closesthit")]
void closesthit(inout Payload hitValue, in Attributes Attribs)
{
    const float3 barycentricCoords = float3(1.0f - Attribs.bary.x - Attribs.bary.y, Attribs.bary.x, Attribs.bary.y);
    if (cam.renderMode == RENDER_BARYCENTRIC ){
        hitValue.color = float4(barycentricCoords, 1);
    } else if (cam.renderMode == RENDER_INSTANCE_ID){
        hitValue.color = float4(heatmap(InstanceID(), 0, 25), 1);
    } else if (cam.renderMode == RENDER_DISTANCE){
        hitValue.color = float4(heatmap(log(1 + RayTCurrent()), 0, log(1 + 25)), 1);
    } else {
        handleDraw(hitValue, Attribs.bary);
    }
}

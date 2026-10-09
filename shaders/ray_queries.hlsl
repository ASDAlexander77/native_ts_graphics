/* Copyright (c) 2021-2024 Holochip Corporation
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

// Port of Vulkan-Samples' ray_queries shaders (ray_shadow.vert, ray_shadow.frag) to Donut's
// bindings: the scene rasterized, each pixel shaded by inline ray queries against its TLAS, nine
// for ambient occlusion and one towards the light for the shadow. The TypeScript side gives the
// sample's projection without its Vulkan y flip, Donut's clip space being y-up.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

cbuffer c_Global : register(b0)
{
    float4x4 g_View;
    float4x4 g_Proj;
    float3 g_CameraPosition;
    float3 g_LightPosition;
};

RaytracingAccelerationStructure t_TopLevelAS : register(t0);

struct VSInput
{
    float3 position : POSITION;
    float3 normal : NORMAL;
};

struct VSOutput
{
    float4 position : SV_Position;
    float4 pos : TEXCOORD0;
    float3 normal : TEXCOORD1;
    // scene with respect to BVH coordinates
    float4 scenePos : TEXCOORD2;
};

// ray_shadow.vert
VSOutput ray_shadow_vs(VSInput input)
{
    VSOutput output;
    // We want to be able to perform ray tracing, so don't apply any matrix to scene_pos
    output.scenePos = float4(input.position, 1);
    output.pos = mul(float4(input.position, 1), g_View);
    output.normal = input.normal;
    output.position = mul(mul(float4(input.position, 1.0), g_View), g_Proj);
    return output;
}

// Calculate ambient occlusion
float calculate_ambient_occlusion(float3 object_point, float3 object_normal)
{
    const float ao_mult = 1;
    const uint max_ao_each = 3;
    const float max_dist = 2;
    const float tmin = 0.01, tmax = max_dist;
    float accumulated_ao = 0.f;
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
            float3 direction = x * u + y * v + z * object_normal;

            RayDesc ray;
            ray.Origin = object_point;
            ray.TMin = tmin;
            ray.Direction = direction;
            ray.TMax = tmax;
            RayQuery<RAY_FLAG_ACCEPT_FIRST_HIT_AND_END_SEARCH> query;
            query.TraceRayInline(t_TopLevelAS, RAY_FLAG_NONE, 0xFF, ray);
            query.Proceed();
            float dist = max_dist;
            if (query.CommittedStatus() != COMMITTED_NOTHING)
            {
                dist = query.CommittedRayT();
            }
            float ao = min(dist, max_dist);
            float factor = 0.2 + 0.8 * z * z;
            accumulated_factor += factor;
            accumulated_ao += ao * factor;
        }
    }
    accumulated_ao /= (max_dist * accumulated_factor);
    accumulated_ao *= accumulated_ao;
    accumulated_ao = max(min((accumulated_ao) * ao_mult, 1), 0);
    return accumulated_ao;
}

// Apply ray tracing to determine whether the point intersects light
bool intersects_light(float3 light_origin, float3 pos)
{
    const float tmin = 0.01, tmax = 1000;
    const float3 direction = light_origin - pos;

    // For performance, accept the first hit, since we only need to know whether an intersection
    // exists, and not necessarily any particular intersection: one Proceed() call is enough.
    RayDesc ray;
    ray.Origin = pos;
    ray.TMin = tmin;
    ray.Direction = direction;
    ray.TMax = 1.0;
    RayQuery<RAY_FLAG_ACCEPT_FIRST_HIT_AND_END_SEARCH> query;
    query.TraceRayInline(t_TopLevelAS, RAY_FLAG_NONE, 0xFF, ray);
    query.Proceed();
    return query.CommittedStatus() != COMMITTED_NOTHING;
}

// ray_shadow.frag
float4 ray_shadow_ps(VSOutput input) : SV_Target
{
    // this is where we apply the shadow
    const float ao = calculate_ambient_occlusion(input.scenePos.xyz, input.normal);
    const float4 lighting = intersects_light(g_LightPosition, input.scenePos.xyz) ? float4(0.2, 0.2, 0.2, 1) : float4(1, 1, 1, 1);
    return lighting * float4(ao * float3(1, 1, 1), 1);
}

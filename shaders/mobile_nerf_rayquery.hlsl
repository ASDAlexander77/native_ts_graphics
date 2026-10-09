/* Copyright (c) 2024, Qualcomm Innovation Center, Inc. All rights reserved.
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

// Port of Vulkan-Samples' mobile_nerf_rayquery shaders (quad.vert, rayquery_morpheus_combo.frag,
// after Google's MobileNeRF) to Donut's bindings: a triangle over the screen, each pixel's ray
// traced inline (opaque, the sample's USE_OPAQUE path) through the NeRFs' meshes, the hit's
// feature textures run through its model's MLP. The sample's arrays of buffers (one per model) are
// one buffer here, each model's start in g_ModelOffsets; its texture arrays are kept.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

#define NUM_MODELS 4

#define WEIGHTS_0_COUNT (176)
#define WEIGHTS_1_COUNT (256)
// The third layer's size is changed from 48 to 64 to make sure a 16 bytes alignement
#define WEIGHTS_2_COUNT (64)
#define BIAS_0_COUNT (16)
#define BIAS_1_COUNT (16)
// The third layer bias' size is changed from 3 to 4 to make sure a 16 bytes alignement
#define BIAS_2_COUNT (4)
#define MLP_FLOAT4S ((WEIGHTS_0_COUNT + WEIGHTS_1_COUNT + WEIGHTS_2_COUNT + BIAS_0_COUNT + BIAS_1_COUNT + BIAS_2_COUNT) / 4)

cbuffer c_Global : register(b0)
{
    float4x4 g_ViewInverse;
    float4x4 g_ProjInverse;
    float2 g_ImgDim;
    float g_TanHalfFov;
    // Per model: its first vertex and first index in the buffers (whole numbers).
    float4 g_ModelOffsets[NUM_MODELS];
};

// The models' MLPs, one after the other: each its three layers' weights, then their biases.
cbuffer c_Weights : register(b1)
{
    float4 g_Weights[NUM_MODELS * MLP_FLOAT4S];
};

RaytracingAccelerationStructure t_TopLevelAS : register(t0);
// The sample's vertices (float3 position, float2 texture coordinates), as floats: a structure of
// them would be padded to 24 bytes in SPIR-V's layout.
StructuredBuffer<float> t_Vertices : register(t1);
StructuredBuffer<uint> t_Indices : register(t2);
Texture2D t_Feature0[NUM_MODELS] : register(t3);
Texture2D t_Feature1[NUM_MODELS] : register(t7);
SamplerState s_Feature : register(s0);

// quad.vert: a triangle over the screen.
float4 quad_vs(uint vertexId : SV_VertexID) : SV_Position
{
    float2 outUV = float2((vertexId << 1) & 2, vertexId & 2);
    return float4(outUV * 2.0f - 1.0f, 0.0f, 1.0f);
}

float3 evaluateNetwork(float4 f0, float4 f1, float4 viewdir, uint idx)
{
    const uint base = idx * MLP_FLOAT4S;

    const int bias_0_ind = WEIGHTS_0_COUNT + WEIGHTS_1_COUNT + WEIGHTS_2_COUNT;
    float4 intermediate_one[4] = {
        g_Weights[base + bias_0_ind / 4],
        g_Weights[base + bias_0_ind / 4 + 1],
        g_Weights[base + bias_0_ind / 4 + 2],
        g_Weights[base + bias_0_ind / 4 + 3]
    };
    // For models form original mobile nerf, use the original code
    const float inputs[11] = {
        f0.r, f0.g, f0.b, f0.a, f1.r, f1.g, f1.b, f1.a,
        (viewdir.r + 1.0) / 2, (-viewdir.b + 1.0) / 2, (viewdir.g + 1.0) / 2
    };
    [unroll]
    for (int i = 0; i < 11; i++)
    {
        [unroll]
        for (int j = 0; j < 4; j++)
        {
            intermediate_one[j] += inputs[i] * g_Weights[base + i * 4 + j];
        }
    }

    const int bias_1_ind = WEIGHTS_0_COUNT + WEIGHTS_1_COUNT + WEIGHTS_2_COUNT + BIAS_0_COUNT;
    float4 intermediate_two[4] = {
        g_Weights[base + bias_1_ind / 4],
        g_Weights[base + bias_1_ind / 4 + 1],
        g_Weights[base + bias_1_ind / 4 + 2],
        g_Weights[base + bias_1_ind / 4 + 3]
    };
    [unroll]
    for (int oneInd = 0; oneInd < 16; oneInd++)
    {
        const float intermediate = intermediate_one[oneInd / 4][oneInd % 4];
        if (intermediate > 0.0f)
        {
            [unroll]
            for (int j = 0; j < 4; j++)
            {
                intermediate_two[j] += intermediate * g_Weights[base + WEIGHTS_0_COUNT / 4 + oneInd * 4 + j];
            }
        }
    }

    const int bias_2_ind = WEIGHTS_0_COUNT + WEIGHTS_1_COUNT + WEIGHTS_2_COUNT + BIAS_0_COUNT + BIAS_1_COUNT;
    float4 result = g_Weights[base + bias_2_ind / 4];
    [unroll]
    for (int twoInd = 0; twoInd < 16; twoInd++)
    {
        const float intermediate = intermediate_two[twoInd / 4][twoInd % 4];
        if (intermediate > 0.0f)
        {
            result += intermediate * g_Weights[base + WEIGHTS_0_COUNT / 4 + WEIGHTS_1_COUNT / 4 + twoInd];
        }
    }
    result = 1.0 / (1.0 + exp(-result));
    return result.rgb * viewdir.a + (1.0 - viewdir.a);
}

// The ray through the pixel: the sample's projection has no y flip, and SV_Position's y runs down
// as gl_FragCoord's does in Vulkan.
float3 CalcRayDirComp(float2 fragCoord)
{
    const float2 inUV = fragCoord / g_ImgDim;
    float2 d = inUV * 2.0 - 1.0;
    float4 target = mul(float4(d.x, d.y, 1, 1), g_ProjInverse);
    float4 direction = mul(float4(normalize(target.xyz), 0), g_ViewInverse);
    return normalize(direction.xyz);
}

// MLP was trained with gamma-corrected values: convert to linear so sRGB conversion isn't applied
// twice.
float Convert_sRGB_ToLinear(float value)
{
    return value <= 0.04045
        ? value / 12.92
        : pow((value + 0.055) / 1.055, 2.4);
}

float3 Convert_sRGB_ToLinear(float3 value)
{
    return float3(Convert_sRGB_ToLinear(value.x), Convert_sRGB_ToLinear(value.y), Convert_sRGB_ToLinear(value.z));
}

// rayquery_morpheus_combo.frag (USE_OPAQUE): the first hit, treated as opaque.
float4 rayquery_ps(float4 fragCoord : SV_Position) : SV_Target
{
    const float3 rayDirection = CalcRayDirComp(fragCoord.xy);
    const float3 camPosition = mul(float4(0, 0, 0, 1), g_ViewInverse).xyz;

    RayDesc ray;
    ray.Origin = camPosition;
    ray.TMin = 0.01f;
    ray.Direction = rayDirection;
    ray.TMax = 256.0f;
    RayQuery<RAY_FLAG_FORCE_OPAQUE> rayQuery;
    rayQuery.TraceRayInline(t_TopLevelAS, RAY_FLAG_NONE, 0xFF, ray);

    // Start traversal
    rayQuery.Proceed();

    if (rayQuery.CommittedStatus() == COMMITTED_NOTHING)
    {
        discard;
    }

    const uint instanceID = rayQuery.CommittedInstanceID();
    const uint2 offsets = uint2(g_ModelOffsets[instanceID].xy);

    // get primitive ID in order to access UVs of hitted triangle
    const uint primitiveID = rayQuery.CommittedPrimitiveIndex();
    const uint i0 = offsets.x + t_Indices[offsets.y + 3 * primitiveID];
    const uint i1 = offsets.x + t_Indices[offsets.y + 3 * primitiveID + 1];
    const uint i2 = offsets.x + t_Indices[offsets.y + 3 * primitiveID + 2];
    const float2 uv0 = float2(t_Vertices[i0 * 5 + 3], t_Vertices[i0 * 5 + 4]);
    const float2 uv1 = float2(t_Vertices[i1 * 5 + 3], t_Vertices[i1 * 5 + 4]);
    const float2 uv2 = float2(t_Vertices[i2 * 5 + 3], t_Vertices[i2 * 5 + 4]);

    // Get berycentric coordinate then interpolate the uv of the hit point
    float3 barycentrics = float3(0.0, rayQuery.CommittedTriangleBarycentrics());
    barycentrics.x = 1.0 - barycentrics.y - barycentrics.z;
    const float2 hitpoint_uv = barycentrics.x * uv0 + barycentrics.y * uv1 + barycentrics.z * uv2;

    // Sample feature maps (level 0: they have no others)
    const float2 flipped = float2(hitpoint_uv.x, 1.0 - hitpoint_uv.y);
    float4 pixel_0 = t_Feature0[NonUniformResourceIndex(instanceID)].SampleLevel(s_Feature, flipped, 0);
    float4 pixel_1 = t_Feature1[NonUniformResourceIndex(instanceID)].SampleLevel(s_Feature, flipped, 0);

    pixel_0.a = pixel_0.a * 2.0 - 1.0;
    pixel_1.a = pixel_1.a * 2.0 - 1.0;

    return float4(Convert_sRGB_ToLinear(evaluateNetwork(pixel_0, pixel_1, float4(rayDirection, 1.0f), instanceID)), 1.0);
}

/* Copyright (c) 2024-2026, Holochip Inc.
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

// Port of Vulkan-Samples' render_octomap shaders (render.vert/frag, gltf.vert/frag,
// splat.vert/frag). The TypeScript side gives the sample's projection with clip y negated for
// Donut's y-up clip space.

#include <donut/shaders/binding_helpers.hlsli>

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

struct UBO
{
    float4x4 projection;
    float4x4 camera;
};

cbuffer c_UBO : register(b0)
{
    UBO ubo;
};

struct ColorVSOutput
{
    float4 position : SV_Position;
    float4 color : COLOR;
};

// --- Octomap: a cube per occupied voxel ---------------------------------------------------------

// render.vert
ColorVSOutput render_vs(float3 aPos : POSITION, float3 instancePos : INSTANCE_POSITION, float4 inColor : INSTANCE_COLOR,
    float instanceScale : INSTANCE_SCALE)
{
    ColorVSOutput output;
    output.color = inColor;
    float4 locPos = float4(aPos, 1.0);
    float eps = 0.00001;
    float4 Pos = float4((locPos.xyz * instanceScale) + instancePos, 1.0);
    Pos.x -= eps;
    Pos.y -= eps;
    Pos.z -= eps;
    output.position = mul(mul(Pos, ubo.camera), ubo.projection);
    return output;
}

// render.frag, gltf.frag
float4 color_ps(ColorVSOutput input) : SV_Target
{
    return input.color;
}

// --- glTF map -----------------------------------------------------------------------------------

struct PushConstants
{
    float4x4 model;
    float4 color;
};

DECLARE_PUSH_CONSTANTS(PushConstants, pc, 1, 0);

// gltf.vert
ColorVSOutput gltf_vs(float3 inPos : POSITION, float4 inColor : COLOR)
{
    ColorVSOutput output;
    float4 world_pos = mul(float4(inPos, 1.0), pc.model);
    output.position = mul(mul(world_pos, ubo.camera), ubo.projection);
    // Use vertex color from GLTF data
    output.color = inColor;
    return output;
}

// --- Gaussian splats ----------------------------------------------------------------------------

struct SplatVSOutput
{
    float4 position : SV_Position;
    float4 color : COLOR;
    float3 conic : CONIC;       // inverse 2D covariance (c/det, -b/det, a/det)
    float opacity : OPACITY;
    float2 coord : COORD;       // view-space offset from splat center
};

static const float2 quadVertices[4] = {
    float2(-1.0, -1.0),
    float2( 1.0, -1.0),
    float2(-1.0,  1.0),
    float2( 1.0,  1.0)
};

// quaternionToMatrix: the sample's GLSL mat3 (given by columns), as a matrix (by rows).
float3x3 quaternionToMatrix(float4 q)
{
    float x = q.x, y = q.y, z = q.z, w = q.w;
    float x2 = x * 2.0, y2 = y * 2.0, z2 = z * 2.0;
    float xx = x * x2, xy = x * y2, xz = x * z2;
    float yy = y * y2, yz = y * z2, zz = z * z2;
    float wx = w * x2, wy = w * y2, wz = w * z2;
    return float3x3(
        1.0 - (yy + zz), xy + wz,         xz - wy,
        xy - wz,         1.0 - (xx + zz), yz + wx,
        xz + wy,         yz - wx,         1.0 - (xx + yy)
    );
}

// splat.vert: per-splat attributes (instanced), a quad of 4 vertices (triangle strip) each.
SplatVSOutput splat_vs(uint vertexIndex : SV_VertexID, float3 inPosition : SPLAT_POSITION, float4 inRotation : SPLAT_ROTATION,
    float3 inScale : SPLAT_SCALE, float inOpacity : SPLAT_OPACITY, float3 inColor : SPLAT_COLOR)
{
    SplatVSOutput output;
    float2 quadPos = quadVertices[vertexIndex % 4];

    // Transform splat center to view space
    float4 viewCenter = mul(float4(inPosition, 1.0), ubo.camera);

    // There is no vertex-shader discard, so culling is done by placing the quad outside the
    // clip volume: with w = 1, clip coordinates of (2, 2, 2) divide down to NDC x/y = 2, which
    // is outside the [-1, 1] NDC range on those axes alone and is therefore rejected by
    // clipping before the rasterizer ever sees it (NDC z = 2 is also outside the [0, 1]
    // depth range, reinforcing the cull). The other outputs are zeroed only so a culled vertex
    // can't contribute visible color/opacity if it somehow survives.

    // Cull splats at or behind the near plane — they produce inverted/degenerate quads.
    if (viewCenter.z >= -0.001)
    {
        output.position = float4(2.0, 2.0, 2.0, 1.0);
        output.color = 0.0;
        output.conic = 0.0;
        output.opacity = 0.0;
        output.coord = 0.0;
        return output;
    }

    float splatDepth = -viewCenter.z; // positive distance in front of camera

    // Cull unconverged / degenerate splats whose world-scale exceeds their depth (same
    // outside-clip-volume technique as above).
    float maxScale = max(inScale.x, max(inScale.y, inScale.z));
    if (maxScale > splatDepth)
    {
        output.position = float4(2.0, 2.0, 2.0, 1.0);
        output.color = 0.0;
        output.conic = 0.0;
        output.opacity = 0.0;
        output.coord = 0.0;
        return output;
    }

    // Build 3D covariance from rotation and scale
    float3x3 R = quaternionToMatrix(inRotation);
    float3x3 S = float3x3(inScale.x, 0.0, 0.0,
                          0.0, inScale.y, 0.0,
                          0.0, 0.0, inScale.z);
    float3x3 RS = mul(R, S);
    float3x3 cov3D = mul(RS, transpose(RS));

    // Project 3D covariance into view space and take the top-left 2x2 (the view's rotation,
    // read row-major from glm's columns, is transposed here)
    float3x3 W = transpose((float3x3)ubo.camera);
    float3x3 cov3D_view = mul(mul(W, cov3D), transpose(W));
    cov3D_view[0][0] += 1e-4;
    cov3D_view[1][1] += 1e-4;

    // cov2D: a = [0][0], b = [0][1], c = [1][1]  (symmetric 2x2)
    float a = cov3D_view[0][0];
    float b = cov3D_view[0][1];
    float c = cov3D_view[1][1];

    // Per-axis billboard extents (3 sigma), clamped to depth to avoid screen-filling quads
    float extentX = min(3.0 * sqrt(max(1e-6, a)), splatDepth);
    float extentY = min(3.0 * sqrt(max(1e-6, c)), splatDepth);

    // View-space coordinate for this quad vertex
    output.coord = float2(quadPos.x * extentX, quadPos.y * extentY);

    // Place quad vertex in view space and project
    float3 quadViewPos = viewCenter.xyz + float3(1.0, 0.0, 0.0) * output.coord.x
                                        + float3(0.0, 1.0, 0.0) * output.coord.y;
    output.position = mul(float4(quadViewPos, 1.0), ubo.projection);

    // Inverse 2D covariance for fragment-shader Gaussian evaluation
    float det = a * c - b * b;
    if (det < 1e-14) det = 1e-14;
    output.conic = float3(c, -b, a) / det;   // (c/det, -b/det, a/det)

    // Color is stored in display space — pass through without gamma modification
    output.color = float4(inColor, 1.0);
    output.opacity = inOpacity;
    return output;
}

// splat.frag
float4 splat_ps(SplatVSOutput input) : SV_Target
{
    float x = input.coord.x;
    float y = input.coord.y;

    // Full anisotropic 2D Gaussian: -0.5 * [x,y] * cov2D^-1 * [x,y]^T
    // inConic = (c/det, -b/det, a/det) for cov2D = [[a,b],[b,c]]
    float power = -0.5 * (input.conic.x * x * x + 2.0 * input.conic.y * x * y + input.conic.z * y * y);

    if (power > 0.0)
    {
        discard;
    }

    float alpha = exp(power) * input.opacity;

    if (alpha < 0.01)
    {
        discard;
    }

    // Premultiplied alpha for correct blending
    return float4(input.color.rgb * alpha, alpha);
}

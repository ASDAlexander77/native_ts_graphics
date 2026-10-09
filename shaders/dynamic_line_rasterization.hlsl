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

// Port of Vulkan-Samples' dynamic_line_rasterization shaders (base.vert, base.frag, grid.vert,
// grid.frag) to Donut's bindings. The TypeScript side gives the sample's projection * view with
// clip y negated for Donut's y-up clip space, and its inverse, so the picture lands as the sample's
// does.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

cbuffer c_Camera : register(b0)
{
    float4x4 g_ViewProjection;
    float4x4 g_ViewProjectionInverse;
};

// The sample's push constant: the color of what is drawn.
cbuffer c_Color : register(b1)
{
    float4 g_Color;
};

// base.vert: the cube, moved down by 1 (the model matrix is the identity).
float4 base_vs(float3 position : POSITION) : SV_Position
{
    return mul(float4(position - float3(0.0, 1.0, 0.0), 1.0), g_ViewProjection);
}

// base.frag
float4 base_ps() : SV_Target
{
    return g_Color;
}

struct GridVSOutput
{
    float4 position : SV_Position;
    float3 nearPoint : NEAR_POINT;
    float3 farPoint : FAR_POINT;
};

float3 unprojectPoint(float x, float y, float z)
{
    float4 eyeSpacePos = mul(float4(x, y, z, 1.0), g_ViewProjectionInverse);
    return eyeSpacePos.xyz / eyeSpacePos.w;
}

static const float3 c_GridPlane[6] = {
    float3(1, 1, 0), float3(-1, -1, 0), float3(-1, 1, 0),
    float3(-1, -1, 0), float3(1, 1, 0), float3(1, -1, 0)
};

// grid.vert: a quad over the screen, with the points of the near and far planes behind each corner.
GridVSOutput grid_vs(uint vertexIndex : SV_VertexID)
{
    float3 pos = c_GridPlane[vertexIndex];

    GridVSOutput output;
    output.nearPoint = unprojectPoint(pos.x, pos.y, 0.0);
    output.farPoint = unprojectPoint(pos.x, pos.y, 1.0);
    output.position = float4(pos, 1.0);
    return output;
}

float4 grid(float3 pos)
{
    float2 coord = pos.xz;
    // (Fine derivatives: the sample's fwidth is SPIR-V's, fine on NVIDIA; DXIL's is coarse.)
    float2 derivative = abs(ddx_fine(coord)) + abs(ddy_fine(coord));
    float2 grid = abs(frac(coord - 0.5) - 0.5) / derivative;
    float line_ = min(grid.x, grid.y);
    float minimumz = min(derivative.y, 1);
    float minimumx = min(derivative.x, 1);
    float4 color = float4(0.5, 0.5, 0.5, 1.0 - min(line_, 1.0));

    if (abs(pos.x) < minimumx)
        color.y = 1;
    if (abs(pos.z) < minimumz)
        color.x = 1;
    return color;
}

float fadeFactor(float3 pos)
{
    // (Clip z, which the negated y leaves as it is.)
    float z = mul(float4(pos, 1.0), g_ViewProjection).z;
    // Empirical values are used to determine when to cut off the grid before moire patterns become visible.
    return z * 6 - 0.5;
}

// grid.frag: the plane y = 0 where the eye's ray meets it (below the horizon), its unit squares'
// edges, the x axis red and the z axis green, fading out in the distance.
float4 grid_ps(GridVSOutput input) : SV_Target
{
    float t = -input.nearPoint.y / (input.farPoint.y - input.nearPoint.y);
    float3 pos = input.nearPoint + t * (input.farPoint - input.nearPoint);

    // Display only the lower plane
    if (t < 1.0)
    {
        float4 gridColor = grid(pos);
        return float4(gridColor.xyz, gridColor.w * fadeFactor(pos));
    }
    return float4(0.0, 0.0, 0.0, 0.0);
}

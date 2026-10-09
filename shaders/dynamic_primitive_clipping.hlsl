/* Copyright (c) 2024, Mobica Limited
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

// Port of Vulkan-Samples' dynamic_primitive_clipping shaders (primitive_clipping.vert, .frag) to
// Donut's bindings: user clip distances (SV_ClipDistance, gl_ClipDistance). Positions and
// directions are in the sample's world and view spaces; its projection, which the TypeScript side
// sets up, flips y for Donut's y-up clip space, so the clip space functions take the sample's clip
// position (y down) back.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

cbuffer c_Ubo : register(b0)
{
    float4x4 g_Projection;
    float4x4 g_View;
    float4x4 g_Model;
    float4 g_ColorTransformation;
    // The visualization, and the sign of the clip distance (1 for the first draw, -1 the second).
    int2 g_SceneTransformation;
    float g_UsePrimitiveClipping;
};

// In a fixed pipeline approach which you can still find in OpenGL implementations you could define
// up to maximum 6 clipping half-spaces and a distance to each clipping half-space was stored in gl_ClipDistance.
// That's why gl_ClipDistance[] is an array which maximum size is limited by maxClipDistances.
//
// In our example we show you how to define such half-spaces using plane equation: Ax+By+Cz+D=0
// You could transmit information about values of A,B,C and D using UBO for example, but for simplicity we will use const declaration:
static const float4 planeValues = float4(0.0, 1.0, 0.0, 0.0);

struct VSInput
{
    float3 pos : POSITION;
    float3 normal : NORMAL;
};

struct VSOutput
{
    float4 position : SV_Position;
    float clipDistance : SV_ClipDistance0;
    float3 normal : NORMAL;
};

// Cases 0 and 1 present how to use world space coordinates with more advanced functions
// Case 2 shows how to use half-space in world space coordinates
// Case 3 shows how to use half-space in clip space coordinates
// Cases 4-6 present how to use clip space coordinates with more advanced functions
// Cases 0,1,4,5 use sin() function to create strips in which values of gl_ClipDistance below 0 cause triangle primitives
// to be clipped according to Vulkan specification chapter 27.4
// Cases 6-8 use different types of distance functions from center of the screen ( Euclidean, Manhattan, Chebyshev )
VSOutput main_vs(VSInput input)
{
    VSOutput output;
    float4 worldPosition = mul(float4(input.pos, 1.0), g_Model);
    output.position = mul(mul(worldPosition, g_View), g_Projection);
    // The sample's clip position: y down.
    const float4 position = float4(output.position.x, -output.position.y, output.position.zw);
    float clipResult = 1.0;
    float distance = 0.4;

    // Primitive clipping does not have any vkCmd* command that turns it off.
    // If we want to turn it off - we have to transfer this information to shader through UBO variable and
    // then use code similar to this (the clip distance left positive: nothing clipped):
    output.clipDistance = 1.0;
    if (g_UsePrimitiveClipping > 0.0)
    {
        switch (g_SceneTransformation.x)
        {
        case 0:
            clipResult = sin(worldPosition.x * 0.1 * 2.0 * 3.1415);
            break;
        case 1:
            clipResult = sin(worldPosition.y * 0.1 * 2.0 * 3.1415);
            break;
        case 2:
            clipResult = dot(worldPosition, planeValues);
            break;
        case 3:
            clipResult = dot(position, planeValues);
            break;
        case 4:
            clipResult = sin(position.x / position.w * 3.0 * 2.0 * 3.1415);
            break;
        case 5:
            clipResult = sin(position.y / position.w * 3.0 * 2.0 * 3.1415);
            break;
        case 6:
            clipResult = (position.x * position.x + position.y * position.y) / (position.w * position.w) - distance * distance;
            break;
        case 7:
            clipResult = (abs(position.x) + abs(position.y)) / position.w - distance;
            break;
        case 8:
            clipResult = max(abs(position.x), abs(position.y)) / position.w - distance;
            break;
        }
        output.clipDistance = clipResult * float(g_SceneTransformation.y);
    }
    output.normal = normalize(mul(input.normal, (float3x3) mul(g_Model, g_View)));
    return output;
}

// The view space normal as a color, inverted for the second draw.
float4 main_ps(VSOutput input) : SV_Target
{
    float4 color = float4(0.5 * input.normal + 0.5, 1);
    color.xyz = g_ColorTransformation.x * color.xyz + g_ColorTransformation.y;
    return color;
}

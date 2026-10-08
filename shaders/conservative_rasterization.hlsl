/* Copyright (c) 2019-2024, Sascha Willems
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

// Port of Vulkan-Samples' conservative_rasterization shaders (triangle.vert/frag,
// triangleoverlay.frag, fullscreen.vert/frag). The TypeScript side gives the sample's projection
// with clip y negated for Donut's y-up clip space.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

struct SceneConstants
{
    float4x4 projection;
    float4x4 model;
    // The overlay's target size in pixels, and its lines' width (the sample's lineWidth).
    float2 viewportSize;
    float lineWidth;
    float padding;
};

cbuffer c_Scene : register(b0)
{
    SceneConstants g_Scene;
};

// --- The triangle -------------------------------------------------------------------------------

struct TriangleVSOutput
{
    float4 position : SV_Position;
    float3 color : COLOR;
};

// triangle.vert
TriangleVSOutput triangle_vs(float3 inPos : POSITION, float3 inColor : COLOR)
{
    TriangleVSOutput output;
    output.color = inColor;
    output.position = mul(mul(float4(inPos, 1.0), g_Scene.model), g_Scene.projection);
    return output;
}

// triangle.frag
float4 triangle_ps(TriangleVSOutput input) : SV_Target
{
    return float4(input.color, 1.0);
}

// --- The triangle's outline ---------------------------------------------------------------------

// The sample draws the triangle's edges in line mode, lineWidth 2 (strict lines: a rectangle of that
// width around each edge). D3D has no wide lines, and NVRHI draws Vulkan's at width 1: here a
// geometry shader turns each edge into that rectangle.
[maxvertexcount(12)]
void overlay_gs(triangle TriangleVSOutput input[3], inout TriangleStream<TriangleVSOutput> output)
{
    // The vertices in pixels.
    float2 pixels[3];
    for (uint i = 0; i < 3; i++)
    {
        pixels[i] = input[i].position.xy / input[i].position.w * g_Scene.viewportSize * 0.5;
    }

    TriangleVSOutput vertex;
    vertex.color = 1.0;
    for (uint edge = 0; edge < 3; edge++)
    {
        const uint a = edge;
        const uint b = (edge + 1) % 3;
        const float2 direction = normalize(pixels[b] - pixels[a]);
        const float2 side = float2(-direction.y, direction.x) * (g_Scene.lineWidth * 0.5);
        const float2 corners[4] = { pixels[a] - side, pixels[a] + side, pixels[b] - side, pixels[b] + side };
        for (uint c = 0; c < 4; c++)
        {
            const uint end = c < 2 ? a : b;
            vertex.position = float4(corners[c] / (g_Scene.viewportSize * 0.5), input[end].position.z / input[end].position.w, 1.0);
            output.Append(vertex);
        }
        output.RestartStrip();
    }
}

// triangleoverlay.frag
float4 overlay_ps(TriangleVSOutput input) : SV_Target
{
    return float4(1.0, 1.0, 1.0, 1.0);
}

// --- The low resolution image, full screen ------------------------------------------------------

Texture2D t_Color : register(t0);
SamplerState s_Color : register(s0);

struct FullscreenVSOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
};

// fullscreen.vert: a triangle over the screen (in the sample's clip space, y down).
FullscreenVSOutput fullscreen_vs(uint vertexId : SV_VertexID)
{
    FullscreenVSOutput output;
    output.uv = float2((vertexId << 1) & 2, vertexId & 2);
    const float2 position = output.uv * 2.0 - 1.0;
    output.position = float4(position.x, -position.y, 0.0, 1.0);
    return output;
}

// fullscreen.frag
float4 fullscreen_ps(FullscreenVSOutput input) : SV_Target
{
    return t_Color.Sample(s_Color, input.uv);
}

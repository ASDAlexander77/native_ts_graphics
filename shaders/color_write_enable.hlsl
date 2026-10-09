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

// Port of Vulkan-Samples' color_write_enable shaders (triangle_separate_channels.vert/.frag,
// composition.vert/.frag) to Donut's bindings: a triangle written to three targets, then the
// targets added up. The sample reads its targets as input attachments of a second subpass; here
// they're textures read at the pixel. Clip y is negated for Donut's y-up clip space.

struct VSOutput
{
    float4 position : SV_Position;
    float3 color : COLOR;
};

// triangle_separate_channels.vert
VSOutput triangle_vs(uint vertexIndex : SV_VertexID)
{
    const float2 triangle_positions[3] = {
        float2(0.0, -0.5),
        float2(0.5, 0.5),
        float2(-0.5, 0.5)
    };
    const float3 triangle_colors[3] = {
        float3(1.0, 0.0, 0.0),
        float3(0.0, 1.0, 0.0),
        float3(0.0, 0.0, 1.0)
    };
    VSOutput output;
    const float2 position = triangle_positions[vertexIndex];
    output.position = float4(position.x, -position.y, 0.0, 1.0);
    output.color = triangle_colors[vertexIndex];
    return output;
}

struct TriangleOutput
{
    float4 colorR : SV_Target0;
    float4 colorG : SV_Target1;
    float4 colorB : SV_Target2;
};

// triangle_separate_channels.frag: the full color is copied to individual targets; each target
// has a single channel (R, G, B) written, by the pipeline's write masks.
TriangleOutput triangle_ps(VSOutput input)
{
    TriangleOutput output;
    output.colorR = float4(input.color, 1.0f);
    output.colorG = float4(input.color, 1.0f);
    output.colorB = float4(input.color, 1.0f);
    return output;
}

Texture2D t_ColorR : register(t0);
Texture2D t_ColorG : register(t1);
Texture2D t_ColorB : register(t2);

// composition.vert
float4 composition_vs(uint vertexIndex : SV_VertexID) : SV_Position
{
    float2 uv = float2((vertexIndex << 1) & 2, vertexIndex & 2);
    float2 position = uv * 2.0f - 1.0f;
    // y negated as the triangle's, keeping its winding for the back face culling.
    return float4(position.x, -position.y, 0.0f, 1.0f);
}

// composition.frag
float4 composition_ps(float4 position : SV_Position) : SV_Target
{
    const int3 pixel = int3(position.xy, 0);
    float4 color_r = t_ColorR.Load(pixel);
    float4 color_g = t_ColorG.Load(pixel);
    float4 color_b = t_ColorB.Load(pixel);
    return color_r + color_g + color_b;
}

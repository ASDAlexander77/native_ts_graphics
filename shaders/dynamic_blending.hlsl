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

// Port of Vulkan-Samples' dynamic_blending shaders (blending.vert, blending.frag) to Donut's
// bindings. The TypeScript side gives the sample's projection * view * model with clip y negated
// for Donut's y-up clip space, so the picture lands as the sample's does.

// The matrix comes in glm's layout (columns): read as row-major, it's for mul(vector, matrix).
#pragma pack_matrix(row_major)

cbuffer c_Camera : register(b0)
{
    float4x4 g_ModelViewProjection;
};

// The two faces' corner colors: top left, top right, bottom left, bottom right; the face at z = -1
// first.
cbuffer c_Colors : register(b1)
{
    float4 g_Colors[8];
};

struct VSOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
    nointerpolation uint colorOffset : TEXCOORD1;
};

// blending.vert
VSOutput main_vs(float3 position : POSITION, float2 uv : TEXCOORD)
{
    VSOutput output;
    output.uv = uv;
    output.colorOffset = position.z == 1.0 ? 4 : 0;
    output.position = mul(float4(position, 1.0), g_ModelViewProjection);
    return output;
}

// blending.frag: the face's corner colors, interpolated bilinearly.
float4 main_ps(VSOutput input) : SV_Target
{
    float4 c00 = g_Colors[0 + input.colorOffset];
    float4 c01 = g_Colors[1 + input.colorOffset];
    float4 c02 = g_Colors[2 + input.colorOffset];
    float4 c03 = g_Colors[3 + input.colorOffset];

    float4 b0 = lerp(c00, c01, input.uv.x);
    float4 b1 = lerp(c02, c03, input.uv.x);

    return lerp(b0, b1, input.uv.y);
}

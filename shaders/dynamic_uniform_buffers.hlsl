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

// Port of Vulkan-Samples' dynamic_uniform_buffers shaders (base.vert, base.frag) to Donut's
// bindings: a colored cube, its model matrix from its own slice of one uniform buffer. The
// TypeScript side gives the sample's projection with clip y negated for Donut's y-up clip space.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

cbuffer UboView : register(b0)
{
    float4x4 g_Projection;
    float4x4 g_View;
};

cbuffer UboInstance : register(b1)
{
    float4x4 g_Model;
};

struct VSInput
{
    float3 pos : POSITION;
    float3 color : COLOR;
};

struct VSOutput
{
    float4 position : SV_Position;
    float3 color : COLOR;
};

// base.vert
VSOutput base_vs(VSInput input)
{
    VSOutput output;
    output.color = input.color;
    // To avoid calculating this for every vertex, matrix multiplications could be moved to the CPU-side
    float4x4 modelView = mul(g_Model, g_View);
    output.position = mul(mul(float4(input.pos.xyz, 1.0), modelView), g_Projection);
    return output;
}

// base.frag
float4 base_ps(VSOutput input) : SV_Target
{
    return float4(input.color, 1.0);
}

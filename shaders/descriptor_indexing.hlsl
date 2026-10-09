/* Copyright (c) 2021, Arm Limited and Contributors
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

// Port of Vulkan-Samples' descriptor_indexing shaders (nonuniform-quads.vert/.frag,
// update-after-bind-quads.vert/.frag) to Donut's bindings: rotating quads, each sampling a texture
// of a bindless array, the left grid by a non-uniform index (the instance), the right one by a
// push constant (a slot written just before each draw). Clip y is negated for Donut's y-up clip
// space.

#include <donut/shaders/binding_helpers.hlsli>

// The sample's push constants: the quads' rotation (vertex), the table slot to read (fragment);
// plus the quad's instance index, for the right grid's draws (the sample's firstInstance, which
// HLSL's SV_InstanceID leaves out).
struct Registers
{
    float phase;
    uint tableOffset;
    uint instance;
};

DECLARE_PUSH_CONSTANTS(Registers, g_Registers, 0, 0);

SamplerState s_ImmutableSampler : register(s0);
VK_BINDING(0, 1) Texture2D t_Textures[] : register(t0, space1);

struct VSOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
    nointerpolation int textureIndex : TEXCOORD1;
};

// The quad's corner, rotated by the phase, at its place in the grid (column offset 0 on the
// left, 8 on the right).
VSOutput quad(uint vertexIndex, int instanceIndex, int columnOffset)
{
    VSOutput output;
    float2 local_offset = float2(vertexIndex & 1, vertexIndex >> 1);
    output.uv = local_offset;

    // A lazy quad rotation, could easily have been precomputed on CPU.
    float cos_phase = cos(g_Registers.phase);
    float sin_phase = sin(g_Registers.phase);
    // GLSL's mat2(cos, -sin, sin, cos) * v, by columns.
    local_offset -= 0.5;
    local_offset = float2(cos_phase * local_offset.x + sin_phase * local_offset.y,
        -sin_phase * local_offset.x + cos_phase * local_offset.y);

    // To keep the sample as simple as possible, use the instance index to move the quads around on screen.
    int instance_x = instanceIndex % 8 + columnOffset;
    int instance_y = instanceIndex / 8;
    float2 instance_offset = float2(instance_x, instance_y) / float2(15.0, 7.0);
    instance_offset = 2.1 * (instance_offset - 0.5);

    float2 position = (0.10 * local_offset) + instance_offset;
    output.position = float4(position.x, -position.y, 0.0, 1.0);

    // Pass down an index which we will use to index into the descriptor array.
    output.textureIndex = instanceIndex;
    return output;
}

// nonuniform-quads.vert
VSOutput nonuniform_vs(uint vertexIndex : SV_VertexID, uint instanceIndex : SV_InstanceID)
{
    return quad(vertexIndex, instanceIndex, 0);
}

// nonuniform-quads.frag: indexing into the texture array with a non-uniform index (across the
// draw, there are different instance indices being used).
float4 nonuniform_ps(VSOutput input) : SV_Target
{
    return t_Textures[NonUniformResourceIndex(input.textureIndex)].Sample(s_ImmutableSampler, input.uv);
}

// update-after-bind-quads.vert
VSOutput update_after_bind_vs(uint vertexIndex : SV_VertexID)
{
    return quad(vertexIndex, g_Registers.instance, 8);
}

// update-after-bind-quads.frag: a very common usage pattern for streamed descriptors with
// UPDATE_AFTER_BIND: only the push constants change, and the shader reads the new descriptors.
// A push constant is dynamically uniform over the draw call, so this is simply dynamic indexing.
float4 update_after_bind_ps(VSOutput input) : SV_Target
{
    return t_Textures[g_Registers.tableOffset].Sample(s_ImmutableSampler, input.uv);
}

/* Copyright (c) 2021-2025 Holochip Corporation
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

// Port of Vulkan-Samples' multi_draw_indirect shaders (multi_draw_indirect.vert/frag, cull.comp,
// cull_address.comp) to Donut's bindings, in one file. Positions are in the sample's world (its
// vertices with y negated) and its view space (y down on the screen, -z forward); its projection,
// which the TypeScript side sets up, flips y for Donut's y-up clip space.

// The matrices are glm's (column vectors) in memory: read row-major, they're their transposes, for
// mul(vector, matrix), and m[k][i] is the GLSL shaders' mat[k][i].
#pragma pack_matrix(row_major)

struct GlobalUniform
{
    float4x4 view;
    float4x4 proj;
    float4x4 proj_view;
    uint model_count;
};

cbuffer c_GlobalUniform : register(b0)
{
    GlobalUniform global_uniform;
};

// --- Drawing ---------------------------------------------------------------------------------

// The scene's textures, one per mesh: each draw's (instance's) texture index picks one.
#define TEXTURE_COUNT 225
Texture2D textures[TEXTURE_COUNT] : register(t0);
SamplerState s_Texture : register(s0);

struct VSInput
{
    float3 position : POSITION;
    float2 uv : TEXCOORD;
    // Per instance: the model's texture (the sample also declares its bounding sphere, unused).
    uint texture_index : TEXTURE_INDEX;
};

struct VSOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD;
    nointerpolation uint texture_index : TEXTURE_INDEX;
};

VSOutput mdi_vs(VSInput input)
{
    VSOutput output;
    output.uv = input.uv;
    output.position = mul(mul(float4(input.position, 1.0), global_uniform.view), global_uniform.proj);
    output.texture_index = input.texture_index;
    return output;
}

float4 mdi_ps(VSOutput input) : SV_Target
{
    float4 color = textures[input.texture_index].Sample(s_Texture, input.uv);
    color.rgb *= 1.5;
    return color;
}

// --- Culling ---------------------------------------------------------------------------------

// struct ModelInformation { float x, y, z, r; uint texture_index, firstIndex, indexCount, _pad; }
#define MODEL_INFORMATION_SIZE 32
ByteAddressBuffer model_buffer : register(t0);

// struct VkDrawIndexedIndirectCommand { uint indexCount, instanceCount, firstIndex; int vertexOffset;
// uint firstInstance; }: the culling writes instanceCount.
#define COMMAND_SIZE 20
#define INSTANCE_COUNT_OFFSET 4

// See "VisibilityTester" in the C++ code for explanation
bool check_is_visible(float4x4 mat, float3 origin, float radius)
{
    uint plane_index = 0;
    for (uint i = 0; i < 3; ++i)
    {
        for (uint j = 0; j < 2; ++j, ++plane_index)
        {
            if (plane_index == 2 || plane_index == 3)
            {
                continue;
            }
            const float sign = (j > 0) ? 1.f : -1.f;
            float4 plane = float4(0, 0, 0, 0);
            for (uint k = 0; k < 4; ++k)
            {
                plane[k] = mat[k][3] + sign * mat[k][i];
            }
            plane.xyzw /= sqrt(dot(plane.xyz, plane.xyz));
            if (dot(origin, plane.xyz) + plane.w + radius < 0)
            {
                return false;
            }
        }
    }
    return true;
}

// Whether model `id` is in the view; false past the last model.
bool is_model_visible(uint id)
{
    const float4 sphere = asfloat(model_buffer.Load4(id * MODEL_INFORMATION_SIZE));
    return check_is_visible(global_uniform.proj_view, sphere.xyz, sphere.w);
}

// cull.comp: writes the commands through their buffer's binding.
RWByteAddressBuffer command_buffer : register(u0);

[numthreads(64, 1, 1)]
void cull_cs(uint3 globalId : SV_DispatchThreadID)
{
    uint id = globalId.x;
    if (id >= global_uniform.model_count)
    {
        return;
    }
    const bool is_visible = is_model_visible(id);
    command_buffer.Store(id * COMMAND_SIZE + INSTANCE_COUNT_OFFSET, is_visible ? 1 : 0);
}

// cull_address.comp: writes the commands through their buffer's device address, the first of
// the addresses buffer (as two uints). Vulkan only: HLSL has no pointers on D3D12.
StructuredBuffer<uint2> addresses : register(t1);

[numthreads(64, 1, 1)]
void cull_address_cs(uint3 globalId : SV_DispatchThreadID)
{
#ifdef SPIRV
    uint id = globalId.x;
    if (id >= global_uniform.model_count)
    {
        return;
    }
    const bool is_visible = is_model_visible(id);
    const uint2 address = addresses[0];
    const uint64_t command_buffer = (uint64_t(address.y) << 32) | address.x;
    vk::RawBufferStore<uint>(command_buffer + id * COMMAND_SIZE + INSTANCE_COUNT_OFFSET, is_visible ? 1 : 0);
#endif
}

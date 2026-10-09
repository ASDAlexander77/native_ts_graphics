/* Copyright (c) 2020-2025, Arm Limited and Contributors
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

// Port of Vulkan-Samples' 16bit_arithmetic shaders: compute_buffer.comp (FP32 arithmetic) and
// visualize.vert/frag. The FP16 shaders are in 16bit_arithmetic_fp16.hlsl, which needs native
// 16-bit types (shader model 6.2, no DXBC). The blobs are 16-bit floats, four to a blob: the
// sample reads them as f16vec4 with 16-bit storage; here they're read as two uints and converted
// (f16tof32), which needs nothing, so this runs on D3D11 as well.

#include <donut/shaders/binding_helpers.hlsli>

// The sample's specialization constants.
static const uint WIDTH = 1024;
static const uint HEIGHT = 1024;

StructuredBuffer<uint2> blob_data : register(t0);

RWTexture2D<float4> o_results : register(u0);

struct Registers
{
    uint num_blobs;
    float seed;
    int2 range;
};

DECLARE_PUSH_CONSTANTS(Registers, registers, 0, 0);

// This is very arbitrary. Expends a ton of arithmetic to compute
// something that looks similar to a lens flare.
float4 compute_blob(float2 pos, float4 blob, float seed)
{
    float2 offset = pos - blob.xy;
    float2 s_offset = offset * (1.1 + seed);
    float2 r_offset = offset * 0.95;
    float2 g_offset = offset * 1.0;
    float2 b_offset = offset * 1.05;

    float r_dot = dot(r_offset, r_offset);
    float g_dot = dot(g_offset, g_offset);
    float b_dot = dot(b_offset, b_offset);
    float s_dot = dot(s_offset, s_offset);

    float4 dots = float4(r_dot, g_dot, b_dot, s_dot) * blob.w;

    // Now we have square distances to blob center.

    // Gotta have some FMAs, right? :D
    dots = dots * dots + dots;
    dots = dots * dots + dots;
    dots = dots * dots + dots;
    dots = dots * dots + dots;
    dots = dots * dots + dots;
    dots = dots * dots + dots;

    float4 parabolas = max(float4(1.0, 1.0, 1.0, 0.9) - dots, 0.0);
    parabolas -= parabolas.w;
    parabolas = max(parabolas, 0.0);
    return parabolas;
}

// compute_buffer.comp
[numthreads(8, 8, 1)]
void compute_fp32(uint3 globalInvocationID : SV_DispatchThreadID)
{
    uint num_blobs = registers.num_blobs;

    float x = float(globalInvocationID.x) / float(WIDTH) - 0.5;
    float y = float(globalInvocationID.y) / float(HEIGHT) - 0.5;
    float2 pos = float2(x, y);
    float4 result = 0.0;
    float seed = registers.seed;
    int2 range = registers.range;

    const float EXPAND_FACTOR = 0.3;
    float stride = seed * EXPAND_FACTOR;

    for (uint i = 0; i < num_blobs; i++)
    {
        const uint2 packed = blob_data[i];
        float4 blob = float4(f16tof32(packed.x), f16tof32(packed.x >> 16), f16tof32(packed.y), f16tof32(packed.y >> 16));

        // Get as much mileage out of the buffer load as possible.
        for (int y = -range.y; y <= range.y; y++)
            for (int x = -range.x; x <= range.x; x++)
                result += compute_blob(pos + stride * float2(x, y), blob, seed);
    }

    o_results[globalInvocationID.xy] = result;
}

// --- Visualization: the result over the screen ---------------------------------------------------

Texture2D tex : register(t0);
SamplerState s_tex : register(s0);

struct VisualizeVSOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
};

// visualize.vert: a triangle over the screen, in the sample's clip space (y down), negated for
// Donut's (y up).
VisualizeVSOutput visualize_vs(uint vertexIndex : SV_VertexID)
{
    VisualizeVSOutput output;
    float2 position;
    if (vertexIndex == 0)
        position = float2(-1.0, -1.0);
    else if (vertexIndex == 1)
        position = float2(-1.0, 3.0);
    else
        position = float2(3.0, -1.0);

    output.uv = position * 0.5 + 0.5;
    output.position = float4(position.x, -position.y, 0.0, 1.0);
    return output;
}

// visualize.frag
float4 visualize_ps(VisualizeVSOutput input) : SV_Target
{
    return float4(tex.SampleLevel(s_tex, input.uv, 0.0).rgb, 1.0);
}

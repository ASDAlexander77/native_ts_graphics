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

// Port of Vulkan-Samples' 16bit_arithmetic FP16 shaders: compute_buffer_fp16.comp (16-bit push
// constants, PUSH_CONSTANT_16=1) and compute_buffer_fp16_fallback.comp (32-bit ones, for devices
// without them, PUSH_CONSTANT_16=0). Native 16-bit types: shader model 6.2, compiled with
// -enable-16bit-types (ShaderMake's default from 6.2 on), so DXIL and SPIR-V only.

#include <donut/shaders/binding_helpers.hlsli>

#ifndef PUSH_CONSTANT_16
#define PUSH_CONSTANT_16 1
#endif

// The sample's specialization constants.
static const uint WIDTH = 1024;
static const uint HEIGHT = 1024;

// It is possible to use native 16-bit types in SSBOs and UBOs. We could use uvec2 here and unpack manually.
// The key feature of 16-bit storage is to allow scalar access to 16-bit values however.
// Avoiding extra unpacking and packing can also be useful.
StructuredBuffer<float16_t4> blob_data : register(t0);

RWTexture2D<float4> o_results : register(u0);

#if PUSH_CONSTANT_16
struct Registers
{
    uint16_t num_blobs;
    float16_t seed;
    int16_t2 range;
};
#else
struct Registers
{
    // Fallback for implementations which do not support PushConstant16.
    uint num_blobs;
    float seed;
    int2 range;
};
#endif

DECLARE_PUSH_CONSTANTS(Registers, registers, 0, 0);

// This is very arbitrary. Expends a ton of arithmetic to compute
// something that looks similar to a lens flare.
float16_t4 compute_blob(float16_t2 pos, float16_t4 blob, float16_t seed)
{
    float16_t2 offset = pos - blob.xy;
    float16_t4 rg_offset = offset.xxyy * float16_t4(0.95h, 1.0h, 0.95h, 1.0h);
    float16_t4 bs_offset = offset.xxyy * float16_t4(1.05h, 1.1h + seed, 1.05h, 1.1h + seed);

    float16_t4 rg_dot = rg_offset * rg_offset;
    float16_t4 bs_dot = bs_offset * bs_offset;

    // Dot products can be somewhat awkward in FP16, since the result is a scalar 16-bit value, and we don't want that.
    // To that end, we compute at least two dot products side by side, and rg_offset and bs_offset are swizzled
    // such that we avoid swizzling across a 32-bit boundary.
    float16_t4 dots = float16_t4(rg_dot.xy + rg_dot.zw, bs_dot.xy + bs_dot.zw) * blob.w;

    // Now we have square distances to blob center.

    // Gotta have some FMAs, right? :D
    dots = dots * dots + dots;
    dots = dots * dots + dots;
    dots = dots * dots + dots;
    dots = dots * dots + dots;
    dots = dots * dots + dots;
    dots = dots * dots + dots;

    float16_t4 parabolas = max(float16_t4(1.0h, 1.0h, 1.0h, 0.9h) - dots, float16_t4(0.0h, 0.0h, 0.0h, 0.0h));
    parabolas -= parabolas.w;
    parabolas = max(parabolas, float16_t4(0.0h, 0.0h, 0.0h, 0.0h));
    return parabolas;
}

// compute_buffer_fp16.comp, compute_buffer_fp16_fallback.comp
[numthreads(8, 8, 1)]
void compute_fp16(uint3 globalInvocationID : SV_DispatchThreadID)
{
    uint num_blobs = uint(registers.num_blobs);

    float x = float(globalInvocationID.x) / float(WIDTH) - 0.5;
    float y = float(globalInvocationID.y) / float(HEIGHT) - 0.5;
    float16_t2 pos = float16_t2(x, y);
    float16_t4 result = float16_t4(0.0h, 0.0h, 0.0h, 0.0h);
    float16_t seed = float16_t(registers.seed);
    int2 range = int2(registers.range);

    const float16_t EXPAND_FACTOR = 0.3h;
    float16_t stride = seed * EXPAND_FACTOR;

    for (uint i = 0; i < num_blobs; i++)
    {
        float16_t4 blob = blob_data[i];

        // Get as much mileage out of the buffer load as possible.
        for (int y = -range.y; y <= range.y; y++)
            for (int x = -range.x; x <= range.x; x++)
                result += compute_blob(pos + stride * float16_t2(x, y), blob, seed);
    }

    o_results[globalInvocationID.xy] = result;
}

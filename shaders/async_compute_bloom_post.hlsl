/* Copyright (c) 2021-2026, Arm Limited and Contributors
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

// Port of Vulkan-Samples' async_compute compute shaders (threshold.comp, blur_down.comp,
// blur_up.comp, blur_common.h) to Donut's bindings, in one file.

#include <donut/shaders/binding_helpers.hlsli>

// --- Bloom: threshold, blur down, blur up (compute) --------------------------------------------

// The sample's Registers.
struct BlurConstants
{
    uint2 resolution;
    float2 invResolution;
    float2 invInputResolution;
};
DECLARE_PUSH_CONSTANTS(BlurConstants, g_Blur, 0, 0);

Texture2D t_Input : register(t0);
SamplerState s_Input : register(s0);
RWTexture2D<float4> u_Output : register(u0);

float2 getUV(float2 uv, float x, float y, float scale)
{
    return uv + g_Blur.invInputResolution * (float2(x, y) * scale);
}

// blur_common.h
float3 bloomBlur(float2 uv, float uvScale)
{
    float3 rgb = 0.0;
    const float N = -1.0;
    const float Z = 0.0;
    const float P = 1.0;
    rgb += 0.25 * t_Input.SampleLevel(s_Input, getUV(uv, Z, Z, uvScale), 0.0).rgb;
    rgb += 0.0625 * t_Input.SampleLevel(s_Input, getUV(uv, N, P, uvScale), 0.0).rgb;
    rgb += 0.0625 * t_Input.SampleLevel(s_Input, getUV(uv, P, P, uvScale), 0.0).rgb;
    rgb += 0.0625 * t_Input.SampleLevel(s_Input, getUV(uv, N, N, uvScale), 0.0).rgb;
    rgb += 0.0625 * t_Input.SampleLevel(s_Input, getUV(uv, P, N, uvScale), 0.0).rgb;
    rgb += 0.125 * t_Input.SampleLevel(s_Input, getUV(uv, N, Z, uvScale), 0.0).rgb;
    rgb += 0.125 * t_Input.SampleLevel(s_Input, getUV(uv, P, Z, uvScale), 0.0).rgb;
    rgb += 0.125 * t_Input.SampleLevel(s_Input, getUV(uv, Z, N, uvScale), 0.0).rgb;
    rgb += 0.125 * t_Input.SampleLevel(s_Input, getUV(uv, Z, P, uvScale), 0.0).rgb;
    return rgb;
}

// threshold.comp
[numthreads(8, 8, 1)]
void threshold_cs(uint3 globalId : SV_DispatchThreadID)
{
    if (all(globalId.xy < g_Blur.resolution))
    {
        float2 uv = (float2(globalId.xy) + 0.5) * g_Blur.invResolution;
        float3 rgb = t_Input.SampleLevel(s_Input, uv, 0.0).rgb;
        rgb = 0.2 * max(rgb - 1.0, 0.0);
        u_Output[globalId.xy] = float4(rgb, 1.0);
    }
}

// blur_down.comp: downscale pass. Simple and naive :)
[numthreads(8, 8, 1)]
void blur_down_cs(uint3 globalId : SV_DispatchThreadID)
{
    if (all(globalId.xy < g_Blur.resolution))
    {
        float2 uv = (float2(globalId.xy) + 0.5) * g_Blur.invResolution;
        float3 rgb = bloomBlur(uv, 1.75);
        u_Output[globalId.xy] = float4(rgb, 1.0);
    }
}

// blur_up.comp: upscale pass. Simple and naive :)
[numthreads(8, 8, 1)]
void blur_up_cs(uint3 globalId : SV_DispatchThreadID)
{
    if (all(globalId.xy < g_Blur.resolution))
    {
        float2 uv = (float2(globalId.xy) + 0.5) * g_Blur.invResolution;
        float3 rgb = bloomBlur(uv, 0.875);
        u_Output[globalId.xy] = float4(rgb, 1.0);
    }
}

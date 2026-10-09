/* Copyright (c) 2020-2021, Holochip
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

// Port of Vulkan-Samples' fragment_shading_rate_dynamic compute shader (generate_shading_rate.comp)
// to Donut's bindings: each shading rate texel's rate from the highest frequency content in its
// block of the frequency image, the device's rate closest to the one wanted.

#include <donut/shaders/binding_helpers.hlsli>

// The frequency content of the reduced size pass (two channels, 0 to 255).
VK_IMAGE_FORMAT("rg8ui") RWTexture2D<uint2> u_InputFrequency : register(u0);
// The shading rates: Vulkan's (and D3D12's) encoding, log2(width) << 2 | log2(height).
VK_IMAGE_FORMAT("r8ui") RWTexture2D<uint> u_OutputSamplingRate : register(u1);

// The sample's FrequencyInformation buffer, as pairs: the frequency image's size, the shading rate
// image's, the largest rate's width and height, the number of rates (and padding), then the rates
// (width, height).
StructuredBuffer<uint2> t_Params : register(t0);

[numthreads(8, 8, 1)]
void generate_cs(uint3 globalId : SV_DispatchThreadID)
{
    const uint x0 = globalId.x;
    const uint y0 = globalId.y;
    const uint frameWidth = t_Params[0].x;
    const uint frameHeight = t_Params[0].y;
    const uint outputWidth = t_Params[1].x;
    const uint outputHeight = t_Params[1].y;

    const uint deltaX = max(1, uint(round(float(frameWidth) / float(outputWidth))));
    const uint deltaY = max(1, uint(round(float(frameHeight) / float(outputHeight))));
    if (x0 >= outputWidth || y0 >= outputHeight)
    {
        return;
    }

    float2 maxFreqs = float2(0.0, 0.0);
    for (uint i = 0; i < deltaX; ++i)
    {
        for (uint j = 0; j < deltaY; ++j)
        {
            const int2 coord = int2(deltaX * x0 + i, deltaY * y0 + j);
            const float2 freq = float2(u_InputFrequency[coord]) / 255.0;
            maxFreqs = max(maxFreqs, freq);
        }
    }

    const float2 freqs = min(1.25 * sqrt(maxFreqs), float2(1.0, 1.0));

    const float minRate = 1.0;
    const float maxRate = max(t_Params[2].x, t_Params[2].y);

    const float2 optimalRate = freqs * float2(minRate, minRate) + (1.0 - freqs) * float2(maxRate, maxRate);

    const uint nRates = t_Params[3].x;
    uint optimalRateIndex = 0;
    float currentCost = 1.0 + 2.0 * maxRate * maxRate;
    for (uint r = 0; r < nRates; ++r)
    {
        const uint2 rate = t_Params[4 + r];
        const float cost = (rate.x - optimalRate.x) * (rate.x - optimalRate.x) + (rate.y - optimalRate.y) * (rate.y - optimalRate.y);
        if (cost < currentCost)
        {
            currentCost = cost;
            optimalRateIndex = r;
        }
    }

    const uint optimalRateX = t_Params[4 + optimalRateIndex].x;
    const uint optimalRateY = t_Params[4 + optimalRateIndex].y;
    const uint rateCode = (optimalRateY >> 1) | ((optimalRateX << 1) & 12);
    u_OutputSamplingRate[uint2(x0, y0)] = rateCode;
}

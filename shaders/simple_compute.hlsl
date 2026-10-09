//--------------------------------------------------------------------------------------
// SimpleCompute: the fractal
//
// Copyright (c) Microsoft Corporation. All rights reserved.
//--------------------------------------------------------------------------------------

// The Xbox ATG SimpleComputePC12 sample's compute shader (Assets/fractal.hlsl), drawing a
// Mandelbrot fractal, on Donut's bindings. Port: the constant buffer is push constants (the
// async compute worker sends the latest values with each run), and the root signature goes.

#include <donut/shaders/binding_helpers.hlsli>

struct FractalConstants
{
    float4 g_MaxThreadIter;
    float4 g_Window;
};
DECLARE_PUSH_CONSTANTS(FractalConstants, g_Constants, 0, 0);

VK_IMAGE_FORMAT("rgba8") RWTexture2D<float4> OutputTexture : REGISTER_UAV(0, 0);
Texture2D ColorMapTexture : REGISTER_SRV(0, 0);
SamplerState ColorMapSampler : REGISTER_SAMPLER(0, 0);

[numthreads(8, 8, 1)]
void fractal_cs(uint3 DTid : SV_DispatchThreadID)
{
    const float4 g_MaxThreadIter = g_Constants.g_MaxThreadIter;
    const float4 g_Window = g_Constants.g_Window;

    float2 WindowLocal = ((float2)DTid.xy / g_MaxThreadIter.xy) * float2(1, -1) + float2(-0.5f, 0.5f);
    float2 coord = WindowLocal.xy * g_Window.xy + g_Window.zw;

    uint maxiter = (uint)g_MaxThreadIter.z * 4;
    uint iter = 0;
    float2 constant = coord;
    float2 sq;
    do
    {
        float2 newvalue;
        sq = coord * coord;
        newvalue.x = sq.x - sq.y;
        newvalue.y = 2 * coord.y * coord.x;
        coord = newvalue + constant;
        iter++;
    } while (iter < maxiter && (sq.x + sq.y) < 4.0);

    // The color depends on how exactly the driver divides: on NVIDIA's D3D12 (the sample's) and
    // Vulkan drivers, by an approximate reciprocal, the inside of the set (1200 / 300 = 3.9999998)
    // takes the map's last color; dividing exactly (NVIDIA's D3D11 driver), 4.0, the first one.
    float colorIndex = frac((float)iter / g_MaxThreadIter.z);
    float4 SampledColor = ColorMapTexture.SampleLevel(ColorMapSampler, float2(colorIndex, 0), 0);

    OutputTexture[DTid.xy] = SampledColor;
}

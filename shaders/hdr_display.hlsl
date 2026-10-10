// DirectX-Graphics-Samples' D3D12HDR shaders (gradientVS/PS, paletteVS/PS, presentVS/PS,
// color.hlsli): an SDR [0, 1] and an HDR [0, 9] gradient and the Rec.709 and Rec.2020 gamuts drawn
// linearly into a float target, then presented with the display's curve (sRGB, ST.2084 after a
// Rec.709 to Rec.2020 conversion, or linear for scRGB), the UI layer composed over the scene.
//
// The sample's root constants (b0: the reference white's nits, the display curve) are push
// constants here, the curve a float (both are floats in one block); its vector ternaries select()s,
// as HLSL 2021 has them.
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).

#include <donut/shaders/binding_helpers.hlsli>

#define DISPLAY_CURVE_SRGB      0
#define DISPLAY_CURVE_ST2084    1
#define DISPLAY_CURVE_LINEAR    2

struct RootConstants
{
    float standardNits;     // The reference brightness level of the display.
    float displayCurve;     // The expected format of the output signal.
};

DECLARE_PUSH_CONSTANTS(RootConstants, g_RootConstants, 0, 0);

Texture2D g_scene : register(t0);
Texture2D g_ui : register(t1);
SamplerState g_sampler : register(s0);


/////
// color.hlsli

float3 xyYToRec709(float2 xy, float Y = 1.0)
{
    // https://github.com/ampas/aces-dev/blob/v1.0.3/transforms/ctl/README-MATRIX.md
    static const float3x3 XYZtoRGB =
    {
        3.2409699419, -1.5373831776, -0.4986107603,
        -0.9692436363, 1.8759675015, 0.0415550574,
        0.0556300797, -0.2039769589, 1.0569715142
    };
    float3 XYZ = Y * float3(xy.x / xy.y, 1.0, (1.0 - xy.x - xy.y) / xy.y);
    float3 RGB = mul(XYZtoRGB, XYZ);
    float maxChannel = max(RGB.r, max(RGB.g, RGB.b));
    return RGB / max(maxChannel, 1.0);
}

float3 LinearToSRGB(float3 color)
{
    // Approximately pow(color, 1.0 / 2.2)
    return select(color < 0.0031308, 12.92 * color, 1.055 * pow(abs(color), 1.0 / 2.4) - 0.055);
}

float3 SRGBToLinear(float3 color)
{
    // Approximately pow(color, 2.2)
    return select(color < 0.04045, color / 12.92, pow(abs(color + 0.055) / 1.055, 2.4));
}

float3 Rec709ToRec2020(float3 color)
{
    static const float3x3 conversion =
    {
        0.627402, 0.329292, 0.043306,
        0.069095, 0.919544, 0.011360,
        0.016394, 0.088028, 0.895578
    };
    return mul(conversion, color);
}

float3 LinearToST2084(float3 color)
{
    float m1 = 2610.0 / 4096.0 / 4;
    float m2 = 2523.0 / 4096.0 * 128;
    float c1 = 3424.0 / 4096.0;
    float c2 = 2413.0 / 4096.0 * 32;
    float c3 = 2392.0 / 4096.0 * 32;
    float3 cp = pow(abs(color), m1);
    return pow((c1 + c2 * cp) / (1 + c3 * cp), m2);
}


/////
// The gradients

struct GradientPSInput
{
    float4 position : SV_POSITION;
    float4 color : COLOR;
};

GradientPSInput GradientVS(float4 position : POSITION, float4 color : COLOR)
{
    GradientPSInput result;
    result.position = position;
    result.color = color;
    return result;
}

float4 GradientPS(GradientPSInput input) : SV_TARGET
{
    // This draws a perceptual gradient rather than a linear gradient.
    return float4(pow(abs(input.color.rgb), 2.2), input.color.a);
}


/////
// The gamut triangles

struct UVPSInput
{
    float4 position : SV_POSITION;
    float2 uv : TEXCOORD;
};

UVPSInput PaletteVS(float4 position : POSITION, float2 uv : TEXCOORD)
{
    UVPSInput result;
    result.position = position;
    result.uv = uv;
    return result;
}

float4 PalettePS(UVPSInput input) : SV_TARGET
{
    // The triangle stores the data in CIE xyY color space. We convert the data to RGB format in Rec709 RGB color space.
    return float4(xyYToRec709(input.uv), 1.0);
}


/////
// Presenting

UVPSInput PresentVS(float4 position : POSITION, float2 uv : TEXCOORD)
{
    UVPSInput result;
    result.position = position;
    result.uv = uv;
    return result;
}

float4 PresentPS(UVPSInput input) : SV_TARGET
{
    // The scene, including brightness bars and color palettes, is rendered with linear gamma and Rec.709 primaries. (DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709)
    float3 scene = g_scene.Sample(g_sampler, input.uv).rgb;

    // Direct2D renders the UI layer with gamma 2.2 in Rec.709 primaries. (DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, known as sRGB)
    float4 uiLayer = g_ui.Sample(g_sampler, input.uv);
    // Direct2D's white text is premultiplied, its color as opaque as its coverage; ImGui's blending
    // leaves the texture's alpha below its color: take the larger, as Direct2D's alpha.
    uiLayer.a = max(uiLayer.a, max(uiLayer.r, max(uiLayer.g, uiLayer.b)));

    // Compose the scene and UI layers. Note that we convert UI layer from gamma 2.2 to to linear gamma before composing so both UI layers and the scene are with linear gamma and Rec.709 primaries.
    float3 result = lerp(scene, SRGBToLinear(uiLayer.rgb), uiLayer.a);

    uint displayCurve = uint(g_RootConstants.displayCurve);
    if (displayCurve == DISPLAY_CURVE_SRGB)
    {
        result = LinearToSRGB(result);
    }
    else if (displayCurve == DISPLAY_CURVE_ST2084)
    {
        const float st2084max = 10000.0;
        const float hdrScalar = g_RootConstants.standardNits / st2084max;

        // The HDR scene is in Rec.709, but the display is Rec.2020
        result = Rec709ToRec2020(result);

        // Apply the ST.2084 curve to the scene.
        result = LinearToST2084(result * hdrScalar);
    }
    else // displayCurve == DISPLAY_CURVE_LINEAR
    {
        // Just pass through
    }

    return float4(result, 1.0);
}

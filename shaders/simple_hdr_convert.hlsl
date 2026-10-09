//--------------------------------------------------------------------------------------
// SimpleHDR: the HDR scene to the back buffer
//
// Advanced Technology Group (ATG)
// Copyright (C) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
//--------------------------------------------------------------------------------------

// Port of the Xbox ATG SimpleHDR_PC12 sample's PrepareSwapChainBuffersPS.hlsl and ToneMapSDRPS.hlsl,
// with the ATG kit's FullScreenQuadVS.hlsl and the HDRCommon.hlsli functions they use, to Donut's
// bindings (root signature left out, the HDR10Data constant buffer as push constants, the static
// point sampler bound at s0). The sample's HDR scene is opaque everywhere (SpriteBatch's alpha
// blending keeps a destination alpha of 1), so the back buffer's alpha is 1; ImGui's text blending
// changes the HDR scene's alpha here, so the back buffer gets 1 explicitly.

#include <donut/shaders/binding_helpers.hlsli>

// --- HDRCommon.hlsli -----------------------------------------------------------------------

// The ST.2084 spec defines max nits as 10,000 nits
static const float g_MaxNitsFor2084 = 10000.0f;

// Color rotation matrix to rotate Rec.709 color primaries into Rec.2020
static const float3x3 from709to2020 =
{
    { 0.6274040f, 0.3292820f, 0.0433136f },
    { 0.0690970f, 0.9195400f, 0.0113612f },
    { 0.0163916f, 0.0880132f, 0.8955950f }
};

// Calculates the normalized non-linear ST.2084 value given a normalized linear value
float3 LinearToST2084(float3 normalizedLinearValue)
{
    float3 ST2084 = pow((0.8359375f + 18.8515625f * pow(abs(normalizedLinearValue), 0.1593017578f)) / (1.0f + 18.6875f * pow(abs(normalizedLinearValue), 0.1593017578f)), 78.84375f);
    return ST2084;  // Don't clamp between [0..1], so we can still perform operations on scene values higher than 10,000 nits
}

// Normalizes HDR scene values (1.0 = paper white) for the ST.2084 curve (1.0 = 10,000 nits)
float3 NormalizeHDRSceneValue(float3 hdrSceneValue, float paperWhiteNits)
{
    float3 normalizedLinearValue = hdrSceneValue * paperWhiteNits / g_MaxNitsFor2084;
    return normalizedLinearValue;       // Don't clamp between [0..1], so we can still perform operations on scene values higher than 10,000 nits
}

// Convert linear HDR values to HDR10
float4 ConvertToHDR10(float4 hdrSceneValue, float paperWhiteNits)
{
    float3 rec2020 = mul(from709to2020, hdrSceneValue.rgb);                             // Rotate Rec.709 color primaries into Rec.2020 color primaries
    float3 normalizedLinearValue = NormalizeHDRSceneValue(rec2020, paperWhiteNits);     // Normalize using paper white nits to prepare for ST.2084
    float3 HDR10 = LinearToST2084(normalizedLinearValue);                               // Apply ST.2084 curve
    return float4(HDR10.rgb, hdrSceneValue.a);
}

// --- FullScreenQuad ------------------------------------------------------------------------

struct HDR10Data
{
    float PaperWhiteNits;                           // Defines how bright white is (in nits), which controls how bright the SDR range in the image will be, e.g. 200 nits
};
DECLARE_PUSH_CONSTANTS(HDR10Data, g_HDR10Data, 0, 0);

SamplerState PointSampler : register(s0);
Texture2D<float4> Texture : register(t0);

struct Interpolators
{
    float4 Position : SV_Position;
    float2 TexCoord : TEXCOORD0;
};

Interpolators quad_vs(uint vI : SV_VertexId)
{
    Interpolators output;

    // We use the 'big triangle' optimization so you only Draw 3 verticies instead of 4.
    float2 texcoord = float2((vI << 1) & 2, vI & 2);
    output.TexCoord = texcoord;
    output.Position = float4(texcoord.x * 2 - 1, -texcoord.y * 2 + 1, 0, 1);

    return output;
}

// --- PrepareSwapChainBuffersPS.hlsl --------------------------------------------------------

// Prepare the HDR swapchain buffer as HDR10. This means the buffer has to contain data which uses
//  - Rec.2020 color primaries
//  - Quantized using ST.2084 curve
//  - 10-bit per channel
float4 prepare_hdr10_ps(Interpolators In) : SV_Target0
{
    // Input is linear values using sRGB / Rec.709 color primaries
    float4 hdrSceneValues = Texture.Sample(PointSampler, In.TexCoord);

    return float4(ConvertToHDR10(hdrSceneValues, g_HDR10Data.PaperWhiteNits).rgb, 1.0);
}

// --- ToneMapSDRPS.hlsl ---------------------------------------------------------------------

// Very simple HDR to SDR tonemapping, which simply clips values above 1.0f from the HDR scene.
float4 tonemap_sdr_ps(Interpolators In) : SV_Target0
{
    // Input is linear values using sRGB / Rec.709 color primaries
    float4 hdrSceneValues = Texture.Sample(PointSampler, In.TexCoord);

    return float4(saturate(hdrSceneValues.rgb), 1.0);
}

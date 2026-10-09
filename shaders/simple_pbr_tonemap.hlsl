//--------------------------------------------------------------------------------------
// SimplePBR: tone mapping
//
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//--------------------------------------------------------------------------------------

// DirectXTK's ToneMapPostProcess (ToneMap.fx, Utilities.fxh) as the Xbox ATG SimplePBR12_UWP sample
// uses it: ACES filmic with the estimated sRGB curve for an SDR signal, Rec.709 to Rec.2020 and
// ST.2084 (no tone mapping) for HDR10, on Donut's bindings.

Texture2D<float4> HDRTexture : register(t0);
sampler Sampler : register(s0);

cbuffer Parameters : register(b0)
{
    float linearExposure;     // c0.x
    float paperWhiteNits;     // c0.y
    float4x3 colorRotation;   // c1
};

struct VSInputTx
{
    float2 TexCoord : TEXCOORD0;
    float4 Position : SV_Position;
};

// --- Utilities.fxh ---------------------------------------------------------------------------

// sRGB, approximated
float3 LinearToSRGBEst(float3 color)
{
    return pow(abs(color), 1/2.2f);
}

// Apply the ST.2084 curve to normalized linear values and outputs normalized non-linear values
float3 LinearToST2084(float3 normalizedLinearValue)
{
    return pow((0.8359375f + 18.8515625f * pow(abs(normalizedLinearValue), 0.1593017578f)) / (1.0f + 18.6875f * pow(abs(normalizedLinearValue), 0.1593017578f)), 78.84375f);
}

// ACES Filmic tonemap operator
// https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/
float3 ToneMapACESFilmic(float3 x)
{
    float a = 2.51f;
    float b = 0.03f;
    float c = 2.43f;
    float d = 0.59f;
    float e = 0.14f;
    return saturate((x*(a*x+b))/(x*(c*x+d)+e));
}

// --- ToneMap.fx ------------------------------------------------------------------------------

// Vertex shader: self-created quad.
VSInputTx quad_vs(uint vI : SV_VertexId)
{
    VSInputTx vout;

    // We use the 'big triangle' optimization so you only Draw 3 verticies instead of 4.
    float2 texcoord = float2((vI << 1) & 2, vI & 2);
    vout.TexCoord = texcoord;

    vout.Position = float4(texcoord.x * 2 - 1, -texcoord.y * 2 + 1, 0, 1);
    return vout;
}

// Pixel shader: ACES filmic operator
float4 aces_filmic_srgb_ps(VSInputTx pin) : SV_Target0
{
    float4 hdr = HDRTexture.Sample(Sampler, pin.TexCoord);
    float3 sdr = ToneMapACESFilmic(hdr.xyz * linearExposure);
    float3 srgb = LinearToSRGBEst(sdr);
    return float4(srgb, hdr.a);
}

// HDR10, using Rec.2020 color primaries and ST.2084 curve
float3 HDR10(float3 color)
{
    // Rotate from Rec.709 to Rec.2020 primaries
    float3 rgb = mul(color, (float3x3)colorRotation);

    // ST.2084 spec defines max nits as 10,000 nits
    float3 normalized = rgb * paperWhiteNits / 10000.f;

    // Apply ST.2084 curve
    return LinearToST2084(normalized);
}

float4 hdr10_ps(VSInputTx pin) : SV_Target0
{
    float4 hdr = HDRTexture.Sample(Sampler, pin.TexCoord);
    float3 rgb = HDR10(hdr.xyz);
    return float4(rgb, hdr.a);
}

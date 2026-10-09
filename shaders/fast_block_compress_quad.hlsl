//--------------------------------------------------------------------------------------
// FastBlockCompress: image display
//
// Advanced Technology Group (ATG)
// Copyright (C) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
//--------------------------------------------------------------------------------------

// Port of the Xbox ATG FastBlockCompress sample's QuadWithCamera.hlsl and the ATG kit's
// FullScreenQuadVS.hlsl to Donut's bindings (root signature left out, the constant buffer as push
// constants, the static point sampler bound at s0). Change: the sample's quad samples level
// g_mipLevel of a view that already starts at that level (so level 2 x g_mipLevel, while its RMS
// error is of level g_mipLevel); here the view has all levels.

#include <donut/shaders/binding_helpers.hlsli>

// Reconstruct the Z component of a normal map
float ReconstructZ(float2 v)
{
    v = v * 2 - 1;
    float z = sqrt(max(0, 1 - dot(v, v)));

    return 0.5f*(z + 1);
}

// --- FullScreenQuadVS.hlsl -----------------------------------------------------------------

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

// --- QuadWithCamera.hlsl -------------------------------------------------------------------

struct QuadWithCameraConstants
{
    float oneOverZoom;
    float offsetX;
    float offsetY;
    float textureWidth;
    float textureHeight;
    uint mipLevel;
    uint highlightBlocks;
    uint colorDiffs;
    uint alphaDiffs;
    uint reconstructZ;
};
DECLARE_PUSH_CONSTANTS(QuadWithCameraConstants, g_Quad, 0, 0);

SamplerState    PointSampler : register(s0);
Texture2D       g_tex : register(t0);
Texture2D       g_originalTex : register(t1);

static const float g_diffsScale = 10.0f;

// Convert from UV to texel coordinates
uint2 UVToTexel(float2 uv)
{
    return int2(uv.x * g_Quad.textureWidth, uv.y * g_Quad.textureHeight);
}

//--------------------------------------------------------------------------------------
// Shader entry point
//--------------------------------------------------------------------------------------
float4 quad_ps(Interpolators In) : SV_Target
{
    float2 texCoord = In.TexCoord * g_Quad.oneOverZoom;
    texCoord += float2(g_Quad.offsetX, g_Quad.offsetY);

    // If desired, highlight block boundaries
    if (g_Quad.highlightBlocks)
    {
        uint2 prevBlock = UVToTexel(texCoord - float2(ddx(texCoord.x), ddy(texCoord.y))) / 4;
        uint2 currBlock = UVToTexel(texCoord) / 4;

        if (currBlock.x != prevBlock.x || currBlock.y != prevBlock.y)
        {
            return float4(1.0f, 0.0f, 1.0f, 1.0f);
        }
    }

    float4 texelColor = g_tex.SampleLevel(PointSampler, texCoord, g_Quad.mipLevel);
    if (g_Quad.reconstructZ) texelColor.z = ReconstructZ(texelColor.xy);

    if (g_Quad.colorDiffs)
    {
        float4 originalTexelColor = g_originalTex.SampleLevel(PointSampler, texCoord, g_Quad.mipLevel);
        float4 diff = g_diffsScale * abs(texelColor - originalTexelColor);

        return float4(diff.rgb, 1.0f);
    }
    else if (g_Quad.alphaDiffs)
    {
        float4 originalTexelColor = g_originalTex.SampleLevel(PointSampler, texCoord, g_Quad.mipLevel);
        float4 diff = g_diffsScale * abs(texelColor - originalTexelColor);

        return float4(diff.aaa, 1.0f);
    }

    // Draw a checkerboard in alpha areas
    const float numCheckers = 32;
    int2 checker = trunc(fmod(In.TexCoord * numCheckers, 2));
    float3 checkerColor = (checker.x ^ checker.y) * 1.f;

    return float4(lerp(checkerColor.rgb, texelColor.rgb, texelColor.a), 1.0f);
}

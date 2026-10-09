//--------------------------------------------------------------------------------------
// Bokeh: the scene
//
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//--------------------------------------------------------------------------------------

// The Xbox ATG Bokeh12 sample draws its SDKMESH models with the BasicEffect DirectXTK's
// EffectFactory makes for their materials: per-pixel lighting (EnableDefaultLighting) and a
// texture. These are its VSBasicPixelLightingTx and PSBasicPixelLightingTx on Donut's bindings.

// --- BasicEffect.fx: VSBasicPixelLightingTx, PSBasicPixelLightingTx ---------------------------

// BasicEffect's constant buffer with row-major matrices for mul(vector, matrix) (DirectXMath's
// layout); fog disabled.
cbuffer Parameters : register(b0)
{
    float4 DiffuseColor;
    float3 EmissiveColor;
    float padding0;
    float3 SpecularColor;
    float SpecularPower;

    float4 LightDirection[3];
    float4 LightDiffuseColor[3];
    float4 LightSpecularColor[3];

    float3 EyePosition;
    float padding1;

    row_major float4x4 World;
    row_major float4x4 WorldInverseTranspose;
    row_major float4x4 WorldViewProj;
};

Texture2D Texture : register(t0);
SamplerState Sampler : register(s0);

// The models' vertices (position, normal, texture coordinates), as DirectXTK's input layout for
// their declaration reads them.
struct VSInputNmTx
{
    float4 Position : POSITION;
    float3 Normal   : NORMAL;
    float2 TexCoord : TEXCOORD0;
};

struct VSOutputPixelLightingTx
{
    float2 TexCoord   : TEXCOORD0;
    float4 PositionWS : TEXCOORD1;
    float3 NormalWS   : TEXCOORD2;
    float4 Diffuse    : COLOR0;
    float4 PositionPS : SV_Position;
};

// Port: the sample's models have no normals (all zero), which is why it makes every effect
// emissive. On the Xbox the zero normals come out of normalize() as zero (its reciprocal square
// root clamps), so they light nothing; on PC normalize(0) is NaN, which would poison every pixel.
// This normalize gives the Xbox's zero.
float3 NormalizeOrZero(float3 v)
{
    float lengthSq = dot(v, v);
    return lengthSq > 0 ? v * rsqrt(lengthSq) : 0;
}

struct ColorPair
{
    float3 Diffuse;
    float3 Specular;
};

ColorPair ComputeLights(float3 eyeVector, float3 worldNormal, uniform int numLights)
{
    float3x3 lightDirections = 0;
    float3x3 lightDiffuse = 0;
    float3x3 lightSpecular = 0;
    float3x3 halfVectors = 0;

    [unroll]
    for (int i = 0; i < numLights; i++)
    {
        lightDirections[i] = LightDirection[i].xyz;
        lightDiffuse[i]    = LightDiffuseColor[i].xyz;
        lightSpecular[i]   = LightSpecularColor[i].xyz;

        halfVectors[i] = normalize(eyeVector - lightDirections[i]);
    }

    float3 dotL = mul(-lightDirections, worldNormal);
    float3 dotH = mul(halfVectors, worldNormal);

    float3 zeroL = step(0, dotL);

    float3 diffuse  = zeroL * dotL;
    float3 specular = pow(max(dotH, 0) * zeroL, SpecularPower) * dotL;

    ColorPair result;

    result.Diffuse  = mul(diffuse,  lightDiffuse)  * DiffuseColor.rgb + EmissiveColor;
    result.Specular = mul(specular, lightSpecular) * SpecularColor;

    return result;
}

VSOutputPixelLightingTx scene_vs(VSInputNmTx vin)
{
    VSOutputPixelLightingTx vout;

    // ComputeCommonVSOutputPixelLighting (no fog: its factor is 0)
    vout.PositionPS = mul(vin.Position, WorldViewProj);
    vout.PositionWS = float4(mul(vin.Position, World).xyz, 0);
    vout.NormalWS = NormalizeOrZero(mul(vin.Normal, (float3x3)WorldInverseTranspose));

    vout.Diffuse = float4(1, 1, 1, DiffuseColor.a);
    vout.TexCoord = vin.TexCoord;

    return vout;
}

float4 scene_ps(VSOutputPixelLightingTx pin) : SV_Target0
{
    float4 color = Texture.Sample(Sampler, pin.TexCoord) * pin.Diffuse;

    float3 eyeVector = normalize(EyePosition - pin.PositionWS.xyz);
    float3 worldNormal = NormalizeOrZero(pin.NormalWS);

    ColorPair lightResult = ComputeLights(eyeVector, worldNormal, 3);

    color.rgb *= lightResult.Diffuse;

    // AddSpecular
    color.rgb += lightResult.Specular * color.a;

    return color;
}

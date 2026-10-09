//--------------------------------------------------------------------------------------
// VideoTexture: the textured cube and the video sprite
//
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//--------------------------------------------------------------------------------------

// The Xbox ATG VideoTexturePC12 sample draws a cube with DirectXTK's BasicEffect (vertex lighting,
// EnableDefaultLighting, a texture: VSBasicVertexLightingTx and PSBasicVertexLightingTxNoFog) and the
// video with SpriteBatch. These are their shaders on Donut's bindings: BasicEffect's constant buffer
// with row-major matrices for mul(vector, matrix) (DirectXMath's layout), the cube's vertices read
// from a buffer, the sprite's rectangle in pixels as push constants.

#include <donut/shaders/binding_helpers.hlsli>

#pragma pack_matrix(row_major)

// --- BasicEffect.fx ------------------------------------------------------------------------

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

    float4x4 World;
    float4x4 WorldInverseTranspose;
    float4x4 WorldViewProj;
};

// GeometricPrimitive's VertexPositionNormalTexture: float3 position, float3 normal, float2 uv.
ByteAddressBuffer t_Vertices : register(t0);
Texture2D Texture : register(t1);
SamplerState Sampler : register(s0);

struct VSOutputTx
{
    float4 Diffuse    : COLOR0;
    float4 Specular   : COLOR1;
    float2 TexCoord   : TEXCOORD0;
    float4 PositionPS : SV_Position;
};

// --- Lighting.fxh --------------------------------------------------------------------------

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

// --- BasicEffect.fx: VSBasicVertexLightingTx, PSBasicVertexLightingTxNoFog ------------------

VSOutputTx cube_vs(uint vertexID : SV_VertexID)
{
    const uint address = vertexID * 32;
    float4 position = float4(asfloat(t_Vertices.Load3(address)), 1.0);
    float3 normal = asfloat(t_Vertices.Load3(address + 12));
    float2 texCoord = asfloat(t_Vertices.Load2(address + 24));

    // ComputeCommonVSOutputWithLighting
    float4 pos_ws = mul(position, World);
    float3 eyeVector = normalize(EyePosition - pos_ws.xyz);
    float3 worldNormal = normalize(mul(normal, (float3x3)WorldInverseTranspose));

    ColorPair lightResult = ComputeLights(eyeVector, worldNormal, 3);

    VSOutputTx vout;
    vout.PositionPS = mul(position, WorldViewProj);
    vout.Diffuse = float4(lightResult.Diffuse, DiffuseColor.a);
    vout.Specular = float4(lightResult.Specular, 0.0);
    vout.TexCoord = texCoord;
    return vout;
}

float4 cube_ps(VSOutputTx pin) : SV_Target0
{
    float4 color = Texture.Sample(Sampler, pin.TexCoord) * pin.Diffuse;

    // AddSpecular
    color.rgb += pin.Specular.rgb * color.a;

    return color;
}

// --- SpriteBatch ----------------------------------------------------------------------------

struct SpriteConstants
{
    // The destination rectangle in pixels: left, top, right, bottom.
    float4 rect;
    // The target's size in pixels.
    float2 targetSize;
    float2 padding;
};
DECLARE_PUSH_CONSTANTS(SpriteConstants, g_Sprite, 1, 0);

struct SpriteOutput
{
    float2 TexCoord : TEXCOORD0;
    float4 Position : SV_Position;
};

// Two triangles over the rectangle; SpriteBatch's viewport transform: x * 2 / width - 1.
SpriteOutput sprite_vs(uint vertexID : SV_VertexID)
{
    static const float2 corners[6] = { float2(0, 0), float2(1, 0), float2(0, 1), float2(1, 0), float2(1, 1), float2(0, 1) };
    float2 corner = corners[vertexID];
    float2 pixels = lerp(g_Sprite.rect.xy, g_Sprite.rect.zw, corner);
    SpriteOutput output;
    output.TexCoord = corner;
    output.Position = float4(pixels.x * (2.0 / g_Sprite.targetSize.x) - 1.0, pixels.y * (-2.0 / g_Sprite.targetSize.y) + 1.0, 0.0, 1.0);
    return output;
}

// SpriteEffect's pixel shader with white sprites: the texture.
float4 sprite_ps(SpriteOutput input) : SV_Target0
{
    return Texture.Sample(Sampler, input.TexCoord);
}

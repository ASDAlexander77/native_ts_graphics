//--------------------------------------------------------------------------------------
// MouseCursor: sprites and the models' effects
//
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//--------------------------------------------------------------------------------------

// The Xbox ATG MouseCursor UWP sample draws its menu with SpriteBatch and its SDKMESH models with
// the effects DirectXTK's (D3D11) EffectFactory makes for their materials: DualTextureEffect for
// the FPS room (two texture coordinates: a texture and a light map), BasicEffect with vertex
// lighting (EnableDefaultLighting) and a texture for the RTS map. These are SpriteBatch's shaders
// and the effects' VSDualTextureNoFog / PSDualTextureNoFog and VSBasicVertexLightingTx /
// PSBasicVertexLightingTxNoFog on Donut's bindings.

#include <donut/shaders/binding_helpers.hlsli>

// --- SpriteBatch -----------------------------------------------------------------------------

// A sprite: its destination rectangle and the render target's size in pixels, its color.
struct SpriteConstants
{
    float4 rect;        // left, top, right, bottom
    float2 targetSize;
    float2 padding;
    float4 color;
};
DECLARE_PUSH_CONSTANTS(SpriteConstants, g_Sprite, 0, 0);

Texture2D SpriteTexture : REGISTER_SRV(0, 0);
SamplerState SpriteSampler : REGISTER_SAMPLER(0, 0);

struct SpriteVertex
{
    float4 color    : COLOR0;
    float2 texCoord : TEXCOORD0;
    float4 position : SV_Position;
};

// The sprite's quad as two triangles (6 vertices), positions transformed as SpriteBatch's
// viewport transform does (x * 2 / width - 1, 1 - y * 2 / height).
SpriteVertex sprite_vs(uint vertexID : SV_VertexID)
{
    const float2 corners[6] = { float2(0, 0), float2(1, 0), float2(0, 1), float2(1, 0), float2(1, 1), float2(0, 1) };
    float2 corner = corners[vertexID];
    float2 position = lerp(g_Sprite.rect.xy, g_Sprite.rect.zw, corner);

    SpriteVertex output;
    output.color = g_Sprite.color;
    output.texCoord = corner;
    output.position = float4(position.x * (2.0 / g_Sprite.targetSize.x) - 1.0, 1.0 - position.y * (2.0 / g_Sprite.targetSize.y), 0, 1);
    return output;
}

// SpriteEffect's SpritePixelShader.
float4 sprite_ps(SpriteVertex input) : SV_Target0
{
    return SpriteTexture.Sample(SpriteSampler, input.texCoord) * input.color;
}

// --- The models' effects -----------------------------------------------------------------------

// The effects' constants with row-major matrices for mul(vector, matrix) (DirectXMath's layout):
// DiffuseColor, EmissiveColor, SpecularColor and SpecularPower, the three lights' directions,
// diffuse and specular colors, EyePosition, World, WorldInverseTranspose, WorldViewProj (fog
// disabled). DualTextureEffect reads DiffuseColor and WorldViewProj.
cbuffer Parameters : REGISTER_CBUFFER(0, 0)
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

Texture2D<float4> Texture  : REGISTER_SRV(0, 0);
Texture2D<float4> Texture2 : REGISTER_SRV(1, 0);
SamplerState Sampler  : REGISTER_SAMPLER(0, 0);

// DualTextureEffect.fx: VSDualTextureNoFog, PSDualTextureNoFog. The FPS room's vertices:
// position, normal, two texture coordinates, tangent, binormal (64 bytes). Port: the second
// texture coordinates have a name of their own (Donut's input layouts give no semantic indices).
struct VSInputTx2
{
    float4 Position  : POSITION;
    float2 TexCoord  : TEXCOORD0;
    float2 TexCoord2 : LIGHTMAPCOORD;
};

struct VSOutputTx2NoFog
{
    float4 Diffuse    : COLOR0;
    float2 TexCoord   : TEXCOORD0;
    float2 TexCoord2  : TEXCOORD1;
    float4 PositionPS : SV_Position;
};

VSOutputTx2NoFog dual_texture_vs(VSInputTx2 vin)
{
    VSOutputTx2NoFog vout;

    // ComputeCommonVSOutput; SetCommonVSOutputParamsNoFog
    vout.PositionPS = mul(vin.Position, WorldViewProj);
    vout.Diffuse = DiffuseColor;

    vout.TexCoord = vin.TexCoord;
    vout.TexCoord2 = vin.TexCoord2;

    return vout;
}

float4 dual_texture_ps(VSOutputTx2NoFog pin) : SV_Target0
{
    float4 color = Texture.Sample(Sampler, pin.TexCoord);
    float4 overlay = Texture2.Sample(Sampler, pin.TexCoord2);

    color.rgb *= 2;
    color *= overlay * pin.Diffuse;

    return color;
}

// BasicEffect.fx: VSBasicVertexLightingTx, PSBasicVertexLightingTxNoFog. The RTS map's vertices:
// position, normal, texture coordinates, tangent, binormal (56 bytes).
struct VSInputNmTx
{
    float4 Position : POSITION;
    float3 Normal   : NORMAL;
    float2 TexCoord : TEXCOORD0;
};

struct VSOutputTx
{
    float4 Diffuse    : COLOR0;
    float4 Specular   : COLOR1;
    float2 TexCoord   : TEXCOORD0;
    float4 PositionPS : SV_Position;
};

struct ColorPair
{
    float3 Diffuse;
    float3 Specular;
};

// Lighting.fxh
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

VSOutputTx basic_vs(VSInputNmTx vin)
{
    VSOutputTx vout;

    // ComputeCommonVSOutputWithLighting (no fog: its factor is 0)
    float4 pos_ws = mul(vin.Position, World);
    float3 eyeVector = normalize(EyePosition - pos_ws.xyz);
    float3 worldNormal = normalize(mul(vin.Normal, (float3x3)WorldInverseTranspose));

    ColorPair lightResult = ComputeLights(eyeVector, worldNormal, 3);

    vout.PositionPS = mul(vin.Position, WorldViewProj);
    vout.Diffuse = float4(lightResult.Diffuse, DiffuseColor.a);
    vout.Specular = float4(lightResult.Specular, 0);

    vout.TexCoord = vin.TexCoord;

    return vout;
}

float4 basic_ps(VSOutputTx pin) : SV_Target0
{
    float4 color = Texture.Sample(Sampler, pin.TexCoord) * pin.Diffuse;

    // AddSpecular
    color.rgb += pin.Specular.rgb * color.a;

    return color;
}

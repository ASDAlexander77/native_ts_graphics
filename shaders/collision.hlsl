//--------------------------------------------------------------------------------------
// Collision: debug lines
//
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//--------------------------------------------------------------------------------------

// The Xbox ATG Collision sample draws its objects as lines with DirectXTK's PrimitiveBatch and a
// BasicEffect with vertex colors (no lighting, no texture): BasicEffect.fx's VSBasicVc and
// PSBasicNoFog on Donut's bindings. Port: WorldViewProj comes as push constants.

#include <donut/shaders/binding_helpers.hlsli>

// WorldViewProj, row-major for mul(vector, matrix) (DirectXMath's layout); the world is the
// identity. DiffuseColor is BasicEffect's default (white, opaque).
struct LineConstants
{
    row_major float4x4 worldViewProj;
};
DECLARE_PUSH_CONSTANTS(LineConstants, g_Constants, 0, 0);

// VertexPositionColor.
struct VSInputVc
{
    float4 Position : POSITION;
    float4 Color    : COLOR;
};

struct VSOutputNoFog
{
    float4 Diffuse    : COLOR0;
    float4 PositionPS : SV_Position;
};

VSOutputNoFog line_vs(VSInputVc vin)
{
    VSOutputNoFog vout;

    // ComputeCommonVSOutput (DiffuseColor is white), then the vertex color.
    vout.PositionPS = mul(vin.Position, g_Constants.worldViewProj);
    vout.Diffuse = vin.Color;

    return vout;
}

float4 line_ps(VSOutputNoFog pin) : SV_Target0
{
    return pin.Diffuse;
}

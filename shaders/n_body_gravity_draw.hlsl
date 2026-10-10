// DirectX-Graphics-Samples' D3D12nBodyGravity ParticleDraw.hlsl: the particles drawn as point
// sprites a geometry shader turns into camera-facing quads with a radial gradient, blended
// additively. The sample's constant buffer (cb0: the matrices) is push constants here.
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).

#include <donut/shaders/binding_helpers.hlsli>

struct PosVelo
{
    float4 pos;
    float4 velo;
};

struct VSParticleIn
{
    float4 color    : COLOR;
    uint id         : SV_VERTEXID;
};

struct VSParticleDrawOut
{
    float3 pos      : POSITION;
    float4 color    : COLOR;
};

struct GSParticleDrawOut
{
    float2 tex      : TEXCOORD0;
    float4 color    : COLOR;
    float4 pos      : SV_POSITION;
};

struct PSParticleDrawIn
{
    float2 tex      : TEXCOORD0;
    float4 color    : COLOR;
};

StructuredBuffer<PosVelo> g_bufPosVelo : register(t0);

struct DrawConstants
{
    row_major float4x4 g_mWorldViewProj;
    row_major float4x4 g_mInvView;
};

DECLARE_PUSH_CONSTANTS(DrawConstants, g_drawConstants, 0, 0);

static const float g_fParticleRad = 10.0f;

static const float3 g_positions[4] =
{
    float3(-1, 1, 0),
    float3(1, 1, 0),
    float3(-1, -1, 0),
    float3(1, -1, 0),
};

static const float2 g_texcoords[4] =
{
    float2(0, 0),
    float2(1, 0),
    float2(0, 1),
    float2(1, 1),
};

//
// Vertex shader for drawing the point-sprite particles.
//
VSParticleDrawOut VSParticleDraw(VSParticleIn input)
{
    VSParticleDrawOut output;

    output.pos = g_bufPosVelo[input.id].pos.xyz;

    float mag = g_bufPosVelo[input.id].velo.w / 9;
    output.color = lerp(float4(1.0f, 0.1f, 0.1f, 1.0f), input.color, mag);

    return output;
}

//
// GS for rendering point sprite particles.  Takes a point and turns
// it into 2 triangles.
//
[maxvertexcount(4)]
void GSParticleDraw(point VSParticleDrawOut input[1], inout TriangleStream<GSParticleDrawOut> SpriteStream)
{
    GSParticleDrawOut output;

    // Emit two new triangles.
    for (int i = 0; i < 4; i++)
    {
        float3 position = g_positions[i] * g_fParticleRad;
        position = mul(position, (float3x3)g_drawConstants.g_mInvView) + input[0].pos;
        output.pos = mul(float4(position, 1.0), g_drawConstants.g_mWorldViewProj);

        output.color = input[0].color;
        output.tex = g_texcoords[i];
        SpriteStream.Append(output);
    }
    SpriteStream.RestartStrip();
}

//
// PS for drawing particles. Use the texture coordinates to generate a
// radial gradient representing the particle.
//
float4 PSParticleDraw(PSParticleDrawIn input) : SV_Target
{
    float intensity = 0.5f - length(float2(0.5f, 0.5f) - input.tex);
    intensity = clamp(intensity, 0.0f, 0.5f) * 2.0f;
    return float4(input.color.xyz, intensity);
}

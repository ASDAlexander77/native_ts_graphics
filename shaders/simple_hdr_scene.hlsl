//--------------------------------------------------------------------------------------
// SimpleHDR: the HDR scene's shapes
//
// Advanced Technology Group (ATG)
// Copyright (C) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
//--------------------------------------------------------------------------------------

// The Xbox ATG SimpleHDR_PC12 sample draws its HDR scene's blocks with DirectXTK's SpriteBatch and a
// pixel shader that outputs the sprite's color (ColorPS.hlsl), and its ST.2084 curve with
// PrimitiveBatch lines through BasicEffect (vertex colors, an orthographic projection). These are
// their equivalents on Donut's bindings: rectangles in the sample's 1920x1080 layout stretched over
// the target, lines in pixels of the viewport, both in one color (linear HDR scene values). Pixels
// go to clip space by a scale and offset the TypeScript side computes as SpriteBatch's viewport
// transform and DirectXMath's orthographic projection do (the curve's right edge lands where the
// sample's does, a hair inside the viewport).

#include <donut/shaders/binding_helpers.hlsli>

struct DrawConstants
{
    // Rectangles: left, top, right, bottom in layout pixels.
    float4 rect;
    float4 color;
    // Clip space = pixels * scale + offset.
    float2 scale;
    float2 offset;
};
DECLARE_PUSH_CONSTANTS(DrawConstants, g_Draw, 0, 0);

// The lines' vertices, in pixels of the viewport (y down).
StructuredBuffer<float2> t_LineVertices : register(t0);

float4 ToClip(float2 pixels)
{
    return float4(pixels * g_Draw.scale + g_Draw.offset, 0.0, 1.0);
}

// Two triangles over the rectangle (SpriteBatch's sprite, its destination rectangle).
float4 rect_vs(uint vertexID : SV_VertexID) : SV_Position
{
    static const float2 corners[6] = { float2(0, 0), float2(1, 0), float2(0, 1), float2(1, 0), float2(1, 1), float2(0, 1) };
    float2 corner = corners[vertexID];
    return ToClip(lerp(g_Draw.rect.xy, g_Draw.rect.zw, corner));
}

// A line list (PrimitiveBatch::DrawLine with BasicEffect's
// CreateOrthographicOffCenter(0, width, height, 0, 0, 1) projection).
float4 line_vs(uint vertexID : SV_VertexID) : SV_Position
{
    return ToClip(t_LineVertices[vertexID]);
}

// ColorPS.hlsl: only outputs color.
float4 color_ps() : SV_Target0
{
    return g_Draw.color;
}

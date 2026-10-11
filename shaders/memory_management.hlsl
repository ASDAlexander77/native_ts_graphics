// DirectX-Graphics-Samples' D3D12MemoryManagement shaders (Texture.hlsl, Color.hlsl) for
// examples/memory_management.ts: a screen-space rectangle per draw, textured (an image, modulated
// by a color) or filled with a color, under the sample's orthographic camera. The rectangle's
// corners come from push constants rather than a vertex buffer, in the sample's vertex order.
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).

#include <donut/shaders/binding_helpers.hlsli>

struct Constants
{
    // The rectangle in world units: left, top, right, bottom.
    float4 rect;
    float4 color;
    // The camera: its position (world units), then world units to clip space (x, y).
    float4 camera;
};
DECLARE_PUSH_CONSTANTS(Constants, g_Constants, 0, 0);

Texture2D t_Texture : register(t0);
SamplerState s_Sampler : register(s0);

struct PSInput
{
    float4 position : SV_Position;
    float4 color : COLOR;
    float2 uv : TEXCOORD;
};

// The sample's FillRectangle vertices: top left, bottom right, bottom left, bottom right, top
// left, top right.
PSInput rect_vs(uint vertexId : SV_VertexID)
{
    const float2 corners[6] = { float2(0, 0), float2(1, 1), float2(0, 1), float2(1, 1), float2(0, 0), float2(1, 0) };
    const float2 corner = corners[vertexId];
    const float4 r = g_Constants.rect;
    float2 world = float2(corner.x == 0 ? r.x : r.z, corner.y == 0 ? r.y : r.w);

    PSInput output;
    // Camera::GetViewProjectionMatrix: an orthographic projection of the camera's rectangle (its
    // top at negative y: y grows down the screen).
    output.position = float4((world - g_Constants.camera.xy) * g_Constants.camera.zw, 0.5, 1.0);
    output.color = g_Constants.color;
    output.uv = corner;
    return output;
}

float4 texture_ps(PSInput input) : SV_Target
{
    return t_Texture.Sample(s_Sampler, input.uv) * input.color;
}

float4 color_ps(PSInput input) : SV_Target
{
    return input.color;
}

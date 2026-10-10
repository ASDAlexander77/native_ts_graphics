//*********************************************************
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).
// THIS CODE IS PROVIDED *AS IS* WITHOUT WARRANTY OF
// ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING ANY
// IMPLIED WARRANTIES OF FITNESS FOR A PARTICULAR
// PURPOSE, MERCHANTABILITY, OR NON-INFRINGEMENT.
//
//*********************************************************

// The D3D12SM6WaveIntrinsics sample's magnify.hlsl: its second pass, the first's texture under
// the UI layer, magnified 6 times around the mouse position. One change: the UI layer is Donut's
// ImGui here, whose blending leaves less than its text's coverage in alpha; the sample's D2D
// leaves premultiplied coverage in all four channels, which for its white text is the color's.

cbuffer SceneConstantBuffer : register(b0)
{
    float4x4 orthProjMatrix;
    float2 mousePosition;
    float2 resolution;
    float time;
    uint renderMode;
    uint laneSize;
    float4 padding[10];
};

struct PSInput
{
    float4 position : SV_POSITION;
    float2 uv : TEXCOORD;
};

Texture2D g_texture : register(t0);
Texture2D g_uiLayer : register(t1);
SamplerState g_sampler : register(s0);

PSInput VSMain(float4 position : POSITION, float2 uv : TEXCOORD)
{
    PSInput result;

    result.position = mul(position,orthProjMatrix);
    result.uv = uv;

    return result;
}

float4 PSMain(PSInput input) : SV_TARGET
{
    float aspectRatio = resolution.x / resolution.y;
    float magnifiedFactor = 6.0f;
    float magnifiedAreaSize = 0.05f;
    float magnifiedAreaBorder = 0.005f;

    // check the distance between this pixel and mouse location in UV space. 
    float2 normalizedPixelPos = input.uv;                           
    float2 normalizedMousePos = mousePosition / resolution;         // convert mouse position to uv space.
    float2 diff = abs(normalizedPixelPos - normalizedMousePos);     // distance from this pixel to mouse.

    float4 color = g_texture.Sample(g_sampler, normalizedPixelPos);
    float4 ui = g_uiLayer.Sample(g_sampler, normalizedPixelPos);
    ui.a = max(ui.a, max(ui.r, max(ui.g, ui.b)));

    color = lerp(color, ui, ui.a);

    // if the distance from this pixel to mouse is touching the border of the magnified area, color it as cyan.
    if (diff.x < (magnifiedAreaSize + magnifiedAreaBorder) && diff.y < (magnifiedAreaSize + magnifiedAreaBorder)*aspectRatio)
    {
        color = float4(0.0f, 1.0f, 1.0f, 1.0f);
    }

    // if the distance from this pixel to mouse is inside the magnified area, enable the magnify effect.
    if (diff.x < magnifiedAreaSize && diff.y < magnifiedAreaSize *aspectRatio)
    {
        color = g_texture.Sample(g_sampler, normalizedMousePos + (normalizedPixelPos - normalizedMousePos) / magnifiedFactor);
    }

    return color;
}

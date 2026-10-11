// The D3D12HelloGenericPrograms sample's shaders.hlsl, unchanged: a vertex shader passing
// positions (clip space) and colors through, and two pixel shaders: the color, and the color with
// green at 1. Each is compiled on its own and used as a DXIL library by the generic programs.
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).

struct PSInput
{
    float4 position : SV_POSITION;
    float4 color : COLOR;
};

PSInput VSMain(float4 position : POSITION, float4 color : COLOR)
{
    PSInput result;

    result.position = position;
    result.color = color;

    return result;
}

float4 PSMain(PSInput input) : SV_TARGET
{
    return input.color;
}

float4 PSMain2(PSInput input) : SV_TARGET
{
    return float4(input.color.r, 1, input.color.b, 1);
}


//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).
// THIS CODE IS PROVIDED *AS IS* WITHOUT WARRANTY OF
// ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING ANY
// IMPLIED WARRANTIES OF FITNESS FOR A PARTICULAR
// PURPOSE, MERCHANTABILITY, OR NON-INFRINGEMENT.
//
// Developed by Minigraph
//
// Author:  James Stanard
//
// MiniEngine's Model/Shaders/DepthViewerVS.hlsl (the depth prepass and shadow maps), without its root
// signature attribute.

#include "Common.hlsli"

cbuffer VSConstants : register(b0)
{
    float4x4 WVP;
};

struct VSInput
{
    float3 pos : POSITION;
    float2 uv : TEXCOORD;
};

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv : TexCoord0;
};

VSOutput main(VSInput vsInput)
{
    VSOutput vsOutput;

    vsOutput.pos = mul(WVP, float4(vsInput.pos, 1.0));
    vsOutput.uv = vsInput.uv;

    return vsOutput;
}

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
// MiniEngine's Model/Shaders/DepthViewerPS.hlsl (alpha-tested cutouts in the depth passes): its
// texDiffuse the material's diffuse texture.

#include "Common.hlsli"

struct VSOutput
{
    float4 pos : SV_Position;
    float2 uv : TexCoord0;
};

void main(VSOutput vsOutput)
{
    if (MaterialTexture(0).Sample(defaultSampler, vsOutput.uv).a < 0.5)
        discard;
}

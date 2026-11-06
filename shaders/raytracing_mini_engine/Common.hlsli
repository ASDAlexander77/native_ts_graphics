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
// MiniEngine's Model/Shaders/Common.hlsli for the port (raytracing_mini_engine): its root signature's
// static samplers as NVRHI samplers (the binding layout's s10, s11), and the material's textures as a
// bindless table (every material's diffuse texture at 3 m, specular at 3 m + 1, normal map at 3 m + 2)
// indexed by the draw's material (the root signature's b1 constant, a push constant here).

#ifndef __COMMON_HLSLI__
#define __COMMON_HLSLI__

#pragma warning (disable: 3078)
#pragma warning (disable: 3557)

#ifdef SPIRV
#define VK_BINDING(reg, dset) [[vk::binding(reg, dset)]]
#define VK_PUSH_CONSTANT [[vk::push_constant]]
#else
#define VK_BINDING(reg, dset)
#define VK_PUSH_CONSTANT
#endif

SamplerState defaultSampler : register(s10);
SamplerComparisonState shadowSampler : register(s11);

struct MaterialConstants
{
    uint materialIdx;
};
VK_PUSH_CONSTANT ConstantBuffer<MaterialConstants> g_material : register(b1);

VK_BINDING(0, 1) Texture2D<float4> g_materialTextures[] : register(t0, space1);

Texture2D<float4> MaterialTexture(uint index)
{
    return g_materialTextures[NonUniformResourceIndex(g_material.materialIdx * 3 + index)];
}

#endif // __COMMON_HLSLI__

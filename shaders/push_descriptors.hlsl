// Vulkan-Samples' push_descriptors shaders (cube.vert, cube.frag) in HLSL, for
// examples/push_descriptors.ts: a textured cube, the scene's matrices, the cube's and its texture
// in one descriptor set whose descriptors are pushed into the command buffer with each draw. The
// bindings are the sample's (set 0: 0 and 1 uniform buffers, 2 a combined image sampler), given
// explicitly; SPIR-V only (push descriptors are Vulkan's).
//
// Copyright (c) 2019-2024, Sascha Willems
// SPDX-License-Identifier: Apache-2.0

struct UBOScene
{
    float4x4 projection;
    float4x4 view;
};
[[vk::binding(0, 0)]] ConstantBuffer<UBOScene> uboCamera;

struct UBOModel
{
    float4x4 local;
};
[[vk::binding(1, 0)]] ConstantBuffer<UBOModel> uboModel;

[[vk::binding(2, 0)]] [[vk::combinedImageSampler]] Texture2D t_ColorMap;
[[vk::binding(2, 0)]] [[vk::combinedImageSampler]] SamplerState s_ColorMap;

struct VSOutput
{
    float4 position : SV_Position;
    [[vk::location(0)]] float2 uv : TEXCOORD0;
};

// The cube's position and texture coordinates (its normals, which the sample doesn't use, aren't
// read).
VSOutput cube_vs([[vk::location(0)]] float3 inPos : POSITION, [[vk::location(1)]] float2 inUV : TEXCOORD)
{
    VSOutput output;
    output.uv = inUV;
    output.position = mul(uboCamera.projection, mul(uboCamera.view, mul(uboModel.local, float4(inPos, 1.0))));
    return output;
}

float4 cube_ps(VSOutput input) : SV_Target
{
    return t_ColorMap.Sample(s_ColorMap, input.uv);
}

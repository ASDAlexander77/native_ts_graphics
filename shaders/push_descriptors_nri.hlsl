// Vulkan-Samples' push_descriptors shaders (cube.vert, cube.frag) in HLSL, for
// examples/nri/push_descriptors_nri.ts: push_descriptors.hlsl's, with the registers NRI binds. The
// scene's and the cube's uniform buffers are NRI root descriptors (b0, b1 in space 0: on Vulkan, a
// push descriptor set, vkCmdPushDescriptorSetKHR with each draw); NRI has no combined image
// samplers, so the texture and its sampler are a descriptor set's (t0, s0 in space 1), one per cube.
// SPIR-V only (push descriptors are Vulkan's), as push_descriptors.hlsl.
//
// Copyright (c) 2019-2024, Sascha Willems
// SPDX-License-Identifier: Apache-2.0

struct UBOScene
{
    float4x4 projection;
    float4x4 view;
};
ConstantBuffer<UBOScene> uboCamera : register(b0);

struct UBOModel
{
    float4x4 local;
};
ConstantBuffer<UBOModel> uboModel : register(b1);

Texture2D t_ColorMap : register(t0, space1);
SamplerState s_ColorMap : register(s0, space1);

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

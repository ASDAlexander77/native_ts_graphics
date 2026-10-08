/* Copyright (c) 2025, Arm Limited and Contributors
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 the "License";
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Port of Vulkan-Samples' rasterization_order_attachment_access shaders (fullscreen.vert,
// background.frag, blend.vert/frag). The sample's blending reads the color attachment in the
// fragment shader (dynamic rendering local read), its order across overlapping fragments of a draw
// guaranteed by VK_EXT_rasterization_order_attachment_access. Here the color is a UAV texture of
// the swapchain's bytes (sRGB, packed in a uint): with ROV=1 a rasterizer ordered view (D3D's ROVs,
// Vulkan's fragment shader interlock), with ROV=0 a plain one, each sphere then drawn alone with a
// barrier after it. The TypeScript side gives the sample's projection with clip y negated for
// Donut's y-up clip space.

#include <donut/shaders/binding_helpers.hlsli>

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

#ifndef ROV
#define ROV 0
#endif

struct SceneConstants
{
    float4x4 projection;
    float4x4 view;
    float backgroundGrayscale;
};

cbuffer c_Scene : register(b0)
{
    SceneConstants g_Scene;
};

// The first instance of the draw: SV_InstanceID doesn't count it (Vulkan's gl_InstanceIndex does).
struct DrawConstants
{
    uint baseInstance;
};
DECLARE_PUSH_CONSTANTS(DrawConstants, g_Draw, 1, 0);

#define INSTANCE_COUNT 64
struct Instance
{
    float4x4 model;
    float4 color;
};
StructuredBuffer<Instance> t_Instances : register(t1);

Texture2D t_Background : register(t0);
SamplerState s_Background : register(s0);

// The swapchain's bytes: sRGB-encoded RGBA8, packed. UAVs from u1: on D3D11 they share slots with
// the render targets.
#if ROV
// globallycoherent: DXC marks the image Coherent in SPIR-V, so a fragment inside the interlock sees
// what the one before it wrote (D3D's ROVs are coherent by themselves).
globallycoherent RasterizerOrderedTexture2D<uint> u_Color : register(u1);
#else
RWTexture2D<uint> u_Color : register(u1);
#endif

// --- sRGB, as the sample's swapchain stores and reads its texels ---------------------------------

// Per channel: DXC's HLSL 2021 wants select() for vectors, which FXC doesn't have.
float srgbToLinear(float c)
{
    return (c <= 0.04045) ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}

float linearToSrgb(float c)
{
    c = saturate(c);
    return (c <= 0.0031308) ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

float3 srgbToLinear(float3 c)
{
    return float3(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
}

float3 linearToSrgb(float3 c)
{
    return float3(linearToSrgb(c.r), linearToSrgb(c.g), linearToSrgb(c.b));
}

uint packColor(float3 linearColor, float alpha)
{
    const uint3 rgb = uint3(round(linearToSrgb(linearColor) * 255.0));
    const uint a = uint(round(saturate(alpha) * 255.0));
    return rgb.r | (rgb.g << 8) | (rgb.b << 16) | (a << 24);
}

float3 unpackColor(uint value)
{
    return srgbToLinear(float3(value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF) / 255.0);
}

// --- Background ---------------------------------------------------------------------------------

struct FullscreenVSOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
};

// fullscreen.vert: vertices at (-1,-1), (3,-1), (-1,3) of the sample's clip space (y down).
FullscreenVSOutput fullscreen_vs(uint vertexId : SV_VertexID)
{
    FullscreenVSOutput output;
    output.uv = float2((vertexId << 1) & 2, vertexId & 2);
    const float2 position = output.uv * 2.0 - 1.0;
    output.position = float4(position.x, -position.y, 0.0, 1.0);
    return output;
}

// background.frag, into the color texture.
float4 background_ps(FullscreenVSOutput input) : SV_Target
{
    const float3 color = t_Background.Sample(s_Background, input.uv).rgb * g_Scene.backgroundGrayscale;
    u_Color[uint2(input.position.xy)] = packColor(color, 1.0);
    return 0.0;
}

// --- Blending -----------------------------------------------------------------------------------

struct BlendVSOutput
{
    float4 position : SV_Position;
    float4 color : COLOR;
};

// blend.vert
BlendVSOutput blend_vs(float3 inPos : POSITION, uint instanceId : SV_InstanceID)
{
    const Instance inst = t_Instances[g_Draw.baseInstance + instanceId];
    BlendVSOutput output;
    output.position = mul(mul(mul(float4(inPos, 1.0), inst.model), g_Scene.view), g_Scene.projection);
    output.color = inst.color;
    return output;
}

// blend.frag: reads what is at the pixel (the sample's subpassLoad), blends over it.
float4 blend_ps(BlendVSOutput input) : SV_Target
{
    const uint2 pixel = uint2(input.position.xy);
    const float3 dst = unpackColor(u_Color[pixel]);
    const float4 src = input.color;

    // Alpha blending: src over dst
    const float3 result = src.rgb * src.a + dst * (1.0 - src.a);
    u_Color[pixel] = packColor(result, 1.0);
    return 0.0;
}

// --- To the screen ------------------------------------------------------------------------------

Texture2D<uint> t_Color : register(t2);

// The color texture's texels, decoded (the sRGB back buffer encodes them again).
float4 display_ps(FullscreenVSOutput input) : SV_Target
{
    return float4(unpackColor(t_Color[uint2(input.position.xy)]), 1.0);
}

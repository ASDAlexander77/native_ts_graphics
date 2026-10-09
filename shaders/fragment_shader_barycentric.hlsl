/* Copyright (c) 2023-2025, Mobica Limited
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

// Port of Vulkan-Samples' fragment_shader_barycentric shaders (skybox.vert/frag, object.vert/frag).
// GLSL's gl_BaryCoordEXT and gl_BaryCoordNoPerspEXT are SV_Barycentrics with perspective and
// noperspective interpolation, its pervertexEXT inputs nointerpolation ones read with
// GetAttributeAtVertex (shader model 6.1; DXC compiles both to VK_KHR_fragment_shader_barycentric).
// The TypeScript side gives the sample's projection with clip y negated for Donut's y-up clip space.

#include <donut/shaders/binding_helpers.hlsli>

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

struct UBO
{
    float4x4 projection;
    float4x4 modelview;
};

cbuffer c_UBO : register(b0)
{
    UBO ubo;
};

// The sample's push constants: the selected effect.
struct PushConstants
{
    int type;
};

DECLARE_PUSH_CONSTANTS(PushConstants, pushConstant, 1, 0);

// The skybox's cube map, or the object's texture.
TextureCube t_EnvMap : register(t0);
Texture2D t_ColorMap : register(t0);
SamplerState s_Sampler : register(s0);

// --- Skybox -------------------------------------------------------------------------------------

struct SkyboxVSOutput
{
    float4 position : SV_Position;
    float3 uvw : TEXCOORD0;
};

// skybox.vert
SkyboxVSOutput skybox_vs(float3 inPos : POSITION)
{
    SkyboxVSOutput output;
    output.uvw = inPos;
    output.position = mul(float4(mul(inPos, (float3x3)ubo.modelview), 1.0), ubo.projection);
    return output;
}

// skybox.frag
float4 skybox_ps(SkyboxVSOutput input) : SV_Target
{
    return t_EnvMap.Sample(s_Sampler, input.uvw);
}

// --- Object -------------------------------------------------------------------------------------

struct ObjectVSOutput
{
    float4 position : SV_Position;
    // Not interpolated: the pixel shader reads it at each of the triangle's vertices.
    nointerpolation float3 color : COLOR;
};

static const float3 triangleColors[6] = {
    float3(1.0, 0.0, 0.0),
    float3(0.0, 1.0, 0.0),
    float3(0.0, 0.0, 1.0),
    float3(0.0, 0.0, 1.0),
    float3(0.0, 1.0, 0.0),
    float3(1.0, 0.0, 0.0)
};

// object.vert
ObjectVSOutput object_vs(float3 inPos : POSITION, uint vertexIndex : SV_VertexID)
{
    ObjectVSOutput output;
    output.position = mul(mul(float4(inPos, 1.0), ubo.modelview), ubo.projection);
    output.color = triangleColors[vertexIndex % 6];
    return output;
}

// object.frag
float4 object_ps(ObjectVSOutput input,
    float3 baryCoord : SV_Barycentrics0,
    noperspective float3 baryCoordNoPersp : SV_Barycentrics1) : SV_Target
{
    const float3 inColor[3] = {
        GetAttributeAtVertex(input.color, 0),
        GetAttributeAtVertex(input.color, 1),
        GetAttributeAtVertex(input.color, 2)
    };

    float4 outColor = 0.0;
    switch (pushConstant.type)
    {
        case 0:
        {
            outColor.rgb = inColor[0].rgb * baryCoord.x +
                inColor[1].rgb * baryCoord.y +
                inColor[2].rgb * baryCoord.z;
            outColor.a = 1.0;
            break;
        }
        case 1:
        {
            outColor.rgb = baryCoord - baryCoordNoPersp;
            const float exposure = 10.f;
            outColor = float4(1.0 - exp(-outColor.rgb * exposure), 1.0);
            break;
        }
        case 2:
        {
            if (baryCoord.x < 0.01 || baryCoord.y < 0.01 || baryCoord.z < 0.01)
                outColor = float4(0.0, 0.0, 0.0, 1.0);
            else
                outColor = float4(0.5, 0.5, 0.5, 1.0);
            break;
        }
        case 3:
        {
            if (baryCoord.x <= baryCoord.y && baryCoord.x <= baryCoord.z)
                outColor = float4(inColor[0].rgb * baryCoord.x, 1.0);
            else if (baryCoord.y < baryCoord.x && baryCoord.y <= baryCoord.z)
                outColor = float4(inColor[1].rgb * baryCoord.y, 1.0);
            else
                outColor = float4(inColor[2].rgb * baryCoord.z, 1.0);
            break;
        }
        case 4:
        {
            outColor = t_ColorMap.Sample(s_Sampler, float2(sin(baryCoord.x) + cos(2 * baryCoord.z), sin(baryCoord.x) + cos(2 * baryCoord.y)));
            break;
        }
    }
    return outColor;
}

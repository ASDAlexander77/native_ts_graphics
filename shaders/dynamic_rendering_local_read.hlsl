/* Copyright (c) 2024, Sascha Willems
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

// Port of Vulkan-Samples' dynamic_rendering_local_read shaders (scene_opaque.vert/.frag,
// composition.vert/.frag, scene_transparent.vert/.frag) to Donut's bindings: a G-buffer of the
// opaque scene, its deferred lighting by 64 point lights, then the transparent scene forward. The
// sample reads the G-buffer as input attachments in the same render pass; here they're textures
// read at the pixel in the next pass. The TypeScript side gives the sample's projection with clip
// y negated for Donut's y-up clip space.

#include <donut/shaders/binding_helpers.hlsli>

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

cbuffer UBO : register(b0)
{
    float4x4 g_Projection;
    float4x4 g_Model;
    float4x4 g_View;
};

struct SceneNode
{
    float4x4 nodeMatrix;
    float4 color;
};

DECLARE_PUSH_CONSTANTS(SceneNode, g_SceneNode, 1, 0);

static const float NEAR_PLANE = 0.1f;
static const float FAR_PLANE = 256.0f;

float linearDepth(float depth)
{
    float z = depth * 2.0f - 1.0f;
    return (2.0f * NEAR_PLANE * FAR_PLANE) / (FAR_PLANE + NEAR_PLANE - z * (FAR_PLANE - NEAR_PLANE));
}

// --- The opaque scene into the G-buffer ---------------------------------------------------------

struct OpaqueVSInput
{
    float3 pos : POSITION;
    float3 normal : NORMAL;
};

struct OpaqueVSOutput
{
    float4 position : SV_Position;
    float3 normal : NORMAL;
    float4 color : COLOR;
    float3 worldPos : TEXCOORD0;
};

// scene_opaque.vert
OpaqueVSOutput opaque_vs(OpaqueVSInput input)
{
    OpaqueVSOutput output;
    float4x4 nodeMat = mul(g_SceneNode.nodeMatrix, g_Model);
    output.position = mul(mul(mul(float4(input.pos, 1.0), nodeMat), g_View), g_Projection);
    // Vertex position in world space
    output.worldPos = mul(float4(input.pos, 1.0), g_SceneNode.nodeMatrix).xyz;
    // GL to Vulkan coord space
    output.worldPos.y = -output.worldPos.y;
    // Normal in world space: transpose(inverse(mat3(nodeMat))) * normal, i.e. the cofactors over
    // the determinant. m holds the matrix transposed (rows: its columns), so the cofactors of m are
    // those of the matrix transposed: what mul(normal, ...) needs.
    float3x3 m = (float3x3)nodeMat;
    float3x3 cofactors = float3x3(cross(m[1], m[2]), cross(m[2], m[0]), cross(m[0], m[1]));
    float determinant = dot(m[0], cofactors[0]);
    output.normal = normalize(mul(input.normal, cofactors / determinant));
    output.color = g_SceneNode.color;
    return output;
}

struct GBufferOutput
{
    float4 positionDepth : SV_Target0;
    float4 normal : SV_Target1;
    float4 albedo : SV_Target2;
};

// scene_opaque.frag (the sample's fourth output, zeros into the swapchain image, is left out:
// the back buffer is cleared to zeros anyway)
GBufferOutput opaque_ps(OpaqueVSOutput input)
{
    GBufferOutput output;
    output.positionDepth = float4(input.worldPos, 1.0);
    float3 N = normalize(input.normal);
    N.y = -N.y;
    output.normal = float4(N, 1.0);
    output.albedo = input.color;
    // Store linearized depth in alpha component
    output.positionDepth.a = linearDepth(input.position.z);
    return output;
}

// --- The deferred composition ---------------------------------------------------------------

Texture2D t_PositionDepth : register(t0);
Texture2D t_Normal : register(t1);
Texture2D t_Albedo : register(t2);

struct Light
{
    float4 position;
    float3 color;
    float radius;
};

StructuredBuffer<Light> t_Lights : register(t3);

// composition.vert
float4 composition_vs(uint vertexIndex : SV_VertexID) : SV_Position
{
    float2 uv = float2((vertexIndex << 1) & 2, vertexIndex & 2);
    return float4(uv * 2.0f - 1.0f, 0.0f, 1.0f);
}

// composition.frag: every light's diffuse part over the albedo, attenuated steeply by distance.
float4 composition_ps(float4 position : SV_Position) : SV_Target
{
    const int3 pixel = int3(position.xy, 0);
    float3 fragPos = t_PositionDepth.Load(pixel).rgb;
    float3 normal = t_Normal.Load(pixel).rgb;
    float4 albedo = t_Albedo.Load(pixel);

#define ambient 0.005

    // Ambient part
    float3 fragcolor = albedo.rgb * ambient;

    uint lightCount, stride;
    t_Lights.GetDimensions(lightCount, stride);
    for (uint i = 0; i < lightCount; ++i)
    {
        Light light = t_Lights[i];
        float3 L = light.position.xyz - fragPos;
        float dist = length(L);
        float attenuation = light.radius / (pow(dist, 8.0) + 1.0);
        float NdotL = max(0.0, dot(normalize(normal), normalize(L)));
        float3 diffuse = light.color * albedo.rgb * NdotL * attenuation;
        fragcolor += diffuse;
    }
    return float4(fragcolor, 1.0);
}

// --- The transparent scene ------------------------------------------------------------------

Texture2D t_Glass : register(t4);
SamplerState s_Glass : register(s0);

struct TransparentVSInput
{
    float3 pos : POSITION;
    float3 normal : NORMAL;
    float2 uv : TEXCOORD;
};

struct TransparentVSOutput
{
    float4 position : SV_Position;
    float4 color : COLOR;
    float2 uv : TEXCOORD0;
};

// scene_transparent.vert
TransparentVSOutput transparent_vs(TransparentVSInput input)
{
    TransparentVSOutput output;
    output.color = float4(1.0, 1.0, 1.0, 1.0);
    output.uv = input.uv;
    output.position = mul(mul(mul(mul(float4(input.pos.xyz, 1.0), g_SceneNode.nodeMatrix), g_Model), g_View), g_Projection);
    return output;
}

// scene_transparent.frag: the glass texture (the sample reads the G-buffer's depth to discard
// hidden fragments, but its discard is commented out: the depth test does it).
float4 transparent_ps(TransparentVSOutput input) : SV_Target
{
    float depth = t_PositionDepth.Load(int3(input.position.xy, 0)).a;
    float4 sampledColor = t_Glass.Sample(s_Glass, input.uv);
    if ((depth != 0.0) && (linearDepth(input.position.z) < depth))
    {
        // discard;
    }
    return sampledColor;
}

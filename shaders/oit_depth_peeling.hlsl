/* Copyright (c) 2024, Google
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

// Port of Vulkan-Samples' oit_depth_peeling shaders (fullscreen.vert, background.frag,
// gather.vert, gather_first.frag, gather.frag, combine.frag). The TypeScript side gives the
// sample's model-view-projection with clip y negated for Donut's y-up clip space.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

struct SceneConstants
{
    float4x4 model_view_projection;
    float background_grayscale;
    float object_alpha;
    int front_layer_index;
    int back_layer_index;
};

cbuffer c_SceneConstants : register(b0)
{
    SceneConstants sceneConstants;
};

// --- Fullscreen passes ---------------------------------------------------------------------------

struct FullscreenVSOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
};

// fullscreen.vert: in the sample's clip space (y down), negated for Donut's (y up).
FullscreenVSOutput fullscreen_vs(uint vertexIndex : SV_VertexID)
{
    const float4 fullscreen_triangle[] =
    {
        float4(-1.0f,  3.0f, 0.0f, 2.0f),
        float4(-1.0f, -1.0f, 0.0f, 0.0f),
        float4( 3.0f, -1.0f, 2.0f, 0.0f),
    };
    const float4 vertex = fullscreen_triangle[vertexIndex % 3];
    FullscreenVSOutput output;
    output.position = float4(vertex.x, -vertex.y, 0.0f, 1.0f);
    output.uv = vertex.zw;
    return output;
}

Texture2D backgroundTex : register(t1);
SamplerState s_Background : register(s1);

// background.frag
float4 background_ps(FullscreenVSOutput input) : SV_Target
{
    return backgroundTex.Sample(s_Background, input.uv) * sceneConstants.background_grayscale;
}

static const int kLayersCount = 8;
Texture2D layerTex[kLayersCount] : register(t2);
SamplerState s_Point : register(s0);

// combine.frag
float4 combine_ps(FullscreenVSOutput input) : SV_Target
{
    // Merge all layers using in-shader alpha blending.
    float4 color = float4(0.0f, 0.0f, 0.0f, 1.0f);
    const int front_layer_index = clamp(sceneConstants.front_layer_index, 0, kLayersCount - 1);
    const int back_layer_index = clamp(sceneConstants.back_layer_index, front_layer_index, kLayersCount - 1);
    // (Every layer read, those outside the range ignored: FXC indexes texture arrays with constants
    // only.)
    [unroll]
    for (int i = kLayersCount - 1; i >= 0; --i)
    {
        const float4 fragmentColor = layerTex[i].Sample(s_Point, input.uv);
        if (i <= back_layer_index && i >= front_layer_index)
        {
            color.rgb = lerp(color.rgb, fragmentColor.rgb, fragmentColor.a);
            color.a *= 1.0f - fragmentColor.a;
        }
    }
    // The final color is blended in the background using fixed-function alpha blending.
    color.a = 1.0f - color.a;
    return color;
}

// --- Gather passes: one layer each ---------------------------------------------------------------

struct GatherVSOutput
{
    float4 position : SV_Position;
    float4 color : COLOR;
};

// gather.vert
GatherVSOutput gather_vs(float3 inPos : POSITION, float2 inUV : TEXCOORD)
{
    GatherVSOutput output;
    output.position = mul(float4(inPos, 1.0f), sceneConstants.model_view_projection);
    output.color = float4(inUV, 0.0f, sceneConstants.object_alpha);
    return output;
}

// gather_first.frag
float4 gather_first_ps(GatherVSOutput input) : SV_Target
{
    // The first gather pass is equivalent to rendering an opaque object.
    // That is, only the front-most fragments are rendered.
    return input.color;
}

Texture2D depthTex : register(t0);

// gather.frag
float4 gather_ps(GatherVSOutput input) : SV_Target
{
    // 'depthTex' contains the depth information of the previous layer.
    // That information is used to discard any fragment that belongs to
    // a layer that has already be rendered (i.e. a layer further in front).
    const float layerDepth = depthTex.Load(int3(input.position.xy, 0)).r;
    if (input.position.z >= layerDepth)
    {
        // NOTE
        // Remember that a reversed Z-buffer is used here.
        // Fragments closer to the camera have a higher z coordinate.
        discard;
    }

    return input.color;
}

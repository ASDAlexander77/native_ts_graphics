/* Copyright (c) 2023-2024, Google
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

// Port of Vulkan-Samples' oit_linked_lists shaders (gather.vert/frag, fullscreen.vert,
// background.frag, combine.vert/frag) to Donut's bindings, in one file. The TypeScript side gives
// the sample's projection with clip y negated for Donut's y-up clip space, so the picture (and
// the per-pixel lists) land as the sample's do.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

#define LINKED_LIST_END_SENTINEL 0xFFFFFFFFU

// For performance reasons, this should be kept as low as result correctness allows.
#define SORTED_FRAGMENT_MAX_COUNT 16U

struct SceneConstants
{
    float4x4 projection;
    float4x4 view;
    float backgroundGrayscale;
    uint sortFragments;
    uint fragmentMaxCount;
    uint sortedFragmentCount;
};

cbuffer c_Scene : register(b0)
{
    SceneConstants g_Scene;
};

#define INSTANCE_COUNT 64

struct Instance
{
    float4x4 model;
    float4 color;
};

cbuffer c_Instances : register(b1)
{
    Instance g_Instances[INSTANCE_COUNT];
};

// UAVs from u1: on D3D11 they share slots with the render targets, and the passes have one.

// Each pixel's list: the index of its last fragment, LINKED_LIST_END_SENTINEL for none.
RWTexture2D<uint> u_LinkedListHead : register(u1);
// The fragments: the index of the previous one in the list, the color (packed RGBA8), the depth.
RWStructuredBuffer<uint3> u_Fragments : register(u2);
// The fragments written so far.
RWStructuredBuffer<uint> u_FragmentCounter : register(u3);

Texture2D t_Background : register(t0);
SamplerState s_Background : register(s0);

// GLSL's packUnorm4x8 and unpackUnorm4x8.
uint packUnorm4x8(float4 value)
{
    uint4 bytes = uint4(round(saturate(value) * 255.0));
    return bytes.x | (bytes.y << 8) | (bytes.z << 16) | (bytes.w << 24);
}

float4 unpackUnorm4x8(uint value)
{
    return float4(value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF, value >> 24) / 255.0;
}

// --- Gather: every fragment of the transparent spheres into its pixel's list ------------------

struct GatherVSOutput
{
    float4 position : SV_Position;
    float4 color : COLOR;
};

// gather.vert
GatherVSOutput gather_vs(float3 position : POSITION, uint instanceId : SV_InstanceID)
{
    const Instance instance = g_Instances[instanceId];
    GatherVSOutput output;
    output.position = mul(mul(mul(float4(position, 1.0), instance.model), g_Scene.view), g_Scene.projection);
    output.color = instance.color;
    return output;
}

// gather.frag. The pass draws nothing: its pipeline writes no color (the sample's render pass has
// no attachments).
float4 gather_ps(GatherVSOutput input) : SV_Target
{
    // Get the next fragment index
    uint nextFragmentIndex;
    InterlockedAdd(u_FragmentCounter[0], 1U, nextFragmentIndex);

    // Ignore the fragment if the fragment buffer is full
    if (nextFragmentIndex >= g_Scene.fragmentMaxCount)
    {
        discard;
    }

    // Update the linked list head
    uint previousFragmentIndex;
    InterlockedExchange(u_LinkedListHead[uint2(input.position.xy)], nextFragmentIndex, previousFragmentIndex);

    // Add the fragment to the buffer
    u_Fragments[nextFragmentIndex] = uint3(previousFragmentIndex, packUnorm4x8(input.color), asuint(input.position.z));
    return 0.0;
}

// --- Background --------------------------------------------------------------------------------

struct FullscreenVSOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
};

// fullscreen.vert: a triangle over the screen (in the sample's clip space, y down), with texture
// coordinates from 0 at the top left.
FullscreenVSOutput fullscreen_vs(uint vertexId : SV_VertexID)
{
    const float4 fullscreenTriangle[3] =
    {
        float4(-1.0, 3.0, 0.0, 2.0),
        float4(-1.0, -1.0, 0.0, 0.0),
        float4(3.0, -1.0, 2.0, 0.0),
    };
    const float4 vertex = fullscreenTriangle[vertexId % 3];
    FullscreenVSOutput output;
    output.position = float4(vertex.x, -vertex.y, 0.0, 1.0);
    output.uv = vertex.zw;
    return output;
}

// background.frag
float4 background_ps(FullscreenVSOutput input) : SV_Target
{
    return t_Background.Sample(s_Background, input.uv) * g_Scene.backgroundGrayscale;
}

// --- Combine: each pixel's fragments, sorted and blended ----------------------------------------

// combine.vert
float4 combine_vs(uint vertexId : SV_VertexID) : SV_Position
{
    const float2 fullscreenTriangle[3] =
    {
        float2(-1.0, 3.0),
        float2(-1.0, -1.0),
        float2(3.0, -1.0),
    };
    const float2 vertex = fullscreenTriangle[vertexId % 3];
    return float4(vertex.x, -vertex.y, 0.0, 1.0);
}

// Blend two colors.
// The alpha channel keeps track of the amount of visibility of the background.
float4 blendColors(uint packedSrcColor, float4 dstColor)
{
    const float4 srcColor = unpackUnorm4x8(packedSrcColor);
    float alphaResult = srcColor.a + dstColor.a * (1.0 - srcColor.a);
    float3 rgbResult = (srcColor.rgb * srcColor.a + dstColor.rgb * dstColor.a * (1.0 - srcColor.a)) / alphaResult;
    return float4(rgbResult, alphaResult);
}

// Sort and blend fragments from the linked list.
// For performance reasons, the maximum number of sorted fragments is limited.
// Approximations are used when the number of fragments is over the limit.
float4 mergeWithSort(uint firstFragmentIndex)
{
    // Fragments are sorted from back to front.
    // e.g. sortedFragments[0] is the farthest from the camera.
    uint2 sortedFragments[SORTED_FRAGMENT_MAX_COUNT];
    uint sortedFragmentCount = 0U;
    const uint kSortedFragmentMaxCount = min(g_Scene.sortedFragmentCount, SORTED_FRAGMENT_MAX_COUNT);

    float4 color = 0.0;
    uint fragmentIndex = firstFragmentIndex;
    while (fragmentIndex != LINKED_LIST_END_SENTINEL)
    {
        const uint3 fragment = u_Fragments[fragmentIndex];
        fragmentIndex = fragment.x;

        if (sortedFragmentCount < kSortedFragmentMaxCount)
        {
            // There is still room in the sorted list.
            // Insert the fragment so that the list stay sorted.
            // (The sample's for loop over i, down to the insertion point; with a constant bound,
            // which FXC compiles right: it takes the original for a loop that writes nothing.)
            uint i = sortedFragmentCount;
            for (uint step = 0; step < SORTED_FRAGMENT_MAX_COUNT; ++step)
            {
                if ((i == 0) || !(fragment.z < sortedFragments[i - 1].y))
                {
                    break;
                }
                sortedFragments[i] = sortedFragments[i - 1];
                --i;
            }
            sortedFragments[i] = fragment.yz;
            ++sortedFragmentCount;
        }
        else if (sortedFragments[0].y < fragment.z)
        {
            // The fragment is closer than the farthest sorted one.
            // First, make room by blending the farthest fragment from the sorted list.
            // Then, insert the fragment in the sorted list.
            // This is an approximation.
            color = blendColors(sortedFragments[0].x, color);
            uint i = 0;
            for (; (i < kSortedFragmentMaxCount - 1) && (sortedFragments[i + 1].y < fragment.z); ++i)
            {
                sortedFragments[i] = sortedFragments[i + 1];
            }
            sortedFragments[i] = fragment.yz;
        }
        else
        {
            // The next fragment is farther than any of the sorted ones.
            // Blend it early.
            // This is an approximation.
            color = blendColors(fragment.y, color);
        }
    }

    // Early return if there are no fragments.
    if (sortedFragmentCount == 0)
    {
        return 0.0;
    }

    // Blend the sorted fragments to get the final color.
    for (uint i = 0; i < sortedFragmentCount; ++i)
    {
        color = blendColors(sortedFragments[i].x, color);
    }
    return color;
}

// Blend fragments from the linked list without sorting them.
float4 mergeWithoutSort(uint firstFragmentIndex)
{
    float4 color = 0.0;
    uint fragmentIndex = firstFragmentIndex;
    while (fragmentIndex != LINKED_LIST_END_SENTINEL)
    {
        const uint3 fragment = u_Fragments[fragmentIndex];
        fragmentIndex = fragment.x;
        color = blendColors(fragment.y, color);
    }
    return color;
}

// combine.frag
float4 combine_ps(float4 position : SV_Position) : SV_Target
{
    // Reset the atomic counter for the next frame.
    // Note that we don't care about atomicity here, as all threads will write the same value.
    u_FragmentCounter[0] = 0;

    // Get the first fragment index in the linked list.
    const uint2 pixel = uint2(position.xy);
    uint fragmentIndex = u_LinkedListHead[pixel];
    // Reset the list head for the next frame.
    u_LinkedListHead[pixel] = LINKED_LIST_END_SENTINEL;

    // Compute the final color.
    return (g_Scene.sortFragments == 1U) ? mergeWithSort(fragmentIndex) : mergeWithoutSort(fragmentIndex);
}

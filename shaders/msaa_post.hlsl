/* Copyright (c) 2020-2024, Arm Limited and Contributors
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

// Port of the post-processing pass of Vulkan-Samples' msaa: the framework's postprocessing.vert,
// and the outline effects outline.frag and outline_ms_depth.frag (with MS_DEPTH), to Donut's
// bindings.

// The sample's PostprocessingUniform: (far, near) of the camera, swapped as the sample passes them
// (its linearizeDepth names them the other way round), for reversed depth.
struct PostConstants
{
    float2 nearFar;
};

cbuffer c_Post : register(b0)
{
    PostConstants g_Post;
};

#if MS_DEPTH
// Multisampled (outline_ms_depth.frag): sample 0 is read.
Texture2DMS<float> t_DepthMS : register(t1);
#else
Texture2D<float> t_Depth : register(t1);
#endif
Texture2D t_Color : register(t0);
SamplerState s_Color : register(s0);

// postprocessing.vert: the sample's triangle over the screen, in its clip space (y down) turned
// into Donut's (y up).
void post_vs(uint vertexId : SV_VertexID, out float4 position : SV_Position, out float2 uv : TEXCOORD0)
{
    uv = float2((vertexId << 1) & 2, vertexId & 2);
    position = float4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
}

float linearizeDepth(float depth, float near, float far)
{
    return near * far / (far + depth * (near - far));
}

float getDepth(int2 pixel, int2 offset)
{
#if MS_DEPTH
    float depth = t_DepthMS.Load(pixel + offset, 0);
#else
    float depth = t_Depth.Load(int3(pixel + offset, 0));
#endif
    return linearizeDepth(depth, g_Post.nearFar.x, g_Post.nearFar.y);
}

// outline.frag (outline_ms_depth.frag with MS_DEPTH): darkens the edges where the depth changes.
float4 outline_ps(float4 fragCoord : SV_Position, float2 uv : TEXCOORD0) : SV_Target
{
    const int2 pixel = int2(fragCoord.xy);
    float4 color = t_Color.Sample(s_Color, uv);
    float depth = getDepth(pixel, int2(0, 0));

    float3 outlineColor = float3(0.0, 0.0, 0.0);
    int thickness = 2;
    float outline = depth - getDepth(pixel, int2(-thickness, 0));
    outline += depth - getDepth(pixel, int2(0, thickness));
    outline += depth - getDepth(pixel, int2(thickness, 0));
    outline += depth - getDepth(pixel, int2(0, -thickness));

    return float4(lerp(color.rgb, outlineColor, saturate(outline)), color.a);
}

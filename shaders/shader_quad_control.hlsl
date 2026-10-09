/* Copyright (c) 2025-2026, Holochip Inc.
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

// Port of Vulkan-Samples' shader_quad_control shaders (quad_control.vert, quad_control.frag).
// The pixel shader runs in full quads, as the sample's layout(full_quads): SPIR-V's
// RequireFullQuadsKHR execution mode (SPV_KHR_quad_control, as DXC's inline SPIR-V) on Vulkan; D3D12
// always runs pixel shaders in whole quads, helper lanes taking part in quad operations. With
// BROADCAST, every pixel shows its quad's top left one's texture coordinates (QuadReadLaneAt, the
// sample's README's subgroupQuadBroadcast(vUV, 0)): 2 x 2 blocks of one color.

// The sample's triangle over the screen, in its clip space (y down) turned into Donut's (y up).
void main_vs(uint vertexId : SV_VertexID, out float4 position : SV_Position, out float2 uv : TEXCOORD0)
{
    const float2 positions[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
    const float2 pos = positions[vertexId];
    uv = 0.5 * pos + 0.5;
    position = float4(pos.x, -pos.y, 0.0, 1.0);
}

#ifdef SPIRV
#define CapabilityQuadControlKHR 5087
#define ExecutionModeRequireFullQuadsKHR 5089
[[vk::ext_extension("SPV_KHR_quad_control")]]
[[vk::ext_capability(CapabilityQuadControlKHR)]]
#endif
float4 main_ps(float4 position : SV_Position, float2 uv : TEXCOORD0) : SV_Target
{
#ifdef SPIRV
    // layout(full_quads) in;
    vk::ext_execution_mode(ExecutionModeRequireFullQuadsKHR);
#endif
#if BROADCAST
    const float2 shown = QuadReadLaneAt(uv, 0);
#else
    const float2 shown = uv;
#endif
    return float4(shown, 0.5, 1.0);
}

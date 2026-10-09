/* Copyright (c) 2026, Holochip Inc.
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

// Port of Vulkan-Samples' compute_shader_derivatives shaders (Slang: derivatives_quad.comp,
// derivatives_linear.comp, fullscreen.vert/frag). Derivatives in compute shaders are shader model
// 6.6's: an 8 x 8 thread group gives quads of 2 x 2 threads (DXC's SPIR-V: DerivativeGroupQuads),
// a one-dimensional group of 64 gives quads of 4 consecutive threads (DerivativeGroupLinear). The
// sample's linear variant numbers its 8 x 8 threads row by row (Slang's [DerivativeGroupLinear]):
// here the 64 threads of a 1D group are laid out the same way, so a "quad" is 4 pixels in a row.

// Output image for gradient magnitude visualization
RWTexture2D<float4> gOutputImage : register(u0);

// The sample's procedural function and its visualization, at a pixel.
void shade(uint2 tid)
{
    // Get image dimensions
    uint2 dims;
    gOutputImage.GetDimensions(dims.x, dims.y);

    if (tid.x >= dims.x || tid.y >= dims.y)
        return;

    // Normalized coordinates [0, 1]
    float2 uv = float2(tid.xy) / float2(dims - 1);

    // Create an interesting procedural function: radial gradient with modulation
    float2 center = float2(0.5, 0.5);
    float2 delta = uv - center;
    float dist = length(delta);

    // Procedural function with spatial variation
    float value = sin(dist * 10.0) * 0.5 + 0.5;
    value *= (1.0 - smoothstep(0.0, 0.7, dist));

    // Compute derivatives of the function - this is the key feature!
    // (Fine ones: the sample's ddx is SPIR-V's OpDPdx, coarse or fine as the driver likes, and
    // fine on NVIDIA's; DXIL's ddx is coarse, one value per quad.)
    float dx = ddx_fine(value);
    float dy = ddy_fine(value);

    // Gradient magnitude - useful for edge detection, LOD selection, and filtering
    float gradientMag = sqrt(dx * dx + dy * dy);

    // Visualize gradient magnitude as edge detection
    float edgeIntensity = saturate(gradientMag * 10.0);

    // Create a color visualization
    float3 color;
    color.r = edgeIntensity;                    // Red for edges
    color.g = edgeIntensity * 0.5;              // Some yellow for strong edges
    color.b = value * (1.0 - edgeIntensity);    // Blue for the base pattern

    // Write visualization to output image
    gOutputImage[tid.xy] = float4(color, 1.0);
}

// derivatives_quad.comp: 8x8 local size for efficient compute with proper derivative quad coverage
[numthreads(8, 8, 1)]
void derivatives_quad(uint3 tid : SV_DispatchThreadID)
{
    shade(tid.xy);
}

// derivatives_linear.comp: the 8 x 8 tiles of the image, their pixels in row order.
[numthreads(64, 1, 1)]
void derivatives_linear(uint3 groupId : SV_GroupID, uint localIndex : SV_GroupIndex)
{
    shade(groupId.xy * 8 + uint2(localIndex % 8, localIndex / 8));
}

// --- Fragment shader for displaying the computed gradient visualization -------------------------

Texture2D computedImage : register(t0);
SamplerState computedImageSampler : register(s0);

struct PSInput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
};

// fullscreen.vert: a triangle over the screen, in the sample's clip space (y down), negated for
// Donut's (y up).
PSInput fullscreen_vs(uint vertexID : SV_VertexID)
{
    PSInput output;

    // Generate fullscreen triangle using vertex ID
    // Vertex 0: (-1, -1) -> UV (0, 0)
    // Vertex 1: ( 3, -1) -> UV (2, 0)
    // Vertex 2: (-1,  3) -> UV (0, 2)
    output.uv = float2((vertexID << 1) & 2, vertexID & 2);
    const float2 position = output.uv * 2.0 - 1.0;
    output.position = float4(position.x, -position.y, 0.0, 1.0);

    return output;
}

// fullscreen.frag
float4 fullscreen_ps(PSInput input) : SV_Target
{
    // Sample the computed gradient visualization image
    return computedImage.Sample(computedImageSampler, input.uv);
}

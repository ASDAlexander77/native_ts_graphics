/* Copyright (c) 2021, Arm Limited and Contributors
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

// Port of Vulkan-Samples' timeline_semaphore shaders (game_of_life_init.comp,
// game_of_life_mutate.comp, game_of_life_update.comp, render.vert, render.frag) to Donut's
// bindings: Conway's Game of Life on a 64 x 64 image, a step a second, the living cells' colors
// fading in over it; drawn in a square over the screen. Clip y is negated for Donut's y-up clip
// space.

#include <donut/shaders/binding_helpers.hlsli>

// The compute shaders write this frame's image, reading the previous frame's (point sampled,
// repeating: the grid wraps around).
RWTexture2D<float4> u_ImageOutput : register(u0);
Texture2D t_ImageInput : register(t0);
SamplerState s_ImmutableSampler : register(s0);

struct Registers
{
    float counter;
};

DECLARE_PUSH_CONSTANTS(Registers, g_Registers, 0, 0);

// game_of_life_init.comp
[numthreads(8, 8, 1)]
void init_cs(uint3 globalId : SV_DispatchThreadID)
{
    int2 index = int2(globalId.xy);
    bool is_alive;

    // Create an arbitrary pattern which happens to create a desirable result.
    int2 mask = int2((index.x & 16) != 0 ? 7 : 3, (index.y & 16) != 0 ? 7 : 3);
    int2 wrapped_index = index & mask;
    if (all(wrapped_index == int2(1, 0)) ||
        all(wrapped_index == int2(2, 1)) ||
        all(wrapped_index == int2(0, 2)) ||
        all(wrapped_index == int2(1, 2)) ||
        all(wrapped_index == int2(2, 2)))
    {
        is_alive = true;
    }
    else
    {
        is_alive = false;
    }

    u_ImageOutput[index] = is_alive ? float4(1.0, 1.0, 1.0, 0.0) : float4(0.0, 0.0, 0.0, 0.0);
}

// game_of_life_mutate.comp
[numthreads(8, 8, 1)]
void mutate_cs(uint3 globalId : SV_DispatchThreadID)
{
    float4 v = t_ImageInput.Load(int3(globalId.xy, 0));

    // Increase intensity over time until the cell dies.
    if (any(v.rgb != float3(0.0, 0.0, 0.0)))
        v.w = max(v.w, g_Registers.counter);
    else
        v.w = 0.0;

    u_ImageOutput[globalId.xy] = v;
}

// game_of_life_update.comp
[numthreads(8, 8, 1)]
void update_cs(uint3 globalId : SV_DispatchThreadID)
{
    int2 index = int2(globalId.xy);
    uint width, height;
    t_ImageInput.GetDimensions(width, height);
    float2 uv = (float2(index) + 0.5) / float2(width, height);

    int neighbors = 0;
    float4 self = t_ImageInput.SampleLevel(s_ImmutableSampler, uv, 0.0);
    bool is_alive = any(self.rgb != float3(0.0, 0.0, 0.0));
    float3 total = self.rgb;

#define CHECK_OFFSET(x, y) { \
    float3 tmp; \
    tmp = t_ImageInput.SampleLevel(s_ImmutableSampler, uv, 0.0, int2(x, y)).rgb; \
    if (any(tmp != float3(0.0, 0.0, 0.0))) { \
        neighbors++; \
        total += tmp.rgb; \
    } \
}
    CHECK_OFFSET(-1, -1)
    CHECK_OFFSET( 0, -1)
    CHECK_OFFSET(+1, -1)
    CHECK_OFFSET(-1,  0)
    CHECK_OFFSET(+1,  0)
    CHECK_OFFSET(-1, +1)
    CHECK_OFFSET( 0, +1)
    CHECK_OFFSET(+1, +1)

    if (is_alive)
    {
        is_alive = neighbors == 2 || neighbors == 3;
        if (is_alive)
        {
            total /= float(neighbors);
        }
        else
        {
            total = float3(0.0, 0.0, 0.0);
        }
    }
    else
    {
        is_alive = neighbors == 3;
        if (is_alive)
        {
            float3 fresh_color = float3(uv.x, uv.y, 1.0 - uv.x - uv.y);
            total = fresh_color;
        }
        else
        {
            total = float3(0.0, 0.0, 0.0);
        }
    }

    u_ImageOutput[index] = float4(total, 0.0);
}

struct VSOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
};

// render.vert: a triangle over the viewport.
VSOutput render_vs(uint vertexIndex : SV_VertexID)
{
    float2 position;
    if (vertexIndex == 0)
        position = float2(-1.0, -1.0);
    else if (vertexIndex == 1)
        position = float2(-1.0, 3.0);
    else
        position = float2(3.0, -1.0);
    VSOutput output;
    output.position = float4(position.x, -position.y, 0.0, 1.0);
    output.uv = position * 0.5 + 0.5;
    return output;
}

// render.frag: the cells' colors over their gray by their intensity.
float4 convert_color(float4 value)
{
    float gray = dot(value.rgb, float3(0.3, 0.6, 0.1));
    return float4(lerp(float3(gray, gray, gray), value.rgb, value.a), 1.0);
}

float4 render_ps(VSOutput input) : SV_Target
{
    return convert_color(t_ImageInput.SampleLevel(s_ImmutableSampler, input.uv, 0.0));
}

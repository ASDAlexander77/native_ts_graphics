/* Copyright 2023 Nintendo
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *	 http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Port of Vulkan-Samples' shader_object shaders to Donut's bindings: the skybox, the terrain, the
// basic shader pairs (the sample links each vertex shader to its fragment shader), the material
// shaders (any vertex shader with any geometry shader, or none, and any fragment shader) and the
// post-processing passes, one entry point each. The sample's three descriptor set layouts become
// two binding layouts: the scene's (basic and material shaders alike, with the material push
// constants; the basic shaders read their model matrix only) and post-processing's. The
// TypeScript side gives the sample's projection with clip y negated for Donut's y-up clip space.

#include <donut/shaders/binding_helpers.hlsli>

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

cbuffer UBO : register(b0)
{
    float4x4 g_Projection;
    float4x4 g_View;
    float4x4 g_ProjView;
    // The sample's post-processing push constant (elapsed_time), here for post-processing only.
    float g_PostElapsedTime;
};

// The sample's MaterialPushConstant; BasicPushConstant is its model matrix alone.
struct PushConstants
{
    float4x4 model;
    float3 cameraPos;
    float elapsedTime;
    float materialDiffuse;
    float materialSpec;
};

DECLARE_PUSH_CONSTANTS(PushConstants, g_Push, 1, 0);

// The scene's textures: the sky sphere (the skybox and the reflective material), the heightmap and
// the terrain's layers, the checkerboard (the materials).
Texture2D t_EnvMap : register(t1);
Texture2D t_Heightmap : register(t2);
Texture2DArray t_TerrainLayers : register(t3);
Texture2D t_Checkerboard : register(t4);
SamplerState s_Texture : register(s1);
SamplerState s_Heightmap : register(s2);
SamplerState s_TerrainLayers : register(s3);

// Post-processing's input: the scene's output image.
Texture2D t_PostInput : register(t0);
SamplerState s_PostInput : register(s0);

struct VSInput
{
    float3 pos : POSITION;
    float3 normal : NORMAL;
    float2 uv : TEXCOORD;
};

// mat3(inverse(transpose(model))) * normal: model is read transposed (m, rows: its columns), so the
// cofactors of m over its determinant are what mul(normal, ...) needs.
float3 transformNormal(float3 normal, float4x4 model)
{
    float3x3 m = (float3x3)model;
    float3x3 cofactors = float3x3(cross(m[1], m[2]), cross(m[2], m[0]), cross(m[0], m[1]));
    float determinant = dot(m[0], cofactors[0]);
    return mul(normal, cofactors / determinant);
}

// --- Skybox -------------------------------------------------------------------------------------

struct SkyboxVSOutput
{
    float4 position : SV_Position;
    float3 uvWorldPos : TEXCOORD0;
    float3 pos : TEXCOORD1;
    float3 normal : NORMAL;
};

// skybox.vert
SkyboxVSOutput skybox_vs(VSInput input)
{
    SkyboxVSOutput output;
    output.uvWorldPos = float3(input.uv, 0.0);
    output.pos = mul(input.pos, (float3x3)mul(g_Push.model, g_View));
    output.position = mul(float4(output.pos, 1.0), g_Projection);
    output.normal = mul(input.normal, (float3x3)mul(g_View, g_Push.model));
    return output;
}

// skybox.frag (which leaves alpha unwritten)
float4 skybox_ps(SkyboxVSOutput input) : SV_Target
{
    return float4(t_EnvMap.Sample(s_Texture, float2(input.uvWorldPos.x, -input.uvWorldPos.y)).rgb, 1.0);
}

// --- Terrain ------------------------------------------------------------------------------------

struct TerrainVSOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
    float3 pos : TEXCOORD1;
    float3 normal : NORMAL;
    // Clip space z, for the fog (see fog()).
    float clipZ : TEXCOORD2;
};

// terrain.vert
TerrainVSOutput terrain_vs(VSInput input)
{
    TerrainVSOutput output;
    output.uv = input.uv;
    output.normal = input.normal;
    output.pos = float3(input.pos.x, t_Heightmap.SampleLevel(s_Heightmap, input.uv, 0.0).r * 256.0f, input.pos.z);
    output.position = mul(mul(float4(output.pos, 1.0), g_Push.model), g_ProjView);
    output.clipZ = output.position.z;
    return output;
}

float3 sampleTerrainLayer(TerrainVSOutput input)
{
    // Define some layer ranges for sampling depending on terrain height
    float2 layers[6];
    layers[0] = float2(-10.0, 10.0);
    layers[1] = float2(5.0, 45.0);
    layers[2] = float2(45.0, 80.0);
    layers[3] = float2(75.0, 100.0);
    layers[4] = float2(95.0, 150.0);
    layers[5] = float2(140.0, 290.0);

    float3 color = float3(0.0, 0.0, 0.0);

    // Get height from displacement map
    float height = 255.0f - input.pos.y;

    for (int i = 0; i < 6; i++)
    {
        float range = layers[i].y - layers[i].x;
        float weight = (range - abs(height - layers[i].y)) / range;
        weight = max(0.0, weight);
        color += weight * t_TerrainLayers.Sample(s_TerrainLayers, float3(input.uv * 16.0, i)).rgb;
    }

    return color;
}

// The sample's distance is gl_FragCoord.z / gl_FragCoord.w, clip space z (gl_FragCoord.w is 1 / w;
// on D3D, SV_Position.w is w itself, so it comes from the vertex shader instead). With the sample's
// reversed depth that stays near 0.1, so the fog is all but invisible, as in the sample.
float fog(float density, float clipZ)
{
    const float LOG2 = -1.442695;
    float dist = clipZ * 0.1;
    float d = density * dist;
    return 1.0 - clamp(exp2(d * d * LOG2), 0.0, 1.0);
}

// terrain.frag
float4 terrain_ps(TerrainVSOutput input) : SV_Target
{
    float3 N = normalize(input.normal);
    float3 L = normalize(float3(0, -1, 1));
    float3 ambient = float3(0.5, 0.5, 0.5);
    float3 diffuse = max(dot(N, L), 0.0) * float3(1.0, 1.0, 1.0);
    float4 color = float4((ambient + diffuse) * sampleTerrainLayer(input), 1.0);

    const float4 fogColor = float4(0.47, 0.5, 0.67, 0.0);
    return lerp(color, fogColor, fog(0.25, input.clipZ));
}

// --- Basic shaders (linked pairs) ---------------------------------------------------------------

struct BasicVSOutput
{
    float4 position : SV_Position;
    float3 color : COLOR;
};

float4 basicPosition(VSInput input)
{
    return mul(mul(float4(input.pos, 1.0), g_Push.model), g_ProjView);
}

// basic_normals.vert
BasicVSOutput basic_normals_vs(VSInput input)
{
    BasicVSOutput output;
    output.color = input.normal;
    output.position = basicPosition(input);
    return output;
}

// basic_pos.vert
BasicVSOutput basic_pos_vs(VSInput input)
{
    BasicVSOutput output;
    output.color = input.pos;
    output.position = basicPosition(input);
    return output;
}

// basic_uv.vert
BasicVSOutput basic_uv_vs(VSInput input)
{
    BasicVSOutput output;
    output.color = float3(input.uv, 0);
    output.position = basicPosition(input);
    return output;
}

// basic_n_dot_l.vert (its output is the normal)
BasicVSOutput basic_n_dot_l_vs(VSInput input)
{
    BasicVSOutput output;
    output.color = transformNormal(input.normal, g_Push.model);
    output.position = basicPosition(input);
    return output;
}

// basic_normals.frag, basic_pos.frag and basic_uv.frag (the same shader)
float4 basic_color_ps(BasicVSOutput input) : SV_Target
{
    return float4(input.color, 1);
}

// basic_n_dot_l.frag
float4 basic_n_dot_l_ps(BasicVSOutput input) : SV_Target
{
    float3 l = normalize(float3(0, -1, 1));
    return float4(float3(1, 1, 1) * dot(normalize(input.color), l), 1);
}

// --- Material shaders ---------------------------------------------------------------------------

// The sample's VertexData (its texture_index is never written nor read).
struct MaterialVertex
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
    float3 normal : NORMAL;
    float3 worldPos : TEXCOORD1;
    float3 objectPos : TEXCOORD2;
};

MaterialVertex materialVertex(VSInput input, float3 worldPos)
{
    MaterialVertex output;
    output.uv = input.uv;
    output.normal = transformNormal(input.normal, g_Push.model);
    output.objectPos = input.pos;
    output.worldPos = worldPos;
    output.position = mul(float4(worldPos, 1.0f), g_ProjView);
    return output;
}

float3 modelToWorld(float3 pos)
{
    return mul(float4(pos, 1.0), g_Push.model).xyz;
}

// material_scene.vert
MaterialVertex material_scene_vs(VSInput input)
{
    return materialVertex(input, modelToWorld(input.pos));
}

// material_rotates.vert: the position turned by theta around y first (the sample's mat3, by
// columns: (cos, 0, -sin), (0, 1, 0), (sin, 0, cos)).
MaterialVertex material_rotates_vs(VSInput input)
{
    float theta = g_Push.elapsedTime * 0.1f;
    float c = cos(theta);
    float s = sin(theta);
    float3 rotated = float3(c * input.pos.x + s * input.pos.z, input.pos.y, -s * input.pos.x + c * input.pos.z);
    return materialVertex(input, modelToWorld(rotated));
}

float waveOffset(float3 worldPos)
{
    float amplitude = 0.5f;
    float phase = 2.0f;
    return amplitude * sin(worldPos.x + worldPos.z + g_Push.elapsedTime * phase);
}

// material_wave_x.vert
MaterialVertex material_wave_x_vs(VSInput input)
{
    float3 worldPos = modelToWorld(input.pos);
    worldPos.x += waveOffset(worldPos);
    return materialVertex(input, worldPos);
}

// material_wave_y.vert
MaterialVertex material_wave_y_vs(VSInput input)
{
    float3 worldPos = modelToWorld(input.pos);
    worldPos.y += waveOffset(worldPos);
    return materialVertex(input, worldPos);
}

// material_wave_z.vert
MaterialVertex material_wave_z_vs(VSInput input)
{
    float3 worldPos = modelToWorld(input.pos);
    worldPos.z += waveOffset(worldPos);
    return materialVertex(input, worldPos);
}

// material_pass_through.geom
[maxvertexcount(3)]
void material_pass_through_gs(triangle MaterialVertex input[3], inout TriangleStream<MaterialVertex> stream)
{
    for (int i = 0; i < 3; ++i)
    {
        stream.Append(input[i]);
    }
    stream.RestartStrip();
}

// material_pass_sin_offset.geom
[maxvertexcount(3)]
void material_pass_sin_offset_gs(triangle MaterialVertex input[3], inout TriangleStream<MaterialVertex> stream)
{
    float amplitude = 0.2f;
    float phase = 5.f;
    for (int i = 0; i < 3; ++i)
    {
        float sinInside = abs(input[i].worldPos.x * input[i].worldPos.y * 2) + g_Push.elapsedTime * phase;
        float3 sinOffset = amplitude * float3(sin(sinInside), cos(sinInside), 0);
        MaterialVertex output = input[i];
        output.worldPos = input[i].worldPos + sinOffset;
        output.position = mul(float4(output.worldPos, 1.f), g_ProjView);
        stream.Append(output);
    }
    stream.RestartStrip();
}

// material_gen_normals.geom: the face normal, (B - A) x (C - A) in object space.
[maxvertexcount(3)]
void material_gen_normals_gs(triangle MaterialVertex input[3], inout TriangleStream<MaterialVertex> stream)
{
    float3 AB = input[1].objectPos - input[0].objectPos;
    float3 AC = input[2].objectPos - input[0].objectPos;
    float3 normal = transformNormal(cross(AB, AC), g_Push.model);
    for (int i = 0; i < 3; ++i)
    {
        MaterialVertex output = input[i];
        output.normal = normal;
        stream.Append(output);
    }
    stream.RestartStrip();
}

// material_normals.frag
float4 material_normals_ps(MaterialVertex input) : SV_Target
{
    return float4(normalize(input.normal) * 0.5 + 0.5, 1);
}

// material_texture.frag
float4 material_texture_ps(MaterialVertex input) : SV_Target
{
    return t_Checkerboard.Sample(s_Texture, input.uv);
}

#define PI 3.1415926538

// material_reflective.frag: the sky sphere in the reflected direction.
float4 material_reflective_ps(MaterialVertex input) : SV_Target
{
    float3 viewDir = normalize(g_Push.cameraPos - input.worldPos);
    float3 reflectedDirection = normalize(reflect(viewDir, normalize(input.normal)));
    float u = 0.5f + atan2(reflectedDirection.z, reflectedDirection.x) / (2 * PI);
    float v = 0.5f + asin(reflectedDirection.y) / PI;
    return t_EnvMap.Sample(s_Texture, float2(u, v));
}

// material_n_dot_l.frag
float4 material_n_dot_l_ps(MaterialVertex input) : SV_Target
{
    float3 l = normalize(float3(0, -1, 1));
    float4 textureColor = t_Checkerboard.Sample(s_Texture, input.uv);
    float nDotL = dot(normalize(input.normal), l);
    float4 color = g_Push.materialDiffuse * textureColor * nDotL + 0.1f * textureColor;
    color += g_Push.materialSpec * float4(float3(1, 1, 1) * nDotL, 1);
    return color;
}

// --- Post-processing ----------------------------------------------------------------------------

struct PostVSOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
};

// post_process_FSQ.vert: one triangle over the screen, uv 0 at the top left (clip y negated).
PostVSOutput fsq_vs(uint vertexIndex : SV_VertexID)
{
    const float2 positions[3] = { float2(-1, 1), float2(-1, -3), float2(3, 1) };
    const float2 uvs[3] = { float2(0, 0), float2(0, 2), float2(2, 0) };
    PostVSOutput output;
    output.position = float4(positions[vertexIndex], 0.0f, 1.0f);
    output.uv = uvs[vertexIndex];
    return output;
}

// post_process_brighten.frag
float4 post_brighten_ps(PostVSOutput input) : SV_Target
{
    return float4(t_PostInput.Sample(s_PostInput, input.uv).rgb * 1.2f, 1.0f);
}

// post_process_invert.frag
float4 post_invert_ps(PostVSOutput input) : SV_Target
{
    float3 color = t_PostInput.Sample(s_PostInput, input.uv).rgb;
    return float4(float3(1.0f, 1.0f, 1.0f) - color, 1.0f);
}

// post_process_grayscale.frag
float4 post_grayscale_ps(PostVSOutput input) : SV_Target
{
    float3 color = t_PostInput.Sample(s_PostInput, input.uv).rgb;
    return float4((color.r + color.g + color.b).xxx / 3.0f, 1.0f);
}

// post_process_quantize.frag
float4 post_quantize_ps(PostVSOutput input) : SV_Target
{
    float3 color = t_PostInput.Sample(s_PostInput, input.uv).rgb;
    float3 colorQuant = floor(color * 4) / 4.0f;
    return float4(colorQuant, 1.0f);
}

// post_process_edge_detection.frag: a Laplacian over the 3 x 3 texels around.
float4 post_edge_detection_ps(PostVSOutput input) : SV_Target
{
    float3 color = float3(0, 0, 0);
    color += t_PostInput.Sample(s_PostInput, input.uv, int2(0, 1)).rgb;
    color += t_PostInput.Sample(s_PostInput, input.uv, int2(-1, 0)).rgb;
    color += t_PostInput.Sample(s_PostInput, input.uv, int2(0, 0)).rgb * -4.0;
    color += t_PostInput.Sample(s_PostInput, input.uv, int2(1, 0)).rgb;
    color += t_PostInput.Sample(s_PostInput, input.uv, int2(0, -1)).rgb;
    return float4(color * 2.0f, 1.0f);
}

// GLSL's mod (x - y * floor(x / y)).
float glslMod(float x, float y)
{
    return x - y * floor(x / y);
}

// Based on HSV to RGB in https://en.wikipedia.org/wiki/HSL_and_HSV
float3 rgb_from_hsv(float hue, float sat, float value)
{
    float h_prime = hue / 60.0f;
    float c = value * sat;
    float x = c * (1 - abs(glslMod(h_prime, 2) - 1));
    float3 rgb = float3(0, 0, 0);
    if (h_prime < 1)
    {
        rgb = float3(c, x, 0);
    }
    else if (h_prime < 2)
    {
        rgb = float3(x, c, 0);
    }
    else if (h_prime < 3)
    {
        rgb = float3(0, c, x);
    }
    else if (h_prime < 4)
    {
        rgb = float3(0, x, c);
    }
    else if (h_prime < 5)
    {
        rgb = float3(x, 0, c);
    }
    else if (h_prime < 6)
    {
        rgb = float3(c, 0, x);
    }
    return rgb + (value - c).xxx;
}

// post_process_color_cycle.frag
float4 post_color_cycle_ps(PostVSOutput input) : SV_Target
{
    float3 color = t_PostInput.Sample(s_PostInput, input.uv).rgb;
    return float4(color * rgb_from_hsv(glslMod(g_PostElapsedTime * 60.f, 360.f), 1.f, 1.f), 1.0f);
}

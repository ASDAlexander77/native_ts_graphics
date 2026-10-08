/* Copyright (c) 2019-2025, Sascha Willems
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

// Port of Vulkan-Samples' terrain_tessellation shaders (terrain.vert/tesc/tese/frag,
// skysphere.vert/frag) to Donut's bindings, in one file. Positions are in the sample's world space,
// where the terrain rises towards -y; worldToView maps them to Donut's view space.

// Donut's matrices are row-major, for mul(vector, matrix).
#pragma pack_matrix(row_major)

struct TerrainConstants
{
    float4x4 worldToView;
    float4x4 viewToClip;
    // The inverse of worldToView's rotation, for the sky's view directions.
    float4x4 viewToWorld;
    float4 lightPos;
    float4 frustumPlanes[6];
    float displacementFactor;
    float tessellationFactor;
    float2 viewportDim;
    float tessellatedEdgeSize;
};

cbuffer c_Terrain : register(b0)
{
    TerrainConstants g_Const;
};

Texture2D<float> t_Heightmap : register(t0);
Texture2DArray t_TerrainLayers : register(t1);
Texture2D t_Sky : register(t2);
SamplerState s_Heightmap : register(s0);
SamplerState s_TerrainLayers : register(s1);
SamplerState s_Sky : register(s2);

// --- Terrain ---------------------------------------------------------------------------------

// The sample's terrain: a grid of PATCH_SIZE x PATCH_SIZE vertices, drawn as quad patches.
#define PATCH_SIZE 64
// Heightmap texels per grid vertex (vkb::HeightMap's scale).
#define HEIGHTMAP_SCALE 16

struct VSOutput
{
    float4 Pos : POSITION;
    float3 Normal : NORMAL;
    float2 UV : TEXCOORD0;
};

// vkb::HeightMap::get_height: the texel under grid vertex (x, y), clamped to the grid.
float GridHeight(int x, int y)
{
    const int2 texel = clamp(int2(x, y), 0, PATCH_SIZE - 1) * HEIGHTMAP_SCALE;
    return t_Heightmap.Load(int3(texel, 0));
}

// The sample builds the grid on the CPU (generate_terrain) and draws it with an index buffer; here
// the vertex shader makes each patch corner from SV_VertexID, as those indices order them.
VSOutput main_vs(uint i_vertex : SV_VertexID)
{
    const uint patch = i_vertex / 4;
    const uint corner = i_vertex % 4;
    const int x = int(patch % (PATCH_SIZE - 1)) + ((corner == 2 || corner == 3) ? 1 : 0);
    const int y = int(patch / (PATCH_SIZE - 1)) + ((corner == 1 || corner == 2) ? 1 : 0);

    const float wx = 2.0;
    const float wy = 2.0;

    VSOutput output;
    output.Pos = float4(x * wx + wx / 2.0 - PATCH_SIZE * wx / 2.0, 0.0, y * wy + wy / 2.0 - PATCH_SIZE * wy / 2.0, 1.0);
    output.UV = float2(x, y) / PATCH_SIZE;

    // Calculate normals from height map using a sobel filter
    float heights[3][3];
    for (int hx = -1; hx <= 1; hx++)
    {
        for (int hy = -1; hy <= 1; hy++)
        {
            heights[hx + 1][hy + 1] = GridHeight(x + hx, y + hy);
        }
    }

    float3 normal;
    // Gx sobel filter
    normal.x = heights[0][0] - heights[2][0] + 2.0 * heights[0][1] - 2.0 * heights[2][1] + heights[0][2] - heights[2][2];
    // Gy sobel filter
    normal.z = heights[0][0] + 2.0 * heights[1][0] + heights[2][0] - heights[0][2] - 2.0 * heights[1][2] - heights[2][2];
    // Calculate missing up component of the normal using the filtered x and y axis
    // The first value controls the bump strength
    normal.y = 0.25 * sqrt(1.0 - normal.x * normal.x - normal.z * normal.z);

    output.Normal = normalize(normal * float3(2.0, 1.0, 2.0));
    return output;
}

struct HSOutput
{
    float4 Pos : POSITION;
    float3 Normal : NORMAL;
    float2 UV : TEXCOORD0;
};

struct ConstantsHSOutput
{
    float TessLevelOuter[4] : SV_TessFactor;
    float TessLevelInner[2] : SV_InsideTessFactor;
};

// Calculate the tessellation factor based on screen space
// dimensions of the edge
float screenSpaceTessFactor(float4 p0, float4 p1)
{
    // Calculate edge mid point
    float4 midPoint = 0.5 * (p0 + p1);
    // Sphere radius as distance between the control points
    float radius = distance(p0, p1) / 2.0;

    // View space
    float4 v0 = mul(midPoint, g_Const.worldToView);

    // Project into clip space
    float4 clip0 = mul(v0 - float4(radius, 0.0, 0.0, 0.0), g_Const.viewToClip);
    float4 clip1 = mul(v0 + float4(radius, 0.0, 0.0, 0.0), g_Const.viewToClip);

    // Get normalized device coordinates
    clip0 /= clip0.w;
    clip1 /= clip1.w;

    // Convert to viewport coordinates
    clip0.xy *= g_Const.viewportDim;
    clip1.xy *= g_Const.viewportDim;

    // Return the tessellation factor based on the screen size
    // given by the distance of the two edge control points in screen space
    // and a reference (min.) tessellation size for the edge set by the application
    return clamp(distance(clip0, clip1) / g_Const.tessellatedEdgeSize * g_Const.tessellationFactor, 1.0, 64.0);
}

// Checks the current's patch visibility against the frustum using a sphere check
// Sphere radius is given by the patch size
bool frustumCheck(float4 Pos, float2 inUV)
{
    // Fixed radius (increase if patch size is increased in example)
    const float radius = 8.0f;
    float4 pos = Pos;
    pos.y -= t_Heightmap.SampleLevel(s_Heightmap, inUV, 0.0) * g_Const.displacementFactor;

    // Check sphere against frustum planes
    for (int i = 0; i < 6; i++)
    {
        if (dot(pos, g_Const.frustumPlanes[i]) + radius < 0.0)
        {
            return false;
        }
    }
    return true;
}

ConstantsHSOutput ConstantsHS(InputPatch<VSOutput, 4> patch)
{
    ConstantsHSOutput output = (ConstantsHSOutput)0;

    if (!frustumCheck(patch[0].Pos, patch[0].UV))
    {
        output.TessLevelInner[0] = 0.0;
        output.TessLevelInner[1] = 0.0;
        output.TessLevelOuter[0] = 0.0;
        output.TessLevelOuter[1] = 0.0;
        output.TessLevelOuter[2] = 0.0;
        output.TessLevelOuter[3] = 0.0;
    }
    else
    {
        if (g_Const.tessellationFactor > 0.0)
        {
            output.TessLevelOuter[0] = screenSpaceTessFactor(patch[3].Pos, patch[0].Pos);
            output.TessLevelOuter[1] = screenSpaceTessFactor(patch[0].Pos, patch[1].Pos);
            output.TessLevelOuter[2] = screenSpaceTessFactor(patch[1].Pos, patch[2].Pos);
            output.TessLevelOuter[3] = screenSpaceTessFactor(patch[2].Pos, patch[3].Pos);
            output.TessLevelInner[0] = lerp(output.TessLevelOuter[0], output.TessLevelOuter[3], 0.5);
            output.TessLevelInner[1] = lerp(output.TessLevelOuter[2], output.TessLevelOuter[1], 0.5);
        }
        else
        {
            // Tessellation factor can be set to zero by example
            // to demonstrate a simple passthrough
            output.TessLevelInner[0] = 1.0;
            output.TessLevelInner[1] = 1.0;
            output.TessLevelOuter[0] = 1.0;
            output.TessLevelOuter[1] = 1.0;
            output.TessLevelOuter[2] = 1.0;
            output.TessLevelOuter[3] = 1.0;
        }
    }

    return output;
}

[domain("quad")]
[partitioning("integer")]
[outputtopology("triangle_cw")]
[outputcontrolpoints(4)]
[patchconstantfunc("ConstantsHS")]
[maxtessfactor(20.0f)]
HSOutput main_hs(InputPatch<VSOutput, 4> patch, uint InvocationID : SV_OutputControlPointID)
{
    HSOutput output = (HSOutput)0;
    output.Pos = patch[InvocationID].Pos;
    output.Normal = patch[InvocationID].Normal;
    output.UV = patch[InvocationID].UV;
    return output;
}

struct DSOutput
{
    float4 Pos : SV_Position;
    float3 Normal : NORMAL;
    float2 UV : TEXCOORD0;
    float3 ViewVec : TEXCOORD1;
    float3 LightVec : TEXCOORD2;
    // Clip space z, for the fog.
    float ClipZ : TEXCOORD3;
};

[domain("quad")]
DSOutput main_ds(ConstantsHSOutput input, float2 TessCoord : SV_DomainLocation, const OutputPatch<HSOutput, 4> patch)
{
    // Interpolate UV coordinates
    DSOutput output = (DSOutput)0;
    float2 uv1 = lerp(patch[0].UV, patch[1].UV, TessCoord.x);
    float2 uv2 = lerp(patch[3].UV, patch[2].UV, TessCoord.x);
    output.UV = lerp(uv1, uv2, TessCoord.y);

    float3 n1 = lerp(patch[0].Normal, patch[1].Normal, TessCoord.x);
    float3 n2 = lerp(patch[3].Normal, patch[2].Normal, TessCoord.x);
    output.Normal = lerp(n1, n2, TessCoord.y);

    // Interpolate positions
    float4 pos1 = lerp(patch[0].Pos, patch[1].Pos, TessCoord.x);
    float4 pos2 = lerp(patch[3].Pos, patch[2].Pos, TessCoord.x);
    float4 pos = lerp(pos1, pos2, TessCoord.y);
    // Displace
    pos.y -= t_Heightmap.SampleLevel(s_Heightmap, output.UV, 0.0) * g_Const.displacementFactor;
    // Perspective projection
    output.Pos = mul(mul(pos, g_Const.worldToView), g_Const.viewToClip);
    output.ClipZ = output.Pos.z;

    // Calculate vectors for lighting based on tessellated position
    output.ViewVec = -pos.xyz;
    output.LightVec = normalize(g_Const.lightPos.xyz + output.ViewVec);
    return output;
}

float3 sampleTerrainLayer(float2 inUV)
{
    // Define some layer ranges for sampling depending on terrain height
    float2 layers[6];
    layers[0] = float2(-10.0, 10.0);
    layers[1] = float2(5.0, 45.0);
    layers[2] = float2(45.0, 80.0);
    layers[3] = float2(75.0, 100.0);
    layers[4] = float2(95.0, 140.0);
    layers[5] = float2(140.0, 190.0);

    float3 color = float3(0.0, 0.0, 0.0);

    // Get height from displacement map
    float height = t_Heightmap.SampleLevel(s_Heightmap, inUV, 0.0) * 255.0;

    for (int i = 0; i < 6; i++)
    {
        float range = layers[i].y - layers[i].x;
        float weight = (range - abs(height - layers[i].y)) / range;
        weight = max(0.0, weight);
        color += weight * t_TerrainLayers.Sample(s_TerrainLayers, float3(inUV * 16.0, i)).rgb;
    }

    return color;
}

// The sample divides gl_FragCoord.z by gl_FragCoord.w, which is 1/w on Vulkan: clip space z. (On
// D3D, SV_Position.w is w itself, so it comes from the domain shader instead.) With the sample's
// reversed depth that stays near 0.1, so the fog is all but invisible, as in the sample.
float fog(float density, float clipZ)
{
    const float LOG2 = -1.442695;
    float dist = clipZ * 0.1;
    float d = density * dist;
    return 1.0 - clamp(exp2(d * d * LOG2), 0.0, 1.0);
}

float4 main_ps(DSOutput input) : SV_Target0
{
    float3 N = normalize(input.Normal);
    float3 L = normalize(input.LightVec);
    float3 ambient = float3(0.5, 0.5, 0.5);
    float3 diffuse = max(dot(N, L), 0.0) * float3(1.0, 1.0, 1.0);

    float4 color = float4((ambient + diffuse) * sampleTerrainLayer(input.UV), 1.0);

    const float4 fogColor = float4(0.47, 0.5, 0.67, 0.0);
    return lerp(color, fogColor, fog(0.25, input.ClipZ));
}

// --- Sky -------------------------------------------------------------------------------------

// The sample draws a sphere around the camera (scenes/geosphere.gltf) whose texture coordinates
// are an equirectangular mapping of its direction. Here a full screen triangle computes that
// mapping for each pixel's view direction.
void sky_vs(
    uint i_vertex : SV_VertexID,
    out float4 o_position : SV_Position,
    out float2 o_clip : TEXCOORD0)
{
    o_clip = float2((i_vertex << 1) & 2, i_vertex & 2) * 2.0 - 1.0;
    o_position = float4(o_clip, 0.0, 1.0);
}

static const float PI = 3.14159265358979;

float4 sky_ps(float4 i_position : SV_Position, float2 i_clip : TEXCOORD0) : SV_Target0
{
    const float3 viewDir = float3(i_clip.x / g_Const.viewToClip[0][0], i_clip.y / g_Const.viewToClip[1][1], 1.0);
    const float3 dir = normalize(mul(viewDir, (float3x3)g_Const.viewToWorld));

    // geosphere.gltf's texture coordinates, with the vertical flip of skysphere.vert.
    float2 uv;
    uv.x = atan2(-dir.z, dir.x) / (2.0 * PI) + 0.5;
    uv.y = 1.0 - acos(clamp(dir.y, -1.0, 1.0)) / PI;

    // Level 0: the wrap of uv.x would make the derivatives pick the smallest mip along a seam.
    return float4(t_Sky.SampleLevel(s_Sky, uv, 0.0).rgb, 1.0);
}

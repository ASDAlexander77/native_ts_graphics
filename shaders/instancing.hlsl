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

// Port of Vulkan-Samples' instancing shaders (instancing.vert/frag, planet.vert/frag,
// starfield.vert/frag) to Donut's bindings, in one file. Positions are in the sample's world space,
// where -y is up; modelview maps them to Donut's view space.

// Donut's matrices are row-major, for mul(vector, matrix).
#pragma pack_matrix(row_major)

struct UBO
{
    float4x4 projection;
    float4x4 modelview;
    float4 lightPos;
    float locSpeed;
    float globSpeed;
};

cbuffer c_Scene : register(b0)
{
    UBO ubo;
};

// The rocks' texture array, or the planet's texture.
Texture2DArray t_Rocks : register(t0);
Texture2D t_Planet : register(t0);
SamplerState s_Color : register(s0);

struct VSOutput
{
    float4 Pos : SV_POSITION;
    float3 Normal : NORMAL;
    float3 Color : COLOR;
    float3 UV : TEXCOORD0;
    float3 ViewVec : TEXCOORD1;
    float3 LightVec : TEXCOORD2;
};

// --- Instanced rocks -------------------------------------------------------------------------

struct InstancedVSInput
{
    // Vertex attributes
    float3 Pos : POSITION;
    float3 Normal : NORMAL;
    float2 UV : TEXCOORD;

    // Instanced attributes
    float3 instancePos : INSTANCE_POSITION;
    float3 instanceRot : INSTANCE_ROTATION;
    float instanceScale : INSTANCE_SCALE;
    int instanceTexIndex : INSTANCE_TEXINDEX;
};

VSOutput instancing_vs(InstancedVSInput input)
{
    VSOutput output = (VSOutput) 0;
    output.Color = float3(1.0, 1.0, 1.0);
    output.UV = float3(input.UV, input.instanceTexIndex);

    // rotate around x
    float s = sin(input.instanceRot.x + ubo.locSpeed);
    float c = cos(input.instanceRot.x + ubo.locSpeed);

    float3x3 mx =
    {
        c, -s, 0.0,
        s, c, 0.0,
        0.0, 0.0, 1.0
    };

    // rotate around y
    s = sin(input.instanceRot.y + ubo.locSpeed);
    c = cos(input.instanceRot.y + ubo.locSpeed);

    float3x3 my =
    {
        c, 0.0, -s,
        0.0, 1.0, 0.0,
        s, 0.0, c
    };

    // rot around z
    s = sin(input.instanceRot.z + ubo.locSpeed);
    c = cos(input.instanceRot.z + ubo.locSpeed);

    float3x3 mz =
    {
        1.0, 0.0, 0.0,
        0.0, c, -s,
        0.0, s, c
    };

    float3x3 rotMat = mul(mz, mul(my, mx));

    float4x4 gRotMat;
    s = sin(input.instanceRot.y + ubo.globSpeed);
    c = cos(input.instanceRot.y + ubo.globSpeed);
    gRotMat[0] = float4(c, 0.0, -s, 0.0);
    gRotMat[1] = float4(0.0, 1.0, 0.0, 0.0);
    gRotMat[2] = float4(s, 0.0, c, 0.0);
    gRotMat[3] = float4(0.0, 0.0, 0.0, 1.0);

    float4 locPos = float4(mul(rotMat, input.Pos.xyz), 1.0);
    float4 pos = float4((locPos.xyz * input.instanceScale) + input.instancePos, 1.0);

    output.Pos = mul(mul(mul(gRotMat, pos), ubo.modelview), ubo.projection);
    output.Normal = mul(mul((float3x3) gRotMat, mul(rotMat, input.Normal)), (float3x3) ubo.modelview);

    pos = mul(float4(input.Pos.xyz + input.instancePos, 1.0), ubo.modelview);
    float3 lPos = mul(ubo.lightPos.xyz, (float3x3) ubo.modelview);
    output.LightVec = lPos - pos.xyz;
    output.ViewVec = -pos.xyz;
    return output;
}

float4 instancing_ps(VSOutput input) : SV_TARGET
{
    float4 color = t_Rocks.Sample(s_Color, input.UV) * float4(input.Color, 1.0);
    float3 N = normalize(input.Normal);
    float3 L = normalize(input.LightVec);
    float3 V = normalize(input.ViewVec);
    float3 R = reflect(-L, N);
    float3 diffuse = max(dot(N, L), 0.1) * input.Color;
    float3 specular = (dot(N, L) > 0.0) ? pow(max(dot(R, V), 0.0), 16.0) * float3(0.75, 0.75, 0.75) * color.r : float3(0.0, 0.0, 0.0);
    return float4(diffuse * color.rgb + specular, 1.0);
}

// --- Planet ----------------------------------------------------------------------------------

struct PlanetVSInput
{
    float3 Pos : POSITION;
    float3 Normal : NORMAL;
    float2 UV : TEXCOORD;
};

VSOutput planet_vs(PlanetVSInput input)
{
    VSOutput output = (VSOutput) 0;
    output.Color = float3(1.0, 1.0, 1.0);
    output.UV = float3(input.UV * float2(10.0, 6.0), 0.0);
    output.Pos = mul(mul(float4(input.Pos.xyz, 1.0), ubo.modelview), ubo.projection);

    float4 pos = mul(float4(input.Pos, 1.0), ubo.modelview);
    output.Normal = mul(input.Normal, (float3x3) ubo.modelview);
    float3 lPos = mul(ubo.lightPos.xyz, (float3x3) ubo.modelview);
    output.LightVec = lPos - pos.xyz;
    output.ViewVec = -pos.xyz;
    return output;
}

float4 planet_ps(VSOutput input) : SV_TARGET
{
    float4 color = t_Planet.Sample(s_Color, input.UV.xy) * float4(input.Color, 1.0) * 1.5;
    float3 N = normalize(input.Normal);
    float3 L = normalize(input.LightVec);
    float3 V = normalize(input.ViewVec);
    float3 R = reflect(-L, N);
    float3 diffuse = max(dot(N, L), 0.0) * input.Color;
    float3 specular = pow(max(dot(R, V), 0.0), 4.0) * float3(0.5, 0.5, 0.5) * color.r;
    return float4(diffuse * color.rgb + specular, 1.0);
}

// --- Star field ------------------------------------------------------------------------------

#define HASHSCALE3 float3(443.897, 441.423, 437.195)
#define STARFREQUENCY 0.01

// Hash function by Dave Hoskins (https://www.shadertoy.com/view/4djSRW)
float hash33(float3 p3)
{
    p3 = frac(p3 * HASHSCALE3);
    p3 += dot(p3, p3.yxz + float3(19.19, 19.19, 19.19));
    return frac((p3.x + p3.y) * p3.z + (p3.x + p3.z) * p3.y + (p3.y + p3.z) * p3.x);
}

float3 starField(float3 pos)
{
    float3 color = float3(0.0, 0.0, 0.0);
    float threshhold = (1.0 - STARFREQUENCY);
    float rnd = hash33(pos);
    if (rnd >= threshhold)
    {
        float starCol = pow((rnd - threshhold) / (1.0 - threshhold), 16.0);
        color += starCol.xxx;
    }
    return color;
}

struct StarfieldVSOutput
{
    float4 Pos : SV_POSITION;
    float3 UVW : TEXCOORD0;
};

// A full screen triangle.
StarfieldVSOutput starfield_vs(uint VertexIndex : SV_VertexID)
{
    StarfieldVSOutput output = (StarfieldVSOutput) 0;
    output.UVW = float3((VertexIndex << 1) & 2, VertexIndex & 2, VertexIndex & 2);
    output.Pos = float4(output.UVW.xy * 2.0f - 1.0f, 0.0f, 1.0f);
    return output;
}

float4 starfield_ps(StarfieldVSOutput input) : SV_TARGET
{
    return float4(starField(input.UVW), 1.0);
}

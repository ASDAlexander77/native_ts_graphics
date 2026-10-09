/* Copyright (c) 2023-2024, Mobica Limited
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

// Port of Vulkan-Samples' patch_control_points shaders (tess.vert, tess.tesc, tess.tese,
// tess.frag) to Donut's bindings: triangle patches tessellated by their edges' distance from the
// camera, colored by the level. The TypeScript side gives the sample's projection with clip y
// negated for Donut's y-up clip space.

#include <donut/shaders/binding_helpers.hlsli>

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

#define PI 3.14159

cbuffer UBO : register(b0)
{
    float4x4 g_Projection;
    float4x4 g_View;
};

cbuffer UBOTessellation : register(b1)
{
    float g_TessellationFactor;
};

// The sample's push constants: where the model goes.
struct PushConstants
{
    float3 direction;
};

DECLARE_PUSH_CONSTANTS(PushConstants, g_PushConstants, 2, 0);

struct VSInput
{
    float3 pos : POSITION;
};

struct ControlPoint
{
    float4 position : POSITION;
};

// tess.vert: the model moved, then turned half a turn around x.
ControlPoint tess_vs(VSInput input)
{
    // glm's (and GLSL's) rotX[column][row]: column 1 is (0, cos, sin, 0), column 2 (0, -sin, cos, 0).
    const float4x4 rotX = float4x4(
        1.0, 0.0, 0.0, 0.0,
        0.0, cos(PI), sin(PI), 0.0,
        0.0, -sin(PI), cos(PI), 0.0,
        0.0, 0.0, 0.0, 1.0);
    ControlPoint output;
    output.position = mul(float4(input.pos + g_PushConstants.direction, 1.0f), rotX);
    return output;
}

float getTessLevel(float4 p0, float4 p1)
{
    float tessellationLevel = 0.0f;
    const float midDistance = 1.6f;
    const float shortDistance = 1.0f;

    // Calculate edge mid point
    float4 centerPoint = 0.5f * (p0 + p1);
    // Calculate vector from camera to mid point
    float4 vCam = mul(centerPoint, g_View);
    // Calculate vector for camera projection
    float4 vCamView = mul(vCam, g_Projection);
    // Calculate the vector length
    float centerDistance = length(vCamView);

    // Adjusting the size of the tessellation depending on the length of the vector
    if (centerDistance >= midDistance)
    {
        tessellationLevel = 1.0f;
    }
    else if (centerDistance >= shortDistance && centerDistance < midDistance)
    {
        tessellationLevel = g_TessellationFactor * 0.4f;
    }
    else
    {
        tessellationLevel = g_TessellationFactor;
    }

    return tessellationLevel;
}

float3 getColor(float tessellationLevel)
{
    float3 outColor = float3(0.0f, 0.0f, 0.0f);
    if (tessellationLevel == 1.0f)
    {
        outColor = float3(1.0f, 0.0f, 0.0f);        // red color
    }
    else if (tessellationLevel == g_TessellationFactor * 0.4f)
    {
        outColor = float3(0.0f, 0.0f, 1.0f);        // blue color
    }
    else if (tessellationLevel == g_TessellationFactor)
    {
        outColor = float3(0.0f, 1.0f, 0.0f);        // green color
    }
    return outColor;
}

struct TessFactors
{
    float edges[3] : SV_TessFactor;
    float inside : SV_InsideTessFactor;
};

// tess.tesc's levels: per edge by its distance, the inside level between edges 0 and 2.
TessFactors tess_constants(InputPatch<ControlPoint, 3> patch)
{
    TessFactors output;
    if (g_TessellationFactor > 1.0)
    {
        output.edges[0] = getTessLevel(patch[2].position, patch[0].position);
        output.edges[1] = getTessLevel(patch[0].position, patch[1].position);
        output.edges[2] = getTessLevel(patch[1].position, patch[2].position);
        output.inside = lerp(output.edges[0], output.edges[2], 0.5);
    }
    else
    {
        output.edges[0] = 1;
        output.edges[1] = 1;
        output.edges[2] = 1;
        output.inside = 1;
    }
    return output;
}

struct HullOutput
{
    float4 position : POSITION;
    float3 color : COLOR;
};

// tess.tesc's control points: passed on, each with the color of the patch's first outer level.
[domain("tri")]
[partitioning("integer")]
[outputtopology("triangle_cw")]
[outputcontrolpoints(3)]
[patchconstantfunc("tess_constants")]
HullOutput tess_hs(InputPatch<ControlPoint, 3> patch, uint id : SV_OutputControlPointID)
{
    const float outer0 = g_TessellationFactor > 1.0 ? getTessLevel(patch[2].position, patch[0].position) : 1.0;
    HullOutput output;
    output.position = patch[id].position;
    output.color = getColor(outer0);
    return output;
}

struct DSOutput
{
    float4 position : SV_Position;
    float4 color : COLOR;
};

// tess.tese
[domain("tri")]
DSOutput tess_ds(TessFactors factors, float3 tessCoord : SV_DomainLocation,
    const OutputPatch<HullOutput, 3> patch)
{
    float4 pos = tessCoord.x * patch[0].position + tessCoord.y * patch[1].position + tessCoord.z * patch[2].position;
    DSOutput output;
    output.position = mul(mul(pos, g_View), g_Projection);
    output.color = float4(patch[0].color, 1.0f);
    return output;
}

// tess.frag
float4 tess_ps(DSOutput input) : SV_Target
{
    return input.color;
}

/* Copyright (c) 2024, Qualcomm Innovation Center, Inc. All rights reserved.
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

// Port of Vulkan-Samples' mobile_nerf forward shaders (raster.vert, merged_morpheus.frag, after
// Google's MobileNeRF) to Donut's bindings: the meshes' feature textures run through each model's
// small MLP per pixel. The TypeScript side gives the sample's projection with clip y negated for
// Donut's y-up clip space, so the picture lands as the sample's does.

// The matrices come in glm's layout (columns): read as row-major, they're for mul(vector, matrix).
#pragma pack_matrix(row_major)

cbuffer c_Global : register(b0)
{
    float4x4 g_Model;
    float4x4 g_View;
    float4x4 g_Proj;
    float3 g_CameraPosition;
    float3 g_CameraSide;
    float3 g_CameraUp;
    float3 g_CameraLookat;
    float2 g_ImgDim;
};

#define WEIGHTS_0_COUNT (176)
#define WEIGHTS_1_COUNT (256)
// The third layer's size is changed from 48 to 64 to make sure a 16 bytes alignement
#define WEIGHTS_2_COUNT (64)
#define BIAS_0_COUNT (16)
#define BIAS_1_COUNT (16)
// The third layer bias' size is changed from 3 to 4 to make sure a 16 bytes alignement
#define BIAS_2_COUNT (4)

// The model's MLP: its three layers' weights, then their biases.
cbuffer c_Weights : register(b1)
{
    float4 g_Weights[(WEIGHTS_0_COUNT + WEIGHTS_1_COUNT + WEIGHTS_2_COUNT + BIAS_0_COUNT + BIAS_1_COUNT + BIAS_2_COUNT) / 4];
};

Texture2D t_Feature0 : register(t0);
Texture2D t_Feature1 : register(t1);
SamplerState s_Feature : register(s0);

struct VSInput
{
    float3 position : POSITION;
    float2 texCoord : TEXCOORD;
    float3 posOffset : INSTANCE_OFFSET;
};

struct VSOutput
{
    float4 position : SV_Position;
    float2 texCoord : TEXCOORD0;
    float3 rayDirection : TEXCOORD1;
};

// raster.vert: the instance's copy of the mesh (y flipped), and the ray from the camera's position
// (as the framework keeps it: the view's translation) to it.
VSOutput raster_vs(VSInput input)
{
    VSOutput output;
    // The framework's loader flips the texture coordinates' v.
    output.texCoord = float2(input.texCoord.x, 1.0 - input.texCoord.y);
    float3 pos = input.position + input.posOffset;
    output.position = mul(mul(mul(float4(pos.x, -pos.y, pos.z, 1.0), g_Model), g_View), g_Proj);
    output.rayDirection = pos - float3(g_CameraPosition.x, -g_CameraPosition.y, g_CameraPosition.z);
    return output;
}

float3 evaluateNetwork(float4 f0, float4 f1, float4 viewdir)
{
    const int bias_0_ind = WEIGHTS_0_COUNT + WEIGHTS_1_COUNT + WEIGHTS_2_COUNT;
    float4 intermediate_one[4] = {
        g_Weights[bias_0_ind / 4],
        g_Weights[bias_0_ind / 4 + 1],
        g_Weights[bias_0_ind / 4 + 2],
        g_Weights[bias_0_ind / 4 + 3]
    };
    // For models form original mobile nerf, use the original code
    const float inputs[11] = {
        f0.r, f0.g, f0.b, f0.a, f1.r, f1.g, f1.b, f1.a,
        (viewdir.r + 1.0) / 2, (-viewdir.b + 1.0) / 2, (viewdir.g + 1.0) / 2
    };
    [unroll]
    for (int i = 0; i < 11; i++)
    {
        [unroll]
        for (int j = 0; j < 4; j++)
        {
            intermediate_one[j] += inputs[i] * g_Weights[i * 4 + j];
        }
    }

    const int bias_1_ind = WEIGHTS_0_COUNT + WEIGHTS_1_COUNT + WEIGHTS_2_COUNT + BIAS_0_COUNT;
    float4 intermediate_two[4] = {
        g_Weights[bias_1_ind / 4],
        g_Weights[bias_1_ind / 4 + 1],
        g_Weights[bias_1_ind / 4 + 2],
        g_Weights[bias_1_ind / 4 + 3]
    };
    [unroll]
    for (int oneInd = 0; oneInd < 16; oneInd++)
    {
        const float intermediate = intermediate_one[oneInd / 4][oneInd % 4];
        if (intermediate > 0.0f)
        {
            [unroll]
            for (int j = 0; j < 4; j++)
            {
                intermediate_two[j] += intermediate * g_Weights[WEIGHTS_0_COUNT / 4 + oneInd * 4 + j];
            }
        }
    }

    const int bias_2_ind = WEIGHTS_0_COUNT + WEIGHTS_1_COUNT + WEIGHTS_2_COUNT + BIAS_0_COUNT + BIAS_1_COUNT;
    float4 result = g_Weights[bias_2_ind / 4];
    [unroll]
    for (int twoInd = 0; twoInd < 16; twoInd++)
    {
        const float intermediate = intermediate_two[twoInd / 4][twoInd % 4];
        if (intermediate > 0.0f)
        {
            result += intermediate * g_Weights[WEIGHTS_0_COUNT / 4 + WEIGHTS_1_COUNT / 4 + twoInd];
        }
    }
    result = 1.0 / (1.0 + exp(-result));
    return result.rgb * viewdir.a + (1.0 - viewdir.a);
}

// MLP was trained with gamma-corrected values: convert to linear so sRGB conversion isn't applied
// twice.
float Convert_sRGB_ToLinear(float value)
{
    return value <= 0.04045
        ? value / 12.92
        : pow((value + 0.055) / 1.055, 2.4);
}

float3 Convert_sRGB_ToLinear(float3 value)
{
    return float3(Convert_sRGB_ToLinear(value.x), Convert_sRGB_ToLinear(value.y), Convert_sRGB_ToLinear(value.z));
}

// merged_morpheus.frag
float4 merged_ps(VSOutput input) : SV_Target
{
    const float2 flipped = float2(input.texCoord.x, 1.0 - input.texCoord.y);
    float4 feature_0 = t_Feature0.Sample(s_Feature, flipped);
    float4 feature_1 = t_Feature1.Sample(s_Feature, flipped);
    float4 rayDirection = float4(normalize(input.rayDirection), 1.0f);

    // deal with iphone
    feature_0.a = feature_0.a * 2.0 - 1.0;
    feature_1.a = feature_1.a * 2.0 - 1.0;
    rayDirection.a = rayDirection.a * 2.0 - 1.0;

    return float4(Convert_sRGB_ToLinear(evaluateNetwork(feature_0, feature_1, rayDirection)), 1.0);
}

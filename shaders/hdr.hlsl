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

// Port of Vulkan-Samples' hdr shaders (gbuffer.vert/frag, composition.vert/frag, bloom.vert/frag)
// to Donut's bindings, in one file. The sample's specialization constants (the gbuffer shaders'
// type, the bloom shader's dir) become entry points. Positions and directions are in the sample's
// world and view spaces (view y down on the screen, -z forward); its projection, which the
// TypeScript side sets up, flips y for Donut's y-up clip space.

// Donut's matrices are row-major, for mul(vector, matrix).
#pragma pack_matrix(row_major)

// --- G-buffer: skybox and reflecting object, into two float targets ----------------------------

struct UBOMatrices
{
    float4x4 projection;
    float4x4 modelview;
    float4x4 skyboxModelview;
    float4x4 inverseModelview;
    float modelscale;
};

cbuffer c_Matrices : register(b0)
{
    UBOMatrices uboMatrices;
};

struct UBOParams
{
    float exposure;
};

cbuffer c_Params : register(b1)
{
    UBOParams ubo;
};

TextureCube t_EnvMap : register(t0);
SamplerState s_EnvMap : register(s0);

struct GBufferVSInput
{
    float3 Pos : POSITION;
    float3 Normal : NORMAL;
};

struct GBufferVSOutput
{
    float4 Pos : SV_POSITION;
    float3 UVW : TEXCOORD0;
    float3 ViewPos : TEXCOORD1;
    float3 Normal : NORMAL;
    float3 ViewVec : TEXCOORD2;
    float3 LightVec : TEXCOORD3;
};

struct GBufferPSOutput
{
    float4 Color0 : SV_Target0;
    float4 Color1 : SV_Target1;
};

static const int TYPE_SKYBOX = 0;
static const int TYPE_REFLECT = 1;

GBufferVSOutput gbuffer_vs(GBufferVSInput input, int type)
{
    GBufferVSOutput output = (GBufferVSOutput) 0;
    output.UVW = input.Pos;

    switch (type)
    {
        case TYPE_SKYBOX:
            output.ViewPos = mul(input.Pos, (float3x3) uboMatrices.skyboxModelview);
            output.Pos = mul(float4(output.ViewPos, 1.0), uboMatrices.projection);
            break;
        case TYPE_REFLECT:
            output.ViewPos = mul(float4(input.Pos * uboMatrices.modelscale, 1.0), uboMatrices.modelview).xyz;
            output.Pos = mul(mul(float4(input.Pos * uboMatrices.modelscale, 1.0), uboMatrices.modelview), uboMatrices.projection);
            break;
    }
    output.Normal = mul(input.Normal, (float3x3) uboMatrices.modelview);

    float3 lightPos = float3(0.0f, -5.0f, 5.0f);
    output.LightVec = lightPos.xyz - output.ViewPos.xyz;
    output.ViewVec = -output.ViewPos.xyz;
    return output;
}

GBufferPSOutput gbuffer_ps(GBufferVSOutput input, int type)
{
    GBufferPSOutput output = (GBufferPSOutput) 0;
    float4 color = float4(0.0, 0.0, 0.0, 0.0);

    switch (type)
    {
        case TYPE_SKYBOX:
        {
            float3 normal = normalize(input.UVW);
            color = t_EnvMap.Sample(s_EnvMap, normal);
        }
        break;

        case TYPE_REFLECT:
        {
            float3 wViewVec = mul(normalize(input.ViewVec), (float3x3) uboMatrices.inverseModelview);
            float3 normal = normalize(input.Normal);
            float3 wNormal = mul(normal, (float3x3) uboMatrices.inverseModelview);

            float NdotL = max(dot(normal, input.LightVec), 0.0);

            float3 eyeDir = normalize(input.ViewVec);
            float3 halfVec = normalize(input.LightVec + eyeDir);
            float NdotH = max(dot(normal, halfVec), 0.0);
            float NdotV = max(dot(normal, eyeDir), 0.0);
            float VdotH = max(dot(eyeDir, halfVec), 0.0);

            // Geometric attenuation
            float NH2 = 2.0 * NdotH;
            float g1 = (NH2 * NdotV) / VdotH;
            float g2 = (NH2 * NdotL) / VdotH;
            float geoAtt = min(1.0, min(g1, g2));

            const float F0 = 0.6;
            const float k = 0.2;

            // Fresnel (schlick approximation)
            float fresnel = pow(1.0 - VdotH, 5.0);
            fresnel *= (1.0 - F0);
            fresnel += F0;

            // Note: clamp to zero to mitigate any divide by zero
            float spec = max((fresnel * geoAtt) / (NdotV * NdotL * 3.14), 0.0);

            color = t_EnvMap.Sample(s_EnvMap, reflect(-wViewVec, wNormal));

            color = float4(color.rgb * NdotL * (k + spec * (1.0 - k)), 1.0);
        }
        break;
    }

    // Color with manual exposure into attachment 0
    output.Color0.rgb = float3(1.0, 1.0, 1.0) - exp(-color.rgb * ubo.exposure);

    // Bright parts for bloom into attachment 1
    float l = dot(output.Color0.rgb, float3(0.2126, 0.7152, 0.0722));
    float threshold = 0.75;
    output.Color1.rgb = (l > threshold) ? output.Color0.rgb : float3(0.0, 0.0, 0.0);
    output.Color1.a = 1.0;
    return output;
}

GBufferVSOutput skybox_vs(GBufferVSInput input)
{
    return gbuffer_vs(input, TYPE_SKYBOX);
}

GBufferPSOutput skybox_ps(GBufferVSOutput input)
{
    return gbuffer_ps(input, TYPE_SKYBOX);
}

GBufferVSOutput reflect_vs(GBufferVSInput input)
{
    return gbuffer_vs(input, TYPE_REFLECT);
}

GBufferPSOutput reflect_ps(GBufferVSOutput input)
{
    return gbuffer_ps(input, TYPE_REFLECT);
}

// --- Full screen passes: composition and bloom -------------------------------------------------

// The composition reads the scene from t0; the bloom passes read t1 (the bright parts, or the
// first pass's result).
Texture2D t_Color0 : register(t0);
Texture2D t_Color1 : register(t1);
SamplerState s_Color : register(s0);

struct FullscreenVSOutput
{
    float4 Pos : SV_POSITION;
    float2 UV : TEXCOORD0;
};

FullscreenVSOutput fullscreen_vs(uint VertexIndex : SV_VertexID)
{
    FullscreenVSOutput output = (FullscreenVSOutput) 0;
    output.UV = float2((VertexIndex << 1) & 2, VertexIndex & 2);
    // The sample's clip space has y down (Vulkan's), Donut's y up: uv (0, 0) stays at the top left.
    output.Pos = float4(output.UV.x * 2.0f - 1.0f, 1.0f - output.UV.y * 2.0f, 0.0f, 1.0f);
    return output;
}

float4 composition_ps(FullscreenVSOutput input) : SV_Target
{
    return t_Color0.Sample(s_Color, input.UV);
}

float4 bloom(float2 inUV, int dir)
{
    // From the OpenGL Super bible
    const float weights[] = {   0.0024499299678342,
                                0.0043538453346397,
                                0.0073599963704157,
                                0.0118349786570722,
                                0.0181026699707781,
                                0.0263392293891488,
                                0.0364543006660986,
                                0.0479932050577658,
                                0.0601029809166942,
                                0.0715974486241365,
                                0.0811305381519717,
                                0.0874493212267511,
                                0.0896631113333857,
                                0.0874493212267511,
                                0.0811305381519717,
                                0.0715974486241365,
                                0.0601029809166942,
                                0.0479932050577658,
                                0.0364543006660986,
                                0.0263392293891488,
                                0.0181026699707781,
                                0.0118349786570722,
                                0.0073599963704157,
                                0.0043538453346397,
                                0.0024499299678342};

    const float blurScale = 0.003;
    const float blurStrength = 1.0;

    float ar = 1.0;
    // Aspect ratio for vertical blur pass
    if (dir == 1)
    {
        float2 ts;
        t_Color1.GetDimensions(ts.x, ts.y);
        ar = ts.y / ts.x;
    }

    // Each pass reads its source transposed (uv.yx), so the second pass undoes the first's
    // transposition, blurring along the other axis.
    float2 P = inUV.yx - float2(0, (25 >> 1) * ar * blurScale);

    float4 color = float4(0.0, 0.0, 0.0, 0.0);
    for (int i = 0; i < 25; i++)
    {
        float2 dv = float2(0.0, i * blurScale) * ar;
        color += t_Color1.Sample(s_Color, P + dv) * weights[i] * blurStrength;
    }

    return color;
}

// The first bloom pass (dir 0): the bright parts, into the filter target.
float4 bloom_filter_ps(FullscreenVSOutput input) : SV_Target
{
    return bloom(input.UV, 0);
}

// The second bloom pass (dir 1): the filter target, added over the composition.
float4 bloom_composite_ps(FullscreenVSOutput input) : SV_Target
{
    return bloom(input.UV, 1);
}

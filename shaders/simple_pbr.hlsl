//--------------------------------------------------------------------------------------
// SimplePBR: the PBR effect
//
// Advanced Technology Group (ATG)
// Copyright (C) Microsoft Corporation. All rights reserved.
//--------------------------------------------------------------------------------------

// The Xbox ATG SimplePBR12_UWP sample's PBREffect (Kits/ATGTK/PBREffect: PBREffect_Common.hlsli,
// PBREffect_Math.hlsli, VSConstant and PSTextured) on Donut's bindings. Port: the constant
// buffer's packoffsets are written out as members (with the padding they imply).

// --- PBREffect_Common.hlsli ------------------------------------------------------------------

Texture2D<float4> PBR_AlbedoTexture     : register(t0);
Texture2D<float3> PBR_NormalTexture     : register(t1);
Texture2D<float3> PBR_RMATexture        : register(t2);
TextureCube<float3> PBR_RadianceTexture   : register(t3);
TextureCube<float3> PBR_IrradianceTexture : register(t4);

sampler PBR_SurfaceSampler : register(s0);
sampler PBR_IBLSampler     : register(s1);

cbuffer PBR_Constants : register(b0)
{
    float3   PBR_EyePosition;                // c0
    float4x4 PBR_World;                      // c1
    float3x3 PBR_WorldInverseTranspose;      // c5
    float4x4 PBR_WorldViewProj;              // c8
    float4x4 PBR_PrevWorldViewProj;          // c12

    float3 PBR_LightDirection[3];            // c16
    float3 PBR_LightColor[3];                // c19   // "Specular and diffuse light" in PBR

    float3 PBR_ConstantAlbedo;               // c22   // Constant values if not a textured effect
    float  PBR_Padding;
    float  PBR_ConstantMetallic;             // c23.x
    float  PBR_ConstantRoughness;            // c23.y

    int PBR_NumRadianceMipLevels;            // c23.z

    // Size of render target
    float PBR_TargetWidth;                   // c23.w
    float PBR_TargetHeight;                  // c24.x
};

// Vertex formats
// Port: POSITION (the sample's SV_Position input semantic).
struct VSInputNmTxTangent
{
    float4 Position : POSITION;
    float3 Normal   : NORMAL;
    float4 Tangent  : TANGENT;
    float2 TexCoord : TEXCOORD0;
};

struct VSOutputPixelLightingTxTangent
{
    float2 TexCoord   : TEXCOORD0;
    float4 PositionWS : TEXCOORD1;
    float3 NormalWS   : TEXCOORD2;
    float3 TangentWS  : TEXCOORD3;
    float4 Diffuse    : COLOR0;
    float4 PositionPS : SV_Position;
};

struct PSInputPixelLightingTxTangent
{
    float2 TexCoord   : TEXCOORD0;
    float4 PositionWS : TEXCOORD1;
    float3 NormalWS   : TEXCOORD2;
    float3 TangentWS  : TEXCOORD3;
    float4 Diffuse    : COLOR0;
};


// Common vertex shader code
struct CommonVSOutputPixelLighting
{
    float4 Pos_ps;
    float3 Pos_ws;
    float3 Normal_ws;
};

CommonVSOutputPixelLighting ComputeCommonVSOutputPixelLighting(float4 position, float3 normal, float4x4 world, float4x4 worldViewProj, float3x3 worldInverseT)
{
    CommonVSOutputPixelLighting vout;

    vout.Pos_ps = mul(position, worldViewProj);
    vout.Pos_ws = mul(position, world).xyz;
    vout.Normal_ws = normalize(mul(normal, worldInverseT));

    return vout;
}

// --- PBREffect_Math.hlsli --------------------------------------------------------------------

static const float PI = 3.14159265f;
static const float EPSILON = 1e-6f;

float3 BiasX2(float3 x)
{
    return 2.f * x - 1.f;
}

// Given a local normal, transform it into a tangent space given by surface normal and tangent
float3 PeturbNormal(float3 localNormal, float3 surfaceNormalWS, float3 surfaceTangentWS)
{
    float3 normal = normalize(surfaceNormalWS);
    float3 tangent = normalize(surfaceTangentWS);
    float3 binormal = cross(normal, tangent);     // reconstructed from normal & tangent
    float3x3 TBN = { tangent, binormal, normal }; // world "frame" for local normal

    return mul(localNormal, TBN);                // transform to local to world (tangent space)
}

// Normal z component reconstruction for supporting BC5
float3 TwoChannelNormalX2(float2 normal)
{
    float2 xy = 2.0f * normal - 1.0f;
    float z = sqrt(1 - dot(xy, xy));
    return float3(xy.x, xy.y, z);
}

// Shlick's approximation of Fresnel
// https://en.wikipedia.org/wiki/Schlick%27s_approximation
float3 Fresnel_Shlick(in float3 f0, in float3 f90, in float x)
{
    return f0 + (f90 - f0) * pow(1.f - x, 5.f);
}

// Burley B. "Physically Based Shading at Disney"
// SIGGRAPH 2012 Course: Practical Physically Based Shading in Film and Game Production, 2012.
float Diffuse_Burley(in float NdotL, in float NdotV, in float LdotH, in float roughness)
{
    float fd90 = 0.5f + 2.f * roughness * LdotH * LdotH;
    return Fresnel_Shlick(1, fd90, NdotL).x * Fresnel_Shlick(1, fd90, NdotV).x;
}

// GGX specular D (normal distribution)
// https://www.cs.cornell.edu/~srm/publications/EGSR07-btdf.pdf
float Specular_D_GGX(in float alpha, in float NdotH)
{
    const float alpha2 = alpha * alpha;
    const float lower = (NdotH * NdotH * (alpha2 - 1)) + 1;
    return alpha2 / max(EPSILON, PI * lower * lower);
}

// Schlick-Smith specular G (visibility) with Hable's LdotH optimization
// http://www.cs.virginia.edu/~jdl/bib/appearance/analytic%20models/schlick94b.pdf
// http://graphicrants.blogspot.se/2013/08/specular-brdf-reference.html
float G_Shlick_Smith_Hable(float alpha, float LdotH)
{
    return rcp(lerp(LdotH * LdotH, 1, alpha * alpha * 0.25f));
}

// A microfacet based BRDF.
//
// alpha:           This is roughness * roughness as in the "Disney" PBR model by Burley et al.
//
// specularColor:   The F0 reflectance value - 0.04 for non-metals, or RGB for metals. This follows model
//                  used by Unreal Engine 4.
//
// NdotV, NdotL, LdotH, NdotH: vector relationships between,
//      N - surface normal
//      V - eye normal
//      L - light normal
//      H - half vector between L & V.
float3 Specular_BRDF(in float alpha, in float3 specularColor, in float NdotV, in float NdotL, in float LdotH, in float NdotH)
{
    // Specular D (microfacet normal distribution) component
    float specular_D = Specular_D_GGX(alpha, NdotH);

    // Specular Fresnel
    float3 specular_F = Fresnel_Shlick(specularColor, 1, LdotH);

    // Specular G (visibility) component
    float specular_G = G_Shlick_Smith_Hable(alpha, LdotH);

    return specular_D * specular_F * specular_G;
}

// Diffuse irradiance
float3 Diffuse_IBL(in float3 N)
{
    return PBR_IrradianceTexture.Sample(PBR_IBLSampler, N);
}

// Approximate specular image based lighting by sampling radiance map at lower mips
// according to roughness, then modulating by Fresnel term.
float3 Specular_IBL(in float3 N, in float3 V, in float lodBias)
{
    float mip = lodBias * PBR_NumRadianceMipLevels;
    float3 dir = reflect(-V, N);
    return PBR_RadianceTexture.SampleLevel(PBR_IBLSampler, dir, mip);
}

// --- PBREffect_Common.hlsli: PBR_LightSurface --------------------------------------------------

// Apply Disney-style physically based rendering to a surface with:
//
// V, N:             Eye and surface normals
//
// numLights:        Number of directional lights.
//
// lightColor[]:     Color and intensity of directional light.
//
// lightDirection[]: Light direction.
float3 PBR_LightSurface(
    in float3 V, in float3 N,
    in int numLights, in float3 lightColor[3], in float3 lightDirection[3],
    in float3 albedo, in float roughness, in float metallic, in float ambientOcclusion)
{
    // Specular coefficiant - fixed reflectance value for non-metals
    static const float kSpecularCoefficient = 0.04;

    const float NdotV = saturate(dot(N, V));

    // Burley roughness bias
    const float alpha = roughness * roughness;

    // Blend base colors
    const float3 c_diff = lerp(albedo, float3(0, 0, 0), metallic)       * ambientOcclusion;
    const float3 c_spec = lerp(kSpecularCoefficient, albedo, metallic)  * ambientOcclusion;

    // Output color
    float3 acc_color = 0;

    // Accumulate light values
    for (int i = 0; i < numLights; i++)
    {
        // light vector (to light)
        const float3 L = normalize(-lightDirection[i]);

        // Half vector
        const float3 H = normalize(L + V);

        // products
        const float NdotL = saturate(dot(N, L));
        const float LdotH = saturate(dot(L, H));
        const float NdotH = saturate(dot(N, H));

        // Diffuse & specular factors
        float diffuse_factor = Diffuse_Burley(NdotL, NdotV, LdotH, roughness);
        float3 specular      = Specular_BRDF(alpha, c_spec, NdotV, NdotL, LdotH, NdotH);

        // Directional light
        acc_color += NdotL * lightColor[i] * (((c_diff * diffuse_factor) + specular));
    }

    // Add diffuse irradiance
    float3 diffuse_env = Diffuse_IBL(N);
    acc_color += c_diff * diffuse_env;

    // Add specular radiance
    float3 specular_env = Specular_IBL(N, V, roughness);
    acc_color += c_spec * specular_env;

    return acc_color;
}

// --- PBREffect_VSConstant.hlsl ---------------------------------------------------------------

// Shared vertex shader for constant (debugging) and textured variants
VSOutputPixelLightingTxTangent pbr_vs(VSInputNmTxTangent vin)
{
    VSOutputPixelLightingTxTangent vout;

    CommonVSOutputPixelLighting cout = ComputeCommonVSOutputPixelLighting(vin.Position, vin.Normal, PBR_World, PBR_WorldViewProj, PBR_WorldInverseTranspose);

    vout.PositionPS = cout.Pos_ps;
    vout.PositionWS = float4(cout.Pos_ws, 1);
    vout.NormalWS = cout.Normal_ws;
    vout.Diffuse = float4(PBR_ConstantAlbedo, 1);
    vout.TexCoord = vin.TexCoord;
    vout.TangentWS = normalize(mul(vin.Tangent.xyz, PBR_WorldInverseTranspose));

    return vout;
}

// --- PBREffect_PSTextured.hlsl ---------------------------------------------------------------

// Pixel shader: pixel lighting + texture.
float4 pbr_ps(PSInputPixelLightingTxTangent pin) : SV_Target0
{
    // vectors
    const float3 V = normalize(PBR_EyePosition - pin.PositionWS.xyz); // view vector
    const float3 L = normalize(-PBR_LightDirection[0]);               // light vector ("to light" oppositve of light's direction)

    // Before lighting, peturb the surface's normal by the one given in normal map.
    float3 localNormal = TwoChannelNormalX2(PBR_NormalTexture.Sample(PBR_SurfaceSampler, pin.TexCoord).xy);

    float3 N = PeturbNormal( localNormal, pin.NormalWS, pin.TangentWS);

    // Get albedo, then roughness, metallic and ambient occlusion
    float4 albedo = PBR_AlbedoTexture.Sample(PBR_SurfaceSampler, pin.TexCoord);

    // glTF2 defines metalness as B channel, roughness as G channel, and occlusion as R channel
    float3 RMA = PBR_RMATexture.Sample(PBR_SurfaceSampler, pin.TexCoord);

    // Shade surface
    float3 output = PBR_LightSurface(V, N, 3, PBR_LightColor, PBR_LightDirection, albedo.rgb, RMA.g, RMA.b, RMA.r);

    return float4(output, albedo.w);
}

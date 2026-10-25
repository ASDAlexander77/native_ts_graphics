/*
* Donut's forward_ps.hlsl (Copyright (c) 2014-2024, NVIDIA CORPORATION. All rights reserved., under the
* MIT license of Donut: the permission notice is in external/Donut/LICENSE.txt), with hair shaded by
* NVIDIA's RTX Character Rendering far-field hair BCSDF where a material is hair.
*
* This software contains source code provided by NVIDIA Corporation: it includes the headers of the
* RTXCR checkout's material library (RTXCR_DIR), which is under the NVIDIA RTX SDKs License.
*/

#pragma pack_matrix(row_major)

#include <donut/shaders/forward_cb.h>

// Declare the constants that drive material bindings in 'material_bindings.hlsli'
// to match the bindings explicitly declared in 'forward_cb.h'.

#define MATERIAL_REGISTER_SPACE     FORWARD_SPACE_MATERIAL
#define MATERIAL_CB_SLOT            FORWARD_BINDING_MATERIAL_CONSTANTS
#define MATERIAL_DIFFUSE_SLOT       FORWARD_BINDING_MATERIAL_DIFFUSE_TEXTURE
#define MATERIAL_SPECULAR_SLOT      FORWARD_BINDING_MATERIAL_SPECULAR_TEXTURE
#define MATERIAL_NORMALS_SLOT       FORWARD_BINDING_MATERIAL_NORMAL_TEXTURE
#define MATERIAL_EMISSIVE_SLOT      FORWARD_BINDING_MATERIAL_EMISSIVE_TEXTURE
#define MATERIAL_OCCLUSION_SLOT     FORWARD_BINDING_MATERIAL_OCCLUSION_TEXTURE
#define MATERIAL_TRANSMISSION_SLOT  FORWARD_BINDING_MATERIAL_TRANSMISSION_TEXTURE
#define MATERIAL_OPACITY_SLOT       FORWARD_BINDING_MATERIAL_OPACITY_TEXTURE

#define MATERIAL_SAMPLER_REGISTER_SPACE FORWARD_SPACE_SHADING
#define MATERIAL_SAMPLER_SLOT           FORWARD_BINDING_MATERIAL_SAMPLER

#include <donut/shaders/scene_material.hlsli>
#include <donut/shaders/material_bindings.hlsli>
#include <donut/shaders/forward_vertex.hlsli>
#include <donut/shaders/lighting.hlsli>
#include <donut/shaders/shadows.hlsli>
#include <donut/shaders/binding_helpers.hlsli>

#include <rtxcr/HairFarFieldBCSDF.hlsli>

DECLARE_CBUFFER(ForwardShadingViewConstants, g_ForwardView, FORWARD_BINDING_VIEW_CONSTANTS,         FORWARD_SPACE_VIEW);
DECLARE_CBUFFER(ForwardShadingLightConstants, g_ForwardLight, FORWARD_BINDING_LIGHT_CONSTANTS,      FORWARD_SPACE_SHADING);

Texture2DArray t_ShadowMapArray       : REGISTER_SRV(FORWARD_BINDING_SHADOW_MAP_TEXTURE,            FORWARD_SPACE_SHADING);
TextureCubeArray t_DiffuseLightProbe  : REGISTER_SRV(FORWARD_BINDING_DIFFUSE_LIGHT_PROBE_TEXTURE,   FORWARD_SPACE_SHADING);
TextureCubeArray t_SpecularLightProbe : REGISTER_SRV(FORWARD_BINDING_SPECULAR_LIGHT_PROBE_TEXTURE,  FORWARD_SPACE_SHADING);
Texture2D t_EnvironmentBrdf           : REGISTER_SRV(FORWARD_BINDING_ENVIRONMENT_BRDF_TEXTURE,      FORWARD_SPACE_SHADING);

SamplerState s_ShadowSampler          : REGISTER_SAMPLER(FORWARD_BINDING_SHADOW_MAP_SAMPLER,        FORWARD_SPACE_SHADING);
SamplerState s_LightProbeSampler      : REGISTER_SAMPLER(FORWARD_BINDING_LIGHT_PROBE_SAMPLER,       FORWARD_SPACE_SHADING);
SamplerState s_BrdfSampler            : REGISTER_SAMPLER(FORWARD_BINDING_ENVIRONMENT_BRDF_SAMPLER,  FORWARD_SPACE_SHADING);

float3 GetIncidentVector(float4 directionOrPosition, float3 surfacePos)
{
    if (directionOrPosition.w > 0)
        return normalize(surfacePos.xyz - directionOrPosition.xyz);
    else
        return directionOrPosition.xyz;
}

// The hair of the path tracer's default material (the UI's defaults): the physics absorption model,
// the Fresnel approximation of the sample (not the analytical one).
static const uint HAIR_ABSORPTION_MODEL = RTXCR_HairAbsorptionModel_Physics;
static const uint HAIR_FRESNEL_APPROXIMATION = 1;
// How much of the sky reaches a strand inside the hair: the path tracer's strands shadow each other, the
// shadow map can't resolve that, so the sky's light is scaled by this (a look, not a measurement).
static const float HAIR_SKY_VISIBILITY = 0.5;
// How fast a light falls off through hair, per world unit (centimetres) of it: in the path
// tracer the strands nearest the sun shadow those behind them.
static const float HAIR_SHADOW_DENSITY = 4.0;
// The texels around a point that its light through the hair is the average of, (2 * radius + 1)^2:
// the strands are thinner than one.
static const int HAIR_SHADOW_FILTER_RADIUS = 2;

// The share of the light that reaches surfacePos through the hair, from a per-object shadow of the head and
// the hair: the shadow map holds the depth of the first surface the light meets, and the light has passed
// through the hair for the depth beyond it, falling off exponentially (TressFX's approximation of a deep
// shadow map). Unlike a depth comparison, the strands behind the outermost ones are lit, less and less.
float LightThroughHair(ShadowConstants shadow, float3 lightDirection, float3 surfacePos)
{
    const float4 uvzw = mul(float4(surfacePos, 1.0), shadow.matWorldToUvzwShadow);
    if (any(uvzw.xy < 0.0) || any(uvzw.xy > 1.0))
        return 1.0;
    // The shadow map's depth over a world unit along the light (an orthographic projection: the same everywhere).
    const float depthPerWorldUnit = abs(mul(float4(lightDirection, 0.0), shadow.matWorldToUvzwShadow).z);
    const int2 size = int2(shadow.shadowMapSizeTexels);
    const int2 center = int2(uvzw.xy * shadow.shadowMapSizeTexels);

    float sum = 0;
    for (int y = -HAIR_SHADOW_FILTER_RADIUS; y <= HAIR_SHADOW_FILTER_RADIUS; y++)
    {
        for (int x = -HAIR_SHADOW_FILTER_RADIUS; x <= HAIR_SHADOW_FILTER_RADIUS; x++)
        {
            const int2 texel = clamp(center + int2(x, y), 0, size - 1);
            const float occluderDepth = t_ShadowMapArray.Load(int4(texel, shadow.shadowMapArrayIndex, 0)).r;
            const float hairDepth = max(uvzw.z - occluderDepth, 0.0) / depthPerWorldUnit;
            sum += exp(-hairDepth * HAIR_SHADOW_DENSITY);
        }
    }
    const int width = 2 * HAIR_SHADOW_FILTER_RADIUS + 1;
    return sum / float(width * width);
}

bool IsHairMaterial(uint flags)
{
    return (flags & MaterialFlags_Hair) != 0;
}

// The far-field hair BCSDF for light arriving along the world direction vectorToLight (pointing to the light),
// seen along viewVector (pointing to the camera): a strand has no surface to light, so the BCSDF takes the
// strand's tangent and the two directions in the frame of the tangent and the normal (the path tracer's
// way). It includes the cosine, so it is what a radiance of 1 from that direction gives.
float3 EvalHair(MaterialSample surfaceMaterial, float3 normal, float3 tangent, float3 viewVector, float3 vectorToLight)
{
    RTXCR_HairMaterialData hair;
    hair.baseColor = surfaceMaterial.hairParams.baseColor;
    hair.longitudinalRoughness = surfaceMaterial.hairParams.longitudinalRoughness;
    hair.azimuthalRoughness = surfaceMaterial.hairParams.azimuthalRoughness;
    hair.ior = surfaceMaterial.hairParams.ior;
    hair.eta = 1.0f / hair.ior;
    hair.fresnelApproximation = HAIR_FRESNEL_APPROXIMATION;
    hair.absorptionModel = HAIR_ABSORPTION_MODEL;
    hair.melanin = surfaceMaterial.hairParams.melanin;
    hair.melaninRedness = surfaceMaterial.hairParams.melaninRedness;
    hair.cuticleAngleInDegrees = surfaceMaterial.hairParams.cuticleAngle;

    const float3 biTangent = cross(normal, tangent);
    const float3x3 tangentBasis = float3x3(tangent, biTangent, normal);

    RTXCR_HairInteractionSurface surface;
    surface.incidentRayDirection = mul(tangentBasis, viewVector);
    surface.shadingNormal = float3(0.0f, 0.0f, 1.0f);
    surface.tangent = float3(1.0f, 0.0f, 0.0f);

    const RTXCR_HairMaterialInteractionBcsdf interaction = RTXCR_CreateHairMaterialInteractionBcsdf(hair,
        surfaceMaterial.hairParams.diffuseReflectionTint, surfaceMaterial.hairParams.diffuseReflectionWeight,
        hair.longitudinalRoughness);

    float3 bsdfSpecular = 0;
    float3 bsdfDiffuse = 0;
    float pdf = 0;
    RTXCR_HairFarFieldBcsdfEval(surface, interaction, mul(tangentBasis, vectorToLight), surface.incidentRayDirection,
        bsdfSpecular, bsdfDiffuse, pdf);

    return pdf > 0.0f ? bsdfSpecular + bsdfDiffuse : 0;
}

// The hair under the sky: the BCSDF against the sky's light from six directions (the axes), each standing for
// a sixth of the sphere, in place of the path tracer's environment lighting.
float3 HairAmbient(MaterialSample surfaceMaterial, float3 normal, float3 tangent, float3 viewVector, float3 skyBottom, float3 skyTop)
{
    float3 sum = 0;
    [unroll]
    for (int axis = 0; axis < 3; axis++)
    {
        [unroll]
        for (int sign = -1; sign <= 1; sign += 2)
        {
            float3 direction = 0;
            direction[axis] = sign;
            const float3 radiance = lerp(skyBottom, skyTop, direction.y * 0.5 + 0.5);
            sum += EvalHair(surfaceMaterial, normal, tangent, viewVector, direction) * radiance;
        }
    }
    return sum * (HAIR_SKY_VISIBILITY * 4.0 * 3.14159265 / 6.0);
}

void main(
    in float4 i_position : SV_Position,
    in SceneVertex i_vtx,
    in bool i_isFrontFace : SV_IsFrontFace,
    VK_LOCATION_INDEX(0, 0) out float4 o_color : SV_Target0
#if TRANSMISSIVE_MATERIAL
    , VK_LOCATION_INDEX(0, 1) out float4 o_backgroundBlendFactor : SV_Target1
#endif
)
{
    MaterialTextureSample textures = SampleMaterialTexturesAuto(i_vtx.texCoord, g_Material.normalTextureTransformScale);

    MaterialSample surfaceMaterial = EvaluateSceneMaterial(i_vtx.normal, i_vtx.tangent, g_Material, textures);
    float3 surfaceWorldPos = i_vtx.pos;

    if (!i_isFrontFace)
        surfaceMaterial.shadingNormal = -surfaceMaterial.shadingNormal;

    if (g_Material.domain != MaterialDomain_Opaque)
        clip(surfaceMaterial.opacity - g_Material.alphaCutoff);

    float4 cameraDirectionOrPosition = g_ForwardView.view.cameraDirectionOrPosition;
    float3 viewIncident = GetIncidentVector(cameraDirectionOrPosition, surfaceWorldPos);

    const bool isHair = IsHairMaterial(g_Material.flags);
    // The strand's direction, from the tessellation; any perpendicular if it has none.
    float3 hairTangent = i_vtx.tangent.xyz;
    if (dot(hairTangent, hairTangent) < 1e-5f)
        hairTangent = cross(surfaceMaterial.shadingNormal, float3(0.0f, 1.0f, 0.0f));
    hairTangent = normalize(hairTangent);

    float3 diffuseTerm = 0;
    float3 specularTerm = 0;

    [loop]
    for(uint nLight = 0; nLight < g_ForwardLight.numLights; nLight++)
    {
        LightConstants light = g_ForwardLight.lights[nLight];

        float2 shadow = 0;
        for (int cascade = 0; cascade < 4; cascade++)
        {
            if (light.shadowCascades[cascade] >= 0)
            {
                float2 cascadeShadow = EvaluateShadowGather16(t_ShadowMapArray, s_ShadowSampler, g_ForwardLight.shadows[light.shadowCascades[cascade]], surfaceWorldPos, g_ForwardLight.shadowMapTextureSize);

                shadow = saturate(shadow + cascadeShadow * (1.0001 - shadow.y));

                if (shadow.y == 1)
                    break;
            }
            else
                break;
        }

        shadow.x += (1 - shadow.y) * light.outOfBoundsShadow;

        // The example's per-object shadow is the head and the hair's, through which the light passes.
        float objectShadow = 1;

        for (int object = 0; object < 4; object++)
        {
            if (light.perObjectShadows[object] >= 0)
                objectShadow *= LightThroughHair(g_ForwardLight.shadows[light.perObjectShadows[object]], light.direction, surfaceWorldPos);
        }

        shadow.x *= objectShadow;

        if (isHair)
        {
            // Directional lights only (the sun); others add nothing.
            if (light.lightType == LightType_Directional)
            {
                diffuseTerm += shadow.x * EvalHair(surfaceMaterial, surfaceMaterial.shadingNormal, hairTangent, -viewIncident, -light.direction)
                    * light.intensity * light.color;
            }
            continue;
        }

        float3 diffuseRadiance, specularRadiance;
        ShadeSurface(light, surfaceMaterial, surfaceWorldPos, viewIncident, diffuseRadiance, specularRadiance);

        diffuseTerm += (shadow.x * diffuseRadiance) * light.color;
        specularTerm += (shadow.x * specularRadiance) * light.color;
    }

    float NdotV = saturate(-dot(surfaceMaterial.shadingNormal, viewIncident));

    if(g_ForwardLight.numLightProbes > 0 && !isHair)
    {
        float3 N = surfaceMaterial.shadingNormal;
        float3 R = reflect(viewIncident, N);

        float2 environmentBrdf = t_EnvironmentBrdf.SampleLevel(s_BrdfSampler, float2(NdotV, surfaceMaterial.roughness), 0).xy;

        float lightProbeWeight = 0;
        float3 lightProbeDiffuse = 0;
        float3 lightProbeSpecular = 0;

        [loop]
        for (uint nProbe = 0; nProbe < g_ForwardLight.numLightProbes; nProbe++)
        {
            LightProbeConstants lightProbe = g_ForwardLight.lightProbes[nProbe];

            float weight = GetLightProbeWeight(lightProbe, surfaceWorldPos);

            if (weight == 0)
                continue;

            float specularMipLevel = sqrt(saturate(surfaceMaterial.roughness)) * (lightProbe.mipLevels - 1);
            float3 diffuseProbe = t_DiffuseLightProbe.SampleLevel(s_LightProbeSampler, float4(N.xyz, lightProbe.diffuseArrayIndex), 0).rgb;
            float3 specularProbe = t_SpecularLightProbe.SampleLevel(s_LightProbeSampler, float4(R.xyz, lightProbe.specularArrayIndex), specularMipLevel).rgb;

            lightProbeDiffuse += (weight * lightProbe.diffuseScale) * diffuseProbe;
            lightProbeSpecular += (weight * lightProbe.specularScale) * specularProbe;
            lightProbeWeight += weight;
        }

        if (lightProbeWeight > 1)
        {
            float invWeight = rcp(lightProbeWeight);
            lightProbeDiffuse *= invWeight;
            lightProbeSpecular *= invWeight;
        }

        diffuseTerm += lightProbeDiffuse * surfaceMaterial.diffuseAlbedo * surfaceMaterial.occlusion;
        specularTerm += lightProbeSpecular * (surfaceMaterial.specularF0 * environmentBrdf.x + environmentBrdf.y) * surfaceMaterial.occlusion;
    }

    {
        float3 ambientColor = lerp(g_ForwardLight.ambientColorBottom.rgb, g_ForwardLight.ambientColorTop.rgb, surfaceMaterial.shadingNormal.y * 0.5 + 0.5);

        if (isHair)
        {
            diffuseTerm += HairAmbient(surfaceMaterial, surfaceMaterial.shadingNormal, hairTangent, -viewIncident,
                g_ForwardLight.ambientColorBottom.rgb, g_ForwardLight.ambientColorTop.rgb);
        }
        else
        {
            diffuseTerm += ambientColor * surfaceMaterial.diffuseAlbedo * surfaceMaterial.occlusion;
            specularTerm += ambientColor * surfaceMaterial.specularF0 * surfaceMaterial.occlusion;
        }
    }

#if TRANSMISSIVE_MATERIAL

    // See https://github.com/KhronosGroup/glTF/blob/master/extensions/2.0/Khronos/KHR_materials_transmission/README.md#transmission-btdf

    float dielectricFresnel = Schlick_Fresnel(0.04, NdotV);

    o_color.rgb = diffuseTerm * (1.0 - surfaceMaterial.transmission)
        + specularTerm
        + surfaceMaterial.emissiveColor;
    o_color.a = 1.0;

    float backgroundScalar = surfaceMaterial.transmission
        * (1.0 - dielectricFresnel);

    if (g_Material.domain == MaterialDomain_TransmissiveAlphaBlended)
        backgroundScalar *= (1.0 - surfaceMaterial.opacity);

    o_backgroundBlendFactor.rgb = backgroundScalar;

    if (surfaceMaterial.hasMetalRoughParams)
    {
        o_backgroundBlendFactor.rgb *= surfaceMaterial.baseColor * (1.0 - surfaceMaterial.metalness);
    }

    o_backgroundBlendFactor.a = 1.0;

#else // TRANSMISSIVE_MATERIAL

    o_color.rgb = diffuseTerm
        + specularTerm
        + surfaceMaterial.emissiveColor;

    if (g_Material.domain == MaterialDomain_AlphaTested)
    {
        // Fix the fuzzy edges on alpha tested geometry.
        o_color.a = saturate((surfaceMaterial.opacity - g_Material.alphaCutoff)
            / max(fwidth(surfaceMaterial.opacity) * 1.4142, 0.0001) + 0.5);
    }
    else
        o_color.a = surfaceMaterial.opacity;

#endif // TRANSMISSIVE_MATERIAL
}

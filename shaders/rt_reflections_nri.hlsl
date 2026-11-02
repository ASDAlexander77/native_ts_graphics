/*
* Copyright (c) 2014-2021, NVIDIA CORPORATION. All rights reserved.
*
* Permission is hereby granted, free of charge, to any person obtaining a
* copy of this software and associated documentation files (the "Software"),
* to deal in the Software without restriction, including without limitation
* the rights to use, copy, modify, merge, publish, distribute, sublicense,
* and/or sell copies of the Software, and to permit persons to whom the
* Software is furnished to do so, subject to the following conditions:
*
* The above copyright notice and this permission notice shall be included in
* all copies or substantial portions of the Software.
*
* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
* IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
* FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL
* THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
* LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
* FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
* DEALINGS IN THE SOFTWARE.
*/

// rt_reflections.hlsl for examples/nri/rt_reflections_nri.ts: NRI's shader tables hold shader
// identifiers alone (no local root signatures), so the reflection closest-hit shader finds the hit
// geometry's resources itself instead of in a local binding set. The TLAS's instance IDs are their
// meshes' first global geometry index: the geometry is InstanceID() + GeometryIndex(), its
// GeometryData gives its index and vertex offsets and its material, whose MaterialConstants give its
// textures' numbers in the scene's texture array. The indices, texture coordinates and normals are
// read through typed views of the whole scene buffers (the texture coordinates as pairs of floats),
// fetching what the Donut example's per-geometry views fetch. Everything else is rt_reflections.hlsl's.

#pragma pack_matrix(row_major)

#include "rt_reflections_lighting_cb.h"

#include <donut/shaders/gbuffer.hlsli>
#include <donut/shaders/scene_material.hlsli>
#include <donut/shaders/bindless.h>
#include <donut/shaders/lighting.hlsli>
#include <donut/shaders/binding_helpers.hlsli>

// ---[ Structures ]---

struct ShadowHitInfo
{
    bool missed;
};

struct ReflectionHitInfo
{
    float3 color;
};

struct Attributes
{
    float2 uv;
};

// ---[ Resources ]---

ConstantBuffer<LightingConstants> g_Lighting : register(b0);
RWTexture2D<float4> u_Output                 : register(u0);
RaytracingAccelerationStructure SceneBVH     : register(t0);
Texture2D t_GBufferDepth                     : register(t1);
Texture2D t_GBuffer0                         : register(t2);
Texture2D t_GBuffer1                         : register(t3);
Texture2D t_GBuffer2                         : register(t4);
Texture2D t_GBuffer3                         : register(t5);
SamplerState s_MaterialSampler               : register(s0);

// ---[ Ray Generation Shader ]---

float GetShadow(float3 worldPos, float3 lightDirection)
{
    // Setup the ray
    RayDesc ray;
    ray.Origin = worldPos;
    ray.Direction = -normalize(lightDirection);
    ray.TMin = 0.01f;
    ray.TMax = 100.f;

    // Trace the ray
    ShadowHitInfo shadowPayload;
    shadowPayload.missed = false;

    TraceRay(
        SceneBVH,
        RAY_FLAG_CULL_BACK_FACING_TRIANGLES,
        0xFF, // InstanceInclusionMask
        0, // RayContributionToHitGroupIndex
        2, // MultiplierForGeometryContributionToHitGroupIndex
        0, // MissShaderIndex
        ray,
        shadowPayload);

    return (shadowPayload.missed) ? 1 : 0;
}

float3 GetReflection(float3 worldPos, float3 reflectedVector)
{
    // Setup the ray
    RayDesc ray;
    ray.Origin = worldPos;
    ray.Direction = normalize(reflectedVector);
    ray.TMin = 0.01f;
    ray.TMax = 100.f;

    // Trace the ray
    ReflectionHitInfo reflectionPayload;
    reflectionPayload.color = 0;

    TraceRay(
        SceneBVH,
        RAY_FLAG_CULL_BACK_FACING_TRIANGLES,
        0xFF, // InstanceInclusionMask
        1, // RayContributionToHitGroupIndex
        2, // MultiplierForGeometryContributionToHitGroupIndex
        1, // MissShaderIndex
        ray,
        reflectionPayload);

    return reflectionPayload.color;
}

[shader("raygeneration")]
void RayGen()
{
    uint2 globalIdx = DispatchRaysIndex().xy;
    float2 pixelPosition = float2(globalIdx) + 0.5;

    MaterialSample surfaceMaterial = DecodeGBuffer(globalIdx, t_GBuffer0, t_GBuffer1, t_GBuffer2, t_GBuffer3);

    float3 surfaceWorldPos = ReconstructWorldPosition(g_Lighting.view, pixelPosition.xy, t_GBufferDepth[pixelPosition.xy].x);

    float3 viewIncident = GetIncidentVector(g_Lighting.view.cameraDirectionOrPosition, surfaceWorldPos);

    float3 diffuseTerm = 0;
    float3 specularTerm = 0;

    if (any(surfaceMaterial.shadingNormal != 0))
    {
        float shadow = GetShadow(surfaceWorldPos, g_Lighting.light.direction);

        if (shadow > 0)
        {
            float3 diffuseRadiance, specularRadiance;
            ShadeSurface(g_Lighting.light, surfaceMaterial, surfaceWorldPos, viewIncident, diffuseRadiance, specularRadiance);

            diffuseTerm += (shadow * diffuseRadiance) * g_Lighting.light.color;
            specularTerm += (shadow * specularRadiance) * g_Lighting.light.color;
        }

        diffuseTerm += g_Lighting.ambientColor.rgb * surfaceMaterial.diffuseAlbedo;

        float3 reflection = GetReflection(surfaceWorldPos, reflect(viewIncident, surfaceMaterial.shadingNormal));
        float3 fresnel = Schlick_Fresnel(surfaceMaterial.specularF0, saturate(-dot(viewIncident, surfaceMaterial.shadingNormal)));
        specularTerm += reflection * fresnel;
    }

    float3 outputColor = diffuseTerm
        + specularTerm
        + surfaceMaterial.emissiveColor;

    u_Output[globalIdx] = float4(outputColor, 1);
}

// ---[ Shadow Miss Shader ]---

[shader("miss")]
void ShadowMiss(inout ShadowHitInfo shadowPayload : SV_RayPayload)
{
    shadowPayload.missed = true;
}

// ---[ Reflection Shaders ]---

// The scene's geometries and materials (Donut's GeometryData and MaterialConstants); its indices
// (from each geometry's first vertex), texture coordinates (as floats: the stream starts after the
// positions, not always 8-byte aligned) and normals (snorm8: RGBA8_SNORM) as typed buffers; its
// textures, by number.
StructuredBuffer<GeometryData> t_Geometries             : register(t6);
StructuredBuffer<MaterialConstants> t_MaterialConstants : register(t7);
Buffer<uint> t_SceneIndexBuffer                         : register(t8);
Buffer<float> t_SceneTexCoordBuffer                     : register(t9);
Buffer<float4> t_SceneNormalsBuffer                     : register(t10);
Texture2D t_SceneTextures[]                             : register(t0, space1);

// material_bindings.hlsli's SampleMaterialTexturesLevel, from the material's textures.
MaterialTextureSample SampleMaterialTexturesLevel(MaterialConstants material, float2 texCoord, float lod)
{
    MaterialTextureSample values = DefaultMaterialTextures();

    if ((material.flags & MaterialFlags_UseBaseOrDiffuseTexture) != 0)
    {
        values.baseOrDiffuse = t_SceneTextures[NonUniformResourceIndex(material.baseOrDiffuseTextureIndex)].SampleLevel(s_MaterialSampler, texCoord, lod);
    }

    if ((material.flags & MaterialFlags_UseMetalRoughOrSpecularTexture) != 0)
    {
        values.metalRoughOrSpecular = t_SceneTextures[NonUniformResourceIndex(material.metalRoughOrSpecularTextureIndex)].SampleLevel(s_MaterialSampler, texCoord, lod);
    }

    if ((material.flags & MaterialFlags_UseEmissiveTexture) != 0)
    {
        values.emissive = t_SceneTextures[NonUniformResourceIndex(material.emissiveTextureIndex)].SampleLevel(s_MaterialSampler, texCoord, lod);
    }

    if ((material.flags & MaterialFlags_UseNormalTexture) != 0)
    {
        values.normal = t_SceneTextures[NonUniformResourceIndex(material.normalTextureIndex)].SampleLevel(s_MaterialSampler, texCoord, lod);
    }

    if ((material.flags & MaterialFlags_UseOcclusionTexture) != 0)
    {
        values.occlusion = t_SceneTextures[NonUniformResourceIndex(material.occlusionTextureIndex)].SampleLevel(s_MaterialSampler, texCoord, lod);
    }

    if ((material.flags & MaterialFlags_UseTransmissionTexture) != 0)
    {
        values.transmission = t_SceneTextures[NonUniformResourceIndex(material.transmissionTextureIndex)].SampleLevel(s_MaterialSampler, texCoord, lod);
    }

    if ((material.flags & MaterialFlags_UseOpacityTexture) != 0)
    {
        values.opacity = t_SceneTextures[NonUniformResourceIndex(material.opacityTextureIndex)].SampleLevel(s_MaterialSampler, texCoord, lod).r;
    }

    return values;
}

[shader("miss")]
void ReflectionMiss(inout ReflectionHitInfo reflectionPayload : SV_RayPayload)
{
}

[shader("closesthit")]
void ReflectionClosestHit(inout ReflectionHitInfo reflectionPayload : SV_RayPayload, in Attributes attrib : SV_IntersectionAttributes)
{
    GeometryData geometry = t_Geometries[InstanceID() + GeometryIndex()];
    MaterialConstants material = t_MaterialConstants[geometry.materialIndex];

    uint triangleIndex = PrimitiveIndex();
    float3 barycentrics = float3((1.0f - attrib.uv.x - attrib.uv.y), attrib.uv.x, attrib.uv.y);

    uint3 indices;
    uint firstIndex = geometry.indexOffset / 4;
    indices.x = t_SceneIndexBuffer[firstIndex + triangleIndex * 3 + 0];
    indices.y = t_SceneIndexBuffer[firstIndex + triangleIndex * 3 + 1];
    indices.z = t_SceneIndexBuffer[firstIndex + triangleIndex * 3 + 2];

    uint firstTexCoord = geometry.texCoord1Offset / 4;
    float2 vertexUVs[3];
    vertexUVs[0] = float2(t_SceneTexCoordBuffer[firstTexCoord + indices.x * 2], t_SceneTexCoordBuffer[firstTexCoord + indices.x * 2 + 1]);
    vertexUVs[1] = float2(t_SceneTexCoordBuffer[firstTexCoord + indices.y * 2], t_SceneTexCoordBuffer[firstTexCoord + indices.y * 2 + 1]);
    vertexUVs[2] = float2(t_SceneTexCoordBuffer[firstTexCoord + indices.z * 2], t_SceneTexCoordBuffer[firstTexCoord + indices.z * 2 + 1]);

    uint firstNormal = geometry.normalOffset / 4;
    float3 vertexNormals[3];
    vertexNormals[0] = t_SceneNormalsBuffer[firstNormal + indices.x].xyz;
    vertexNormals[1] = t_SceneNormalsBuffer[firstNormal + indices.y].xyz;
    vertexNormals[2] = t_SceneNormalsBuffer[firstNormal + indices.z].xyz;

    float2 uv =
        vertexUVs[0] * barycentrics.x +
        vertexUVs[1] * barycentrics.y +
        vertexUVs[2] * barycentrics.z;

    float3 normal = normalize(
        vertexNormals[0] * barycentrics.x +
        vertexNormals[1] * barycentrics.y +
        vertexNormals[2] * barycentrics.z);


    MaterialTextureSample textures = SampleMaterialTexturesLevel(material, uv, 3);

    MaterialSample surfaceMaterial = EvaluateSceneMaterial(normal, /* tangent = */ 0, material, textures);

    float3 surfaceWorldPos = WorldRayOrigin() + WorldRayDirection() * RayTCurrent();

    float3 diffuseRadiance, specularRadiance;
    float3 viewIncident = WorldRayDirection();
    ShadeSurface(g_Lighting.light, surfaceMaterial, surfaceWorldPos, viewIncident, diffuseRadiance, specularRadiance);

    float3 diffuseTerm = 0;
    float3 specularTerm = 0;

    float shadow = GetShadow(surfaceWorldPos, g_Lighting.light.direction);
    diffuseTerm += (shadow * diffuseRadiance) * g_Lighting.light.color;
    specularTerm += (shadow * specularRadiance) * g_Lighting.light.color;

    diffuseTerm += g_Lighting.ambientColor.rgb * surfaceMaterial.diffuseAlbedo;

    reflectionPayload.color = diffuseTerm + specularTerm;
}

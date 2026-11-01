// Donut's renderer constants for the NRI ports of the Donut examples that draw with its passes
// (examples/nri/deferred_shading_nri.ts): the structs of Donut's shaders (donut/shaders/*_cb.h),
// filled as Donut's engine fills them (PlanarView, Material, DirectionalLight,
// DeferredLightingPass), with Donut's own math (donut/core/math, header-only here), so the ports
// draw the same pixels. A translation unit of its own: NRIFramework's MathLib (in nri_interop.cpp)
// has global types of the same names as Donut's (float4x4...).

#include <donut/core/math/math.h>

#include <cstring>

using namespace donut::math;

#include <donut/shaders/light_types.h>
#include <donut/shaders/view_cb.h>
#include <donut/shaders/light_cb.h>
#include <donut/shaders/material_cb.h>
#include <donut/shaders/deferred_lighting_cb.h>

#ifdef _WIN32
#define NRI_INTEROP_API __declspec(dllexport)
#else
#define NRI_INTEROP_API __attribute__((visibility("default")))
#endif

namespace
{
    // PlanarView::SetMatrices, SetViewport(nvrhi::Viewport(width, height)), UpdateCache and
    // IView::FillPlanarViewConstants, without a pixel offset.
    void FillPlanarViewConstants(const float* viewMatrix, const float* projMatrix, int width, int height, PlanarViewConstants& constants)
    {
        float4x4 viewHomogeneous;
        memcpy(&viewHomogeneous, viewMatrix, sizeof(viewHomogeneous));
        const affine3 view = homogeneousToAffine(viewHomogeneous);
        float4x4 proj;
        memcpy(&proj, projMatrix, sizeof(proj));

        // nvrhi::Viewport(width, height): x and y from 0, depth 0 to 1.
        const float minX = 0.f;
        const float maxX = float(width);
        const float minY = 0.f;
        const float maxY = float(height);
        const float2 pixelOffset = float2(0.f, 0.f);

        const float4x4 pixelOffsetMatrix = affineToHomogeneous(translation(
            float3(2.f * pixelOffset.x / (maxX - minX), -2.f * pixelOffset.y / (maxY - minY), 0.f)));
        const float4x4 pixelOffsetMatrixInv = inverse(pixelOffsetMatrix);
        const float4x4 viewProj = affineToHomogeneous(view) * proj;
        const float4x4 viewProjOffset = viewProj * pixelOffsetMatrix;
        const affine3 viewInv = inverse(view);
        const float4x4 projInv = inverse(proj);
        const float4x4 viewProjInv = projInv * affineToHomogeneous(viewInv);
        const float4x4 viewProjOffsetInv = pixelOffsetMatrixInv * viewProjInv;

        constants.matWorldToView = affineToHomogeneous(view);
        constants.matViewToClip = proj * pixelOffsetMatrix;
        constants.matWorldToClip = viewProjOffset;
        constants.matClipToView = pixelOffsetMatrixInv * projInv;
        constants.matViewToWorld = affineToHomogeneous(viewInv);
        constants.matClipToWorld = viewProjOffsetInv;
        constants.matViewToClipNoOffset = proj;
        constants.matWorldToClipNoOffset = viewProj;
        constants.matClipToViewNoOffset = projInv;
        constants.matClipToWorldNoOffset = viewProjInv;

        constants.viewportOrigin = float2(minX, minY);
        constants.viewportSize = float2(maxX - minX, maxY - minY);
        constants.viewportSizeInv = 1.f / constants.viewportSize;

        constants.clipToWindowScale = float2(0.5f * (maxX - minX), -0.5f * (maxY - minY));
        constants.clipToWindowBias = constants.viewportOrigin + constants.viewportSize * 0.5f;

        constants.windowToClipScale = 1.f / constants.clipToWindowScale;
        constants.windowToClipBias = -constants.clipToWindowBias * constants.windowToClipScale;

        const bool orthographic = proj[2][3] == 0.f;
        constants.cameraDirectionOrPosition = orthographic
            ? float4(viewInv.m_linear[2], 0.f)
            : float4(viewInv.m_translation, 1.f);

        constants.pixelOffset = pixelOffset;
    }
}

extern "C"
{
    // The sizes (bytes, multiples of 16) of Donut's shader constant structs: 0 PlanarViewConstants,
    // 1 MaterialConstants, 2 LightConstants, 3 DeferredLightingConstants; 0 for others.
    NRI_INTEROP_API int Nri_GetDonutConstantsSize(int which)
    {
        switch (which)
        {
        case 0: return int(sizeof(PlanarViewConstants));
        case 1: return int(sizeof(MaterialConstants));
        case 2: return int(sizeof(LightConstants));
        case 3: return int(sizeof(DeferredLightingConstants));
        default: return 0;
        }
    }

    // A planar view's PlanarViewConstants (donut/shaders/view_cb.h) into dst, as Donut's PlanarView
    // fills them from its world-to-view and projection matrices (16 floats each, row-major,
    // row-vector convention, as donut::math builds them: Donut_SetPlanarView's) and a viewport of
    // width x height pixels, without a pixel offset.
    NRI_INTEROP_API void Nri_FillDonutPlanarViewConstants(const float* viewMatrix, const float* projMatrix, int width, int height, void* dst)
    {
        PlanarViewConstants constants = {};
        FillPlanarViewConstants(viewMatrix, projMatrix, width, height, constants);
        memcpy(dst, &constants, sizeof(constants));
    }

    // The MaterialConstants (donut/shaders/material_cb.h) of a Donut material with a base or
    // diffuse texture and default parameters (Donut_CreateTexturedMaterial's), the specular-gloss
    // model if specularGloss != 0, as Material::FillConstantBuffer fills them, into dst.
    NRI_INTEROP_API void Nri_FillDonutTexturedMaterialConstants(int specularGloss, void* dst)
    {
        MaterialConstants constants = {};
        constants.flags = MaterialFlags_UseBaseOrDiffuseTexture;
        if (specularGloss)
            constants.flags |= MaterialFlags_UseSpecularGlossModel;
        constants.domain = MaterialDomain_Opaque;
        constants.baseOrDiffuseColor = float3(1.f);
        constants.specularColor = float3(0.f);
        constants.emissiveColor = float3(0.f) * 1.f;
        constants.roughness = 0.f;
        constants.metalness = 0.f;
        constants.normalTextureScale = 1.f;
        constants.materialID = 0;
        constants.occlusionStrength = 1.f;
        constants.transmissionFactor = 0.f;
        constants.normalTextureTransformScale = float2(1.f);
        constants.opacity = 1.f;
        constants.alphaCutoff = -1.f;
        // No bindless descriptors.
        constants.baseOrDiffuseTextureIndex = -1;
        constants.metalRoughOrSpecularTextureIndex = -1;
        constants.emissiveTextureIndex = -1;
        constants.normalTextureIndex = -1;
        constants.occlusionTextureIndex = -1;
        constants.transmissionTextureIndex = -1;
        constants.opacityTextureIndex = -1;
        memcpy(dst, &constants, sizeof(constants));
    }

    // The LightConstants (donut/shaders/light_cb.h) of a white Donut DirectionalLight in a node of
    // its own under an untransformed node, shining along (dirX, dirY, dirZ) (Light::SetDirection:
    // the node's rotation and scaling decomposed from lookatZ, then its transform composed back as
    // SceneGraphNode does), angularSize in degrees and irradiance as given, without shadows, as
    // DirectionalLight::FillLightConstants fills them, into dst (Donut_AddDirectionalLight's light).
    NRI_INTEROP_API void Nri_FillDonutDirectionalLightConstants(double dirX, double dirY, double dirZ, double angularSize, double irradiance,
        void* dst)
    {
        // Light::SetDirection, under a parent whose transform is the identity.
        const daffine3 parentToWorld = daffine3::identity();
        const daffine3 worldToLocal = lookatZ(double3(dirX, dirY, dirZ));
        const daffine3 localToParent = inverse(worldToLocal * parentToWorld);
        dquat rotation;
        double3 scale;
        decomposeAffine<double>(localToParent, nullptr, &rotation, &scale);

        // SceneGraphNode::UpdateLocalTransform (no translation), then the global transform.
        daffine3 localTransform = scaling(scale);
        localTransform *= rotation.toAffine();
        localTransform *= translation(double3(0.0));
        const daffine3 globalTransform = localTransform * parentToWorld;

        // Light::FillLightConstants, then DirectionalLight's (Light::GetDirection).
        LightConstants constants = {};
        constants.color = float3(1.f);
        constants.shadowCascades = int4(-1);
        constants.perObjectShadows = int4(-1);
        constants.shadowChannel = int4(-1, -1, -1, -1);
        constants.outOfBoundsShadow = 1.f;
        const double3 direction = -normalize(double3(globalTransform.m_linear.row2));
        constants.lightType = LightType_Directional;
        constants.direction = float3(normalize(direction));
        const float clampedAngularSize = clamp(float(angularSize), 0.f, 90.f);
        constants.angularSizeOrInvRange = radians(clampedAngularSize);
        constants.intensity = float(irradiance);
        memcpy(dst, &constants, sizeof(constants));
    }

    // The DeferredLightingConstants (donut/shaders/deferred_lighting_cb.h) DeferredLightingPass::Render
    // writes for a planar view (Nri_FillDonutPlanarViewConstants' arguments), lightCount lights
    // (LightConstants each, from lights: Nri_FillDonutDirectionalLightConstants'), without shadow
    // maps, light probes or ambient occlusion, a top and bottom ambient color and no random offset,
    // into dst.
    NRI_INTEROP_API void Nri_FillDonutDeferredLightingConstants(const float* viewMatrix, const float* projMatrix, int width, int height,
        const void* lights, int lightCount, double topR, double topG, double topB, double bottomR, double bottomG, double bottomB, void* dst)
    {
        DeferredLightingConstants constants = {};
        constants.randomOffset = float2(0.f);
        constants.noisePattern[0] = float4(0.059f, 0.529f, 0.176f, 0.647f);
        constants.noisePattern[1] = float4(0.765f, 0.294f, 0.882f, 0.412f);
        constants.noisePattern[2] = float4(0.235f, 0.706f, 0.118f, 0.588f);
        constants.noisePattern[3] = float4(0.941f, 0.471f, 0.824f, 0.353f);
        constants.ambientColorTop = float4(float3(float(topR), float(topG), float(topB)), 0.f);
        constants.ambientColorBottom = float4(float3(float(bottomR), float(bottomG), float(bottomB)), 0.f);
        constants.enableAmbientOcclusion = 0;
        constants.indirectDiffuseScale = 1.f;
        constants.indirectSpecularScale = 1.f;
        const int count = lightCount < DEFERRED_MAX_LIGHTS ? lightCount : DEFERRED_MAX_LIGHTS;
        if (count > 0)
            memcpy(constants.lights, lights, sizeof(LightConstants) * size_t(count));
        constants.numLights = uint(count);
        FillPlanarViewConstants(viewMatrix, projMatrix, width, height, constants.view);
        memcpy(dst, &constants, sizeof(constants));
    }
}

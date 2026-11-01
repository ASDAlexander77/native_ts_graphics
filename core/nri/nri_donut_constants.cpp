// Donut's renderer constants for the NRI ports of the Donut examples that draw with its passes
// (examples/nri/deferred_shading_nri.ts): the structs of Donut's shaders (donut/shaders/*_cb.h),
// filled as Donut's engine fills them (PlanarView, Material, DirectionalLight,
// DeferredLightingPass), with Donut's own math (donut/core/math, header-only here), so the ports
// draw the same pixels. A translation unit of its own: NRIFramework's MathLib (in nri_interop.cpp)
// has global types of the same names as Donut's (float4x4...).

#include <donut/core/math/math.h>

#include <algorithm>
#include <cmath>
#include <cstring>

using namespace donut::math;

#include <donut/shaders/light_types.h>
#include <donut/shaders/view_cb.h>
#include <donut/shaders/light_cb.h>
#include <donut/shaders/material_cb.h>
#include <donut/shaders/deferred_lighting_cb.h>
#include <donut/shaders/forward_cb.h>
#include <donut/shaders/depth_cb.h>
#include <donut/shaders/sky_cb.h>
// (tonemapping_cb.h has depth_cb.h's include guard.)
#undef DEPTH_CB_H
#include <donut/shaders/tonemapping_cb.h>

#ifdef _WIN32
#define NRI_INTEROP_API __declspec(dllexport)
#else
#define NRI_INTEROP_API __attribute__((visibility("default")))
#endif

namespace
{
    // The global transform of a Donut DirectionalLight's node, in a node of its own under an
    // untransformed node, shining along direction (Light::SetDirection: the node's rotation and
    // scaling decomposed from lookatZ, then its transform composed back as SceneGraphNode does).
    daffine3 DirectionalLightTransform(const double3& direction)
    {
        const daffine3 parentToWorld = daffine3::identity();
        const daffine3 worldToLocal = lookatZ(direction);
        const daffine3 localToParent = inverse(worldToLocal * parentToWorld);
        dquat rotation;
        double3 scale;
        decomposeAffine<double>(localToParent, nullptr, &rotation, &scale);

        // SceneGraphNode::UpdateLocalTransform (no translation), then the global transform.
        daffine3 localTransform = scaling(scale);
        localTransform *= rotation.toAffine();
        localTransform *= translation(double3(0.0));
        return localTransform * parentToWorld;
    }

    // DirectionalLight::FillLightConstants (Light's, then its own) for a white light in that node,
    // without shadows.
    LightConstants DirectionalLightConstants(const double3& direction, double angularSize, double irradiance)
    {
        const daffine3 globalTransform = DirectionalLightTransform(direction);
        LightConstants constants = {};
        constants.color = float3(1.f);
        constants.shadowCascades = int4(-1);
        constants.perObjectShadows = int4(-1);
        constants.shadowChannel = int4(-1, -1, -1, -1);
        constants.outOfBoundsShadow = 1.f;
        const double3 lightDirection = -normalize(double3(globalTransform.m_linear.row2));
        constants.lightType = LightType_Directional;
        constants.direction = float3(normalize(lightDirection));
        const float clampedAngularSize = clamp(float(angularSize), 0.f, 90.f);
        constants.angularSizeOrInvRange = radians(clampedAngularSize);
        constants.intensity = float(irradiance);
        return constants;
    }

    // A planar shadow map of resolution x resolution fitted to a directional light and world-space
    // bounds as PlanarShadowMap::SetupWholeSceneDirectionalLightView fits it (with
    // patches/Donut-planar-shadow-map-whole-scene-depth-range.patch): its view and projection, and
    // its fade range in texels.
    struct PlanarShadowView
    {
        affine3 worldToView;
        float4x4 projection;
        float2 fadeRangeTexels;
    };

    PlanarShadowView SetupWholeSceneDirectionalLightView(const double3& direction, box3 sceneBounds, float resolution, float fadeRangeWorld)
    {
        daffine3 viewToWorld = DirectionalLightTransform(direction);
        viewToWorld = scaling(double3(1.0, 1.0, -1.0)) * viewToWorld;
        const affine3 worldToView = affine3(inverse(viewToWorld));

        // Transform scene AABB into view space and recalculate bounds
        box3 boundsView = sceneBounds * worldToView;
        float3 vecDiamOriginal = boundsView.diagonal();

        // Select maximum diameter along X and Y, so that shadow map texels will be square
        float maxXY = max(vecDiamOriginal.x, vecDiamOriginal.y);
        float3 vecDiam = float3(maxXY, maxXY, vecDiamOriginal.z);
        boundsView = boundsView.grow(0.5f * (vecDiam - vecDiamOriginal));

        PlanarShadowView view;
        view.worldToView = worldToView;
        view.projection = orthoProjD3DStyle(
            boundsView.m_mins.x,
            boundsView.m_maxs.x,
            boundsView.m_mins.y,
            boundsView.m_maxs.y,
            boundsView.m_mins.z,
            boundsView.m_maxs.z);
        const float2 shadowMapSize = float2(resolution);
        view.fadeRangeTexels = clamp(
            float2(fadeRangeWorld * shadowMapSize) / boundsView.diagonal().xy(),
            float2(1.f),
            shadowMapSize * 0.5f);
        return view;
    }

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
    // 1 MaterialConstants, 2 LightConstants, 3 DeferredLightingConstants,
    // 4 ForwardShadingLightConstants, 5 ShadowConstants, 6 DepthPassConstants, 7 SkyConstants,
    // 8 ToneMappingConstants; 0 for others.
    NRI_INTEROP_API int Nri_GetDonutConstantsSize(int which)
    {
        switch (which)
        {
        case 0: return int(sizeof(PlanarViewConstants));
        case 1: return int(sizeof(MaterialConstants));
        case 2: return int(sizeof(LightConstants));
        case 3: return int(sizeof(DeferredLightingConstants));
        case 4: return int(sizeof(ForwardShadingLightConstants));
        case 5: return int(sizeof(ShadowConstants));
        case 6: return int(sizeof(DepthPassConstants));
        case 7: return int(sizeof(SkyConstants));
        case 8: return int(sizeof(ToneMappingConstants));
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
        const LightConstants constants = DirectionalLightConstants(double3(dirX, dirY, dirZ), angularSize, irradiance);
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

    // The PlanarViewConstants of one face (0 to 5) of a Donut CubemapView: CubemapView::SetTransform
    // with the camera's world-to-view matrix (16 floats, row-major, row-vector convention: an affine
    // transform) and zNear, its reverse infinite projection (the default), each face's view the
    // camera's turned by the face's matrix; SetArrayViewports' resolution x resolution viewport.
    // ForwardShadingViewConstants is these alone.
    NRI_INTEROP_API void Nri_FillDonutCubemapFaceViewConstants(const float* worldToView, double zNear, int resolution, int face, void* dst)
    {
        // View.cpp's g_CubemapViewMatrices.
        static const float3x3 faceMatrices[6] = {
            float3x3(0, 0, 1, 0, 1, 0, -1, 0, 0),
            float3x3(0, 0, -1, 0, 1, 0, 1, 0, 0),
            float3x3(1, 0, 0, 0, 0, 1, 0, -1, 0),
            float3x3(1, 0, 0, 0, 0, -1, 0, 1, 0),
            float3x3(1, 0, 0, 0, 1, 0, 0, 0, 1),
            float3x3(-1, 0, 0, 0, 1, 0, 0, 0, -1)
        };
        float4x4 viewHomogeneous;
        memcpy(&viewHomogeneous, worldToView, sizeof(viewHomogeneous));
        const affine3 viewMatrix = homogeneousToAffine(viewHomogeneous);
        const float nearPlane = float(zNear);
        const float4x4 faceProjMatrix = float4x4(
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 0, 1,
            0, 0, nearPlane, 0);
        const affine3 faceViewMatrix = viewMatrix * affine3(faceMatrices[face % 6], float3(0.f));
        const float4x4 faceView = affineToHomogeneous(faceViewMatrix);

        PlanarViewConstants constants = {};
        FillPlanarViewConstants(reinterpret_cast<const float*>(&faceView), reinterpret_cast<const float*>(&faceProjMatrix), resolution,
            resolution, constants);
        memcpy(dst, &constants, sizeof(constants));
    }

    // The ForwardShadingLightConstants ForwardShadingPass::PrepareLights writes with no lights, light
    // probes or shadow map, a top and bottom ambient color, into dst.
    NRI_INTEROP_API void Nri_FillDonutForwardLightConstants(double topR, double topG, double topB, double bottomR, double bottomG,
        double bottomB, void* dst)
    {
        ForwardShadingLightConstants constants = {};
        const int2 shadowMapTextureSize = 0;
        constants.shadowMapTextureSize = float2(shadowMapTextureSize);
        constants.shadowMapTextureSizeInv = 1.f / constants.shadowMapTextureSize;
        constants.ambientColorTop = float4(float3(float(topR), float(topG), float(topB)), 0.f);
        constants.ambientColorBottom = float4(float3(float(bottomR), float(bottomG), float(bottomB)), 0.f);
        memcpy(dst, &constants, sizeof(constants));
    }

    // A planar shadow map (Donut's PlanarShadowMap: one orthographic view, a D24S8 texture array of
    // one resolution x resolution slice, depth cleared to 1) fitted to the directional light of
    // Nri_FillDonutDirectionalLightConstants' arguments and world-space bounds (6 floats: min x, y, z,
    // max x, y, z), as Donut_SetupPlanarShadowMapForScene fits it (the bounds grown by 1% of their
    // diagonal first), shadows fading out over fadeRangeWorld at its edges: the DepthPassConstants
    // (DepthPass::SetupView's) into depthDst and the ShadowConstants (FillShadowConstants') into
    // shadowDst. Returns 1 if its view is mirrored (PlanarView::IsMirrored: the depth pass's front
    // faces are counterclockwise), else 0.
    NRI_INTEROP_API int Nri_SetupDonutPlanarShadowMap(double dirX, double dirY, double dirZ, const float* bounds, int resolution,
        double fadeRangeWorld, void* depthDst, void* shadowDst)
    {
        box3 sceneBounds(float3(bounds[0], bounds[1], bounds[2]), float3(bounds[3], bounds[4], bounds[5]));
        sceneBounds = sceneBounds.grow(float3(0.01f * length(sceneBounds.diagonal())));
        const PlanarShadowView view = SetupWholeSceneDirectionalLightView(double3(dirX, dirY, dirZ), sceneBounds, float(resolution),
            float(fadeRangeWorld));

        // PlanarView's view-projection (no pixel offset).
        const float4x4 viewProjection = affineToHomogeneous(view.worldToView) * view.projection;
        DepthPassConstants depthConstants = {};
        depthConstants.matWorldToClip = viewProjection;
        memcpy(depthDst, &depthConstants, sizeof(depthConstants));

        // PlanarShadowMap::FillShadowConstants: the viewport is the whole texture, array slice 0.
        const float4x4 matClipToUvzw = {
            0.5f,  0,    0, 0,
            0,    -0.5f, 0, 0,
            0,     0,    1, 0,
            0.5f,  0.5f, 0, 1,
        };
        const float2 textureSize = float2(float(resolution));
        ShadowConstants shadow = {};
        shadow.matWorldToUvzwShadow = viewProjection * matClipToUvzw;
        shadow.shadowMapArrayIndex = 0;
        const box2 uvRange = box2((float2(0.f) + 1.f) / textureSize, (textureSize - 1.f) / textureSize);
        const float2 fadeUV = view.fadeRangeTexels / textureSize;
        shadow.shadowMapCenterUV = uvRange.center();
        shadow.shadowFadeBias = uvRange.diagonal() / (2.f * fadeUV);
        shadow.shadowFadeScale = -1.f / fadeUV;
        shadow.shadowFalloffDistance = 1.f;
        shadow.shadowMapSizeTexels = textureSize;
        shadow.shadowMapSizeTexelsInv = 1.f / shadow.shadowMapSizeTexels;
        memcpy(shadowDst, &shadow, sizeof(shadow));

        return determinant(view.worldToView.m_linear) < 0.f ? 1 : 0;
    }

    // The ForwardShadingLightConstants ForwardShadingPass::PrepareLights writes for one light, the
    // directional light of Nri_FillDonutDirectionalLightConstants' arguments, with the shadow map of
    // shadowMapResolution (its ShadowConstants: Nri_SetupDonutPlanarShadowMap's) or none
    // (shadowMapResolution 0, shadow ignored), no light probes, a top and bottom ambient color.
    NRI_INTEROP_API void Nri_FillDonutForwardSunLightConstants(double dirX, double dirY, double dirZ, double angularSize, double irradiance,
        const void* shadow, int shadowMapResolution, double topR, double topG, double topB, double bottomR, double bottomG,
        double bottomB, void* dst)
    {
        ForwardShadingLightConstants constants = {};
        const int2 shadowMapTextureSize = shadowMapResolution;
        constants.shadowMapTextureSize = float2(shadowMapTextureSize);
        constants.shadowMapTextureSizeInv = 1.f / constants.shadowMapTextureSize;
        constants.lights[0] = DirectionalLightConstants(double3(dirX, dirY, dirZ), angularSize, irradiance);
        if (shadowMapResolution > 0)
        {
            memcpy(&constants.shadows[0], shadow, sizeof(ShadowConstants));
            constants.lights[0].shadowCascades[0] = 0;
            // PlanarShadowMap::IsLitOutOfBounds: false unless set.
            constants.lights[0].outOfBoundsShadow = 0.f;
        }
        constants.numLights = 1;
        constants.ambientColorTop = float4(float3(float(topR), float(topG), float(topB)), 0.f);
        constants.ambientColorBottom = float4(float3(float(bottomR), float(bottomG), float(bottomB)), 0.f);
        memcpy(dst, &constants, sizeof(constants));
    }

    // The SkyConstants EnvironmentMapPass::Render writes for a planar view (Nri_FillDonutPlanarViewConstants'
    // arguments): the clip-to-world transform translated by the camera's position.
    NRI_INTEROP_API void Nri_FillDonutSkyConstants(const float* viewMatrix, const float* projMatrix, int width, int height, void* dst)
    {
        PlanarViewConstants view = {};
        FillPlanarViewConstants(viewMatrix, projMatrix, width, height, view);
        float4x4 viewHomogeneous;
        memcpy(&viewHomogeneous, viewMatrix, sizeof(viewHomogeneous));
        const float3 viewOrigin = inverse(homogeneousToAffine(viewHomogeneous)).m_translation;
        SkyConstants constants = {};
        constants.matClipToTranslatedWorld = view.matClipToWorld * affineToHomogeneous(translation(-viewOrigin));
        memcpy(dst, &constants, sizeof(constants));
    }

    // The ToneMappingConstants ToneMappingPass writes, with the default ToneMappingParameters and no
    // color LUT, for a stage: 0 AddFrameToHistogram (a width x height view), 1 ComputeExposure
    // (frameTime seconds of eye adaptation: 0 keeps the exposure as it is), 2 Render; into dst.
    NRI_INTEROP_API void Nri_FillDonutToneMappingConstants(int stage, int width, int height, double frameTime, void* dst)
    {
        // ToneMappingPasses.cpp's luminance range and ToneMappingParameters' defaults.
        const float minLogLuminance = -10;
        const float maxLogLuminance = 4;
        const float histogramLowPercentile = 0.8f;
        const float histogramHighPercentile = 0.95f;
        const float eyeAdaptationSpeedUp = 1.f;
        const float eyeAdaptationSpeedDown = 0.5f;
        const float minAdaptedLuminance = 0.02f;
        const float maxAdaptedLuminance = 0.5f;
        const float exposureBias = -0.5f;
        const float whitePoint = 3.f;

        ToneMappingConstants constants = {};
        if (stage == 0)
        {
            constants.logLuminanceScale = 1.0f / (maxLogLuminance - minLogLuminance);
            constants.logLuminanceBias = -minLogLuminance * constants.logLuminanceScale;
            constants.viewOrigin = uint2(0, 0);
            constants.viewSize = uint2(uint(width), uint(height));
            constants.sourceSlice = 0;
        }
        else if (stage == 1)
        {
            constants.logLuminanceScale = maxLogLuminance - minLogLuminance;
            constants.logLuminanceBias = minLogLuminance;
            constants.histogramLowPercentile = std::min(0.99f, std::max(0.f, histogramLowPercentile));
            constants.histogramHighPercentile = std::min(1.f, std::max(constants.histogramLowPercentile, histogramHighPercentile));
            constants.eyeAdaptationSpeedUp = eyeAdaptationSpeedUp;
            constants.eyeAdaptationSpeedDown = eyeAdaptationSpeedDown;
            constants.minAdaptedLuminance = minAdaptedLuminance;
            constants.maxAdaptedLuminance = maxAdaptedLuminance;
            constants.frameTime = float(frameTime);
        }
        else
        {
            constants.exposureScale = ::exp2f(exposureBias);
            constants.whitePointInvSquared = 1.f / powf(whitePoint, 2.f);
            constants.minAdaptedLuminance = minAdaptedLuminance;
            constants.maxAdaptedLuminance = maxAdaptedLuminance;
            constants.sourceSlice = 0;
            constants.colorLUTTextureSize = float2(0.f);
            constants.colorLUTTextureSizeInv = float2(0.f);
        }
        memcpy(dst, &constants, sizeof(constants));
    }
}

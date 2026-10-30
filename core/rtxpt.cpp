// C++ glue of the rtxpt example (NVIDIA's RTX Path Tracing sample, github.com/NVIDIA-RTX/RTXPT): the
// sample's renderer library (rtxpt_core in CMakeLists.txt: its scene, materials, lights, environment map,
// the path tracer's run-time pipeline baker, tone mapping and accumulation, compiled from RTXPT_DIR in
// place) driven for examples/rtxpt.ts, which is the sample's host: what Sample.cpp decides (settings,
// camera, accumulation, when to rebuild) is there, and RtxptRenderer here holds the sample's C++ objects
// and does its steps on them (Sample.cpp's and AdvancedSample.cpp's: the reference mode, and the real-time
// mode with its denoising layers, NRD and TAA or DLSS; no RTXDI, SHaRC, sub-sampling, opacity micromaps, DLSS-RR
// or async compute). Built only with RTXPT_DIR, which also puts the sample's sources on the include path.
//
// This software contains source code provided by NVIDIA Corporation.
//
// Copyright (c) 2025-2026, NVIDIA CORPORATION.  All rights reserved.
//
// NVIDIA CORPORATION and its licensors retain all intellectual property
// and proprietary rights in and to this software, related documentation
// and any modifications thereto.  Any use, reproduction, disclosure or
// distribution of this software and related documentation without an express
// license agreement from NVIDIA CORPORATION is strictly prohibited.

#include <algorithm>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <limits>
#include <memory>
#include <random>
#include <string>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

#include <donut/app/ApplicationBase.h>
#include <donut/core/json.h>
#include <donut/core/log.h>
#include <donut/core/vfs/VFS.h>
#include <donut/engine/BindingCache.h>
#include <donut/engine/CommonRenderPasses.h>
#include <donut/engine/DescriptorTableManager.h>
#include <donut/engine/FramebufferFactory.h>
#include <donut/engine/SceneGraph.h>
#include <donut/engine/ShaderFactory.h>
#include <donut/engine/TextureCache.h>
#include <donut/engine/ThreadPool.h>
#include <donut/engine/View.h>
#include <donut/render/BloomPass.h>
#include <donut/render/TemporalAntiAliasingPass.h>
#include <nvrhi/utils.h>

#include <SampleCommon/SampleCommon.h>
#include <SampleCommon/ExtendedScene.h>
#include <SampleCommon/PTPipelineBaker.h>
#include <SampleCommon/ComputePipelineBaker.h>
#include <SampleCommon/RenderTargets.h>
#include <SampleCommon/AccelerationStructureUtil.h>
#include <Materials/MaterialsBaker.h>
#include <Lighting/LightsBaker.h>
#include <Lighting/Distant/EnvMapBaker.h>
#include <Lighting/Distant/EnvMapImportanceSamplingBaker.h>
#include <ToneMapper/ToneMappingPasses.h>
#include <ProcessingPasses/AccumulationPass.h>
#include <ProcessingPasses/PostProcess.h>
#include <ProcessingPasses/DenoisingGuidesBaker.h>
#include <NRD/NrdIntegration.h>
#include <NRD/NrdConfig.h>
#include <Misc/ShaderDebug.h>
#include <OpacityMicroMap/OmmBaker.h>
#include <SampleCommon/LocalConfig.h>
#include <SampleCommon/DirectoryModifiedMonitor.h>
#include <SampleCommon/GpuProfiler.h>
#include <SceneRenderCache.h>
#include <Shaders/SampleConstantBuffer.h>

#include "donut_api.h"

using namespace donut;
using namespace donut::math;
using namespace donut::engine;

// Donut's shader structures, on donut::math's types.
#include <donut/shaders/light_cb.h>
#include <donut/shaders/view_cb.h>

// core/donut_interop.cpp's DLSS (Donut's, over NGX; does nothing without DONUT_WITH_DLSS): the real-time mode's
// "DLSS" anti-aliasing, at the render size (the sample's runs through Streamline, upscaling).
namespace donut::render { class DLSS; }
extern "C"
{
    DONUT_API int Donut_IsDlssInitialized(donut::render::DLSS* dlss);
    DONUT_API void Donut_EvaluateDlssTextures(nvrhi::ICommandList* commandList, donut::render::DLSS* dlss, nvrhi::ITexture* depth, nvrhi::ITexture* motionVectors,
        nvrhi::ITexture* inputColor, nvrhi::ITexture* outputColor, int width, int height, double jitterX, double jitterY, int reset);
}

// OmmBaker.cpp's (opacity micromaps, not built): ExtendedScene and LightsBaker read it.
bool MeshInfoEx::s_anyDebugDataDirty = true;

// LocalConfig.cpp's (not built: the rest of it configures Sample): per-user material overrides, none for the
// default RTXPT_LOCAL_CONFIG_ID.
void LocalConfig::PostMaterialLoad(donut::engine::Material&)
{
}

// What examples/rtxpt.ts decides for a frame, as it writes it (its FS_* offsets): Sample.cpp's m_ui fields
// and camera that its Render reads. All 4 bytes.
struct RtxptFrameSettings
{
    float cameraPos[3];         float fovY;
    float cameraDir[3];         float zNear;
    float cameraUp[3];          float focalDistance;
    float apertureRadius;       uint32_t frameIndex;            uint32_t sampleIndex;           uint32_t resetAccumulation;
    uint32_t bounceCount;       uint32_t diffuseBounceCount;    float envMapDiffuseMipLevel;    float texLODBias;
    float perPixelJitterAAScale; uint32_t fireflyFilterEnabled; float fireflyFilterThreshold;   uint32_t enableToneMapping;
    uint32_t neeEnabled;        uint32_t neeType;               uint32_t neeCandidateSamples;   uint32_t neeFullSamples;
    float neeatGlobalTemporalFeedbackWeight; float neeatLocalToGlobalSampleRatio; float neeatDistantVsLocalImportance; uint32_t useApproximateMIS;
    uint32_t envMapEnabled;     float envMapIntensity;          float envMapTint[3];            float envMapRotation[3];
    uint32_t toneMapOperator;   uint32_t autoExposure;          float exposureCompensation;     float exposureValue;
    float exposureValueMin;     float exposureValueMax;         uint32_t enableBloom;           float bloomRadius;
    float bloomIntensity;       uint32_t activeDenoisingLayerCount; uint32_t denoisingLayersMaxVertexDepth; uint32_t allowPrimarySurfaceReplacement;
    float denoisingLayersSplitStopThreshold; float denoisingLayersSuppressPrimaryIndirectSpecularK; float denoisingLayersAntiAliasingFallthrough; float denoiserRadianceClampK;
    // The real-time mode: realtimeAA 0 none, 1 TAA, 2 DLSS; nrdMethod 0 ReBLUR, 1 ReLAX (NrdConfig::DenoiserMethod).
    uint32_t realtimeMode;      uint32_t realtimeAA;            uint32_t standaloneDenoiser;    uint32_t nrdMethod;
    uint32_t resetRealtimeCaches; uint32_t enableAnimations;    uint32_t taaJitter;             float taaNewFrameWeight;
    uint32_t taaEnableHistoryClamping; uint32_t taaUseHistoryClampRelax; float nrdDisocclusionThreshold; float nrdDisocclusionThresholdAlternate;
    uint32_t nrdUseAlternateDisocclusionThresholdMix; uint32_t samplesPerPixel;
};
static_assert(sizeof(RtxptFrameSettings) == 280, "RtxptFrameSettings: examples/rtxpt.ts's FRAME_SETTINGS_SIZE");
static_assert(offsetof(RtxptFrameSettings, apertureRadius) == 48 && offsetof(RtxptFrameSettings, bounceCount) == 64
    && offsetof(RtxptFrameSettings, neeEnabled) == 96 && offsetof(RtxptFrameSettings, envMapEnabled) == 128
    && offsetof(RtxptFrameSettings, toneMapOperator) == 160 && offsetof(RtxptFrameSettings, bloomIntensity) == 192
    && offsetof(RtxptFrameSettings, realtimeMode) == 224 && offsetof(RtxptFrameSettings, resetRealtimeCaches) == 240
    && offsetof(RtxptFrameSettings, taaEnableHistoryClamping) == 256 && offsetof(RtxptFrameSettings, nrdUseAlternateDisocclusionThresholdMix) == 272,
    "RtxptFrameSettings: examples/rtxpt.ts's FS_* offsets");

// Sample.cpp's: input 32-bit radiance scaled to fit the baker's 16-bit range.
static const float c_envMapRadianceScale = 1.0f / 4.0f;

namespace
{
    // The folder of the module holding this code: the executable, or donut_interop_shared under the JIT.
    std::filesystem::path ModuleDirectory()
    {
#ifdef _WIN32
        HMODULE handle = nullptr;
        GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(&ModuleDirectory), &handle);
        wchar_t path[MAX_PATH] = {};
        GetModuleFileNameW(handle, path, MAX_PATH);
        return std::filesystem::path(path).parent_path();
#else
        return donut::app::GetDirectoryWithExecutable();
#endif
    }

    SimpleViewConstants FromPlanarViewConstants(const PlanarViewConstants& view)
    {
        SimpleViewConstants ret;
        ret.matWorldToView          = view.matWorldToView;
        ret.matViewToClip           = view.matViewToClip;
        ret.matWorldToClipNoOffset  = view.matWorldToClipNoOffset;
        ret.matClipToWorldNoOffset  = view.matClipToWorldNoOffset;
        ret.matWorldToClip          = view.matWorldToClip;
        ret.clipToWindowBias        = view.clipToWindowBias;
        ret.clipToWindowScale       = view.clipToWindowScale;
        ret.viewportOrigin          = view.viewportOrigin;
        ret.viewportSize            = view.viewportSize;
        ret.viewportSizeInv         = view.viewportSizeInv;
        ret.pixelOffset             = view.pixelOffset;
        return ret;
    }

    // Sample::FireflyFilterThreshold: linear in the on-screen middle gray's luminance.
    float FireflyFilterThreshold(float uiThreshold, float preExposedGrayLuminance)
    {
        constexpr float kGrayRef = 0.18f;
        return uiThreshold * preExposedGrayLuminance * (1e3f / sqrtf(kGrayRef));
    }
}

// Sample's objects, the ones its reference mode uses.
struct RtxptRenderer
{
    nvrhi::DeviceHandle device;
    std::filesystem::path assetsPath;
    std::shared_ptr<ShaderFactory> shaderFactory;
    std::shared_ptr<CommonRenderPasses> commonPasses;
    std::unique_ptr<BindingCache> bindingCache;
    nvrhi::CommandListHandle commandList;           // for the work done between frames (Prepare)

    nvrhi::BindingLayoutHandle bindlessLayout;
    nvrhi::BindingLayoutHandle bindlessHeapLayout;
    nvrhi::BindingLayoutHandle bindingLayout;
    std::shared_ptr<DescriptorTableManager> descriptorTable;
    std::shared_ptr<DescriptorTableManager> heapDescriptorTable;
    std::shared_ptr<TextureCache> textureCache;

    nvrhi::BufferHandle constantBuffer;
    nvrhi::BufferHandle bindlessValidationBuffer;
    nvrhi::BufferHandle feedbackBufferGpu;
    nvrhi::BufferHandle debugLineBufferCapture;
    nvrhi::BufferHandle debugDeltaPathTreeGpu;
    nvrhi::BufferHandle debugDeltaPathTreeSearchStack;

    std::filesystem::path scenePath;
    std::shared_ptr<ExtendedScene> scene;
    // SampleUI.cpp's TogglableNode: scene nodes named *_togglable (shown) or *_togglable_off (hidden at load),
    // hidden by moving them far away.
    struct TogglableNode
    {
        SceneGraphNode* node;
        double3 originalTranslation;
        std::string name;
    };
    std::vector<TogglableNode> togglableNodes;
    // SampleGame (core/rtxpt_game.ts): the scene graph nodes it holds, by handle, the light nodes the last
    // CollectGameLights found, and the JSON files and file names it reads.
    std::vector<std::shared_ptr<SceneGraphNode>> gameNodes;
    std::vector<int> collectedGameLights;
    std::vector<Json::Value> gameJson;
    std::vector<std::string> listedFiles;
    std::vector<std::shared_ptr<Light>> lights;
    std::string envMapLocalPath;
    float envLightIntensity = std::numeric_limits<float>::quiet_NaN();

    std::shared_ptr<MaterialsBaker> materialsBaker;
    std::shared_ptr<PTPipelineBaker> ptPipelineBaker;
    std::shared_ptr<ComputePipelineBaker> computePipelineBaker;
    std::shared_ptr<PTPipelineVariant> ptPipelineReference;
    // The real-time mode's: the denoising layers' build pass, then their fill (the path tracing).
    std::shared_ptr<PTPipelineVariant> ptPipelineBuildDenoisingLayers;
    std::shared_ptr<PTPipelineVariant> ptPipelineFillDenoisingLayers;
    std::shared_ptr<EnvMapBaker> envMapBaker;
    std::shared_ptr<LightsBaker> lightsBaker;
    std::unique_ptr<RenderTargets> renderTargets;
    std::shared_ptr<ShaderDebug> shaderDebug;
    std::unique_ptr<AccumulationPass> accumulationPass;
    std::unique_ptr<ToneMappingPass> toneMappingPass;
    std::unique_ptr<render::BloomPass> bloomPass;
    std::shared_ptr<PostProcess> postProcess;
    std::shared_ptr<DenoisingGuidesBaker> denoisingGuidesBaker;
    int neeatQualityPreset = -1;

    // The real-time mode's TAA (only while it's on) and NRD, an instance per denoising layer (only while the
    // standalone denoiser is on), with SampleUI's settings for them.
    std::unique_ptr<render::TemporalAntiAliasingPass> temporalAntiAliasingPass;
    bool temporalAntiAliasingFeedbackValid = false;
    // DLSS (Donut_RtxptRendererSetDlss; the example owns it), and whether it ran last frame (else no history).
    donut::render::DLSS* dlss = nullptr;
    bool dlssActive = false;
    std::unique_ptr<NrdIntegration> nrdInstances[cDenoisingLayerCount];
    uint32_t nrdMethod = 0;
    nrd::ReblurSettings reblurSettings = NrdConfig::getDefaultREBLURSettings();
    nrd::RelaxSettings relaxSettings = NrdConfig::getDefaultRELAXSettings();

    nvrhi::rt::AccelStructHandle topLevelAS;
    nvrhi::BufferHandle tlasInstanceBuffer;
    std::vector<nvrhi::rt::InstanceDesc> tlasInstances;
    nvrhi::BufferHandle subInstanceBuffer;
    std::vector<SubInstanceData> subInstanceData;
    uint32_t subInstanceCount = 0;

    ThreadPool frameWorkerPool;
    SceneRenderCache sceneRenderCache;
    std::shared_ptr<PlanarView> view;
    std::shared_ptr<PlanarView> viewPrevious;
    uint2 renderSize = { 0, 0 };
    std::vector<ShaderMacro> globalMacros;      // examples/rtxpt.ts's (Sample::GetPTPipelineGlobalMacros)
    nvrhi::BindingSetHandle bindingSet;

    RtxptFrameSettings settings = {};
    double sceneTime = 0.0;
    EnvMapSceneParams envMapSceneParams = {};
    PathTracerCameraData lastCameraData = {};
    SampleConstants constants = {};

    // Sample::Init's: the layouts and tables everything binds through.
    bool Init(nvrhi::IDevice* dev, const std::filesystem::path& assets)
    {
        device = dev;
        assetsPath = assets;

        // The precompiled shaders the passes ask for: "donut/..." Donut's (bin/shaders/framework), "app/..." the
        // sample's (shaders/rtxpt.cfg: bin/shaders/rtxpt), "nrd/..." NRD's (bin/shaders/nrd).
        const char* shaderType = app::GetShaderTypeName(device->getGraphicsAPI());
        const std::filesystem::path binDirectory = ModuleDirectory();
        auto rootFS = std::make_shared<vfs::RootFileSystem>();
        rootFS->mount("/shaders/donut", binDirectory / "shaders" / "framework" / shaderType);
        rootFS->mount("/shaders/app", binDirectory / "shaders" / "rtxpt" / shaderType);
        rootFS->mount("/shaders/nrd", binDirectory / "shaders" / "nrd" / shaderType);
        shaderFactory = std::make_shared<ShaderFactory>(device, rootFS, "/shaders");

        commonPasses = std::make_shared<CommonRenderPasses>(device, shaderFactory);
        bindingCache = std::make_unique<BindingCache>(device);

        nvrhi::BindlessLayoutDesc bindlessLayoutDesc;
        bindlessLayoutDesc.visibility = nvrhi::ShaderType::All;
        bindlessLayoutDesc.firstSlot = 0;
        bindlessLayoutDesc.maxCapacity = 1024;
        bindlessLayoutDesc.registerSpaces = { nvrhi::BindingLayoutItem::RawBuffer_SRV(1), nvrhi::BindingLayoutItem::Texture_SRV(2) };
        bindlessLayout = device->createBindlessLayout(bindlessLayoutDesc);

        // SM 6.6 ResourceDescriptorHeap access (Shaders/Bindless.hlsli): no register spaces.
        nvrhi::BindlessLayoutDesc bindlessHeapLayoutDesc;
        bindlessHeapLayoutDesc.visibility = nvrhi::ShaderType::All;
        bindlessHeapLayoutDesc.layoutType = nvrhi::BindlessLayoutDesc::LayoutType::MutableSrvUavCbv;
        bindlessHeapLayoutDesc.maxCapacity = 1024;
        bindlessHeapLayout = device->createBindlessLayout(bindlessHeapLayoutDesc);

        // The global layout every pass of the sample shares; the same items as the sample's (its IntroSample's
        // and real-time mode's included: the shaders declare them).
        nvrhi::BindingLayoutDesc desc;
        desc.visibility = nvrhi::ShaderType::Compute | nvrhi::ShaderType::AllRayTracing;
        using I = nvrhi::BindingLayoutItem;
        desc.bindings = {
            I::VolatileConstantBuffer(0), I::PushConstants(1, sizeof(SampleMiniConstants)), I::RayTracingAccelStruct(0),
            I::StructuredBuffer_SRV(1), I::StructuredBuffer_SRV(2), I::StructuredBuffer_SRV(3), I::StructuredBuffer_SRV(4), I::StructuredBuffer_SRV(5),
            I::Texture_SRV(6), I::Texture_SRV(10), I::Texture_SRV(11),
            I::StructuredBuffer_SRV(12), I::StructuredBuffer_SRV(13), I::StructuredBuffer_SRV(14),
            I::Sampler(0), I::Sampler(1), I::Sampler(2), I::Sampler(3),
            I::Texture_UAV(0), I::Texture_UAV(1), I::Texture_UAV(2), I::Texture_UAV(4), I::Texture_UAV(5), I::Texture_UAV(6), I::Texture_UAV(7), I::Texture_UAV(8),
            I::Texture_UAV(31), I::Texture_UAV(32), I::Texture_UAV(33), I::Texture_UAV(34), I::Texture_UAV(35), I::Texture_UAV(36), I::Texture_UAV(37),
            I::StructuredBuffer_UAV(51), I::StructuredBuffer_UAV(52), I::StructuredBuffer_UAV(53), I::StructuredBuffer_UAV(54),
            I::Texture_UAV(60), I::Texture_UAV(61),
            I::Texture_UAV(70), I::Texture_UAV(71), I::Texture_UAV(72), I::Texture_UAV(73), I::Texture_UAV(74), I::Texture_UAV(75), I::RawBuffer_UAV(76),
            I::RawBuffer_UAV(SHADER_DEBUG_BUFFER_UAV_INDEX), I::Texture_UAV(SHADER_DEBUG_VIZ_TEXTURE_UAV_INDEX),
            // NEE-AT
            I::TypedBuffer_SRV(15), I::TypedBuffer_SRV(16), I::TypedBuffer_SRV(17), I::Texture_SRV(18), I::TypedBuffer_SRV(19), I::Texture_UAV(20), I::Texture_UAV(21),
            // denoising layers, G-buffer, environment IBL, IntroSample's, SHaRC's
            I::Texture_UAV(40), I::StructuredBuffer_UAV(42), I::Texture_UAV(44), I::StructuredBuffer_UAV(45),
            I::Texture_UAV(100), I::Texture_UAV(101), I::Texture_UAV(102), I::Texture_UAV(103),
            I::Texture_SRV(80), I::Texture_SRV(81), I::Texture_SRV(82), I::Texture_SRV(83), I::Texture_SRV(84),
            I::Texture_UAV(85), I::Texture_SRV(87), I::Texture_SRV(95), I::StructuredBuffer_SRV(90), I::StructuredBuffer_SRV(91),
            I::Texture_UAV(88), I::Texture_UAV(89), I::Texture_UAV(95),
            I::StructuredBuffer_UAV(90), I::StructuredBuffer_UAV(91), I::StructuredBuffer_UAV(92),
            I::StructuredBuffer_SRV(50),
            I::StructuredBuffer_UAV(94), I::TypedBuffer_SRV(94), I::VolatileConstantBuffer(12),
        };
        bindingLayout = device->createBindingLayout(desc);

        descriptorTable = std::make_shared<DescriptorTableManager>(device, bindlessLayout);
        heapDescriptorTable = std::make_shared<DescriptorTableManager>(device, bindlessHeapLayout);
        textureCache = std::make_shared<TextureCache>(device, std::make_shared<vfs::NativeFileSystem>(), descriptorTable);

        // t_BindlessValidationData: read only by shaders built with RTXPT_SHADER_DEBUG (_DEBUG), never here.
        nvrhi::BufferDesc validationDesc;
        validationDesc.byteSize = 1024 * sizeof(uint32_t);
        validationDesc.structStride = sizeof(uint32_t);
        validationDesc.debugName = "BindlessValidationData";
        validationDesc.initialState = nvrhi::ResourceStates::NonPixelShaderResource;
        validationDesc.keepInitialState = true;
        bindlessValidationBuffer = device->createBuffer(validationDesc);

        // The debug feedback buffers the path tracer writes when picking (u51-u54).
        auto debugBuffer = [&](size_t byteSize, uint32_t stride, const char* name, bool vertexBuffer)
        {
            nvrhi::BufferDesc bufferDesc;
            bufferDesc.byteSize = byteSize;
            bufferDesc.canHaveUAVs = true;
            bufferDesc.isVertexBuffer = vertexBuffer;
            bufferDesc.structStride = stride;
            bufferDesc.keepInitialState = true;
            bufferDesc.initialState = nvrhi::ResourceStates::Common;
            bufferDesc.debugName = name;
            return device->createBuffer(bufferDesc);
        };
        feedbackBufferGpu = debugBuffer(sizeof(DebugFeedbackStruct), sizeof(DebugFeedbackStruct), "Feedback_Buffer_Gpu", false);
        debugLineBufferCapture = debugBuffer(sizeof(DebugLineStruct) * MAX_DEBUG_LINES, sizeof(DebugLineStruct), "DebugLinesCapture", true);
        debugDeltaPathTreeGpu = debugBuffer(sizeof(DeltaTreeVizPathVertex) * cDeltaTreeVizMaxVertices, sizeof(DeltaTreeVizPathVertex), "Feedback_PathDecomp_Gpu", false);
        debugDeltaPathTreeSearchStack = debugBuffer(sizeof(PathPayload) * cDeltaTreeVizMaxStackSize, sizeof(PathPayload), "DebugDeltaPathTreeSearchStack", false);

        constantBuffer = device->createBuffer(nvrhi::utils::CreateVolatileConstantBufferDesc(
            sizeof(SampleConstants), "SampleConstants", c_MaxRenderPassConstantBufferVersions * 2));

        commandList = device->createCommandList(nvrhi::CommandListParameters().setScratchChunkSize(4 * 1024 * 1024));

        view = std::make_shared<PlanarView>();
        viewPrevious = std::make_shared<PlanarView>();
        return true;
    }

    // Sample::SceneUnloading's.
    void UnloadScene()
    {
        device->waitForIdle();
        bindingSet = nullptr;
        topLevelAS = nullptr;
        subInstanceBuffer = nullptr;
        bindingCache->Clear();
        lights.clear();
        envMapBaker = nullptr;
        lightsBaker = nullptr;
        materialsBaker = nullptr;
        if (ptPipelineBaker != nullptr)
        {
            ptPipelineBaker->ReleaseVariant(ptPipelineReference);
            ptPipelineBaker->ReleaseVariant(ptPipelineBuildDenoisingLayers);
            ptPipelineBaker->ReleaseVariant(ptPipelineFillDenoisingLayers);
        }
        ptPipelineBaker = nullptr;
        computePipelineBaker = nullptr;
        if (scene != nullptr)
            for (const auto& mesh : scene->GetSceneGraph()->GetMeshes())
                mesh->accelStruct = nullptr;
        togglableNodes.clear();
        gameNodes.clear();
        collectedGameLights.clear();
        gameJson.clear();
        scene = nullptr;
    }

    // SampleUI.cpp's UpdateTogglableNodes.
    void CollectTogglableNodes(SceneGraphNode* node)
    {
        auto addIfTogglable = [&](const std::string& token) -> bool
        {
            const std::string& name = node->GetName();
            if (name.length() <= token.length() || name.compare(name.length() - token.length(), token.length(), token) != 0)
                return false;
            togglableNodes.push_back({ node, node->GetTranslation(), name.substr(0, name.length() - token.length()) });
            return true;
        };
        if (!addIfTogglable("_togglable") && addIfTogglable("_togglable_off"))
            SetTogglableNodeSelected((int)togglableNodes.size() - 1, false);
        for (int i = (int)node->GetNumChildren() - 1; i >= 0; i--)
            CollectTogglableNodes(node->GetChild(i));
    }

    bool IsTogglableNodeSelected(int index) const
    {
        return togglableNodes[index].node->GetTranslation().x > -9999.0;
    }

    void SetTogglableNodeSelected(int index, bool selected)
    {
        TogglableNode& t = togglableNodes[index];
        t.node->SetTranslation(selected ? t.originalTranslation : double3(-10000.0, -10000.0, -10000.0));
    }

    // Sample::LoadScene. Sample::SceneLoaded starts with the game's step (GameScene::SceneLoaded, the host's), then
    // FinishLoadingScene does the rest.
    bool LoadScene(const std::filesystem::path& path)
    {
        UnloadScene();
        scenePath = path;
        scene = std::shared_ptr<ExtendedScene>(new ExtendedScene(device, *shaderFactory, std::make_shared<vfs::NativeFileSystem>(),
            textureCache, descriptorTable, std::make_shared<ExtendedSceneTypeFactory>()));
        if (!scene->Load(path))
        {
            scene = nullptr;
            return false;
        }
        return true;
    }

    // Sample::SceneLoaded's scene-side steps after the game's, in their order.
    bool FinishLoadingScene()
    {
        if (scene == nullptr)
            return false;

        // Material leaf properties at time 0, before the materials are read.
        for (const auto& animation : scene->GetSceneGraph()->GetAnimations())
            for (const auto& channel : animation->GetChannels())
            {
                if (channel->GetAttribute() != AnimationAttribute::LeafProperty)
                    continue;
                const auto node = channel->GetTargetNode();
                if (!node || std::dynamic_pointer_cast<MeshInstance>(node->GetLeaf()))
                    (void)channel->Apply(0.0f);
            }

        materialsBaker = std::make_shared<MaterialsBaker>("PathTracerMaterialSpecializations.hlsl", device, textureCache, shaderFactory);
        materialsBaker->LoadMaterials(scene, scenePath, assetsPath);

        sceneTime = 0.0;
        scene->FinishedLoading(0);

        for (const auto& light : scene->GetSceneGraph()->GetLights())
            lights.push_back(light);

        std::shared_ptr<EnvironmentLight> envLight = FindEnvironmentLight(lights);
        envMapLocalPath = envLight ? envLight->path : "";
        envLightIntensity = envLight ? envLight->intensity : std::numeric_limits<float>::quiet_NaN();

        // Invisible lights and markers only slow things down.
        for (int i = (int)lights.size() - 1; i >= 0; i--)
        {
            LightConstants lc;
            lights[i]->FillLightConstants(lc);
            if (length(lc.color * lc.intensity) <= 1e-7f)
                lights.erase(lights.begin() + i);
        }
        CollectTogglableNodes(scene->GetSceneGraph()->GetRootNode().get());

        if (envMapLocalPath != "" && envLight == nullptr)
        {
            envLight = std::make_shared<EnvironmentLight>();
            scene->GetSceneGraph()->AttachLeafNode(scene->GetSceneGraph()->GetRootNode(), envLight);
            lights.push_back(envLight);
        }

        // Animated BLASes need the animations applied once.
        for (const auto& anim : scene->GetSceneGraph()->GetAnimations())
            (void)anim->Apply(0.0f);
        return true;
    }

    // SampleGame's scene graph steps (GameModel.cpp, GameProps.cpp, GameScene.cpp). Nodes are handles into
    // gameNodes; -1 is the scene's root.
    std::shared_ptr<SceneGraphNode> GameNode(int handle)
    {
        if (handle < 0 || handle >= (int)gameNodes.size())
            return scene->GetSceneGraph()->GetRootNode();
        return gameNodes[handle];
    }

    int AddGameNode(const std::shared_ptr<SceneGraphNode>& node)
    {
        gameNodes.push_back(node);
        return (int)gameNodes.size() - 1;
    }

    // PropBase's and ModelInstance's constructors: a new named node under `parent`.
    int CreateGameNode(int parent, const char* name)
    {
        std::shared_ptr<SceneGraphNode> node = std::make_shared<SceneGraphNode>();
        node = scene->GetSceneGraph()->Attach(GameNode(parent), node);
        node->SetName(name);
        return AddGameNode(node);
    }

    // ModelInstance's constructor: the scene's model `modelIndex` (its import root) under `parent`. The first
    // instance gets the import root itself, later ones copies (SceneGraph::Attach).
    void AttachGameModel(int parent, int modelIndex)
    {
        const auto& models = scene->GetModels();
        if (modelIndex < 0 || modelIndex >= (int)models.size() || !models[modelIndex].rootNode)
            return;
        scene->GetSceneGraph()->Attach(GameNode(parent), models[modelIndex].rootNode);
    }

    // ModelInstance::MapLightControllers' walk: the light nodes under `node`, depth first, as handles.
    void CollectGameLights(SceneGraphNode* node)
    {
        if (node->GetLeaf() != nullptr && (node->GetLeaf()->GetContentFlags() & SceneContentFlags::Lights) != 0)
            collectedGameLights.push_back(AddGameNode(node->shared_from_this()));
        for (int i = 0; i < (int)node->GetNumChildren(); i++)
            CollectGameLights(node->GetChild(i));
    }

    // ModelInstance::UpdateLightFromControllers, one controller's light.
    void UpdateGameLight(int handle, float3 color, float intensity, float innerAngle, float outerAngle)
    {
        std::shared_ptr<SceneGraphNode> node = GameNode(handle);
        // a frame old world transform (the sample's note)
        float3 scale;
        dm::decomposeAffine<float>(node->GetLocalToWorldTransformFloat(), nullptr, nullptr, &scale);
        float reallyAverageScale = (scale.x + scale.y + scale.z) / 3.0f;

        Light* light = dynamic_cast<Light*>(node->GetLeaf().get());
        if (light == nullptr)
            return;
        SpotLight* spotLight = dynamic_cast<SpotLight*>(light);
        PointLight* pointLight = dynamic_cast<PointLight*>(light);
        light->color = color;
        if (spotLight != nullptr)
        {
            spotLight->radius = reallyAverageScale;
            spotLight->intensity = intensity;
            spotLight->outerAngle = std::abs(outerAngle);
            spotLight->innerAngle = innerAngle;
            // the sample's kUseMinSpotlightFalloff: past outerAngle the falloff clamps to kMinSpotlightFalloff
            spotLight->outerAngle = -spotLight->outerAngle;
        }
        if (pointLight != nullptr)
        {
            pointLight->radius = reallyAverageScale;
            pointLight->intensity = intensity;
        }
    }

    // GameScene::TickCamera: the game camera's pose (9 floats: position, direction, up) in the attached prop's
    // space into world space, in place.
    void TransformGameCamera(int propHandle, float* posDirUp)
    {
        std::shared_ptr<SceneGraphNode> node = GameNode(propHandle);
        dm::daffine3 transformD = dm::scaling(node->GetScaling());
        transformD *= node->GetRotation().toAffine();
        transformD *= dm::translation(node->GetTranslation());
        const affine3 transform = dm::affine3(transformD);
        const float3 pos = transform.transformPoint(float3(posDirUp[0], posDirUp[1], posDirUp[2]));
        const float3 dir = transform.transformVector(float3(posDirUp[3], posDirUp[4], posDirUp[5]));
        const float3 up = transform.transformVector(float3(posDirUp[6], posDirUp[7], posDirUp[8]));
        const float values[9] = { pos.x, pos.y, pos.z, dir.x, dir.y, dir.z, up.x, up.y, up.z };
        std::memcpy(posDirUp, values, sizeof(values));
    }

    // The game's JSON files: a value by path, "a/b/0/c" (array elements by index); null where missing.
    const Json::Value& GameJsonValue(int handle, const char* path)
    {
        static const Json::Value nullValue;
        if (handle < 0 || handle >= (int)gameJson.size())
            return nullValue;
        const Json::Value* node = &gameJson[handle];
        const std::string p = path;
        size_t start = 0;
        while (start < p.size())
        {
            size_t end = p.find('/', start);
            if (end == std::string::npos)
                end = p.size();
            const std::string key = p.substr(start, end - start);
            if (node->isArray())
            {
                char* last = nullptr;
                const long index = std::strtol(key.c_str(), &last, 10);
                if (key.empty() || *last != 0 || index < 0 || index >= (long)node->size())
                    return nullValue;
                node = &(*node)[(Json::ArrayIndex)index];
            }
            else if (node->isObject())
            {
                if (!node->isMember(key))
                    return nullValue;
                node = &(*node)[key];
            }
            else
                return nullValue;
            start = end + 1;
        }
        return *node;
    }

    // Sample::CreateBlases without the pool (every BLAS its own), CreateTlas, and the sub-instance data.
    void CreateAccelStructs(nvrhi::ICommandList* cl)
    {
        for (const std::shared_ptr<MeshInfo>& mesh : scene->GetSceneGraph()->GetMeshes())
        {
            if (mesh->isSkinPrototype)
                continue;
            bvh::Config cfg = { .excludeTransmissive = false };
            nvrhi::rt::AccelStructDesc blasDesc = bvh::GetMeshBlasDesc(cfg, *mesh, nullptr, false);
            nvrhi::rt::AccelStructHandle as = device->createAccelStruct(blasDesc);
            nvrhi::utils::BuildBottomLevelAccelStruct(cl, as, blasDesc);
            mesh->accelStruct = as;
        }

        nvrhi::rt::AccelStructDesc tlasDesc;
        tlasDesc.isTopLevel = true;
        tlasDesc.topLevelMaxInstances = scene->GetSceneGraph()->GetMeshInstances().size();
        tlasDesc.buildFlags = nvrhi::rt::AccelStructBuildFlags::PreferFastTrace;
        topLevelAS = device->createAccelStruct(tlasDesc);

        subInstanceCount = 0;
        for (const auto& instance : scene->GetSceneGraph()->GetMeshInstances())
            subInstanceCount += (uint32_t)instance->GetMesh()->geometries.size();
        nvrhi::BufferDesc bufferDesc;
        bufferDesc.byteSize = sizeof(SubInstanceData) * std::max(1u, subInstanceCount);
        bufferDesc.debugName = "Instances";
        bufferDesc.structStride = sizeof(SubInstanceData);
        bufferDesc.canHaveUAVs = true;
        bufferDesc.initialState = nvrhi::ResourceStates::Common;
        bufferDesc.keepInitialState = true;
        subInstanceBuffer = device->createBuffer(bufferDesc);
        subInstanceData.assign(subInstanceCount, SubInstanceData::Default());

        nvrhi::BufferDesc instanceDesc;
        instanceDesc.byteSize = sizeof(nvrhi::rt::InstanceDesc) * std::max<size_t>(1, tlasDesc.topLevelMaxInstances);
        instanceDesc.structStride = sizeof(nvrhi::rt::InstanceDesc);
        instanceDesc.debugName = "TLASInstanceDescs";
        instanceDesc.canHaveUAVs = true;
        instanceDesc.isAccelStructBuildInput = true;
        instanceDesc.initialState = nvrhi::ResourceStates::UnorderedAccess;
        instanceDesc.keepInitialState = true;
        tlasInstanceBuffer = device->createBuffer(instanceDesc);
    }

    // Sample::BuildTLAS (the CPU path; without opacity micromaps).
    void BuildTLAS(nvrhi::ICommandList* cl)
    {
        const auto& meshInstances = scene->GetSceneGraph()->GetMeshInstances();
        tlasInstances.resize(meshInstances.size());
        for (size_t i = 0; i < meshInstances.size(); i++)
        {
            const auto& instance = meshInstances[i];
            const nvrhi::rt::IAccelStruct* blas = instance->GetMesh()->accelStruct.Get();
            nvrhi::rt::InstanceDesc desc;
            desc.blasDeviceAddress = (blas != nullptr) ? blas->getDeviceAddress() : 0;
            desc.instanceMask = 1;
            desc.instanceID = instance->GetGeometryInstanceIndex();
            desc.instanceContributionToHitGroupIndex = instance->GetGeometryInstanceIndex();
            desc.flags = nvrhi::rt::InstanceFlags::None;
            affineToColumnMajor(instance->GetNode()->GetLocalToWorldTransformFloat(), desc.transform);
            tlasInstances[i] = desc;
        }
        if (!tlasInstances.empty())
            cl->writeBuffer(tlasInstanceBuffer, tlasInstances.data(), tlasInstances.size() * sizeof(nvrhi::rt::InstanceDesc));
        cl->setBufferState(tlasInstanceBuffer, nvrhi::ResourceStates::AccelStructBuildInput);
        cl->setAccelStructState(topLevelAS, nvrhi::ResourceStates::AccelStructWrite);
        cl->commitBarriers();
        cl->buildTopLevelAccelStructFromBuffer(topLevelAS, tlasInstanceBuffer, 0, tlasInstances.size(), nvrhi::rt::AccelStructBuildFlags::AllowEmptyInstances);
    }

    // Sample::UpdateSkinnedBLASs.
    void UpdateSkinnedBLASs(nvrhi::ICommandList* cl, uint32_t frameIndex)
    {
        const auto& skinned = scene->GetSceneGraph()->GetSkinnedMeshInstances();
        for (const auto& instance : skinned)
        {
            if (instance->GetLastUpdateFrameIndex() < frameIndex)
                continue;
            cl->setAccelStructState(instance->GetMesh()->accelStruct, nvrhi::ResourceStates::AccelStructWrite);
            cl->setBufferState(instance->GetMesh()->buffers->vertexBuffer, nvrhi::ResourceStates::AccelStructBuildInput);
        }
        cl->commitBarriers();
        for (const auto& instance : skinned)
        {
            if (instance->GetLastUpdateFrameIndex() < frameIndex)
                continue;
            bvh::Config cfg = { .excludeTransmissive = false };
            nvrhi::rt::AccelStructDesc blasDesc = bvh::GetMeshBlasDesc(cfg, *instance->GetMesh(), nullptr, true);
            nvrhi::utils::BuildBottomLevelAccelStruct(cl, instance->GetMesh()->accelStruct, blasDesc);
        }
        for (const auto& instance : skinned)
            if (instance->GetLastUpdateFrameIndex() >= frameIndex)
                cl->setAccelStructState(instance->GetMesh()->accelStruct, nvrhi::ResourceStates::AccelStructBuildBlas);
        // TransitionMeshBuffersToReadOnly
        for (const auto& instance : skinned)
            cl->setBufferState(instance->GetMesh()->buffers->vertexBuffer, nvrhi::ResourceStates::NonPixelShaderResource);
        cl->commitBarriers();
    }

    // Sample::RecreateBindingSet's main set (the reference path tracer's: no async-compute variants).
    void RecreateBindingSet()
    {
        using S = nvrhi::BindingSetItem;
        RenderTargets& rt = *renderTargets;
        nvrhi::BindingSetDesc desc;
        desc.bindings = {
            S::ConstantBuffer(0, constantBuffer), S::PushConstants(1, sizeof(SampleMiniConstants)), S::RayTracingAccelStruct(0, topLevelAS),
            S::StructuredBuffer_SRV(1, subInstanceBuffer), S::StructuredBuffer_SRV(2, scene->GetInstanceBuffer()),
            S::StructuredBuffer_SRV(3, scene->GetGeometryBuffer()), S::StructuredBuffer_SRV(4, materialsBaker->GetMaterialDataBuffer()),
            S::StructuredBuffer_SRV(5, materialsBaker->GetMaterialDataBuffer()),
            S::Texture_SRV(6, rt.LdrColorScratch, nvrhi::Format::SRGBA8_UNORM),
            S::Texture_SRV(10, envMapBaker->GetEnvMapCube()), S::Texture_SRV(11, envMapBaker->GetImportanceSampling()->GetImportanceMapOnly()),
            S::StructuredBuffer_SRV(12, lightsBaker->GetControlBuffer()), S::StructuredBuffer_SRV(13, lightsBaker->GetLightBuffer()),
            S::StructuredBuffer_SRV(14, lightsBaker->GetLightExBuffer()),
            S::Sampler(0, commonPasses->m_AnisotropicWrapSampler), S::Sampler(1, envMapBaker->GetEnvMapCubeSampler()),
            S::Sampler(2, envMapBaker->GetImportanceSampling()->GetImportanceMapSampler()), S::Sampler(3, commonPasses->m_LinearClampSampler),
            S::Texture_UAV(0, rt.OutputColor), S::Texture_UAV(1, rt.ProcessedOutputColor), S::Texture_UAV(2, rt.LdrColor, nvrhi::Format::RGBA8_UNORM),
            S::Texture_UAV(4, rt.Throughput), S::Texture_UAV(5, rt.ScreenMotionVectors), S::Texture_UAV(6, rt.Depth),
            S::Texture_UAV(7, rt.SpecularHitT), S::Texture_UAV(8, rt.ScratchFloat1),
            S::Texture_UAV(31, rt.DenoiserViewspaceZ), S::Texture_UAV(32, rt.DenoiserMotionVectors), S::Texture_UAV(33, rt.DenoiserNormalRoughness),
            S::Texture_UAV(34, rt.DenoiserDiffRadianceHitDist), S::Texture_UAV(35, rt.DenoiserSpecRadianceHitDist),
            S::Texture_UAV(36, rt.DenoiserDisocclusionThresholdMix), S::Texture_UAV(37, rt.CombinedHistoryClampRelax),
            S::StructuredBuffer_UAV(51, feedbackBufferGpu), S::StructuredBuffer_UAV(52, debugLineBufferCapture),
            S::StructuredBuffer_UAV(53, debugDeltaPathTreeGpu), S::StructuredBuffer_UAV(54, debugDeltaPathTreeSearchStack),
            S::Texture_UAV(60, rt.SecondarySurfacePositionNormal), S::Texture_UAV(61, rt.SecondarySurfaceRadiance),
            S::Texture_UAV(70, rt.RRDiffuseAlbedo), S::Texture_UAV(71, rt.RRSpecAlbedo), S::Texture_UAV(72, rt.RRNormalsAndRoughness),
            S::Texture_UAV(73, rt.RRSpecMotionVectors),
            S::Texture_UAV(74, (rt.RRTransparencyLayer != nullptr) ? rt.RRTransparencyLayer : rt.RRSpecMotionVectors),
            S::Texture_UAV(75, rt.DenoiserAvgLayerRadianceHalfRes), S::RawBuffer_UAV(76, rt.SubSamplingPixelList),
            S::Texture_UAV(100, rt.OutputColor), S::Texture_UAV(101, rt.OutputColor), S::Texture_UAV(102, rt.OutputColor), S::Texture_UAV(103, rt.OutputColor),
            S::RawBuffer_UAV(SHADER_DEBUG_BUFFER_UAV_INDEX, shaderDebug->GetGPUWriteBuffer()),
            S::Texture_UAV(SHADER_DEBUG_VIZ_TEXTURE_UAV_INDEX, shaderDebug->GetDebugVizTexture()),
            S::TypedBuffer_SRV(15, lightsBaker->GetLightProxyCounters()), S::TypedBuffer_SRV(16, lightsBaker->GetLightSamplingProxies()),
            S::TypedBuffer_SRV(17, lightsBaker->GetLocalSamplingBuffer()), S::Texture_SRV(18, lightsBaker->GetEnvLightLookupMap()),
            S::TypedBuffer_SRV(19, lightsBaker->GetLightWeightsBoost()), S::Texture_UAV(20, lightsBaker->GetFeedbackTotalWeight()),
            S::Texture_UAV(21, lightsBaker->GetFeedbackCandidates()),
            S::Texture_UAV(40, rt.DenoisingLayersHeader), S::StructuredBuffer_UAV(42, rt.DenoisingLayersBuffer),
            S::Texture_UAV(44, rt.StableRadiance), S::StructuredBuffer_UAV(45, rt.SurfaceDataBuffer),
            S::Texture_SRV(80, commonPasses->m_BlackCubeMapArray), S::Texture_SRV(81, commonPasses->m_BlackCubeMapArray),
            S::Texture_SRV(82, commonPasses->m_BlackTexture),
            S::Texture_SRV(83, (envMapBaker->GetBRDFLUT() != nullptr) ? envMapBaker->GetBRDFLUT() : commonPasses->m_BlackTexture),
            S::Texture_SRV(84, commonPasses->m_BlackTexture), S::Texture_UAV(85, rt.Depth),
            S::Texture_SRV(87, commonPasses->m_BlackTexture), S::Texture_SRV(95, commonPasses->m_BlackTexture),
            S::StructuredBuffer_SRV(90, lightsBaker->GetLightBuffer()), S::StructuredBuffer_SRV(91, lightsBaker->GetLightExBuffer()),
            S::Texture_UAV(88, rt.OutputColor), S::Texture_UAV(89, rt.OutputColor), S::Texture_UAV(95, rt.OutputColor),
            S::StructuredBuffer_UAV(90, rt.DenoisingLayersBuffer), S::StructuredBuffer_UAV(91, rt.DenoisingLayersBuffer),
            S::StructuredBuffer_UAV(92, rt.DenoisingLayersBuffer),
            S::StructuredBuffer_SRV(50, bindlessValidationBuffer),
            S::StructuredBuffer_UAV(94, rt.DenoisingLayersBuffer), S::TypedBuffer_SRV(94, lightsBaker->GetLightProxyCounters()),
            S::ConstantBuffer(12, constantBuffer),
        };
        bindingSet = device->createBindingSet(desc, bindingLayout);
    }

    // Sample::Render's renderer setup (its needNewPasses branches, RecreateAccelStructs, the pipeline bakers'
    // Update), done between frames on a command list of its own. Bits of the result: 1 the render targets
    // were made again, 2 the passes, 4 the acceleration structures.
    int Prepare(uint32_t width, uint32_t height, bool needNewPasses, bool rebuildAccelStructs, int qualityPreset)
    {
        int result = 0;
        if (renderTargets == nullptr || renderSize.x != width || renderSize.y != height)
        {
            device->waitForIdle();
            device->runGarbageCollection();
            ReleaseDenoisers();
            temporalAntiAliasingPass = nullptr;
            renderTargets = nullptr;
            bindingCache->Clear();
            renderSize = uint2(width, height);
            renderTargets = std::make_unique<RenderTargets>();
            renderTargets->Init(device, renderSize, renderSize, c_SwapchainCount, RenderTargets::OptionalBuffers{});
            view->SetViewport(nvrhi::Viewport(float(width), float(height)));
            viewPrevious->SetViewport(nvrhi::Viewport(float(width), float(height)));
            needNewPasses = true;
            result |= 1;
        }
        // NEE-AT's buffers and the path tracer's shaders follow the quality preset.
        if (lightsBaker != nullptr && neeatQualityPreset != qualityPreset)
            needNewPasses = true;
        neeatQualityPreset = qualityPreset;

        if (needNewPasses)
        {
            if (ptPipelineBaker == nullptr)
            {
                ptPipelineBaker = std::make_shared<PTPipelineBaker>(device, materialsBaker, bindingLayout, bindlessLayout,
                    [this](std::vector<ShaderMacro>& macros) { GetGlobalMacros(macros); }, bindlessHeapLayout);
                computePipelineBaker = std::make_shared<ComputePipelineBaker>(device);
                ptPipelineReference = ptPipelineBaker->CreateVariant("PathTracerSample.hlsl", { ShaderMacro("PATH_TRACER_MODE", "PT_REFERENCE") }, "REF");
                // AdvancedPathTracer::CreateRTPipelines': the fill pass's sub-sampling macros are
                // AdaptiveSampling::GetFillPassMacros' without sub-sampling (not ported).
                ptPipelineBuildDenoisingLayers = ptPipelineBaker->CreateVariant("PathTracerSample.hlsl", { ShaderMacro("PATH_TRACER_MODE", "PT_DENOISING_LAYERS_BUILD") }, "BUILD");
                ptPipelineFillDenoisingLayers = ptPipelineBaker->CreateVariant("PathTracerSample.hlsl", { ShaderMacro("PATH_TRACER_MODE", "PT_DENOISING_LAYERS_FILL") }, "FILL", false,
                    [](std::vector<ShaderMacro>& macros)
                    {
                        macros.push_back(ShaderMacro("RTXPT_SUB_SAMPLING_SCALE_X", "1"));
                        macros.push_back(ShaderMacro("RTXPT_SUB_SAMPLING_SCALE_Y", "1"));
                        macros.push_back(ShaderMacro("RTXPT_SUB_SAMPLING_RATE_NUM", "1"));
                        macros.push_back(ShaderMacro("RTXPT_SUB_SAMPLING_PATTERN", "0"));
                        macros.push_back(ShaderMacro("RTXPT_SUB_SAMPLING_BLOCK_SIZE", "8"));
                    });
            }
            materialsBaker->CreateRenderPassesAndLoadMaterials(bindlessLayout, commonPasses, scene, scenePath, assetsPath);
        }

        if (rebuildAccelStructs || topLevelAS == nullptr)
        {
            device->waitForIdle();
            bindingSet = nullptr;
            topLevelAS = nullptr;
            bindingCache->Clear();
            for (const auto& mesh : scene->GetSceneGraph()->GetMeshes())
                mesh->accelStruct = nullptr;
            commandList->open();
            CreateAccelStructs(commandList);
            commandList->close();
            device->executeCommandList(commandList);
            device->waitForIdle();
            result |= 4;
        }

        if (needNewPasses)
        {
            device->waitForIdle();
            commandList->open();
            CreateRenderPasses(commandList);
            commandList->close();
            device->executeCommandList(commandList);
            bindingSet = nullptr;
            result |= 2;
        }

        // The path tracer's shaders compile here (a hit group per material).
        ptPipelineBaker->Update(scene, subInstanceCount, needNewPasses);
        computePipelineBaker->Update(needNewPasses);
        return result;
    }

    // Sample::CreateRenderPasses (the reference path tracer's passes) and AdvancedPathTracer's.
    void CreateRenderPasses(nvrhi::ICommandList* cl)
    {
        bindingCache->Clear();
        shaderDebug = std::make_shared<ShaderDebug>(device, cl, shaderFactory, commonPasses);

        accumulationPass = std::make_unique<AccumulationPass>(device, shaderFactory);
        accumulationPass->CreatePipeline();
        accumulationPass->CreateBindingSet(renderTargets->OutputColor, renderTargets->AccumulatedRadiance, renderTargets->ProcessedOutputColor);

        std::unique_ptr<ToneMappingPass> previousToneMappingPass = std::move(toneMappingPass);
        toneMappingPass = std::make_unique<ToneMappingPass>(device, shaderFactory, commonPasses, renderTargets->LdrFramebuffer, *view, renderTargets->OutputColor);
        if (previousToneMappingPass != nullptr)
            toneMappingPass->InheritAutoExposure(*previousToneMappingPass);
        bloomPass = std::make_unique<render::BloomPass>(device, shaderFactory, commonPasses, renderTargets->ProcessedOutputFramebuffer, *view);
        postProcess = std::make_shared<PostProcess>(device, shaderFactory, commonPasses, shaderDebug);
        temporalAntiAliasingPass = nullptr;     // made again by UpdateTemporalAntiAliasingPass

        if (envMapBaker == nullptr)
            envMapBaker = std::make_shared<EnvMapBaker>(device, textureCache, false);
        if (lightsBaker == nullptr)
            lightsBaker = std::make_shared<LightsBaker>(device);
        envMapBaker->CreateRenderPasses(shaderDebug, shaderFactory, computePipelineBaker);
        envMapBaker->GenerateBRDFLUT(cl, *bindingCache);
        lightsBaker->CreateRenderPasses(computePipelineBaker, bindlessLayout, commonPasses, shaderDebug, renderSize,
            envMapBaker->GetImportanceSampling()->GetImportanceMapResolution(), neeatQualityPreset);

        denoisingGuidesBaker = std::make_shared<DenoisingGuidesBaker>(device, shaderFactory, renderTargets, shaderDebug, bindingLayout);
    }

    // examples/rtxpt.ts's macros, then the lights baker's (Sample::GetPTPipelineGlobalMacros).
    void GetGlobalMacros(std::vector<ShaderMacro>& macros)
    {
        macros = globalMacros;
        if (lightsBaker != nullptr)
            lightsBaker->SetGlobalShaderMacros(macros);
    }

    // Sample::UpdateTemporalAntiAliasingPass: TAA and its history exist only while it's on.
    void UpdateTemporalAntiAliasingPass()
    {
        const RtxptFrameSettings& s = settings;
        if (!s.realtimeMode || s.realtimeAA != 1)
        {
            temporalAntiAliasingPass = nullptr;
            renderTargets->ReleaseTemporalFeedback();
            return;
        }
        renderTargets->EnsureTemporalFeedback();
        if (temporalAntiAliasingPass == nullptr)
        {
            temporalAntiAliasingFeedbackValid = false;
            render::TemporalAntiAliasingPass::CreateParameters taaParams;
            taaParams.sourceDepth = renderTargets->Depth;
            taaParams.motionVectors = renderTargets->ScreenMotionVectors;
            taaParams.unresolvedColor = renderTargets->OutputColor;
            taaParams.resolvedColor = renderTargets->ProcessedOutputColor;
            taaParams.feedback1 = renderTargets->TemporalFeedback1;
            taaParams.feedback2 = renderTargets->TemporalFeedback2;
            taaParams.historyClampRelax = renderTargets->CombinedHistoryClampRelax;
            taaParams.motionVectorStencilMask = 0;
            taaParams.useCatmullRomFilter = true;
            temporalAntiAliasingPass = std::make_unique<render::TemporalAntiAliasingPass>(device, shaderFactory, commonPasses, *view, taaParams);
        }
        temporalAntiAliasingPass->SetJitter((render::TemporalAntiAliasingJitter)s.taaJitter);
    }

    static float VanDerCorput(uint32_t base, uint32_t index)
    {
        float result = 0.0f;
        for (float denominator = float(base); index > 0; index /= base, denominator *= base)
            result += float(index % base) / denominator;
        return result;
    }

    // Sample::ComputeCameraJitter: TAA's own sequence, or (DLSS) the same sequences by frame index; none in reference
    // mode or without AA. The render size is the display size here: Halton's phase count is 32.
    float2 ComputeCameraJitter() const
    {
        const RtxptFrameSettings& s = settings;
        if (!s.realtimeMode || s.realtimeAA == 0)
            return float2(0.0f, 0.0f);
        if (s.realtimeAA == 1 && temporalAntiAliasingPass != nullptr)
            return temporalAntiAliasingPass->GetCurrentPixelOffset();
        const uint64_t frameIndex = s.frameIndex;
        switch ((render::TemporalAntiAliasingJitter)s.taaJitter)
        {
        default:
        case render::TemporalAntiAliasingJitter::MSAA:
        {
            // RTXPT_MSAA_JITTER_SAMPLE_COUNT 16: the standard D3D pattern, in 1/16 pixels.
            static const int2 offsets[] = {
                int2(1, 1), int2(-1, -3), int2(-3, 2), int2(4, -1), int2(-5, -2), int2(2, 5), int2(5, 3), int2(3, -5),
                int2(-2, 6), int2(0, -7), int2(-4, -6), int2(-6, 4), int2(-8, 0), int2(7, -4), int2(6, 7), int2(-7, -8)
            };
            return float2(offsets[frameIndex % 16]) / 16.0f;
        }
        case render::TemporalAntiAliasingJitter::Halton:
        {
            const uint32_t index = uint32_t(frameIndex % 32) + 1;
            return float2{ VanDerCorput(2, index), VanDerCorput(3, index) } - 0.5f;
        }
        case render::TemporalAntiAliasingJitter::R2:
        {
            const double g = 1.32471795724474602596;
            return float2{ float(std::fmod(double(frameIndex) / g, 1.0)), float(std::fmod(double(frameIndex) / (g * g), 1.0)) } - 0.5f;
        }
        case render::TemporalAntiAliasingJitter::WhiteNoise:
        {
            std::mt19937 rng{ uint32_t(frameIndex) };
            std::uniform_real_distribution<float> dist(-0.5f, 0.5f);
            return float2{ dist(rng), dist(rng) };
        }
        }
    }

    // Sample::UpdateViews, with the camera's jitter.
    void UpdateViews(bool firstFrame)
    {
        UpdateTemporalAntiAliasingPass();
        const RtxptFrameSettings& s = settings;
        const float3 pos(s.cameraPos[0], s.cameraPos[1], s.cameraPos[2]);
        const float3 dir(s.cameraDir[0], s.cameraDir[1], s.cameraDir[2]);
        const float3 up(s.cameraUp[0], s.cameraUp[1], s.cameraUp[2]);
        // FirstPersonCamera::GetWorldToViewMatrix (BaseCamera::BaseLookAt and UpdateWorldToView).
        const float3 right = normalize(cross(dir, up));
        const float3 trueUp = normalize(cross(right, dir));
        const affine3 worldToView = translation(-pos) * affine3::from_cols(right, trueUp, dir, 0.f);
        view->SetViewport(nvrhi::Viewport(float(renderSize.x), float(renderSize.y)));
        view->SetMatrices(worldToView, perspProjD3DStyleReverse(s.fovY, float(renderSize.x) / float(renderSize.y), s.zNear));
        view->SetPixelOffset(ComputeCameraJitter());
        view->UpdateCache();
        if (firstFrame)
        {
            viewPrevious->SetMatrices(view->GetViewMatrix(), view->GetProjectionMatrix());
            viewPrevious->SetPixelOffset(view->GetPixelOffset());
            viewPrevious->UpdateCache();
        }
    }

    // Sample::Render up to the main path tracing pass: the scene's buffers, the materials, the acceleration
    // structures, the environment map, the binding set, the constants and the lights.
    // Returns true if the environment map changed (Sample resets the accumulation then).
    bool BeginFrame(nvrhi::ICommandList* cl)
    {
        const RtxptFrameSettings& s = settings;
        const bool firstFrame = s.frameIndex == 0;

        // The environment map's transform and radiance.
        if (s.envMapEnabled)
        {
            const float intensity = s.envMapIntensity / c_envMapRadianceScale;
            envMapSceneParams.ColorMultiplier = float3(s.envMapTint[0], s.envMapTint[1], s.envMapTint[2]) * intensity;
            const affine3 rotationTransform = rotation(radians(float3(s.envMapRotation[0], s.envMapRotation[1], s.envMapRotation[2])));
            affineToColumnMajor(rotationTransform, envMapSceneParams.Transform);
            affineToColumnMajor(inverse(rotationTransform), envMapSceneParams.InvTransform);
            envMapSceneParams.Enabled = 1;
        }
        else
        {
            envMapSceneParams.ColorMultiplier = float3(0, 0, 0);
            envMapSceneParams.Enabled = 0;
        }

        UpdateViews(firstFrame);

        scene->Refresh(cl, s.frameIndex);
        sceneRenderCache.Open(scene, &frameWorkerPool);
        materialsBaker->Update(cl, scene, subInstanceData, sceneRenderCache);
        cl->writeBuffer(subInstanceBuffer, subInstanceData.data(), subInstanceData.size() * sizeof(SubInstanceData));
        UpdateSkinnedBLASs(cl, s.frameIndex);
        BuildTLAS(cl);

        // PreUpdateLighting: a new environment cube needs a new binding set.
        auto previousCube = envMapBaker->GetEnvMapCube();
        if (envMapBaker->PreUpdate(cl, commonPasses, envMapLocalPath))
            bindingCache->Clear();
        if (previousCube != envMapBaker->GetEnvMapCube())
            bindingSet = nullptr;

        if (bindingSet == nullptr)
        {
            shaderDebug->CreateRenderPasses(renderTargets->LdrFramebuffer->GetFramebuffer(*view), renderTargets->Depth);
            RecreateBindingSet();
        }

        ToneMappingParameters toneMapping;
        toneMapping.toneMapOperator = (ToneMapperOperator)s.toneMapOperator;
        toneMapping.autoExposure = s.autoExposure != 0;
        toneMapping.exposureCompensation = s.exposureCompensation;
        toneMapping.exposureValue = s.exposureValue;
        toneMapping.exposureValueMin = s.exposureValueMin;
        toneMapping.exposureValueMax = s.exposureValueMax;
        toneMappingPass->PreRender(toneMapping);

        renderTargets->Clear(cl);

        // The constants (Sample::UpdatePathTracerConstants and Render's).
        SampleConstants& c = constants;
        std::memset(&c, 0, sizeof(c));
        const float3 camPos(s.cameraPos[0], s.cameraPos[1], s.cameraPos[2]);
        const PathTracerCameraData cameraData = BridgeCamera(renderSize.x, renderSize.y, float(renderSize.x) / float(renderSize.y),
            camPos, float3(s.cameraDir[0], s.cameraDir[1], s.cameraDir[2]), float3(s.cameraUp[0], s.cameraUp[1], s.cameraUp[2]),
            s.fovY, s.zNear, 1e7f, s.focalDistance, s.apertureRadius, view->GetPixelOffset());
        PathTracerConstants& pt = c.ptConsts;
        pt.camera = cameraData;
        pt.prevCamera = firstFrame ? cameraData : lastCameraData;
        lastCameraData = cameraData;
        pt.bounceCount = s.bounceCount;
        pt.diffuseBounceCount = s.diffuseBounceCount;
        pt.perPixelJitterAAScale = s.perPixelJitterAAScale;
        pt.texLODBias = s.texLODBias;
        const uint32_t samplesPerPixel = ActualSamplesPerPixel();
        pt.sampleBaseIndex = s.sampleIndex * samplesPerPixel;
        pt.invSubSampleCount = 1.0f / (float)samplesPerPixel;
        pt.imageWidth = renderSize.x;
        pt.imageHeight = renderSize.y;
        pt.preExposedGrayLuminance = s.enableToneMapping ? luminance(toneMappingPass->GetPreExposedGray(0)) : 1.0f;
        pt.fireflyFilterThreshold = s.fireflyFilterEnabled ? FireflyFilterThreshold(s.fireflyFilterThreshold, pt.preExposedGrayLuminance) : 0.0f;
        pt.useReSTIRDI = 0;
        pt.useReSTIRGI = 0;
        pt.denoiserRadianceClampK = s.denoiserRadianceClampK;
        pt.DLSSRRBrightnessClampK = 4096.0f * pt.preExposedGrayLuminance;   // SampleUIData's DLSSRRBrightnessClampK
        pt.denoisingEnabled = UseStandaloneDenoiser() ? 1 : 0;
        pt._activeDenoisingLayerCount = s.activeDenoisingLayerCount;
        pt.maxDenoisingLayerVertexDepth = std::min(std::min(s.denoisingLayersMaxVertexDepth, cDenoisingLayerMaxVertexIndex), s.bounceCount);
        pt.allowPrimarySurfaceReplacement = s.allowPrimarySurfaceReplacement;
        pt.denoisingLayersSplitStopThreshold = s.denoisingLayersSplitStopThreshold;
        pt.denoisingLayersSuppressPrimaryIndirectSpecularK = s.denoisingLayersSuppressPrimaryIndirectSpecularK;
        pt.denoisingLayersAntiAliasingFallthrough = s.denoisingLayersAntiAliasingFallthrough;
        pt.frameIndex = s.frameIndex;
        pt.genericTSLineStride = GenericTSComputeLineStride(renderSize.x, renderSize.y);
        pt.genericTSPlaneStride = GenericTSComputePlaneStride(renderSize.x, renderSize.y);
        pt.NEEEnabled = s.neeEnabled;
        pt.NEEType = s.neeType;
        pt.NEECandidateSamples = s.neeCandidateSamples;
        pt.NEEFullSamples = s.neeFullSamples;
        pt.EnvironmentMapDiffuseSampleMIPLevel = s.envMapDiffuseMipLevel;

        c.MaterialCount = materialsBaker->GetMaterialDataCount();
        c.envMapSceneParams = envMapSceneParams;
        c.envMapImportanceSamplingParams = envMapBaker->GetImportanceSampling()->GetShaderParams();
        PlanarViewConstants viewConstants;
        view->FillPlanarViewConstants(viewConstants);
        PlanarViewConstants previousViewConstants;
        viewPrevious->FillPlanarViewConstants(previousViewConstants);
        c.view = FromPlanarViewConstants(viewConstants);
        c.previousView = FromPlanarViewConstants(previousViewConstants);
        c.debug.pickX = -1;
        c.debug.pickY = -1;
        c.debug.debugViewType = 0;
        c.debug.debugViewDenoisingLayerIndex = (s.activeDenoisingLayerCount == 1) ? 0 : -1;
        c.debug.imageWidth = renderSize.x;
        c.debug.imageHeight = renderSize.y;
        c.debug.cameraPosW = camPos;
        c.denoisingHitParamConsts = float3(reblurSettings.hitDistanceParameters.A, reblurSettings.hitDistanceParameters.B,
            reblurSettings.hitDistanceParameters.C);

        const bool environmentChanged = UpdateLighting(cl);
#if RTXPT_SUBINSTANCE_LIGHT_PATCH_PASS
        // Only the sub-instances' two light fields changed since the upload above: patched on the GPU.
        lightsBaker->ApplySubInstanceLightPatches(cl, *bindingCache, subInstanceBuffer);
#else
        cl->writeBuffer(subInstanceBuffer, subInstanceData.data(), subInstanceData.size() * sizeof(SubInstanceData));
#endif
        c.lightControl.AnalyticLightOffset = lightsBaker->GetAnalyticLightOffset();
        c.lightControl.AnalyticLightCount = lightsBaker->GetAnalyticLightCount();
        cl->writeBuffer(constantBuffer, &c, sizeof(c));
        return environmentChanged;
    }

    // Sample::UpdateLighting: the directional lights baked into the environment map, then the lights baker.
    bool UpdateLighting(nvrhi::ICommandList* cl)
    {
        const RtxptFrameSettings& s = settings;
        EMB_DirectionalLight dirLights[EnvMapBaker::c_MaxDirLights];
        uint32_t dirLightCount = 0;
        const affine3 rotationTransform = rotation(radians(float3(s.envMapRotation[0], s.envMapRotation[1], s.envMapRotation[2])));
        for (const auto& light : lights)
        {
            auto dirLight = std::dynamic_pointer_cast<DirectionalLight>(light);
            if (dirLight == nullptr || dirLightCount >= EnvMapBaker::c_MaxDirLights)
                continue;
            LightConstants lc;
            dirLight->FillLightConstants(lc);
            const float minAngularSize = PI_f / (envMapBaker->GetTargetCubeResolution() / 2.0f);
            dirLights[dirLightCount].AngularSize = std::max(lc.angularSizeOrInvRange, minAngularSize);
            dirLights[dirLightCount].ColorIntensity = float4(lc.color, lc.intensity);
            dirLights[dirLightCount].Direction = rotationTransform.transformVector(lc.direction);
            dirLightCount++;
        }
        const bool environmentChanged = envMapBaker->Update(cl, *bindingCache, commonPasses, EnvMapBaker::BakeSettings{ .EnvMapRadianceScale = c_envMapRadianceScale },
            sceneTime, dirLights, dirLightCount, !s.realtimeMode || !s.enableAnimations);

        LightsBaker::BakeSettings bake;
        bake.ImportanceSamplingType = s.neeType;
        bake.CameraPosition = float3(s.cameraPos[0], s.cameraPos[1], s.cameraPos[2]);
        bake.CameraDirection = float3(s.cameraDir[0], s.cameraDir[1], s.cameraDir[2]);
        bake.ViewProjMatrix = view->GetViewProjectionMatrix();
        bake.GlobalTemporalFeedbackWeight = s.neeatGlobalTemporalFeedbackWeight;
        bake.LocalToGlobalSampleRatio = s.neeatLocalToGlobalSampleRatio;
        bake.UseApproximateMIS = s.useApproximateMIS != 0;
        bake.DistantVsLocalImportanceScale = s.neeatDistantVsLocalImportance;
        bake.ResetFeedback = (s.resetAccumulation != 0 && !s.realtimeMode) || s.resetRealtimeCaches != 0;
        bake.PrevViewportSize = float2((float)viewPrevious->GetViewExtent().width(), (float)viewPrevious->GetViewExtent().height());
        bake.ViewportSize = float2((float)view->GetViewExtent().width(), (float)view->GetViewExtent().height());
        bake.EnvMapParams = NEEAT::LightsBakerEnvMapParams{ .Transform = envMapSceneParams.Transform, .InvTransform = envMapSceneParams.InvTransform,
            .ColorMultiplier = envMapSceneParams.ColorMultiplier, .Enabled = envMapSceneParams.Enabled };
        bake.FrameIndex = s.frameIndex;
        lightsBaker->UpdateBegin(cl, *bindingCache, bake, sceneTime, scene, materialsBaker, nullptr, subInstanceBuffer, subInstanceData,
            envMapBaker->GetImportanceSampling()->GetRadianceAndImportanceMap(), sceneRenderCache);
        return environmentChanged;
    }

    // SampleUIData::ActualUseStandaloneDenoiser (TAA or no AA: DLSS-RR, the other denoiser, isn't ported).
    bool UseStandaloneDenoiser() const
    {
        return settings.realtimeMode && settings.standaloneDenoiser;
    }

    // The path tracer's samples per pixel in a frame: the real-time mode's, 1 in reference mode.
    uint32_t ActualSamplesPerPixel() const
    {
        return (settings.realtimeMode && settings.samplesPerPixel > 1) ? settings.samplesPerPixel : 1u;
    }

    void ReleaseDenoisers()
    {
        for (auto& instance : nrdInstances)
            instance = nullptr;
    }

    // AdvancedPathTracer::PathTrace: in real-time mode the denoising layers' build pass first; then the lights
    // baker's end, the path tracer (the reference raygen, or the denoising layers' fill) samplesPerPixel times and
    // the specular hit distance guide; then (SampleRenderCode) the denoiser.
    void PathTrace(nvrhi::ICommandList* cl)
    {
        const bool useDenoisingLayers = settings.realtimeMode != 0;
        nvrhi::rt::State state;
        state.bindings = { bindingSet, descriptorTable->GetDescriptorTable(), heapDescriptorTable->GetDescriptorTable() };
        nvrhi::rt::DispatchRaysArguments args;
        args.width = renderSize.x;
        args.height = renderSize.y;

        if (useDenoisingLayers)
        {
            cl->setTextureState(renderTargets->Depth, nvrhi::AllSubresources, nvrhi::ResourceStates::UnorderedAccess);
            cl->setTextureState(renderTargets->ScreenMotionVectors, nvrhi::AllSubresources, nvrhi::ResourceStates::UnorderedAccess);
            cl->setTextureState(renderTargets->Throughput, nvrhi::AllSubresources, nvrhi::ResourceStates::UnorderedAccess);
            cl->setTextureState(renderTargets->SpecularHitT, nvrhi::AllSubresources, nvrhi::ResourceStates::UnorderedAccess);
            state.shaderTable = ptPipelineBuildDenoisingLayers->GetShaderTable();
            cl->setRayTracingState(state);
            SampleMiniConstants miniConstants = {};
            cl->setPushConstants(&miniConstants, sizeof(miniConstants));
            cl->dispatchRays(args);
            cl->setBufferState(renderTargets->DenoisingLayersBuffer, nvrhi::ResourceStates::UnorderedAccess);
            cl->setTextureState(renderTargets->Depth, nvrhi::AllSubresources, nvrhi::ResourceStates::UnorderedAccess);
            cl->setTextureState(renderTargets->ScreenMotionVectors, nvrhi::AllSubresources, nvrhi::ResourceStates::UnorderedAccess);
            cl->setTextureState(renderTargets->Throughput, nvrhi::AllSubresources, nvrhi::ResourceStates::UnorderedAccess);
        }

        lightsBaker->UpdateEnd(cl, *bindingCache, scene, materialsBaker, nullptr, subInstanceBuffer, renderTargets->Depth, renderTargets->ScreenMotionVectors);

        state.shaderTable = (useDenoisingLayers ? ptPipelineFillDenoisingLayers : ptPipelineReference)->GetShaderTable();
        const uint32_t samplesPerPixel = ActualSamplesPerPixel();
        for (uint32_t subSampleIndex = 0; subSampleIndex < samplesPerPixel; subSampleIndex++)
        {
            cl->setBufferState(renderTargets->DenoisingLayersBuffer, nvrhi::ResourceStates::UnorderedAccess);
            cl->setTextureState(renderTargets->SpecularHitT, nvrhi::AllSubresources, nvrhi::ResourceStates::UnorderedAccess);
            cl->setRayTracingState(state);
            SampleMiniConstants miniConstants = {};
            miniConstants.params = uint4(subSampleIndex, 0, 0, 0);
            cl->setPushConstants(&miniConstants, sizeof(miniConstants));
            cl->dispatchRays(args);
            cl->setTextureState(renderTargets->SpecularHitT, nvrhi::AllSubresources, nvrhi::ResourceStates::UnorderedAccess);
        }
        cl->setBufferState(renderTargets->DenoisingLayersBuffer, nvrhi::ResourceStates::UnorderedAccess);

        denoisingGuidesBaker->DenoiseSpecHitT(cl, bindingSet);

        Denoise(cl);
    }

    // Sample::Denoise: NRD per denoising layer, the last first, each between its input preparation and its
    // merge into OutputColor (the first prepare starts from the stable radiance).
    void Denoise(nvrhi::ICommandList* cl)
    {
        if (!UseStandaloneDenoiser())
        {
            ReleaseDenoisers();
            return;
        }
        const bool useRelax = settings.nrdMethod == (uint32_t)NrdConfig::DenoiserMethod::RELAX;
        if (nrdMethod != settings.nrdMethod)
        {
            ReleaseDenoisers();
            nrdMethod = settings.nrdMethod;
        }
        for (auto& instance : nrdInstances)
            if (instance == nullptr)
            {
                instance = std::make_unique<NrdIntegration>(device, useRelax ? nrd::Denoiser::RELAX_DIFFUSE_SPECULAR : nrd::Denoiser::REBLUR_DIFFUSE_SPECULAR);
                instance->Initialize(renderSize.x, renderSize.y, *shaderFactory);
            }

        const PostProcess::ComputePassType preparePassType = useRelax ? PostProcess::ComputePassType::RELAXDenoiserPrepareInputs : PostProcess::ComputePassType::REBLURDenoiserPrepareInputs;
        const PostProcess::ComputePassType mergePassType = useRelax ? PostProcess::ComputePassType::RELAXDenoiserFinalMerge : PostProcess::ComputePassType::REBLURDenoiserFinalMerge;
        const bool resetHistory = settings.resetRealtimeCaches != 0;
        const int passCount = std::min((int)settings.activeDenoisingLayerCount, (int)std::size(nrdInstances));
        bool initWithStableRadiance = true;
        for (int pass = passCount - 1; pass >= 0; pass--)
        {
            SampleMiniConstants miniConstants = { uint4((uint)pass, initWithStableRadiance ? 1 : 0, 0, 0) };
            initWithStableRadiance = false;
            const nvrhi::TextureDesc& outputDesc = renderTargets->OutputColor->getDesc();
            postProcess->Apply(cl, preparePassType, constantBuffer, miniConstants, bindingSet, bindingLayout, outputDesc.width, outputDesc.height);

            // A negative time between frames: NRD measures it itself.
            const void* methodSettings = useRelax ? (const void*)&relaxSettings : (const void*)&reblurSettings;
            nrdInstances[pass]->RunDenoiserPasses(cl, *renderTargets, pass, *view, *viewPrevious, settings.frameIndex,
                settings.nrdDisocclusionThreshold, settings.nrdDisocclusionThresholdAlternate, settings.nrdUseAlternateDisocclusionThresholdMix != 0,
                -1.0f, false, resetHistory, methodSettings);

            postProcess->Apply(cl, mergePassType, pass, constantBuffer, miniConstants, renderTargets->OutputColor, *renderTargets, nullptr);
        }
    }

    // Sample::PostProcessAA: the accumulation in reference mode; TAA, DLSS (or a copy) in real-time mode, then without the
    // denoiser the denoising layers' merge into OutputColor (after the copy, as the sample does).
    void PostProcessAA(nvrhi::ICommandList* cl, float accumulationWeight)
    {
        const bool dlssRuns = settings.realtimeMode && settings.realtimeAA == 2 && dlss != nullptr && Donut_IsDlssInitialized(dlss);
        const bool dlssReset = !dlssActive || settings.frameIndex == 0 || settings.resetRealtimeCaches;
        dlssActive = dlssRuns;
        if (!settings.realtimeMode)
        {
            accumulationPass->Render(cl, *view, *view, accumulationWeight);
            return;
        }
        if (dlssRuns)
        {
            // Depth (reverse-Z) and ScreenMotionVectors (pixels, previous minus current) as Donut's TAA takes them.
            const float2 jitter = view->GetPixelOffset();
            Donut_EvaluateDlssTextures(cl, dlss, renderTargets->Depth, renderTargets->ScreenMotionVectors, renderTargets->OutputColor,
                renderTargets->ProcessedOutputColor, int(renderSize.x), int(renderSize.y), jitter.x, jitter.y, dlssReset ? 1 : 0);
        }
        else if (settings.realtimeAA == 1 && temporalAntiAliasingPass != nullptr)
        {
            render::TemporalAntiAliasingParameters taaParams;
            taaParams.newFrameWeight = settings.taaNewFrameWeight;
            taaParams.enableHistoryClamping = settings.taaEnableHistoryClamping != 0;
            taaParams.useHistoryClampRelax = settings.taaUseHistoryClampRelax != 0;
            const bool previousViewValid = settings.frameIndex != 0 && temporalAntiAliasingFeedbackValid;
            temporalAntiAliasingPass->TemporalResolve(cl, taaParams, previousViewValid, *view, *view);
            temporalAntiAliasingFeedbackValid = true;
        }
        else
            cl->copyTexture(renderTargets->ProcessedOutputColor, nvrhi::TextureSlice(), renderTargets->OutputColor, nvrhi::TextureSlice());

        if (!UseStandaloneDenoiser())
        {
            SampleMiniConstants miniConstants = { uint4(0, 0, 0, 0) };
            const nvrhi::TextureDesc& outputDesc = renderTargets->OutputColor->getDesc();
            postProcess->Apply(cl, PostProcess::ComputePassType::NoDenoiserFinalMerge, constantBuffer, miniConstants, bindingSet, bindingLayout,
                outputDesc.width, outputDesc.height);
        }
    }

    // PostProcessAA, PostProcessPreToneMapping's bloom and the tone mapping into LdrColor.
    void Resolve(nvrhi::ICommandList* cl, float accumulationWeight)
    {
        PostProcessAA(cl, accumulationWeight);

        PlanarView fullscreenView = *view;
        fullscreenView.SetViewport(nvrhi::Viewport(float(renderSize.x), float(renderSize.y)));
        fullscreenView.UpdateCache();
        if (settings.enableBloom && settings.bloomIntensity > 0.f && settings.bloomRadius > 0.f)
            bloomPass->Render(cl, renderTargets->ProcessedOutputFramebuffer, fullscreenView, renderTargets->ProcessedOutputColor,
                settings.bloomRadius, settings.bloomIntensity);
        // The first run may close and open the list again: the volatile constants go again then.
        if (toneMappingPass->Render(cl, *bindingCache, fullscreenView, renderTargets->ProcessedOutputColor, settings.enableToneMapping != 0))
            cl->writeBuffer(constantBuffer, &constants, sizeof(constants));
    }

    // Sample::PostRender, and Render's end: TAA's next jitter, the views swap.
    void EndFrame()
    {
        sceneRenderCache.Close();
        if (temporalAntiAliasingPass != nullptr)
            temporalAntiAliasingPass->AdvanceFrame();
        std::swap(view, viewPrevious);
    }
};

extern "C"
{
    // Makes the sample's code find bin/ShaderDynamic (its run-time shader compiler and sources) where
    // this module is, under the JIT too. Returns false without it (CMakeLists.txt's rtxpt_dynamic_shaders).
    DONUT_API bool Donut_RtxptSetup()
    {
        std::filesystem::path directory = ModuleDirectory();
        donut::app::SetDirectoryWithExecutable(directory);
        return std::filesystem::exists(directory / "ShaderDynamic" / "Source" / "Rtxpt");
    }

    DONUT_API RtxptRenderer* Donut_RtxptRendererCreate(void* device, const char* assetsDirectory)
    {
        if (!Donut_RtxptSetup())
        {
            log::error("rtxpt: no ShaderDynamic/ next to %s (build the rtxpt_dynamic_shaders target)", ModuleDirectory().string().c_str());
            return nullptr;
        }
        // Sample's constructor and Init: the shader sources' change monitor (the pipeline bakers poll it) and the
        // profiler the passes mark their GPU work for.
        DirectoryModifiedMonitor::Init();
        GpuProfiler::Init(static_cast<nvrhi::IDevice*>(device));
        auto r = std::make_unique<RtxptRenderer>();
        if (!r->Init(static_cast<nvrhi::IDevice*>(device), assetsDirectory))
            return nullptr;
        return r.release();
    }

    DONUT_API void Donut_RtxptRendererDestroy(RtxptRenderer* r)
    {
        r->UnloadScene();
        r->device->waitForIdle();
        delete r;
        DirectoryModifiedMonitor::Shutdown();
        GpuProfiler::Shutdown();
    }

    DONUT_API bool Donut_RtxptRendererLoadScene(RtxptRenderer* r, const char* scenePath)
    {
        return r->LoadScene(scenePath);
    }

    DONUT_API bool Donut_RtxptRendererFinishLoadingScene(RtxptRenderer* r)
    {
        return r->FinishLoadingScene();
    }

    // SampleGame (core/rtxpt_game.ts). Whether the scene has a GameSettings node (GameScene::SceneLoaded).
    DONUT_API bool Donut_RtxptRendererHasGameSettings(RtxptRenderer* r)
    {
        return r->scene != nullptr && r->scene->GetGameSettingsNode() != nullptr;
    }

    // The scene's models (ExtendedScene::GetModels, the scene file's "models"): their count and import root names.
    DONUT_API int Donut_RtxptRendererGetSceneModelCount(RtxptRenderer* r)
    {
        return r->scene != nullptr ? (int)r->scene->GetModels().size() : 0;
    }

    DONUT_API const char* Donut_RtxptRendererGetSceneModelRootName(RtxptRenderer* r, int modelIndex)
    {
        const auto& models = r->scene->GetModels();
        if (modelIndex < 0 || modelIndex >= (int)models.size() || !models[modelIndex].rootNode)
            return "";
        return models[modelIndex].rootNode->GetName().c_str();
    }

    // ModelType's constructor: the model's pose on its import root (copied with it to every instance).
    DONUT_API void Donut_RtxptRendererSetSceneModelTransform(RtxptRenderer* r, int modelIndex, double tx, double ty, double tz,
        double rx, double ry, double rz, double rw, double sx, double sy, double sz)
    {
        const auto& models = r->scene->GetModels();
        if (modelIndex < 0 || modelIndex >= (int)models.size() || !models[modelIndex].rootNode)
            return;
        const double3 translation(tx, ty, tz);
        const dquat rotation = dquat::fromXYZW(double4(rx, ry, rz, rw));
        const double3 scaling(sx, sy, sz);
        models[modelIndex].rootNode->SetTransform(&translation, &rotation, &scaling);
    }

    // A new named node under `parent` (-1: the scene's root); returns its handle.
    DONUT_API int Donut_RtxptRendererCreateGameNode(RtxptRenderer* r, int parent, const char* name)
    {
        return r->CreateGameNode(parent, name);
    }

    DONUT_API void Donut_RtxptRendererAttachGameModel(RtxptRenderer* r, int parent, int modelIndex)
    {
        r->AttachGameModel(parent, modelIndex);
    }

    DONUT_API const char* Donut_RtxptRendererGetGameNodeName(RtxptRenderer* r, int node)
    {
        return r->GameNode(node)->GetName().c_str();
    }

    DONUT_API void Donut_RtxptRendererSetGameNodeTransform(RtxptRenderer* r, int node, double tx, double ty, double tz,
        double rx, double ry, double rz, double rw, double sx, double sy, double sz)
    {
        const double3 translation(tx, ty, tz);
        const dquat rotation = dquat::fromXYZW(double4(rx, ry, rz, rw));
        const double3 scaling(sx, sy, sz);
        r->GameNode(node)->SetTransform(&translation, &rotation, &scaling);
    }

    DONUT_API void Donut_RtxptRendererSetGameNodeRotation(RtxptRenderer* r, int node, double x, double y, double z, double w)
    {
        r->GameNode(node)->SetRotation(dquat::fromXYZW(double4(x, y, z, w)));
    }

    // The node's local transform, one value: 0-2 translation, 3-6 rotation (x, y, z, w), 7-9 scaling.
    DONUT_API double Donut_RtxptRendererGetGameNodeTransform(RtxptRenderer* r, int node, int component)
    {
        const std::shared_ptr<SceneGraphNode> n = r->GameNode(node);
        const double3 t = n->GetTranslation();
        const dquat q = n->GetRotation();
        const double3 sc = n->GetScaling();
        const double values[10] = { t.x, t.y, t.z, q.x, q.y, q.z, q.w, sc.x, sc.y, sc.z };
        return (component >= 0 && component < 10) ? values[component] : 0.0;
    }

    // The light nodes under `node`, depth first: their count; Donut_RtxptRendererGetCollectedGameLight has their handles.
    DONUT_API int Donut_RtxptRendererCollectGameLights(RtxptRenderer* r, int node)
    {
        r->collectedGameLights.clear();
        r->CollectGameLights(r->GameNode(node).get());
        return (int)r->collectedGameLights.size();
    }

    DONUT_API int Donut_RtxptRendererGetCollectedGameLight(RtxptRenderer* r, int index)
    {
        return (index >= 0 && index < (int)r->collectedGameLights.size()) ? r->collectedGameLights[index] : -1;
    }

    // The values are floats (the game rounds them so).
    DONUT_API void Donut_RtxptRendererUpdateGameLight(RtxptRenderer* r, int node, double red, double green, double blue, double intensity,
        double innerAngle, double outerAngle)
    {
        r->UpdateGameLight(node, float3(float(red), float(green), float(blue)), float(intensity), float(innerAngle), float(outerAngle));
    }

    DONUT_API void Donut_RtxptRendererTransformGameCamera(RtxptRenderer* r, int propNode, float* posDirUp)
    {
        r->TransformGameCamera(propNode, posDirUp);
    }

    // The files in `folder` matching `wildcard` (SampleCommon's EnumerateFilesWithWildcard): their count;
    // Donut_RtxptRendererGetListedFile has their paths.
    DONUT_API int Donut_RtxptRendererListFiles(RtxptRenderer* r, const char* folder, const char* wildcard)
    {
        r->listedFiles.clear();
        for (const std::filesystem::path& path : EnumerateFilesWithWildcard(folder, wildcard))
            r->listedFiles.push_back(path.string());
        return (int)r->listedFiles.size();
    }

    DONUT_API const char* Donut_RtxptRendererGetListedFile(RtxptRenderer* r, int index)
    {
        return (index >= 0 && index < (int)r->listedFiles.size()) ? r->listedFiles[index].c_str() : "";
    }

    // A JSON file whose root is an object (SampleCommon's LoadJsonFromFile): its handle, or -1.
    DONUT_API int Donut_RtxptRendererLoadGameJson(RtxptRenderer* r, const char* path)
    {
        Json::Value root;
        if (!LoadJsonFromFile(path, root) || root.empty() || !root.isObject())
            return -1;
        r->gameJson.push_back(root);
        return (int)r->gameJson.size() - 1;
    }

    // Values by path (see GameJsonValue): whether there is one, an array's or object's size (-1 if neither),
    // a number, bool or string (`defaultValue` where missing or of another type), and component `component`
    // of an n-vector as Donut's json::Read reads it (a single number for all components; NaN where missing).
    DONUT_API bool Donut_RtxptRendererHasGameJson(RtxptRenderer* r, int json, const char* path)
    {
        return !r->GameJsonValue(json, path).isNull();
    }

    DONUT_API int Donut_RtxptRendererGetGameJsonSize(RtxptRenderer* r, int json, const char* path)
    {
        const Json::Value& v = r->GameJsonValue(json, path);
        return (v.isArray() || v.isObject()) ? (int)v.size() : -1;
    }

    DONUT_API double Donut_RtxptRendererGetGameJsonNumber(RtxptRenderer* r, int json, const char* path, double defaultValue)
    {
        return json::Read<double>(r->GameJsonValue(json, path), defaultValue);
    }

    DONUT_API bool Donut_RtxptRendererGetGameJsonBool(RtxptRenderer* r, int json, const char* path, bool defaultValue)
    {
        return json::Read<bool>(r->GameJsonValue(json, path), defaultValue);
    }

    DONUT_API const char* Donut_RtxptRendererGetGameJsonString(RtxptRenderer* r, int json, const char* path, const char* defaultValue)
    {
        static std::string value;
        value = json::Read<std::string>(r->GameJsonValue(json, path), defaultValue);
        return value.c_str();
    }

    DONUT_API double Donut_RtxptRendererGetGameJsonVector(RtxptRenderer* r, int json, const char* path, int count, int component)
    {
        const Json::Value& v = r->GameJsonValue(json, path);
        const double nan = std::numeric_limits<double>::quiet_NaN();
        if (count == 3)
        {
            const double3 value = json::Read<double3>(v, double3(nan));
            return component == 0 ? value.x : component == 1 ? value.y : value.z;
        }
        const double4 value = json::Read<double4>(v, double4(nan));
        return component == 0 ? value.x : component == 1 ? value.y : component == 2 ? value.z : value.w;
    }

    DONUT_API int Donut_RtxptRendererGetSceneCameraCount(RtxptRenderer* r)
    {
        return (int)r->scene->GetSceneGraph()->GetCameras().size();
    }

    // The scene's camera `index` (Sample::UpdateCameraFromScene): position, direction, up, vertical field of
    // view, near plane, then its exposure (auto exposure, compensation, value, min, max; ToneMappingParameters'
    // defaults where unset, NaN when the camera has no exposure settings, i.e. isn't a PerspectiveCameraEx).
    DONUT_API bool Donut_RtxptRendererGetSceneCamera(RtxptRenderer* r, int index, float* out)
    {
        const auto& cameras = r->scene->GetSceneGraph()->GetCameras();
        if (index < 0 || index >= (int)cameras.size())
            return false;
        auto camera = std::dynamic_pointer_cast<PerspectiveCamera>(cameras[index]);
        if (camera == nullptr)
            return false;
        const affine3 viewToWorld = camera->GetViewToWorldMatrix();
        const float3 pos = viewToWorld.m_translation;
        const float3 dir = viewToWorld.m_linear.row2;
        const float3 up = viewToWorld.m_linear.row1;
        const float nan = std::numeric_limits<float>::quiet_NaN();
        float values[16] = { pos.x, pos.y, pos.z, dir.x, dir.y, dir.z, up.x, up.y, up.z, camera->verticalFov, camera->zNear, nan, nan, nan, nan, nan };
        if (auto ex = std::dynamic_pointer_cast<PerspectiveCameraEx>(camera))
        {
            const ToneMappingParameters defaults;
            values[11] = ex->enableAutoExposure.value_or(defaults.autoExposure) ? 1.0f : 0.0f;
            values[12] = ex->exposureCompensation.value_or(defaults.exposureCompensation);
            values[13] = ex->exposureValue.value_or(defaults.exposureValue);
            values[14] = ex->exposureValueMin.value_or(defaults.exposureValueMin);
            values[15] = ex->exposureValueMax.value_or(defaults.exposureValueMax);
        }
        std::memcpy(out, values, sizeof(values));
        return true;
    }

    // The scene's sample settings (SampleSettings) and environment light, NaN where unset: 0 realtime mode,
    // 1 animations, 2 starting camera, 3 real-time firefly filter, 4 max bounces, 5 max diffuse bounces,
    // 6 texture MIP bias, 7 the environment light's intensity.
    DONUT_API double Donut_RtxptRendererGetSceneSetting(RtxptRenderer* r, int key)
    {
        const double nan = std::numeric_limits<double>::quiet_NaN();
        if (key == 7)
            return r->envLightIntensity;
        auto s = r->scene->GetSampleSettingsNode();
        if (s == nullptr)
            return nan;
        switch (key)
        {
        case 0: return s->realtimeMode.has_value() ? (s->realtimeMode.value() ? 1.0 : 0.0) : nan;
        case 1: return s->enableAnimations.has_value() ? (s->enableAnimations.value() ? 1.0 : 0.0) : nan;
        case 2: return s->startingCamera.has_value() ? (double)s->startingCamera.value() : nan;
        case 3: return s->realtimeFireflyFilter.has_value() ? (double)s->realtimeFireflyFilter.value() : nan;
        case 4: return s->maxBounces.has_value() ? (double)s->maxBounces.value() : nan;
        case 5: return s->maxDiffuseBounces.has_value() ? (double)s->maxDiffuseBounces.value() : nan;
        case 6: return s->textureMIPBias.has_value() ? (double)s->textureMIPBias.value() : nan;
        default: return nan;
        }
    }

    // The scene's togglable nodes (named *_togglable, or *_togglable_off: hidden at load), for the UI.
    DONUT_API int Donut_RtxptRendererGetTogglableNodeCount(RtxptRenderer* r)
    {
        return (int)r->togglableNodes.size();
    }

    DONUT_API const char* Donut_RtxptRendererGetTogglableNodeName(RtxptRenderer* r, int index)
    {
        return r->togglableNodes[index].name.c_str();
    }

    DONUT_API bool Donut_RtxptRendererIsTogglableNodeShown(RtxptRenderer* r, int index)
    {
        return r->IsTogglableNodeSelected(index);
    }

    // Moves the node back or away; the accumulation restarts then.
    DONUT_API void Donut_RtxptRendererShowTogglableNode(RtxptRenderer* r, int index, bool shown)
    {
        r->SetTogglableNodeSelected(index, shown);
    }

    // The path tracer's global shader macros (Sample::GetPTPipelineGlobalMacros, examples/rtxpt.ts's): cleared,
    // then added one by one. A change recompiles the path tracer at the next Prepare.
    DONUT_API void Donut_RtxptRendererClearShaderMacros(RtxptRenderer* r)
    {
        r->globalMacros.clear();
    }

    DONUT_API void Donut_RtxptRendererAddShaderMacro(RtxptRenderer* r, const char* name, const char* value)
    {
        r->globalMacros.push_back(ShaderMacro(name, value));
    }

    // Applies the scene's animations at sceneTime (seconds, looped per animation).
    DONUT_API void Donut_RtxptRendererAnimate(RtxptRenderer* r, double sceneTime, bool applyAnimations, double elapsedSeconds)
    {
        if (r->toneMappingPass != nullptr)
            r->toneMappingPass->AdvanceFrame((float)elapsedSeconds);
        r->sceneTime = sceneTime;
        if (!applyAnimations)
            return;
        for (const auto& anim : r->scene->GetSceneGraph()->GetAnimations())
            (void)anim->Apply((float)std::fmod(sceneTime, (double)anim->GetDuration()));
    }

    // The renderer's setup for width x height, between frames (in the animate callback: it executes command
    // lists of its own): see RtxptRenderer::Prepare. Bits: 1 render targets made, 2 passes, 4 acceleration structures.
    DONUT_API int Donut_RtxptRendererPrepare(RtxptRenderer* r, int width, int height, bool needNewPasses, bool rebuildAccelStructs, int neeatQualityPreset)
    {
        return r->Prepare((uint32_t)width, (uint32_t)height, needNewPasses, rebuildAccelStructs, neeatQualityPreset);
    }

    // The frame's settings (examples/rtxpt.ts's FRAME_SETTINGS_SIZE bytes) and scene time, then everything up
    // to the path tracing pass, recorded into the frame's command list. True if the environment map changed:
    // reset the accumulation at the next frame.
    DONUT_API bool Donut_RtxptRendererBeginFrame(RtxptRenderer* r, nvrhi::ICommandList* commandList, const float* frameSettings)
    {
        std::memcpy(&r->settings, frameSettings, sizeof(RtxptFrameSettings));
        return r->BeginFrame(commandList);
    }

    // The path tracer, then in real-time mode the denoiser: see RtxptRenderer::PathTrace.
    DONUT_API void Donut_RtxptRendererPathTrace(RtxptRenderer* r, nvrhi::ICommandList* commandList)
    {
        r->PathTrace(commandList);
    }

    // Accumulates the frame's samples with accumulationWeight (1 / (n + 1); 0 keeps the accumulated image), or in
    // real-time mode TAA, DLSS (or a copy), then bloom and tone mapping into the LDR color (Donut_RtxptRendererGetLdrColor).
    DONUT_API void Donut_RtxptRendererResolve(RtxptRenderer* r, nvrhi::ICommandList* commandList, double accumulationWeight)
    {
        r->Resolve(commandList, (float)accumulationWeight);
    }

    DONUT_API void Donut_RtxptRendererEndFrame(RtxptRenderer* r)
    {
        r->EndFrame();
    }

    DONUT_API nvrhi::ITexture* Donut_RtxptRendererGetLdrColor(RtxptRenderer* r)
    {
        return r->renderTargets->LdrColor;
    }

    // DLSS (Donut_CreateDlss, initialized for the render size by the caller) for the real-time mode's realtimeAA 2;
    // null: none (the copy instead).
    DONUT_API void Donut_RtxptRendererSetDlss(RtxptRenderer* r, donut::render::DLSS* dlss)
    {
        r->dlss = dlss;
    }

    // The frame's depth (R32_FLOAT, reverse-Z) and screen motion vectors (RGBA16_FLOAT, pixels, previous minus
    // current), and its camera jitter in pixels (between BeginFrame and EndFrame): DLSS-NR's guides.
    DONUT_API nvrhi::ITexture* Donut_RtxptRendererGetDepth(RtxptRenderer* r)
    {
        return r->renderTargets->Depth;
    }

    DONUT_API nvrhi::ITexture* Donut_RtxptRendererGetMotionVectors(RtxptRenderer* r)
    {
        return r->renderTargets->ScreenMotionVectors;
    }

    DONUT_API double Donut_RtxptRendererGetJitterX(RtxptRenderer* r)
    {
        return r->view->GetPixelOffset().x;
    }

    DONUT_API double Donut_RtxptRendererGetJitterY(RtxptRenderer* r)
    {
        return r->view->GetPixelOffset().y;
    }

    // The accumulated radiance (RGBA32_FLOAT, linear), for checks.
    DONUT_API nvrhi::ITexture* Donut_RtxptRendererGetAccumulatedRadiance(RtxptRenderer* r)
    {
        return r->renderTargets->AccumulatedRadiance;
    }
}

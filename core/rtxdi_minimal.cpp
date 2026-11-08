// C++ glue of the rtxdi_minimal example (NVIDIA's RTXDI Minimal Sample, github.com/NVIDIA-RTX/RTXDI,
// Samples/MinimalSample), the part that depends on the sample's shaders: the buffers they read and write, the
// CPU half of the light preparation (which emissive geometry's triangles go where in the light buffer) and the
// resampling constants with the sample's settings - for core/rtxdi_di.ts and examples/rtxdi_minimal.ts, which
// create the passes and bind the shaders (RTXDI_DIR's, compiled in place) on them. The structures the shaders
// read come from the sample's ShaderParameters.h, included in place (this file's include path, set in
// CMakeLists.txt). The values and the behaviour follow the sample's host; the code is this repository's.
// core/rtxdi.cpp has the parts that don't depend on the sample. Built only with RTXDI_DIR.
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
#include <array>
#include <cstdint>
#include <memory>
#include <vector>

#include <donut/core/log.h>
#include <donut/core/math/math.h>
#include <donut/engine/Scene.h>
#include <donut/engine/SceneGraph.h>
#include <donut/engine/View.h>
#include <nvrhi/nvrhi.h>
#include <nvrhi/utils.h>

#include <Rtxdi/DI/ReSTIRDI.h>

#include "donut_api.h"

// The sample's constant buffer, task and light structures, which its shaders include (ShaderParameters.h,
// on donut::math's types).
using namespace donut::math;
#include "ShaderParameters.h"

// The layouts the shaders read: a drift (another RTXDI or Donut) fails here, not as a wrong picture.
static_assert(sizeof(RAB_LightInfo) == 32, "RAB_LightInfo is two uint4s");
static_assert(sizeof(PrepareLightsTask) == 16, "PrepareLightsTask is one uint4");
static_assert(sizeof(PrepareLightsConstants) == 4, "PrepareLightsConstants is one uint");
static_assert(sizeof(ResamplingConstants) % 16 == 0, "ResamplingConstants fills whole constant buffer registers");
// The ray masks examples/rtxdi_minimal.ts passes to Rtxdi_BuildSceneAccelStructs (core/rtxdi.cpp).
static_assert(INSTANCE_MASK_OPAQUE == 1 && INSTANCE_MASK_ALPHA_TESTED == 2 && INSTANCE_MASK_TRANSPARENT == 4,
    "examples/rtxdi_minimal.ts's INSTANCE_MASK_* are the shaders'");

// core/donut_interop.cpp's app and its NVRHI device.
struct App;
extern "C"
{
    void* Donut_GetNvrhiDevice(App* app);
}

namespace
{
    // RtxdiBuffer (core/interop/rtxdi_minimal.d.ts): the buffers' indices.
    enum BufferSlot : int
    {
        TaskSlot = 0,
        LightDataSlot = 1,
        GeometryInstanceToLightSlot = 2,
        NeighborOffsetsSlot = 3,
        LightReservoirsSlot = 4,
        BufferSlotCount
    };

    // How many of each thing the buffers have room for (at least one: NVRHI has no empty buffers).
    struct Capacity
    {
        uint32_t emissiveGeometries = 1;
        uint32_t emissiveTriangles = 1;
        uint32_t geometryInstances = 1;
    };
}

// The buffers of the sample's shaders (by BufferSlot) and the resampling constant buffer, with what the last
// Rtxdi_PrepareLights found. TypeScript holds it as an RtxdiResourcesHandle until Rtxdi_DestroyResources.
struct RtxdiMinimalResources
{
    std::array<nvrhi::BufferHandle, BufferSlotCount> buffers;
    nvrhi::BufferHandle resamplingConstants;
    Capacity capacity;

    // The last Rtxdi_PrepareLights: its task count (the PrepareLights push constant) and where its lights are.
    uint32_t taskCount = 0;
    RTXDI_LightBufferParameters lights = {};
    // A scene grown past the capacity is logged once, not every frame.
    bool overflowLogged = false;
};

namespace
{
    // --- The sample's settings ------------------------------------------------------------------

    // What its settings window starts at (the four it changes), in Rtxdi_GetDefaultSettings' order.
    constexpr float kStartLocalLightSamples = 8.0f;
    constexpr float kStartBrdfSamples = 1.0f;
    constexpr float kStartBrdfCutoff = 0.0f;
    constexpr float kStartSpatialSamples = 2.0f;

    // What it doesn't let change: the spatio-temporal reuse's history, neighborhood and its similarity tests.
    // The fields not set (infinite and environment light samples, the BRDF ray's minimum t, disocclusion boost,
    // naive sample discounting, ...) are zero, as the sample leaves them.
    struct FixedReuse
    {
        uint32_t historyFrames = 20;
        float neighborRadiusPixels = 32.0f;
        float maxNormalDifference = 0.5f;
        float maxDepthDifference = 0.1f;
        bool permuteTemporalSamples = true;
        bool skipVisibilityOfReusedSamples = true;
    };

    // --- Light preparation ----------------------------------------------------------------------

    // A geometry of the scene's emissive material, before its place in the light buffer is decided.
    struct EmissiveGeometry
    {
        uint32_t instanceIndex;         // the mesh instance's (the shaders' instance buffer)
        uint32_t geometryInMesh;        // the geometry's index in its mesh
        size_t geometryInstanceIndex;   // the instance's geometry's in the scene's (the map's index)
        uint32_t triangles;
    };

    // The scene's emissive geometries, in instance then geometry order: those whose material's emissive color
    // isn't black and, when the intensity counts (the lights themselves), whose intensity isn't zero or less. Without
    // it the list is the upper bound the buffers are sized for.
    std::vector<EmissiveGeometry> FindEmissiveGeometries(const donut::engine::SceneGraph& sceneGraph, bool intensityCounts)
    {
        std::vector<EmissiveGeometry> found;
        for (const auto& instance : sceneGraph.GetMeshInstances())
        {
            const auto& geometries = instance->GetMesh()->geometries;
            for (size_t i = 0; i < geometries.size(); ++i)
            {
                const donut::engine::Material& material = *geometries[i]->material;
                const bool colored = any(material.emissiveColor != 0.f);
                if (!colored || (intensityCounts && material.emissiveIntensity <= 0.f))
                    continue;
                found.push_back({ uint32_t(instance->GetInstanceIndex()), uint32_t(i),
                    size_t(instance->GetGeometryInstanceIndex()) + i, geometries[i]->numIndices / 3 });
            }
        }
        return found;
    }

    // The light buffer's layout: each emissive geometry's triangles one after the other, a task (PrepareLights'
    // work item) per geometry, and the map from a geometry instance to its first light (RTXDI_INVALID_LIGHT_INDEX
    // where it has none). Geometries past the capacity are left out (and unlit).
    struct LightLayout
    {
        std::vector<PrepareLightsTask> tasks;
        std::vector<uint32_t> firstLightOf;
        uint32_t lightCount = 0;
        bool overflowed = false;
    };

    LightLayout LayOutLights(const std::vector<EmissiveGeometry>& emissive, size_t geometryInstanceCount, const Capacity& capacity)
    {
        LightLayout layout;
        layout.firstLightOf.assign(std::min<size_t>(geometryInstanceCount, capacity.geometryInstances), RTXDI_INVALID_LIGHT_INDEX);
        for (const EmissiveGeometry& geometry : emissive)
        {
            const bool fits = geometry.geometryInstanceIndex < layout.firstLightOf.size()
                && layout.tasks.size() < capacity.emissiveGeometries
                && layout.lightCount + geometry.triangles <= capacity.emissiveTriangles;
            if (!fits)
            {
                layout.overflowed = true;
                continue;
            }
            const uint32_t first = layout.lightCount;
            layout.firstLightOf[geometry.geometryInstanceIndex] = first;
            // PrepareLightsTask's fields: instance, geometry, triangle count, first light.
            layout.tasks.push_back({ geometry.instanceIndex, geometry.geometryInMesh, geometry.triangles, first });
            layout.lightCount = first + geometry.triangles;
        }
        return layout;
    }

    // The RTXDI light buffer of lightCount local lights from the start: no infinite lights, no environment light.
    RTXDI_LightBufferParameters LocalLightsOnly(uint32_t lightCount)
    {
        RTXDI_LightBufferParameters lights = {};
        lights.localLightBufferRegion.numLights = lightCount;
        lights.environmentLightParams.lightIndex = RTXDI_INVALID_LIGHT_INDEX;
        return lights;
    }

    // --- Buffers --------------------------------------------------------------------------------

    // One of the shaders' buffers: elementSize-byte elements, structured (the element size its stride) or typed
    // (typedFormat), resting in restingState.
    struct BufferSpec
    {
        BufferSlot slot;
        const char* name;
        uint32_t elementSize;
        uint64_t elementCount;
        nvrhi::Format typedFormat;
        nvrhi::ResourceStates restingState;
        bool shaderWritable;
    };

    nvrhi::BufferHandle CreateBuffer(nvrhi::IDevice* device, const BufferSpec& spec)
    {
        const bool typed = spec.typedFormat != nvrhi::Format::UNKNOWN;
        return device->createBuffer(nvrhi::BufferDesc()
            .setDebugName(spec.name)
            .setByteSize(uint64_t(spec.elementSize) * spec.elementCount)
            .setStructStride(typed ? 0 : spec.elementSize)
            .setFormat(spec.typedFormat)
            .setCanHaveTypedViews(typed)
            .setCanHaveUAVs(spec.shaderWritable)
            .setInitialState(spec.restingState)
            .setKeepInitialState(true));
    }

    nvrhi::IDevice* DeviceOf(App* app)
    {
        return static_cast<nvrhi::IDevice*>(Donut_GetNvrhiDevice(app));
    }
}

extern "C"
{
    // The shaders' buffers, sized for the scene's emissive geometries and geometry instances and the context's
    // neighbor offsets and reservoirs. Null (logged) without a context or scene.
    DONUT_API RtxdiMinimalResources* Rtxdi_CreateResources(App* app, rtxdi::ReSTIRDIContext* context, donut::engine::Scene* scene)
    {
        if (!app || !context || !scene || !scene->GetSceneGraph())
        {
            donut::log::error("Rtxdi_CreateResources: needs an app, a context and a loaded scene");
            return nullptr;
        }
        const donut::engine::SceneGraph& sceneGraph = *scene->GetSceneGraph();

        // Room for every geometry with an emissive color: the intensity is looked at when the lights are laid out.
        const std::vector<EmissiveGeometry> emissive = FindEmissiveGeometries(sceneGraph, false);
        uint32_t emissiveTriangles = 0;
        for (const EmissiveGeometry& geometry : emissive)
            emissiveTriangles += geometry.triangles;

        auto resources = std::make_unique<RtxdiMinimalResources>();
        Capacity& capacity = resources->capacity;
        capacity.emissiveGeometries = std::max(uint32_t(emissive.size()), 1u);
        capacity.emissiveTriangles = std::max(emissiveTriangles, 1u);
        capacity.geometryInstances = std::max(uint32_t(sceneGraph.GetGeometryInstancesCount()), 1u);

        const uint64_t reservoirs = uint64_t(context->GetReservoirBufferParameters().reservoirArrayPitch)
            * rtxdi::c_NumReSTIRDIReservoirBuffers;
        const nvrhi::ResourceStates read = nvrhi::ResourceStates::ShaderResource;
        const nvrhi::ResourceStates readWrite = nvrhi::ResourceStates::UnorderedAccess;
        const BufferSpec specs[] = {
            { TaskSlot, "RTXDI PrepareLights tasks", sizeof(PrepareLightsTask), capacity.emissiveGeometries,
                nvrhi::Format::UNKNOWN, read, true },
            { LightDataSlot, "RTXDI lights", sizeof(RAB_LightInfo), capacity.emissiveTriangles,
                nvrhi::Format::UNKNOWN, read, true },
            { GeometryInstanceToLightSlot, "RTXDI geometry instance lights", sizeof(uint32_t), capacity.geometryInstances,
                nvrhi::Format::UNKNOWN, read, false },
            // Two signed normalized bytes an offset, read as float2.
            { NeighborOffsetsSlot, "RTXDI neighbor offsets", 2, context->GetStaticParameters().NeighborOffsetCount,
                nvrhi::Format::RG8_SNORM, read, false },
            { LightReservoirsSlot, "RTXDI light reservoirs", sizeof(RTXDI_PackedDIReservoir), reservoirs,
                nvrhi::Format::UNKNOWN, readWrite, true },
        };

        nvrhi::IDevice* device = DeviceOf(app);
        for (const BufferSpec& spec : specs)
        {
            nvrhi::BufferHandle buffer = CreateBuffer(device, spec);
            if (!buffer)
            {
                donut::log::error("Rtxdi_CreateResources: the %s buffer couldn't be created", spec.name);
                return nullptr;
            }
            resources->buffers[spec.slot] = buffer;
        }
        return resources.release();
    }

    DONUT_API void Rtxdi_DestroyResources(RtxdiMinimalResources* resources)
    {
        delete resources;
    }

    // One of the resources' buffers (RtxdiBuffer order); null (logged) for no resources or another index.
    DONUT_API nvrhi::IBuffer* Rtxdi_GetBuffer(RtxdiMinimalResources* resources, int which)
    {
        if (!resources || which < 0 || which >= BufferSlotCount)
        {
            donut::log::error("Rtxdi_GetBuffer: needs resources and an RtxdiBuffer (got %d)", which);
            return nullptr;
        }
        return resources->buffers[which].Get();
    }

    // The resampling constant buffer, volatile (rewritten every frame by Rtxdi_WriteResamplingConstants), 16
    // versions a frame as the sample has. The PrepareLights constants are push constants.
    DONUT_API void Rtxdi_CreateConstantBuffers(App* app, RtxdiMinimalResources* resources)
    {
        if (!app || !resources)
        {
            donut::log::error("Rtxdi_CreateConstantBuffers: needs an app and resources");
            return;
        }
        resources->resamplingConstants = DeviceOf(app)->createBuffer(
            nvrhi::utils::CreateVolatileConstantBufferDesc(sizeof(ResamplingConstants), "RTXDI resampling constants", 16));
    }

    DONUT_API nvrhi::IBuffer* Rtxdi_GetResamplingConstantBuffer(RtxdiMinimalResources* resources)
    {
        return resources ? resources->resamplingConstants.Get() : nullptr;
    }

    // The CPU half of the light preparation: the scene's emissive geometries laid out in the light buffer, their
    // tasks and the geometry instance to light map written on the command list, and where the lights are kept for
    // Rtxdi_WriteResamplingConstants. Returns the number of lights.
    DONUT_API int Rtxdi_PrepareLights(RtxdiMinimalResources* resources, donut::engine::Scene* scene, nvrhi::ICommandList* commandList)
    {
        if (!resources || !scene || !scene->GetSceneGraph() || !commandList)
        {
            donut::log::error("Rtxdi_PrepareLights: needs resources, a scene and a command list");
            if (resources)
                resources->taskCount = 0;
            return 0;
        }
        const donut::engine::SceneGraph& sceneGraph = *scene->GetSceneGraph();
        const LightLayout layout = LayOutLights(FindEmissiveGeometries(sceneGraph, true),
            sceneGraph.GetGeometryInstancesCount(), resources->capacity);
        if (layout.overflowed && !resources->overflowLogged)
        {
            donut::log::error("Rtxdi_PrepareLights: the scene has more emissive geometries than Rtxdi_CreateResources made room for; they are not lit");
            resources->overflowLogged = true;
        }

        // NVRHI has no empty writes: with no tasks the map is all invalid and the shaders see no lights.
        if (!layout.firstLightOf.empty())
            commandList->writeBuffer(resources->buffers[GeometryInstanceToLightSlot], layout.firstLightOf.data(),
                layout.firstLightOf.size() * sizeof(uint32_t));
        if (!layout.tasks.empty())
            commandList->writeBuffer(resources->buffers[TaskSlot], layout.tasks.data(),
                layout.tasks.size() * sizeof(PrepareLightsTask));

        resources->lights = LocalLightsOnly(layout.lightCount);
        resources->taskCount = uint32_t(layout.tasks.size());
        return int(layout.lightCount);
    }

    // PrepareLightsConstants::numTasks of the last Rtxdi_PrepareLights: the push constant of its dispatch.
    DONUT_API int Rtxdi_GetPrepareLightsTaskCount(RtxdiMinimalResources* resources)
    {
        return resources ? int(resources->taskCount) : 0;
    }

    // The frame's ResamplingConstants: the views, the context's runtime parameters and reservoir buffers, the
    // lights of the last Rtxdi_PrepareLights, the settings window's values and the sample's fixed ones.
    DONUT_API void Rtxdi_WriteResamplingConstants(RtxdiMinimalResources* resources, rtxdi::ReSTIRDIContext* context, nvrhi::ICommandList* commandList,
        donut::engine::IView* view, donut::engine::IView* prevView, int enableResampling, int unbiasedMode,
        int numLocalLightSamples, int numBrdfSamples, double brdfCutoff, int numSpatialSamples)
    {
        if (!resources || !resources->resamplingConstants || !context || !commandList || !view || !prevView)
        {
            donut::log::error("Rtxdi_WriteResamplingConstants: needs resources with constant buffers, a context, a command list and two views");
            return;
        }
        ResamplingConstants constants = {};
        view->FillPlanarViewConstants(constants.view);
        prevView->FillPlanarViewConstants(constants.prevView);

        // The frame: the random sequence, the reservoirs read (last frame's) and written.
        const rtxdi::ReSTIRDIStaticParameters& statics = context->GetStaticParameters();
        constants.runtimeParams.frameIndex = context->GetFrameIndex();
        constants.runtimeParams.neighborOffsetMask = statics.NeighborOffsetCount - 1;
        constants.runtimeParams.activeCheckerboardField = 0;
        constants.restirDIReservoirBufferParams = context->GetReservoirBufferParameters();
        constants.inputBufferIndex = context->GetBufferIndices().temporalResamplingInputBufferIndex;
        constants.outputBufferIndex = context->GetBufferIndices().initialSamplingOutputBufferIndex;
        constants.lightBufferParams = resources->lights;

        // The settings window's.
        constants.enableResampling = enableResampling != 0 ? 1u : 0u;
        RTXDI_DIInitialSamplingParameters& initial = constants.initialSamplingParams;
        initial.numLocalLightSamples = uint32_t(std::max(numLocalLightSamples, 0));
        initial.numBrdfSamples = uint32_t(std::max(numBrdfSamples, 0));
        initial.brdfCutoff = float(brdfCutoff);
        RTXDI_DISpatioTemporalResamplingParameters& reuse = constants.spatioTemporalResamplingParams;
        reuse.numSamples = uint32_t(std::max(numSpatialSamples, 0));
        // Unbiased: the reused samples' visibility is ray traced.
        reuse.biasCorrectionMode = unbiasedMode != 0
            ? ReSTIRDI_SpatioTemporalBiasCorrectionMode::Raytraced
            : ReSTIRDI_SpatioTemporalBiasCorrectionMode::Basic;

        // The sample's fixed ones.
        const FixedReuse fixed;
        reuse.maxHistoryLength = fixed.historyFrames;
        reuse.samplingRadius = fixed.neighborRadiusPixels;
        reuse.normalThreshold = fixed.maxNormalDifference;
        reuse.depthThreshold = fixed.maxDepthDifference;
        reuse.enablePermutationSampling = fixed.permuteTemporalSamples ? 1u : 0u;
        reuse.enableVisibilityShortcut = fixed.skipVisibilityOfReusedSamples ? 1u : 0u;

        commandList->writeBuffer(resources->resamplingConstants, &constants, sizeof(constants));
    }

    // The sample's start values of the four settings its window changes, into dst: the initial local light
    // samples, the initial BRDF samples, the BRDF cutoff and the spatial samples.
    DONUT_API void Rtxdi_GetDefaultSettings(float* dst)
    {
        if (!dst)
            return;
        const float start[4] = { kStartLocalLightSamples, kStartBrdfSamples, kStartBrdfCutoff, kStartSpatialSamples };
        std::copy(std::begin(start), std::end(start), dst);
    }
}

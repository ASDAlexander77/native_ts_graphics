// C++ glue of the rtxdi_minimal example (NVIDIA's RTXDI Minimal Sample, github.com/NVIDIA-RTX/RTXDI,
// Samples/MinimalSample): what the sample's host does in C++ - the ReSTIR DI context of RTXDI's runtime
// library (rtxdi_runtime in CMakeLists.txt, compiled from RTXDI_DIR in place), its RtxdiResources, the
// CPU side of its PrepareLightsPass and the ResamplingConstants of its RenderPass - for
// examples/rtxdi_minimal.ts, which creates the passes and binds the shaders (RTXDI_DIR's, compiled in
// place) on them. Written from the sample's behaviour: the structures the shaders read come from its
// ShaderParameters.h, included in place (the include path of this file, set in CMakeLists.txt), and the
// sample's parameter values are repeated here, none of its code. Built only with RTXDI_DIR.
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
#include <cstdint>
#include <cstring>
#include <fstream>
#include <memory>
#include <unordered_map>
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

// core/donut_interop.cpp's app, its NVRHI device and its texture readback.
struct App;
extern "C"
{
    void* Donut_GetNvrhiDevice(App* app);
    int Donut_ReadTextureLevel(App* app, nvrhi::ITexture* texture, int mipLevel, void* dst, int byteSize);
}

// The sample's RtxdiResources, with the constant buffers and the light buffer parameters of the last
// Rtxdi_PrepareLights beside them. TypeScript holds it as an RtxdiResourcesHandle until
// Rtxdi_DestroyResources.
struct RtxdiMinimalResources
{
    nvrhi::DeviceHandle device;

    nvrhi::BufferHandle taskBuffer;
    nvrhi::BufferHandle lightDataBuffer;
    nvrhi::BufferHandle geometryInstanceToLightBuffer;
    nvrhi::BufferHandle neighborOffsetsBuffer;
    nvrhi::BufferHandle lightReservoirBuffer;
    nvrhi::BufferHandle resamplingConstantBuffer;

    // What the buffers were made for, in elements (at least one each: NVRHI has no empty buffers).
    uint32_t maxEmissiveMeshes = 1;
    uint32_t maxEmissiveTriangles = 1;
    uint32_t maxGeometryInstances = 1;

    bool neighborOffsetsInitialized = false;
    // The last Rtxdi_PrepareLights' task count: PrepareLightsConstants::numTasks, which TypeScript pushes.
    uint32_t taskCount = 0;
    // Kept for the ResamplingConstants, as the sample hands PrepareLightsPass::Process's to Render.
    RTXDI_LightBufferParameters lightBufferParams = {};
    // The capacity errors are logged once, not every frame.
    bool capacityErrorLogged = false;
};

// The sample's ray tracing acceleration structures (SampleScene's BuildMeshBLASes and BuildTopLevelAccelStruct):
// a BLAS per mesh and the TLAS over the mesh instances. TypeScript holds it as an RtxdiSceneAccelStructsHandle
// until Rtxdi_DestroySceneAccelStructs.
struct RtxdiSceneAccelStructs
{
    std::unordered_map<const donut::engine::MeshInfo*, nvrhi::rt::AccelStructHandle> meshes;
    nvrhi::rt::AccelStructHandle topLevel;
};

namespace
{
    // The sample's GetDefaultMinimalSampleInitialSamplingParams: the other fields are zero.
    RTXDI_DIInitialSamplingParameters DefaultInitialSamplingParams()
    {
        RTXDI_DIInitialSamplingParameters params = {};
        params.numLocalLightSamples = 8;
        params.numBrdfSamples = 1;
        params.numInfiniteLightSamples = 0;
        params.numEnvironmentSamples = 0;
        params.brdfCutoff = 0.0f;
        params.brdfRayMinT = 0.0f;
        return params;
    }

    // The sample's GetDefaultMinimalSpaioTemporalParams.
    RTXDI_DISpatioTemporalResamplingParameters DefaultSpatioTemporalParams()
    {
        RTXDI_DISpatioTemporalResamplingParameters params = {};
        params.maxHistoryLength = 20;
        params.biasCorrectionMode = ReSTIRDI_SpatioTemporalBiasCorrectionMode::Basic;
        params.depthThreshold = 0.1f;
        params.normalThreshold = 0.5f;
        params.numSamples = 2;
        params.numDisocclusionBoostSamples = 0;
        params.samplingRadius = 32;
        params.enableVisibilityShortcut = true;
        params.enablePermutationSampling = true;
        params.discountNaiveSamples = false;
        return params;
    }

    // A float from the bits of a half (IEEE 754 binary16): subnormals, infinities and NaNs included.
    float HalfToFloat(uint16_t half)
    {
        const uint32_t sign = uint32_t(half & 0x8000u) << 16;
        uint32_t exponent = (half >> 10) & 0x1fu;
        uint32_t mantissa = half & 0x3ffu;
        uint32_t bits;
        if (exponent == 0)
        {
            if (mantissa == 0)
            {
                bits = sign;
            }
            else
            {
                // Subnormal: normalized.
                exponent = 127 - 15 + 1;
                while (!(mantissa & 0x400u))
                {
                    mantissa <<= 1;
                    exponent--;
                }
                bits = sign | (exponent << 23) | ((mantissa & 0x3ffu) << 13);
            }
        }
        else if (exponent == 31)
        {
            bits = sign | 0x7f800000u | (mantissa << 13);
        }
        else
        {
            bits = sign | ((exponent + 127 - 15) << 23) | (mantissa << 13);
        }
        float result;
        std::memcpy(&result, &bits, sizeof(result));
        return result;
    }

    // Whether the geometry has an emissive color (PrepareLightsPass::CountLightsInScene's test).
    bool HasEmissiveColor(const donut::engine::MeshGeometry& geometry)
    {
        return any(geometry.material->emissiveColor != 0.f);
    }
}

extern "C"
{
    // A ReSTIR DI context for width x height frames, the other static parameters at their defaults.
    DONUT_API rtxdi::ReSTIRDIContext* Rtxdi_CreateDIContext(int width, int height)
    {
        rtxdi::ReSTIRDIStaticParameters params;
        params.RenderWidth = uint32_t(std::max(width, 0));
        params.RenderHeight = uint32_t(std::max(height, 0));
        return new rtxdi::ReSTIRDIContext(params);
    }

    DONUT_API void Rtxdi_DestroyDIContext(rtxdi::ReSTIRDIContext* context)
    {
        delete context;
    }

    // The frame the runtime parameters and the reservoir buffer indices are for.
    DONUT_API void Rtxdi_SetFrameIndex(rtxdi::ReSTIRDIContext* context, int frameIndex)
    {
        context->SetFrameIndex(uint32_t(frameIndex));
    }

    // The sample's RtxdiResources, sized for the scene's emissive geometries and geometry instances. Null
    // (logged) without a context or scene.
    DONUT_API RtxdiMinimalResources* Rtxdi_CreateResources(App* app, rtxdi::ReSTIRDIContext* context, donut::engine::Scene* scene)
    {
        if (!app || !context || !scene || !scene->GetSceneGraph())
        {
            donut::log::error("Rtxdi_CreateResources: needs an app, a context and a loaded scene");
            return nullptr;
        }
        nvrhi::IDevice* device = static_cast<nvrhi::IDevice*>(Donut_GetNvrhiDevice(app));

        // PrepareLightsPass::CountLightsInScene: the geometries with an emissive color (the intensity is
        // tested when the lights are prepared, so this is an upper bound).
        uint32_t numEmissiveMeshes = 0;
        uint32_t numEmissiveTriangles = 0;
        for (const auto& instance : scene->GetSceneGraph()->GetMeshInstances())
        {
            for (const auto& geometry : instance->GetMesh()->geometries)
            {
                if (HasEmissiveColor(*geometry))
                {
                    numEmissiveMeshes += 1;
                    numEmissiveTriangles += geometry->numIndices / 3;
                }
            }
        }
        const uint32_t numGeometryInstances = uint32_t(scene->GetSceneGraph()->GetGeometryInstancesCount());

        auto resources = std::make_unique<RtxdiMinimalResources>();
        resources->device = device;
        resources->maxEmissiveMeshes = std::max(numEmissiveMeshes, 1u);
        resources->maxEmissiveTriangles = std::max(numEmissiveTriangles, 1u);
        resources->maxGeometryInstances = std::max(numGeometryInstances, 1u);

        nvrhi::BufferDesc taskDesc;
        taskDesc.byteSize = sizeof(PrepareLightsTask) * resources->maxEmissiveMeshes;
        taskDesc.structStride = sizeof(PrepareLightsTask);
        taskDesc.initialState = nvrhi::ResourceStates::ShaderResource;
        taskDesc.keepInitialState = true;
        taskDesc.debugName = "TaskBuffer";
        taskDesc.canHaveUAVs = true;
        resources->taskBuffer = device->createBuffer(taskDesc);

        nvrhi::BufferDesc lightDesc;
        lightDesc.byteSize = sizeof(RAB_LightInfo) * resources->maxEmissiveTriangles;
        lightDesc.structStride = sizeof(RAB_LightInfo);
        lightDesc.initialState = nvrhi::ResourceStates::ShaderResource;
        lightDesc.keepInitialState = true;
        lightDesc.debugName = "LightDataBuffer";
        lightDesc.canHaveUAVs = true;
        resources->lightDataBuffer = device->createBuffer(lightDesc);

        nvrhi::BufferDesc geometryInstanceToLightDesc;
        geometryInstanceToLightDesc.byteSize = sizeof(uint32_t) * resources->maxGeometryInstances;
        geometryInstanceToLightDesc.structStride = sizeof(uint32_t);
        geometryInstanceToLightDesc.initialState = nvrhi::ResourceStates::ShaderResource;
        geometryInstanceToLightDesc.keepInitialState = true;
        geometryInstanceToLightDesc.debugName = "GeometryInstanceToLightBuffer";
        resources->geometryInstanceToLightBuffer = device->createBuffer(geometryInstanceToLightDesc);

        // Two signed normalized bytes per offset, read as a typed buffer.
        nvrhi::BufferDesc neighborOffsetsDesc;
        neighborOffsetsDesc.byteSize = context->GetStaticParameters().NeighborOffsetCount * 2;
        neighborOffsetsDesc.format = nvrhi::Format::RG8_SNORM;
        neighborOffsetsDesc.canHaveTypedViews = true;
        neighborOffsetsDesc.debugName = "NeighborOffsets";
        neighborOffsetsDesc.initialState = nvrhi::ResourceStates::ShaderResource;
        neighborOffsetsDesc.keepInitialState = true;
        resources->neighborOffsetsBuffer = device->createBuffer(neighborOffsetsDesc);

        nvrhi::BufferDesc reservoirsDesc;
        reservoirsDesc.byteSize = uint64_t(sizeof(RTXDI_PackedDIReservoir)) * context->GetReservoirBufferParameters().reservoirArrayPitch
            * rtxdi::c_NumReSTIRDIReservoirBuffers;
        reservoirsDesc.structStride = sizeof(RTXDI_PackedDIReservoir);
        reservoirsDesc.initialState = nvrhi::ResourceStates::UnorderedAccess;
        reservoirsDesc.keepInitialState = true;
        reservoirsDesc.debugName = "LightReservoirBuffer";
        reservoirsDesc.canHaveUAVs = true;
        resources->lightReservoirBuffer = device->createBuffer(reservoirsDesc);

        if (!resources->taskBuffer || !resources->lightDataBuffer || !resources->geometryInstanceToLightBuffer
            || !resources->neighborOffsetsBuffer || !resources->lightReservoirBuffer)
        {
            donut::log::error("Rtxdi_CreateResources: a buffer couldn't be created");
            return nullptr;
        }
        return resources.release();
    }

    DONUT_API void Rtxdi_DestroyResources(RtxdiMinimalResources* resources)
    {
        delete resources;
    }

    // The resources' buffers, in Rtxdi_GetBuffer's RtxdiBuffer order.
    DONUT_API nvrhi::IBuffer* Rtxdi_GetBuffer(RtxdiMinimalResources* resources, int which)
    {
        switch (which)
        {
        case 0: return resources->taskBuffer.Get();
        case 1: return resources->lightDataBuffer.Get();
        case 2: return resources->geometryInstanceToLightBuffer.Get();
        case 3: return resources->neighborOffsetsBuffer.Get();
        case 4: return resources->lightReservoirBuffer.Get();
        default: return nullptr;
        }
    }

    // RtxdiResources::InitializeNeighborOffsets: the offsets are written once.
    DONUT_API void Rtxdi_InitializeNeighborOffsets(RtxdiMinimalResources* resources, rtxdi::ReSTIRDIContext* context, nvrhi::ICommandList* commandList)
    {
        if (resources->neighborOffsetsInitialized)
            return;

        const uint32_t neighborOffsetCount = context->GetStaticParameters().NeighborOffsetCount;
        std::vector<uint8_t> offsets(size_t(neighborOffsetCount) * 2);
        rtxdi::FillNeighborOffsetBuffer(offsets.data(), neighborOffsetCount);
        commandList->writeBuffer(resources->neighborOffsetsBuffer, offsets.data(), offsets.size());
        resources->neighborOffsetsInitialized = true;
    }

    // The resampling constant buffer, volatile (rewritten every frame by Rtxdi_WriteResamplingConstants); 16
    // versions as the sample's. The PrepareLights constants are push constants, as the sample's.
    DONUT_API void Rtxdi_CreateConstantBuffers(App* app, RtxdiMinimalResources* resources)
    {
        if (!app || !resources)
        {
            donut::log::error("Rtxdi_CreateConstantBuffers: needs an app and resources");
            return;
        }
        nvrhi::IDevice* device = static_cast<nvrhi::IDevice*>(Donut_GetNvrhiDevice(app));
        resources->resamplingConstantBuffer = device->createBuffer(
            nvrhi::utils::CreateVolatileConstantBufferDesc(sizeof(ResamplingConstants), "ResamplingConstants", 16));
    }

    DONUT_API nvrhi::IBuffer* Rtxdi_GetResamplingConstantBuffer(RtxdiMinimalResources* resources)
    {
        return resources->resamplingConstantBuffer.Get();
    }

    // PrepareLightsPass::Process without the dispatch: the tasks, the geometry instance to light map and the
    // constants, and the light buffer parameters kept. Returns the number of lights.
    DONUT_API int Rtxdi_PrepareLights(RtxdiMinimalResources* resources, donut::engine::Scene* scene, nvrhi::ICommandList* commandList)
    {
        if (!resources || !scene || !scene->GetSceneGraph() || !commandList)
        {
            donut::log::error("Rtxdi_PrepareLights: needs resources, a scene and a command list");
            if (resources)
                resources->taskCount = 0;
            return 0;
        }
        std::vector<PrepareLightsTask> tasks;
        uint32_t lightBufferOffset = 0;
        const auto& sceneGraph = scene->GetSceneGraph();
        std::vector<uint32_t> geometryInstanceToLight(sceneGraph->GetGeometryInstancesCount(), RTXDI_INVALID_LIGHT_INDEX);

        for (const auto& instance : sceneGraph->GetMeshInstances())
        {
            const auto& mesh = instance->GetMesh();
            const size_t firstGeometryInstanceIndex = size_t(instance->GetGeometryInstanceIndex());

            for (size_t geometryIndex = 0; geometryIndex < mesh->geometries.size(); ++geometryIndex)
            {
                const auto& geometry = mesh->geometries[geometryIndex];
                if (!HasEmissiveColor(*geometry) || geometry->material->emissiveIntensity <= 0.f)
                    continue;

                const uint32_t triangleCount = geometry->numIndices / 3;
                // The scene changed since Rtxdi_CreateResources (a bigger one, or emissive where it wasn't):
                // the buffers don't fit it.
                if (firstGeometryInstanceIndex + geometryIndex >= geometryInstanceToLight.size()
                    || firstGeometryInstanceIndex + geometryIndex >= resources->maxGeometryInstances
                    || tasks.size() >= resources->maxEmissiveMeshes
                    || lightBufferOffset + triangleCount > resources->maxEmissiveTriangles)
                {
                    if (!resources->capacityErrorLogged)
                    {
                        donut::log::error("Rtxdi_PrepareLights: the scene has more emissive geometries than Rtxdi_CreateResources made room for; they are not lit");
                        resources->capacityErrorLogged = true;
                    }
                    continue;
                }

                geometryInstanceToLight[firstGeometryInstanceIndex + geometryIndex] = lightBufferOffset;

                PrepareLightsTask task = {};
                task.instanceIndex = uint32_t(instance->GetInstanceIndex());
                task.geometryIndex = uint32_t(geometryIndex);
                task.lightBufferOffset = lightBufferOffset;
                task.triangleCount = triangleCount;
                tasks.push_back(task);

                lightBufferOffset += triangleCount;
            }
        }

        // Writes nothing for an empty list (NVRHI has no empty writes): the map is all invalid, the
        // shaders see no lights.
        const size_t mapCount = std::min<size_t>(geometryInstanceToLight.size(), resources->maxGeometryInstances);
        if (mapCount > 0)
            commandList->writeBuffer(resources->geometryInstanceToLightBuffer, geometryInstanceToLight.data(), mapCount * sizeof(uint32_t));

        resources->lightBufferParams = {};
        resources->lightBufferParams.localLightBufferRegion.firstLightIndex = 0;
        resources->lightBufferParams.localLightBufferRegion.numLights = lightBufferOffset;
        resources->lightBufferParams.infiniteLightBufferRegion.firstLightIndex = 0;
        resources->lightBufferParams.infiniteLightBufferRegion.numLights = 0;
        resources->lightBufferParams.environmentLightParams.lightIndex = RTXDI_INVALID_LIGHT_INDEX;
        resources->lightBufferParams.environmentLightParams.lightPresent = false;

        if (!tasks.empty())
            commandList->writeBuffer(resources->taskBuffer, tasks.data(), tasks.size() * sizeof(PrepareLightsTask));

        resources->taskCount = uint32_t(tasks.size());
        return int(lightBufferOffset);
    }

    // PrepareLightsConstants::numTasks of the last Rtxdi_PrepareLights: the push constant of its dispatch.
    DONUT_API int Rtxdi_GetPrepareLightsTaskCount(RtxdiMinimalResources* resources)
    {
        return resources ? int(resources->taskCount) : 0;
    }

    // SampleScene::BuildMeshBLASes and BuildTopLevelAccelStruct, recorded into an open command list (the sample
    // builds the BLASes on a list of its own and waits for them; NVRHI orders the TLAS build after them here).
    // As the sample's: no BLAS for skinned meshes (vertex joint weights); each geometry opaque only for an
    // opaque material; PreferFastTrace, plus AllowCompaction for meshes without a skin; the TLAS AllowUpdate,
    // each instance's mask from its content (INSTANCE_MASK_OPAQUE, _ALPHA_TESTED, _TRANSPARENT), triangle culling
    // off when any of its materials is double-sided, its instance index as the ID. Unlike the sample's, the
    // acceleration structures have memory of their own, not placed in one heap (no effect on what rays hit),
    // and the instances without a BLAS are left out of the TLAS rather than left empty at its end. Null
    // (logged) without an app, a command list or a loaded scene.
    DONUT_API RtxdiSceneAccelStructs* Rtxdi_BuildSceneAccelStructs(App* app, nvrhi::ICommandList* commandList, donut::engine::Scene* scene)
    {
        if (!app || !commandList || !scene || !scene->GetSceneGraph())
        {
            donut::log::error("Rtxdi_BuildSceneAccelStructs: needs an app, a command list and a loaded scene");
            return nullptr;
        }
        nvrhi::IDevice* device = static_cast<nvrhi::IDevice*>(Donut_GetNvrhiDevice(app));
        const auto& sceneGraph = scene->GetSceneGraph();
        auto accelStructs = std::make_unique<RtxdiSceneAccelStructs>();

        for (const auto& mesh : sceneGraph->GetMeshes())
        {
            if (mesh->buffers->hasAttribute(donut::engine::VertexAttribute::JointWeights))
                continue;

            nvrhi::rt::AccelStructDesc blasDesc;
            blasDesc.isTopLevel = false;
            for (const auto& geometry : mesh->geometries)
            {
                nvrhi::rt::GeometryDesc geometryDesc;
                auto& triangles = geometryDesc.geometryData.triangles;
                triangles.indexBuffer = mesh->buffers->indexBuffer;
                triangles.indexOffset = (mesh->indexOffset + geometry->indexOffsetInMesh) * sizeof(uint32_t);
                triangles.indexFormat = nvrhi::Format::R32_UINT;
                triangles.indexCount = geometry->numIndices;
                triangles.vertexBuffer = mesh->buffers->vertexBuffer;
                triangles.vertexOffset = (mesh->vertexOffset + geometry->vertexOffsetInMesh) * sizeof(float3)
                    + mesh->buffers->getVertexBufferRange(donut::engine::VertexAttribute::Position).byteOffset;
                triangles.vertexFormat = nvrhi::Format::RGB32_FLOAT;
                triangles.vertexStride = sizeof(float3);
                triangles.vertexCount = geometry->numVertices;
                geometryDesc.geometryType = nvrhi::rt::GeometryType::Triangles;
                geometryDesc.flags = geometry->material->domain == donut::engine::MaterialDomain::Opaque
                    ? nvrhi::rt::GeometryFlags::Opaque
                    : nvrhi::rt::GeometryFlags::None;
                blasDesc.bottomLevelGeometries.push_back(geometryDesc);
            }
            blasDesc.buildFlags = nvrhi::rt::AccelStructBuildFlags::PreferFastTrace;
            if (!mesh->skinPrototype)
                blasDesc.buildFlags = blasDesc.buildFlags | nvrhi::rt::AccelStructBuildFlags::AllowCompaction;
            blasDesc.trackLiveness = false;
            blasDesc.debugName = mesh->name;

            nvrhi::rt::AccelStructHandle blas = device->createAccelStruct(blasDesc);
            if (!blas)
            {
                donut::log::error("Rtxdi_BuildSceneAccelStructs: the BLAS of %s couldn't be created", mesh->name.c_str());
                return nullptr;
            }
            nvrhi::utils::BuildBottomLevelAccelStruct(commandList, blas, blasDesc);
            accelStructs->meshes[mesh.get()] = blas;
        }

        std::vector<nvrhi::rt::InstanceDesc> instances;
        for (const auto& instance : sceneGraph->GetMeshInstances())
        {
            const auto blas = accelStructs->meshes.find(instance->GetMesh().get());
            if (blas == accelStructs->meshes.end())
                continue;

            nvrhi::rt::InstanceDesc instanceDesc;
            instanceDesc.instanceMask = 0;
            const donut::engine::SceneContentFlags contentFlags = instance->GetContentFlags();
            if ((contentFlags & donut::engine::SceneContentFlags::OpaqueMeshes) != 0)
                instanceDesc.instanceMask |= INSTANCE_MASK_OPAQUE;
            if ((contentFlags & donut::engine::SceneContentFlags::AlphaTestedMeshes) != 0)
                instanceDesc.instanceMask |= INSTANCE_MASK_ALPHA_TESTED;
            if ((contentFlags & donut::engine::SceneContentFlags::BlendedMeshes) != 0)
                instanceDesc.instanceMask |= INSTANCE_MASK_TRANSPARENT;
            for (const auto& geometry : instance->GetMesh()->geometries)
            {
                if (geometry->material->doubleSided)
                    instanceDesc.flags = nvrhi::rt::InstanceFlags::TriangleCullDisable;
            }
            instanceDesc.bottomLevelAS = blas->second;
            if (const auto node = instance->GetNode())
                affineToColumnMajor(node->GetLocalToWorldTransformFloat(), instanceDesc.transform);
            instanceDesc.instanceID = uint32_t(instance->GetInstanceIndex());
            instances.push_back(instanceDesc);
        }

        nvrhi::rt::AccelStructDesc tlasDesc;
        tlasDesc.isTopLevel = true;
        tlasDesc.topLevelMaxInstances = std::max<size_t>(sceneGraph->GetMeshInstances().size(), 1);
        tlasDesc.debugName = "TopLevelAS";
        tlasDesc.buildFlags = nvrhi::rt::AccelStructBuildFlags::AllowUpdate;
        accelStructs->topLevel = device->createAccelStruct(tlasDesc);
        if (!accelStructs->topLevel)
        {
            donut::log::error("Rtxdi_BuildSceneAccelStructs: the TLAS couldn't be created");
            return nullptr;
        }
        commandList->buildTopLevelAccelStruct(accelStructs->topLevel, instances.data(), instances.size(),
            nvrhi::rt::AccelStructBuildFlags::None);
        return accelStructs.release();
    }

    DONUT_API void Rtxdi_DestroySceneAccelStructs(RtxdiSceneAccelStructs* accelStructs)
    {
        delete accelStructs;
    }

    // For the binding sets; valid as long as the acceleration structures.
    DONUT_API nvrhi::rt::IAccelStruct* Rtxdi_GetTopLevelAS(RtxdiSceneAccelStructs* accelStructs)
    {
        return accelStructs ? accelStructs->topLevel.Get() : nullptr;
    }

    // RenderPass::Render's ResamplingConstants, with the sample's parameters and the UI's settings.
    DONUT_API void Rtxdi_WriteResamplingConstants(RtxdiMinimalResources* resources, rtxdi::ReSTIRDIContext* context, nvrhi::ICommandList* commandList,
        donut::engine::IView* view, donut::engine::IView* prevView, int enableResampling, int unbiasedMode,
        int numLocalLightSamples, int numBrdfSamples, double brdfCutoff, int numSpatialSamples)
    {
        if (!resources || !resources->resamplingConstantBuffer || !context || !commandList || !view || !prevView)
        {
            donut::log::error("Rtxdi_WriteResamplingConstants: needs resources with constant buffers, a context, a command list and two views");
            return;
        }
        ResamplingConstants constants = {};
        view->FillPlanarViewConstants(constants.view);
        prevView->FillPlanarViewConstants(constants.prevView);

        constants.enableResampling = enableResampling != 0;

        constants.initialSamplingParams = DefaultInitialSamplingParams();
        constants.initialSamplingParams.numLocalLightSamples = uint32_t(std::max(numLocalLightSamples, 0));
        constants.initialSamplingParams.numBrdfSamples = uint32_t(std::max(numBrdfSamples, 0));
        constants.initialSamplingParams.brdfCutoff = float(brdfCutoff);

        constants.spatioTemporalResamplingParams = DefaultSpatioTemporalParams();
        constants.spatioTemporalResamplingParams.biasCorrectionMode = unbiasedMode != 0
            ? ReSTIRDI_SpatioTemporalBiasCorrectionMode::Raytraced
            : ReSTIRDI_SpatioTemporalBiasCorrectionMode::Basic;
        constants.spatioTemporalResamplingParams.numSamples = uint32_t(std::max(numSpatialSamples, 0));

        constants.restirDIReservoirBufferParams = context->GetReservoirBufferParameters();
        constants.lightBufferParams = resources->lightBufferParams;
        constants.runtimeParams.neighborOffsetMask = context->GetStaticParameters().NeighborOffsetCount - 1;
        constants.runtimeParams.activeCheckerboardField = 0;
        constants.runtimeParams.frameIndex = context->GetFrameIndex();

        constants.inputBufferIndex = context->GetBufferIndices().temporalResamplingInputBufferIndex;
        constants.outputBufferIndex = context->GetBufferIndices().initialSamplingOutputBufferIndex;

        commandList->writeBuffer(resources->resamplingConstantBuffer, &constants, sizeof(constants));
    }

    // The sample's numLocalLightSamples, numBrdfSamples, brdfCutoff and spatial numSamples.
    DONUT_API void Rtxdi_GetDefaultSettings(float* dst)
    {
        const RTXDI_DIInitialSamplingParameters initial = DefaultInitialSamplingParams();
        const RTXDI_DISpatioTemporalResamplingParameters spatioTemporal = DefaultSpatioTemporalParams();
        dst[0] = float(initial.numLocalLightSamples);
        dst[1] = float(initial.numBrdfSamples);
        dst[2] = initial.brdfCutoff;
        dst[3] = float(spatioTemporal.numSamples);
    }

    // The texture as width, height (int32) and width x height RGBA float32 pixels, top row first.
    DONUT_API int Rtxdi_SaveTextureRGBA32F(App* app, nvrhi::ITexture* texture, const char* path)
    {
        const nvrhi::TextureDesc& desc = texture->getDesc();
        const bool half = desc.format == nvrhi::Format::RGBA16_FLOAT;
        if (!half && desc.format != nvrhi::Format::RGBA32_FLOAT)
        {
            donut::log::error("Rtxdi_SaveTextureRGBA32F: %s is not RGBA16_FLOAT or RGBA32_FLOAT", path);
            return 0;
        }

        const size_t pixelCount = size_t(desc.width) * desc.height;
        const size_t bytesPerPixel = half ? 8 : 16;
        std::vector<uint8_t> raw(pixelCount * bytesPerPixel);
        if (Donut_ReadTextureLevel(app, texture, 0, raw.data(), int(raw.size())) != int(raw.size()))
        {
            donut::log::error("Rtxdi_SaveTextureRGBA32F: couldn't read the texture back");
            return 0;
        }

        std::vector<float> pixels(pixelCount * 4);
        if (half)
        {
            const uint16_t* source = reinterpret_cast<const uint16_t*>(raw.data());
            for (size_t i = 0; i < pixels.size(); ++i)
                pixels[i] = HalfToFloat(source[i]);
        }
        else
        {
            std::memcpy(pixels.data(), raw.data(), raw.size());
        }

        std::ofstream file(path, std::ios::binary | std::ios::trunc);
        const int32_t size[2] = { int32_t(desc.width), int32_t(desc.height) };
        file.write(reinterpret_cast<const char*>(size), sizeof(size));
        file.write(reinterpret_cast<const char*>(pixels.data()), std::streamsize(pixels.size() * sizeof(float)));
        file.close();
        if (!file)
        {
            donut::log::error("Rtxdi_SaveTextureRGBA32F: couldn't write %s", path);
            return 0;
        }
        return 1;
    }
}

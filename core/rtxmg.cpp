// C++ side of the rtxmg_demo example (NVIDIA's RTX Mega Geometry demo, github.com/NVIDIA-RTX/RTXMG), its
// cluster tessellation path: the library's scene (subdivision surfaces, their animation poses, materials,
// textures), the cluster tessellator that turns the surfaces into clusters and rebuilds their CLASes and
// BLASes every frame, the HiZ buffer it culls against (traced from the previous frame's TLAS), the TLAS,
// and the environment map's importance-sampling tables. TypeScript makes the path tracer's pipeline and
// binding set over what this hands it, traces, accumulates and tone maps. The library and the demo's
// helpers (zrenderer.cpp, envmap's scan system) are built from RTXMG_DIR in place, and its demo headers
// (render_params.h, lighting_cb.h, blit_params.h...) included from there: built only with RTXMG_DIR
// (CMakeLists.txt).
//
// This software contains source code provided by NVIDIA Corporation.
//
// Copyright (c) 2024-2026, NVIDIA CORPORATION.  All rights reserved.
//
// NVIDIA CORPORATION and its licensors retain all intellectual property
// and proprietary rights in and to this software, related documentation
// and any modifications thereto.  Any use, reproduction, disclosure or
// distribution of this software and related documentation without an express
// license agreement from NVIDIA CORPORATION is strictly prohibited.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <numbers>
#include <string>
#include <vector>

#include <donut/app/ApplicationBase.h>
#include <donut/core/json.h>
#include <donut/core/log.h>
#include <donut/core/math/math.h>
#include <donut/core/vfs/VFS.h>
#include <donut/engine/CommonRenderPasses.h>
#include <donut/engine/DescriptorTableManager.h>
#include <donut/engine/SceneGraph.h>
#include <donut/engine/SceneTypes.h>
#include <donut/engine/ShaderFactory.h>
#include <donut/engine/TextureCache.h>
#include <donut/engine/ThreadPool.h>
#include <nvrhi/nvrhi.h>
#include <nvrhi/utils.h>

#include "rtxmg/cluster_tess/cluster_tessellator.h"
#include "rtxmg/cluster_tess/fill_instance_descs_params.h"
#include "rtxmg/hiz/zbuffer.h"
#include "rtxmg/scene/camera.h"
#include "rtxmg/scene/scene.h"
#include "rtxmg/subdivision/subdivision_surface.h"
#include "rtxmg/utils/bindless_layout.h"
#include "rtxmg/utils/buffer.h"
#include "rtxmg/utils/pixel_pick.h"

// The demo's headers, shared with its shaders (RTXMG_DIR/demo on the include path).
#include "blit_params.h"
#include "envmap/preprocess_envmap_params.h"
#include "envmap/scan_system.h"
#include "gbuffer.h"
#include "lerp_keyframes_params.h"
#include "lighting_cb.h"
#include "ray_payload.h"
#include "render_params.h"
#include "zrenderer.h"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include "donut_api.h"

using namespace donut;
using namespace donut::math;

namespace
{
    // The folder of the module holding this code: the executable, or donut_interop_shared under the JIT
    // (whose executable is tslang's). bin/, where the shaders are.
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
        return app::GetDirectoryWithExecutable();
#endif
    }

    // The scene file's "settings" the demo reads (its Args << Json): the ones the cluster tessellation
    // path traces with.
    struct SceneSettings
    {
        std::string envmap;           // relative to the media folder
        float envmapAzimuth = 0.f;    // radians ("envmap rotation" is in degrees)
        float envmapElevation = 0.f;
        float envmapIntensity = 1.f;
        uint32_t spp = 1;
        uint32_t maxBounces = 8;
        float fireflyMaxIntensity = 1000.f;
        float exposure = 1.f;
    };
}

// What the example's frame needs from RTX Mega Geometry, as the demo's RTXMGRenderer holds it, without its
// cluster-LOD, DLSS and debug parts.
struct RtxmgDemo
{
    nvrhi::DeviceHandle device;
    std::shared_ptr<engine::ShaderFactory> shaderFactory;
    std::shared_ptr<engine::CommonRenderPasses> commonPasses;
    nvrhi::BindingLayoutHandle bindlessLayout;
    std::shared_ptr<engine::DescriptorTableManager> descriptorTable;
    std::shared_ptr<engine::TextureCache> textureCache;
    std::unique_ptr<engine::ThreadPool> threadPool;

    std::filesystem::path mediaPath;
    std::shared_ptr<RTXMGScene> scene;
    SceneSettings settings;

    Camera camera;
    bool accelNeedsUpdate = true;
    ClusterTessStatistics buildStats;
    std::unique_ptr<ClusterTessellator> tessellator;
    std::unique_ptr<ClusterTessAccels> accels;
    nvrhi::rt::AccelStructHandle tlas;
    bool tlasBuilt = false;
    RTXMGBuffer<nvrhi::rt::InstanceDesc> instanceDescs;
    RTXMGBuffer<SubdInstance> subdInstances;
    nvrhi::BufferHandle fillInstanceDescsParams;
    nvrhi::BindingLayoutHandle fillInstanceDescsLayout;
    nvrhi::ComputePipelineHandle fillInstanceDescsPipeline;

    nvrhi::BufferHandle lerpPoses;
    nvrhi::BindingLayoutHandle lerpLayout;
    nvrhi::ComputePipelineHandle lerpPipeline;

    std::unique_ptr<ZBuffer> zbuffer;
    std::unique_ptr<ZRenderer> zrenderer;

    // Outputs at the render size.
    int2 size = int2(0, 0);
    nvrhi::TextureHandle accumulation, depth, normals, albedo, specular, specularHitT, roughness, display;
    nvrhi::BufferHandle hitResult;
    RTXMGBuffer<ShaderDebugElement> pixelDebug;
    RTXMGBuffer<PixelPickResult> pixelPick;
    nvrhi::BufferHandle timeView;
    nvrhi::BufferHandle dummy;        // the shaders' unused structured buffers (cluster LOD's)
    nvrhi::BufferHandle exposure;     // the blit's auto-exposure input, unused (a typed R32_UINT, as Donut's)

    // Environment map and its importance-sampling tables.
    std::shared_ptr<engine::LoadedTexture> envMap;
    ScanSystem scanSystem;
    RTXMGBuffer<float> conditionalFunc, conditionalCdf, marginalFunc, marginalCdf;

    nvrhi::BufferHandle lightingConstants, renderParamsBuffer, blitParamsBuffer;
    nvrhi::ShaderLibraryHandle pathTracerLibrary;
    nvrhi::ShaderHandle blitShader;
    RenderParams params = {};
    // The sun, along the view (the demo's); in a scene graph node, which setting its direction needs.
    std::shared_ptr<engine::DirectionalLight> sun = std::make_shared<engine::DirectionalLight>();
    std::shared_ptr<engine::SceneGraphNode> sunNode = std::make_shared<engine::SceneGraphNode>();
    // Bumped whenever a resource TypeScript binds is made again (the binding set has to be too).
    int bindingGeneration = 0;

    nvrhi::ICommandList* OpenCommandList(nvrhi::CommandListHandle& commandList)
    {
        // Not immediate: the app may have its own immediate list open (only one may be).
        commandList = device->createCommandList(nvrhi::CommandListParameters().setEnableImmediateExecution(false));
        commandList->open();
        return commandList;
    }

    void ExecuteAndWait(nvrhi::CommandListHandle& commandList)
    {
        commandList->close();
        device->executeCommandList(commandList);
        device->waitForIdle();
    }
};

namespace
{
    bool CreateShaders(RtxmgDemo& r)
    {
        const std::filesystem::path bin = ModuleDirectory();
        const char* api = app::GetShaderTypeName(r.device->getGraphicsAPI());
        auto fs = std::make_shared<vfs::RootFileSystem>();
        for (const char* lib : { "rtxmg_demo", "cluster_tess", "cluster_lod", "envmap", "hiz" })
            fs->mount(std::string("/shaders/") + lib, bin / "shaders" / lib / api / "shaders");
        fs->mount("/shaders/donut", bin / "shaders" / "framework" / api);
        r.shaderFactory = std::make_shared<engine::ShaderFactory>(r.device, fs, "/shaders");
        r.commonPasses = std::make_shared<engine::CommonRenderPasses>(r.device, r.shaderFactory);
        return std::filesystem::exists(bin / "shaders" / "rtxmg_demo" / api / "shaders" / "rtxmg_demo_path_tracer.bin");
    }

    nvrhi::TextureHandle CreateOutput(nvrhi::IDevice* device, int2 size, nvrhi::Format format, const char* name)
    {
        nvrhi::TextureDesc desc;
        desc.width = size.x;
        desc.height = size.y;
        desc.isUAV = true;
        desc.keepInitialState = true;
        desc.format = format;
        desc.initialState = nvrhi::ResourceStates::UnorderedAccess;
        desc.debugName = name;
        return device->createTexture(desc);
    }

    void ReadSceneSettings(const std::filesystem::path& sceneFile, SceneSettings& s)
    {
        Json::Value root;
        std::ifstream file(sceneFile);
        if (!file || !(file >> root))
            return;
        const Json::Value& node = root["settings"];
        if (!node.isObject())
            return;
        constexpr float degrees = float(std::numbers::pi) / 180.f;
        if (node["envmap"].isString()) s.envmap = node["envmap"].asString();
        if (node["envmap rotation"].isNumeric()) s.envmapAzimuth = node["envmap rotation"].asFloat() * degrees;
        if (node["envmap elevation"].isNumeric()) s.envmapElevation = node["envmap elevation"].asFloat() * degrees;
        if (node["envmap intensity"].isNumeric()) s.envmapIntensity = node["envmap intensity"].asFloat();
        if (node["spp"].isIntegral()) s.spp = node["spp"].asUInt();
        if (node["max bounces"].isIntegral()) s.maxBounces = node["max bounces"].asUInt();
        if (node["firefly max intensity"].isNumeric()) s.fireflyMaxIntensity = node["firefly max intensity"].asFloat();
        if (node["exposure"].isNumeric()) s.exposure = node["exposure"].asFloat();
    }

    // The environment map's conditional and marginal functions and CDFs, which the path tracer samples
    // it by (the demo's UpdateEnvMapSampling).
    void UpdateEnvMapSampling(RtxmgDemo& r, nvrhi::ICommandList* commandList)
    {
        const uint32_t width = r.envMap->texture->getDesc().width;
        const uint32_t height = r.envMap->texture->getDesc().height;
        r.conditionalFunc.Create(width * height, "Conditional Func", r.device, nvrhi::Format::R32_FLOAT);
        r.conditionalCdf.Create((width + 2) * height, "Conditional CDF", r.device, nvrhi::Format::R32_FLOAT);
        r.marginalFunc.Create(height, "Marginal Func", r.device, nvrhi::Format::R32_FLOAT);
        r.marginalCdf.Create(height + 2, "Marginal CDF", r.device, nvrhi::Format::R32_FLOAT);

        PreprocessEnvMapParams params;
        params.envMapWidth = width;
        params.envMapHeight = height;
        nvrhi::BufferHandle paramsBuffer = r.device->createBuffer(nvrhi::utils::CreateVolatileConstantBufferDesc(
            sizeof(params), "PreprocessEnvMapParams", engine::c_MaxRenderPassConstantBufferVersions));
        commandList->writeBuffer(paramsBuffer, &params, sizeof(params));

        auto bindingSetDesc = nvrhi::BindingSetDesc()
            .addItem(nvrhi::BindingSetItem::Texture_SRV(0, r.envMap->texture))
            .addItem(nvrhi::BindingSetItem::TypedBuffer_UAV(0, r.conditionalFunc))
            .addItem(nvrhi::BindingSetItem::TypedBuffer_UAV(1, r.conditionalCdf))
            .addItem(nvrhi::BindingSetItem::TypedBuffer_UAV(2, r.marginalFunc))
            .addItem(nvrhi::BindingSetItem::TypedBuffer_UAV(3, r.marginalCdf))
            .addItem(nvrhi::BindingSetItem::ConstantBuffer(0, paramsBuffer))
            .addItem(nvrhi::BindingSetItem::Sampler(0, r.commonPasses->m_LinearClampSampler));
        nvrhi::BindingLayoutHandle layout;
        nvrhi::BindingSetHandle bindingSet;
        if (!nvrhi::utils::CreateBindingSetAndLayout(r.device, nvrhi::ShaderType::Compute, 0, bindingSetDesc, layout, bindingSet))
            return;

        auto run = [&](const char* path, uint32_t x, uint32_t y)
        {
            nvrhi::ShaderHandle shader = r.shaderFactory->CreateShader(path, "main", nullptr, nvrhi::ShaderType::Compute);
            nvrhi::ComputePipelineHandle pipeline = r.device->createComputePipeline(
                nvrhi::ComputePipelineDesc().setComputeShader(shader).addBindingLayout(layout));
            commandList->setComputeState(nvrhi::ComputeState().setPipeline(pipeline).addBindingSet(bindingSet));
            commandList->dispatch(x, y);
        };
        run("envmap/compute_conditional.hlsl", div_ceil(width, 16), div_ceil(height, 16));
        r.scanSystem.PrefixScan(r.conditionalFunc, r.conditionalCdf, width, height, commandList);
        nvrhi::utils::BufferUavBarrier(commandList, r.conditionalCdf);
        run("envmap/compute_marginal.hlsl", 1, div_ceil(height, 32));
        r.scanSystem.PrefixScan(r.marginalFunc, r.marginalCdf, height, 1, commandList);
    }

    // Interpolates the animated surfaces' poses between their keyframes (the demo's DispatchGPUAnimation):
    // the pose position buffers are filled only by this, also when the animation stands still.
    void LerpPoses(RtxmgDemo& r, nvrhi::ICommandList* commandList)
    {
        const auto poses = r.scene->GetSubdPoses();
        if (poses.empty())
            return;
        std::vector<LerpKeyFramesPose> lerpPoses(poses.size());
        for (size_t i = 0; i < poses.size(); ++i)
            lerpPoses[i] = { .f0 = poses[i].f0, .f1 = poses[i].f1, .blend = poses[i].blend, ._pad = 0 };
        const size_t bytes = lerpPoses.size() * sizeof(LerpKeyFramesPose);
        if (!r.lerpPoses || r.lerpPoses->getDesc().byteSize < bytes)
            r.lerpPoses = r.device->createBuffer(nvrhi::BufferDesc().setByteSize(bytes)
                .setStructStride(sizeof(LerpKeyFramesPose)).setDebugName("LerpKeyFramesPoses")
                .setInitialState(nvrhi::ResourceStates::ShaderResource).setKeepInitialState(true));
        commandList->writeBuffer(r.lerpPoses, lerpPoses.data(), bytes);

        const auto& meshes = r.scene->GetSubdMeshes();
        for (uint32_t first = 0, last; first < poses.size(); first = last)
        {
            const uint32_t meshID = poses[first].meshID;
            for (last = first + 1; last < poses.size() && poses[last].meshID == meshID; ++last) {}
            const SubdivisionSurface& mesh = *meshes[meshID];
            const uint32_t numPoses = last - first;
            auto bindingSetDesc = nvrhi::BindingSetDesc()
                .addItem(nvrhi::BindingSetItem::StructuredBuffer_SRV(0, mesh.m_positionKeyframes))
                .addItem(nvrhi::BindingSetItem::StructuredBuffer_SRV(1, r.lerpPoses, nvrhi::Format::UNKNOWN,
                    nvrhi::BufferRange(first * sizeof(LerpKeyFramesPose), numPoses * sizeof(LerpKeyFramesPose))))
                .addItem(nvrhi::BindingSetItem::StructuredBuffer_UAV(0, mesh.m_posePositions))
                .addItem(nvrhi::BindingSetItem::StructuredBuffer_UAV(1, mesh.m_posePositionsPrev))
                .addItem(nvrhi::BindingSetItem::PushConstants(0, sizeof(LerpKeyFramesConstants)));
            nvrhi::BindingSetHandle bindingSet;
            if (!nvrhi::utils::CreateBindingSetAndLayout(r.device, nvrhi::ShaderType::Compute, 0, bindingSetDesc, r.lerpLayout, bindingSet))
                return;
            if (!r.lerpPipeline)
            {
                nvrhi::ShaderHandle shader = r.shaderFactory->CreateShader("rtxmg_demo/lerp_keyframes.hlsl", "main", nullptr, nvrhi::ShaderType::Compute);
                r.lerpPipeline = r.device->createComputePipeline(nvrhi::ComputePipelineDesc().setComputeShader(shader).addBindingLayout(r.lerpLayout));
            }
            commandList->setComputeState(nvrhi::ComputeState().setPipeline(r.lerpPipeline).addBindingSet(bindingSet));
            const LerpKeyFramesConstants constants{ .numVertices = mesh.NumVertices(), .poseStride = mesh.m_poseStride };
            commandList->setPushConstants(&constants, sizeof(constants));
            commandList->dispatch(div_ceil(mesh.NumVertices(), 64u), numPoses, 1);
        }
    }

    void FillInstanceDescs(RtxmgDemo& r, nvrhi::ICommandList* commandList, nvrhi::IBuffer* blasAddresses, uint32_t numInstances)
    {
        FillInstanceDescsParams params = {};
        params.numInstances = numInstances;
        params.instanceOffset = 0;
        commandList->writeBuffer(r.fillInstanceDescsParams, &params, sizeof(params));
        auto bindingSetDesc = nvrhi::BindingSetDesc()
            .addItem(nvrhi::BindingSetItem::StructuredBuffer_SRV(0, blasAddresses))
            .addItem(nvrhi::BindingSetItem::StructuredBuffer_UAV(0, r.instanceDescs))
            .addItem(nvrhi::BindingSetItem::ConstantBuffer(0, r.fillInstanceDescsParams));
        nvrhi::BindingSetHandle bindingSet;
        if (!nvrhi::utils::CreateBindingSetAndLayout(r.device, nvrhi::ShaderType::Compute, 0, bindingSetDesc, r.fillInstanceDescsLayout, bindingSet))
            return;
        if (!r.fillInstanceDescsPipeline)
        {
            nvrhi::ShaderHandle shader = r.shaderFactory->CreateShader("cluster_tess/fill_instance_descs.hlsl", "main", nullptr, nvrhi::ShaderType::Compute);
            r.fillInstanceDescsPipeline = r.device->createComputePipeline(
                nvrhi::ComputePipelineDesc().setComputeShader(shader).addBindingLayout(r.fillInstanceDescsLayout));
        }
        commandList->setComputeState(nvrhi::ComputeState().setPipeline(r.fillInstanceDescsPipeline).addBindingSet(bindingSet));
        commandList->dispatch(div_ceil(numInstances, kFillInstanceDescsThreads), 1, 1);
    }

    // The TLAS over the subdivision surface instances, their BLAS addresses patched in from the cluster
    // tessellator's (the demo's UpdateAccelerationStructures without cluster LOD), and the instances' data
    // the hit shader reads.
    void BuildTlas(RtxmgDemo& r, nvrhi::ICommandList* commandList, uint32_t frameIndex)
    {
        r.scene->Refresh(commandList, frameIndex);

        std::vector<nvrhi::rt::InstanceDesc> instances;
        std::vector<SubdInstance> subdInstances;
        auto index = [](const DescriptorHandle& descriptor) -> uint32_t
        {
            return descriptor.IsValid() ? uint32_t(descriptor.GetIndexInHeap()) : kInvalidBindlessIndex;
        };
        uint32_t instanceIndex = 0;
        for (const auto& instance : r.scene->GetSubdMeshInstances())
        {
            const auto& mesh = r.scene->GetSubdMeshes()[instance.meshID];
            const unsigned int writeDepth = !mesh->HasAnimation();
            nvrhi::rt::InstanceDesc desc;
            desc.blasDeviceAddress = 0;  // fill_instance_descs writes it
            desc.instanceMask = (writeDepth << 1) | 0x1;
            desc.instanceID = instanceIndex++;
            desc.instanceContributionToHitGroupIndex = 0;
            affineToColumnMajor(instance.node->localToWorld, desc.transform);
            instances.push_back(desc);

            SubdInstance s;
            s.plansBindlessIndex = index(mesh->GetTopologyMap()->plansDescriptor);
            s.stencilMatrixBindlessIndex = index(mesh->GetTopologyMap()->stencilMatrixDescriptor);
            s.subpatchTreesBindlessIndex = index(mesh->GetTopologyMap()->subpatchTreesDescriptor);
            s.patchPointIndicesBindlessIndex = index(mesh->GetTopologyMap()->patchPointIndicesDescriptor);
            s.meshID = instance.meshID;
            s._meshPad = 0;
            s.vertexSurfaceDescriptorBindlessIndex = index(mesh->m_vertexSurfaceDescriptorDescriptor);
            s.vertexControlPointIndicesBindlessIndex = index(mesh->m_vertexControlPointIndicesDescriptor);
            const SubdivisionSurface::Pose* pose = r.scene->GetSubdPose(instance);
            s.positionsBindlessIndex = index(pose ? pose->positionsDescriptor : mesh->m_positionsDescriptor);
            s.positionsPrevBindlessIndex = pose ? index(pose->positionsPrevDescriptor) : kInvalidBindlessIndex;
            s.surfaceToMaterialIndexBindlessIndex = index(mesh->m_surfaceToMaterialIndexDescriptor);
            s.topologyQualityBindlessIndex = index(mesh->m_topologyQualityDescriptor);
            affineToColumnMajor(instance.node->prevLocalToWorld, s.prevLocalToWorld);
            affineToColumnMajor(inverse(instance.node->localToWorld), s.worldToLocal);
            subdInstances.push_back(s);
        }
        const uint32_t count = uint32_t(instances.size());
        if (count == 0)
            return;

        if (!r.instanceDescs.GetBuffer() || r.instanceDescs.GetNumElements() != count)
        {
            nvrhi::BufferDesc desc = {
                .byteSize = count * sizeof(nvrhi::rt::InstanceDesc),
                .structStride = sizeof(nvrhi::rt::InstanceDesc),
                .debugName = "TLAS InstanceDescs",
                .canHaveUAVs = true,
                .isAccelStructBuildInput = true,
                .initialState = nvrhi::ResourceStates::AccelStructBuildInput,
                .keepInitialState = true,
            };
            r.instanceDescs.Create(desc, r.device);
            r.subdInstances.Create(count, "SubdInstances", r.device);
            ++r.bindingGeneration;
        }
        commandList->writeBuffer(r.instanceDescs.GetBuffer(), instances.data(), count * sizeof(nvrhi::rt::InstanceDesc));
        r.subdInstances.Upload(subdInstances, commandList);
        if (nvrhi::IBuffer* blasAddresses = r.accels->blasPtrsBuffer)
            FillInstanceDescs(r, commandList, blasAddresses, count);
        commandList->buildTopLevelAccelStructFromBuffer(r.tlas, r.instanceDescs, 0u, count);
        r.tlasBuilt = true;
    }

    CameraConstants MakeCameraConstants(const Camera& camera, int2 size)
    {
        return CameraConstants{
            camera.GetViewMatrix(),
            inverse(camera.GetViewMatrix()),
            camera.GetProjectionMatrix(),
            inverse(camera.GetProjectionMatrix()),
            float2(float(size.x), float(size.y)),
            float2(1.0f / size.x, 1.0f / size.y) };
    }

    float VanDerCorput(size_t base, size_t index)
    {
        float ret = 0.0f;
        float denominator = float(base);
        while (index > 0)
        {
            ret += float(index % base) / denominator;
            index /= base;
            denominator *= float(base);
        }
        return ret;
    }
}

extern "C"
{
    // Makes the library's shader factory, bindless descriptor table (its capacity reserved before any
    // descriptor, as the cluster tessellator caches absolute heap indices), texture cache and constant
    // buffers. `device` is Donut_GetNvrhiDevice's. Null if the shaders aren't in bin/shaders/rtxmg_demo.
    DONUT_API RtxmgDemo* Donut_RtxmgCreate(void* device)
    {
        auto r = std::make_unique<RtxmgDemo>();
        r->device = static_cast<nvrhi::IDevice*>(device);
        // Cluster operations: Vulkan's VK_NV_cluster_acceleration_structure. NVRHI's D3D12 ones need NVAPI
        // or its DXR cluster build, neither of which this build has.
        if (!r->device->queryFeatureSupport(nvrhi::Feature::RayTracingClusters))
        {
            log::info("rtxmg_demo: the device has no cluster acceleration structures");
            return nullptr;
        }
        if (!CreateShaders(*r))
        {
            log::error("rtxmg_demo: its shaders are missing (build rtxmg_demo_shaders, with RTXMG_DIR)");
            return nullptr;
        }
        r->bindlessLayout = r->device->createBindlessLayout(rtxmg::MakeGlobalBindlessLayoutDesc());
        r->descriptorTable = std::make_shared<engine::DescriptorTableManager>(r->device, r->bindlessLayout);
        r->descriptorTable->ReserveCapacity(rtxmg::kGlobalBindlessCapacity);
        r->textureCache = std::make_shared<engine::TextureCache>(r->device, std::make_shared<vfs::NativeFileSystem>(), r->descriptorTable);
        const unsigned hw = std::thread::hardware_concurrency();
        r->threadPool = std::make_unique<engine::ThreadPool>(hw > 4 ? hw - 2 : std::max(1u, hw));

        auto constants = [&](size_t size, const char* name)
        {
            return r->device->createBuffer(nvrhi::utils::CreateVolatileConstantBufferDesc(
                uint32_t(size), name, engine::c_MaxRenderPassConstantBufferVersions));
        };
        r->lightingConstants = constants(sizeof(LightingConstants), "LightingConstants");
        r->renderParamsBuffer = constants(sizeof(RenderParams), "RenderParams");
        r->blitParamsBuffer = constants(sizeof(BlitParams), "BlitParams");
        r->fillInstanceDescsParams = constants(sizeof(FillInstanceDescsParams), "FillInstanceDescsParams");
        r->timeView = r->device->createBuffer(nvrhi::BufferDesc().setByteSize(2 * sizeof(uint32_t))
            .setFormat(nvrhi::Format::R32_UINT).setCanHaveTypedViews(true).setCanHaveUAVs(true)
            .setDebugName("TimeViewBuffer").setInitialState(nvrhi::ResourceStates::UnorderedAccess).setKeepInitialState(true));
        r->dummy = r->device->createBuffer(nvrhi::BufferDesc().setByteSize(sizeof(float)).setStructStride(sizeof(float))
            .setFormat(nvrhi::Format::R32_FLOAT).setCanHaveTypedViews(true)
            .setDebugName("DummyBuffer").setInitialState(nvrhi::ResourceStates::ShaderResource).setKeepInitialState(true));
        r->exposure = r->device->createBuffer(nvrhi::BufferDesc().setByteSize(sizeof(uint32_t))
            .setFormat(nvrhi::Format::R32_UINT).setCanHaveTypedViews(true)
            .setDebugName("Exposure").setInitialState(nvrhi::ResourceStates::ShaderResource).setKeepInitialState(true));
        r->pixelDebug.Create(64, "PixelDebugBuffer", r->device);
        r->pixelPick.Create(1, "PixelPickBuffer", r->device);
        r->scanSystem.Init(r->shaderFactory, r->device);

        r->sun->angularSize = 0.53f;
        r->sun->irradiance = 3.f;
        r->sunNode->SetLeaf(r->sun);
        r->params.colorMode = ColorMode::BASE_COLOR;
        r->params.shadingMode = ShadingMode::PT;
        r->params.missColor = float3(0.75f);  // the demo's default, seen where rays miss without an environment map
        r->params.wireframeThickness = 0.1f;
        r->params.roughnessOverride = 0.f;
        r->params.isolationLevel = TessellatorConfig::kMaxIsolationLevel;
        r->params.clusterPattern = uint32_t(ClusterTessPattern::SLANTED);
        r->params.globalDisplacementScale = 1.f;
        r->params.debugSurfaceIndex = -1;
        r->params.debugPixel = int2(-1, -1);
        r->params.selectedClusterLodGeometry = -1;
        r->params.selectedClusterLodInstance = -1;
        r->params.selectedClusterLodLevel = -1;
        r->params.selectedSubdMesh = -1;
        r->params.envmapIntensity = 1.f;
        r->params.denoiserMode = DenoiserMode::None;
        return r.release();
    }

    DONUT_API void Donut_RtxmgDestroy(RtxmgDemo* r)
    {
        if (r)
            r->device->waitForIdle();
        delete r;
    }

    // Loads `sceneFile` (relative to `mediaDirectory`, RTXMG_DIR/assets for its scenes) and its "settings",
    // finishes uploading it, and makes the tessellator, the TLAS and the environment map's sampling
    // tables; points the camera at the scene's view. Waits for the GPU. False if it can't load.
    DONUT_API bool Donut_RtxmgLoadScene(RtxmgDemo* r, const char* mediaDirectory, const char* sceneFile)
    {
        r->mediaPath = std::filesystem::path(mediaDirectory).lexically_normal();
        const std::filesystem::path scenePath = r->mediaPath / sceneFile;
        ReadSceneSettings(scenePath, r->settings);

        auto scene = std::make_shared<RTXMGScene>(RTXMGSceneParams{
            .device = r->device,
            .mediaPath = &r->mediaPath,
            .commonPasses = r->commonPasses,
            .fs = std::make_shared<vfs::NativeFileSystem>(),
            .textureCache = r->textureCache,
            .descriptorTable = r->descriptorTable,
        });
        scene->SetEnableMaterials(true);
        scene->SetEnableNormalMaps(true);
        if (!scene->LoadWithThreadPool(scenePath, r->threadPool.get(), nullptr))
            return false;
        r->threadPool->WaitForTasks();
        r->textureCache->ProcessRenderingThreadCommands(*r->commonPasses, 0.f);
        r->textureCache->LoadingFinished();
        r->scene = scene;

        nvrhi::CommandListHandle commandList;
        nvrhi::ICommandList* cl = r->OpenCommandList(commandList);
        r->scene->FinishedLoading(cl);

        nvrhi::rt::AccelStructDesc tlasDesc;
        tlasDesc.isTopLevel = true;
        tlasDesc.topLevelMaxInstances = std::max<uint32_t>(uint32_t(r->scene->GetSubdMeshInstances().size()), 1u);
        tlasDesc.debugName = "TLAS";
        r->tlas = r->device->createAccelStruct(tlasDesc);
        r->tlasBuilt = false;
        r->tessellator = std::make_unique<ClusterTessellator>(*r->shaderFactory, r->commonPasses,
            r->descriptorTable->GetDescriptorTable(), r->device);
        r->accels = std::make_unique<ClusterTessAccels>();

        if (!r->settings.envmap.empty())
        {
            const std::filesystem::path envmapPath = r->mediaPath / r->settings.envmap;
            r->envMap = r->textureCache->LoadTextureFromFile(envmapPath, engine::TextureLoadOptions{ engine::SRGBMode::FromFile },
                r->commonPasses.get(), cl);
            if (r->envMap && r->envMap->texture)
                UpdateEnvMapSampling(*r, cl);
            else
                r->envMap = nullptr;
        }
        r->ExecuteAndWait(commandList);

        const SceneSettings& s = r->settings;
        r->params.spp = s.spp;
        r->params.ptMaxBounces = s.maxBounces;
        r->params.fireflyMaxIntensity = s.fireflyMaxIntensity;
        r->params.hasEnvironmentMap = r->envMap ? 1 : 0;
        r->params.envmapIntensity = s.envmapIntensity;
        const affine3 rotation = donut::math::rotation(float3(0, 1, 0), s.envmapAzimuth) * donut::math::rotation(float3(1, 0, 0), s.envmapElevation);
        r->params.envmapRotation = affineToHomogeneous(rotation);
        r->params.envmapRotationInv = transpose(r->params.envmapRotation);

        if (const View* view = r->scene->GetView())
        {
            r->camera.SetEye(view->position);
            r->camera.SetLookat(view->lookat);
            r->camera.SetUp(view->up);
            r->camera.SetFovY(view->fov);
        }
        r->accelNeedsUpdate = true;
        ++r->bindingGeneration;
        return true;
    }

    // The scene file's exposure (the blit's), and its path tracing samples per pixel and bounces.
    DONUT_API double Donut_RtxmgGetExposure(RtxmgDemo* r)
    {
        return r->settings.exposure;
    }
    DONUT_API int Donut_RtxmgGetMaxBounces(RtxmgDemo* r)
    {
        return int(r->params.ptMaxBounces);
    }
    DONUT_API int Donut_RtxmgGetPayloadSize(RtxmgDemo* r)
    {
        return int(sizeof(RayPayload));
    }

    // The path tracer's samples per pixel, bounces and firefly clamp (the scene file's, until set); negative
    // values keep the current ones. Set before the pipeline, whose recursion depth is the bounces + 1.
    DONUT_API void Donut_RtxmgSetPathTracing(RtxmgDemo* r, int spp, int maxBounces, double fireflyMaxIntensity)
    {
        if (spp >= 0) r->params.spp = uint32_t(spp);
        if (maxBounces >= 0) r->params.ptMaxBounces = uint32_t(maxBounces);
        if (fireflyMaxIntensity >= 0.0) r->params.fireflyMaxIntensity = float(fireflyMaxIntensity);
        r->params.subFrameIndex = 0;
    }

    // The demo's shading mode (0 primary rays, 1 ambient occlusion, 2 path tracing) and color mode (0 base
    // color, ...: its ColorMode); the accumulation starts over.
    DONUT_API void Donut_RtxmgSetShadingMode(RtxmgDemo* r, int shadingMode, int colorMode)
    {
        r->params.shadingMode = ShadingMode(shadingMode);
        r->params.colorMode = ColorMode(colorMode);
        r->params.subFrameIndex = 0;
    }

    // The camera from a "[eye][lookat][up]fovY" string (the demo's -p); false if malformed.
    DONUT_API bool Donut_RtxmgSetCamera(RtxmgDemo* r, const char* camera)
    {
        if (!r->camera.Set(camera))
            return false;
        r->accelNeedsUpdate = true;
        return true;
    }

    // Makes the outputs at the render size (the path tracer's accumulation and G-buffer, the display
    // texture the blit writes) and the HiZ buffer; the subframes start over.
    DONUT_API void Donut_RtxmgSetSize(RtxmgDemo* r, int width, int height)
    {
        const int2 size(width, height);
        if (all(size == r->size))
            return;
        r->device->waitForIdle();
        r->size = size;
        r->camera.SetAspectRatio(float(width) / float(height));
        nvrhi::IDevice* d = r->device;
        r->accumulation = CreateOutput(d, size, nvrhi::Format::RGBA32_FLOAT, "Accum");
        r->depth = CreateOutput(d, size, nvrhi::Format::R32_FLOAT, "Depth");
        r->normals = CreateOutput(d, size, nvrhi::Format::RGBA16_FLOAT, "Normals");
        r->albedo = CreateOutput(d, size, nvrhi::Format::RGBA8_UNORM, "Albedo");
        r->specular = CreateOutput(d, size, nvrhi::Format::RGBA8_UNORM, "Specular");
        r->specularHitT = CreateOutput(d, size, nvrhi::Format::R32_FLOAT, "SpecularHitT");
        r->roughness = CreateOutput(d, size, nvrhi::Format::R8_UNORM, "Roughness");
        r->display = CreateOutput(d, size, nvrhi::Format::RGBA8_UNORM, "Display");
        r->hitResult = d->createBuffer(nvrhi::BufferDesc().setByteSize(uint64_t(width) * height * sizeof(HitResult))
            .setStructStride(sizeof(HitResult)).setCanHaveUAVs(true).setDebugName("HitResult")
            .setInitialState(nvrhi::ResourceStates::UnorderedAccess).setKeepInitialState(true));
        nvrhi::CommandListHandle commandList;
        nvrhi::ICommandList* cl = r->OpenCommandList(commandList);
        r->zbuffer = ZBuffer::Create(uint2(width, height), r->commonPasses, r->shaderFactory, cl);
        r->zbuffer->Clear(cl);
        r->ExecuteAndWait(commandList);
        r->params.subFrameIndex = 0;
        r->accelNeedsUpdate = true;
        ++r->bindingGeneration;
    }

    // Records the frame's work before the path tracer: the poses, the HiZ prepass (the previous TLAS from
    // this camera), the clusters and acceleration structures while the tessellation changes (the
    // adaptive rate settles over a few frames), and the constants. Returns the binding generation:
    // different from the last frame's when a resource the binding set holds was made again.
    DONUT_API int Donut_RtxmgBeginFrame(RtxmgDemo* r, nvrhi::ICommandList* commandList, int frameIndex)
    {
        LerpPoses(*r, commandList);

        const TessellatorConfig config = {
            .tessMode = TessellatorConfig::AdaptiveTessellationMode::SPHERICAL_PROJECTION,
            .viewportSize = { uint32_t(r->size.x), uint32_t(r->size.y) },
            .isolationLevel = r->params.isolationLevel,
            .clusterPattern = ClusterTessPattern(r->params.clusterPattern),
            .displacementScale = r->params.globalDisplacementScale,
            .camera = &r->camera,
            .zbuffer = r->zbuffer.get(),
        };
        if (r->accelNeedsUpdate && r->tessellator->ResizeAccelStorage(*r->scene, config, *r->accels))
        {
            r->tlasBuilt = false;
            ++r->bindingGeneration;
        }
        if (r->tlasBuilt && r->zbuffer)
        {
            if (!r->zrenderer)
                r->zrenderer = std::make_unique<ZRenderer>(r->shaderFactory);
            r->zrenderer->Render(r->camera, r->tlas, r->zbuffer->GetCurrent(), commandList);
            r->zbuffer->ReduceHierarchy(commandList);
        }
        if (r->accelNeedsUpdate)
        {
            nvrhi::IBuffer* before[] = { r->accels->clusterShadingDataBuffer, r->accels->clusterVertexPositionsBuffer,
                r->accels->clusterVertexNormalsBuffer };
            if (!r->scene->GetSubdMeshes().empty())
                r->tessellator->BuildAccel(*r->scene, config, *r->accels, r->buildStats, uint32_t(frameIndex), commandList);
            BuildTlas(*r, commandList, uint32_t(frameIndex));
            if (before[0] != r->accels->clusterShadingDataBuffer || before[1] != r->accels->clusterVertexPositionsBuffer
                || before[2] != r->accels->clusterVertexNormalsBuffer)
                ++r->bindingGeneration;
            r->accelNeedsUpdate = r->buildStats.tessRateAdjusted;
        }

        // The sun shines along the view, as the demo's.
        r->sun->SetDirection(double3(r->camera.GetDirection()));
        LightingConstants lighting = {};
        lighting.ambientColor = float4(0.05f);
        r->sun->FillLightConstants(lighting.light);
        commandList->writeBuffer(r->lightingConstants, &lighting, sizeof(lighting));

        const uint32_t phaseCount = 8;
        const uint32_t phase = (r->params.subFrameIndex % phaseCount) + 1;
        r->params.jitter = float2{ VanDerCorput(2, phase), VanDerCorput(3, phase) } - 0.5f;
        auto const& [u, v, w] = r->camera.GetBasis();
        if (any(r->camera.GetEye() != r->params.eye) || any(u != r->params.U) || any(v != r->params.V) || any(w != r->params.W))
            r->params.subFrameIndex = 0;
        r->params.camera = MakeCameraConstants(r->camera, r->size);
        r->params.prevCamera = r->params.camera;
        r->params.zFar = r->camera.GetZFar();
        r->params.eye = r->camera.GetEye();
        r->params.U = u;
        r->params.V = v;
        r->params.W = w;
        r->params.viewProjectionMatrix = r->camera.GetViewProjectionMatrix();
        commandList->writeBuffer(r->renderParamsBuffer, &r->params, sizeof(r->params));
        commandList->clearBufferUInt(r->pixelDebug, 0);
        commandList->clearBufferUInt(r->pixelPick, 0);
        return r->bindingGeneration;
    }

    // After the path tracer's dispatch: the next frame accumulates one more subframe.
    DONUT_API void Donut_RtxmgEndFrame(RtxmgDemo* r)
    {
        ++r->params.subFrameIndex;
    }

    // The blit's constants (the demo's, without DLSS: no separator, tone mapping ACES) at `exposure`.
    DONUT_API void Donut_RtxmgWriteBlitParams(RtxmgDemo* r, nvrhi::ICommandList* commandList, double exposure)
    {
        BlitParams blit;
        blit.m_blitDecodeMode = BlitDecodeMode::None;
        blit.m_tonemapOperator = TonemapOperator::Aces;
        blit.m_exposure = float(exposure);
        blit.m_zNear = r->camera.GetZNear();
        blit.m_zFar = r->camera.GetZFar();
        blit.m_separator = 1.0f;
        blit.m_autoExposureEnabled = 0;
        blit.m_autoExposureScale = 1.f;
        commandList->writeBuffer(r->blitParamsBuffer, &blit, sizeof(blit));
    }

    // What the path tracer and the blit bind, by `which` (RtxmgResource below); null for none.
    enum RtxmgResource
    {
        Rtxmg_LightingConstants = 0, Rtxmg_RenderParams, Rtxmg_InstanceBuffer, Rtxmg_MaterialBuffer,
        Rtxmg_EnvMapConditionalCdf, Rtxmg_EnvMapMarginalCdf, Rtxmg_EnvMapConditionalFunc, Rtxmg_EnvMapMarginalFunc,
        Rtxmg_ClusterShadingData, Rtxmg_ClusterVertexPositions, Rtxmg_ClusterVertexNormals, Rtxmg_SubdInstances,
        Rtxmg_Dummy, Rtxmg_HitResult, Rtxmg_PixelDebug, Rtxmg_TimeView, Rtxmg_BlitParams, Rtxmg_Exposure, Rtxmg_PixelPick,
    };

    DONUT_API nvrhi::IBuffer* Donut_RtxmgGetBuffer(RtxmgDemo* r, int which)
    {
        auto orDummy = [r](nvrhi::IBuffer* b) -> nvrhi::IBuffer* { return b ? b : r->dummy.Get(); };
        switch (which)
        {
        case Rtxmg_LightingConstants: return r->lightingConstants;
        case Rtxmg_RenderParams: return r->renderParamsBuffer;
        case Rtxmg_InstanceBuffer: return orDummy(r->scene ? r->scene->GetInstanceBuffer() : nullptr);
        case Rtxmg_MaterialBuffer: return orDummy(r->scene ? r->scene->GetMaterialBuffer() : nullptr);
        case Rtxmg_EnvMapConditionalCdf: return orDummy(r->envMap ? r->conditionalCdf.GetBuffer() : nullptr);
        case Rtxmg_EnvMapMarginalCdf: return orDummy(r->envMap ? r->marginalCdf.GetBuffer() : nullptr);
        case Rtxmg_EnvMapConditionalFunc: return orDummy(r->envMap ? r->conditionalFunc.GetBuffer() : nullptr);
        case Rtxmg_EnvMapMarginalFunc: return orDummy(r->envMap ? r->marginalFunc.GetBuffer() : nullptr);
        case Rtxmg_ClusterShadingData: return orDummy(r->accels ? r->accels->clusterShadingDataBuffer.GetBuffer() : nullptr);
        case Rtxmg_ClusterVertexPositions: return orDummy(r->accels ? r->accels->clusterVertexPositionsBuffer.GetBuffer() : nullptr);
        case Rtxmg_ClusterVertexNormals: return orDummy(r->accels ? r->accels->clusterVertexNormalsBuffer.GetBuffer() : nullptr);
        case Rtxmg_SubdInstances: return orDummy(r->subdInstances.GetBuffer());
        case Rtxmg_Dummy: return r->dummy;
        case Rtxmg_HitResult: return r->hitResult;
        case Rtxmg_PixelDebug: return r->pixelDebug.GetBuffer();
        case Rtxmg_TimeView: return r->timeView;
        case Rtxmg_BlitParams: return r->blitParamsBuffer;
        case Rtxmg_Exposure: return r->exposure;
        case Rtxmg_PixelPick: return r->pixelPick.GetBuffer();
        default: return nullptr;
        }
    }

    enum RtxmgTexture
    {
        Rtxmg_EnvMap = 0, Rtxmg_Accumulation, Rtxmg_Depth, Rtxmg_Normals, Rtxmg_Albedo, Rtxmg_Specular,
        Rtxmg_SpecularHitT, Rtxmg_Roughness, Rtxmg_Display,
    };

    DONUT_API nvrhi::ITexture* Donut_RtxmgGetTexture(RtxmgDemo* r, int which)
    {
        switch (which)
        {
        case Rtxmg_EnvMap: return r->envMap ? r->envMap->texture.Get() : r->commonPasses->m_BlackTexture.Get();
        case Rtxmg_Accumulation: return r->accumulation;
        case Rtxmg_Depth: return r->depth;
        case Rtxmg_Normals: return r->normals;
        case Rtxmg_Albedo: return r->albedo;
        case Rtxmg_Specular: return r->specular;
        case Rtxmg_SpecularHitT: return r->specularHitT;
        case Rtxmg_Roughness: return r->roughness;
        case Rtxmg_Display: return r->display;
        default: return nullptr;
        }
    }

    DONUT_API nvrhi::rt::IAccelStruct* Donut_RtxmgGetTlas(RtxmgDemo* r)
    {
        return r->tlas;
    }
    DONUT_API nvrhi::IBindingLayout* Donut_RtxmgGetBindlessLayout(RtxmgDemo* r)
    {
        return r->bindlessLayout;
    }
    DONUT_API nvrhi::IDescriptorTable* Donut_RtxmgGetDescriptorTable(RtxmgDemo* r)
    {
        return r->descriptorTable->GetDescriptorTable();
    }
    // 0: linear wrap (the path tracer's), 1: linear clamp (the blit's).
    DONUT_API nvrhi::ISampler* Donut_RtxmgGetSampler(RtxmgDemo* r, int which)
    {
        return which == 0 ? r->commonPasses->m_LinearWrapSampler.Get() : r->commonPasses->m_LinearClampSampler.Get();
    }

    // The path tracer's shader library: the cluster tessellation permutation (no vertex normals, no
    // cluster-LOD shading). Null if it doesn't load.
    DONUT_API nvrhi::IShaderLibrary* Donut_RtxmgGetPathTracerLibrary(RtxmgDemo* r)
    {
        if (!r->pathTracerLibrary)
        {
            std::vector<engine::ShaderMacro> macros = { { "VERTEX_NORMALS", "0" }, { "CLUSTER_LOD_SHADING", "0" } };
            r->pathTracerLibrary = r->shaderFactory->CreateShaderLibrary("rtxmg_demo/rtxmg_demo_path_tracer.hlsl", &macros);
        }
        return r->pathTracerLibrary;
    }

    // The blit's compute shader (rtxmg_demo/blit.hlsl). Null if it doesn't load.
    DONUT_API nvrhi::IShader* Donut_RtxmgGetBlitShader(RtxmgDemo* r)
    {
        if (!r->blitShader)
            r->blitShader = r->shaderFactory->CreateShader("rtxmg_demo/blit.hlsl", "main", nullptr, nvrhi::ShaderType::Compute);
        return r->blitShader;
    }
}

// C++ glue of the RTXDI examples (NVIDIA's RTXDI, github.com/NVIDIA-RTX/RTXDI), the part that doesn't depend on
// a sample's shaders: the ReSTIR DI context of RTXDI's runtime library (rtxdi_runtime in CMakeLists.txt,
// compiled from RTXDI_DIR in place) with its neighbor offsets, the scene's ray tracing acceleration structures
// and a float dump of a render target. What depends on the Minimal Sample's ShaderParameters.h (its resources,
// light preparation and constants) is core/rtxdi_minimal.cpp's. The values and the behaviour follow the
// sample's host; the code is this repository's. Built only with RTXDI_DIR.
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
#include <nvrhi/nvrhi.h>
#include <nvrhi/utils.h>

#include <Rtxdi/DI/ReSTIRDI.h>

#include "donut_api.h"

// core/donut_interop.cpp's app, its NVRHI device and its texture readback.
struct App;
extern "C"
{
    void* Donut_GetNvrhiDevice(App* app);
    int Donut_ReadTextureLevel(App* app, nvrhi::ITexture* texture, int mipLevel, void* dst, int byteSize);
}

// A scene's acceleration structures: a BLAS per mesh that has one and the TLAS over their instances.
// TypeScript holds it as an RtxdiSceneAccelStructsHandle until Rtxdi_DestroySceneAccelStructs.
struct RtxdiSceneAccelStructs
{
    std::unordered_map<const donut::engine::MeshInfo*, nvrhi::rt::AccelStructHandle> meshes;
    nvrhi::rt::AccelStructHandle topLevel;
};

namespace
{
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

    // --- Acceleration structures ---------------------------------------------------------------

    // The instance mask bit of each kind of content (the shaders' ray masks), by SceneContentFlags.
    struct InstanceMaskBits
    {
        donut::engine::SceneContentFlags content;
        uint32_t bit;
    };

    // A mesh's BLAS between its creation and its build: the build needs the description it was made from.
    struct PendingBlas
    {
        const donut::engine::MeshInfo* mesh;
        nvrhi::rt::AccelStructDesc desc;
        nvrhi::rt::AccelStructHandle handle;
    };

    // A skinned mesh (vertex joint weights) gets no BLAS: its vertices aren't the bind pose's.
    bool HasSkin(const donut::engine::MeshInfo& mesh)
    {
        return mesh.buffers->hasAttribute(donut::engine::VertexAttribute::JointWeights);
    }

    // One of the mesh's geometries as BLAS triangles (positions from the mesh's vertex buffer, 32-bit
    // indices), as Donut_BuildSceneAccelStructs makes them, but any-hit shaders run on it unless its
    // material is opaque.
    nvrhi::rt::GeometryDesc TrianglesOf(const donut::engine::MeshInfo& mesh, const donut::engine::MeshGeometry& geometry)
    {
        const donut::engine::BufferGroup& buffers = *mesh.buffers;
        const uint64_t positionsStart = buffers.getVertexBufferRange(donut::engine::VertexAttribute::Position).byteOffset;

        nvrhi::rt::GeometryTriangles triangles;
        triangles.setIndexBuffer(buffers.indexBuffer)
            .setIndexFormat(nvrhi::Format::R32_UINT)
            .setIndexOffset(uint64_t(mesh.indexOffset + geometry.indexOffsetInMesh) * sizeof(uint32_t))
            .setIndexCount(geometry.numIndices)
            .setVertexBuffer(buffers.vertexBuffer)
            .setVertexFormat(nvrhi::Format::RGB32_FLOAT)
            .setVertexStride(sizeof(donut::math::float3))
            .setVertexOffset(positionsStart + uint64_t(mesh.vertexOffset + geometry.vertexOffsetInMesh) * sizeof(donut::math::float3))
            .setVertexCount(geometry.numVertices);

        const bool opaque = geometry.material->domain == donut::engine::MaterialDomain::Opaque;
        return nvrhi::rt::GeometryDesc()
            .setTriangles(triangles)
            .setFlags(opaque ? nvrhi::rt::GeometryFlags::Opaque : nvrhi::rt::GeometryFlags::None);
    }

    // The BLAS of a mesh: its geometries, traced fast; compactable unless it has a skin (only static meshes).
    nvrhi::rt::AccelStructDesc BlasDescOf(const donut::engine::MeshInfo& mesh)
    {
        nvrhi::rt::AccelStructDesc desc;
        desc.setDebugName(mesh.name).setIsTopLevel(false).setTrackLiveness(false);
        for (const auto& geometry : mesh.geometries)
            desc.addBottomLevelGeometry(TrianglesOf(mesh, *geometry));
        desc.buildFlags = mesh.skinPrototype
            ? nvrhi::rt::AccelStructBuildFlags::PreferFastTrace
            : nvrhi::rt::AccelStructBuildFlags::PreferFastTrace | nvrhi::rt::AccelStructBuildFlags::AllowCompaction;
        return desc;
    }

    // An instance's TLAS entry: the mask bits of the content it has, no back-face culling when any of its
    // materials is double-sided, and its instance index as the ID the shaders read.
    nvrhi::rt::InstanceDesc InstanceOf(const donut::engine::MeshInstance& instance, nvrhi::rt::IAccelStruct* blas,
        const InstanceMaskBits (&maskBits)[3])
    {
        nvrhi::rt::InstanceDesc desc;
        desc.bottomLevelAS = blas;
        desc.instanceID = uint32_t(instance.GetInstanceIndex());

        uint32_t mask = 0;
        for (const InstanceMaskBits& entry : maskBits)
        {
            if ((instance.GetContentFlags() & entry.content) != 0)
                mask |= entry.bit;
        }
        desc.instanceMask = mask;

        const auto& geometries = instance.GetMesh()->geometries;
        const bool doubleSided = std::any_of(geometries.begin(), geometries.end(),
            [](const auto& geometry) { return geometry->material->doubleSided; });
        desc.flags = doubleSided ? nvrhi::rt::InstanceFlags::TriangleCullDisable : nvrhi::rt::InstanceFlags::None;

        if (const donut::engine::SceneGraphNode* node = instance.GetNode())
            donut::math::affineToColumnMajor(node->GetLocalToWorldTransformFloat(), desc.transform);
        return desc;
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
        if (!context)
        {
            donut::log::error("Rtxdi_SetFrameIndex: needs a context");
            return;
        }
        context->SetFrameIndex(uint32_t(frameIndex));
    }

    // The context's neighbor offsets (RTXDI's FillNeighborOffsetBuffer: two signed normalized bytes each) written
    // into the buffer on the command list.
    DONUT_API void Rtxdi_InitializeNeighborOffsets(rtxdi::ReSTIRDIContext* context, nvrhi::ICommandList* commandList, nvrhi::IBuffer* buffer)
    {
        if (!context || !commandList || !buffer)
        {
            donut::log::error("Rtxdi_InitializeNeighborOffsets: needs a context, a command list and a buffer");
            return;
        }
        const uint32_t count = context->GetStaticParameters().NeighborOffsetCount;
        std::vector<uint8_t> offsets(size_t(count) * 2);
        if (offsets.size() > buffer->getDesc().byteSize)
        {
            donut::log::error("Rtxdi_InitializeNeighborOffsets: the buffer is smaller than the context's %u offsets", count);
            return;
        }
        rtxdi::FillNeighborOffsetBuffer(offsets.data(), count);
        commandList->writeBuffer(buffer, offsets.data(), offsets.size());
    }

    // The scene's acceleration structures, recorded into an open command list (BLASes, then the TLAS; NVRHI
    // orders the TLAS build after them). Every acceleration structure is created before any build is recorded,
    // so a failure leaves the command list as it was. The three masks are the instance mask bits of opaque,
    // alpha tested and blended content (the shaders' ray masks).
    DONUT_API RtxdiSceneAccelStructs* Rtxdi_BuildSceneAccelStructs(App* app, nvrhi::ICommandList* commandList, donut::engine::Scene* scene,
        int opaqueMask, int alphaTestedMask, int transparentMask)
    {
        if (!app || !commandList || !scene || !scene->GetSceneGraph())
        {
            donut::log::error("Rtxdi_BuildSceneAccelStructs: needs an app, a command list and a loaded scene");
            return nullptr;
        }
        nvrhi::IDevice* device = static_cast<nvrhi::IDevice*>(Donut_GetNvrhiDevice(app));
        const auto& sceneGraph = scene->GetSceneGraph();
        const InstanceMaskBits maskBits[3] = {
            { donut::engine::SceneContentFlags::OpaqueMeshes, uint32_t(opaqueMask) },
            { donut::engine::SceneContentFlags::AlphaTestedMeshes, uint32_t(alphaTestedMask) },
            { donut::engine::SceneContentFlags::BlendedMeshes, uint32_t(transparentMask) },
        };

        // Created first, built after.
        std::vector<PendingBlas> pending;
        for (const auto& mesh : sceneGraph->GetMeshes())
        {
            if (HasSkin(*mesh))
                continue;
            PendingBlas blas{ mesh.get(), BlasDescOf(*mesh), nullptr };
            blas.handle = device->createAccelStruct(blas.desc);
            if (!blas.handle)
            {
                donut::log::error("Rtxdi_BuildSceneAccelStructs: the BLAS of %s couldn't be created", mesh->name.c_str());
                return nullptr;
            }
            pending.push_back(std::move(blas));
        }

        auto accelStructs = std::make_unique<RtxdiSceneAccelStructs>();
        for (const PendingBlas& blas : pending)
            accelStructs->meshes.emplace(blas.mesh, blas.handle);

        // Instances whose mesh has no BLAS are left out.
        std::vector<nvrhi::rt::InstanceDesc> instances;
        for (const auto& instance : sceneGraph->GetMeshInstances())
        {
            const auto found = accelStructs->meshes.find(instance->GetMesh().get());
            if (found != accelStructs->meshes.end())
                instances.push_back(InstanceOf(*instance, found->second, maskBits));
        }

        const size_t maxInstances = std::max<size_t>(sceneGraph->GetMeshInstances().size(), 1);
        accelStructs->topLevel = device->createAccelStruct(nvrhi::rt::AccelStructDesc()
            .setDebugName("RTXDI scene TLAS")
            .setIsTopLevel(true)
            .setTopLevelMaxInstances(maxInstances)
            .setBuildFlags(nvrhi::rt::AccelStructBuildFlags::AllowUpdate));
        if (!accelStructs->topLevel)
        {
            donut::log::error("Rtxdi_BuildSceneAccelStructs: the TLAS couldn't be created");
            return nullptr;
        }

        for (const PendingBlas& blas : pending)
            nvrhi::utils::BuildBottomLevelAccelStruct(commandList, blas.handle, blas.desc);
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

    // The texture as width, height (int32) and width x height RGBA float32 pixels, top row first.
    DONUT_API int Rtxdi_SaveTextureRGBA32F(App* app, nvrhi::ITexture* texture, const char* path)
    {
        if (!app || !texture || !path)
        {
            donut::log::error("Rtxdi_SaveTextureRGBA32F: needs an app, a texture and a path");
            return 0;
        }
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

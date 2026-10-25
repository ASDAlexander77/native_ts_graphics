// C++ helpers of the rtxcr_pathtracer example (NVIDIA's RTX Character Rendering pathtracer sample,
// github.com/NVIDIA-RTX/RTXCR): the hair curves of a loaded scene tessellated into the geometry the
// ray tracer traces (polytubes, DOTS or linear swept spheres), and the scene's acceleration
// structures over it. They work on Donut's scene objects (mesh buffers, mesh instances), which
// TypeScript can't reach; the sample's CurveTessellation and AccelerationStructure classes, here as
// one. Built only with RTXCR_DIR (CMakeLists.txt), which also puts its libraries on the include path.
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
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include <donut/core/math/math.h>
#include <donut/engine/DescriptorTableManager.h>
#include <donut/engine/Scene.h>
#include <donut/engine/SceneGraph.h>
#include <donut/render/SkyPass.h>
#include <nvrhi/common/misc.h>
#include <nvrhi/nvrhi.h>
#include <nvrhi/utils.h>
#include <rtxcr/geometry/include/CurveTessellation.h>

// donut/shaders/sky_cb.h is shared with HLSL: its float3 is Donut's.
using namespace donut::math;
#include <donut/shaders/sky_cb.h>

#include "donut_api.h"

namespace
{
    using namespace donut::engine;
    namespace dm = donut::math;

    // The sample's TessellationType (Curve/CurveTessellation.h).
    enum TessellationType : int
    {
        Polytube = 0,
        DisjointOrthogonalTriangleStrip = 1,
        LinearSweptSphere = 2,
        TessellationTypeCount = 3
    };

    // RTXCR_CURVE_POLYTUBE_ORDER in the sample's shared/shared.h.
    constexpr uint32_t POLYTUBE_ORDER = 3;

    struct RtxcrScene
    {
        nvrhi::IDevice* device = nullptr;
        Scene* scene = nullptr;
        DescriptorTableManager* descriptorTable = nullptr;
        float hairRadiusScale = 1.0f;
        int tessellationType = LinearSweptSphere;

        // Per mesh instance index, as the sample indexes them (the curve meshes' entries are filled).
        std::vector<std::vector<MeshGeometry>> originalGeometries;
        std::vector<std::vector<rtxcr::geometry::LineSegment>> lineSegments;

        struct MeshBuffersCache
        {
            std::shared_ptr<BufferGroup> buffers;
            std::vector<MeshGeometry> geometries;
        };
        std::vector<MeshBuffersCache> meshBuffersCache[TessellationTypeCount];

        nvrhi::rt::AccelStructHandle tlas;

        // The curve meshes' line segments by mesh name (the morph target passes' input).
        std::unordered_map<std::string, uint32_t> lineSegmentIndexByMeshName;

        // The morph target animation: per animated mesh its keyframes, the line segments they move,
        // the constants; the pass's shader and pipeline; the time it has run.
        struct MorphTargetResources
        {
            nvrhi::BufferHandle dataBuffer;
            nvrhi::BufferHandle lineSegmentsBuffer;
            nvrhi::BufferHandle constantBuffer;
            uint32_t vertexSize = 0;
        };
        std::unordered_map<const MeshInfo*, MorphTargetResources> morphTargets;
        // The animated meshes' two vertex buffers: the hit shaders read the one the frame's parity picks
        // (their bindless descriptors are consecutive: the mesh's, then the next one) and the previous
        // frame's, the other.
        struct DynamicVertexBuffers
        {
            nvrhi::BufferHandle buffers[2];
            std::shared_ptr<DescriptorHandle> secondDescriptor;
        };
        std::unordered_map<const BufferGroup*, DynamicVertexBuffers> dynamicVertexBuffers;
        nvrhi::BufferHandle morphTargetMask;
        nvrhi::ShaderHandle morphShader;
        nvrhi::BindingLayoutHandle morphLayout;
        nvrhi::ComputePipelineHandle morphPipeline;
        float totalTime = 0.0f;
        float prevAnimationTimestampPerFrame = 0.0f;
    };

    // The sample's LineSegment (shared/shared.h) as the shaders read it: 48 bytes.
    struct GpuLineSegment
    {
        int32_t geometryIndex;
        float pad0[3];
        float point0[3];
        float radius0;
        float point1[3];
        float radius1;
    };
    static_assert(sizeof(GpuLineSegment) == 48, "LineSegment layout");

    // MorphTargetConstants (shared/shared.h).
    struct GpuMorphTargetConstants
    {
        int32_t vertexCount;
        float lerpWeight;
        float prevLerpWeight;
        float pad0;
    };

    bool isNear(float a, float b)
    {
        return std::fabs(a - b) < 1e-5f;
    }

    // Splits each curve mesh into line segments (the tessellations' input), a virtual geometry
    // index per run of connected segments for line lists.
    void convertCurveLineStripsToLineSegments(RtxcrScene& s, const std::vector<std::shared_ptr<MeshInstance>>& meshInstances)
    {
        s.lineSegments.resize(meshInstances.size());

        for (uint32_t meshIndex = 0; meshIndex < meshInstances.size(); ++meshIndex)
        {
            const auto& mesh = meshInstances[meshIndex]->GetMesh();
            if (!mesh->IsCurve())
                continue;
            s.lineSegmentIndexByMeshName[mesh->name] = meshIndex;

            const auto& indices = mesh->buffers->indexData;
            const auto& positions = mesh->buffers->positionData;
            const auto& radius = mesh->buffers->radiusData;
            const auto& texCoord1 = mesh->buffers->texcoord1Data;

            const auto& geometryCache = s.originalGeometries[meshIndex];
            uint32_t virtualGeometryIndex = 0;
            for (uint32_t geometryIndex = 0; geometryIndex < mesh->geometries.size(); ++geometryIndex)
            {
                const auto& cached = geometryCache[geometryIndex];
                auto& geometry = mesh->geometries[geometryIndex];

                const uint32_t indexStep = (geometry->type == MeshGeometryPrimitiveType::Lines) ? 2 : 1;
                for (uint32_t index = 0; index < cached.numIndices - 1; index += indexStep)
                {
                    const uint32_t lineIndexStart = indices[index + cached.indexOffsetInMesh] + cached.indexOffsetInMesh;
                    const uint32_t lineIndexEnd = indices[index + 1 + cached.indexOffsetInMesh] + cached.indexOffsetInMesh;

                    const auto& posStart = positions[lineIndexStart];
                    const auto& posEnd = positions[lineIndexEnd];

                    rtxcr::geometry::LineSegment segment;
                    segment.vertices[0].position[0] = posStart.x;
                    segment.vertices[0].position[1] = posStart.y;
                    segment.vertices[0].position[2] = posStart.z;
                    segment.vertices[0].radius = radius[lineIndexStart] * s.hairRadiusScale;
                    segment.vertices[1].position[0] = posEnd.x;
                    segment.vertices[1].position[1] = posEnd.y;
                    segment.vertices[1].position[2] = posEnd.z;
                    segment.vertices[1].radius = radius[lineIndexEnd] * s.hairRadiusScale;

                    if (texCoord1.data())
                    {
                        const auto& uvStart = texCoord1[lineIndexStart];
                        const auto& uvEnd = texCoord1[lineIndexEnd];
                        segment.vertices[0].texCoord[0] = uvStart.x;
                        segment.vertices[0].texCoord[1] = uvStart.y;
                        segment.vertices[1].texCoord[0] = uvEnd.x;
                        segment.vertices[1].texCoord[1] = uvEnd.y;
                    }

                    // Line lists have no strip structure: a segment that doesn't start where the
                    // previous one ended starts a new geometry.
                    if (geometry->type == MeshGeometryPrimitiveType::Lines)
                    {
                        if (!s.lineSegments[meshIndex].empty())
                        {
                            const auto& prevEnd = s.lineSegments[meshIndex].back().vertices[1];
                            if (!isNear(posStart.x, prevEnd.position[0]) || !isNear(posStart.y, prevEnd.position[1]) ||
                                !isNear(posStart.z, prevEnd.position[2]))
                            {
                                ++virtualGeometryIndex;
                            }
                        }
                        segment.geometryIndex = virtualGeometryIndex;
                    }
                    else
                    {
                        segment.geometryIndex = geometryIndex;
                    }

                    s.lineSegments[meshIndex].push_back(segment);
                }
            }
        }
    }

    void copyToMeshBuffersCache(RtxcrScene& s, int type, const std::shared_ptr<BufferGroup>& meshBuffers,
        const std::vector<std::shared_ptr<MeshGeometry>>& geometries)
    {
        RtxcrScene::MeshBuffersCache cache;
        cache.buffers = std::make_shared<BufferGroup>();
        cache.buffers->vertexBufferRanges = meshBuffers->vertexBufferRanges;
        cache.buffers->indexData = meshBuffers->indexData;
        cache.buffers->positionData = meshBuffers->positionData;
        cache.buffers->normalData = meshBuffers->normalData;
        cache.buffers->tangentData = meshBuffers->tangentData;
        cache.buffers->texcoord1Data = meshBuffers->texcoord1Data;
        cache.buffers->radiusData = meshBuffers->radiusData;

        cache.geometries.reserve(geometries.size());
        for (const auto& geometry : geometries)
            cache.geometries.push_back(*geometry);

        s.meshBuffersCache[type].push_back(cache);
    }

    // Tessellates every curve mesh into `type` (triangle tubes, DOTS or LSS), into the mesh's CPU
    // buffers, and caches the result for replacingSceneMesh.
    void tessellate(RtxcrScene& s, int type, const std::vector<std::shared_ptr<MeshInstance>>& meshInstances)
    {
        for (uint32_t meshIndex = 0; meshIndex < meshInstances.size(); ++meshIndex)
        {
            auto& mesh = meshInstances[meshIndex]->GetMesh();
            auto& meshBuffers = mesh->buffers;
            if (!mesh->IsCurve())
                continue;

            const auto& lineSegments = s.lineSegments[meshIndex];
            const auto& geometryCache = s.originalGeometries[meshIndex];

            // Vertices (and indices) per segment: a face is two triangles, 3 vertices each.
            uint32_t numVerticesPerSegment = 0;
            if (type == Polytube)
            {
                mesh->type = MeshType::CurvePolytubes;
                numVerticesPerSegment = POLYTUBE_ORDER * 2 * 3;
            }
            else if (type == DisjointOrthogonalTriangleStrip)
            {
                mesh->type = MeshType::CurveDisjointOrthogonalTriangleStrips;
                numVerticesPerSegment = 4 * 3;
            }
            else
            {
                mesh->type = MeshType::CurveLinearSweptSpheres;
            }

            const uint32_t totalVertices = static_cast<uint32_t>(lineSegments.size()) *
                (type == LinearSweptSphere ? 2 : numVerticesPerSegment);
            meshBuffers->indexData.resize(type == LinearSweptSphere ? 0 : totalVertices);
            meshBuffers->positionData.resize(totalVertices);
            meshBuffers->normalData.resize(type == LinearSweptSphere ? 0 : totalVertices);
            meshBuffers->tangentData.resize(type == LinearSweptSphere ? 0 : totalVertices);
            meshBuffers->texcoord1Data.resize(type == LinearSweptSphere ? 0 : totalVertices);
            meshBuffers->radiusData.resize(totalVertices);

            uint32_t indexOffsetInMesh = 0;
            uint32_t vertexOffsetInMesh = 0;
            uint32_t globalIndex = 0;

            for (uint32_t geometryIndex = 0; geometryIndex < mesh->geometries.size(); ++geometryIndex)
            {
                const auto& cached = geometryCache[geometryIndex];
                auto& geometry = mesh->geometries[geometryIndex];

                // Segments of the geometry: a line list has two indices per segment, a strip one more
                // index than segments.
                const uint32_t segmentCount = (geometry->type == MeshGeometryPrimitiveType::Lines) ?
                    cached.numIndices / 2 : cached.numIndices - 1;

                if (type == LinearSweptSphere)
                {
                    const uint32_t geometryNumVertices = segmentCount * 2;
                    geometry->numIndices = 0;
                    geometry->numVertices = geometryNumVertices;
                    geometry->indexOffsetInMesh = 0;
                    geometry->vertexOffsetInMesh = vertexOffsetInMesh;

                    globalIndex = rtxcr::geometry::convertToLinearSweptSpheres(lineSegments, segmentCount,
                        reinterpret_cast<float*>(meshBuffers->positionData.data()), meshBuffers->radiusData.data(), globalIndex);

                    vertexOffsetInMesh += geometryNumVertices;
                    continue;
                }

                const uint32_t geometryNumIndices = segmentCount * numVerticesPerSegment;
                const uint32_t geometryNumVertices = segmentCount * numVerticesPerSegment;
                geometry->numIndices = geometryNumIndices;
                geometry->numVertices = geometryNumVertices;
                geometry->indexOffsetInMesh = indexOffsetInMesh;
                geometry->vertexOffsetInMesh = vertexOffsetInMesh;

                if (type == Polytube)
                {
                    globalIndex = rtxcr::geometry::convertToTrianglePolyTubes(lineSegments, segmentCount,
                        meshBuffers->indexData.data(), reinterpret_cast<float*>(meshBuffers->positionData.data()),
                        meshBuffers->normalData.data(), meshBuffers->tangentData.data(),
                        reinterpret_cast<float*>(meshBuffers->texcoord1Data.data()), meshBuffers->radiusData.data(), globalIndex);
                }
                else
                {
                    globalIndex = rtxcr::geometry::convertToDisjointOrthogonalTriangleStrips(lineSegments, segmentCount,
                        meshBuffers->indexData.data(), reinterpret_cast<float*>(meshBuffers->positionData.data()),
                        meshBuffers->normalData.data(), meshBuffers->tangentData.data(),
                        reinterpret_cast<float*>(meshBuffers->texcoord1Data.data()), meshBuffers->radiusData.data(), globalIndex);
                }

                indexOffsetInMesh += geometryNumIndices;
                vertexOffsetInMesh += geometryNumVertices;
            }

            copyToMeshBuffersCache(s, type, meshBuffers, mesh->geometries);
        }
    }

    // The states of a vertex buffer between the morph target passes: read by shaders (bindless) and as
    // acceleration structure input.
    const nvrhi::ResourceStates VERTEX_BUFFER_REST_STATE = nvrhi::ResourceStates::VertexBuffer |
        nvrhi::ResourceStates::ShaderResource | nvrhi::ResourceStates::AccelStructBuildInput;

    // The sample's CreateDynamicVertexBuffer: the mesh's vertex buffer, made as Scene::CreateMeshBuffers
    // does but writable by the morph target pass (and registered in the descriptor table); it moves
    // the curve's CPU vertex data in.
    void createDynamicVertexBuffer(RtxcrScene& s, BufferGroup* meshBuffers, const std::string& meshName)
    {
        auto appendBufferRange = [](nvrhi::BufferRange& range, size_t size, uint64_t& currentBufferSize) {
            range.byteOffset = currentBufferSize;
            range.byteSize = nvrhi::align(size, size_t(16));
            currentBufferSize += range.byteSize;
        };

        nvrhi::BufferDesc bufferDesc;
        bufferDesc.isVertexBuffer = true;
        bufferDesc.byteSize = 0;
        bufferDesc.debugName = "Dynamic VertexBuffer - " + meshName;
        bufferDesc.canHaveTypedViews = true;
        bufferDesc.canHaveRawViews = true;
        bufferDesc.isAccelStructBuildInput = true;
        bufferDesc.canHaveUAVs = true;

        // The vertex attributes, in the order Scene::CreateMeshBuffers lays them out.
        struct Attribute
        {
            VertexAttribute attribute;
            const void* data;
            size_t byteSize;
        };
        const Attribute attributes[] = {
            { VertexAttribute::Position, meshBuffers->positionData.data(), meshBuffers->positionData.size() * sizeof(meshBuffers->positionData[0]) },
            { VertexAttribute::Normal, meshBuffers->normalData.data(), meshBuffers->normalData.size() * sizeof(meshBuffers->normalData[0]) },
            { VertexAttribute::Tangent, meshBuffers->tangentData.data(), meshBuffers->tangentData.size() * sizeof(meshBuffers->tangentData[0]) },
            { VertexAttribute::TexCoord1, meshBuffers->texcoord1Data.data(), meshBuffers->texcoord1Data.size() * sizeof(meshBuffers->texcoord1Data[0]) },
            { VertexAttribute::TexCoord2, meshBuffers->texcoord2Data.data(), meshBuffers->texcoord2Data.size() * sizeof(meshBuffers->texcoord2Data[0]) },
            { VertexAttribute::JointWeights, meshBuffers->weightData.data(), meshBuffers->weightData.size() * sizeof(meshBuffers->weightData[0]) },
            { VertexAttribute::JointIndices, meshBuffers->jointData.data(), meshBuffers->jointData.size() * sizeof(meshBuffers->jointData[0]) },
            { VertexAttribute::CurveRadius, meshBuffers->radiusData.data(), meshBuffers->radiusData.size() * sizeof(meshBuffers->radiusData[0]) },
        };
        for (const auto& attribute : attributes)
        {
            if (attribute.byteSize > 0)
                appendBufferRange(meshBuffers->getVertexBufferRange(attribute.attribute), attribute.byteSize, bufferDesc.byteSize);
        }

        // Both buffers start with the mesh's vertices; the second one's descriptor follows the first's.
        auto& dynamicBuffers = s.dynamicVertexBuffers[meshBuffers];
        auto& buffers = dynamicBuffers.buffers;
        buffers[0] = s.device->createBuffer(bufferDesc);
        bufferDesc.debugName = "Dynamic VertexBuffer - " + meshName + " 1";
        buffers[1] = s.device->createBuffer(bufferDesc);
        meshBuffers->vertexBuffer = buffers[0];
        if (s.descriptorTable)
        {
            // Release the old pair's descriptors first, so these two are consecutive free ones.
            meshBuffers->vertexBufferDescriptor = nullptr;
            dynamicBuffers.secondDescriptor = nullptr;
            meshBuffers->vertexBufferDescriptor = std::make_shared<DescriptorHandle>(
                s.descriptorTable->CreateDescriptorHandle(nvrhi::BindingSetItem::RawBuffer_SRV(0, buffers[0])));
            dynamicBuffers.secondDescriptor = std::make_shared<DescriptorHandle>(
                s.descriptorTable->CreateDescriptorHandle(nvrhi::BindingSetItem::RawBuffer_SRV(0, buffers[1])));
            assert(dynamicBuffers.secondDescriptor->Get() == meshBuffers->vertexBufferDescriptor->Get() + 1);
        }

        nvrhi::CommandListHandle commandList = s.device->createCommandList();
        commandList->open();
        for (const auto& buffer : buffers)
        {
            commandList->beginTrackingBufferState(buffer, nvrhi::ResourceStates::Common);
            for (const auto& attribute : attributes)
            {
                if (attribute.byteSize == 0)
                    continue;
                const auto& range = meshBuffers->getVertexBufferRange(attribute.attribute);
                commandList->writeBuffer(buffer, attribute.data, range.byteSize, range.byteOffset);
            }
            commandList->setBufferState(buffer, VERTEX_BUFFER_REST_STATE);
        }
        commandList->commitBarriers();
        commandList->close();
        s.device->executeCommandList(commandList);
        s.device->waitForIdle();

        std::vector<dm::float3>().swap(meshBuffers->positionData);
        std::vector<uint32_t>().swap(meshBuffers->normalData);
        std::vector<uint32_t>().swap(meshBuffers->tangentData);
        std::vector<dm::float2>().swap(meshBuffers->texcoord1Data);
        std::vector<dm::float2>().swap(meshBuffers->texcoord2Data);
        std::vector<dm::float4>().swap(meshBuffers->weightData);
        std::vector<dm::vector<uint16_t, 4>>().swap(meshBuffers->jointData);
        std::vector<float>().swap(meshBuffers->radiusData);
    }

    // Makes the scene's curve meshes the cached tessellation of `type`, their GPU buffers to be
    // created again.
    void replacingSceneMesh(RtxcrScene& s, int type, const std::vector<std::shared_ptr<MeshInstance>>& meshInstances)
    {
        const auto& cache = s.meshBuffersCache[type];
        uint32_t curveIndex = 0;
        for (uint32_t meshIndex = 0; meshIndex < meshInstances.size(); ++meshIndex)
        {
            auto& mesh = meshInstances[meshIndex]->GetMesh();
            auto& meshBuffers = mesh->buffers;
            if (!mesh->IsCurve())
                continue;

            // The geometries keep the scene's indices (the tessellations' are per mesh).
            for (uint32_t geometryIndex = 0; geometryIndex < mesh->geometries.size(); ++geometryIndex)
            {
                const int globalGeometryIndex = mesh->geometries[geometryIndex]->globalGeometryIndex;
                *mesh->geometries[geometryIndex] = cache[curveIndex].geometries[geometryIndex];
                mesh->geometries[geometryIndex]->globalGeometryIndex = globalGeometryIndex;
            }

            mesh->type = type == Polytube ? MeshType::CurvePolytubes :
                type == DisjointOrthogonalTriangleStrip ? MeshType::CurveDisjointOrthogonalTriangleStrips :
                MeshType::CurveLinearSweptSpheres;

            const auto& src = cache[curveIndex].buffers;
            meshBuffers->vertexBufferRanges = src->vertexBufferRanges;
            meshBuffers->indexData = src->indexData;
            meshBuffers->positionData = src->positionData;
            meshBuffers->normalData = src->normalData;
            meshBuffers->tangentData = src->tangentData;
            meshBuffers->texcoord1Data = src->texcoord1Data;
            meshBuffers->radiusData = src->radiusData;

            meshBuffers->indexBuffer = nullptr;
            meshBuffers->vertexBuffer = nullptr;
            meshBuffers->instanceBuffer = nullptr;

            // Morph target animation writes the vertices on the GPU.
            if (!meshBuffers->morphTargetData.empty())
                createDynamicVertexBuffer(s, meshBuffers.get(), mesh->name);

            ++curveIndex;
        }
    }

    // The sample's GetMeshBlasDesc: triangles, or linear swept spheres for LSS curves.
    void getMeshBlasDesc(const MeshInfo& mesh, nvrhi::rt::AccelStructDesc& blasDesc, bool isUpdate = false)
    {
        blasDesc.isTopLevel = false;
        blasDesc.debugName = mesh.name;
        blasDesc.bottomLevelGeometries.resize(mesh.geometries.size());

        for (uint32_t geometryIndex = 0; geometryIndex < mesh.geometries.size(); ++geometryIndex)
        {
            const auto& geometry = mesh.geometries[geometryIndex];
            nvrhi::rt::GeometryDesc geometryDesc;

            if (mesh.type != MeshType::CurveLinearSweptSpheres)
            {
                auto& triangles = geometryDesc.geometryData.triangles;
                triangles.indexBuffer = mesh.buffers->indexBuffer;
                triangles.indexOffset = (mesh.indexOffset + geometry->indexOffsetInMesh) * sizeof(uint32_t);
                triangles.indexFormat = nvrhi::Format::R32_UINT;
                triangles.indexCount = geometry->numIndices;
                triangles.vertexBuffer = mesh.buffers->vertexBuffer;
                triangles.vertexOffset = (mesh.vertexOffset + geometry->vertexOffsetInMesh) * sizeof(dm::float3) +
                    mesh.buffers->getVertexBufferRange(VertexAttribute::Position).byteOffset;
                triangles.vertexFormat = nvrhi::Format::RGB32_FLOAT;
                triangles.vertexStride = sizeof(dm::float3);
                triangles.vertexCount = geometry->numVertices;
                geometryDesc.geometryType = nvrhi::rt::GeometryType::Triangles;
            }
            else
            {
                auto& lss = geometryDesc.geometryData.lss;
                lss.vertexBuffer = mesh.buffers->vertexBuffer;
                lss.vertexPositionOffset = (mesh.vertexOffset + geometry->vertexOffsetInMesh) * sizeof(dm::float3) +
                    mesh.buffers->getVertexBufferRange(VertexAttribute::Position).byteOffset;
                lss.vertexPositionFormat = nvrhi::Format::RGB32_FLOAT;
                lss.vertexPositionStride = sizeof(dm::float3);
                lss.vertexRadiusOffset = (mesh.vertexOffset + geometry->vertexOffsetInMesh) * sizeof(float) +
                    mesh.buffers->getVertexBufferRange(VertexAttribute::CurveRadius).byteOffset;
                lss.vertexRadiusFormat = nvrhi::Format::R32_FLOAT;
                lss.vertexRadiusStride = sizeof(float);
                lss.primitiveCount = geometry->numVertices / 2;
                lss.vertexCount = geometry->numVertices;
                lss.primitiveFormat = nvrhi::rt::GeometryLssPrimitiveFormat::List;
                lss.endcapMode = nvrhi::rt::GeometryLssEndcapMode::None;
                geometryDesc.geometryType = nvrhi::rt::GeometryType::Lss;
            }

            geometryDesc.flags = (geometry->material->domain != MaterialDomain::Opaque)
                ? nvrhi::rt::GeometryFlags::None
                : nvrhi::rt::GeometryFlags::Opaque;

            blasDesc.bottomLevelGeometries[geometryIndex] = geometryDesc;
        }

        if (mesh.isMorphTargetAnimationMesh)
        {
            blasDesc.buildFlags = nvrhi::rt::AccelStructBuildFlags::AllowUpdate | nvrhi::rt::AccelStructBuildFlags::PreferFastTrace;
            if (isUpdate)
                blasDesc.buildFlags = blasDesc.buildFlags | nvrhi::rt::AccelStructBuildFlags::PerformUpdate;
        }
        else if (mesh.skinPrototype)
        {
            blasDesc.buildFlags = nvrhi::rt::AccelStructBuildFlags::PreferFastTrace;
        }
        else
        {
            blasDesc.buildFlags = nvrhi::rt::AccelStructBuildFlags::PreferFastTrace | nvrhi::rt::AccelStructBuildFlags::AllowCompaction;
        }
    }
}

// The constant buffer layouts examples/rtxcr_pathtracer.ts writes, as the sample's headers (the
// checkout's shared/) have them; last, as the headers define macros (PI, ...) of their own.
#include <cstddef>
#include <shared/globalCb.h>
#include <shared/lightingCb.h>

static_assert(sizeof(GlobalConstants) == 448, "GlobalConstants: examples/rtxcr_pathtracer.ts's size");
static_assert(offsetof(GlobalConstants, enableAccumulation) == 32 && offsetof(GlobalConstants, enableDenoiser) == 44 &&
    offsetof(GlobalConstants, nrdHitDistanceParams) == 112 && offsetof(GlobalConstants, hairMode) == 128 &&
    offsetof(GlobalConstants, absorptionModel) == 160 && offsetof(GlobalConstants, enableSssTransmission) == 208 &&
    offsetof(GlobalConstants, sssTransmissionColor) == 272 && offsetof(GlobalConstants, forceLambertianBRDF) == 312 &&
    offsetof(GlobalConstants, skyParams) == 320 && offsetof(GlobalConstants, enableAnimation) == 432,
    "GlobalConstants: examples/rtxcr_pathtracer.ts's offsets");
static_assert(sizeof(ProceduralSkyShaderParameters) == 96, "the sky parameters: examples/rtxcr_pathtracer.ts's size");
static_assert(offsetof(LightingConstants, view) == 32 && MAX_LIGHTS == 8,
    "LightingConstants: examples/rtxcr_pathtracer.ts's layout");

extern "C"
{
    // Takes a scene loaded by Donut_LoadSceneWithDescriptorTableDeferred (its CPU mesh buffers still
    // there): tessellates its curves into all three representations, makes `tessellationType` (0
    // polytubes, 1 DOTS, 2 LSS) the scene's, and uploads the scene's buffers. hairRadiusScale scales
    // the curves' radii.
    DONUT_API RtxcrScene* Donut_RtxcrCreateScene(void* device, donut::engine::Scene* scene, donut::engine::DescriptorTableManager* descriptorTable,
        double hairRadiusScale, int tessellationType)
    {
        auto s = std::make_unique<RtxcrScene>();
        s->device = static_cast<nvrhi::IDevice*>(device);
        s->scene = scene;
        s->descriptorTable = descriptorTable;
        s->hairRadiusScale = static_cast<float>(hairRadiusScale);
        s->tessellationType = tessellationType;

        const auto& meshInstances = scene->GetSceneGraph()->GetMeshInstances();
        s->originalGeometries.resize(meshInstances.size());
        for (uint32_t meshIndex = 0; meshIndex < meshInstances.size(); ++meshIndex)
        {
            for (const auto& geometry : meshInstances[meshIndex]->GetMesh()->geometries)
                s->originalGeometries[meshIndex].push_back(*geometry);
        }

        convertCurveLineStripsToLineSegments(*s, meshInstances);
        tessellate(*s, Polytube, meshInstances);
        tessellate(*s, DisjointOrthogonalTriangleStrip, meshInstances);
        tessellate(*s, LinearSweptSphere, meshInstances);
        replacingSceneMesh(*s, tessellationType, meshInstances);

        scene->FinishedLoading(0);
        return s.release();
    }

    // Makes the scene's hair `type` (0 polytubes, 1 DOTS, 2 LSS) and uploads its buffers again. The morph
    // targets, bottom level structures and everything bound to the scene's buffers are the caller's to
    // make again (Donut_RtxcrCreateMorphTargets, Donut_RtxcrBuildAccelStructs). Returns 1 if it changed.
    DONUT_API int Donut_RtxcrSetTessellationType(RtxcrScene* s, int type, int frameIndex)
    {
        if (type == s->tessellationType || type < 0 || type >= TessellationTypeCount)
            return 0;

        s->device->waitForIdle();
        s->tessellationType = type;
        s->morphTargets.clear();
        s->morphPipeline = nullptr;
        s->morphLayout = nullptr;
        replacingSceneMesh(*s, type, s->scene->GetSceneGraph()->GetMeshInstances());
        s->scene->FinishedLoading(static_cast<uint32_t>(frameIndex));
        return 1;
    }

    DONUT_API void Donut_RtxcrDestroyScene(RtxcrScene* s)
    {
        delete s;
    }

    // Number of curve (hair) meshes, for logging.
    DONUT_API int Donut_RtxcrGetCurveMeshCount(RtxcrScene* s)
    {
        int count = 0;
        for (const auto& mesh : s->scene->GetSceneGraph()->GetMeshes())
            count += mesh->IsCurve() ? 1 : 0;
        return count;
    }

    // Creates the bottom level structures of the scene's meshes (all of them if rebuild, else the
    // missing ones) and the top level one over its instances, recorded into an open command list.
    DONUT_API void Donut_RtxcrBuildAccelStructs(RtxcrScene* s, nvrhi::ICommandList* commandList, bool rebuild)
    {
        auto* sceneGraph = s->scene->GetSceneGraph().get();

        for (const auto& mesh : sceneGraph->GetMeshes())
        {
            if (mesh->buffers->hasAttribute(VertexAttribute::JointWeights))
                continue;

            nvrhi::rt::AccelStructDesc blasDesc;
            getMeshBlasDesc(*mesh, blasDesc);

            // The morph target meshes' vertex buffers are not in a permanent state: they rest as
            // the shaders and structures read them.
            if (mesh->isMorphTargetAnimationMesh && mesh->buffers->vertexBuffer)
                commandList->beginTrackingBufferState(mesh->buffers->vertexBuffer, VERTEX_BUFFER_REST_STATE);

            if (rebuild || !mesh->accelStruct)
            {
                nvrhi::rt::AccelStructHandle accelStruct = s->device->createAccelStruct(blasDesc);
                if (!mesh->skinPrototype)
                    nvrhi::utils::BuildBottomLevelAccelStruct(commandList, accelStruct, blasDesc);
                mesh->accelStruct = accelStruct;
            }
        }

        const size_t instanceCount = sceneGraph->GetMeshInstances().size();
        if (!s->tlas || instanceCount > s->tlas->getDesc().topLevelMaxInstances)
        {
            nvrhi::rt::AccelStructDesc tlasDesc;
            tlasDesc.isTopLevel = true;
            tlasDesc.topLevelMaxInstances = instanceCount;
            tlasDesc.debugName = "Top Level Acceleration Struct";
            s->tlas = s->device->createAccelStruct(tlasDesc);
        }
    }

    // Builds the top level structure over the scene's current instances. Instance masks: 4 for
    // mirror (roughness 0) materials, 2 for emissive ones unless showEmissiveSurfaces, else 1.
    DONUT_API void Donut_RtxcrBuildTlas(RtxcrScene* s, nvrhi::ICommandList* commandList, bool showEmissiveSurfaces)
    {
        auto* sceneGraph = s->scene->GetSceneGraph().get();

        // Skinned meshes' structures are rebuilt every frame.
        for (const auto& skinnedInstance : sceneGraph->GetSkinnedMeshInstances())
        {
            commandList->setAccelStructState(skinnedInstance->GetMesh()->accelStruct, nvrhi::ResourceStates::AccelStructWrite);
            commandList->setBufferState(skinnedInstance->GetMesh()->buffers->vertexBuffer, nvrhi::ResourceStates::AccelStructBuildInput);
        }
        commandList->commitBarriers();
        for (const auto& skinnedInstance : sceneGraph->GetSkinnedMeshInstances())
        {
            nvrhi::rt::AccelStructDesc blasDesc;
            getMeshBlasDesc(*skinnedInstance->GetMesh(), blasDesc);
            nvrhi::utils::BuildBottomLevelAccelStruct(commandList, skinnedInstance->GetMesh()->accelStruct, blasDesc);
        }

        std::vector<nvrhi::rt::InstanceDesc> instances;
        for (const auto& instance : sceneGraph->GetMeshInstances())
        {
            nvrhi::rt::InstanceDesc instanceDesc;
            instanceDesc.bottomLevelAS = instance->GetMesh()->accelStruct;
            const dm::float3& emissiveColor = instance->GetMesh()->geometries[0]->material->emissiveColor;
            const float roughness = instance->GetMesh()->geometries[0]->material->roughness;
            if (roughness == 0)
                instanceDesc.instanceMask = 4;
            else if (!showEmissiveSurfaces && (emissiveColor.x > 0.0f || emissiveColor.y > 0.0f || emissiveColor.z > 0.0f))
                instanceDesc.instanceMask = 2;
            else
                instanceDesc.instanceMask = 1;
            instanceDesc.instanceID = instance->GetInstanceIndex();

            if (instance->GetMesh()->type == MeshType::CurveDisjointOrthogonalTriangleStrips)
                instanceDesc.setFlags(nvrhi::rt::InstanceFlags::TriangleCullDisable);

            auto node = instance->GetNode();
            dm::affineToColumnMajor(node->GetLocalToWorldTransformFloat(), instanceDesc.transform);
            instances.push_back(instanceDesc);
        }

        // Compacts the structures tagged for it whose original builds have finished.
        commandList->compactBottomLevelAccelStructs();
        commandList->buildTopLevelAccelStruct(s->tlas, instances.data(), instances.size());
    }

    // The sample's sky constants (GlobalConstants::skyParams, 96 bytes): Donut's procedural sky for
    // `sun` (a directional light) with the horizon in skyColor, the sample's own light and glow sizes,
    // and the ground in skyColor (skyType 0, a constant sky) or black (no sky); for the environment
    // map (skyType 2) the light's angular size is -1, the shader's mark of it.
    DONUT_API void Donut_RtxcrFillSkyParameters(RtxcrScene* s, donut::engine::Light* sun, double skyR, double skyG, double skyB, bool enableSky, int skyType, void* dst)
    {
        const dm::float3 skyColor = enableSky ? dm::float3(float(skyR), float(skyG), float(skyB)) : dm::float3(0.0f, 0.0f, 0.0f);

        donut::render::SkyParameters skyParams = {};
        skyParams.brightness = 1.0f;
        skyParams.horizonColor = skyColor;

        ProceduralSkyShaderParameters params = {};
        donut::render::SkyPass::FillShaderParameters(*static_cast<donut::engine::DirectionalLight*>(sun), skyParams, params);
        params.angularSizeOfLight = 0.02f;
        params.glowSize = 0.02f;
        params.skyColor = skyColor;
        if (!enableSky)
            params.groundColor = dm::float3(0.0f, 0.0f, 0.0f);
        else if (skyType == 0)
            params.groundColor = skyColor;
        else if (skyType == 2)
            params.angularSizeOfLight = -1.0f;
        std::memcpy(dst, &params, sizeof(params));
    }

    // The sample's CreateMorphTargetBuffers: for each mesh with morph targets (the animated hair), its
    // keyframes, line segments and constants for the animation pass, and for every mesh instance a uint
    // that says whether its mesh has them (the shaders' t_instanceMorphTargetMetaDataBuffer). Returns
    // the number of morph target meshes.
    DONUT_API int Donut_RtxcrCreateMorphTargets(RtxcrScene* s)
    {
        s->morphTargets.clear();
        s->totalTime = 0.0f;
        s->prevAnimationTimestampPerFrame = 0.0f;

        auto createBuffer = [&](size_t byteSize, uint32_t stride, const std::string& name, bool raw) {
            nvrhi::BufferDesc bufferDesc;
            bufferDesc.byteSize = byteSize;
            bufferDesc.structStride = stride;
            bufferDesc.debugName = name;
            bufferDesc.canHaveTypedViews = true;
            bufferDesc.canHaveRawViews = raw;
            bufferDesc.initialState = nvrhi::ResourceStates::ShaderResource | nvrhi::ResourceStates::CopyDest;
            return s->device->createBuffer(bufferDesc);
        };

        nvrhi::CommandListHandle commandList = s->device->createCommandList();
        int count = 0;
        for (const auto& mesh : s->scene->GetSceneGraph()->GetMeshes())
        {
            const auto found = s->lineSegmentIndexByMeshName.find(mesh->name);
            if (!mesh->isMorphTargetAnimationMesh || found == s->lineSegmentIndexByMeshName.end() ||
                s->lineSegments[found->second].empty())
                continue;
            const auto& lineSegments = s->lineSegments[found->second];

            RtxcrScene::MorphTargetResources resources;
            const std::string name = std::to_string(mesh->globalMeshIndex);

            commandList->open();

            // All the keyframes in one buffer, which the pass binds two ranges of.
            const auto& keyframes = mesh->buffers->morphTargetData;
            const size_t keyframesSize = sizeof(dm::float4) * keyframes.size();
            resources.dataBuffer = createBuffer(keyframesSize, sizeof(dm::float4), "Morph Target Data Buffer " + name, true);
            commandList->beginTrackingBufferState(resources.dataBuffer, nvrhi::ResourceStates::Common);
            commandList->writeBuffer(resources.dataBuffer, keyframes.data(), keyframesSize);
            commandList->setPermanentBufferState(resources.dataBuffer, nvrhi::ResourceStates::ShaderResource);

            // The vertices the animation makes, per segment, by the tessellation.
            if (s->tessellationType == Polytube)
                resources.vertexSize = static_cast<uint32_t>(lineSegments.size()) * POLYTUBE_ORDER * 6;
            else if (s->tessellationType == DisjointOrthogonalTriangleStrip)
                resources.vertexSize = static_cast<uint32_t>(lineSegments.size()) * 3 * 4;
            else
                resources.vertexSize = static_cast<uint32_t>(lineSegments.size()) * 2;

            std::vector<GpuLineSegment> segments(lineSegments.size());
            for (size_t i = 0; i < lineSegments.size(); ++i)
            {
                const auto& segment = lineSegments[i];
                GpuLineSegment& gpu = segments[i];
                std::memset(&gpu, 0, sizeof(gpu));
                gpu.geometryIndex = static_cast<int32_t>(segment.geometryIndex);
                std::memcpy(gpu.point0, segment.vertices[0].position, sizeof(gpu.point0));
                gpu.radius0 = segment.vertices[0].radius;
                std::memcpy(gpu.point1, segment.vertices[1].position, sizeof(gpu.point1));
                gpu.radius1 = segment.vertices[1].radius;
            }
            const size_t segmentsSize = sizeof(GpuLineSegment) * segments.size();
            resources.lineSegmentsBuffer = createBuffer(segmentsSize, sizeof(GpuLineSegment), "Mesh Line Segments Buffer " + name, false);
            commandList->beginTrackingBufferState(resources.lineSegmentsBuffer, nvrhi::ResourceStates::Common);
            commandList->writeBuffer(resources.lineSegmentsBuffer, segments.data(), segmentsSize);
            commandList->setPermanentBufferState(resources.lineSegmentsBuffer, nvrhi::ResourceStates::ShaderResource);

            resources.constantBuffer = s->device->createBuffer(
                nvrhi::utils::CreateStaticConstantBufferDesc(sizeof(GpuMorphTargetConstants), "MorphTargetConstants"));
            commandList->beginTrackingBufferState(resources.constantBuffer, nvrhi::ResourceStates::Common);

            commandList->commitBarriers();
            commandList->close();
            s->device->executeCommandList(commandList);

            s->morphTargets[mesh.get()] = resources;
            ++count;
        }

        // The mask: 1 for the instances of the meshes with morph targets.
        const auto& meshInstances = s->scene->GetSceneGraph()->GetMeshInstances();
        std::vector<uint32_t> mask(std::max<size_t>(meshInstances.size(), 1), 0);
        for (size_t i = 0; i < meshInstances.size(); ++i)
        {
            if (!meshInstances[i]->GetMesh()->buffers->morphTargetData.empty())
                mask[i] = 1;
        }
        nvrhi::BufferDesc maskDesc;
        maskDesc.byteSize = mask.size() * sizeof(uint32_t);
        maskDesc.structStride = sizeof(uint32_t);
        maskDesc.debugName = "Instance Morph Target Meta Data";
        maskDesc.initialState = nvrhi::ResourceStates::ShaderResource | nvrhi::ResourceStates::CopyDest;
        s->morphTargetMask = s->device->createBuffer(maskDesc);
        commandList->open();
        commandList->beginTrackingBufferState(s->morphTargetMask, nvrhi::ResourceStates::Common);
        commandList->writeBuffer(s->morphTargetMask, mask.data(), mask.size() * sizeof(uint32_t));
        commandList->setPermanentBufferState(s->morphTargetMask, nvrhi::ResourceStates::ShaderResource);
        commandList->commitBarriers();
        commandList->close();
        s->device->executeCommandList(commandList);
        return count;
    }

    // The buffer of one uint per mesh instance, 1 where the mesh has morph targets; valid as long as
    // the scene (Donut_RtxcrCreateMorphTargets makes it).
    DONUT_API nvrhi::IBuffer* Donut_RtxcrGetMorphTargetMask(RtxcrScene* s)
    {
        return s->morphTargetMask;
    }

    // The compute shader of the morph target pass for the scene's tessellation (the sample's
    // morphTargetAnimation.cs.hlsl with RTXCR_CURVE_TESSELLATION_TYPE).
    DONUT_API void Donut_RtxcrSetMorphTargetShader(RtxcrScene* s, nvrhi::IShader* shader)
    {
        s->morphShader = shader;
        s->morphPipeline = nullptr;
        s->morphLayout = nullptr;
    }

    // Restarts the morph target animation.
    DONUT_API void Donut_RtxcrResetMorphTargetAnimation(RtxcrScene* s)
    {
        s->totalTime = 0.0f;
        s->prevAnimationTimestampPerFrame = 0.0f;
    }

    // The sample's MorphTargetAnimationPass for every morph target mesh, then their bottom level
    // structures' update: blends the two keyframes around the animation's time into the vertex
    // buffers. animationTimestampPerFrame is the time between keyframes; the last keyframe blends back
    // to the first over animationSmoothingFactor of them. With enableDebugOverride the keyframe and
    // blend weight are the given ones. Returns the number of meshes animated.
    DONUT_API int Donut_RtxcrAnimateMorphTargets(RtxcrScene* s, nvrhi::ICommandList* commandList, int frameIndex, double elapsedSeconds,
        double animationTimestampPerFrame, bool enableDebugOverride, int overrideKeyFrameIndex, double overrideKeyFrameWeight,
        double animationSmoothingFactor)
    {
        if (s->morphTargets.empty() || !s->morphShader)
            return 0;

        s->totalTime += static_cast<float>(elapsedSeconds);

        if (!s->morphPipeline)
        {
            nvrhi::BindingLayoutDesc layoutDesc;
            layoutDesc.visibility = nvrhi::ShaderType::Compute;
            layoutDesc.bindings = {
                nvrhi::BindingLayoutItem::ConstantBuffer(0),
                nvrhi::BindingLayoutItem::StructuredBuffer_SRV(0),
                nvrhi::BindingLayoutItem::StructuredBuffer_SRV(1),
                nvrhi::BindingLayoutItem::StructuredBuffer_SRV(2),
                nvrhi::BindingLayoutItem::RawBuffer_UAV(0),
                nvrhi::BindingLayoutItem::RawBuffer_UAV(1),
                nvrhi::BindingLayoutItem::RawBuffer_UAV(2),
            };
            // LSS has no index buffer.
            if (s->tessellationType != LinearSweptSphere)
                layoutDesc.bindings.push_back(nvrhi::BindingLayoutItem::TypedBuffer_SRV(3));
            s->morphLayout = s->device->createBindingLayout(layoutDesc);

            nvrhi::ComputePipelineDesc pipelineDesc;
            pipelineDesc.CS = s->morphShader;
            pipelineDesc.addBindingLayout(s->morphLayout);
            s->morphPipeline = s->device->createComputePipeline(pipelineDesc);
        }

        const float timestamp = static_cast<float>(animationTimestampPerFrame);
        const float smoothing = static_cast<float>(animationSmoothingFactor);
        int animated = 0;
        for (const auto& mesh : s->scene->GetSceneGraph()->GetMeshes())
        {
            const auto found = s->morphTargets.find(mesh.get());
            if (found == s->morphTargets.end() || found->second.vertexSize == 0)
                continue;
            const auto& resources = found->second;

            // The frame's vertex buffer: the hit shaders read the descriptor index + (frame index % 2).
            const auto dynamicBuffers = s->dynamicVertexBuffers.find(mesh->buffers.get());
            if (dynamicBuffers != s->dynamicVertexBuffers.end())
                mesh->buffers->vertexBuffer = dynamicBuffers->second.buffers[frameIndex & 1];

            const auto& positionRange = mesh->buffers->getVertexBufferRange(VertexAttribute::Position);
            const auto& normalRange = mesh->buffers->getVertexBufferRange(VertexAttribute::Normal);
            const auto& tangentRange = mesh->buffers->getVertexBufferRange(VertexAttribute::Tangent);

            // The keyframes to blend: the time of the animation, wrapped.
            const uint32_t morphTargetSize = static_cast<uint32_t>(mesh->buffers->morphTargetBufferRange.size());
            const float totalAnimationTime = (morphTargetSize - 1) * timestamp;
            const float adjustedTotalAnimationTime = totalAnimationTime + smoothing * timestamp;
            s->totalTime *= s->prevAnimationTimestampPerFrame != 0.0f ? (timestamp / s->prevAnimationTimestampPerFrame) : 1.0f;
            while (s->totalTime > adjustedTotalAnimationTime)
                s->totalTime -= adjustedTotalAnimationTime;

            uint32_t keyFrameIndex = 0;
            if (!enableDebugOverride)
                keyFrameIndex = s->totalTime < totalAnimationTime ? static_cast<uint32_t>(s->totalTime / timestamp) : morphTargetSize - 1;
            else
                keyFrameIndex = static_cast<uint32_t>(overrideKeyFrameIndex) % morphTargetSize;

            const auto& keyframeRange = mesh->buffers->morphTargetBufferRange[keyFrameIndex];
            const auto& nextKeyframeRange = mesh->buffers->morphTargetBufferRange[(keyFrameIndex + 1) % morphTargetSize];

            // The last keyframe's blend back to the first is slowed to avoid flickering.
            float adjustedTimestamp = timestamp;
            if ((keyFrameIndex + 1) % morphTargetSize == 0)
                adjustedTimestamp *= smoothing;

            GpuMorphTargetConstants constants = {};
            constants.vertexCount = static_cast<int32_t>(resources.vertexSize);
            const float weight = !enableDebugOverride ?
                (s->totalTime - keyFrameIndex * timestamp) / adjustedTimestamp : static_cast<float>(overrideKeyFrameWeight);
            constants.lerpWeight = std::min(std::max(weight, 0.0f), 1.0f);

            commandList->beginTrackingBufferState(resources.constantBuffer, nvrhi::ResourceStates::Common);
            commandList->writeBuffer(resources.constantBuffer, &constants, sizeof(constants));

            // The vertex buffer rests as the shaders and acceleration structures read it.
            commandList->beginTrackingBufferState(mesh->buffers->vertexBuffer, VERTEX_BUFFER_REST_STATE);
            commandList->setBufferState(mesh->buffers->vertexBuffer, nvrhi::ResourceStates::UnorderedAccess);
            commandList->commitBarriers();

            nvrhi::BindingSetDesc bindingSetDesc;
            bindingSetDesc.bindings = {
                nvrhi::BindingSetItem::ConstantBuffer(0, resources.constantBuffer),
                nvrhi::BindingSetItem::StructuredBuffer_SRV(0, resources.dataBuffer, nvrhi::Format::UNKNOWN, keyframeRange),
                nvrhi::BindingSetItem::StructuredBuffer_SRV(1, resources.dataBuffer, nvrhi::Format::UNKNOWN, nextKeyframeRange),
                nvrhi::BindingSetItem::StructuredBuffer_SRV(2, resources.lineSegmentsBuffer),
                nvrhi::BindingSetItem::RawBuffer_UAV(0, mesh->buffers->vertexBuffer, positionRange),
                nvrhi::BindingSetItem::RawBuffer_UAV(1, mesh->buffers->vertexBuffer, normalRange),
                nvrhi::BindingSetItem::RawBuffer_UAV(2, mesh->buffers->vertexBuffer, tangentRange),
            };
            if (s->tessellationType != LinearSweptSphere)
                bindingSetDesc.bindings.push_back(nvrhi::BindingSetItem::TypedBuffer_SRV(3, mesh->buffers->indexBuffer));
            nvrhi::BindingSetHandle bindingSet = s->device->createBindingSet(bindingSetDesc, s->morphLayout);

            nvrhi::ComputeState state;
            state.setPipeline(s->morphPipeline);
            state.addBindingSet(bindingSet);
            commandList->setComputeState(state);
            commandList->dispatch((resources.vertexSize - 1) / 32 + 1);

            s->prevAnimationTimestampPerFrame = timestamp;
            while (s->totalTime > adjustedTotalAnimationTime)
                s->totalTime -= adjustedTotalAnimationTime;

            // The bottom level structure follows the vertices.
            commandList->setBufferState(mesh->buffers->vertexBuffer, nvrhi::ResourceStates::AccelStructBuildInput);
            commandList->commitBarriers();
            nvrhi::rt::AccelStructDesc blasDesc;
            getMeshBlasDesc(*mesh, blasDesc, true);
            nvrhi::utils::BuildBottomLevelAccelStruct(commandList, mesh->accelStruct, blasDesc);
            commandList->setBufferState(mesh->buffers->vertexBuffer, VERTEX_BUFFER_REST_STATE);
            commandList->commitBarriers();
            ++animated;
        }
        return animated;
    }

    // Valid as long as the scene.
    DONUT_API nvrhi::rt::IAccelStruct* Donut_RtxcrGetTlas(RtxcrScene* s)
    {
        return s->tlas;
    }
}

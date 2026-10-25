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
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include <donut/core/math/math.h>
#include <donut/engine/DescriptorTableManager.h>
#include <donut/engine/Scene.h>
#include <donut/engine/SceneGraph.h>
#include <nvrhi/nvrhi.h>
#include <nvrhi/utils.h>
#include <rtxcr/geometry/include/CurveTessellation.h>

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
                    geometry->globalGeometryIndex = geometryIndex;

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
                geometry->globalGeometryIndex = geometryIndex;

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

            for (uint32_t geometryIndex = 0; geometryIndex < mesh->geometries.size(); ++geometryIndex)
                *mesh->geometries[geometryIndex] = cache[curveIndex].geometries[geometryIndex];

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

            ++curveIndex;
        }
    }

    // The sample's GetMeshBlasDesc: triangles, or linear swept spheres for LSS curves.
    void getMeshBlasDesc(const MeshInfo& mesh, nvrhi::rt::AccelStructDesc& blasDesc)
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

    // Valid as long as the scene.
    DONUT_API nvrhi::rt::IAccelStruct* Donut_RtxcrGetTlas(RtxcrScene* s)
    {
        return s->tlas;
    }
}

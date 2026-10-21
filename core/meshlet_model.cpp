// Meshlet model files for TypeScript (the examples that list it link it; see CMakeLists.txt): the
// ".bin" files DirectX-Graphics-Samples' D3D12MeshShaders samples load (their Model::LoadFromFile,
// written by its WavefrontConverter): meshes of vertices, indices, meshlets with their unique vertex
// indices and packed primitives, meshlet subsets and per-meshlet culling data, all in one buffer.
// A file is checked as that loader checks it, then each mesh's data is handed out as the file has
// it, for Donut_CreateStaticShaderBuffer to upload, with the bounding spheres the loader computes.
// Functions of no Donut object, so donut.ts doesn't wrap them and other examples don't link them.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <vector>

#include "donut_api.h"

namespace
{
    // Model.cpp's file layout.
    constexpr uint32_t c_prolog = 0x4D53484C; // 'MSHL'
    constexpr uint32_t CURRENT_FILE_VERSION = 0;

    enum Attribute : uint32_t
    {
        Attribute_Position,
        Attribute_Normal,
        Attribute_TexCoord,
        Attribute_Tangent,
        Attribute_Bitangent,
        Attribute_Count
    };

    // The attributes' sizes in bytes (R32G32B32_FLOAT but the texture coordinates' R32G32_FLOAT).
    constexpr uint32_t c_attributeSizes[Attribute_Count] = { 12, 12, 8, 12, 12 };

    struct FileHeader
    {
        uint32_t Prolog;
        uint32_t Version;
        uint32_t MeshCount;
        uint32_t AccessorCount;
        uint32_t BufferViewCount;
        uint32_t BufferSize;
    };

    struct MeshHeader
    {
        uint32_t Indices;
        uint32_t IndexSubsets;
        uint32_t Attributes[Attribute_Count];
        uint32_t Meshlets;
        uint32_t MeshletSubsets;
        uint32_t UniqueVertexIndices;
        uint32_t PrimitiveIndices;
        uint32_t CullData;
    };

    struct BufferView
    {
        uint32_t Offset;
        uint32_t Size;
    };

    struct Accessor
    {
        uint32_t BufferView;
        uint32_t Offset;
        uint32_t Size;
        uint32_t Stride;
        uint32_t Count;
    };

    // A part of the file's buffer, and the number of its elements (the accessor's count).
    struct Span
    {
        const uint8_t* data = nullptr;
        uint32_t size = 0;
        uint32_t count = 0;
    };

    struct Sphere
    {
        float center[3];
        float radius;
    };

    struct Mesh
    {
        // The vertex buffers (one per buffer view the attributes use) and their strides.
        std::vector<Span> vertices;
        std::vector<uint32_t> vertexStrides;
        uint32_t vertexCount = 0;
        // The vertex buffer and byte offset of each attribute; -1 for those the mesh hasn't.
        int attributeBuffer[Attribute_Count];
        uint32_t attributeOffset[Attribute_Count];
        uint32_t indexSize = 0;
        // Indexed by MeshletModelData.
        Span data[7];
        Sphere boundingSphere{};
    };

    struct MeshletModel
    {
        std::vector<uint8_t> buffer;
        std::vector<Mesh> meshes;
        Sphere boundingSphere{};
    };

    // What Donut_GetMeshletModelData hands out.
    enum MeshletModelData
    {
        MeshletModelData_Indices,
        MeshletModelData_IndexSubsets,
        MeshletModelData_Meshlets,
        MeshletModelData_MeshletSubsets,
        MeshletModelData_UniqueVertexIndices,
        MeshletModelData_PrimitiveIndices,
        MeshletModelData_CullData,
    };

    // DirectXMath's XMVector3Length, as its SSE2 path computes it: (x^2 + z^2) + y^2.
    float Length3(float x, float y, float z)
    {
        return std::sqrt((x * x + z * z) + y * y);
    }

    // DirectXCollision's BoundingSphere::CreateFromPoints: the farthest apart of the min / max x, y
    // and z points span the first sphere, which grows to take in the points outside it.
    Sphere CreateSphereFromPoints(uint32_t count, const uint8_t* points, uint32_t stride)
    {
        auto point = [&](uint32_t i) { return reinterpret_cast<const float*>(points + size_t(i) * stride); };
        const float* minX = point(0);
        const float* maxX = minX;
        const float* minY = minX;
        const float* maxY = minX;
        const float* minZ = minX;
        const float* maxZ = minX;
        for (uint32_t i = 1; i < count; ++i)
        {
            const float* p = point(i);
            if (p[0] < minX[0]) minX = p;
            if (p[0] > maxX[0]) maxX = p;
            if (p[1] < minY[1]) minY = p;
            if (p[1] > maxY[1]) maxY = p;
            if (p[2] < minZ[2]) minZ = p;
            if (p[2] > maxZ[2]) maxZ = p;
        }

        const float distX = Length3(maxX[0] - minX[0], maxX[1] - minX[1], maxX[2] - minX[2]);
        const float distY = Length3(maxY[0] - minY[0], maxY[1] - minY[1], maxY[2] - minY[2]);
        const float distZ = Length3(maxZ[0] - minZ[0], maxZ[1] - minZ[1], maxZ[2] - minZ[2]);

        const float* a;
        const float* b;
        float dist;
        if (distX > distY)
        {
            if (distX > distZ) { a = maxX; b = minX; dist = distX; }
            else { a = maxZ; b = minZ; dist = distZ; }
        }
        else
        {
            if (distY > distZ) { a = maxY; b = minY; dist = distY; }
            else { a = maxZ; b = minZ; dist = distZ; }
        }

        // XMVectorLerp(a, b, 0.5): a + 0.5 * (b - a).
        Sphere sphere;
        for (int c = 0; c < 3; c++)
            sphere.center[c] = a[c] + 0.5f * (b[c] - a[c]);
        sphere.radius = dist * 0.5f;

        for (uint32_t i = 0; i < count; ++i)
        {
            const float* p = point(i);
            const float delta[3] = { p[0] - sphere.center[0], p[1] - sphere.center[1], p[2] - sphere.center[2] };
            const float d = Length3(delta[0], delta[1], delta[2]);
            if (d > sphere.radius)
            {
                sphere.radius = (sphere.radius + d) * 0.5f;
                const float scale = 1.0f - sphere.radius / d;
                for (int c = 0; c < 3; c++)
                    sphere.center[c] = sphere.center[c] + scale * delta[c];
            }
        }
        return sphere;
    }

    // DirectXCollision's BoundingSphere::CreateMerged.
    Sphere MergeSpheres(const Sphere& s1, const Sphere& s2)
    {
        const float v[3] = { s2.center[0] - s1.center[0], s2.center[1] - s1.center[1], s2.center[2] - s1.center[2] };
        const float d = Length3(v[0], v[1], v[2]);
        const float r1 = s1.radius;
        const float r2 = s2.radius;
        if (r1 + r2 >= d)
        {
            if (r1 - r2 >= d)
                return s1;
            if (r2 - r1 >= d)
                return s2;
        }
        const float t1 = std::fmin(-r1, d - r2);
        const float t2 = std::fmax(r1, d + r2);
        const float t5 = (t2 - t1) * 0.5f;
        Sphere out;
        for (int c = 0; c < 3; c++)
            out.center[c] = s1.center[c] + (v[c] / d) * (t5 + t1);
        out.radius = t5;
        return out;
    }
}

extern "C"
{
    // A meshlet model file in memory (byteSize bytes, copied), checked as the samples' loader checks
    // it. Null (after printing why) on failure; free it with Donut_DestroyMeshletModel.
    DONUT_API MeshletModel* Donut_LoadMeshletModel(const uint8_t* data, int byteSize)
    {
        auto fail = [](const char* reason) -> MeshletModel*
        {
            fprintf(stderr, "Donut_LoadMeshletModel: %s\n", reason);
            return nullptr;
        };
        const auto* bytes = static_cast<const uint8_t*>(data);
        const size_t size = byteSize > 0 ? size_t(byteSize) : 0;
        if (!bytes || size < sizeof(FileHeader))
            return fail("end of file");

        FileHeader header;
        std::memcpy(&header, bytes, sizeof(header));
        if (header.Prolog != c_prolog)
            return fail("not a meshlet model file");
        if (header.Version != CURRENT_FILE_VERSION)
            return fail("not a supported meshlet model version");

        const size_t metadataSize = sizeof(FileHeader) + size_t(header.MeshCount) * sizeof(MeshHeader)
            + size_t(header.AccessorCount) * sizeof(Accessor) + size_t(header.BufferViewCount) * sizeof(BufferView);
        // The loader reads exactly the header, the metadata and the buffer, then expects the end.
        if (size != metadataSize + header.BufferSize)
            return fail("unexpected file size");

        const uint8_t* cursor = bytes + sizeof(FileHeader);
        std::vector<MeshHeader> meshHeaders(header.MeshCount);
        std::memcpy(meshHeaders.data(), cursor, meshHeaders.size() * sizeof(MeshHeader));
        cursor += meshHeaders.size() * sizeof(MeshHeader);
        std::vector<Accessor> accessors(header.AccessorCount);
        std::memcpy(accessors.data(), cursor, accessors.size() * sizeof(Accessor));
        cursor += accessors.size() * sizeof(Accessor);
        std::vector<BufferView> bufferViews(header.BufferViewCount);
        std::memcpy(bufferViews.data(), cursor, bufferViews.size() * sizeof(BufferView));
        cursor += bufferViews.size() * sizeof(BufferView);

        auto model = std::make_unique<MeshletModel>();
        model->buffer.assign(cursor, cursor + header.BufferSize);
        const uint8_t* buffer = model->buffer.data();

        // An accessor's buffer view, checked to lie in the buffer.
        bool valid = true;
        auto view = [&](uint32_t accessorIndex) -> Span
        {
            if (accessorIndex >= accessors.size() || accessors[accessorIndex].BufferView >= bufferViews.size())
            {
                valid = false;
                return Span{};
            }
            const Accessor& accessor = accessors[accessorIndex];
            const BufferView& bufferView = bufferViews[accessor.BufferView];
            if (uint64_t(bufferView.Offset) + bufferView.Size > header.BufferSize)
            {
                valid = false;
                return Span{};
            }
            return Span{ buffer + bufferView.Offset, bufferView.Size, accessor.Count };
        };

        model->meshes.resize(meshHeaders.size());
        for (size_t i = 0; i < meshHeaders.size(); ++i)
        {
            const MeshHeader& meshView = meshHeaders[i];
            Mesh& mesh = model->meshes[i];

            mesh.data[MeshletModelData_Indices] = view(meshView.Indices);
            if (valid)
                mesh.indexSize = accessors[meshView.Indices].Size;
            mesh.data[MeshletModelData_IndexSubsets] = view(meshView.IndexSubsets);

            // A vertex buffer per buffer view the attributes use, in the order first used.
            std::vector<uint32_t> vbMap;
            for (uint32_t j = 0; j < Attribute_Count; ++j)
            {
                mesh.attributeBuffer[j] = -1;
                mesh.attributeOffset[j] = 0;
                if (meshView.Attributes[j] == uint32_t(-1))
                    continue;
                const Span verts = view(meshView.Attributes[j]);
                if (!valid)
                    break;
                const Accessor& accessor = accessors[meshView.Attributes[j]];
                size_t slot = 0;
                while (slot < vbMap.size() && vbMap[slot] != accessor.BufferView)
                    slot++;
                if (slot == vbMap.size())
                {
                    vbMap.push_back(accessor.BufferView);
                    mesh.vertices.push_back(verts);
                    mesh.vertexStrides.push_back(accessor.Stride);
                    if (accessor.Stride == 0)
                        return fail("vertex stride 0");
                    mesh.vertexCount = verts.size / accessor.Stride;
                }
                mesh.attributeBuffer[j] = int(slot);
            }
            // D3D12_APPEND_ALIGNED_ELEMENT offsets: the sizes of the attributes before it in its buffer.
            for (uint32_t j = 0; j < Attribute_Count; ++j)
            {
                if (mesh.attributeBuffer[j] < 0)
                    continue;
                for (uint32_t k = 0; k < j; ++k)
                    if (mesh.attributeBuffer[k] == mesh.attributeBuffer[j])
                        mesh.attributeOffset[j] += c_attributeSizes[k];
            }

            mesh.data[MeshletModelData_Meshlets] = view(meshView.Meshlets);
            mesh.data[MeshletModelData_MeshletSubsets] = view(meshView.MeshletSubsets);
            mesh.data[MeshletModelData_UniqueVertexIndices] = view(meshView.UniqueVertexIndices);
            mesh.data[MeshletModelData_PrimitiveIndices] = view(meshView.PrimitiveIndices);
            mesh.data[MeshletModelData_CullData] = view(meshView.CullData);
            if (!valid)
                return fail("an accessor or buffer view out of range");
            if (mesh.attributeBuffer[Attribute_Position] < 0 || mesh.vertexCount == 0)
                return fail("a mesh without vertex positions");
        }

        // The loader's bounding spheres: of each mesh's positions, and all of them merged.
        for (size_t i = 0; i < model->meshes.size(); ++i)
        {
            Mesh& mesh = model->meshes[i];
            const int vb = mesh.attributeBuffer[Attribute_Position];
            mesh.boundingSphere = CreateSphereFromPoints(mesh.vertexCount,
                mesh.vertices[vb].data + mesh.attributeOffset[Attribute_Position], mesh.vertexStrides[vb]);
            model->boundingSphere = i == 0 ? mesh.boundingSphere : MergeSpheres(model->boundingSphere, mesh.boundingSphere);
        }
        return model.release();
    }

    DONUT_API void Donut_DestroyMeshletModel(MeshletModel* model)
    {
        delete model;
    }

    DONUT_API int Donut_GetMeshletModelMeshCount(MeshletModel* model)
    {
        return int(model->meshes.size());
    }

    // A mesh's vertex buffers: their count, data, size in bytes and stride; its vertex count.
    DONUT_API int Donut_GetMeshletModelVertexBufferCount(MeshletModel* model, int mesh)
    {
        return int(model->meshes[mesh].vertices.size());
    }

    DONUT_API const void* Donut_GetMeshletModelVertexBufferData(MeshletModel* model, int mesh, int vertexBuffer)
    {
        return model->meshes[mesh].vertices[vertexBuffer].data;
    }

    DONUT_API int Donut_GetMeshletModelVertexBufferSize(MeshletModel* model, int mesh, int vertexBuffer)
    {
        return int(model->meshes[mesh].vertices[vertexBuffer].size);
    }

    DONUT_API int Donut_GetMeshletModelVertexBufferStride(MeshletModel* model, int mesh, int vertexBuffer)
    {
        return int(model->meshes[mesh].vertexStrides[vertexBuffer]);
    }

    // Copies a vertex buffer into dst (Donut_GetMeshletModelVertexBufferSize bytes).
    DONUT_API void Donut_CopyMeshletModelVertexBuffer(MeshletModel* model, int mesh, int vertexBuffer, void* dst)
    {
        const Span& span = model->meshes[mesh].vertices[vertexBuffer];
        std::memcpy(dst, span.data, span.size);
    }

    DONUT_API int Donut_GetMeshletModelVertexCount(MeshletModel* model, int mesh)
    {
        return int(model->meshes[mesh].vertexCount);
    }

    // The vertex buffer an attribute (0 position, 1 normal, 2 texture coordinates, 3 tangent,
    // 4 bitangent) is in, -1 if the mesh hasn't it; and its byte offset in a vertex.
    DONUT_API int Donut_GetMeshletModelAttributeBuffer(MeshletModel* model, int mesh, int attribute)
    {
        return model->meshes[mesh].attributeBuffer[attribute];
    }

    DONUT_API int Donut_GetMeshletModelAttributeOffset(MeshletModel* model, int mesh, int attribute)
    {
        return int(model->meshes[mesh].attributeOffset[attribute]);
    }

    // Bytes per index of the mesh's index buffer and unique vertex indices: 2 or 4.
    DONUT_API int Donut_GetMeshletModelIndexSize(MeshletModel* model, int mesh)
    {
        return int(model->meshes[mesh].indexSize);
    }

    // A MeshletModelData part of a mesh: its data (valid until the model is freed), size in bytes
    // and element count (indices, subsets, meshlets, primitives, cull data).
    DONUT_API const void* Donut_GetMeshletModelData(MeshletModel* model, int mesh, int which)
    {
        return model->meshes[mesh].data[which].data;
    }

    DONUT_API int Donut_GetMeshletModelDataSize(MeshletModel* model, int mesh, int which)
    {
        return int(model->meshes[mesh].data[which].size);
    }

    DONUT_API int Donut_GetMeshletModelDataCount(MeshletModel* model, int mesh, int which)
    {
        return int(model->meshes[mesh].data[which].count);
    }

    // Copies a part of a mesh into dst (its size in bytes, Donut_GetMeshletModelDataSize).
    DONUT_API void Donut_CopyMeshletModelData(MeshletModel* model, int mesh, int which, void* dst)
    {
        const Span& span = model->meshes[mesh].data[which];
        std::memcpy(dst, span.data, span.size);
    }

    // The bounding sphere (center, radius: 4 floats into dst) of a mesh, or with mesh -1 of the
    // whole model.
    DONUT_API void Donut_CopyMeshletModelBoundingSphere(MeshletModel* model, int mesh, float* dst)
    {
        const Sphere& sphere = mesh < 0 ? model->boundingSphere : model->meshes[mesh].boundingSphere;
        dst[0] = sphere.center[0];
        dst[1] = sphere.center[1];
        dst[2] = sphere.center[2];
        dst[3] = sphere.radius;
    }
}

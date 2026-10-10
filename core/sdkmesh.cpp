// SDKMESH files for TypeScript (the examples that list it link it; see CMakeLists.txt): the legacy
// DirectX SDK's mesh format, which the Xbox ATG samples load through DirectXTK's
// Model::CreateFromSDKMESH. A file is checked as that loader checks it, then its vertex and index
// buffers, meshes, subsets, materials and frames are handed out as they are in the file, for
// Donut_CreateStaticVertexBuffer and friends to upload. Functions of no Donut object, so donut.ts
// doesn't wrap them and other examples don't link them.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace
{
    // DirectXTK's SDKMesh.h.
    constexpr uint32_t SDKMESH_FILE_VERSION = 101;
    constexpr uint32_t SDKMESH_FILE_VERSION_V2 = 200;

    constexpr uint32_t MAX_VERTEX_ELEMENTS = 32;
    constexpr uint32_t MAX_VERTEX_STREAMS = 16;
    constexpr uint32_t MAX_FRAME_NAME = 100;
    constexpr uint32_t MAX_MESH_NAME = 100;
    constexpr uint32_t MAX_SUBSET_NAME = 100;
    constexpr uint32_t MAX_MATERIAL_NAME = 100;
    constexpr uint32_t MAX_TEXTURE_NAME = 260;
    constexpr uint32_t MAX_MATERIAL_PATH = 260;

    constexpr uint8_t D3DDECLTYPE_UNUSED = 17;

#pragma pack(push, 4)
    struct D3DVERTEXELEMENT9
    {
        uint16_t Stream;
        uint16_t Offset;
        uint8_t Type;
        uint8_t Method;
        uint8_t Usage;
        uint8_t UsageIndex;
    };
#pragma pack(pop)

#pragma pack(push, 8)
    struct SDKMESH_HEADER
    {
        uint32_t Version;
        uint8_t IsBigEndian;
        uint64_t HeaderSize;
        uint64_t NonBufferDataSize;
        uint64_t BufferDataSize;

        uint32_t NumVertexBuffers;
        uint32_t NumIndexBuffers;
        uint32_t NumMeshes;
        uint32_t NumTotalSubsets;
        uint32_t NumFrames;
        uint32_t NumMaterials;

        uint64_t VertexStreamHeadersOffset;
        uint64_t IndexStreamHeadersOffset;
        uint64_t MeshDataOffset;
        uint64_t SubsetDataOffset;
        uint64_t FrameDataOffset;
        uint64_t MaterialDataOffset;
    };

    struct SDKMESH_VERTEX_BUFFER_HEADER
    {
        uint64_t NumVertices;
        uint64_t SizeBytes;
        uint64_t StrideBytes;
        D3DVERTEXELEMENT9 Decl[MAX_VERTEX_ELEMENTS];
        uint64_t DataOffset;
    };

    struct SDKMESH_INDEX_BUFFER_HEADER
    {
        uint64_t NumIndices;
        uint64_t SizeBytes;
        uint32_t IndexType;
        uint64_t DataOffset;
    };

    struct SDKMESH_MESH
    {
        char Name[MAX_MESH_NAME];
        uint8_t NumVertexBuffers;
        uint32_t VertexBuffers[MAX_VERTEX_STREAMS];
        uint32_t IndexBuffer;
        uint32_t NumSubsets;
        uint32_t NumFrameInfluences;

        float BoundingBoxCenter[3];
        float BoundingBoxExtents[3];

        uint64_t SubsetOffset;
        uint64_t FrameInfluenceOffset;
    };

    struct SDKMESH_SUBSET
    {
        char Name[MAX_SUBSET_NAME];
        uint32_t MaterialID;
        uint32_t PrimitiveType;
        uint64_t IndexStart;
        uint64_t IndexCount;
        uint64_t VertexStart;
        uint64_t VertexCount;
    };

    struct SDKMESH_FRAME
    {
        char Name[MAX_FRAME_NAME];
        uint32_t Mesh;
        uint32_t ParentFrame;
        uint32_t ChildFrame;
        uint32_t SiblingFrame;
        float Matrix[16];
        uint32_t AnimationDataIndex;
    };

    struct SDKMESH_MATERIAL
    {
        char Name[MAX_MATERIAL_NAME];
        char MaterialInstancePath[MAX_MATERIAL_PATH];
        char DiffuseTexture[MAX_TEXTURE_NAME];
        char NormalTexture[MAX_TEXTURE_NAME];
        char SpecularTexture[MAX_TEXTURE_NAME];

        float Diffuse[4];
        float Ambient[4];
        float Specular[4];
        float Emissive[4];
        float Power;

        uint64_t Force64_1;
        uint64_t Force64_2;
        uint64_t Force64_3;
        uint64_t Force64_4;
        uint64_t Force64_5;
        uint64_t Force64_6;
    };

    struct SDKMESH_MATERIAL_V2
    {
        char Name[MAX_MATERIAL_NAME];
        char RMATexture[MAX_TEXTURE_NAME];
        char AlbedoTexture[MAX_TEXTURE_NAME];
        char NormalTexture[MAX_TEXTURE_NAME];
        char EmissiveTexture[MAX_TEXTURE_NAME];

        float Alpha;

        char Reserved[60];

        uint64_t Force64_1;
        uint64_t Force64_2;
        uint64_t Force64_3;
        uint64_t Force64_4;
        uint64_t Force64_5;
        uint64_t Force64_6;
    };
#pragma pack(pop)

    static_assert(sizeof(D3DVERTEXELEMENT9) == 8, "Direct3D9 Decl structure size incorrect");
    static_assert(sizeof(SDKMESH_HEADER) == 104, "SDK Mesh structure size incorrect");
    static_assert(sizeof(SDKMESH_VERTEX_BUFFER_HEADER) == 288, "SDK Mesh structure size incorrect");
    static_assert(sizeof(SDKMESH_INDEX_BUFFER_HEADER) == 32, "SDK Mesh structure size incorrect");
    static_assert(sizeof(SDKMESH_MESH) == 224, "SDK Mesh structure size incorrect");
    static_assert(sizeof(SDKMESH_SUBSET) == 144, "SDK Mesh structure size incorrect");
    static_assert(sizeof(SDKMESH_FRAME) == 184, "SDK Mesh structure size incorrect");
    static_assert(sizeof(SDKMESH_MATERIAL) == 1256, "SDK Mesh structure size incorrect");
    static_assert(sizeof(SDKMESH_MATERIAL_V2) == sizeof(SDKMESH_MATERIAL), "SDK Mesh structure size incorrect");

    // A file's bytes and where its headers are in them, and its names copied out NUL-terminated
    // (the file's arrays may fill their whole length), each kept for TypeScript to hold on to.
    struct SdkMesh
    {
        std::vector<uint8_t> bytes;
        const SDKMESH_HEADER* header = nullptr;
        const SDKMESH_VERTEX_BUFFER_HEADER* vertexBuffers = nullptr;
        const SDKMESH_INDEX_BUFFER_HEADER* indexBuffers = nullptr;
        const SDKMESH_MESH* meshes = nullptr;
        const SDKMESH_SUBSET* subsets = nullptr;
        const SDKMESH_FRAME* frames = nullptr;
        const SDKMESH_MATERIAL* materials = nullptr;
        const SDKMESH_MATERIAL_V2* materialsV2 = nullptr;
        std::vector<std::string> meshNames;
        std::vector<std::string> materialNames;
        std::vector<std::string> materialTextures; // 4 per material
        std::vector<std::string> frameNames;
    };

    bool Fits(uint64_t dataSize, uint64_t offset, uint64_t size)
    {
        return offset <= dataSize && size <= dataSize - offset;
    }

    std::string CopyName(const char* name, size_t capacity)
    {
        return std::string(name, strnlen(name, capacity));
    }

    const D3DVERTEXELEMENT9* FindElement(const SDKMESH_VERTEX_BUFFER_HEADER& vb, int usage, int usageIndex)
    {
        for (uint32_t i = 0; i < MAX_VERTEX_ELEMENTS; ++i)
        {
            const D3DVERTEXELEMENT9& element = vb.Decl[i];
            if (element.Stream == 0xFF || element.Type == D3DDECLTYPE_UNUSED)
                break;
            if (element.Usage == usage && element.UsageIndex == usageIndex)
                return &element;
        }
        return nullptr;
    }
}

extern "C"
{
    // A SDKMESH file in memory (byteSize bytes, copied), checked as DirectXTK's
    // Model::CreateFromSDKMESH checks it. Null (after printing why) on failure; free it with
    // Donut_DestroySdkMesh.
    SdkMesh* Donut_LoadSdkMesh(const void* data, int byteSize)
    {
        auto fail = [](const char* reason) -> SdkMesh*
        {
            fprintf(stderr, "Donut_LoadSdkMesh: %s\n", reason);
            return nullptr;
        };
        if (!data || byteSize < int(sizeof(SDKMESH_HEADER)))
            return fail("end of file");

        auto mesh = std::make_unique<SdkMesh>();
        const auto* bytes = static_cast<const uint8_t*>(data);
        mesh->bytes.assign(bytes, bytes + byteSize);
        const uint8_t* base = mesh->bytes.data();
        const uint64_t dataSize = mesh->bytes.size();

        const auto* header = reinterpret_cast<const SDKMESH_HEADER*>(base);
        const uint64_t headerSize = sizeof(SDKMESH_HEADER)
            + uint64_t(header->NumVertexBuffers) * sizeof(SDKMESH_VERTEX_BUFFER_HEADER)
            + uint64_t(header->NumIndexBuffers) * sizeof(SDKMESH_INDEX_BUFFER_HEADER);
        if (header->HeaderSize != headerSize)
            return fail("not a valid SDKMESH file");
        if (dataSize < header->HeaderSize)
            return fail("end of file");
        if (header->Version != SDKMESH_FILE_VERSION && header->Version != SDKMESH_FILE_VERSION_V2)
            return fail("not a supported SDKMESH version");
        if (header->IsBigEndian)
            return fail("big-endian SDKMESH files are not supported");
        if (!header->NumMeshes)
            return fail("no meshes found");
        if (!header->NumVertexBuffers)
            return fail("no vertex buffers found");
        if (!header->NumIndexBuffers)
            return fail("no index buffers found");
        if (!header->NumTotalSubsets)
            return fail("no subsets found");
        if (!header->NumMaterials)
            return fail("no materials found");

        if (!Fits(dataSize, header->VertexStreamHeadersOffset, uint64_t(header->NumVertexBuffers) * sizeof(SDKMESH_VERTEX_BUFFER_HEADER))
            || !Fits(dataSize, header->IndexStreamHeadersOffset, uint64_t(header->NumIndexBuffers) * sizeof(SDKMESH_INDEX_BUFFER_HEADER))
            || !Fits(dataSize, header->MeshDataOffset, uint64_t(header->NumMeshes) * sizeof(SDKMESH_MESH))
            || !Fits(dataSize, header->SubsetDataOffset, uint64_t(header->NumTotalSubsets) * sizeof(SDKMESH_SUBSET))
            || (header->NumFrames > 0 && !Fits(dataSize, header->FrameDataOffset, uint64_t(header->NumFrames) * sizeof(SDKMESH_FRAME)))
            || !Fits(dataSize, header->MaterialDataOffset, uint64_t(header->NumMaterials) * sizeof(SDKMESH_MATERIAL)))
            return fail("end of file");

        const uint64_t bufferDataOffset = header->HeaderSize + header->NonBufferDataSize;
        if (!Fits(dataSize, bufferDataOffset, header->BufferDataSize))
            return fail("end of file");

        mesh->header = header;
        mesh->vertexBuffers = reinterpret_cast<const SDKMESH_VERTEX_BUFFER_HEADER*>(base + header->VertexStreamHeadersOffset);
        mesh->indexBuffers = reinterpret_cast<const SDKMESH_INDEX_BUFFER_HEADER*>(base + header->IndexStreamHeadersOffset);
        mesh->meshes = reinterpret_cast<const SDKMESH_MESH*>(base + header->MeshDataOffset);
        mesh->subsets = reinterpret_cast<const SDKMESH_SUBSET*>(base + header->SubsetDataOffset);
        if (header->NumFrames > 0)
            mesh->frames = reinterpret_cast<const SDKMESH_FRAME*>(base + header->FrameDataOffset);
        if (header->Version == SDKMESH_FILE_VERSION_V2)
            mesh->materialsV2 = reinterpret_cast<const SDKMESH_MATERIAL_V2*>(base + header->MaterialDataOffset);
        else
            mesh->materials = reinterpret_cast<const SDKMESH_MATERIAL*>(base + header->MaterialDataOffset);

        for (uint32_t j = 0; j < header->NumVertexBuffers; ++j)
        {
            const auto& vh = mesh->vertexBuffers[j];
            if (vh.SizeBytes > INT32_MAX)
                return fail("vertex buffer too large");
            if (!Fits(dataSize, vh.DataOffset, vh.SizeBytes))
                return fail("end of file");
            if (!FindElement(vh, 0, 0))
                return fail("SV_Position is required");
        }
        for (uint32_t j = 0; j < header->NumIndexBuffers; ++j)
        {
            const auto& ih = mesh->indexBuffers[j];
            if (ih.SizeBytes > INT32_MAX)
                return fail("index buffer too large");
            if (!Fits(dataSize, ih.DataOffset, ih.SizeBytes))
                return fail("end of file");
            if (ih.IndexType != 0 && ih.IndexType != 1)
                return fail("invalid index buffer type found");
        }
        for (uint32_t m = 0; m < header->NumMeshes; ++m)
        {
            const auto& mh = mesh->meshes[m];
            if (!mh.NumSubsets || !mh.NumVertexBuffers || mh.IndexBuffer >= header->NumIndexBuffers
                || mh.VertexBuffers[0] >= header->NumVertexBuffers)
                return fail("invalid mesh found");
            if (!Fits(dataSize, mh.SubsetOffset, uint64_t(mh.NumSubsets) * sizeof(uint32_t)))
                return fail("end of file");
            const auto* subsets = reinterpret_cast<const uint32_t*>(base + mh.SubsetOffset);
            for (uint32_t s = 0; s < mh.NumSubsets; ++s)
            {
                if (subsets[s] >= header->NumTotalSubsets)
                    return fail("invalid mesh found");
                const auto& subset = mesh->subsets[subsets[s]];
                if (subset.MaterialID >= header->NumMaterials)
                    return fail("invalid mesh found");
                if (subset.PrimitiveType > 8)
                    return fail("unsupported primitive type");
            }
        }
        for (uint32_t f = 0; f < header->NumFrames; ++f)
        {
            const uint32_t index = mesh->frames[f].Mesh;
            if (index != UINT32_MAX && index >= header->NumMeshes)
                return fail("invalid mesh index found in frame data");
        }

        for (uint32_t m = 0; m < header->NumMeshes; ++m)
            mesh->meshNames.push_back(CopyName(mesh->meshes[m].Name, MAX_MESH_NAME));
        for (uint32_t m = 0; m < header->NumMaterials; ++m)
        {
            if (mesh->materialsV2)
            {
                const SDKMESH_MATERIAL_V2& mat = mesh->materialsV2[m];
                mesh->materialNames.push_back(CopyName(mat.Name, MAX_MATERIAL_NAME));
                mesh->materialTextures.push_back(CopyName(mat.AlbedoTexture, MAX_TEXTURE_NAME));
                mesh->materialTextures.push_back(CopyName(mat.NormalTexture, MAX_TEXTURE_NAME));
                mesh->materialTextures.push_back(CopyName(mat.RMATexture, MAX_TEXTURE_NAME));
                mesh->materialTextures.push_back(CopyName(mat.EmissiveTexture, MAX_TEXTURE_NAME));
            }
            else
            {
                const SDKMESH_MATERIAL& mat = mesh->materials[m];
                mesh->materialNames.push_back(CopyName(mat.Name, MAX_MATERIAL_NAME));
                mesh->materialTextures.push_back(CopyName(mat.DiffuseTexture, MAX_TEXTURE_NAME));
                mesh->materialTextures.push_back(CopyName(mat.NormalTexture, MAX_TEXTURE_NAME));
                mesh->materialTextures.push_back(CopyName(mat.SpecularTexture, MAX_TEXTURE_NAME));
                mesh->materialTextures.push_back(std::string());
            }
        }
        for (uint32_t f = 0; f < header->NumFrames; ++f)
            mesh->frameNames.push_back(CopyName(mesh->frames[f].Name, MAX_FRAME_NAME));
        return mesh.release();
    }

    void Donut_DestroySdkMesh(SdkMesh* sdkMesh)
    {
        delete sdkMesh;
    }

    // 101, or 200 for files with PBR materials.
    int Donut_GetSdkMeshVersion(SdkMesh* sdkMesh)
    {
        return int(sdkMesh->header->Version);
    }

    int Donut_GetSdkMeshVertexBufferCount(SdkMesh* sdkMesh)
    {
        return int(sdkMesh->header->NumVertexBuffers);
    }

    const void* Donut_GetSdkMeshVertexBufferData(SdkMesh* sdkMesh, int vertexBuffer)
    {
        SdkMesh* mesh = sdkMesh;
        return mesh->bytes.data() + mesh->vertexBuffers[vertexBuffer].DataOffset;
    }

    int Donut_GetSdkMeshVertexBufferSize(SdkMesh* sdkMesh, int vertexBuffer)
    {
        return int(sdkMesh->vertexBuffers[vertexBuffer].SizeBytes);
    }

    int Donut_GetSdkMeshVertexBufferStride(SdkMesh* sdkMesh, int vertexBuffer)
    {
        return int(sdkMesh->vertexBuffers[vertexBuffer].StrideBytes);
    }

    int Donut_GetSdkMeshVertexBufferVertexCount(SdkMesh* sdkMesh, int vertexBuffer)
    {
        return int(sdkMesh->vertexBuffers[vertexBuffer].NumVertices);
    }

    int Donut_GetSdkMeshVertexElementOffset(SdkMesh* sdkMesh, int vertexBuffer, int usage, int usageIndex)
    {
        const D3DVERTEXELEMENT9* element = FindElement(sdkMesh->vertexBuffers[vertexBuffer], usage, usageIndex);
        return element ? int(element->Offset) : -1;
    }

    int Donut_GetSdkMeshVertexElementType(SdkMesh* sdkMesh, int vertexBuffer, int usage, int usageIndex)
    {
        const D3DVERTEXELEMENT9* element = FindElement(sdkMesh->vertexBuffers[vertexBuffer], usage, usageIndex);
        return element ? int(element->Type) : -1;
    }

    int Donut_GetSdkMeshIndexBufferCount(SdkMesh* sdkMesh)
    {
        return int(sdkMesh->header->NumIndexBuffers);
    }

    const void* Donut_GetSdkMeshIndexBufferData(SdkMesh* sdkMesh, int indexBuffer)
    {
        SdkMesh* mesh = sdkMesh;
        return mesh->bytes.data() + mesh->indexBuffers[indexBuffer].DataOffset;
    }

    int Donut_GetSdkMeshIndexBufferSize(SdkMesh* sdkMesh, int indexBuffer)
    {
        return int(sdkMesh->indexBuffers[indexBuffer].SizeBytes);
    }

    int Donut_GetSdkMeshIndexBufferIndexCount(SdkMesh* sdkMesh, int indexBuffer)
    {
        return int(sdkMesh->indexBuffers[indexBuffer].NumIndices);
    }

    int Donut_IsSdkMeshIndexBuffer32Bit(SdkMesh* sdkMesh, int indexBuffer)
    {
        return sdkMesh->indexBuffers[indexBuffer].IndexType == 1 ? 1 : 0;
    }

    int Donut_GetSdkMeshMeshCount(SdkMesh* sdkMesh)
    {
        return int(sdkMesh->header->NumMeshes);
    }

    const char* Donut_GetSdkMeshMeshName(SdkMesh* sdkMesh, int mesh)
    {
        return sdkMesh->meshNames[mesh].c_str();
    }

    int Donut_GetSdkMeshMeshVertexBuffer(SdkMesh* sdkMesh, int mesh)
    {
        return int(sdkMesh->meshes[mesh].VertexBuffers[0]);
    }

    int Donut_GetSdkMeshMeshIndexBuffer(SdkMesh* sdkMesh, int mesh)
    {
        return int(sdkMesh->meshes[mesh].IndexBuffer);
    }

    int Donut_GetSdkMeshMeshSubsetCount(SdkMesh* sdkMesh, int mesh)
    {
        return int(sdkMesh->meshes[mesh].NumSubsets);
    }

    int Donut_GetSdkMeshMeshSubset(SdkMesh* sdkMesh, int mesh, int index)
    {
        SdkMesh* m = sdkMesh;
        const auto* subsets = reinterpret_cast<const uint32_t*>(m->bytes.data() + m->meshes[mesh].SubsetOffset);
        return int(subsets[index]);
    }

    void Donut_CopySdkMeshMeshBounds(SdkMesh* sdkMesh, int mesh, float* dst)
    {
        const SDKMESH_MESH& m = sdkMesh->meshes[mesh];
        memcpy(dst, m.BoundingBoxCenter, 3 * sizeof(float));
        memcpy(dst + 3, m.BoundingBoxExtents, 3 * sizeof(float));
    }

    int Donut_GetSdkMeshSubsetMaterial(SdkMesh* sdkMesh, int subset)
    {
        return int(sdkMesh->subsets[subset].MaterialID);
    }

    int Donut_GetSdkMeshSubsetPrimitiveType(SdkMesh* sdkMesh, int subset)
    {
        return int(sdkMesh->subsets[subset].PrimitiveType);
    }

    int Donut_GetSdkMeshSubsetIndexStart(SdkMesh* sdkMesh, int subset)
    {
        return int(sdkMesh->subsets[subset].IndexStart);
    }

    int Donut_GetSdkMeshSubsetIndexCount(SdkMesh* sdkMesh, int subset)
    {
        return int(sdkMesh->subsets[subset].IndexCount);
    }

    int Donut_GetSdkMeshSubsetVertexStart(SdkMesh* sdkMesh, int subset)
    {
        return int(sdkMesh->subsets[subset].VertexStart);
    }

    int Donut_GetSdkMeshSubsetVertexCount(SdkMesh* sdkMesh, int subset)
    {
        return int(sdkMesh->subsets[subset].VertexCount);
    }

    int Donut_GetSdkMeshMaterialCount(SdkMesh* sdkMesh)
    {
        return int(sdkMesh->header->NumMaterials);
    }

    const char* Donut_GetSdkMeshMaterialName(SdkMesh* sdkMesh, int material)
    {
        return sdkMesh->materialNames[material].c_str();
    }

    // which: 0 diffuse (version 200: albedo), 1 normal, 2 specular (version 200: roughness /
    // metallic / ambient occlusion), 3 emissive (version 200 only).
    const char* Donut_GetSdkMeshMaterialTexture(SdkMesh* sdkMesh, int material, int which)
    {
        if (which < 0 || which > 3)
            return "";
        return sdkMesh->materialTextures[size_t(material) * 4 + size_t(which)].c_str();
    }

    // Version 101: diffuse, ambient, specular and emissive (RGBA each), then the specular power (17
    // floats). Version 200: the alpha (1 float).
    void Donut_CopySdkMeshMaterialColors(SdkMesh* sdkMesh, int material, float* dst)
    {
        SdkMesh* m = sdkMesh;
        if (m->materialsV2)
        {
            dst[0] = m->materialsV2[material].Alpha;
            return;
        }
        const SDKMESH_MATERIAL& mat = m->materials[material];
        memcpy(dst, mat.Diffuse, 4 * sizeof(float));
        memcpy(dst + 4, mat.Ambient, 4 * sizeof(float));
        memcpy(dst + 8, mat.Specular, 4 * sizeof(float));
        memcpy(dst + 12, mat.Emissive, 4 * sizeof(float));
        dst[16] = mat.Power;
    }

    int Donut_GetSdkMeshFrameCount(SdkMesh* sdkMesh)
    {
        return int(sdkMesh->header->NumFrames);
    }

    const char* Donut_GetSdkMeshFrameName(SdkMesh* sdkMesh, int frame)
    {
        return sdkMesh->frameNames[frame].c_str();
    }

    // The frame's mesh and parent frame, -1 for none.
    int Donut_GetSdkMeshFrameMesh(SdkMesh* sdkMesh, int frame)
    {
        return int(sdkMesh->frames[frame].Mesh);
    }

    int Donut_GetSdkMeshFrameParent(SdkMesh* sdkMesh, int frame)
    {
        return int(sdkMesh->frames[frame].ParentFrame);
    }

    // The frame's transform relative to its parent: 16 floats, row-major for mul(vector, matrix)
    // (DirectXMath's layout).
    void Donut_CopySdkMeshFrameMatrix(SdkMesh* sdkMesh, int frame, float* dst)
    {
        memcpy(dst, sdkMesh->frames[frame].Matrix, 16 * sizeof(float));
    }
}

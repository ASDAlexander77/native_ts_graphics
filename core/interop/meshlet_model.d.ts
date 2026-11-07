/// <reference path="../donut_handles.d.ts" />
// Meshlet models (core/meshlet_model.cpp)

// Handles of the module's objects (see donut_handles.d.ts).
@cpp declare class MeshletModelHandle { private readonly __meshletModel: index; }

// Donut_GetMeshletModelAttributeBuffer's attributes.
enum MeshletAttribute {
    Position = 0,
    Normal = 1,
    TexCoord = 2,
    Tangent = 3,
    Bitangent = 4,
}

// Donut_GetMeshletModelData's parts of a mesh.
enum MeshletModelData {
    Indices = 0,
    IndexSubsets = 1,
    Meshlets = 2,
    MeshletSubsets = 3,
    UniqueVertexIndices = 4,
    PrimitiveIndices = 5,
    CullData = 6,
}

// Meshlet model files, the ".bin" files DirectX-Graphics-Samples' D3D12MeshShaders samples load
// (core/meshlet_model.cpp, linked only into the examples that list it): meshes of vertices,
// indices, meshlets (vertex count, vertex offset, primitive count, primitive offset: 4 uints), unique
// vertex indices, packed primitives (three 10-bit indices a uint), meshlet subsets (offset, count)
// and per-meshlet culling data. A file in memory (byteSize bytes, copied), checked as the samples'
// loader checks it; null (after printing why) on failure. Free it with Donut_DestroyMeshletModel.
@nodrops declare function Donut_LoadMeshletModel(data: Ref<u8>, byteSize: int): MeshletModelHandle | null;
@nodrops declare function Donut_DestroyMeshletModel(meshletModel: MeshletModelHandle): void;
@nodrops declare function Donut_GetMeshletModelMeshCount(meshletModel: MeshletModelHandle): int;
// A mesh's vertex buffers (data valid until the model is freed, size in bytes, stride) and vertex count.
@nodrops declare function Donut_GetMeshletModelVertexBufferCount(meshletModel: MeshletModelHandle, mesh: int): int;
@nodrops declare function Donut_GetMeshletModelVertexBufferData(meshletModel: MeshletModelHandle, mesh: int, vertexBuffer: int): Opaque;
@nodrops declare function Donut_GetMeshletModelVertexBufferSize(meshletModel: MeshletModelHandle, mesh: int, vertexBuffer: int): int;
@nodrops declare function Donut_GetMeshletModelVertexBufferStride(meshletModel: MeshletModelHandle, mesh: int, vertexBuffer: int): int;
// Copies a vertex buffer into dst (Donut_GetMeshletModelVertexBufferSize bytes; Ref of a `let` array element).
@nodrops declare function Donut_CopyMeshletModelVertexBuffer(meshletModel: MeshletModelHandle, mesh: int, vertexBuffer: int, dst: Opaque): void;
@nodrops declare function Donut_GetMeshletModelVertexCount(meshletModel: MeshletModelHandle, mesh: int): int;
// The vertex buffer an attribute (MeshletAttribute) is in, -1 if the mesh hasn't it; its byte offset.
@nodrops declare function Donut_GetMeshletModelAttributeBuffer(meshletModel: MeshletModelHandle, mesh: int, attribute: MeshletAttribute): int;
@nodrops declare function Donut_GetMeshletModelAttributeOffset(meshletModel: MeshletModelHandle, mesh: int, attribute: MeshletAttribute): int;
// Bytes per index (2 or 4) of the mesh's indices and unique vertex indices.
@nodrops declare function Donut_GetMeshletModelIndexSize(meshletModel: MeshletModelHandle, mesh: int): int;
// A part of a mesh: its data (valid until the model is freed), size in bytes and element count.
@nodrops declare function Donut_GetMeshletModelData(meshletModel: MeshletModelHandle, mesh: int, which: MeshletModelData): Opaque;
@nodrops declare function Donut_GetMeshletModelDataSize(meshletModel: MeshletModelHandle, mesh: int, which: MeshletModelData): int;
@nodrops declare function Donut_GetMeshletModelDataCount(meshletModel: MeshletModelHandle, mesh: int, which: MeshletModelData): int;
// Copies a part of a mesh into dst (Donut_GetMeshletModelDataSize bytes; Ref of a `let` array element).
@nodrops declare function Donut_CopyMeshletModelData(meshletModel: MeshletModelHandle, mesh: int, which: MeshletModelData, dst: Opaque): void;
// The bounding sphere (center, radius: 4 floats into dst) of a mesh, or with mesh -1 of the model.
@nodrops declare function Donut_CopyMeshletModelBoundingSphere(meshletModel: MeshletModelHandle, mesh: int, dst: Ref<f32>): void;

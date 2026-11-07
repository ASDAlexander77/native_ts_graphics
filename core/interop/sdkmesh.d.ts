/// <reference path="../donut_handles.d.ts" />
// SDKMESH models (core/sdkmesh.cpp)

// Handles of the module's objects (see donut_handles.d.ts).
@cpp declare class SdkMeshHandle { private readonly __sdkMesh: index; }

// SDKMESH files, the legacy DirectX SDK's mesh format the Xbox ATG samples load with DirectXTK
// (core/sdkmesh.cpp, linked only into the examples that list it). A file in memory (e.g.
// Donut_GetBinaryFileData; byteSize bytes, copied), checked as DirectXTK's Model::CreateFromSDKMESH
// checks it; its buffers, meshes, subsets, materials and frames as the file has them. Null (after
// printing why) on failure; free it with Donut_DestroySdkMesh. Strings are valid as long as the mesh.
@nodrops declare function Donut_LoadSdkMesh(data: Ref<u8>, byteSize: int): SdkMeshHandle | null;
@nodrops declare function Donut_DestroySdkMesh(sdkMesh: SdkMeshHandle): void;
// 101, or 200 for files with PBR materials.
@nodrops declare function Donut_GetSdkMeshVersion(sdkMesh: SdkMeshHandle): int;
// Vertex buffers: their data (valid until the mesh is freed), size in bytes, stride, vertex count.
@nodrops declare function Donut_GetSdkMeshVertexBufferCount(sdkMesh: SdkMeshHandle): int;
@nodrops declare function Donut_GetSdkMeshVertexBufferData(sdkMesh: SdkMeshHandle, vertexBuffer: int): Opaque;
@nodrops declare function Donut_GetSdkMeshVertexBufferSize(sdkMesh: SdkMeshHandle, vertexBuffer: int): int;
@nodrops declare function Donut_GetSdkMeshVertexBufferStride(sdkMesh: SdkMeshHandle, vertexBuffer: int): int;
@nodrops declare function Donut_GetSdkMeshVertexBufferVertexCount(sdkMesh: SdkMeshHandle, vertexBuffer: int): int;
// The byte offset in a vertex and the D3DDECLTYPE (2 FLOAT3, 1 FLOAT2...) of a vertex element by its
// D3DDECLUSAGE (0 position, 3 normal, 5 texture coordinates, 6 tangent, 7 binormal, 10 color) and
// usage index; -1 if the vertices have none.
@nodrops declare function Donut_GetSdkMeshVertexElementOffset(sdkMesh: SdkMeshHandle, vertexBuffer: int, usage: int, usageIndex: int): int;
@nodrops declare function Donut_GetSdkMeshVertexElementType(sdkMesh: SdkMeshHandle, vertexBuffer: int, usage: int, usageIndex: int): int;
// Index buffers: their data, size in bytes, index count, and whether the indices are 32-bit (16-bit
// otherwise).
@nodrops declare function Donut_GetSdkMeshIndexBufferCount(sdkMesh: SdkMeshHandle): int;
@nodrops declare function Donut_GetSdkMeshIndexBufferData(sdkMesh: SdkMeshHandle, indexBuffer: int): Opaque;
@nodrops declare function Donut_GetSdkMeshIndexBufferSize(sdkMesh: SdkMeshHandle, indexBuffer: int): int;
@nodrops declare function Donut_GetSdkMeshIndexBufferIndexCount(sdkMesh: SdkMeshHandle, indexBuffer: int): int;
@nodrops declare function Donut_IsSdkMeshIndexBuffer32Bit(sdkMesh: SdkMeshHandle, indexBuffer: int): int;
// Meshes: their name, vertex and index buffers, subsets (indices into the file's subsets), and
// bounding box (center, then extents: 6 floats into dst, Ref of a `let` f32 array element).
@nodrops declare function Donut_GetSdkMeshMeshCount(sdkMesh: SdkMeshHandle): int;
@nodrops declare function Donut_GetSdkMeshMeshName(sdkMesh: SdkMeshHandle, mesh: int): string;
@nodrops declare function Donut_GetSdkMeshMeshVertexBuffer(sdkMesh: SdkMeshHandle, mesh: int): int;
@nodrops declare function Donut_GetSdkMeshMeshIndexBuffer(sdkMesh: SdkMeshHandle, mesh: int): int;
@nodrops declare function Donut_GetSdkMeshMeshSubsetCount(sdkMesh: SdkMeshHandle, mesh: int): int;
@nodrops declare function Donut_GetSdkMeshMeshSubset(sdkMesh: SdkMeshHandle, mesh: int, index: int): int;
@nodrops declare function Donut_CopySdkMeshMeshBounds(sdkMesh: SdkMeshHandle, mesh: int, dst: Ref<f32>): void;
// Subsets: their material, primitive type (0 triangle list, 1 triangle strip, 2 line list, 3 line
// strip, 4 point list...), and ranges of their mesh's index and vertex buffers.
@nodrops declare function Donut_GetSdkMeshSubsetMaterial(sdkMesh: SdkMeshHandle, subset: int): int;
@nodrops declare function Donut_GetSdkMeshSubsetPrimitiveType(sdkMesh: SdkMeshHandle, subset: int): int;
@nodrops declare function Donut_GetSdkMeshSubsetIndexStart(sdkMesh: SdkMeshHandle, subset: int): int;
@nodrops declare function Donut_GetSdkMeshSubsetIndexCount(sdkMesh: SdkMeshHandle, subset: int): int;
@nodrops declare function Donut_GetSdkMeshSubsetVertexStart(sdkMesh: SdkMeshHandle, subset: int): int;
@nodrops declare function Donut_GetSdkMeshSubsetVertexCount(sdkMesh: SdkMeshHandle, subset: int): int;
// Materials: their name, a texture's file name ("" if none: which 0 diffuse, or albedo in version
// 200; 1 normal; 2 specular, or roughness / metallic / ambient occlusion in version 200; 3 emissive,
// version 200 only), and their colors into dst: version 101's diffuse, ambient, specular and
// emissive (RGBA each) and specular power (17 floats), version 200's alpha (1 float).
@nodrops declare function Donut_GetSdkMeshMaterialCount(sdkMesh: SdkMeshHandle): int;
@nodrops declare function Donut_GetSdkMeshMaterialName(sdkMesh: SdkMeshHandle, material: int): string;
@nodrops declare function Donut_GetSdkMeshMaterialTexture(sdkMesh: SdkMeshHandle, material: int, which: int): string;
@nodrops declare function Donut_CopySdkMeshMaterialColors(sdkMesh: SdkMeshHandle, material: int, dst: Ref<f32>): void;
// Frames (the meshes' hierarchy): their name, mesh and parent frame (-1 for none), and transform
// relative to the parent (16 floats into dst, row-major for mul(vector, matrix) as DirectXMath).
@nodrops declare function Donut_GetSdkMeshFrameCount(sdkMesh: SdkMeshHandle): int;
@nodrops declare function Donut_GetSdkMeshFrameName(sdkMesh: SdkMeshHandle, frame: int): string;
@nodrops declare function Donut_GetSdkMeshFrameMesh(sdkMesh: SdkMeshHandle, frame: int): int;
@nodrops declare function Donut_GetSdkMeshFrameParent(sdkMesh: SdkMeshHandle, frame: int): int;
@nodrops declare function Donut_CopySdkMeshFrameMatrix(sdkMesh: SdkMeshHandle, frame: int, dst: Ref<f32>): void;

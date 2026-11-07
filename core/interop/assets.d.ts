/// <reference path="../donut_handles.d.ts" />
// Files: glTF meshes and models, binary files, JSON, image loading, file listing

// glTF material alpha modes (Donut_GetGltfModelPrimitiveAlphaMode).
enum AlphaMode {
    Opaque = 0,
    Mask = 1,
    Blend = 2
}
// The first primitive of a glTF file's first mesh (path relative to the executable's directory), as
// the Vulkan-Samples framework loads it: float3 position, float3 normal and float2 texture
// coordinates interleaved (32 bytes), R32_UINT indices, the nodes' transforms ignored. Uploaded by
// an open command list. Null (after logging why) on failure.
@nodrops declare function Donut_LoadGltfMesh(app: AppHandle, commandList: CommandListHandle, path: string): GltfMeshHandle;
// Valid as long as the mesh.
@nodrops declare function Donut_GetGltfMeshVertexBuffer(gltfMesh: GltfMeshHandle): BufferHandle;
@nodrops declare function Donut_GetGltfMeshIndexBuffer(gltfMesh: GltfMeshHandle): BufferHandle;
@nodrops declare function Donut_GetGltfMeshIndexCount(gltfMesh: GltfMeshHandle): int;
// Every primitive of a glTF file's meshes (path relative to the executable's directory), in mesh
// and primitive order, as the Vulkan-Samples framework's scene loader reads them into submeshes:
// vertices as Donut_LoadGltfMesh's (in mesh space, the nodes' transforms ignored), int indices,
// and the base color image's URI ("" if none). Kept on the CPU. Null (after logging why) on failure.
@nodrops declare function Donut_LoadGltfModel(app: AppHandle, path: string): GltfModelHandle;
// A file read whole (path relative to the executable's directory), for TypeScript to parse: its
// size, and bytes [offset, offset + count) into dst, an int (0..255) each (0 past the end).
@nodrops declare function Donut_LoadBinaryFile(app: AppHandle, path: string): BinaryFileHandle;
@nodrops declare function Donut_GetBinaryFileSize(binaryFile: BinaryFileHandle): int;
// The file's bytes, valid as long as the file (e.g. for Donut_TranscodeKtx2).
@nodrops declare function Donut_GetBinaryFileData(binaryFile: BinaryFileHandle): Opaque;
@nodrops declare function Donut_CopyBinaryFileBytes(binaryFile: BinaryFileHandle, offset: int, count: int, dst: Ref<int>): void;
// count little-endian 32-bit values from byte offset into dst (Ref of a `let` int array element)
// as ints; those past the end of the file as 0.
@nodrops declare function Donut_CopyBinaryFileUInts(binaryFile: BinaryFileHandle, offset: int, count: int, dst: Ref<int>): void;
// byteSize bytes of the file from fileOffset into a buffer at bufferOffset, copied during the call
// into an open command list (e.g. a model's vertices from the middle of its file).
@nodrops declare function Donut_WriteBufferFromBinaryFile(binaryFile: BinaryFileHandle, commandList: CommandListHandle, buffer: BufferHandle, bufferOffset: int,
    fileOffset: int, byteSize: int): void;
// A static vertex buffer (or index buffer if isIndexBuffer != 0) of byteSize bytes of the file from
// fileOffset, uploaded by an open command list. Null (after logging why) on failure.
@nodrops declare function Donut_CreateStaticBufferFromBinaryFile(app: AppHandle, commandList: CommandListHandle, binaryFile: BinaryFileHandle,
    fileOffset: int, byteSize: int, isIndexBuffer: boolean, debugName: string): BufferHandle;
// Same, as Donut_CreateStaticGeometryBuffer's: also a ByteAddressBuffer for shaders and an acceleration
// structure build input (its size rounded up to whole uints, the rest zeros).
@nodrops declare function Donut_CreateStaticGeometryBufferFromBinaryFile(app: AppHandle, commandList: CommandListHandle, binaryFile: BinaryFileHandle,
    fileOffset: int, byteSize: int, isIndexBuffer: boolean, debugName: string): BufferHandle;
// A texture level (Donut_CreateTextureWithLevels) from the file's bytes at fileOffset, its rows (of
// 4 x 4 blocks for block-compressed formats) rowPitch bytes apart, copied during the call into an
// open command list.
@nodrops declare function Donut_WriteTextureLevelFromBinaryFile(binaryFile: BinaryFileHandle, commandList: CommandListHandle, texture: TextureHandle, mipLevel: int,
    fileOffset: int, rowPitch: int): void;
// Writes byteSize bytes of data (Ref of a `let` array element, or a Donut data pointer) to a file
// (path as given: absolute, or relative to the current directory). 1 on success.
@nodrops declare function Donut_WriteBinaryFile(path: string, data: Opaque, byteSize: int): int;
@nodrops declare function Donut_GetGltfModelPrimitiveCount(gltfModel: GltfModelHandle): int;
@nodrops declare function Donut_GetGltfModelVertexCount(gltfModel: GltfModelHandle, primitive: int): int;
@nodrops declare function Donut_GetGltfModelIndexCount(gltfModel: GltfModelHandle, primitive: int): int;
// Into dst: Ref(arr[0]) of a `let` f32 array of 8 x the vertex count / int array of the index count.
@nodrops declare function Donut_CopyGltfModelVertices(gltfModel: GltfModelHandle, primitive: int, dst: Ref<f32>): void;
// A primitive's vertex attribute by its name in the file ("COLOR_0",
// "KHR_gaussian_splatting:ROTATION"...): its elements (0 if none), floats per element, and the
// floats themselves (normalized integers converted; count * components into dst).
@nodrops declare function Donut_GetGltfModelAttributeCount(gltfModel: GltfModelHandle, primitive: int, name: string): int;
@nodrops declare function Donut_GetGltfModelAttributeComponents(gltfModel: GltfModelHandle, primitive: int, name: string): int;
@nodrops declare function Donut_CopyGltfModelAttribute(gltfModel: GltfModelHandle, primitive: int, name: string, dst: Ref<f32>): void;
@nodrops declare function Donut_CopyGltfModelIndices(gltfModel: GltfModelHandle, primitive: int, dst: Ref<int>): void;
@nodrops declare function Donut_GetGltfModelBaseColorImage(gltfModel: GltfModelHandle, primitive: int): string;
// The name of the primitive's mesh ("" if none).
// A primitive's material's base color factor (RGBA) into dst (Ref of a `let` f32 array of 4).
@nodrops declare function Donut_CopyGltfModelBaseColorFactor(gltfModel: GltfModelHandle, primitive: int, dst: Ref<f32>): void;
@nodrops declare function Donut_GetGltfModelMeshName(gltfModel: GltfModelHandle, primitive: int): string;
// The index of the primitive's mesh, and its material's alpha mode.
@nodrops declare function Donut_GetGltfModelPrimitiveMesh(gltfModel: GltfModelHandle, primitive: int): int;
@nodrops declare function Donut_GetGltfModelPrimitiveAlphaMode(gltfModel: GltfModelHandle, primitive: int): AlphaMode;
// The nodes that instantiate meshes, in node order: their mesh, and their world transform (16
// floats, column-major as glm) into dst (Ref of a `let` f32 array element).
// A primitive's material's texture (0 base color, 1 normal, 2 metallic-roughness) as an index into
// the file's textures (-1 if none), and its metallic (0) or roughness (1) factor.
@nodrops declare function Donut_GetGltfModelMaterialTexture(gltfModel: GltfModelHandle, primitive: int, which: int): int;
@nodrops declare function Donut_GetGltfModelMaterialFactor(gltfModel: GltfModelHandle, primitive: int, which: int): number;
// The file's textures, and a texture's image URI ("" if none).
@nodrops declare function Donut_GetGltfModelTextureCount(gltfModel: GltfModelHandle): int;
@nodrops declare function Donut_GetGltfModelTextureImage(gltfModel: GltfModelHandle, texture: int): string;
@nodrops declare function Donut_GetGltfModelNodeCount(gltfModel: GltfModelHandle): int;
@nodrops declare function Donut_GetGltfModelNodeMesh(gltfModel: GltfModelHandle, node: int): int;
@nodrops declare function Donut_CopyGltfModelNodeTransform(gltfModel: GltfModelHandle, node: int, dst: Ref<f32>): void;
// An image file (path relative to the executable's directory) decoded with WIC into an RGBA8
// texture as DirectXTK's CreateWICTextureFromFile loads it: one level, sRGB when the file says so
// (a PNG's sRGB chunk, a JPEG's EXIF color space). Its upload recorded into an open command list.
// Windows only; null (after logging why) on failure.
@nodrops declare function Donut_LoadWicTexture(app: AppHandle, commandList: CommandListHandle, path: string, debugName: string): TextureHandle | null;
// Image file, path relative to the executable's directory, uploaded by an open command list.
// sRGB != 0 treats the data as sRGB. Null (after logging why) on failure.
@nodrops declare function Donut_LoadTexture(app: AppHandle, commandList: CommandListHandle, path: string, sRGB: int): TextureHandle;
// A JSON file whose root is an object (owned by the app; null if unreadable), read by path ("a/0/b"): whether there is a
// value, an array's or object's size (-1 if neither), a number, bool or string (defaultValue where missing), and
// component `component` of a 3- or 4-vector (count) as Donut's json::Read reads it (NaN where missing).
@nodrops declare function Donut_LoadJsonDocument(app: AppHandle, path: string): JsonDocumentHandle | null;
@nodrops declare function Donut_JsonHas(json: JsonDocumentHandle, path: string): boolean;
@nodrops declare function Donut_JsonGetSize(json: JsonDocumentHandle, path: string): int;
@nodrops declare function Donut_JsonGetNumber(json: JsonDocumentHandle, path: string, defaultValue: number): number;
@nodrops declare function Donut_JsonGetBool(json: JsonDocumentHandle, path: string, defaultValue: boolean): boolean;
@nodrops declare function Donut_JsonGetString(json: JsonDocumentHandle, path: string, defaultValue: string): string;
@nodrops declare function Donut_JsonGetVector(json: JsonDocumentHandle, path: string, count: int, component: int): number;
// The files in folder matching wildcard (* and ?, case-insensitive): their count; Donut_GetListedFile has their paths.
@nodrops declare function Donut_ListFiles(folder: string, wildcard: string): int;
@nodrops declare function Donut_GetListedFile(index: int): string;

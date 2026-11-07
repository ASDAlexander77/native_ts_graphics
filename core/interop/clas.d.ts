/// <reference path="../donut_handles.d.ts" />
// Cluster acceleration structures (core/clas.cpp)

// Handles of the module's objects (see donut_handles.d.ts).
@cpp declare class ClasHandle extends ObjectHandle { private readonly __clas: index; }

// Clustered geometry (core/clas.cpp, linked only into the examples that list it): cluster level
// acceleration structures (CLASes) built from clusters of triangles, cluster templates instantiated from
// new vertex positions, cluster BLASes built from CLASes - batches of operations reading their arguments
// from buffers (D3D12's preview: Donut_EnableD3D12RaytracingPreview before the app; Vulkan's
// VK_NV_cluster_acceleration_structure). Null where they aren't supported. Free it with
// Donut_DestroyClas before the app.
@nodrops declare function Donut_CreateClas(device: Opaque): ClasHandle | null;
@nodrops declare function Donut_DestroyClas(clas: ClasHandle): void;
// A buffer of byteSize for operations' results (CLASes, templates, cluster BLASes), or a raw buffer (a
// RWByteAddressBuffer to shaders) for their arguments, scratch, and results' addresses and sizes. The
// Clas's (Donut_ReleaseClasBuffer frees one sooner).
@nodrops declare function Donut_CreateClasStorage(clas: ClasHandle, byteSize: number, debugName: string): BufferHandle;
@nodrops declare function Donut_CreateClasBuffer(clas: ClasHandle, byteSize: number, debugName: string): BufferHandle;
@nodrops declare function Donut_ReleaseClasBuffer(clas: ClasHandle, buffer: BufferHandle): void;
// Stores the GPU address of byte `offset` of `buffer` at dst[0] (low 32 bits) and dst[1] (high).
@nodrops declare function Donut_GetClasBufferAddress(clas: ClasHandle, buffer: BufferHandle, offset: number, dst: Ref<int>): void;
// An operation is described by 17 ints (core/clas.cpp's ClasParam, D3D12's enumeration values): type (0
// move, 1 cluster BLASes from CLASes, 2 CLASes from triangles, 3 templates from triangles, 4 CLASes
// instantiated from templates), mode (0 implicit destinations, 1 explicit, 2 sizes only), flags (4 fast
// trace, 8 fast operation, 0x100 allow data access; moves: 0x200 no overlap), max argument count, the
// cluster limits (max geometry index value, max unique geometry indices per cluster, max triangles and
// vertices per cluster, max total triangles and vertices), vertex format (2 FLOAT32_3, 14 COMPRESSED1;
// templates: their instantiation format), templates' hint vertex format, CLASes' min position
// truncate bit count (or COMPRESSED1's max compressed size), cluster BLASes' max total and per BLAS
// CLAS counts, moves' type (0 cluster BLASes, 1 CLASes, 2 templates) and max bytes moved.
// The sizes it needs: sizes[0] its results' storage at most, sizes[1] its scratch.
@nodrops declare function Donut_GetClasOperationSizes(clas: ClasHandle, params: Ref<int>, sizes: Ref<number>): void;
// Records an operation reading its arguments from `args` (byte argsOffset on, argsStride apart; their
// count from argCount's first uint if not null, else the max argument count) with `scratch`. `storage`
// receives the results: all of them with implicit destinations (their addresses written to
// `addresses`), where `addresses` says with explicit ones. `sizes` (or null) receives each result's size
// (uint64). input0 / input1 (or null): buffers the arguments point into (vertices, indices, CLASes,
// templates, address arrays).
@nodrops declare function Donut_ExecuteClasOperation(clas: ClasHandle, commandList: CommandListHandle, params: Ref<int>,
    args: BufferHandle, argsOffset: number, argsStride: int, argCount: BufferHandle | null,
    storage: BufferHandle | null, scratch: BufferHandle, addresses: BufferHandle | null, addressesOffset: number,
    sizes: BufferHandle | null, sizesOffset: number, input0: BufferHandle | null, input1: BufferHandle | null): void;
// A TLAS of up to maxInstances (buildFlags: AccelStructBuildFlags) built from buffers of
// D3D12_RAYTRACING_INSTANCE_DESC (Donut_BuildClasTlas), whose BLASes may be cluster BLASes. The Clas's
// (Donut_ReleaseClasTlas frees it sooner).
@nodrops declare function Donut_CreateClasTlas(clas: ClasHandle, maxInstances: int, buildFlags: int, debugName: string): AccelStructHandle;
@nodrops declare function Donut_ReleaseClasTlas(clas: ClasHandle, tlas: AccelStructHandle): void;
// Stores an acceleration structure's GPU address (for an instance buffer) at dst[0] (low 32 bits) and dst[1].
@nodrops declare function Donut_GetClasAccelStructAddress(clas: ClasHandle, accelStruct: AccelStructHandle, dst: Ref<int>): void;
// Records the compaction of the BLASes built with AllowCompaction whose builds finished since (their
// addresses change).
@nodrops declare function Donut_CompactClasBlases(clas: ClasHandle, commandList: CommandListHandle): void;
@nodrops declare function Donut_BuildClasTlas(clas: ClasHandle, commandList: CommandListHandle, tlas: AccelStructHandle,
    instances: BufferHandle, instanceCount: int, buildFlags: int): void;

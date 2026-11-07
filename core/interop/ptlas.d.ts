/// <reference path="../donut_handles.d.ts" />
// Partitioned TLAS (core/ptlas.cpp)

// Handles of the module's objects (see donut_handles.d.ts).
@cpp declare class PtlasHandle extends ObjectHandle { private readonly __ptlas: index; }

// Partitioned top level acceleration structures (core/ptlas.cpp, linked only into the examples that list it):
// Vulkan's VK_NV_partitioned_acceleration_structure and D3D12's preview PTLAS, built by operations whose
// arguments shaders write. Enables D3D12's experimental features of the preview; call before creating a
// D3D12 app (whose executable links core/d3d12_preview_sdk.cpp). 1 on success, 0 without the preview or
// Windows' Developer Mode.
@nodrops declare function Donut_EnableD3D12RaytracingPreview(): int;
// A PTLAS on the app's device (Donut_GetNvrhiDevice) of instanceCount instance slots in partitionCount
// partitions of up to maxInstancesPerPartition, and a global partition of up to
// maxInstancesInGlobalPartition; flags: 1 fast trace, 2 fast build, 4 partition translation, 8 an updatable
// reference TLAS (Donut_UpdatePtlasReferenceTlas). Null where PTLASes aren't supported. Free it with
// Donut_DestroyPtlas before the app.
@nodrops declare function Donut_CreatePtlas(device: Opaque, instanceCount: int, maxInstancesPerPartition: int, partitionCount: int,
    maxInstancesInGlobalPartition: int, flags: int): PtlasHandle | null;
@nodrops declare function Donut_DestroyPtlas(ptlas: PtlasHandle): void;
// The PTLAS's buffer, to bind with Donut_BindPartitionedAccelStruct (the Ptlas's: don't release it).
@nodrops declare function Donut_GetPtlasBuffer(ptlas: PtlasHandle): BufferHandle;
// The arguments the next build's operations read, RWByteAddressBuffers for shaders to write: instance
// writes (104 bytes each, laid out differently on Vulkan and D3D12), instance updates and partition
// translations (16 bytes each); room for one per instance slot or partition.
@nodrops declare function Donut_GetPtlasWriteInstanceArgs(ptlas: PtlasHandle): BufferHandle;
@nodrops declare function Donut_GetPtlasUpdateInstanceArgs(ptlas: PtlasHandle): BufferHandle;
@nodrops declare function Donut_GetPtlasTranslatePartitionArgs(ptlas: PtlasHandle): BufferHandle;
// Writes accelStruct's address as instances reference it to dst (two ints, low half first).
@nodrops declare function Donut_PtlasStoreAccelStructAddress(ptlas: PtlasHandle, accelStruct: AccelStructHandle, dst: Ref<int>): void;
// Records a build on an open command list from the first writeCount instance writes, updateCount instance
// updates and translateCount partition translations of the argument buffers: the first from nothing,
// later ones in place. An instance or a partition in one operation at most.
@nodrops declare function Donut_BuildPtlas(ptlas: PtlasHandle, commandList: CommandListHandle, writeCount: int, updateCount: int, translateCount: int): void;
// The operation buffer (a 4-byte operation count, then 24-byte operations from byte 8), a
// RWByteAddressBuffer (the Ptlas's: don't release it).
@nodrops declare function Donut_GetPtlasOperations(ptlas: PtlasHandle): BufferHandle;
// Records the operation buffer's reset to one instance-write operation of no arguments, for shaders to
// append instance writes to: each adds 1 to its argument count (InterlockedAdd at byte 12) and fills the
// write arguments' record of the slot it got back.
@nodrops declare function Donut_ResetPtlasGpuWrites(ptlas: PtlasHandle, commandList: CommandListHandle): void;
// Records a build from the operations the operation buffer holds now (Donut_ResetPtlasGpuWrites' operation,
// its count as shaders left it).
@nodrops declare function Donut_BuildPtlasFromOperations(ptlas: PtlasHandle, commandList: CommandListHandle): void;
// An ordinary TLAS of as many instances, to check the PTLAS against (bind with Donut_BindAccelStruct), and
// its instances (D3D12_RAYTRACING_INSTANCE_DESC / VkAccelerationStructureInstanceKHR, 64 bytes each, a
// RWByteAddressBuffer). The Ptlas's: don't release them.
@nodrops declare function Donut_GetPtlasReferenceTlas(ptlas: PtlasHandle): AccelStructHandle;
@nodrops declare function Donut_GetPtlasReferenceInstances(ptlas: PtlasHandle): BufferHandle;
// Records a build of the reference TLAS from the first instanceCount instances.
@nodrops declare function Donut_BuildPtlasReferenceTlas(ptlas: PtlasHandle, commandList: CommandListHandle, instanceCount: int): void;
// Same, refitting it in place if refit is non-zero and it was created updatable (flag 8), else anew.
@nodrops declare function Donut_UpdatePtlasReferenceTlas(ptlas: PtlasHandle, commandList: CommandListHandle, instanceCount: int, refit: int): void;

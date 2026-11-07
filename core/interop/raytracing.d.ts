/// <reference path="../donut_handles.d.ts" />
/// <reference path="resources.d.ts" />
/// <reference path="pipelines.d.ts" />
// Ray tracing: BLAS/TLAS and opacity micromaps, ray tracing pipelines and shader tables

// nvrhi::rt::AccelStructBuildFlags bits (Donut_BuildTriangleBlas).
enum AccelStructBuildFlags {
    None = 0,
    AllowUpdate = 1,
    AllowCompaction = 2,
    PreferFastTrace = 4,
    PreferFastBuild = 8,
    MinimizeMemory = 0x10,
    // Hit shaders can read the vertex positions of the triangles they hit (Vulkan;
    // Feature.RayTracingPositionFetch).
    AllowDataAccess = 0x40
}
// The usage counts of an opacity micromap array by a geometry's triangles
// (Donut_SetTriangleBlasGeometryOpacityMicromap) from the file's data: indexCount OMM indices
// (indexFormat R16_UINT or R32_UINT) at indexOffset, indexing descCount per-OMM descs at descOffset
// (as Donut_CreateOpacityMicromap takes them). Writes up to maxEntries entries of three ints (count,
// subdivision level, format) into dst (Ref of a `let` int array); returns how many there are.
@nodrops declare function Donut_CountOpacityMicromapUsage(binaryFile: BinaryFileHandle, indexOffset: int, indexCount: int, indexFormat: Format,
    descOffset: int, descCount: int, dst: Ref<int>, maxEntries: int): int;

// Input for acceleration structure builds (index or vertex data).
@nodrops declare function Donut_CreateAccelStructInputBuffer(app: AppHandle, byteSize: int, debugName: string): BufferHandle;
// Same, that shaders also read as a ByteAddressBuffer (Donut_BindRawBufferSRV).
@nodrops declare function Donut_CreateAccelStructInputRawBuffer(app: AppHandle, byteSize: int, debugName: string): BufferHandle;
// Same, that shaders also read as a StructuredBuffer of count elements of stride bytes.
@nodrops declare function Donut_CreateAccelStructInputStructuredBuffer(app: AppHandle, stride: int, count: int, debugName: string): BufferHandle;
// Same, that compute shaders also write (RWStructuredBuffer): e.g. vertices animated on the GPU
// each frame before the BLAS over them is rebuilt.
@nodrops declare function Donut_CreateRWAccelStructInputStructuredBuffer(app: AppHandle, stride: int, count: int, debugName: string): BufferHandle;

// Acceleration structures; both record their build into an open command list.
// Opaque triangles: R32_UINT indices, RGB32_FLOAT vertices.
@nodrops declare function Donut_BuildTriangleBLAS(app: AppHandle, commandList: CommandListHandle, indexBuffer: BufferHandle, indexCount: int, vertexBuffer: BufferHandle, vertexCount: int): AccelStructHandle;
// One instance of bottomLevelAS: identity transform, mask 1, counter-clockwise front faces.
@nodrops declare function Donut_BuildSingleInstanceTLAS(app: AppHandle, commandList: CommandListHandle, bottomLevelAS: AccelStructHandle): AccelStructHandle;
// One opaque triangle geometry: indexCount R32_UINT indices from indexByteOffset of indexBuffer,
// into vertexCount RGB32_FLOAT positions every vertexStride bytes from vertexByteOffset of
// vertexBuffer. Build recorded into an open command list, preferring fast tracing, or if
// updatable != 0 fast builds and updates.
@nodrops declare function Donut_CreateTriangleBlas(app: AppHandle, commandList: CommandListHandle, indexBuffer: BufferHandle, indexByteOffset: int,
    indexCount: int, vertexBuffer: BufferHandle, vertexByteOffset: int, vertexCount: int, vertexStride: int, updatable: int,
    debugName: string): TriangleBlasHandle;
// An updatable one, in place, from its buffers' current contents, into an open command list.
@nodrops declare function Donut_UpdateTriangleBlas(triangleBlas: TriangleBlasHandle, commandList: CommandListHandle): void;
// A bottom-level acceleration structure of several geometries: add them with
// Donut_AddTriangleBlasGeometry, then build it with Donut_BuildTriangleBlas.
@nodrops declare function Donut_CreateEmptyTriangleBlas(app: AppHandle, debugName: string): TriangleBlasHandle;
// Opaque triangles: indexCount R32_UINT indices at indexByteOffset of indexBuffer, vertexCount
// RGB32_FLOAT positions vertexStride bytes apart at vertexByteOffset of vertexBuffer (acceleration
// structure input buffers), transformed by transform (12 floats, 3 rows of 4) or not (null).
@nodrops declare function Donut_AddTriangleBlasGeometry(triangleBlas: TriangleBlasHandle, indexBuffer: BufferHandle, indexByteOffset: int, indexCount: int,
    vertexBuffer: BufferHandle, vertexByteOffset: int, vertexCount: int, vertexStride: int, transform: Ref<f32> | null): void;
// Same, with R16_UINT indices.
@nodrops declare function Donut_AddTriangleBlasGeometry16(triangleBlas: TriangleBlasHandle, indexBuffer: BufferHandle, indexByteOffset: int, indexCount: int,
    vertexBuffer: BufferHandle, vertexByteOffset: int, vertexCount: int, vertexStride: int, transform: Ref<f32> | null): void;
// Opaque procedural primitives instead: aabbCount boxes (6 floats each, min x y z then max x y z),
// aabbStride bytes apart at byteOffset of aabbBuffer (an acceleration structure input buffer),
// intersected by the hit groups' intersection shaders (Donut_RtPipelineAddProceduralHitGroup). A
// BLAS holds triangles or AABBs, not both.
@nodrops declare function Donut_AddTriangleBlasAabbGeometry(triangleBlas: TriangleBlasHandle, aabbBuffer: BufferHandle, byteOffset: int, aabbCount: int,
    aabbStride: int): void;
// An unbuilt BLAS's geometryIndex-th geometry's nvrhi::rt::GeometryFlags (1 opaque, the default; 0
// for any-hit shaders to run on it; 2 no duplicate any-hit invocations).
@nodrops declare function Donut_SetTriangleBlasGeometryFlags(triangleBlas: TriangleBlasHandle, geometryIndex: int, flags: int): void;
// Links an unbuilt BLAS's geometryIndex-th triangle geometry to an opacity micromap array
// (Donut_CreateOpacityMicromap): an OMM index per triangle, ommIndexFormat (R16_UINT or R32_UINT)
// values at ommIndexOffset of ommIndexBuffer (an acceleration structure input buffer; negative
// ones the special fully transparent / opaque indices); usageCounts (Ref of a `let` int array)
// holds numUsageCounts entries of three ints, how many triangles use OMMs of a subdivision level
// and format (Donut_CountOpacityMicromapUsage; Vulkan's builds need them). The BLAS keeps the array.
@nodrops declare function Donut_SetTriangleBlasGeometryOpacityMicromap(triangleBlas: TriangleBlasHandle, geometryIndex: int, opacityMicromap: OpacityMicromapHandle,
    ommIndexBuffer: BufferHandle, ommIndexOffset: int, ommIndexFormat: Format, usageCounts: Ref<int>, numUsageCounts: int): void;
// An opacity micromap array (requires Feature.RayTracingOpacityMicromap), built into an open
// command list from inputBuffer's raw OMM data at inputOffset and perOmmDescs' descs at
// descsOffset (acceleration structure input buffers; descs as D3D12_RAYTRACING_OPACITY_MICROMAP_DESC
// and VkMicromapTriangleEXT have them: 32-bit data offset, 16-bit subdivision level, 16-bit format);
// usageCounts (Ref of a `let` int array) holds numUsageCounts entries of three ints, how many OMMs
// the array has of a subdivision level and format (D3D12's histogram). buildFlags:
// nvrhi::rt::OpacityMicromapBuildFlags bits (1 fast trace, 2 fast build). Null on failure.
@nodrops declare function Donut_CreateOpacityMicromap(app: AppHandle, commandList: CommandListHandle, inputBuffer: BufferHandle, inputOffset: int,
    perOmmDescs: BufferHandle, descsOffset: int, usageCounts: Ref<int>, numUsageCounts: int, buildFlags: int,
    debugName: string): OpacityMicromapHandle | null;
// Builds such an array again, in place, from its inputs' current contents, into an open command list.
@nodrops declare function Donut_BuildOpacityMicromap(commandList: CommandListHandle, opacityMicromap: OpacityMicromapHandle): void;
// Builds the BLAS of the geometries added (AccelStructBuildFlags bits), recorded into an open
// command list; 0 on failure.
@nodrops declare function Donut_BuildTriangleBlas(triangleBlas: TriangleBlasHandle, app: AppHandle, commandList: CommandListHandle, buildFlags: AccelStructBuildFlags): int;
// Builds a built one again, in place (not an update), from its geometries' current contents, into
// an open command list.
@nodrops declare function Donut_RebuildTriangleBlas(triangleBlas: TriangleBlasHandle, commandList: CommandListHandle): void;
// Points a BLAS's geometryIndex-th triangle geometry at another vertex buffer (same layout and
// vertex count, from byte 0) for the next rebuild: e.g. ping-ponged vertex buffers.
@nodrops declare function Donut_SetTriangleBlasGeometryVertexBuffer(triangleBlas: TriangleBlasHandle, geometryIndex: int, vertexBuffer: BufferHandle): void;
// For Donut_AddTopLevelASInstanceWithTransform; valid as long as the BLAS.
@nodrops declare function Donut_GetTriangleBlasAccelStruct(triangleBlas: TriangleBlasHandle): AccelStructHandle;

// One ray generation shader, one miss shader and one triangle hit group (closest hit only, or
// no shader at all if closestHitEntry is ""), taken from shaderLibrary by entry name, plus one
// global binding layout.
@nodrops declare function Donut_CreateRayTracingPipeline(app: AppHandle, shaderLibrary: ShaderLibraryHandle, bindingLayout: BindingLayoutHandle,
    rayGenEntry: string, missEntry: string, hitGroupName: string, closestHitEntry: string, maxPayloadSize: int): RtPipelineHandle;
// One ray generation shader, hit group and miss shader, by export name; keeps the pipeline alive.
@nodrops declare function Donut_CreateShaderTable(app: AppHandle, rayTracingPipeline: RtPipelineHandle, rayGenExport: string, hitGroupExport: string, missExport: string): ShaderTableHandle;
// Same, kept in GPU memory in up to maxCachedVersions copies instead of re-uploaded on every use.
@nodrops declare function Donut_CreateCachedShaderTable(app: AppHandle, rayTracingPipeline: RtPipelineHandle, rayGenExport: string, hitGroupExport: string,
    missExport: string, maxCachedVersions: int, debugName: string): ShaderTableHandle;
// Like Donut_CreateRayTracingPipeline, with an any-hit shader too (either hit shader may be ""),
// and a second global binding layout (e.g. bindless; null for none).
@nodrops declare function Donut_CreateRayTracingPipelineWithLayouts(app: AppHandle, shaderLibrary: ShaderLibraryHandle, bindingLayout: BindingLayoutHandle,
    secondBindingLayout: BindingLayoutHandle | null, rayGenEntry: string, missEntry: string, hitGroupName: string, closestHitEntry: string,
    anyHitEntry: string, maxPayloadSize: int): RtPipelineHandle;
// RaytracingAccelerationStructure at t<slot>.
@nodrops declare function Donut_BindAccelStruct(bindingSetDesc: BindingSetDescHandle, slot: int, accelStruct: AccelStructHandle): void;
// A partitioned TLAS (core/ptlas.ts's Ptlas.getBuffer) as a RaytracingAccelerationStructure at t<slot>.
@nodrops declare function Donut_BindPartitionedAccelStruct(bindingSetDesc: BindingSetDescHandle, slot: int, buffer: BufferHandle): void;
@nodrops declare function Donut_LayoutAccelStruct(bindingLayoutDesc: BindingLayoutDescHandle, slot: int): void;
@nodrops declare function Donut_LayoutPartitionedAccelStruct(bindingLayoutDesc: BindingLayoutDescHandle, slot: int): void;

// Ray tracing pipelines of any shape: a description built with the Donut_RtPipeline* functions,
// freed by Donut_CreateRayTracingPipelineFromDesc. maxRecursionDepth 1 = no rays from hit shaders.
@nodrops declare function Donut_CreateRayTracingPipelineDesc(maxPayloadSize: int, maxRecursionDepth: int): RtPipelineDescHandle;
@nodrops declare function Donut_RtPipelineAddGlobalBindingLayout(pipelineDesc: RtPipelineDescHandle, bindingLayout: BindingLayoutHandle): void;
// A ray generation or miss shader, exported by its entry name.
@nodrops declare function Donut_RtPipelineAddShader(pipelineDesc: RtPipelineDescHandle, shaderLibrary: ShaderLibraryHandle, entryName: string, shaderType: ShaderType): void;
// Triangle hit group; "" for no closest-hit / any-hit shader; an optional local binding layout
// (D3D12 only), whose binding sets come with each shader table entry.
@nodrops declare function Donut_RtPipelineAddHitGroup(pipelineDesc: RtPipelineDescHandle, shaderLibrary: ShaderLibraryHandle, exportName: string,
    closestHitEntry: string, anyHitEntry: string, localBindingLayout: BindingLayoutHandle | null): void;
// Procedural primitive hit group, for AABB geometries (Donut_AddTriangleBlasAabbGeometry): its
// intersection shader by entry name, then closest-hit / any-hit shaders as above ("" for none).
@nodrops declare function Donut_RtPipelineAddProceduralHitGroup(pipelineDesc: RtPipelineDescHandle, shaderLibrary: ShaderLibraryHandle, exportName: string,
    intersectionEntry: string, closestHitEntry: string, anyHitEntry: string, localBindingLayout: BindingLayoutHandle | null): void;
// The largest hit attributes the pipeline's shaders pass (ReportHit's attributes; the default is 8
// bytes, the triangles' barycentrics). D3D12 only: Vulkan takes it from the shaders.
@nodrops declare function Donut_RtPipelineSetMaxAttributeSize(pipelineDesc: RtPipelineDescHandle, byteSize: int): void;
// The UAV slot (register space 0) the pipeline's shaders reach NVAPI's shader extensions (nvHLSLExtns.h) through;
// -1, the default, for none. D3D12 only.
@nodrops declare function Donut_RtPipelineSetHlslExtensionsUAV(pipelineDesc: RtPipelineDescHandle, slot: int): void;
// Whether the pipeline's rays see the opacity micromaps of the BLASes they trace (off by default).
@nodrops declare function Donut_RtPipelineSetAllowOpacityMicromaps(pipelineDesc: RtPipelineDescHandle, allow: boolean): void;
// Whether the pipeline's rays may hit cluster BLASes (core/clas.cpp; D3D12's preview, off by default).
@nodrops declare function Donut_RtPipelineSetAllowClusteredGeometry(pipelineDesc: RtPipelineDescHandle, allow: boolean): void;
@nodrops declare function Donut_CreateRayTracingPipelineFromDesc(app: AppHandle, pipelineDesc: RtPipelineDescHandle): RtPipelineHandle;
// Shader tables of any shape, filled with the Donut_ShaderTable* functions; they keep the
// pipeline alive. The Add functions return the new entry's index.
@nodrops declare function Donut_CreateEmptyShaderTable(app: AppHandle, rayTracingPipeline: RtPipelineHandle): ShaderTableHandle;
@nodrops declare function Donut_ShaderTableSetRayGeneration(shaderTable: ShaderTableHandle, exportName: string): void;
@nodrops declare function Donut_ShaderTableAddMiss(shaderTable: ShaderTableHandle, exportName: string): int;
@nodrops declare function Donut_ShaderTableAddHitGroup(shaderTable: ShaderTableHandle, exportName: string, localBindingSet: BindingSetHandle | null): int;
// One BLAS per mesh of a loaded scene and a TLAS over its instances, builds recorded into an
// open command list.
@nodrops declare function Donut_BuildSceneAccelStructs(app: AppHandle, commandList: CommandListHandle, scene: SceneHandle): SceneAccelStructsHandle;
// For Donut_BindAccelStruct; valid as long as the acceleration structures.
@nodrops declare function Donut_GetSceneTopLevelAS(sceneAccelStructs: SceneAccelStructsHandle): AccelStructHandle;
// Like Donut_BuildSceneAccelStructs, for shader tables with hitGroupStride entries per geometry in
// global geometry index order.
@nodrops declare function Donut_BuildSceneAccelStructsWithHitGroupStride(app: AppHandle, commandList: CommandListHandle, scene: SceneHandle,
    hitGroupStride: int): SceneAccelStructsHandle;
// For animated scenes: one BLAS per mesh (alpha-tested geometries non-opaque, static ones
// compacted later), builds recorded into an open command list, plus a TLAS built every frame by
// Donut_UpdateSceneAccelStructs. Get the TLAS with Donut_GetSceneTopLevelAS.
@nodrops declare function Donut_CreateAnimatedSceneAccelStructs(app: AppHandle, commandList: CommandListHandle, scene: SceneHandle): SceneAccelStructsHandle;
// Valid only inside a render callback, after Donut_RefreshScene: rebuilds the skinned BLASes,
// compacts finished static ones and builds the TLAS (instance IDs = instance indices).
@nodrops declare function Donut_UpdateSceneAccelStructs(app: AppHandle, frame: FrameHandle, sceneAccelStructs: SceneAccelStructsHandle, scene: SceneHandle): void;
// A BLAS for every scene mesh without one (not dynamic meshes), into an open command list;
// geometries not in the Opaque material domain are non-opaque.
@nodrops declare function Donut_BuildSceneBLASes(app: AppHandle, commandList: CommandListHandle, scene: SceneHandle): void;
// A BLAS of one AABB (-1..1 on each axis), built into an open command list.
@nodrops declare function Donut_CreateUnitAABBBlas(app: AppHandle, commandList: CommandListHandle, debugName: string): AccelStructHandle;
// A TLAS of up to maxInstances, rebuilt by Donut_BuildTopLevelAS from the instances added since
// the last build. Get the TLAS with Donut_GetSceneTopLevelAS.
@nodrops declare function Donut_CreateTopLevelAS(app: AppHandle, maxInstances: int): SceneAccelStructsHandle;
// Same, built with buildFlags (e.g. AllowUpdate, for Donut_UpdateTopLevelAS).
@nodrops declare function Donut_CreateTopLevelASWithFlags(app: AppHandle, maxInstances: int, buildFlags: AccelStructBuildFlags): SceneAccelStructsHandle;
// The scene's mesh instances (instance ID = instance index) with instanceMask, dynamicMesh's (if
// not null) with dynamicMeshMask.
@nodrops declare function Donut_AddSceneTopLevelASInstances(sceneAccelStructs: SceneAccelStructsHandle, scene: SceneHandle, instanceMask: int,
    dynamicMesh: DynamicMeshHandle | null, dynamicMeshMask: int): void;
// A BLAS instance scaled by `scale`, then moved to (x, y, z).
@nodrops declare function Donut_AddTopLevelASInstance(sceneAccelStructs: SceneAccelStructsHandle, bottomLevelAS: AccelStructHandle, instanceMask: int, instanceID: int,
    scale: number, x: number, y: number, z: number): void;
// A BLAS instance with a transform: Ref(arr[0]) of a `let` f32[12], a row-major 3x4 matrix with the
// translation in the last column (Vulkan's VkTransformMatrixKHR). flags: nvrhi::rt::InstanceFlags bits
// (1 = no triangle culling).
@nodrops declare function Donut_AddTopLevelASInstanceWithTransform(sceneAccelStructs: SceneAccelStructsHandle, bottomLevelAS: AccelStructHandle, instanceMask: int,
    instanceID: int, flags: int, transform: Ref<f32>): void;
// Same, with the instance's hit group index offset (instanceContributionToHitGroupIndex): which of
// the shader table's hit groups its hits run.
@nodrops declare function Donut_AddTopLevelASInstanceWithHitGroup(sceneAccelStructs: SceneAccelStructsHandle, bottomLevelAS: AccelStructHandle, instanceMask: int,
    instanceID: int, hitGroupIndex: int, flags: int, transform: Ref<f32>): void;
// Valid only inside a render callback.
@nodrops declare function Donut_BuildTopLevelAS(frame: FrameHandle, sceneAccelStructs: SceneAccelStructsHandle): void;
// Valid only inside a render callback: refits the TLAS in place to the instances added since the
// last build (new transforms, same instance count) instead of building it anew. Needs an AllowUpdate
// TLAS; builds it instead the first time or when the instance count changed. 1 if it refitted.
@nodrops declare function Donut_UpdateTopLevelAS(frame: FrameHandle, sceneAccelStructs: SceneAccelStructsHandle): int;
// Traces width x height rays with a shader table, with bindingSet as its global bindings.
@nodrops declare function Donut_DispatchRays(frame: FrameHandle, shaderTable: ShaderTableHandle, bindingSet: BindingSetHandle, width: int, height: int): void;
// Same, with a descriptor table bound after the binding set.
@nodrops declare function Donut_DispatchRaysWithDescriptorTable(frame: FrameHandle, shaderTable: ShaderTableHandle, bindingSet: BindingSetHandle,
    descriptorTable: DescriptorTableHandle, width: int, height: int): void;
// Same, with two binding sets before the descriptor table (a pipeline of two ordinary binding layouts
// and a bindless one).
@nodrops declare function Donut_DispatchRaysWithBindingSets(frame: FrameHandle, shaderTable: ShaderTableHandle, bindingSet: BindingSetHandle,
    secondBindingSet: BindingSetHandle, descriptorTable: DescriptorTableHandle, width: int, height: int): void;

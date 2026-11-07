/// <reference path="../donut_handles.d.ts" />
// D3D12 only: work graphs, library ray tracing pipelines, generic programs, the shading rate
// image

@nodrops declare function Donut_GetD3D12ShadingRateTileSize(app: AppHandle): int;
// The same through D3D12 directly (D3D12 only), instead of the two functions above; valid only
// inside a render callback, Begin and End around the draws.
@nodrops declare function Donut_BeginD3D12ShadingRateImage(frame: FrameHandle, shadingRateSurface: TextureHandle): void;
@nodrops declare function Donut_EndD3D12ShadingRateImage(frame: FrameHandle, shadingRateSurface: TextureHandle): void;

// D3D12 work graphs, through D3D12 directly. They need the Agility SDK runtime: the executable
// must be linked with d3d12_agility_sdk.cpp (see CMakeLists.txt).
// D3D12_WORK_GRAPHS_TIER: 0 unsupported (or not D3D12), 10 for tier 1.0, 11 for tier 1.1.
@nodrops declare function Donut_GetD3D12WorkGraphsTier(app: AppHandle): int;
// A work graph program of all the nodes of a shader library (lib_6_8), with computePipeline's
// root signature, and its broadcasting entry node's dispatch grid set to gridX x gridY x gridZ;
// plus its backing memory. Release it with Donut_ReleaseObject. Null (after logging why) on failure.
@nodrops declare function Donut_CreateD3D12WorkGraph(app: AppHandle, shaderLibrary: ShaderLibraryHandle, computePipeline: ComputePipelineHandle, programName: string,
    entryNodeName: string, gridX: int, gridY: int, gridZ: int): D3D12WorkGraphHandle | null;
// Launches the graph with one empty entry record, bindingSet and byteSize bytes of push constants
// from data as its root arguments, set through computePipeline (one with the same root signature;
// don't dispatch with it after the graph in the same command list). initializeBackingMemory
// non-zero on the backing memory's first use, or after another graph used it.
@nodrops declare function Donut_DispatchD3D12WorkGraph(commandList: CommandListHandle, workGraph: D3D12WorkGraphHandle, computePipeline: ComputePipelineHandle, bindingSet: BindingSetHandle,
    data: Opaque, byteSize: int, initializeBackingMemory: int): void;

// D3D12 ray tracing pipelines from DXIL library subobjects, through D3D12 directly: the library's
// HLSL defines the global and local root signatures, their associations, the hit groups and the
// shader and pipeline configs. exports: the comma-separated shaders and subobjects to take from
// the library (all if empty); the global root signature comes from the library's bytecode;
// descriptorCount: its block of descriptors for descriptor tables. Release it with
// Donut_ReleaseObject. Null (after logging why) on failure or other APIs.
@nodrops declare function Donut_CreateD3D12LibraryRtPipeline(app: AppHandle, shaderLibrary: ShaderLibraryHandle, exports: string, descriptorCount: int): D3D12LibraryRtPipelineHandle | null;
// Its shader table: one ray generation, one miss and one hit group record, by export name; the hit
// group's with byteSize bytes of local root arguments from data. 0 on failure.
@nodrops declare function Donut_SetD3D12LibraryRtShaderTable(app: AppHandle, libraryRtPipeline: D3D12LibraryRtPipelineHandle, rayGeneration: string, miss: string, hitGroup: string,
    data: Opaque, byteSize: int): int;
// Its descriptor at index (set while no frame in flight uses it): a UAV of a 2D texture's first
// level; an SRV of a whole buffer, raw (structureStride 0) or structured.
// Same, from several hit groups: a ray generation record with rayGenArgsSize bytes of local root
// arguments from rayGenArgs, a miss record, and recordCount hit group records, record i the hit
// group recordHitGroups[i] (Ref of an int array: indices into the comma-separated hitGroups) with
// argsSize bytes of local root arguments from recordArgs + i * argsSize. 0 on failure.
@nodrops declare function Donut_SetD3D12LibraryRtShaderTableRecords(app: AppHandle, libraryRtPipeline: D3D12LibraryRtPipelineHandle, rayGeneration: string,
    rayGenArgs: Opaque | null, rayGenArgsSize: int, miss: string, hitGroups: string, recordHitGroups: Ref<int>, recordCount: int, recordArgs: Opaque,
    argsSize: int): int;
@nodrops declare function Donut_SetD3D12LibraryRtDescriptorTextureUAV(app: AppHandle, libraryRtPipeline: D3D12LibraryRtPipelineHandle, index: int, texture: TextureHandle): void;
// An SRV of a 2D texture (all its levels).
@nodrops declare function Donut_SetD3D12LibraryRtDescriptorTextureSRV(app: AppHandle, libraryRtPipeline: D3D12LibraryRtPipelineHandle, index: int, texture: TextureHandle): void;
@nodrops declare function Donut_SetD3D12LibraryRtDescriptorBufferSRV(app: AppHandle, libraryRtPipeline: D3D12LibraryRtPipelineHandle, index: int, buffer: BufferHandle,
    structureStride: int): void;
// The global root signature's parameter rootParameter in its dispatches: a descriptor table from
// its descriptor firstDescriptor on, a TLAS's root SRV, or a constant buffer's root CBV.
@nodrops declare function Donut_SetD3D12LibraryRtRootDescriptorTable(libraryRtPipeline: D3D12LibraryRtPipelineHandle, rootParameter: int, firstDescriptor: int): void;
@nodrops declare function Donut_SetD3D12LibraryRtRootAccelStruct(libraryRtPipeline: D3D12LibraryRtPipelineHandle, rootParameter: int, accelStruct: AccelStructHandle): void;
@nodrops declare function Donut_SetD3D12LibraryRtRootConstantBuffer(libraryRtPipeline: D3D12LibraryRtPipelineHandle, rootParameter: int, buffer: BufferHandle): void;
// Traces width x height rays with it (the resources' states set through NVRHI, NVRHI's bindings
// cleared after).
@nodrops declare function Donut_DispatchD3D12LibraryRays(commandList: CommandListHandle, libraryRtPipeline: D3D12LibraryRtPipelineHandle, width: int, height: int): void;

// D3D_SHADER_MODEL of the device: 0x60 for 6.0 ... 0x69 for 6.9; 0 on other APIs.
@nodrops declare function Donut_GetD3D12ShaderModel(app: AppHandle): int;
// D3D12 generic programs (shader model 6.8; link core/d3d12_agility_sdk.cpp): a graphics pipeline
// made as an executable state object from building blocks: the vertex and pixel shaders as DXIL
// libraries (the vertex shader exported renamed as vertexExport, the pixel shader under its entry
// point's name pixelExport), inputLayout's attributes, pipeline's root signature, triangles, and the render
// target formats of pipeline's framebuffer; default rasterizer, blend and depth states. Release it
// with Donut_ReleaseObject. Null (after logging why) on failure.
@nodrops declare function Donut_CreateD3D12GenericProgram(app: AppHandle, pipeline: GraphicsPipelineHandle, inputLayout: InputLayoutHandle,
    vertexShader: ShaderHandle, vertexExport: string, pixelShader: ShaderHandle, pixelExport: string, programName: string): D3D12GenericProgramHandle | null;
// Another program added to its state object (AddToStateObject): the same vertex shader export with
// another pixel shader. A new state object holding both.
@nodrops declare function Donut_AddD3D12GenericProgram(app: AppHandle, genericProgram: D3D12GenericProgramHandle, pixelShader: ShaderHandle, pixelExport: string,
    programName: string): D3D12GenericProgramHandle | null;
// Draws vertexCount vertices of the draw described (Donut_BeginDraw: pipeline, vertex buffers,
// viewport) with the program in place of the pipeline (SetProgram).
@nodrops declare function Donut_DrawD3D12GenericProgram(frame: FrameHandle, genericProgram: D3D12GenericProgramHandle, vertexCount: int): void;

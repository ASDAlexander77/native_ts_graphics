// --- Donut interop (implemented in donut_interop.cpp) ---------------------------------------

// A method passed as one of these (e.g. `this.onRender`) reaches C++ as a function pointer
// plus its `this` value.
type VoidCallback = () => void;
type RenderCallback = (frame: Opaque) => void;
type AnimateCallback = (elapsedSeconds: number) => void;
type KeyboardCallback = (key: int, scancode: int, action: int, mods: int) => int;
type MousePosCallback = (x: number, y: number) => int;
type MouseButtonCallback = (button: int, action: int, mods: int) => int;
type MouseScrollCallback = (xOffset: number, yOffset: number) => int;

// nvrhi::GraphicsAPI values.
enum GraphicsAPI {
    D3D11 = 0,
    D3D12 = 1,
    VULKAN = 2
}

// nvrhi::Feature values (only the ones used so far).
enum Feature {
    Meshlets = 9,
    RayQuery = 10,
    RayTracingPipeline = 14,
    ShaderSpecializations = 18,
    VariableRateShading = 21
}

// Vertex attributes of Donut_BindGeometryVertexAttribute, with their Buffer<...> element types.
enum GeometryAttribute {
    Position = 0,  // float3
    TexCoord1 = 1, // float2
    Normal = 2,    // float4 (RGBA8_SNORM)
    Tangent = 3    // float4 (RGBA8_SNORM)
}

// Material textures of Donut_BindGeometryMaterialTexture, and what to bind if there's none.
enum MaterialTexture {
    BaseOrDiffuse = 0,
    MetalRoughOrSpecular = 1,
    Normal = 2,
    Emissive = 3,
    Occlusion = 4,
    Transmission = 5,
    Opacity = 6
}

enum FallbackTexture {
    White = 0,
    Black = 1
}

// Buffers of Donut_GetSceneBuffer.
enum SceneBuffer {
    Instances = 0,
    Geometries = 1,
    Materials = 2
}

// Textures of Donut_GetGBufferTexture.
enum GBufferTexture {
    Depth = 0,
    Diffuse = 1,
    Specular = 2,
    Normals = 3,
    Emissive = 4
}

// Textures of Donut_GetTemporalTargetsTexture.
enum TemporalTexture {
    Depth = 0,
    HdrColor = 1,
    ResolvedColor = 2,
    MotionVectors = 3
}

// Bits of Donut_CreateAppWithOptions' options.
enum AppOptions {
    None = 0,
    // Enables the Vulkan ray tracing extensions (D3D12 has them built in).
    RayTracing = 1,
    // Creates a separate compute queue, for Donut_CreateAsyncComputeLoop.
    ComputeQueue = 2,
    // Enables the graphics API's debug layer and NVRHI's validation layer.
    DebugRuntime = 4
}

// nvrhi::PrimitiveType values (only the ones used so far).
enum PrimitiveType {
    TriangleList = 3,
    TriangleStrip = 4
}

// donut::log::Severity values.
enum LogSeverity {
    None = 0,
    Debug = 1,
    Info = 2,
    Warning = 3,
    Error = 4,
    Fatal = 5
}

// Command line helpers: argv is main's argv.
declare function Donut_GetArg(argv: Opaque, index: int): string;
// -d3d11 / -dx11, -d3d12 / -dx12, -vk / -vulkan; D3D12 by default on Windows.
declare function Donut_GetGraphicsAPIFromCommandLine(argc: int, argv: Opaque): GraphicsAPI;
declare function Donut_GraphicsAPIToString(api: GraphicsAPI): string;
// Messages below the severity are dropped.
declare function Donut_SetLogMinSeverity(severity: LogSeverity): void;

// Picks the graphics API from the command line (-d3d11, -d3d12, -vk). Returns null on failure.
declare function Donut_CreateApp(argc: int, argv: Opaque, title: string, width: int, height: int): Opaque;
// Same, for a fixed graphics API.
declare function Donut_CreateAppForAPI(api: GraphicsAPI, title: string, width: int, height: int): Opaque;
// Same, with AppOptions bits.
declare function Donut_CreateAppWithOptions(api: GraphicsAPI, title: string, width: int, height: int, options: AppOptions): Opaque;
// Device without a window, for compute work; adapterIndex -1 picks the default adapter. It has
// no passes: run work with the command list functions. Returns null on failure.
declare function Donut_CreateHeadlessApp(api: GraphicsAPI, adapterIndex: int): Opaque;

// Adapters of one graphics API; null (after logging why) on failure.
declare function Donut_EnumerateAdapters(api: GraphicsAPI): Opaque;
declare function Donut_GetAdapterCount(adapterList: Opaque): int;
declare function Donut_GetAdapterName(adapterList: Opaque, index: int): string;
declare function Donut_GetAdapterMemoryMB(adapterList: Opaque, index: int): int;
declare function Donut_DestroyAdapterList(adapterList: Opaque): void;
// Blocks until the window is closed.
declare function Donut_RunApp(app: Opaque): void;
// Destroys the app with all its passes and resources.
declare function Donut_DestroyApp(app: Opaque): void;
declare function Donut_IsFeatureSupported(app: Opaque, feature: Feature): int;
declare function Donut_GetRendererString(app: Opaque): string;
declare function Donut_SetWindowTitle(app: Opaque, title: string): void;
// Sets "<title> (<graphics API>, <fps> FPS)".
declare function Donut_SetInformativeWindowTitle(app: Opaque, title: string): void;
// Same, with extraInfo appended.
declare function Donut_SetInformativeWindowTitleWithInfo(app: Opaque, title: string, extraInfo: string): void;
// Apps start with vsync on; the change takes effect at the start of the next frame (on Vulkan it
// recreates the swap chain, so the passes get onBackBufferResizing).
declare function Donut_SetVsyncEnabled(app: Opaque, enabled: int): void;
// Lags Donut_SetVsyncEnabled by up to a frame.
declare function Donut_IsVsyncEnabled(app: Opaque): int;
declare function Donut_CloseWindow(app: Opaque): void;

// nvrhi::Format values (only the ones used so far).
enum Format {
    RGBA8_UNORM = 19,
    R32_UINT = 33,
    RGBA16_UINT = 36,
    RGBA16_FLOAT = 38,
    D32 = 53,
    RG32_FLOAT = 43,
    RGB32_FLOAT = 46
}

// Samplers shared through Donut's CommonRenderPasses.
enum CommonSampler {
    PointClamp = 0,
    LinearClamp = 1,
    LinearWrap = 2,
    AnisotropicWrap = 3
}

// nvrhi::ShaderType values.
enum ShaderType {
    Vertex = 0x0001,
    Pixel = 0x0010,
    Compute = 0x0020,
    Amplification = 0x0040,
    Mesh = 0x0080,
    RayGeneration = 0x0100,
    AnyHit = 0x0200,
    ClosestHit = 0x0400,
    Miss = 0x0800,
    All = 0x3FFF
}

// Resources are owned by the app until released or the app is destroyed; null on failure.
// Shaders come from the example's shaders/<example>.cfg, compiled at build time.
declare function Donut_CreateShader(app: Opaque, fileName: string, entryName: string, shaderType: ShaderType): Opaque;
// Specializes one constant ([[vk::constant_id(constantId)]] in HLSL) of a SPIR-V shader;
// requires Feature.ShaderSpecializations (Vulkan only). The UInt variant uses value's bits as-is.
declare function Donut_SpecializeShaderFloat(app: Opaque, shader: Opaque, constantId: int, value: number): Opaque;
declare function Donut_SpecializeShaderUInt(app: Opaque, shader: Opaque, constantId: int, value: int): Opaque;
// Shader library, compiled with -T lib.
declare function Donut_CreateShaderLibrary(app: Opaque, fileName: string): Opaque;
// The permutations compiled with -D defineName=defineValue in the .cfg.
declare function Donut_CreateShaderWithDefine(app: Opaque, fileName: string, entryName: string, shaderType: ShaderType,
    defineName: string, defineValue: string): Opaque;
declare function Donut_CreateShaderLibraryWithDefine(app: Opaque, fileName: string, defineName: string, defineValue: string): Opaque;
// Triangle list, no depth test, for the frame's framebuffer layout.
declare function Donut_CreateGraphicsPipeline(app: Opaque, frame: Opaque, vertexShader: Opaque, pixelShader: Opaque): Opaque;
// Same, with an input layout and one binding layout.
declare function Donut_CreateGraphicsPipelineWithLayouts(app: Opaque, frame: Opaque, vertexShader: Opaque, pixelShader: Opaque, inputLayout: Opaque, bindingLayout: Opaque): Opaque;
// Same, drawing primitiveType, with each layout optional (null for none).
declare function Donut_CreateGraphicsPipelineWithTopology(app: Opaque, frame: Opaque, vertexShader: Opaque, pixelShader: Opaque,
    inputLayout: Opaque | null, bindingLayout: Opaque | null, primitiveType: PrimitiveType): Opaque;
// Same, with amplification + mesh + pixel shaders; requires Feature.Meshlets.
declare function Donut_CreateMeshletPipeline(app: Opaque, frame: Opaque, amplificationShader: Opaque, meshShader: Opaque, pixelShader: Opaque): Opaque;
// A pipeline keeps its own reference to its shaders, so they can be released once it exists.
declare function Donut_ReleaseResource(app: Opaque, resource: Opaque): void;

// Typed buffer of elementCount R32_UINT values. writable != 0: a UAV the GPU writes to;
// otherwise shader-readable only, filled with Donut_WriteBuffer.
declare function Donut_CreateUIntBuffer(app: Opaque, elementCount: int, writable: int, debugName: string): Opaque;
// CPU-readable buffer to copy GPU results into.
declare function Donut_CreateReadbackBuffer(app: Opaque, byteSize: int, debugName: string): Opaque;
// Copies byteSize bytes of a readback buffer to dst once the GPU is done with it (see
// Donut_WaitForIdle). Pass `Ref(array[0])` of a `let` int[] / f32[] array. Returns 0 on failure.
declare function Donut_ReadBuffer(app: Opaque, readbackBuffer: Opaque, dst: Opaque, byteSize: int): int;
// For cbuffers; bind 256-byte-aligned slices of it with Donut_BindConstantBuffer.
declare function Donut_CreateConstantBuffer(app: Opaque, byteSize: int, debugName: string): Opaque;
// For cbuffers rewritten with Donut_WriteBuffer before each use (up to 16 times per frame); bind
// it with Donut_BindEntireConstantBuffer and Donut_LayoutVolatileConstantBuffer.
declare function Donut_CreateVolatileConstantBuffer(app: Opaque, byteSize: int, debugName: string): Opaque;
// StructuredBuffer of count elements of stride bytes, filled with Donut_WriteBuffer.
declare function Donut_CreateStructuredBuffer(app: Opaque, stride: int, count: int, debugName: string): Opaque;
// Same, that shaders can also write (RWStructuredBuffer).
declare function Donut_CreateRWStructuredBuffer(app: Opaque, stride: int, count: int, debugName: string): Opaque;
// Stores an int's bits at dst (Ref of an f32 array element), for int / uint fields of structures
// laid out as f32 arrays.
declare function Donut_StoreInt32(dst: Opaque, value: int): void;
// RGBA8_UNORM texture that compute shaders write (RWTexture2D<float4>) and pixel shaders read;
// NVRHI tracks its state.
declare function Donut_CreateUAVTexture(app: Opaque, width: int, height: int, debugName: string): Opaque;
// Render target that shaders can also read (resting at ShaderResource). A depth format (D32)
// makes a depth buffer, cleared to 1 by default, read by shaders as Texture2D<float>.
declare function Donut_CreateRenderTargetTexture(app: Opaque, width: int, height: int, format: Format, debugName: string): Opaque;
// One color target and an optional depth target; draw into it with Donut_BeginDrawToFramebuffer.
declare function Donut_CreateFramebuffer(app: Opaque, colorTexture: Opaque, depthTexture: Opaque | null): Opaque;
// Triangle list for a framebuffer's layout, NVRHI's default render state: depth test (less) and
// writes, back faces culled (clockwise triangles are front faces).
declare function Donut_CreateGraphicsPipelineForFramebuffer(app: Opaque, framebuffer: Opaque, vertexShader: Opaque,
    pixelShader: Opaque, inputLayout: Opaque, bindingLayout: Opaque): Opaque;
// Vertex / index buffers uploaded once by an open command list (data copied during the call).
declare function Donut_CreateStaticVertexBuffer(app: Opaque, commandList: Opaque, data: Opaque, byteSize: int, debugName: string): Opaque;
declare function Donut_CreateStaticIndexBuffer(app: Opaque, commandList: Opaque, data: Opaque, byteSize: int, debugName: string): Opaque;
// Image file, path relative to the executable's directory, uploaded by an open command list.
// sRGB != 0 treats the data as sRGB. Null (after logging why) on failure.
declare function Donut_LoadTexture(app: Opaque, commandList: Opaque, path: string, sRGB: int): Opaque;
declare function Donut_GetCommonSampler(app: Opaque, which: CommonSampler): Opaque;

// Built up with Donut_AddVertexAttribute, then consumed (freed) by Donut_CreateInputLayout.
declare function Donut_CreateInputLayoutDesc(): Opaque;
// Vertex shader input `name` (its semantic), read from vertex buffer slot bufferIndex at byte
// offset `offset` of each elementStride-byte element.
declare function Donut_AddVertexAttribute(inputLayoutDesc: Opaque, name: string, format: Format, offset: int, bufferIndex: int, elementStride: int): void;
declare function Donut_CreateInputLayout(app: Opaque, inputLayoutDesc: Opaque, vertexShader: Opaque): Opaque;

// Input for acceleration structure builds (index or vertex data).
declare function Donut_CreateAccelStructInputBuffer(app: Opaque, byteSize: int, debugName: string): Opaque;
// RGBA8_UNORM texture of the frame's size that shaders write as RWTexture2D<float4>.
declare function Donut_CreateUAVTextureForFrame(app: Opaque, frame: Opaque, debugName: string): Opaque;
// Same, in another format.
declare function Donut_CreateUAVTextureForFrameWithFormat(app: Opaque, frame: Opaque, debugName: string, format: Format): Opaque;

// Acceleration structures; both record their build into an open command list.
// Opaque triangles: R32_UINT indices, RGB32_FLOAT vertices.
declare function Donut_BuildTriangleBLAS(app: Opaque, commandList: Opaque, indexBuffer: Opaque, indexCount: int, vertexBuffer: Opaque, vertexCount: int): Opaque;
// One instance of bottomLevelAS: identity transform, mask 1, counter-clockwise front faces.
declare function Donut_BuildSingleInstanceTLAS(app: Opaque, commandList: Opaque, bottomLevelAS: Opaque): Opaque;

// One ray generation shader, one miss shader and one triangle hit group (closest hit only, or
// no shader at all if closestHitEntry is ""), taken from shaderLibrary by entry name, plus one
// global binding layout.
declare function Donut_CreateRayTracingPipeline(app: Opaque, shaderLibrary: Opaque, bindingLayout: Opaque,
    rayGenEntry: string, missEntry: string, hitGroupName: string, closestHitEntry: string, maxPayloadSize: int): Opaque;
// One ray generation shader, hit group and miss shader, by export name; keeps the pipeline alive.
declare function Donut_CreateShaderTable(app: Opaque, rayTracingPipeline: Opaque, rayGenExport: string, hitGroupExport: string, missExport: string): Opaque;
// Same, kept in GPU memory in up to maxCachedVersions copies instead of re-uploaded on every use.
declare function Donut_CreateCachedShaderTable(app: Opaque, rayTracingPipeline: Opaque, rayGenExport: string, hitGroupExport: string,
    missExport: string, maxCachedVersions: int, debugName: string): Opaque;
// Like Donut_CreateRayTracingPipeline, with an any-hit shader too (either hit shader may be ""),
// and a second global binding layout (e.g. bindless; null for none).
declare function Donut_CreateRayTracingPipelineWithLayouts(app: Opaque, shaderLibrary: Opaque, bindingLayout: Opaque,
    secondBindingLayout: Opaque | null, rayGenEntry: string, missEntry: string, hitGroupName: string, closestHitEntry: string,
    anyHitEntry: string, maxPayloadSize: int): Opaque;

// Built up with Donut_Bind*, then consumed (freed) by Donut_CreateBindingSet.
declare function Donut_CreateBindingSetDesc(): Opaque;
// Buffer<uint> at t<slot>.
declare function Donut_BindTypedBufferSRV(bindingSetDesc: Opaque, slot: int, buffer: Opaque): void;
// RWBuffer<uint> at u<slot>; the buffer must be writable.
declare function Donut_BindTypedBufferUAV(bindingSetDesc: Opaque, slot: int, buffer: Opaque): void;
// cbuffer at b<slot>: byteSize bytes of a constant buffer from byteOffset (multiples of 256).
declare function Donut_BindConstantBuffer(bindingSetDesc: Opaque, slot: int, constantBuffer: Opaque, byteOffset: int, byteSize: int): void;
// cbuffer at b<slot>: all of a constant buffer (required for volatile ones).
declare function Donut_BindEntireConstantBuffer(bindingSetDesc: Opaque, slot: int, constantBuffer: Opaque): void;
// StructuredBuffer at t<slot>, e.g. from Donut_GetSceneBuffer.
declare function Donut_BindStructuredBufferSRV(bindingSetDesc: Opaque, slot: int, buffer: Opaque): void;
// RWStructuredBuffer at u<slot>, from Donut_CreateRWStructuredBuffer.
declare function Donut_BindStructuredBufferUAV(bindingSetDesc: Opaque, slot: int, buffer: Opaque): void;
// Push constants (Donut_LayoutPushConstants) at b<slot>; their values come with each dispatch or
// draw (Donut_DispatchWithPushConstants, Donut_DrawIndexedWithPushConstants).
declare function Donut_BindPushConstants(bindingSetDesc: Opaque, slot: int, byteSize: int): void;
// Texture2D at t<slot>.
declare function Donut_BindTextureSRV(bindingSetDesc: Opaque, slot: int, texture: Opaque): void;
// SamplerState at s<slot>.
declare function Donut_BindSampler(bindingSetDesc: Opaque, slot: int, sampler: Opaque): void;
// RWTexture2D<float4> at u<slot>.
declare function Donut_BindTextureUAV(bindingSetDesc: Opaque, slot: int, texture: Opaque): void;
// RaytracingAccelerationStructure at t<slot>.
declare function Donut_BindAccelStruct(bindingSetDesc: Opaque, slot: int, accelStruct: Opaque): void;
// Binding set plus matching layout (register space 0) visible to shaderType's stages.
declare function Donut_CreateBindingSet(app: Opaque, bindingSetDesc: Opaque, shaderType: ShaderType): Opaque;
// Binding set for an existing layout.
declare function Donut_CreateBindingSetForLayout(app: Opaque, bindingSetDesc: Opaque, bindingLayout: Opaque): Opaque;
// The layout a binding set was created with; valid as long as the binding set.
declare function Donut_GetBindingLayout(bindingSet: Opaque): Opaque;

// For a layout needed before its resources exist (e.g. by a pipeline): built up with
// Donut_Layout*, then consumed (freed) by Donut_CreateBindingLayout.
declare function Donut_CreateBindingLayoutDesc(): Opaque;
declare function Donut_LayoutTextureUAV(bindingLayoutDesc: Opaque, slot: int): void;
declare function Donut_LayoutAccelStruct(bindingLayoutDesc: Opaque, slot: int): void;
declare function Donut_LayoutTextureSRV(bindingLayoutDesc: Opaque, slot: int): void;
declare function Donut_LayoutVolatileConstantBuffer(bindingLayoutDesc: Opaque, slot: int): void;
declare function Donut_LayoutSampler(bindingLayoutDesc: Opaque, slot: int): void;
declare function Donut_LayoutStructuredBufferSRV(bindingLayoutDesc: Opaque, slot: int): void;
declare function Donut_LayoutTypedBufferSRV(bindingLayoutDesc: Opaque, slot: int): void;
// A non-volatile cbuffer.
declare function Donut_LayoutConstantBuffer(bindingLayoutDesc: Opaque, slot: int): void;
declare function Donut_LayoutStructuredBufferUAV(bindingLayoutDesc: Opaque, slot: int): void;
// Register space of the layout's items (D3D12 only; 0 by default).
declare function Donut_SetBindingLayoutRegisterSpace(bindingLayoutDesc: Opaque, space: int): void;

// Ray tracing pipelines of any shape: a description built with the Donut_RtPipeline* functions,
// freed by Donut_CreateRayTracingPipelineFromDesc. maxRecursionDepth 1 = no rays from hit shaders.
declare function Donut_CreateRayTracingPipelineDesc(maxPayloadSize: int, maxRecursionDepth: int): Opaque;
declare function Donut_RtPipelineAddGlobalBindingLayout(pipelineDesc: Opaque, bindingLayout: Opaque): void;
// A ray generation or miss shader, exported by its entry name.
declare function Donut_RtPipelineAddShader(pipelineDesc: Opaque, shaderLibrary: Opaque, entryName: string, shaderType: ShaderType): void;
// Triangle hit group; "" for no closest-hit / any-hit shader; an optional local binding layout
// (D3D12 only), whose binding sets come with each shader table entry.
declare function Donut_RtPipelineAddHitGroup(pipelineDesc: Opaque, shaderLibrary: Opaque, exportName: string,
    closestHitEntry: string, anyHitEntry: string, localBindingLayout: Opaque | null): void;
declare function Donut_CreateRayTracingPipelineFromDesc(app: Opaque, pipelineDesc: Opaque): Opaque;
// Shader tables of any shape, filled with the Donut_ShaderTable* functions; they keep the
// pipeline alive. The Add functions return the new entry's index.
declare function Donut_CreateEmptyShaderTable(app: Opaque, rayTracingPipeline: Opaque): Opaque;
declare function Donut_ShaderTableSetRayGeneration(shaderTable: Opaque, exportName: string): void;
declare function Donut_ShaderTableAddMiss(shaderTable: Opaque, exportName: string): int;
declare function Donut_ShaderTableAddHitGroup(shaderTable: Opaque, exportName: string, localBindingSet: Opaque | null): int;

// Bindless: a layout of unbounded resource arrays, one register space each (visible to
// shaderType's stages), freed by Donut_CreateBindlessLayout.
declare function Donut_CreateBindlessLayoutDesc(firstSlot: int, maxCapacity: int, shaderType: ShaderType): Opaque;
// ByteAddressBuffer[] / Texture2D[] in register space `space`.
declare function Donut_BindlessLayoutAddRawBuffers(bindlessLayoutDesc: Opaque, space: int): void;
declare function Donut_BindlessLayoutAddTextures(bindlessLayoutDesc: Opaque, space: int): void;
declare function Donut_CreateBindlessLayout(app: Opaque, bindlessLayoutDesc: Opaque): Opaque;
// Donut's DescriptorTableManager over a bindless layout; scenes loaded with
// Donut_LoadSceneWithDescriptorTable register their buffers and textures in it.
declare function Donut_CreateDescriptorTableManager(app: Opaque, bindlessLayout: Opaque): Opaque;
// The table, to bind after a binding set; valid as long as the manager.
declare function Donut_GetDescriptorTable(descriptorTableManager: Opaque): Opaque;
// byteSize bytes of push constants (DECLARE_PUSH_CONSTANTS in HLSL) at b<slot>.
declare function Donut_LayoutPushConstants(bindingLayoutDesc: Opaque, slot: int, byteSize: int): void;
// Register space 0, visible to shaderType's stages.
declare function Donut_CreateBindingLayout(app: Opaque, bindingLayoutDesc: Opaque, shaderType: ShaderType): Opaque;
// Uses the layout of bindingSet.
declare function Donut_CreateComputePipeline(app: Opaque, computeShader: Opaque, bindingSet: Opaque): Opaque;
// Same, from a binding layout.
declare function Donut_CreateComputePipelineWithLayout(app: Opaque, computeShader: Opaque, bindingLayout: Opaque): Opaque;
// Same, with a second binding layout (e.g. bindless; null for none).
declare function Donut_CreateComputePipelineWithLayouts(app: Opaque, computeShader: Opaque, bindingLayout: Opaque,
    secondBindingLayout: Opaque | null): Opaque;
// A binding set from the app's binding cache (the description is freed): created once, reused for
// identical descriptions. Valid until Donut_ClearBindingCache.
declare function Donut_GetCachedBindingSet(app: Opaque, bindingSetDesc: Opaque, bindingLayout: Opaque): Opaque;

// Async compute: every intervalMicroseconds, a C++ worker thread dispatches groupsX x groupsY
// groups of a compute pipeline on the compute queue (needs AppOptions.ComputeQueue) into one of
// its textures (RWTexture2D at u0, the run index as a uint push constant at b0; the layout must
// hold exactly those), and hands it to the render thread. Null if there's no compute queue.
declare function Donut_CreateAsyncComputeLoop(app: Opaque, computePipeline: Opaque, bindingLayout: Opaque,
    groupsX: int, groupsY: int, intervalMicroseconds: int): Opaque;
// Before starting it.
declare function Donut_AddAsyncComputeTexture(asyncComputeLoop: Opaque, texture: Opaque): void;
declare function Donut_StartAsyncComputeLoop(asyncComputeLoop: Opaque): void;
// Joins the worker thread; call before Donut_DestroyApp.
declare function Donut_StopAsyncComputeLoop(asyncComputeLoop: Opaque): void;
// In a render callback: switches to the newest finished texture, if any (the frame waits for the
// compute queue), handing the previous one back. The texture to show; null until the first.
declare function Donut_AcquireAsyncComputeTexture(asyncComputeLoop: Opaque, frame: Opaque): Opaque | null;

// Command lists, for work outside render passes (e.g. in a headless app).
declare function Donut_CreateCommandList(app: Opaque): Opaque;
declare function Donut_OpenCommandList(commandList: Opaque): void;
declare function Donut_CloseCommandList(commandList: Opaque): void;
declare function Donut_ExecuteCommandList(app: Opaque, commandList: Opaque): void;
// Blocks until the GPU has finished all submitted work.
declare function Donut_WaitForIdle(app: Opaque): void;
// Uploads byteSize bytes from data, copied during the call. Pass `Ref(array[0])` of a `let`
// int[] / f32[] array.
declare function Donut_WriteBuffer(commandList: Opaque, buffer: Opaque, data: Opaque, byteSize: int): void;
declare function Donut_CopyBuffer(commandList: Opaque, dst: Opaque, dstOffset: int, src: Opaque, srcOffset: int, byteSize: int): void;
declare function Donut_Dispatch(commandList: Opaque, computePipeline: Opaque, bindingSet: Opaque, groupsX: int, groupsY: int, groupsZ: int): void;
// Same, with a descriptor table bound after the binding set.
declare function Donut_DispatchWithDescriptorTable(commandList: Opaque, computePipeline: Opaque, bindingSet: Opaque,
    descriptorTable: Opaque, groupsX: int, groupsY: int, groupsZ: int): void;
// Same as Donut_Dispatch, with byteSize bytes of push constants from data (Ref of a `let` array
// element) for the binding set's Donut_BindPushConstants item.
declare function Donut_DispatchWithPushConstants(commandList: Opaque, computePipeline: Opaque, bindingSet: Opaque,
    data: Opaque, byteSize: int, groupsX: int, groupsY: int, groupsZ: int): void;
// Fills a depth texture (Donut_CreateRenderTargetTexture) with `depth`.
declare function Donut_ClearDepth(commandList: Opaque, depthTexture: Opaque, depth: number): void;
// Names the commands until the matching Donut_EndMarker, for GPU debuggers and profilers.
declare function Donut_BeginMarker(commandList: Opaque, name: string): void;
declare function Donut_EndMarker(commandList: Opaque): void;

// GPU timer queries: the GPU time between Begin and End, readable once polled.
declare function Donut_CreateTimerQuery(app: Opaque): Opaque;
// Before measuring again.
declare function Donut_ResetTimerQuery(app: Opaque, timerQuery: Opaque): void;
declare function Donut_BeginTimerQuery(commandList: Opaque, timerQuery: Opaque): void;
declare function Donut_EndTimerQuery(commandList: Opaque, timerQuery: Opaque): void;
// Non-zero once the GPU has finished the measured commands.
declare function Donut_PollTimerQuery(app: Opaque, timerQuery: Opaque): int;
// Seconds; waits for the GPU unless polled first.
declare function Donut_GetTimerQueryTime(app: Opaque, timerQuery: Opaque): number;

// Passes are owned by the app; later passes draw on top and get input first.
declare function Donut_AddPass(app: Opaque): Opaque;
declare function Donut_SetRunWhenUnfocused(pass: Opaque, enabled: int): void;
declare function Donut_SetRenderCallback(pass: Opaque, handler: RenderCallback): void;
declare function Donut_SetAnimateCallback(pass: Opaque, handler: AnimateCallback): void;
// Called before the swap chain is resized; release framebuffer-dependent resources here.
declare function Donut_SetBackBufferResizingCallback(pass: Opaque, handler: VoidCallback): void;
declare function Donut_SetKeyboardCallback(pass: Opaque, handler: KeyboardCallback): void;
// Window pixels; same return convention as the keyboard callback.
declare function Donut_SetMousePosCallback(pass: Opaque, handler: MousePosCallback): void;
// GLFW button / action values; same return convention as the keyboard callback.
declare function Donut_SetMouseButtonCallback(pass: Opaque, handler: MouseButtonCallback): void;
// Scroll offsets; same return convention as the keyboard callback.
declare function Donut_SetMouseScrollCallback(pass: Opaque, handler: MouseScrollCallback): void;

// Donut's ImGui renderer as a pass drawn after the ones added before (on top) and seeing input
// before them; buildUI builds the UI every frame with the Donut_ImGui* functions (only valid in
// it). Null if the renderer can't be initialized.
declare function Donut_AddImGuiPass(app: Opaque, buildUI: VoidCallback): Opaque | null;
declare function Donut_ImGuiSetNextWindowPos(x: number, y: number): void;
// autoResize != 0: the window fits its contents. Pair with Donut_ImGuiEnd.
declare function Donut_ImGuiBegin(title: string, autoResize: int): void;
declare function Donut_ImGuiEnd(): void;
declare function Donut_ImGuiText(text: string): void;
declare function Donut_ImGuiSeparator(): void;
declare function Donut_ImGuiIndent(): void;
declare function Donut_ImGuiUnindent(): void;
declare function Donut_ImGuiPushItemWidth(width: number): void;
declare function Donut_ImGuiPopItemWidth(): void;
// Value in, new value out.
declare function Donut_ImGuiCheckbox(label: string, value: int): int;
// Non-zero if clicked.
declare function Donut_ImGuiButton(label: string): int;
// items separated by '|'; returns the new selection.
declare function Donut_ImGuiCombo(label: string, current: int, items: string): int;
// Non-zero while the list is open: then add Donut_ImGuiSelectable items and Donut_ImGuiEndCombo.
declare function Donut_ImGuiBeginCombo(label: string, preview: string): int;
// Non-zero if clicked.
declare function Donut_ImGuiSelectable(label: string, selected: int): int;
declare function Donut_ImGuiEndCombo(): void;
// 3 floats at values (Ref of a `let` f32 array element); non-zero if changed.
declare function Donut_ImGuiDragFloat3(label: string, values: Opaque, speed: number): int;

// C++ objects (scenes, cameras, ...) are owned by the app until released or the app is destroyed.
declare function Donut_ReleaseObject(app: Opaque, object: Opaque): void;

// glTF or .scene.json, path relative to the executable's directory or absolute; loaded on the
// app's thread pool, textures uploaded. Null (after logging why) on failure.
declare function Donut_LoadScene(app: Opaque, path: string): Opaque;
// numConstantBufferVersions bounds how many views it can render per frame.
declare function Donut_CreateForwardShadingPass(app: Opaque, numConstantBufferVersions: int): Opaque;
// Cube map render target, resolution x resolution faces: SRGBA8 color, D32 depth.
declare function Donut_CreateCubemapTarget(app: Opaque, resolution: int): Opaque;
// One array slice per face; valid as long as the target.
declare function Donut_GetCubemapColorTexture(cubemapTarget: Opaque): Opaque;
declare function Donut_SetCubemapViewFromCamera(cubemapTarget: Opaque, camera: Opaque, zNear: number, cullDistance: number): void;
// Records the scene as seen by one cube face (0..5) into commandList, opening and closing it.
declare function Donut_RenderCubemapFace(cubemapTarget: Opaque, face: int, commandList: Opaque, scene: Opaque, forwardShadingPass: Opaque): void;
// Same, on the app's worker threads (it runs C++ only); each concurrent task needs its own
// command list from Donut_CreateDeferredCommandList. Wait with Donut_WaitForTasks.
declare function Donut_RenderCubemapFaceAsync(app: Opaque, cubemapTarget: Opaque, face: int, commandList: Opaque, scene: Opaque, forwardShadingPass: Opaque): void;
declare function Donut_WaitForTasks(app: Opaque): void;
// For recording on another thread and executing later.
declare function Donut_CreateDeferredCommandList(app: Opaque): Opaque;

// Donut's first person camera: WASD / arrows move, dragging with the left button looks around.
declare function Donut_CreateFirstPersonCamera(app: Opaque): Opaque;
// First person cameras only.
declare function Donut_CameraLookAt(camera: Opaque, posX: number, posY: number, posZ: number, targetX: number, targetY: number, targetZ: number): void;
// Donut's third person (orbit) camera: dragging with the left button orbits the target, the wheel
// zooms, WASD / arrows move the target. The Donut_Camera* functions below work for both kinds.
declare function Donut_CreateThirdPersonCamera(app: Opaque): Opaque;
declare function Donut_ThirdPersonCameraSetTarget(camera: Opaque, x: number, y: number, z: number): void;
declare function Donut_ThirdPersonCameraSetDistance(camera: Opaque, distance: number): void;
// Radians.
declare function Donut_ThirdPersonCameraSetRotation(camera: Opaque, yaw: number, pitch: number): void;
// Every frame, after Donut_SetPlanarView of the view it renders.
declare function Donut_ThirdPersonCameraSetView(camera: Opaque, view: Opaque): void;
// Forward / up directions: 3 floats into dst (Ref of a `let` f32 array element).
declare function Donut_GetCameraDirection(camera: Opaque, dst: Opaque): void;
declare function Donut_GetCameraUp(camera: Opaque, dst: Opaque): void;
// Units per second.
declare function Donut_CameraSetMoveSpeed(camera: Opaque, speed: number): void;
// Forward the pass input callbacks' arguments to these.
declare function Donut_CameraKeyboardUpdate(camera: Opaque, key: int, scancode: int, action: int, mods: int): void;
declare function Donut_CameraMousePosUpdate(camera: Opaque, x: number, y: number): void;
declare function Donut_CameraMouseButtonUpdate(camera: Opaque, button: int, action: int, mods: int): void;
declare function Donut_CameraMouseScrollUpdate(camera: Opaque, xOffset: number, yOffset: number): void;
declare function Donut_CameraAnimate(camera: Opaque, elapsedSeconds: number): void;
// World-to-view matrix into dst: Ref(arr[0]) of a `let` f32[16] array, row-major, row-vector
// convention (as Donut_SetPlanarView takes it).
declare function Donut_GetCameraWorldToView(camera: Opaque, dst: Opaque): void;

// Loaded scenes. Both valid as long as the scene.
declare function Donut_GetSceneGraph(scene: Opaque): Opaque;
declare function Donut_GetRootNode(sceneGraph: Opaque): Opaque;
// One BLAS per mesh of a loaded scene and a TLAS over its instances, builds recorded into an
// open command list.
declare function Donut_BuildSceneAccelStructs(app: Opaque, commandList: Opaque, scene: Opaque): Opaque;
// For Donut_BindAccelStruct; valid as long as the acceleration structures.
declare function Donut_GetSceneTopLevelAS(sceneAccelStructs: Opaque): Opaque;
// Like Donut_LoadScene, registering the scene's buffers and textures in a descriptor table; the
// scene's geometry and material buffers index into it.
declare function Donut_LoadSceneWithDescriptorTable(app: Opaque, path: string, descriptorTableManager: Opaque): Opaque;
// InstanceData / GeometryData / MaterialConstants structured buffers; valid as long as the scene.
declare function Donut_GetSceneBuffer(scene: Opaque, which: SceneBuffer): Opaque;
// Geometries of a loaded scene, addressed by global geometry index (0 .. count - 1).
declare function Donut_GetSceneGeometryCount(scene: Opaque): int;
// Per-geometry bindings, e.g. for local binding sets: Buffer<uint> of the geometry's indices;
// Buffer<...> of one vertex attribute; a material texture (or Donut's white / black texture if the
// material has none); the MaterialConstants cbuffer.
declare function Donut_BindGeometryIndexBuffer(bindingSetDesc: Opaque, slot: int, scene: Opaque, geometryIndex: int): void;
declare function Donut_BindGeometryVertexAttribute(bindingSetDesc: Opaque, slot: int, scene: Opaque, geometryIndex: int,
    attribute: GeometryAttribute): void;
declare function Donut_BindGeometryMaterialTexture(app: Opaque, bindingSetDesc: Opaque, slot: int, scene: Opaque, geometryIndex: int,
    which: MaterialTexture, fallback: FallbackTexture): void;
declare function Donut_BindGeometryMaterialConstants(bindingSetDesc: Opaque, slot: int, scene: Opaque, geometryIndex: int): void;
// Like Donut_BuildSceneAccelStructs, for shader tables with hitGroupStride entries per geometry in
// global geometry index order.
declare function Donut_BuildSceneAccelStructsWithHitGroupStride(app: Opaque, commandList: Opaque, scene: Opaque,
    hitGroupStride: int): Opaque;
// Animations, e.g. glTF skeletal ones. Durations in seconds; apply poses the nodes at `time`.
declare function Donut_GetSceneAnimationCount(scene: Opaque): int;
declare function Donut_GetSceneAnimationDuration(scene: Opaque, index: int): number;
declare function Donut_ApplySceneAnimation(scene: Opaque, index: int, time: number): void;
// For animated scenes: one BLAS per mesh (alpha-tested geometries non-opaque, static ones
// compacted later), builds recorded into an open command list, plus a TLAS built every frame by
// Donut_UpdateSceneAccelStructs. Get the TLAS with Donut_GetSceneTopLevelAS.
declare function Donut_CreateAnimatedSceneAccelStructs(app: Opaque, commandList: Opaque, scene: Opaque): Opaque;
// Valid only inside a render callback. Updates the scene graph and GPU buffers (transforms,
// skinning) after animations.
declare function Donut_RefreshScene(app: Opaque, frame: Opaque, scene: Opaque): void;
// Valid only inside a render callback, after Donut_RefreshScene: rebuilds the skinned BLASes,
// compacts finished static ones and builds the TLAS (instance IDs = instance indices).
declare function Donut_UpdateSceneAccelStructs(app: Opaque, frame: Opaque, sceneAccelStructs: Opaque, scene: Opaque): void;

// A texture file (relative to the executable's directory) loaded and uploaded (mipmaps generated
// if it has none), registered in a descriptor table for bindless access. It submits its own
// command list: call it while no other one is open. Null (after logging why) on failure.
declare function Donut_LoadBindlessTexture(app: Opaque, descriptorTableManager: Opaque, path: string, sRGB: int): Opaque;
// Its index in the descriptor table (the shaders' array index).
declare function Donut_GetTextureDescriptorIndex(loadedTexture: Opaque): int;
declare function Donut_GetSceneInstanceCount(scene: Opaque): int;
// A node's world-space position into dst (3 floats); 0 if there's no node at path ("/Emitter").
declare function Donut_GetSceneNodePosition(scene: Opaque, path: string, dst: Opaque): int;

// Dynamic meshes: one alpha-blended geometry whose vertices (positions, texture coordinates) and
// indices are replaced every frame, with room for maxVertices / maxIndices, buffers registered in
// a descriptor table. Attach to a loaded scene before creating binding sets of its buffers.
declare function Donut_CreateDynamicMesh(app: Opaque, descriptorTableManager: Opaque, maxVertices: int, maxIndices: int, name: string): Opaque;
declare function Donut_AttachDynamicMesh(app: Opaque, scene: Opaque, dynamicMesh: Opaque): void;
// A Donut_LoadBindlessTexture texture; the scene picks it up at the next Donut_RefreshScene.
declare function Donut_SetDynamicMeshTexture(app: Opaque, dynamicMesh: Opaque, loadedTexture: Opaque): void;
// Valid only inside a render callback: positions (3 x f32 per vertex), texCoords (2 x f32), int
// indices, as Ref of `let` array elements; rebuilds the mesh's BLAS.
declare function Donut_UpdateDynamicMesh(frame: Opaque, dynamicMesh: Opaque, positions: Opaque, texCoords: Opaque, vertexCount: int,
    indices: Opaque, indexCount: int): void;
// A BLAS for every scene mesh without one (not dynamic meshes), into an open command list;
// geometries not in the Opaque material domain are non-opaque.
declare function Donut_BuildSceneBLASes(app: Opaque, commandList: Opaque, scene: Opaque): void;
// A BLAS of one AABB (-1..1 on each axis), built into an open command list.
declare function Donut_CreateUnitAABBBlas(app: Opaque, commandList: Opaque, debugName: string): Opaque;
// A TLAS of up to maxInstances, rebuilt by Donut_BuildTopLevelAS from the instances added since
// the last build. Get the TLAS with Donut_GetSceneTopLevelAS.
declare function Donut_CreateTopLevelAS(app: Opaque, maxInstances: int): Opaque;
// The scene's mesh instances (instance ID = instance index) with instanceMask, dynamicMesh's (if
// not null) with dynamicMeshMask.
declare function Donut_AddSceneTopLevelASInstances(sceneAccelStructs: Opaque, scene: Opaque, instanceMask: int,
    dynamicMesh: Opaque | null, dynamicMeshMask: int): void;
// A BLAS instance scaled by `scale`, then moved to (x, y, z).
declare function Donut_AddTopLevelASInstance(sceneAccelStructs: Opaque, bottomLevelAS: Opaque, instanceMask: int, instanceID: int,
    scale: number, x: number, y: number, z: number): void;
// Valid only inside a render callback.
declare function Donut_BuildTopLevelAS(frame: Opaque, sceneAccelStructs: Opaque): void;

// Scenes built in code. Material with a diffuse texture (relative to the executable's directory,
// sRGB), uploads recorded into an open command list; specularGloss != 0 selects the
// specular-glossiness model. Null (after logging why) if the texture can't be loaded.
declare function Donut_CreateTexturedMaterial(app: Opaque, commandList: Opaque, name: string, diffuseTexturePath: string, specularGloss: int): Opaque;
// One geometry, identity instance transform, uploads recorded into an open command list. Per
// vertex: position (3 x f32), texture coordinates (2 x f32), normal and tangent (int each,
// packed as by vectorToSnorm8); then indexCount int indices. Arrays: Ref(arr[0]) of `let` arrays.
declare function Donut_CreateMesh(app: Opaque, commandList: Opaque, name: string, material: Opaque,
    positions: Opaque, texCoords: Opaque, normals: Opaque, tangents: Opaque, vertexCount: int,
    indices: Opaque, indexCount: int): Opaque;
declare function Donut_CreateSceneGraph(app: Opaque): Opaque;
// Adds a node holding an instance of mesh under parentNode, or as the root if parentNode is
// null. Returns the node, valid as long as the scene graph.
declare function Donut_AddMeshNode(app: Opaque, sceneGraph: Opaque, parentNode: Opaque | null, mesh: Opaque, name: string): Opaque;
// Directional light in a new node under parentNode, shining along dir; angularSize in degrees.
// Returns the light, valid as long as the scene graph; refresh the graph before using it.
declare function Donut_AddDirectionalLight(sceneGraph: Opaque, parentNode: Opaque, name: string,
    dirX: number, dirY: number, dirZ: number, angularSize: number, irradiance: number): Opaque;
// For constant buffers that embed a LightConstants (donut/shaders/light_cb.h): its size in
// bytes (a multiple of 16), and a light's constants written to dst (Ref of a `let` array element).
declare function Donut_GetLightConstantsSize(): int;
declare function Donut_FillLightConstants(light: Opaque, dst: Opaque): void;
// After adding or changing nodes.
declare function Donut_RefreshSceneGraph(app: Opaque, sceneGraph: Opaque): void;
declare function Donut_PrintSceneGraph(sceneGraph: Opaque): void;

// Deferred shading. G-buffer of width x height pixels plus an RGBA16_FLOAT texture for the lit
// result; create new ones when the frame size changes. reverseDepth != 0 clears depth to 0, for
// reverse-Z projections.
declare function Donut_CreateGBufferTargets(app: Opaque, width: int, height: int, reverseDepth: int): Opaque;
// For Donut_BlitTexture, or as a UAV; valid as long as the targets.
declare function Donut_GetGBufferShadedColor(gbufferTargets: Opaque): Opaque;
// One of the G-buffer textures, e.g. to bind to a shader decoding the G-buffer; valid as long as
// the targets.
declare function Donut_GetGBufferTexture(gbufferTargets: Opaque, which: GBufferTexture): Opaque;
declare function Donut_CreateGBufferFillPass(app: Opaque): Opaque;
declare function Donut_CreateDeferredLightingPass(app: Opaque): Opaque;
// Drops the pass's cached references to G-buffer textures.
declare function Donut_ResetDeferredLightingBindingCache(deferredLightingPass: Opaque): void;
declare function Donut_CreatePlanarView(app: Opaque): Opaque;
// Matrices: Ref(arr[0]) of `let` f32[16] arrays, row-major, row-vector convention (as the math
// functions in the examples build them); viewport of width x height pixels.
declare function Donut_SetPlanarView(view: Opaque, viewMatrix: Opaque, projMatrix: Opaque, width: int, height: int): void;
// For constant buffers that embed a PlanarViewConstants (donut/shaders/view_cb.h): its size in
// bytes (a multiple of 16), and the view's constants written to dst (Ref of a `let` array element).
declare function Donut_GetPlanarViewConstantsSize(): int;
declare function Donut_FillPlanarViewConstants(view: Opaque, dst: Opaque): void;
// These four are valid only inside a render callback.
declare function Donut_ClearGBuffer(frame: Opaque, gbufferTargets: Opaque): void;
// Draws the mesh instance of a Donut_AddMeshNode node into the G-buffer, back faces culled.
declare function Donut_RenderMeshNodeToGBuffer(frame: Opaque, gbufferFillPass: Opaque, view: Opaque, gbufferTargets: Opaque, meshNode: Opaque): void;
// Draws the opaque meshes of a loaded scene into the G-buffer.
declare function Donut_RenderSceneToGBuffer(frame: Opaque, gbufferFillPass: Opaque, view: Opaque, gbufferTargets: Opaque, scene: Opaque): void;
// Lights the G-buffer with the scene graph's lights plus a top / bottom ambient term, into the
// targets' shaded color texture.
declare function Donut_RenderDeferredLighting(frame: Opaque, deferredLightingPass: Opaque, view: Opaque, gbufferTargets: Opaque,
    sceneGraph: Opaque, topR: number, topG: number, topB: number, bottomR: number, bottomG: number, bottomB: number): void;
// Valid only inside a render callback: the transparent meshes of a loaded scene, forward-shaded
// over the targets' shaded color, depth-tested against the G-buffer depth.
declare function Donut_RenderSceneTransparentOverGBuffer(frame: Opaque, forwardShadingPass: Opaque, view: Opaque, gbufferTargets: Opaque,
    scene: Opaque, topR: number, topG: number, topB: number, bottomR: number, bottomG: number, bottomB: number): void;
// Viewport, matrices and derived state, e.g. to keep the previous frame's view.
declare function Donut_CopyPlanarView(dstView: Opaque, srcView: Opaque): void;

// Forward shading with TAA. Targets of width x height pixels: RGBA16_FLOAT HDR color and D24S8
// depth (cleared for reverse Z) to render into, motion vectors, and the TAA resolved color and
// feedback; create new ones when the frame size changes.
declare function Donut_CreateTemporalTargets(app: Opaque, width: int, height: int): Opaque;
// Valid as long as the targets.
declare function Donut_GetTemporalTargetsTexture(temporalTargets: Opaque, which: TemporalTexture): Opaque;
// Rendering into the targets uses this surface whenever the view enables variable rate shading;
// set it before the first draw into them.
declare function Donut_SetTemporalTargetsShadingRateSurface(temporalTargets: Opaque, shadingRateSurface: Opaque): void;
// TAA over the targets (Catmull-Rom filter, stencil mask 0x01), for views like `view`; create a
// new one with new targets.
declare function Donut_CreateTemporalAntiAliasingPass(app: Opaque, view: Opaque, temporalTargets: Opaque): Opaque;
// These four are valid only inside a render callback.
// Depth to 0 (reverse Z), HDR color to black.
declare function Donut_ClearTemporalTargets(frame: Opaque, temporalTargets: Opaque): void;
// A loaded scene, opaque then transparent meshes, with a Donut_CreateForwardShadingPass pass, lit
// by the scene graph's lights plus a top / bottom ambient term.
declare function Donut_RenderSceneForward(frame: Opaque, forwardShadingPass: Opaque, view: Opaque, temporalTargets: Opaque, scene: Opaque,
    topR: number, topG: number, topB: number, bottomR: number, bottomG: number, bottomB: number): void;
declare function Donut_RenderMotionVectors(frame: Opaque, temporalAntiAliasingPass: Opaque, view: Opaque, previousView: Opaque): void;
// HDR color into the resolved color; feedbackIsValid 0 when there's no history yet.
declare function Donut_TemporalResolve(frame: Opaque, temporalAntiAliasingPass: Opaque, view: Opaque, feedbackIsValid: int): void;

// Variable rate shading. Pixels per shading rate surface texel, as NVRHI reports it, or (the
// second one) straight from D3D12, 0 on other APIs.
declare function Donut_GetShadingRateTileSize(app: Opaque): int;
declare function Donut_GetD3D12ShadingRateTileSize(app: Opaque): int;
// R8_UINT surface of width x height tiles, written by compute shaders as RWTexture2D<uint>.
declare function Donut_CreateShadingRateSurface(app: Opaque, width: int, height: int): Opaque;
// enabled != 0: the view's draws use the framebuffer's shading rate surface alone; 0: full rate.
declare function Donut_SetViewVariableRateShading(view: Opaque, enabled: int): void;
// The same through D3D12 directly (D3D12 only), instead of the two functions above; valid only
// inside a render callback, Begin and End around the draws.
declare function Donut_BeginD3D12ShadingRateImage(frame: Opaque, shadingRateSurface: Opaque): void;
declare function Donut_EndD3D12ShadingRateImage(frame: Opaque, shadingRateSurface: Opaque): void;

// D3D12 work graphs, through D3D12 directly. They need the Agility SDK runtime: the executable
// must be linked with d3d12_agility_sdk.cpp (see CMakeLists.txt).
// D3D12_WORK_GRAPHS_TIER: 0 unsupported (or not D3D12), 10 for tier 1.0, 11 for tier 1.1.
declare function Donut_GetD3D12WorkGraphsTier(app: Opaque): int;
// A work graph program of all the nodes of a shader library (lib_6_8), with computePipeline's
// root signature, and its broadcasting entry node's dispatch grid set to gridX x gridY x gridZ;
// plus its backing memory. Release it with Donut_ReleaseObject. Null (after logging why) on failure.
declare function Donut_CreateD3D12WorkGraph(app: Opaque, shaderLibrary: Opaque, computePipeline: Opaque, programName: string,
    entryNodeName: string, gridX: int, gridY: int, gridZ: int): Opaque | null;
// Launches the graph with one empty entry record, bindingSet and byteSize bytes of push constants
// from data as its root arguments, set through computePipeline (one with the same root signature;
// don't dispatch with it after the graph in the same command list). initializeBackingMemory
// non-zero on the backing memory's first use, or after another graph used it.
declare function Donut_DispatchD3D12WorkGraph(commandList: Opaque, workGraph: Opaque, computePipeline: Opaque, bindingSet: Opaque,
    data: Opaque, byteSize: int, initializeBackingMemory: int): void;

// Valid only inside a render callback.
declare function Donut_ClearColor(frame: Opaque, r: number, g: number, b: number, a: number): void;
// Draws vertexCount vertices with no vertex buffers, over the whole framebuffer.
declare function Donut_Draw(frame: Opaque, pipeline: Opaque, vertexCount: int): void;
// Launches groupsX amplification-shader groups of a meshlet pipeline, over the whole framebuffer.
declare function Donut_DispatchMesh(frame: Opaque, meshletPipeline: Opaque, groupsX: int): void;
// Traces width x height rays with a shader table, with bindingSet as its global bindings.
declare function Donut_DispatchRays(frame: Opaque, shaderTable: Opaque, bindingSet: Opaque, width: int, height: int): void;
// Same, with a descriptor table bound after the binding set.
declare function Donut_DispatchRaysWithDescriptorTable(frame: Opaque, shaderTable: Opaque, bindingSet: Opaque,
    descriptorTable: Opaque, width: int, height: int): void;
// Stretches a texture over the whole framebuffer. Call Donut_ClearBindingCache after releasing
// textures blitted before.
declare function Donut_BlitTexture(app: Opaque, frame: Opaque, texture: Opaque): void;
declare function Donut_ClearBindingCache(app: Opaque): void;
// One array slice of a texture, stretched into a rectangle of the framebuffer (pixels).
declare function Donut_BlitTextureSlice(app: Opaque, frame: Opaque, texture: Opaque, arraySlice: int, left: number, top: number, width: number, height: number): void;
// The frame's open command list, for the command list functions (e.g. Donut_WriteBuffer). Don't
// open, close or execute it.
declare function Donut_GetFrameCommandList(frame: Opaque): Opaque;
// A draw: begin with a pipeline (whole framebuffer by default), add state, then issue it.
declare function Donut_BeginDraw(frame: Opaque, pipeline: Opaque): void;
// Same, into another framebuffer (Donut_CreateFramebuffer; a pipeline for its layout).
declare function Donut_BeginDrawToFramebuffer(frame: Opaque, pipeline: Opaque, framebuffer: Opaque): void;
declare function Donut_DrawAddBindingSet(frame: Opaque, bindingSet: Opaque): void;
// R32_UINT indices.
declare function Donut_DrawSetIndexBuffer(frame: Opaque, indexBuffer: Opaque): void;
// R16_UINT indices.
declare function Donut_DrawSetIndexBuffer16(frame: Opaque, indexBuffer: Opaque): void;
// Binds a vertex buffer, from byteOffset, to an input layout slot.
declare function Donut_DrawAddVertexBuffer(frame: Opaque, vertexBuffer: Opaque, slot: int, byteOffset: int): void;
// Draws into this rectangle of the framebuffer (pixels) instead of all of it.
declare function Donut_DrawSetViewport(frame: Opaque, left: number, top: number, width: number, height: number): void;
declare function Donut_DrawIndexed(frame: Opaque, indexCount: int): void;
// Same, with byteSize bytes of push constants from data (the binding set's Donut_BindPushConstants
// item); the draw described stays, so it can repeat with other push constants.
declare function Donut_DrawIndexedWithPushConstants(frame: Opaque, indexCount: int, data: Opaque, byteSize: int): void;
// Copies a texture of the back buffer's size and a compatible format (e.g. RGBA8_UNORM) into the
// back buffer, as is.
declare function Donut_CopyTextureToFrame(frame: Opaque, texture: Opaque): void;
// Same, without an index buffer.
declare function Donut_DrawVertices(frame: Opaque, vertexCount: int): void;
declare function Donut_GetFrameWidth(frame: Opaque): int;
declare function Donut_GetFrameHeight(frame: Opaque): int;

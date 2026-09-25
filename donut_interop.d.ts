// --- Donut interop (implemented in donut_interop.cpp) ---------------------------------------

// A method passed as one of these (e.g. `this.onRender`) reaches C++ as a function pointer
// plus its `this` value.
type VoidCallback = () => void;
type RenderCallback = (frame: Opaque) => void;
type AnimateCallback = (elapsedSeconds: number) => void;
type KeyboardCallback = (key: int, scancode: int, action: int, mods: int) => int;

// nvrhi::GraphicsAPI values.
enum GraphicsAPI {
    D3D11 = 0,
    D3D12 = 1,
    VULKAN = 2
}

// nvrhi::Feature values (only the ones used so far).
enum Feature {
    Meshlets = 9,
    RayTracingPipeline = 14,
    ShaderSpecializations = 18
}

// Bits of Donut_CreateAppWithOptions' options.
enum AppOptions {
    None = 0,
    // Enables the Vulkan ray tracing extensions (D3D12 has them built in).
    RayTracing = 1
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
declare function Donut_CloseWindow(app: Opaque): void;

// nvrhi::ShaderType values.
enum ShaderType {
    Vertex = 0x0001,
    Pixel = 0x0010,
    Compute = 0x0020,
    Amplification = 0x0040,
    Mesh = 0x0080,
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
// Triangle list, no depth test, for the frame's framebuffer layout.
declare function Donut_CreateGraphicsPipeline(app: Opaque, frame: Opaque, vertexShader: Opaque, pixelShader: Opaque): Opaque;
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
// Input for acceleration structure builds (index or vertex data).
declare function Donut_CreateAccelStructInputBuffer(app: Opaque, byteSize: int, debugName: string): Opaque;
// RGBA8_UNORM texture of the frame's size that shaders write as RWTexture2D<float4>.
declare function Donut_CreateUAVTextureForFrame(app: Opaque, frame: Opaque, debugName: string): Opaque;

// Acceleration structures; both record their build into an open command list.
// Opaque triangles: R32_UINT indices, RGB32_FLOAT vertices.
declare function Donut_BuildTriangleBLAS(app: Opaque, commandList: Opaque, indexBuffer: Opaque, indexCount: int, vertexBuffer: Opaque, vertexCount: int): Opaque;
// One instance of bottomLevelAS: identity transform, mask 1, counter-clockwise front faces.
declare function Donut_BuildSingleInstanceTLAS(app: Opaque, commandList: Opaque, bottomLevelAS: Opaque): Opaque;

// One ray generation shader, one miss shader and one triangle hit group (closest hit only),
// taken from shaderLibrary by entry name, plus one global binding layout.
declare function Donut_CreateRayTracingPipeline(app: Opaque, shaderLibrary: Opaque, bindingLayout: Opaque,
    rayGenEntry: string, missEntry: string, hitGroupName: string, closestHitEntry: string, maxPayloadSize: int): Opaque;
// One ray generation shader, hit group and miss shader, by export name; keeps the pipeline alive.
declare function Donut_CreateShaderTable(app: Opaque, rayTracingPipeline: Opaque, rayGenExport: string, hitGroupExport: string, missExport: string): Opaque;

// Built up with Donut_Bind*, then consumed (freed) by Donut_CreateBindingSet.
declare function Donut_CreateBindingSetDesc(): Opaque;
// Buffer<uint> at t<slot>.
declare function Donut_BindTypedBufferSRV(bindingSetDesc: Opaque, slot: int, buffer: Opaque): void;
// RWBuffer<uint> at u<slot>; the buffer must be writable.
declare function Donut_BindTypedBufferUAV(bindingSetDesc: Opaque, slot: int, buffer: Opaque): void;
// RWTexture2D<float4> at u<slot>.
declare function Donut_BindTextureUAV(bindingSetDesc: Opaque, slot: int, texture: Opaque): void;
// RaytracingAccelerationStructure at t<slot>.
declare function Donut_BindAccelStruct(bindingSetDesc: Opaque, slot: int, accelStruct: Opaque): void;
// Binding set plus matching layout (register space 0) visible to shaderType's stages.
declare function Donut_CreateBindingSet(app: Opaque, bindingSetDesc: Opaque, shaderType: ShaderType): Opaque;
// Binding set for an existing layout.
declare function Donut_CreateBindingSetForLayout(app: Opaque, bindingSetDesc: Opaque, bindingLayout: Opaque): Opaque;

// For a layout needed before its resources exist (e.g. by a pipeline): built up with
// Donut_Layout*, then consumed (freed) by Donut_CreateBindingLayout.
declare function Donut_CreateBindingLayoutDesc(): Opaque;
declare function Donut_LayoutTextureUAV(bindingLayoutDesc: Opaque, slot: int): void;
declare function Donut_LayoutAccelStruct(bindingLayoutDesc: Opaque, slot: int): void;
// Register space 0, visible to shaderType's stages.
declare function Donut_CreateBindingLayout(app: Opaque, bindingLayoutDesc: Opaque, shaderType: ShaderType): Opaque;
// Uses the layout of bindingSet.
declare function Donut_CreateComputePipeline(app: Opaque, computeShader: Opaque, bindingSet: Opaque): Opaque;

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

// Passes are owned by the app; later passes draw on top and get input first.
declare function Donut_AddPass(app: Opaque): Opaque;
declare function Donut_SetRunWhenUnfocused(pass: Opaque, enabled: int): void;
declare function Donut_SetRenderCallback(pass: Opaque, handler: RenderCallback): void;
declare function Donut_SetAnimateCallback(pass: Opaque, handler: AnimateCallback): void;
// Called before the swap chain is resized; release framebuffer-dependent resources here.
declare function Donut_SetBackBufferResizingCallback(pass: Opaque, handler: VoidCallback): void;
declare function Donut_SetKeyboardCallback(pass: Opaque, handler: KeyboardCallback): void;

// Valid only inside a render callback.
declare function Donut_ClearColor(frame: Opaque, r: number, g: number, b: number, a: number): void;
// Draws vertexCount vertices with no vertex buffers, over the whole framebuffer.
declare function Donut_Draw(frame: Opaque, pipeline: Opaque, vertexCount: int): void;
// Launches groupsX amplification-shader groups of a meshlet pipeline, over the whole framebuffer.
declare function Donut_DispatchMesh(frame: Opaque, meshletPipeline: Opaque, groupsX: int): void;
// Traces width x height rays with a shader table, with bindingSet as its global bindings.
declare function Donut_DispatchRays(frame: Opaque, shaderTable: Opaque, bindingSet: Opaque, width: int, height: int): void;
// Stretches a texture over the whole framebuffer. Call Donut_ClearBindingCache after releasing
// textures blitted before.
declare function Donut_BlitTexture(app: Opaque, frame: Opaque, texture: Opaque): void;
declare function Donut_ClearBindingCache(app: Opaque): void;
declare function Donut_GetFrameWidth(frame: Opaque): int;
declare function Donut_GetFrameHeight(frame: Opaque): int;

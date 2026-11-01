// --- NRI interop (implemented in core/nri/nri_interop.cpp) ----------------------------------
//
// NRI (NVIDIA Rendering Interface) and NRIFramework, the framework of NVIDIA's NRISamples, for the
// examples that render with them instead of Donut: nri_interop's shared library (built by
// core/nri/CMakeLists.txt), which an example links instead of Donut's interop. NRIFramework's
// SampleBase is the application (the window, the command line, the render loop), calling the
// callbacks set here; each other function is one NRI call, its desc taken apart into arguments.
//
// Every function is @nodrops but Nri_RunSample, which runs the callbacks (TypeScript methods)
// before it returns.

// The handles: the C++ objects' pointers, a class each so that one isn't taken for another. @cpp:
// not reference counted (see donut_handles.d.ts).
@cpp declare class NriSampleHandle { private readonly __nriSample: index; }
@cpp declare class NriDeviceHandle { private readonly __nriDevice: index; }
@cpp declare class NriQueueHandle { private readonly __nriQueue: index; }
@cpp declare class NriFenceHandle { private readonly __nriFence: index; }
@cpp declare class NriSwapChainHandle { private readonly __nriSwapChain: index; }
@cpp declare class NriTextureHandle { private readonly __nriTexture: index; }
@cpp declare class NriDescriptorHandle { private readonly __nriDescriptor: index; }
@cpp declare class NriBufferHandle { private readonly __nriBuffer: index; }
@cpp declare class NriCommandAllocatorHandle { private readonly __nriCommandAllocator: index; }
@cpp declare class NriCommandBufferHandle { private readonly __nriCommandBuffer: index; }
@cpp declare class NriPipelineLayoutHandle { private readonly __nriPipelineLayout: index; }
@cpp declare class NriPipelineHandle { private readonly __nriPipeline: index; }
// What Nri_CreatePipelineFromDesc makes a pipeline from (Nri_CreatePipelineDesc).
@cpp declare class NriPipelineDescHandle { private readonly __nriPipelineDesc: index; }
// What Nri_CreatePipelineLayoutFromDesc makes a layout from (Nri_CreatePipelineLayoutDesc).
@cpp declare class NriPipelineLayoutDescHandle { private readonly __nriPipelineLayoutDesc: index; }
@cpp declare class NriDescriptorPoolHandle { private readonly __nriDescriptorPool: index; }
// Allocated from a pool, destroyed with it.
@cpp declare class NriDescriptorSetHandle { private readonly __nriDescriptorSet: index; }
@cpp declare class NriMemoryHandle { private readonly __nriMemory: index; }
// A worker thread's compute loop (Nri_CreateAsyncComputeLoop).
@cpp declare class NriAsyncComputeLoopHandle { private readonly __nriAsyncComputeLoop: index; }
// A file's bytes (Nri_LoadFile).
@cpp declare class NriFileHandle { private readonly __nriFile: index; }
// A std::default_random_engine (Nri_CreateRandomEngine).
@cpp declare class NriRandomEngineHandle { private readonly __nriRandomEngine: index; }

// nri::GraphicsAPI
enum NriGraphicsAPI {
    None = 0,
    D3D11 = 1,
    D3D12 = 2,
    VK = 3
}

// The states Nri_CmdTextureBarrier moves a texture between (nri::AccessLayoutStage).
enum NriTextureState {
    Undefined = 0,
    ColorAttachment = 1,
    CopySource = 2,
    Present = 3,
    // a depth attachment's (Nri_CreateDepthTexture's, from the start)
    DepthAttachment = 4,
    // read by pixel shaders (Nri_UploadTexture's textures, after it)
    ShaderResource = 5,
    // written by compute shaders (Nri_CreateStorageTexture's textures, from the start)
    Storage = 6,
    // read by pixel and compute shaders
    AllShaderResource = 7
}

// The device features Nri_IsFeatureSupported queries (of nri::DeviceDesc).
enum NriFeature {
    // features.meshShader: Nri_CreateMeshPipeline, Nri_CmdDrawMeshTasks (D3D12, Vulkan)
    MeshShader = 0,
    // features.depthBoundsTest: Nri_PipelineDescSetDepth's boundsTest, Nri_CmdSetDepthBounds
    DepthBoundsTest = 1,
    // features.drawIndirectCount: Nri_CmdDrawIndexedIndirect's countBuffer
    DrawIndirectCount = 2,
    // wave.derivativeOpsStages has compute shaders: ddx / ddy in compute shaders (D3D12 shader
    // model 6.6, Vulkan's VK_KHR_compute_shader_derivatives; quads or linear groups, not told apart)
    ComputeShaderDerivatives = 3
}

// nri::Format, which the functions taking or returning a format pass through: the values the
// examples name (nri_interop.cpp asserts them), any other passing through as well.
enum NriFormat {
    Unknown = 0,
    BGRA8_UNORM = 9,
    BGRA8_SRGB = 10,
    RGBA8_UNORM = 11,
    RGBA8_SRGB = 12,
    R32_UINT = 31,
    R32_SFLOAT = 33,
    RG32_SFLOAT = 36,
    RGB32_SFLOAT = 39,
    RGBA32_SFLOAT = 42,
    BC1_RGBA_UNORM = 50,
    D32_SFLOAT = 66
}

// nri::CompareOp: a depth test's (None: off).
enum NriCompareOp {
    None = 0,
    Always = 1,
    Never = 2,
    Equal = 3,
    NotEqual = 4,
    Less = 5,
    LessEqual = 6,
    Greater = 7,
    GreaterEqual = 8
}

// The stages of the shaders Nri_PipelineDescAddShader adds.
enum NriShaderStage {
    Vertex = 0,
    Pixel = 1,
    Mesh = 2,
    Task = 3
}

// nri::ColorWriteBits: the channels a pipeline writes to its color attachment.
enum NriColorWrite {
    None = 0,
    R = 1,
    G = 2,
    B = 4,
    A = 8,
    RGBA = 15
}

// nri::Topology: the primitives a pipeline draws (Nri_PipelineDescSetTopology).
enum NriTopology {
    TriangleList = 3,
    TriangleStrip = 4
}

// nri::CullMode.
enum NriCullMode {
    None = 0,
    Front = 1,
    Back = 2
}

// nri::DescriptorType: a descriptor range's.
enum NriDescriptorType {
    Sampler = 0,
    ConstantBuffer = 1,
    Texture = 2,
    // RWTexture2D (u registers)
    StorageTexture = 3,
    // StructuredBuffer (t registers)
    StructuredBuffer = 6,
    // RWStructuredBuffer (u registers)
    StorageStructuredBuffer = 7
}

// nri::StageBits: the shader stages that see a descriptor range.
enum NriStage {
    Vertex = 2,
    Pixel = 128,
    // vertex and pixel
    VertexPixel = 130,
    Compute = 1024
}

// nri::Filter (Nri_CreateSampler).
enum NriFilter {
    Nearest = 0,
    Linear = 1
}

// nri::AddressMode (Nri_CreateSampler).
enum NriAddressMode {
    Repeat = 0,
    MirroredRepeat = 1,
    ClampToEdge = 2,
    ClampToBorder = 3
}

// NRIFramework's Key: GLFW's key codes (Nri_IsKeyToggled).
enum NriKey {
    Space = 32
}

// What Nri_CreateUploadedBuffer's buffer is for.
enum NriBufferUsage {
    VertexBuffer = 0,
    IndexBuffer = 1,
    // Nri_CreateHostBuffer's
    ConstantBuffer = 2,
    // Nri_CreateHostBufferWithStride's: structures read by shaders (StructuredBuffer)
    StructuredBuffer = 3
}

// The states Nri_CmdBufferBarrier moves a storage buffer between (nri::AccessStage).
enum NriBufferState {
    // read and written by compute shaders (Nri_CreateStorageBuffer's buffers, from the start)
    Storage = 0,
    // read by vertex shaders
    VertexShaderResource = 1,
    // copied from (Nri_CmdCopyBuffer)
    CopySource = 2,
    // copied to (Nri_CmdZeroBuffer)
    CopyDestination = 3,
    // an indirect draw's arguments (Nri_CmdDrawIndexedIndirect's buffer and countBuffer)
    IndirectArgument = 4,
    // an indirect draw's arguments, and read by compute shaders
    IndirectArgumentAndComputeResource = 5
}

// nri::IndexType (Nri_CmdSetIndexBuffer).
enum NriIndexType {
    UInt16 = 0,
    UInt32 = 1
}

// nri::DescriptorRangeBits: a descriptor range's flags (bits).
enum NriRangeFlags {
    None = 0,
    // its descriptors needn't all be valid
    PartiallyBound = 1,
    // an array
    Array = 2,
    // an array as long as Nri_AllocateDescriptorSet's variableDescriptorNum (descriptorNum at most)
    VariableSizedArray = 4,
    // updated after the set is bound, before the submit (its pool: updateAfterSet)
    UpdateAfterSet = 8
}

type NriInitializeCallback = (graphicsAPI: NriGraphicsAPI) => int;
type NriFrameCallback = (frameIndex: int) => void;

// The application
@nodrops declare function Nri_CreateSample(): NriSampleHandle;
// Destroys the window; after the objects made on the device and the device are.
@nodrops declare function Nri_DestroySample(sample: NriSampleHandle): void;
// Called by Nri_RunSample once the window is made: makes the device and what the frames need,
// returns 0 on failure (then Nri_RunSample returns 1 without rendering).
@nodrops declare function Nri_SetInitializeCallback(sample: NriSampleHandle, handler: NriInitializeCallback): void;
// Called at the start of each frame, before the input is read: waits for the frame's resources.
@nodrops declare function Nri_SetLatencySleepCallback(sample: NriSampleHandle, handler: NriFrameCallback): void;
@nodrops declare function Nri_SetRenderFrameCallback(sample: NriSampleHandle, handler: NriFrameCallback): void;
// Parses the command line, makes the window (calling the initialize callback) and renders until
// it's closed. Returns 0, or 1 if the command line or the initialization failed.
// The command line is NRIFramework's (--api=D3D12, --debugAPI, --frameNum=<n>, --help, ...), with
// the examples' options translated to it: -dx11, -dx12, -vk (--api), -debug (--debugAPI
// --debugNRI), -test (renders testFrames frames, unfocused too, see Nri_IsTest), -testOutput <file>
// (Nri_ReadBufferRGBA8 saves the frame it reads there, as PNG). V-sync is on.
declare function Nri_RunSample(sample: NriSampleHandle, argc: int, argv: Ref<string>, title: string, testFrames: int): int;
// An option of the example's (a flag it reads with Nri_GetArg), which Nri_RunSample leaves out of
// NRIFramework's command line (which would reject it); before Nri_RunSample.
@nodrops declare function Nri_AddExampleOption(sample: NriSampleHandle, option: string): void;
// The command line's argument index (main's argc and argv), "" past its end.
@nodrops declare function Nri_GetArg(argc: int, argv: Ref<string>, index: int): string;
// -test was given: Nri_RunSample rendered the test's frames.
@nodrops declare function Nri_IsTest(sample: NriSampleHandle): int;
@nodrops declare function Nri_GetOutputWidth(sample: NriSampleHandle): int;
@nodrops declare function Nri_GetOutputHeight(sample: NriSampleHandle): int;
// 1 if the key was pressed since the last call (for this key), else 0.
@nodrops declare function Nri_IsKeyToggled(sample: NriSampleHandle, key: NriKey): int;
@nodrops declare function Nri_SetWindowTitle(sample: NriSampleHandle, title: string): void;
// 1 if the key (a GLFW key code: NriKey, or Donut's Key) is down, else 0.
@nodrops declare function Nri_IsKeyPressed(sample: NriSampleHandle, key: int): int;
// 1 if the mouse button (0 left, 1 right, 2 middle) is down, else 0.
@nodrops declare function Nri_IsButtonPressed(sample: NriSampleHandle, button: int): int;
// How far the mouse moved since the last frame, in pixels (x right, y down).
@nodrops declare function Nri_GetMouseDeltaX(sample: NriSampleHandle): number;
@nodrops declare function Nri_GetMouseDeltaY(sample: NriSampleHandle): number;
// The mouse wheel's turn this frame.
@nodrops declare function Nri_GetMouseWheel(sample: NriSampleHandle): number;
// The last frame's duration, in seconds.
@nodrops declare function Nri_GetFrameTime(sample: NriSampleHandle): number;
// The frames in flight (2 with v-sync).
@nodrops declare function Nri_GetQueuedFrameNum(sample: NriSampleHandle): int;

// The device. Nri_CreateDevice fills the interface tables the other functions call through: one
// device at a time.
// The device of the adapter and with the validation the command line chose, null on failure.
@nodrops declare function Nri_CreateDevice(sample: NriSampleHandle, graphicsAPI: NriGraphicsAPI): NriDeviceHandle | null;
@nodrops declare function Nri_DestroyDevice(device: NriDeviceHandle): void;
@nodrops declare function Nri_DeviceWaitIdle(device: NriDeviceHandle): void;
// "D3D12", "VK", ...
@nodrops declare function Nri_GetGraphicsAPIString(graphicsAPI: NriGraphicsAPI): string;
@nodrops declare function Nri_GetAdapterName(device: NriDeviceHandle): string;
// The alignment of the rows of a texture read back into a buffer.
@nodrops declare function Nri_GetUploadBufferTextureRowAlignment(device: NriDeviceHandle): int;
@nodrops declare function Nri_GetGraphicsQueue(device: NriDeviceHandle): NriQueueHandle;
// The device's compute queue, null if it has none.
@nodrops declare function Nri_GetComputeQueue(device: NriDeviceHandle): NriQueueHandle | null;
// 1 if the device has the feature, else 0.
@nodrops declare function Nri_IsFeatureSupported(device: NriDeviceHandle, feature: NriFeature): int;

// Synchronization
@nodrops declare function Nri_CreateFence(device: NriDeviceHandle, initialValue: int): NriFenceHandle;
// A fence for a swap chain's acquire and release (nri::SWAPCHAIN_SEMAPHORE).
@nodrops declare function Nri_CreateSwapChainSemaphore(device: NriDeviceHandle): NriFenceHandle;
@nodrops declare function Nri_DestroyFence(fence: NriFenceHandle): void;
// Waits on the CPU until the fence reaches value.
@nodrops declare function Nri_Wait(fence: NriFenceHandle, value: int): void;

// The swap chain: over the sample's window, its size, v-sync as the command line chose.
@nodrops declare function Nri_CreateSwapChain(sample: NriSampleHandle, device: NriDeviceHandle, queue: NriQueueHandle, textureNum: int): NriSwapChainHandle;
@nodrops declare function Nri_DestroySwapChain(swapChain: NriSwapChainHandle): void;
@nodrops declare function Nri_GetSwapChainTextureNum(swapChain: NriSwapChainHandle): int;
@nodrops declare function Nri_GetSwapChainTexture(swapChain: NriSwapChainHandle, index: int): NriTextureHandle;
// The index of the next texture to render into, once acquireSemaphore is signaled; -1 on failure.
@nodrops declare function Nri_AcquireNextTexture(swapChain: NriSwapChainHandle, acquireSemaphore: NriFenceHandle): int;
// Presents once releaseSemaphore is signaled; 0 on failure.
@nodrops declare function Nri_QueuePresent(swapChain: NriSwapChainHandle, releaseSemaphore: NriFenceHandle): int;

// Textures and views
@nodrops declare function Nri_GetTextureFormat(texture: NriTextureHandle): NriFormat;
@nodrops declare function Nri_GetFormatName(format: NriFormat): string;
// The sRGB format of an 8-bit RGBA or BGRA UNORM format, else the format itself: the swap chain's
// textures are UNORM, their color attachment views may be sRGB (as Donut's back buffers are).
@nodrops declare function Nri_GetSrgbFormat(format: NriFormat): NriFormat;
@nodrops declare function Nri_CreateColorAttachmentView(texture: NriTextureHandle, format: NriFormat): NriDescriptorHandle;
@nodrops declare function Nri_CreateDepthAttachmentView(texture: NriTextureHandle, format: NriFormat): NriDescriptorHandle;
@nodrops declare function Nri_DestroyDescriptor(descriptor: NriDescriptorHandle): void;
// A width x height depth texture in device memory, moved on the queue (which this waits for) to
// NriTextureState.DepthAttachment, where it stays (no barriers needed); null on failure.
@nodrops declare function Nri_CreateDepthTexture(device: NriDeviceHandle, queue: NriQueueHandle, width: int, height: int, format: NriFormat): NriTextureHandle | null;
// Destroys a texture Nri_CreateDepthTexture made and frees its memory.
@nodrops declare function Nri_DestroyTexture(texture: NriTextureHandle): void;

// Buffers
// A buffer of byteSize bytes in memory the CPU reads, bound to its memory; null on failure.
@nodrops declare function Nri_CreateReadbackBuffer(device: NriDeviceHandle, byteSize: int): NriBufferHandle | null;
// Destroys the buffer and frees its memory.
@nodrops declare function Nri_DestroyBuffer(buffer: NriBufferHandle): void;
// Copies count floats from the start of the buffer (a readback buffer, after the GPU wrote it) to
// dst; 1, or 0 if it can't be read.
@nodrops declare function Nri_ReadBufferFloats(buffer: NriBufferHandle, dst: Ref<f32>, count: int): int;
// A buffer of byteSize bytes in device memory, filled with data's byteSize bytes (Ref of an array
// element) on the queue, which this waits for; null on failure.
@nodrops declare function Nri_CreateUploadedBuffer(device: NriDeviceHandle, queue: NriQueueHandle, data: Ref<f32>, byteSize: int, usage: NriBufferUsage): NriBufferHandle | null;
// A buffer of byteSize bytes in memory the CPU writes (Nri_WriteBuffer) and the GPU reads, for usage
// (NriBufferUsage.ConstantBuffer); null on failure.
@nodrops declare function Nri_CreateHostBuffer(device: NriDeviceHandle, byteSize: int, usage: NriBufferUsage): NriBufferHandle | null;
// Nri_CreateHostBuffer's buffer, for usage StructuredBuffer too: structures stride bytes each.
@nodrops declare function Nri_CreateHostBufferWithStride(device: NriDeviceHandle, byteSize: int, usage: NriBufferUsage,
    stride: int): NriBufferHandle | null;
// Copies byteSize bytes of data (Ref of an f32 array element) into the buffer at offset; 0 on failure.
@nodrops declare function Nri_WriteBuffer(buffer: NriBufferHandle, offset: int, data: Ref<f32>, byteSize: int): int;
// A view of byteSize bytes of the buffer from offset, as a constant buffer; null on failure.
// A buffer of byteSize bytes of structures stride bytes each in device memory, which compute
// shaders write (RWStructuredBuffer) and shaders read (StructuredBuffer), with data uploaded on the
// queue (which this waits for), then in NriBufferState.Storage; null on failure.
@nodrops declare function Nri_CreateStorageBuffer(device: NriDeviceHandle, queue: NriQueueHandle, data: Ref<f32>, byteSize: int,
    stride: int): NriBufferHandle | null;
// A view of the whole buffer (Nri_CreateStorageBuffer's) as structures: written by compute shaders
// (storage, 1: RWStructuredBuffer) or read (0: StructuredBuffer); null on failure.
// Nri_CreateStorageBuffer's buffer, but of ints (Ref of an int array element), with structures stride
// bytes each (4: raw, a ByteAddressBuffer's), then in state: in IndirectArgument or
// IndirectArgumentAndComputeResource, indirect draws can take their arguments from it too.
@nodrops declare function Nri_CreateStorageBufferFromInts(device: NriDeviceHandle, queue: NriQueueHandle, data: Ref<int>, byteSize: int,
    stride: int, state: NriBufferState): NriBufferHandle | null;
@nodrops declare function Nri_CreateStructuredBufferView(buffer: NriBufferHandle, storage: int): NriDescriptorHandle | null;
@nodrops declare function Nri_CreateConstantBufferView(buffer: NriBufferHandle, offset: int, byteSize: int): NriDescriptorHandle | null;
// Nri_CreateUploadedBuffer from an int array (index data).
@nodrops declare function Nri_CreateUploadedBufferFromInts(device: NriDeviceHandle, queue: NriQueueHandle, data: Ref<int>, byteSize: int, usage: NriBufferUsage): NriBufferHandle | null;
// The pixels of an 8-bit RGBA or BGRA texture read back into the buffer (rowPitch bytes a row),
// one int each with red in the low byte (0xAABBGGRR; BGRA swapped), row by row into dst
// (pixelCount ints; Ref of an int array element). 0 if the buffer can't be mapped or the format
// isn't one of those.
@nodrops declare function Nri_ReadBufferRGBA8(buffer: NriBufferHandle, rowPitch: int, width: int, height: int, format: NriFormat, dst: Ref<int>, pixelCount: int): int;

// Commands
@nodrops declare function Nri_CreateCommandAllocator(queue: NriQueueHandle): NriCommandAllocatorHandle;
@nodrops declare function Nri_DestroyCommandAllocator(allocator: NriCommandAllocatorHandle): void;
@nodrops declare function Nri_ResetCommandAllocator(allocator: NriCommandAllocatorHandle): void;
@nodrops declare function Nri_CreateCommandBuffer(allocator: NriCommandAllocatorHandle): NriCommandBufferHandle;
@nodrops declare function Nri_DestroyCommandBuffer(commandBuffer: NriCommandBufferHandle): void;
// Without a descriptor pool (the examples bind no descriptor sets).
@nodrops declare function Nri_BeginCommandBuffer(commandBuffer: NriCommandBufferHandle): void;
@nodrops declare function Nri_EndCommandBuffer(commandBuffer: NriCommandBufferHandle): void;
// Moves the whole texture from one state to another.
// A barrier moving the buffer from the state before to after; from Storage to Storage, the writes
// before are seen by the accesses after.
// Copies byteSize bytes from the start of src (in NriBufferState.CopySource) to the start of dst
// (e.g. a readback buffer).
@nodrops declare function Nri_CmdCopyBuffer(commandBuffer: NriCommandBufferHandle, dst: NriBufferHandle, src: NriBufferHandle, byteSize: int): void;
// Zeroes the whole buffer (in NriBufferState.CopyDestination).
// The buffer's device address (a GPU pointer) as two 32-bit halves at dst (Ref of an f32 array
// element: push constants, or a table written with Nri_WriteBuffer; only passed on, never computed
// with: the halves needn't be valid floats); 1, or 0 without one (Vulkan with bufferDeviceAddress only).
@nodrops declare function Nri_GetBufferDeviceAddress(device: NriDeviceHandle, buffer: NriBufferHandle, dst: Ref<f32>): int;
@nodrops declare function Nri_CmdZeroBuffer(commandBuffer: NriCommandBufferHandle, buffer: NriBufferHandle): void;
// drawNum indexed draws whose arguments (5 uints: D3D12_DRAW_INDEXED_ARGUMENTS) are in buffer from
// offset, stride bytes apart (in NriBufferState.IndirectArgument); with a countBuffer
// (NriFeature.DrawIndirectCount), the uint at its countOffset, at most drawNum.
@nodrops declare function Nri_CmdDrawIndexedIndirect(commandBuffer: NriCommandBufferHandle, buffer: NriBufferHandle, offset: int, drawNum: int,
    stride: int, countBuffer: NriBufferHandle | null, countOffset: int): void;
@nodrops declare function Nri_CmdBufferBarrier(commandBuffer: NriCommandBufferHandle, buffer: NriBufferHandle, before: NriBufferState,
    after: NriBufferState): void;
@nodrops declare function Nri_CmdTextureBarrier(commandBuffer: NriCommandBufferHandle, texture: NriTextureHandle, before: NriTextureState, after: NriTextureState): void;
// Renders into one color attachment, a view Nri_CreateColorAttachmentView made.
@nodrops declare function Nri_CmdBeginRendering(commandBuffer: NriCommandBufferHandle, colorAttachment: NriDescriptorHandle): void;
// Renders into one color attachment and a depth attachment (Nri_CreateDepthAttachmentView's).
@nodrops declare function Nri_CmdBeginRenderingWithDepth(commandBuffer: NriCommandBufferHandle, colorAttachment: NriDescriptorHandle, depthAttachment: NriDescriptorHandle): void;
@nodrops declare function Nri_CmdEndRendering(commandBuffer: NriCommandBufferHandle): void;
// Clears the whole depth attachment (after Nri_CmdBeginRenderingWithDepth).
@nodrops declare function Nri_CmdClearDepth(commandBuffer: NriCommandBufferHandle, depth: float): void;
// Binds a vertex buffer from offset bytes in, its vertices stride bytes apart, to stream slot.
@nodrops declare function Nri_CmdSetVertexBuffer(commandBuffer: NriCommandBufferHandle, slot: int, buffer: NriBufferHandle, offset: int, stride: int): void;
// The descriptor pool the command buffer's descriptor sets come from (before Nri_CmdSetDescriptorSet).
@nodrops declare function Nri_CmdSetDescriptorPool(commandBuffer: NriCommandBufferHandle, descriptorPool: NriDescriptorPoolHandle): void;
// Binds a descriptor set (of the graphics pipeline layout's set setIndex) as set setIndex.
@nodrops declare function Nri_CmdSetDescriptorSet(commandBuffer: NriCommandBufferHandle, setIndex: int, descriptorSet: NriDescriptorSetHandle): void;
// The depth bounds test's range (NriFeature.DepthBoundsTest; a pipeline with the test on).
@nodrops declare function Nri_CmdSetDepthBounds(commandBuffer: NriCommandBufferHandle, boundsMin: float, boundsMax: float): void;
// Clears the whole color attachment (between Nri_CmdBeginRendering and Nri_CmdEndRendering).
@nodrops declare function Nri_CmdClearColor(commandBuffer: NriCommandBufferHandle, r: float, g: float, b: float, a: float): void;
@nodrops declare function Nri_CmdSetViewport(commandBuffer: NriCommandBufferHandle, x: float, y: float, width: float, height: float): void;
@nodrops declare function Nri_CmdSetScissor(commandBuffer: NriCommandBufferHandle, x: int, y: int, width: int, height: int): void;
@nodrops declare function Nri_CmdSetPipelineLayout(commandBuffer: NriCommandBufferHandle, pipelineLayout: NriPipelineLayoutHandle): void;
@nodrops declare function Nri_CmdSetPipeline(commandBuffer: NriCommandBufferHandle, pipeline: NriPipelineHandle): void;
@nodrops declare function Nri_CmdDraw(commandBuffer: NriCommandBufferHandle, vertexNum: int, instanceNum: int, baseVertex: int, baseInstance: int): void;
// Binds a view (Nri_CreateConstantBufferView's) as the graphics layout's root descriptor
// rootDescriptorIndex (in the order the layout added them), offset bytes further into its buffer (a
// multiple of 256).
@nodrops declare function Nri_CmdSetRootDescriptor(commandBuffer: NriCommandBufferHandle, rootDescriptorIndex: int, descriptor: NriDescriptorHandle, offset: int): void;
// Binds an index buffer from offset bytes in.
@nodrops declare function Nri_CmdSetIndexBuffer(commandBuffer: NriCommandBufferHandle, buffer: NriBufferHandle, offset: int, indexType: NriIndexType): void;
@nodrops declare function Nri_CmdDrawIndexed(commandBuffer: NriCommandBufferHandle, indexNum: int, instanceNum: int, baseIndex: int, baseVertex: int, baseInstance: int): void;
// The compute bind point's Nri_CmdSetPipelineLayout, Nri_CmdSetDescriptorSet,
// Nri_CmdSetRootDescriptor (no offset) and Nri_CmdSetRootConstants (for Nri_CmdDispatch).
@nodrops declare function Nri_CmdSetComputePipelineLayout(commandBuffer: NriCommandBufferHandle, pipelineLayout: NriPipelineLayoutHandle): void;
@nodrops declare function Nri_CmdSetComputeDescriptorSet(commandBuffer: NriCommandBufferHandle, setIndex: int, descriptorSet: NriDescriptorSetHandle): void;
@nodrops declare function Nri_CmdSetComputeRootDescriptor(commandBuffer: NriCommandBufferHandle, rootDescriptorIndex: int, descriptor: NriDescriptorHandle): void;
@nodrops declare function Nri_CmdSetComputeRootConstants(commandBuffer: NriCommandBufferHandle, rootConstantIndex: int, data: Ref<f32>, size: int): void;
// Dispatches x * y * z groups of the compute pipeline set.
@nodrops declare function Nri_CmdDispatch(commandBuffer: NriCommandBufferHandle, x: int, y: int, z: int): void;
// Sets the graphics layout's root constants rootConstantIndex (in the order the layout added them)
// to size bytes of data (Ref of an f32 array element).
@nodrops declare function Nri_CmdSetRootConstants(commandBuffer: NriCommandBufferHandle, rootConstantIndex: int, data: Ref<f32>, size: int): void;
// Stores value's bits in a float slot: an int field of root constants kept in an f32 array.
@nodrops declare function Nri_StoreInt32(dst: Ref<f32>, value: int): void;
// Dispatches x * y * z mesh shader workgroups, or task shader workgroups with a task shader
// (NriFeature.MeshShader).
@nodrops declare function Nri_CmdDrawMeshTasks(commandBuffer: NriCommandBufferHandle, x: int, y: int, z: int): void;
// Copies the texture's top left width x height pixels (in NriTextureState.CopySource) into the
// buffer, rows rowPitch bytes apart (a multiple of Nri_GetUploadBufferTextureRowAlignment).
@nodrops declare function Nri_CmdReadbackTextureToBuffer(commandBuffer: NriCommandBufferHandle, buffer: NriBufferHandle, rowPitch: int, texture: NriTextureHandle, width: int, height: int): void;

// Submission
// Runs the command buffer once waitSemaphore (a swap chain's acquire) is signaled; signals
// signalSemaphore (the swap chain's release) when done.
@nodrops declare function Nri_QueueSubmit(queue: NriQueueHandle, commandBuffer: NriCommandBufferHandle, waitSemaphore: NriFenceHandle, signalSemaphore: NriFenceHandle): void;
// Makes the work submitted to the queue from now on wait until the fence reaches value (on the GPU).
@nodrops declare function Nri_QueueWait(queue: NriQueueHandle, fence: NriFenceHandle, value: int): void;
// Runs the command buffer once waitFence (if not null) reaches waitValue (e.g. another queue's
// timeline), and signals signalFence with signalValue when done: one submission.
@nodrops declare function Nri_QueueSubmitWithFences(queue: NriQueueHandle, commandBuffer: NriCommandBufferHandle, waitFence: NriFenceHandle | null,
    waitValue: int, signalFence: NriFenceHandle, signalValue: int): void;
// Signals the fence with value once the work submitted before is done.
@nodrops declare function Nri_QueueSignal(queue: NriQueueHandle, fence: NriFenceHandle, value: int): void;

// Pipelines
// A layout binding nothing, for the graphics stages (vertex or mesh, fragment).
@nodrops declare function Nri_CreatePipelineLayout(device: NriDeviceHandle): NriPipelineLayoutHandle;
@nodrops declare function Nri_DestroyPipelineLayout(pipelineLayout: NriPipelineLayoutHandle): void;
// A pipeline drawing triangles from no vertex buffer, not culled, into one color attachment of
// colorFormat, unblended. The shaders' bytecode is read from vsPath and psPath, relative to the
// directory of the executable (of nri_interop's library under the JIT: bin/). Null on failure.
@nodrops declare function Nri_CreateGraphicsPipeline(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle,
    vsPath: string, vsEntry: string, psPath: string, psEntry: string, colorFormat: NriFormat): NriPipelineHandle | null;
// As Nri_CreateGraphicsPipeline, with a mesh shader (msPath, msEntry) making the triangles instead
// of a vertex shader. Needs NriFeature.MeshShader.
@nodrops declare function Nri_CreateMeshPipeline(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle,
    msPath: string, msEntry: string, psPath: string, psEntry: string, colorFormat: NriFormat): NriPipelineHandle | null;
// As Nri_CreateMeshPipeline, with a task (amplification) shader (taskPath, taskEntry) launching the
// mesh shader's workgroups.
@nodrops declare function Nri_CreateTaskMeshPipeline(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle,
    taskPath: string, taskEntry: string, msPath: string, msEntry: string, psPath: string, psEntry: string,
    colorFormat: NriFormat): NriPipelineHandle | null;
@nodrops declare function Nri_DestroyPipeline(pipeline: NriPipelineHandle): void;

// Pipeline descs: a graphics pipeline's shaders and states, set one by one. A new desc draws
// triangles, not culled, without vertex input, color attachment or depth.
@nodrops declare function Nri_CreatePipelineDesc(): NriPipelineDescHandle;
@nodrops declare function Nri_DestroyPipelineDesc(desc: NriPipelineDescHandle): void;
// Adds a shader read from path (as Nri_CreateGraphicsPipeline's); 0 if it can't be read.
@nodrops declare function Nri_PipelineDescAddShader(desc: NriPipelineDescHandle, stage: NriShaderStage, path: string, entry: string): int;
// An attribute of stream 0's vertices: semantic (index 0) on D3D, the next location on Vulkan (as
// DXC numbers the vertex shader's inputs), format at offset bytes in the vertex.
@nodrops declare function Nri_PipelineDescAddVertexAttribute(desc: NriPipelineDescHandle, semantic: string, format: NriFormat, offset: int): void;
// As Nri_PipelineDescAddVertexAttribute, of stream's vertices (the vertex buffer bound to slot stream).
@nodrops declare function Nri_PipelineDescAddVertexAttributeFromStream(desc: NriPipelineDescHandle, semantic: string, format: NriFormat,
    offset: int, stream: int): void;
// The faces culled (None by default), clockwise ones the front.
// The stream's attributes advance per instance, not per vertex.
// Primitive restart for indexType's indices (0xFFFF or 0xFFFFFFFF end a strip).
@nodrops declare function Nri_PipelineDescSetPrimitiveRestart(desc: NriPipelineDescHandle, indexType: NriIndexType): void;
@nodrops declare function Nri_PipelineDescSetInstanceStream(desc: NriPipelineDescHandle, stream: int): void;
@nodrops declare function Nri_PipelineDescSetCullMode(desc: NriPipelineDescHandle, cullMode: NriCullMode): void;
// The color attachment's format and the channels written (NriColorWrite bits).
@nodrops declare function Nri_PipelineDescSetColor(desc: NriPipelineDescHandle, format: NriFormat, writeMask: int): void;
// Additive blending into the color attachment, as Donut's BlendMode.Additive: color one + one, alpha
// srcAlpha + dstAlpha.
@nodrops declare function Nri_PipelineDescSetAdditiveBlend(desc: NriPipelineDescHandle): void;
// The depth attachment's format, its test (NriCompareOp.None: off), whether it's written (1) and
// whether the depth bounds test is on (1; NriFeature.DepthBoundsTest).
@nodrops declare function Nri_PipelineDescSetDepth(desc: NriPipelineDescHandle, format: NriFormat, compareOp: NriCompareOp, write: int, boundsTest: int): void;
// The primitives drawn (TriangleList by default).
@nodrops declare function Nri_PipelineDescSetTopology(desc: NriPipelineDescHandle, topology: NriTopology): void;
// The pipeline the desc describes, with the layout; null on failure.
@nodrops declare function Nri_CreatePipelineFromDesc(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle, desc: NriPipelineDescHandle): NriPipelineHandle | null;

// Pipeline layouts with descriptor sets, their ranges added one by one.
@nodrops declare function Nri_CreatePipelineLayoutDesc(): NriPipelineLayoutDescHandle;
@nodrops declare function Nri_DestroyPipelineLayoutDesc(desc: NriPipelineLayoutDescHandle): void;
// A range of descriptorNum descriptors of type from register baseRegister (t, s or b by type) in set
// setIndex (register space setIndex unless Nri_PipelineLayoutDescSetRegisterSpace says otherwise),
// seen by stages (NriStage); flags: NriRangeFlags bits.
@nodrops declare function Nri_PipelineLayoutDescAddRange(desc: NriPipelineLayoutDescHandle, setIndex: int, baseRegister: int,
    descriptorNum: int, type: NriDescriptorType, stages: NriStage, flags: int): void;
// The register space of set setIndex (on Vulkan, its set number).
@nodrops declare function Nri_PipelineLayoutDescSetRegisterSpace(desc: NriPipelineLayoutDescHandle, setIndex: int, registerSpace: int): void;
// size bytes of root constants (push constants) at register b<registerIndex>, space 0, for stages.
@nodrops declare function Nri_PipelineLayoutDescAddRootConstants(desc: NriPipelineLayoutDescHandle, registerIndex: int, size: int, stages: NriStage): void;
// A root descriptor (push descriptor) of type (a constant buffer, or a structured buffer) at
// register b, t or u<registerIndex> (by type), space 0, for stages: bound per draw with an offset
// (Nri_CmdSetRootDescriptor), as a dynamic uniform buffer is, or per dispatch.
@nodrops declare function Nri_PipelineLayoutDescAddRootDescriptor(desc: NriPipelineLayoutDescHandle, registerIndex: int, type: NriDescriptorType, stages: NriStage): void;
// An immutable (static) sampler at register s<registerIndex>, space 0: filter for minification and
// magnification, mipFilter for mips, addressMode on all axes, for stages.
@nodrops declare function Nri_PipelineLayoutDescAddRootSampler(desc: NriPipelineLayoutDescHandle, registerIndex: int, filter: NriFilter,
    mipFilter: NriFilter, addressMode: NriAddressMode, stages: NriStage): void;
// The layout the desc describes, for the stages its ranges and root parameters are for; null on failure.
@nodrops declare function Nri_CreatePipelineLayoutFromDesc(device: NriDeviceHandle, desc: NriPipelineLayoutDescHandle): NriPipelineLayoutHandle | null;

// Descriptor pools and sets
// A pool of setMaxNum descriptor sets holding at most samplerMaxNum samplers, constantBufferMaxNum
// constant buffers, textureMaxNum textures and storageTextureMaxNum storage textures in all;
// updateAfterSet (1) for sets with ranges updated after binding (NriRangeFlags.UpdateAfterSet). Null
// on failure.
@nodrops declare function Nri_CreateDescriptorPool(device: NriDeviceHandle, setMaxNum: int, samplerMaxNum: int,
    constantBufferMaxNum: int, textureMaxNum: int, storageTextureMaxNum: int, updateAfterSet: int): NriDescriptorPoolHandle | null;
// Destroys the pool and the sets allocated from it.
@nodrops declare function Nri_DestroyDescriptorPool(descriptorPool: NriDescriptorPoolHandle): void;
// Forgets the sets allocated from the pool, which may allocate as many again.
@nodrops declare function Nri_ResetDescriptorPool(descriptorPool: NriDescriptorPoolHandle): void;
// A descriptor set for the layout's set setIndex, from the pool, its variable-sized array (if any)
// variableDescriptorNum long; null on failure.
@nodrops declare function Nri_AllocateDescriptorSet(descriptorPool: NriDescriptorPoolHandle, pipelineLayout: NriPipelineLayoutHandle,
    setIndex: int, variableDescriptorNum: int): NriDescriptorSetHandle | null;
// Puts the descriptor in the set's range rangeIndex (in the order the layout added them), at element.
@nodrops declare function Nri_UpdateDescriptor(descriptorSet: NriDescriptorSetHandle, rangeIndex: int, element: int, descriptor: NriDescriptorHandle): void;
// A sampler: filter for minification, magnification and mips, addressMode on all axes, anisotropy
// (its maximum; 1: none); null on failure.
// A sampler: filter for minification and magnification, mipFilter between mips, addressMode on all
// axes, anisotropy (1: none); null on failure.
@nodrops declare function Nri_CreateSamplerWithMipFilter(device: NriDeviceHandle, filter: NriFilter, mipFilter: NriFilter,
    addressMode: NriAddressMode, anisotropy: int): NriDescriptorHandle | null;
// The device's widest anisotropic filtering (16 on most).
@nodrops declare function Nri_GetMaxSamplerAnisotropy(device: NriDeviceHandle): int;
@nodrops declare function Nri_CreateSampler(device: NriDeviceHandle, filter: NriFilter, addressMode: NriAddressMode, anisotropy: int): NriDescriptorHandle | null;
// A view of a 2D texture's mips for shaders to read.
@nodrops declare function Nri_CreateTextureView(texture: NriTextureHandle, format: NriFormat): NriDescriptorHandle;

// Textures shaders read (destroyed with Nri_DestroyTexture): committed, or placed in memory.
// A width x height texture (one mip) of NRI's choosing (D3D12: a committed resource); null on failure.
@nodrops declare function Nri_CreateCommittedTexture(device: NriDeviceHandle, width: int, height: int, format: NriFormat): NriTextureHandle | null;
// The bytes a width x height texture (one mip) takes placed in memory, rounded up to its alignment
// (D3D12: 4 KB for a small one); 0 on failure.
@nodrops declare function Nri_GetPlacedTextureSize(device: NriDeviceHandle, width: int, height: int, format: NriFormat): number;
// byteSize bytes of device memory for width x height textures of format to be placed in; null on failure.
@nodrops declare function Nri_AllocateTextureMemory(device: NriDeviceHandle, byteSize: number, width: int, height: int, format: NriFormat): NriMemoryHandle | null;
// Frees memory, once the textures placed in it are destroyed.
@nodrops declare function Nri_FreeMemory(memory: NriMemoryHandle): void;
// A width x height texture (one mip) placed in memory at offset bytes; null on failure.
@nodrops declare function Nri_CreatePlacedTexture(device: NriDeviceHandle, memory: NriMemoryHandle, offset: number, width: int, height: int,
    format: NriFormat): NriTextureHandle | null;
// Fills the texture's mip 0 with data (Ref of an int array element), rows (of blocks, for a
// block-compressed format) rowPitch bytes apart, on the queue (which this waits for); leaves it in
// NriTextureState.ShaderResource. 0 on failure.
@nodrops declare function Nri_UploadTexture(queue: NriQueueHandle, texture: NriTextureHandle, data: Ref<int>, rowPitch: int): int;
// The application's device memory in use, in bytes.
@nodrops declare function Nri_GetDeviceMemoryUsage(device: NriDeviceHandle): number;

// Random numbers, as the samples' C++ draws them: a std::default_random_engine seeded with seed (a
// negative one: from std::random_device, different every run).
@nodrops declare function Nri_CreateRandomEngine(seed: int): NriRandomEngineHandle;
// count numbers from one std::normal_distribution<float>(mean, stddev) into dst (Ref of an f32 array
// element).
@nodrops declare function Nri_RandomNormalFloats(randomEngine: NriRandomEngineHandle, mean: number, stddev: number, count: int, dst: Ref<f32>): void;
@nodrops declare function Nri_DestroyRandomEngine(randomEngine: NriRandomEngineHandle): void;
// The engine's next number from std::uniform_real_distribution<float>(a, b).
@nodrops declare function Nri_RandomUniformFloat(randomEngine: NriRandomEngineHandle, a: number, b: number): number;

// Files: read whole from path (relative to the executable's directory, as the shaders), their
// regions uploaded.
@nodrops declare function Nri_LoadFile(path: string): NriFileHandle | null;
@nodrops declare function Nri_DestroyFile(file: NriFileHandle): void;
// Nri_CreateUploadedBuffer from byteSize bytes of the file at offset; null if they're past its end.
@nodrops declare function Nri_CreateUploadedBufferFromFile(device: NriDeviceHandle, queue: NriQueueHandle, file: NriFileHandle, offset: int,
    byteSize: int, usage: NriBufferUsage): NriBufferHandle | null;
// Nri_UploadTexture from the file at offset; 0 if the texture's data would run past its end.
@nodrops declare function Nri_UploadTextureFromFile(queue: NriQueueHandle, texture: NriTextureHandle, file: NriFileHandle, offset: int,
    rowPitch: int): int;
// An image file's texture (PNG, JPEG, ... through stb_image): mip 0, RGBA8 (sRGB 1: RGBA8_SRGB, as
// Donut's sRGB loads), uploaded on the queue (which this waits for), in NriTextureState.ShaderResource;
// null if it can't be read. Destroyed with Nri_DestroyTexture.
// A texture file (DDS, KTX, ... as NRIFramework's utils::LoadTexture reads them) with all its mip
// levels, in its format (sRGB: 1, the format's sRGB variant for RGBA8 and BGRA8), uploaded on the
// queue and left in NriTextureState.ShaderResource; null if it can't be read.
@nodrops declare function Nri_LoadTexture(device: NriDeviceHandle, queue: NriQueueHandle, path: string, sRGB: int): NriTextureHandle | null;
@nodrops declare function Nri_LoadImageTexture(device: NriDeviceHandle, queue: NriQueueHandle, path: string, sRGB: int): NriTextureHandle | null;

// ImGui (NRIFramework's, drawn by NRI's Imgui extension). A frame: Nri_ImguiNewFrame, the widgets,
// Nri_ImguiRender (before recording); Nri_CmdCopyImguiData outside a render pass, Nri_CmdDrawImgui
// inside one; Nri_ImguiEndFrame after the frame's submission.
// The example draws ImGui: before Nri_RunSample (on D3D11 the device then replays command buffers on
// the immediate context, which ImGui's geometry needs).
@nodrops declare function Nri_UseImgui(sample: NriSampleHandle): void;
// ImGui and its renderer for the device (after Nri_UseImgui); 1, or 0 on failure. Destroyed with
// Nri_DestroyImgui, before the device.
@nodrops declare function Nri_InitImgui(sample: NriSampleHandle, device: NriDeviceHandle): int;
@nodrops declare function Nri_DestroyImgui(sample: NriSampleHandle): void;
@nodrops declare function Nri_ImguiNewFrame(sample: NriSampleHandle): void;
@nodrops declare function Nri_ImguiRender(sample: NriSampleHandle): void;
@nodrops declare function Nri_CmdCopyImguiData(sample: NriSampleHandle, commandBuffer: NriCommandBufferHandle): void;
// Draws the UI into the render pass's color attachment, of attachmentFormat (sRGB or not).
@nodrops declare function Nri_CmdDrawImgui(sample: NriSampleHandle, commandBuffer: NriCommandBufferHandle, attachmentFormat: NriFormat): void;
@nodrops declare function Nri_ImguiEndFrame(sample: NriSampleHandle): void;
// 1 if ImGui uses the mouse (it's over a window, or dragging a widget): the example shouldn't.
@nodrops declare function Nri_ImguiWantsMouse(): int;
// The widgets, as Donut's ImGui wrappers.
@nodrops declare function Nri_ImguiSetNextWindowPos(x: number, y: number): void;
// autoResize != 0: the window fits its contents. Always pair with Nri_ImguiEnd.
@nodrops declare function Nri_ImguiBegin(title: string, autoResize: int): void;
@nodrops declare function Nri_ImguiEnd(): void;
@nodrops declare function Nri_ImguiText(text: string): void;
@nodrops declare function Nri_ImguiPushItemWidth(width: number): void;
@nodrops declare function Nri_ImguiPopItemWidth(): void;
// Expanded until the user collapses it (defaultOpen != 0); 1 while expanded.
@nodrops declare function Nri_ImguiCollapsingHeader(label: string, defaultOpen: int): int;
// The checkbox's new state (value, unless it was clicked).
@nodrops declare function Nri_ImguiCheckbox(label: string, value: int): int;
// The selection among items (separated by '|').
@nodrops declare function Nri_ImguiCombo(label: string, current: int, items: string): int;
@nodrops declare function Nri_ImguiSliderFloat(label: string, value: number, min: number, max: number): number;
@nodrops declare function Nri_ImguiSliderInt(label: string, value: int, min: int, max: int): int;

// Compute
// A compute pipeline of the shader read from path (as Nri_CreateGraphicsPipeline's); null on failure.
@nodrops declare function Nri_CreateComputePipeline(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle, path: string,
    entry: string): NriPipelineHandle | null;
// A width x height texture (one mip) compute shaders write (RWTexture2D) and pixel shaders read,
// shared by the queues, moved on the queue (which this waits for) to NriTextureState.Storage; null on
// failure. Destroyed with Nri_DestroyTexture.
@nodrops declare function Nri_CreateStorageTexture(device: NriDeviceHandle, queue: NriQueueHandle, width: int, height: int,
    format: NriFormat): NriTextureHandle | null;
// A view of a 2D texture's mip 0 for compute shaders to write.
@nodrops declare function Nri_CreateStorageTextureView(texture: NriTextureHandle, format: NriFormat): NriDescriptorHandle;

// Async compute: a C++ worker thread (tslang code can't run on threads its GC doesn't know about)
// that every intervalMicroseconds dispatches groupsX x groupsY groups of the compute pipeline on the
// compute queue, each run writing the next free texture (bound by its descriptor set as set 0, the
// run's index as root constants 0), and hands it to the render thread. The graphics queue signals
// graphicsFence with the values Nri_ReleaseAsyncComputeTexture gives. Null on failure.
@nodrops declare function Nri_CreateAsyncComputeLoop(computeQueue: NriQueueHandle, device: NriDeviceHandle, graphicsFence: NriFenceHandle,
    pipelineLayout: NriPipelineLayoutHandle, pipeline: NriPipelineHandle, descriptorPool: NriDescriptorPoolHandle, groupsX: int, groupsY: int,
    intervalMicroseconds: int): NriAsyncComputeLoopHandle | null;
// Adds a texture for the loop to write, by its descriptor set (its storage view at u0); before
// starting it. The textures are numbered from 0 in the order they're added.
@nodrops declare function Nri_AddAsyncComputeTexture(loop: NriAsyncComputeLoopHandle, descriptorSet: NriDescriptorSetHandle): void;
@nodrops declare function Nri_StartAsyncComputeLoop(loop: NriAsyncComputeLoopHandle): void;
// Stops and joins the worker thread, waits for the device to be idle, and destroys the loop.
@nodrops declare function Nri_DestroyAsyncComputeLoop(loop: NriAsyncComputeLoopHandle): void;
// On the render thread: the number of the next texture the loop finished (in NriTextureState.Storage),
// making the work submitted to graphicsQueue from now on wait for its run; -1 if none is finished.
@nodrops declare function Nri_AcquireAsyncComputeTexture(loop: NriAsyncComputeLoopHandle, graphicsQueue: NriQueueHandle): int;
// On the render thread: gives the texture numbered index back to the loop, in NriTextureState.Storage
// once the graphics queue signals graphicsFence with lastUse.
@nodrops declare function Nri_ReleaseAsyncComputeTexture(loop: NriAsyncComputeLoopHandle, index: int, lastUse: int): void;

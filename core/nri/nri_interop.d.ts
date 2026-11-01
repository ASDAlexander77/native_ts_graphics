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
    ShaderResource = 5
}

// The device features Nri_IsFeatureSupported queries (of nri::DeviceDesc).
enum NriFeature {
    // features.meshShader: Nri_CreateMeshPipeline, Nri_CmdDrawMeshTasks (D3D12, Vulkan)
    MeshShader = 0,
    // features.depthBoundsTest: Nri_PipelineDescSetDepth's boundsTest, Nri_CmdSetDepthBounds
    DepthBoundsTest = 1
}

// nri::Format, which the functions taking or returning a format pass through: the values the
// examples name (nri_interop.cpp asserts them), any other passing through as well.
enum NriFormat {
    Unknown = 0,
    BGRA8_UNORM = 9,
    BGRA8_SRGB = 10,
    RGBA8_UNORM = 11,
    RGBA8_SRGB = 12,
    R32_SFLOAT = 33,
    RG32_SFLOAT = 36,
    RGB32_SFLOAT = 39,
    RGBA32_SFLOAT = 42,
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

// nri::DescriptorType: a descriptor range's.
enum NriDescriptorType {
    Sampler = 0,
    ConstantBuffer = 1,
    Texture = 2
}

// nri::StageBits: the shader stages that see a descriptor range.
enum NriStage {
    Vertex = 2,
    Pixel = 128,
    // vertex and pixel
    VertexPixel = 130
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
    VertexBuffer = 0
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
// --debugNRI), -test (renders testFrames frames, unfocused too, see Nri_IsTest). V-sync is on.
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
// A buffer of byteSize bytes in device memory, filled with data's byteSize bytes (Ref of an array
// element) on the queue, which this waits for; null on failure.
@nodrops declare function Nri_CreateUploadedBuffer(device: NriDeviceHandle, queue: NriQueueHandle, data: Ref<f32>, byteSize: int, usage: NriBufferUsage): NriBufferHandle | null;
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
// The color attachment's format and the channels written (NriColorWrite bits).
@nodrops declare function Nri_PipelineDescSetColor(desc: NriPipelineDescHandle, format: NriFormat, writeMask: int): void;
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
// setIndex (register space setIndex), seen by stages (NriStage).
@nodrops declare function Nri_PipelineLayoutDescAddRange(desc: NriPipelineLayoutDescHandle, setIndex: int, baseRegister: int,
    descriptorNum: int, type: NriDescriptorType, stages: NriStage): void;
// The layout the desc describes, for the graphics stages; null on failure.
@nodrops declare function Nri_CreatePipelineLayoutFromDesc(device: NriDeviceHandle, desc: NriPipelineLayoutDescHandle): NriPipelineLayoutHandle | null;

// Descriptor pools and sets
// A pool of setMaxNum descriptor sets holding at most samplerMaxNum samplers, constantBufferMaxNum
// constant buffers and textureMaxNum textures in all; null on failure.
@nodrops declare function Nri_CreateDescriptorPool(device: NriDeviceHandle, setMaxNum: int, samplerMaxNum: int,
    constantBufferMaxNum: int, textureMaxNum: int): NriDescriptorPoolHandle | null;
// Destroys the pool and the sets allocated from it.
@nodrops declare function Nri_DestroyDescriptorPool(descriptorPool: NriDescriptorPoolHandle): void;
// Forgets the sets allocated from the pool, which may allocate as many again.
@nodrops declare function Nri_ResetDescriptorPool(descriptorPool: NriDescriptorPoolHandle): void;
// A descriptor set for the layout's set setIndex, from the pool; null on failure.
@nodrops declare function Nri_AllocateDescriptorSet(descriptorPool: NriDescriptorPoolHandle, pipelineLayout: NriPipelineLayoutHandle,
    setIndex: int): NriDescriptorSetHandle | null;
// Puts the descriptor in the set's range rangeIndex (in the order the layout added them), at element.
@nodrops declare function Nri_UpdateDescriptor(descriptorSet: NriDescriptorSetHandle, rangeIndex: int, element: int, descriptor: NriDescriptorHandle): void;
// A sampler: filter for minification, magnification and mips, addressMode on all axes; null on failure.
@nodrops declare function Nri_CreateSampler(device: NriDeviceHandle, filter: NriFilter, addressMode: NriAddressMode): NriDescriptorHandle | null;
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
// Fills the texture's mip 0 with data (Ref of an int array element), rows rowPitch bytes apart, on the
// queue (which this waits for); leaves it in NriTextureState.ShaderResource. 0 on failure.
@nodrops declare function Nri_UploadTexture(queue: NriQueueHandle, texture: NriTextureHandle, data: Ref<int>, rowPitch: int): int;
// The application's device memory in use, in bytes.
@nodrops declare function Nri_GetDeviceMemoryUsage(device: NriDeviceHandle): number;

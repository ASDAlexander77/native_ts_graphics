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
    Present = 3
}

// nri::Format, which the functions taking or returning a format pass through.
type NriFormat = int;

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
// -test was given: Nri_RunSample rendered the test's frames.
@nodrops declare function Nri_IsTest(sample: NriSampleHandle): int;
@nodrops declare function Nri_GetOutputWidth(sample: NriSampleHandle): int;
@nodrops declare function Nri_GetOutputHeight(sample: NriSampleHandle): int;
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
@nodrops declare function Nri_CreateColorAttachmentView(texture: NriTextureHandle, format: NriFormat): NriDescriptorHandle;
@nodrops declare function Nri_DestroyDescriptor(descriptor: NriDescriptorHandle): void;

// Buffers
// A buffer of byteSize bytes in memory the CPU reads, bound to its memory; null on failure.
@nodrops declare function Nri_CreateReadbackBuffer(device: NriDeviceHandle, byteSize: int): NriBufferHandle | null;
// Destroys the buffer and frees its memory.
@nodrops declare function Nri_DestroyBuffer(buffer: NriBufferHandle): void;
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
@nodrops declare function Nri_CmdEndRendering(commandBuffer: NriCommandBufferHandle): void;
// Clears the whole color attachment (between Nri_CmdBeginRendering and Nri_CmdEndRendering).
@nodrops declare function Nri_CmdClearColor(commandBuffer: NriCommandBufferHandle, r: float, g: float, b: float, a: float): void;
@nodrops declare function Nri_CmdSetViewport(commandBuffer: NriCommandBufferHandle, x: float, y: float, width: float, height: float): void;
@nodrops declare function Nri_CmdSetScissor(commandBuffer: NriCommandBufferHandle, x: int, y: int, width: int, height: int): void;
@nodrops declare function Nri_CmdSetPipelineLayout(commandBuffer: NriCommandBufferHandle, pipelineLayout: NriPipelineLayoutHandle): void;
@nodrops declare function Nri_CmdSetPipeline(commandBuffer: NriCommandBufferHandle, pipeline: NriPipelineHandle): void;
@nodrops declare function Nri_CmdDraw(commandBuffer: NriCommandBufferHandle, vertexNum: int, instanceNum: int, baseVertex: int, baseInstance: int): void;
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
// A layout binding nothing, for the vertex and fragment stages.
@nodrops declare function Nri_CreatePipelineLayout(device: NriDeviceHandle): NriPipelineLayoutHandle;
@nodrops declare function Nri_DestroyPipelineLayout(pipelineLayout: NriPipelineLayoutHandle): void;
// A pipeline drawing triangles from no vertex buffer, not culled, into one color attachment of
// colorFormat, unblended. The shaders' bytecode is read from vsPath and psPath, relative to the
// directory of the executable (of nri_interop's library under the JIT: bin/). Null on failure.
@nodrops declare function Nri_CreateGraphicsPipeline(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle,
    vsPath: string, vsEntry: string, psPath: string, psEntry: string, colorFormat: NriFormat): NriPipelineHandle | null;
@nodrops declare function Nri_DestroyPipeline(pipeline: NriPipelineHandle): void;

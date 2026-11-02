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
// A glTF mesh primitive's vertex and index buffers (Nri_LoadGltfMesh).
@cpp declare class NriGltfMeshHandle { private readonly __nriGltfMesh: index; }
// Every primitive of a glTF file with its materials and nodes, on the CPU (Nri_LoadGltfModel).
@cpp declare class NriGltfModelHandle { private readonly __nriGltfModel: index; }
// A texture's levels gathered on the CPU (Nri_CreateTextureLevels), for Nri_CreateTextureFromLevels.
@cpp declare class NriTextureLevelsHandle { private readonly __nriTextureLevels: index; }
// Timestamps of several time domains sampled together (Nri_CreateCalibratedTimestamps).
@cpp declare class NriCalibratedTimestampsHandle { private readonly __nriCalibratedTimestamps: index; }
// A glTF scene as Donut's engine loads it, on the CPU (Nri_LoadDonutScene).
@cpp declare class NriDonutSceneHandle { private readonly __nriDonutScene: index; }
// A pass's draws (Nri_CreateDrawList), and a pass recording them (Nri_CreateDrawPass).
@cpp declare class NriDrawListHandle { private readonly __nriDrawList: index; }
@cpp declare class NriDrawPassHandle { private readonly __nriDrawPass: index; }
// A pool of timestamp queries (Nri_CreateTimestampQueryPool).
@cpp declare class NriQueryPoolHandle { private readonly __nriQueryPool: index; }
// A std::default_random_engine (Nri_CreateRandomEngine).
@cpp declare class NriRandomEngineHandle { private readonly __nriRandomEngine: index; }
// A bottom or top level acceleration structure (Nri_BuildTriangleBLAS, Nri_BuildSingleInstanceTLAS).
@cpp declare class NriAccelerationStructureHandle { private readonly __nriAccelerationStructure: index; }
// A ray tracing pipeline's shader binding table (Nri_CreateShaderTable).
@cpp declare class NriShaderTableHandle { private readonly __nriShaderTable: index; }
// What Nri_BuildBlasFromDesc builds a BLAS of (Nri_CreateBlasDesc).
@cpp declare class NriBlasDescHandle { private readonly __nriBlasDesc: index; }
// What Nri_CreateRayTracingPipelineFromDesc makes a pipeline of (Nri_CreateRayTracingPipelineDesc).
@cpp declare class NriRayTracingPipelineDescHandle { private readonly __nriRayTracingPipelineDesc: index; }
// A top level acceleration structure with its instance list, built in frames (Nri_CreateTopLevelAS).
@cpp declare class NriTopLevelASHandle { private readonly __nriTopLevelAS: index; }
// A Donut scene's BLASes and TLAS (Nri_BuildDonutSceneAccelStructs).
@cpp declare class NriDonutSceneAccelStructsHandle { private readonly __nriDonutSceneAccelStructs: index; }
// An ImGui font (Nri_ImguiCreateFont), the atlas's: valid as long as ImGui.
@cpp declare class NriImguiFontHandle { private readonly __nriImguiFont: index; }
// An updatable bottom level acceleration structure (Nri_CreateUpdatableTriangleBlas).
@cpp declare class NriUpdatableBlasHandle { private readonly __nriUpdatableBlas: index; }
// A BLAS of geometries whose vertices a buffer the GPU writes holds (Nri_CreateBufferBlas).
@cpp declare class NriBufferBlasHandle { private readonly __nriBufferBlas: index; }
// An animated Donut scene (Nri_LoadDonutAnimatedScene) and its acceleration structures.
@cpp declare class NriDonutAnimatedSceneHandle { private readonly __nriDonutAnimatedScene: index; }
@cpp declare class NriDonutAnimatedSceneAccelStructsHandle { private readonly __nriDonutAnimatedSceneAccelStructs: index; }

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
    AllShaderResource = 7,
    // read and written by pixel shaders (RWTexture2D in a draw: Nri_CreateStorageTextureWithData's);
    // from PixelStorage to PixelStorage, the writes before are seen by the accesses after
    PixelStorage = 8,
    // read as the shading rate attachment (Nri_CreateShadingRateTexture's, from the start)
    ShadingRateAttachment = 9,
    // read by compute shaders only: what a compute queue can read (D3D12's NON_PIXEL_SHADER_RESOURCE)
    ComputeShaderResource = 12,
    // written by ray generation shaders (RWTexture2D in Nri_CmdDispatchRays)
    RayTracingStorage = 13,
    // copied into (Nri_CmdCopyTexture's destination)
    CopyDestination = 14,
    // read by ray tracing shaders (a G-buffer the ray generation shader decodes)
    RayTracingShaderResource = 15,
    // read by geometry and pixel shaders (a texture a geometry shader reads); D3D12 takes it as it
    // takes ShaderResource, so never barrier between the two
    GeometryShaderResource = 16
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
    ComputeShaderDerivatives = 3,
    // shaderFeatures.nativeF16 and nativeI16: float16_t and int16_t (D3D12 shader model 6.2; on
    // Vulkan, in storage buffers too)
    Native16Bit = 4,
    // Native16Bit in root constants (push constants) too (D3D12; Vulkan's storagePushConstant16 and
    // uniformAndStorageBuffer16BitAccess)
    Native16BitConstants = 5,
    // Pixel shaders in full quads (D3D12 always; Vulkan's VK_KHR_shader_quad_control, which NRI is
    // patched to enable, with VK_KHR_shader_maximal_reconvergence)
    ShaderQuadControl = 6,
    // shaderFeatures.barycentric: SV_Barycentrics and GetAttributeAtVertex in pixel shaders (D3D12
    // shader model 6.1, Vulkan's VK_KHR_fragment_shader_barycentric)
    Barycentrics = 7,
    // features.logicOp: Nri_PipelineDescSetLogicOp (D3D's OutputMergerLogicOp, Vulkan's logicOp)
    LogicOp = 8,
    // features.rayTracing with tiers.rayTracing >= 2: inline ray tracing (RayQuery) in any shader, against
    // a set's NriDescriptorType.AccelerationStructure range (D3D12's DXR 1.1, Vulkan's VK_KHR_ray_query),
    // NVRHI's Feature::RayQuery
    RayQuery = 10,
    // tiers.shadingRate >= 2: variable rate shading with shading rate attachments
    // (Nri_PipelineDescSetShadingRate, Nri_CmdSetShadingRate, Nri_CmdBeginRenderingWithShadingRate;
    // D3D12 tier 2, Vulkan's VK_KHR_fragment_shading_rate), NVRHI's Feature::VariableRateShading
    VariableRateShading = 11,
    // shaderFeatures.rasterizedOrderedView: RasterizerOrderedTexture2D and friends in pixel shaders
    // (D3D's ROVs, Vulkan's VK_EXT_fragment_shader_interlock: pixel and sample interlock)
    RasterizerOrderedViews = 23,
    // features.rayTracing: ray tracing pipelines and acceleration structures (Nri_CreateRayTracingPipeline,
    // Nri_BuildTriangleBLAS, ...; D3D12's DXR, Vulkan's VK_KHR_ray_tracing_pipeline), NVRHI's
    // Feature::RayTracingPipeline
    RayTracing = 24,
    // tiers.conservativeRaster != 0: Nri_PipelineDescSetConservativeRaster (D3D12's conservative rasterization
    // tiers, Vulkan's VK_EXT_conservative_rasterization), NVRHI's Feature::ConservativeRasterization
    ConservativeRasterization = 25,
    // shaderFeatures.rayTracingPositionFetch on Vulkan: hit shaders reading their triangle's vertex
    // positions from the acceleration structure (VK_KHR_ray_tracing_position_fetch; BLASes built with
    // NriAccelerationStructureFlags.AllowDataAccess), NVRHI's Feature::RayTracingPositionFetch
    RayTracingPositionFetch = 26
}

// nri::Format, which the functions taking or returning a format pass through: the values the
// examples name (nri_interop.cpp asserts them), any other passing through as well.
// nri::SwapChainFormat: BT.709 primaries with linear 16-bit float, sRGB 8-bit or 10-bit; BT.2020 with
// the ST.2084 (PQ) curve, 10-bit.
enum NriSwapChainFormat {
    BT709_G10_16BIT = 0,
    BT709_G22_8BIT = 1,
    BT709_G22_10BIT = 2,
    BT2020_G2084_10BIT = 3
}

enum NriFormat {
    Unknown = 0,
    R8_UNORM = 1,
    R16_UNORM = 16,
    R16_SFLOAT = 20,
    RG16_SFLOAT = 25,
    R10_G10_B10_A2_UNORM = 46,
    R11_G11_B10_UFLOAT = 48,
    // shading rate attachments (Nri_CreateShadingRateTexture's)
    R8_UINT = 3,
    // fragment_shading_rate_dynamic_nri's frequency content
    RG8_UINT = 7,
    BGRA8_UNORM = 9,
    BGRA8_SRGB = 10,
    RGBA8_UNORM = 11,
    RGBA8_SRGB = 12,
    // rt_reflections_nri's scene normals (snorm8, read as Buffer<float4>)
    RGBA8_SNORM = 13,
    // logic_op_dynamic_state_nri's color attachment on D3D (logic operations on UINT targets)
    RGBA8_UINT = 14,
    R32_UINT = 31,
    // instancing_nri's texture array layer (a vertex attribute)
    R32_SINT = 32,
    R32_SFLOAT = 33,
    // deferred_shading_nri's G-buffer normals (Donut's)
    RGBA16_SNORM = 27,
    RGBA16_SFLOAT = 30,
    RG32_SFLOAT = 36,
    RGB32_SFLOAT = 39,
    RGBA32_SFLOAT = 42,
    // a 16-bit depth buffer (async_compute_bloom_nri's shadow map)
    D16_UNORM = 64,
    BC1_RGBA_UNORM = 50,
    // the Basis Universal transcoder's targets (texture_compression_basisu_nri, ..._comparison_nri)
    BC3_RGBA_SRGB = 55,
    BC7_RGBA_SRGB = 63,
    D32_SFLOAT = 66,
    // deferred_shading_nri's G-buffer depth (Donut's), and the view shaders read it through
    D24_UNORM_S8_UINT = 65,
    R24_UNORM_X8 = 68,
    // the stencil plane of D24_UNORM_S8_UINT for shaders to read (Texture2D<uint2>: .y on D3D)
    X24_G8_UINT = 69
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
    Task = 3,
    Geometry = 4,
    // hull (tessellation control) and domain (tessellation evaluation) shaders
    Hull = 5,
    Domain = 6
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
    PointList = 0,
    LineList = 1,
    LineStrip = 2,
    TriangleList = 3,
    TriangleStrip = 4,
    // patches of Nri_PipelineDescSetPatchControlPoints's control points (hull and domain shaders)
    PatchList = 9
}


// RasterizationDesc's lineRasterization (VkLineRasterizationModeKHR's order): Default draws Vulkan's
// default lines (rectangular, with strictLines) and D3D's aliased ones.
enum NriLineRasterizationMode {
    Default = 0,
    Rectangular = 1,
    Bresenham = 2,
    Smooth = 3
}

// Nri_GetLineRasterizationModes' bits.
enum NriLineRasterizationBits {
    Rectangular = 1,
    Bresenham = 2,
    Smooth = 4,
    StippledRectangular = 8,
    StippledBresenham = 16,
    StippledSmooth = 32
}


// VkTimeDomainEXT: the clocks calibrated timestamps come from.
enum NriTimeDomain {
    Device = 0,
    ClockMonotonic = 1,
    ClockMonotonicRaw = 2,
    QueryPerformanceCounter = 3
}

// nri::BlendFactor: Nri_PipelineDescSetBlend's.
enum NriBlendFactor {
    Zero = 0,
    One = 1,
    SrcColor = 2,
    OneMinusSrcColor = 3,
    DstColor = 4,
    OneMinusDstColor = 5,
    SrcAlpha = 6,
    OneMinusSrcAlpha = 7,
    DstAlpha = 8,
    OneMinusDstAlpha = 9,
    // Nri_CmdSetBlendConstants's
    ConstantColor = 10,
    OneMinusConstantColor = 11,
    ConstantAlpha = 12,
    OneMinusConstantAlpha = 13,
    SrcAlphaSaturate = 14
}

// nri::BlendOp: Nri_PipelineDescSetBlend's.
enum NriBlendOp {
    Add = 0,
    Subtract = 1,
    ReverseSubtract = 2,
    Min = 3,
    Max = 4
}

// nri::CullMode.
enum NriCullMode {
    None = 0,
    Front = 1,
    Back = 2
}

// The draws' shading rate (Nri_CmdSetShadingRate; nri::ShadingRate): fragment width x height.
enum NriShadingRate {
    Rate1x1 = 0,
    Rate1x2 = 1,
    Rate2x1 = 2,
    Rate2x2 = 3,
    // the device's additional shading rates
    Rate2x4 = 4,
    Rate4x2 = 5,
    Rate4x4 = 6
}

// How Nri_CmdSetShadingRate's rate combines with the primitives' and the attachment's
// (nri::ShadingRateCombiner).
enum NriShadingRateCombiner {
    // the rate so far (NVRHI's Passthrough)
    Keep = 0,
    // the new one (NVRHI's Override)
    Replace = 1,
    Min = 2,
    Max = 3,
    Sum = 4
}

// nri::DescriptorType: a descriptor range's.
enum NriDescriptorType {
    Sampler = 0,
    ConstantBuffer = 1,
    Texture = 2,
    // RWTexture2D (u registers)
    StorageTexture = 3,
    // Buffer<T> (t registers: Nri_CreateTypedBufferView's)
    Buffer = 4,
    // RWBuffer<T> (u registers)
    StorageBuffer = 5,
    // StructuredBuffer (t registers)
    StructuredBuffer = 6,
    // RWStructuredBuffer (u registers)
    StorageStructuredBuffer = 7,
    // RaytracingAccelerationStructure (t registers: Nri_CreateAccelerationStructureDescriptor's)
    AccelerationStructure = 8
}

// nri::StageBits: the shader stages that see a descriptor range.
enum NriStage {
    Vertex = 2,
    // hull (tessellation control) and domain (tessellation evaluation) shaders
    Hull = 4,
    Domain = 8,
    Geometry = 16,
    // vertex and geometry
    VertexGeometry = 18,
    Task = 32,
    Mesh = 64,
    Pixel = 128,
    // vertex and pixel
    VertexPixel = 130,
    // vertex, hull, domain and pixel: a tessellated draw's (AllGraphics' task and mesh bits are
    // rejected on Vulkan where the device has no mesh shaders)
    VertexTessellationPixel = 142,
    // every graphics stage (vertex to pixel, task and mesh)
    AllGraphics = 254,
    Compute = 1024,
    RayGen = 2048,
    Miss = 4096,
    Intersection = 8192,
    ClosestHit = 16384,
    AnyHit = 32768,
    // every ray tracing stage (ray generation, miss, intersection, hit and callable shaders)
    RayTracing = 129024
}

// nri::AccelerationStructureBits: how an acceleration structure is built.
enum NriAccelerationStructureFlags {
    None = 0,
    AllowUpdate = 1,
    // hit shaders may read the structure's vertex positions (NriFeature.RayTracingPositionFetch)
    AllowDataAccess = 4,
    PreferFastTrace = 32,
    PreferFastBuild = 64
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
    Space = 32,
    Minus = 45,
    Equal = 61,
    KpSubtract = 333,
    KpAdd = 334
}

// What Nri_CreateUploadedBuffer's buffer is for.
enum NriBufferUsage {
    VertexBuffer = 0,
    IndexBuffer = 1,
    // Nri_CreateHostBuffer's
    ConstantBuffer = 2,
    // Nri_CreateHostBufferWithStride's: structures read by shaders (StructuredBuffer)
    StructuredBuffer = 3,
    // Nri_CreateHostBufferWithStride's: structures read by shaders that acceleration structure builds
    // read too (Nri_CmdUpdateUpdatableBlas' vertices and indices)
    AccelerationStructureInput = 4
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
    IndirectArgumentAndComputeResource = 5,
    // read by vertex and compute shaders (StructuredBuffer): D3D12's legacy barriers take
    // VertexShaderResource for compute shaders too, so a buffer both read goes between this and
    // Storage
    VertexAndComputeShaderResource = 6,
    // read and written by pixel shaders (RWStructuredBuffer in a draw); from PixelStorage to
    // PixelStorage, the writes before are seen by the accesses after
    PixelStorage = 7,
    // read by compute shaders
    ComputeShaderResource = 8,
    // read by pixel shaders
    PixelShaderResource = 9,
    // read by acceleration structure builds (their vertices) and by ray tracing and compute shaders
    // (ByteAddressBuffer): skinned vertices once skinned
    AccelerationStructureInput = 10
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
// The window's size (1280 x 720 unless this is called, before Nri_RunSample).
@nodrops declare function Nri_SetWindowSize(sample: NriSampleHandle, width: int, height: int): void;
// The window can be resized (before Nri_RunSample; not under -test): Nri_GetOutputWidth/Height follow it
// from frame to frame (no frames while it's minimized), and the example recreates its swap chain
// (Nri_DeviceWaitIdle, Nri_DestroySwapChain, Nri_CreateSwapChain) and its targets of that size when the
// size it made them at differs.
@nodrops declare function Nri_UseResizableWindow(sample: NriSampleHandle): void;
// An option of the example's (a flag it reads with Nri_GetArg), which Nri_RunSample leaves out of
// NRIFramework's command line (which would reject it); before Nri_RunSample.
@nodrops declare function Nri_AddExampleOption(sample: NriSampleHandle, option: string): void;
// As Nri_AddExampleOption, an option followed by valueNum values, left out too.
@nodrops declare function Nri_AddExampleOptionWithValues(sample: NriSampleHandle, option: string, valueNum: int): void;
// The command line's argument index (main's argc and argv), "" past its end.
@nodrops declare function Nri_GetArg(argc: int, argv: Ref<string>, index: int): string;
// -test was given: Nri_RunSample rendered the test's frames.
@nodrops declare function Nri_IsTest(sample: NriSampleHandle): int;
// The output's size: the window's (its framebuffer's this frame, with Nri_UseResizableWindow).
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
// The cursor's position in the window, in pixels from its top left corner (x right, y down).
@nodrops declare function Nri_GetMouseX(sample: NriSampleHandle): number;
@nodrops declare function Nri_GetMouseY(sample: NriSampleHandle): number;
// 1: the cursor is hidden and captured (relative mouse movement); 0: normal.
@nodrops declare function Nri_SetCursorDisabled(sample: NriSampleHandle, disabled: int): void;
// Moves the cursor to (x, y), in pixels from the window's top left corner.
@nodrops declare function Nri_SetCursorPosition(sample: NriSampleHandle, x: int, y: int): void;
// 1 if the window has the input focus, else 0.
@nodrops declare function Nri_IsWindowFocused(sample: NriSampleHandle): int;
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
// Shaders' printf (Vulkan: the validation layer's, as Donut's AppOptions.ShaderPrintf), asked for before
// Nri_RunSample: the Vulkan device gets the layer with its printf setting (without -debug too) and a
// messenger for its messages.
@nodrops declare function Nri_UseShaderPrintf(sample: NriSampleHandle): void;
// 1 if shaders' printf output reaches Nri_UpdateShaderPrintfOutput (a Vulkan device made after
// Nri_UseShaderPrintf, the validation layer installed), else 0.
@nodrops declare function Nri_HasShaderPrintf(): int;
// Takes the printf messages the layer has delivered since the last call (once the GPU has finished the
// commands that printed them); their count, Nri_GetShaderPrintfLine's lines until the next call.
@nodrops declare function Nri_UpdateShaderPrintfOutput(): int;
// The index-th message Nri_UpdateShaderPrintfOutput took (the layer's text, the shader's output at its end).
@nodrops declare function Nri_GetShaderPrintfLine(index: int): string;
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
// As Nri_CreateSwapChain, with textures of format (NriSwapChainFormat).
@nodrops declare function Nri_CreateSwapChainWithFormat(sample: NriSampleHandle, device: NriDeviceHandle, queue: NriQueueHandle, textureNum: int, format: int): NriSwapChainHandle;
// The format (NriFormat) NRI gave the swap chain's textures.
@nodrops declare function Nri_GetSwapChainTextureFormat(swapChain: NriSwapChainHandle): int;
// 1 if the display the swap chain's window is on is in HDR mode, else 0.
@nodrops declare function Nri_IsDisplayHdr(swapChain: NriSwapChainHandle): int;
@nodrops declare function Nri_DestroySwapChain(swapChain: NriSwapChainHandle): void;
@nodrops declare function Nri_GetSwapChainTextureNum(swapChain: NriSwapChainHandle): int;
@nodrops declare function Nri_GetSwapChainTexture(swapChain: NriSwapChainHandle, index: int): NriTextureHandle;
// The index of the next texture to render into, once acquireSemaphore is signaled; -1 on failure.
@nodrops declare function Nri_AcquireNextTexture(swapChain: NriSwapChainHandle, acquireSemaphore: NriFenceHandle): int;
// Presents once releaseSemaphore is signaled; 0 on failure.
@nodrops declare function Nri_QueuePresent(swapChain: NriSwapChainHandle, releaseSemaphore: NriFenceHandle): int;

// Textures and views
@nodrops declare function Nri_GetTextureFormat(texture: NriTextureHandle): NriFormat;
// The texture's size (its first level's) and mip levels.
@nodrops declare function Nri_GetTextureWidth(texture: NriTextureHandle): int;
@nodrops declare function Nri_GetTextureHeight(texture: NriTextureHandle): int;
@nodrops declare function Nri_GetTextureMipNum(texture: NriTextureHandle): int;
@nodrops declare function Nri_GetFormatName(format: NriFormat): string;
// The sRGB format of an 8-bit RGBA or BGRA UNORM format, else the format itself: the swap chain's
// textures are UNORM, their color attachment views may be sRGB (as Donut's back buffers are).
@nodrops declare function Nri_GetSrgbFormat(format: NriFormat): NriFormat;
@nodrops declare function Nri_CreateColorAttachmentView(texture: NriTextureHandle, format: NriFormat): NriDescriptorHandle;
// A color attachment view of one mip level of the texture.
@nodrops declare function Nri_CreateColorAttachmentMipView(texture: NriTextureHandle, format: NriFormat, mip: int): NriDescriptorHandle;
@nodrops declare function Nri_CreateDepthAttachmentView(texture: NriTextureHandle, format: NriFormat): NriDescriptorHandle;
// Attachment views of one layer of a texture array (a cubemap's face).
@nodrops declare function Nri_CreateColorAttachmentLayerView(texture: NriTextureHandle, format: NriFormat, layer: int): NriDescriptorHandle;
@nodrops declare function Nri_CreateDepthAttachmentLayerView(texture: NriTextureHandle, format: NriFormat, layer: int): NriDescriptorHandle;
// A view of one layer of a texture array, as an array of that layer alone (Texture2DArray), for
// shaders to read: what Donut binds to blit a slice.
@nodrops declare function Nri_CreateTextureArrayLayerView(texture: NriTextureHandle, format: NriFormat, layer: int): NriDescriptorHandle;
@nodrops declare function Nri_DestroyDescriptor(descriptor: NriDescriptorHandle): void;
// A width x height depth texture in device memory, moved on the queue (which this waits for) to
// NriTextureState.DepthAttachment, where it stays (no barriers needed); null on failure.
@nodrops declare function Nri_CreateDepthTexture(device: NriDeviceHandle, queue: NriQueueHandle, width: int, height: int, format: NriFormat): NriTextureHandle | null;
// A width x height depth texture that shaders read too (Nri_CreateTextureView with the depth format),
// left in NriTextureState.ShaderResource: barriers move it to DepthAttachment for the passes that
// render into it, and back; null on failure.
@nodrops declare function Nri_CreateSampledDepthTexture(device: NriDeviceHandle, queue: NriQueueHandle, width: int, height: int,
    format: NriFormat): NriTextureHandle | null;
// As Nri_CreateDepthTexture, an array of layerNum layers (a cubemap's faces).
@nodrops declare function Nri_CreateLayeredDepthTexture(device: NriDeviceHandle, queue: NriQueueHandle, width: int, height: int,
    layerNum: int, format: NriFormat): NriTextureHandle | null;
// As Nri_CreateDepthTexture, with sampleNum samples per pixel; null on failure.
@nodrops declare function Nri_CreateMultisampledDepthTexture(device: NriDeviceHandle, queue: NriQueueHandle, width: int, height: int,
    format: NriFormat, sampleNum: int): NriTextureHandle | null;
// As Nri_CreateMultisampledDepthTexture, read by shaders too (Nri_CreateTextureView with the depth
// format: Texture2DMS<float>, or Texture2D<float> with 1 sample), left in
// NriTextureState.ShaderResource; null on failure.
@nodrops declare function Nri_CreateSampledMultisampledDepthTexture(device: NriDeviceHandle, queue: NriQueueHandle, width: int, height: int,
    format: NriFormat, sampleNum: int): NriTextureHandle | null;
// A color attachment with sampleNum samples per pixel (Nri_CreateColorAttachmentView), left in
// NriTextureState.ColorAttachment, read by shaders too (Nri_CreateTextureView: Texture2DMS, as
// shaders/nri_msaa_resolve.hlsl resolves it); null on failure.
@nodrops declare function Nri_CreateMultisampledRenderTarget(device: NriDeviceHandle, queue: NriQueueHandle, width: int, height: int,
    format: NriFormat, sampleNum: int): NriTextureHandle | null;
// The sample counts both formats can be rendered with, as bits (1 | 2 | 4 | 8).
@nodrops declare function Nri_GetSupportedSampleCounts(device: NriDeviceHandle, colorFormat: NriFormat, depthFormat: NriFormat): int;
// What the device can do with format: nri::FormatSupportBits (1: sampled texture, 2: storage texture,
// 8: color attachment, ...).
@nodrops declare function Nri_GetFormatSupport(device: NriDeviceHandle, format: NriFormat): int;
// The depth resolve modes of Vulkan's render passes, as bits 1 << mode (mode as Donut's ResolveMode:
// SampleZero 1, Average 2, Min 3, Max 4), as Donut_GetDepthResolveModes gives them; 0 on D3D.
@nodrops declare function Nri_GetDepthResolveModes(device: NriDeviceHandle): int;
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
// Copies count 32-bit ints from the start of the buffer (a readback buffer, after the GPU wrote it)
// to dst (Ref of an int array element); 1, or 0 if it can't be read.
@nodrops declare function Nri_ReadBufferInts(buffer: NriBufferHandle, dst: Ref<int>, count: int): int;
// Writes headerInts ints of header (Ref of an int array element), then the first byteSize bytes of the
// buffer (a readback buffer, after the GPU wrote it), to path (relative to the executable's directory;
// the app's data directory on Android), replacing the file only once it's written. 1, or 0 on failure.
@nodrops declare function Nri_SaveBufferToFile(buffer: NriBufferHandle, byteSize: int, header: Ref<int>, headerInts: int, path: string): int;
// A pool of capacity timestamp queries (the graphics queue's); null on failure.
@nodrops declare function Nri_CreateTimestampQueryPool(device: NriDeviceHandle, capacity: int): NriQueryPoolHandle | null;
@nodrops declare function Nri_DestroyQueryPool(queryPool: NriQueryPoolHandle): void;
// The bytes a query's result takes in a buffer Nri_CmdCopyQueries copies into (8 for a timestamp).
@nodrops declare function Nri_GetQuerySize(queryPool: NriQueryPoolHandle): int;
// Resets num queries from offset before they're written again (outside rendering).
@nodrops declare function Nri_CmdResetQueries(commandBuffer: NriCommandBufferHandle, queryPool: NriQueryPoolHandle, offset: int, num: int): void;
// Writes the GPU's timestamp into query offset once the commands before have completed.
@nodrops declare function Nri_CmdWriteTimestamp(commandBuffer: NriCommandBufferHandle, queryPool: NriQueryPoolHandle, offset: int): void;
// Copies num written queries' results from offset into buffer (Nri_CreateReadbackBuffer's) at
// dstOffset bytes. On D3D11 a buffer remembers only its last copy: one copy per buffer between reads.
@nodrops declare function Nri_CmdCopyQueries(commandBuffer: NriCommandBufferHandle, queryPool: NriQueryPoolHandle, offset: int, num: int,
    buffer: NriBufferHandle, dstOffset: int): void;
// The milliseconds between two timestamps a readback buffer holds at byte offsets begin and end;
// -1 if it can't be read.
@nodrops declare function Nri_ReadTimestampIntervalMs(device: NriDeviceHandle, buffer: NriBufferHandle, begin: int, end: int): number;
// The nanoseconds of one tick of the device's timestamps (Vulkan's timestampPeriod, 1e9 / D3D's
// timestamp frequency); 0 if unknown.
@nodrops declare function Nri_GetTimestampPeriod(device: NriDeviceHandle): number;
// Timestamps of several time domains (clocks) sampled together, the device's among them: Vulkan's
// VK_EXT_calibrated_timestamps (NriTimeDomain values), D3D12's clock calibration of the queue (the device's
// and QueryPerformanceCounter's). Null if the device can't (D3D11, Vulkan without the extension).
@nodrops declare function Nri_CreateCalibratedTimestamps(device: NriDeviceHandle, queue: NriQueueHandle): NriCalibratedTimestampsHandle | null;
@nodrops declare function Nri_DestroyCalibratedTimestamps(calibratedTimestamps: NriCalibratedTimestampsHandle): void;
// Its time domains: their number, and each one's NriTimeDomain (-1 out of range).
@nodrops declare function Nri_GetCalibratedTimeDomainCount(calibratedTimestamps: NriCalibratedTimestampsHandle): int;
@nodrops declare function Nri_GetCalibratedTimeDomain(calibratedTimestamps: NriCalibratedTimestampsHandle, index: int): int;
// Samples the timestamps of all its domains at once; 0 on failure.
@nodrops declare function Nri_SampleCalibratedTimestamps(calibratedTimestamps: NriCalibratedTimestampsHandle): int;
// The last sample's timestamp of domain index, in its domain's ticks (the device's: of Nri_GetTimestampPeriod
// nanoseconds); the sample's maximum deviation between the domains in nanoseconds (0 on D3D12).
@nodrops declare function Nri_GetCalibratedTimestamp(calibratedTimestamps: NriCalibratedTimestampsHandle, index: int): number;
@nodrops declare function Nri_GetCalibratedTimestampsMaxDeviation(calibratedTimestamps: NriCalibratedTimestampsHandle): number;
// A buffer of byteSize bytes in device memory, filled with data's byteSize bytes (Ref of an array
// element) on the queue, which this waits for; null on failure.
@nodrops declare function Nri_CreateUploadedBuffer(device: NriDeviceHandle, queue: NriQueueHandle, data: Ref<f32>, byteSize: int, usage: NriBufferUsage): NriBufferHandle | null;
// A buffer of byteSize bytes in memory the CPU writes (Nri_WriteBuffer) and the GPU reads, for usage
// (NriBufferUsage.ConstantBuffer); null on failure.
@nodrops declare function Nri_CreateHostBuffer(device: NriDeviceHandle, byteSize: int, usage: NriBufferUsage): NriBufferHandle | null;
// A buffer of byteSize bytes in device memory holding data, structures stride bytes each that shaders
// read (StructuredBuffer; views: Nri_CreateStructuredBufferView), uploaded on the queue (which this
// waits for), readable by every shader stage; null on failure.
@nodrops declare function Nri_CreateUploadedStructuredBuffer(device: NriDeviceHandle, queue: NriQueueHandle, data: Ref<f32>, byteSize: int,
    stride: int): NriBufferHandle | null;
@nodrops declare function Nri_CreateUploadedStructuredBufferFromInts(device: NriDeviceHandle, queue: NriQueueHandle, data: Ref<int>,
    byteSize: int, stride: int): NriBufferHandle | null;
// Nri_CreateUploadedStructuredBuffer from data some other library holds (MeshletModel.getData's, ...).
@nodrops declare function Nri_CreateUploadedStructuredBufferFromPointer(device: NriDeviceHandle, queue: NriQueueHandle, data: Opaque,
    byteSize: int, stride: int): NriBufferHandle | null;
// Nri_CreateUploadedBuffer from data some other library holds (SdkMesh.getVertexBufferData's, ...).
@nodrops declare function Nri_CreateUploadedBufferFromPointer(device: NriDeviceHandle, queue: NriQueueHandle, data: Opaque, byteSize: int,
    usage: NriBufferUsage): NriBufferHandle | null;
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
// Nri_CreateStorageBufferFromInts' buffer without data (its contents undefined), in state.
@nodrops declare function Nri_CreateUninitializedStorageBuffer(device: NriDeviceHandle, queue: NriQueueHandle, byteSize: int, stride: int,
    state: NriBufferState): NriBufferHandle | null;
// Nri_CreateUninitializedStorageBuffer's buffer (structures stride bytes each; 4: raw), which
// acceleration structure builds read too (Nri_CmdBuildBufferBlas' vertices), in NriBufferState.Storage.
@nodrops declare function Nri_CreateAccelerationStructureInputStorageBuffer(device: NriDeviceHandle, queue: NriQueueHandle, byteSize: int,
    stride: int): NriBufferHandle | null;
@nodrops declare function Nri_CreateStructuredBufferView(buffer: NriBufferHandle, storage: int): NriDescriptorHandle | null;
// A view of byteSize bytes of the buffer from offset (a multiple of its structure stride and of 256)
// as its structures: written by compute shaders (storage 1) or read (0); null on failure.
@nodrops declare function Nri_CreateStructuredBufferRangeView(buffer: NriBufferHandle, offset: int, byteSize: int,
    storage: int): NriDescriptorHandle | null;
// A view of the whole buffer (Nri_CreateStorageBufferFromInts' with stride 0) as elements of a format:
// written by compute shaders (storage 1: RWBuffer<T>) or read (0: Buffer<T>); null on failure.
@nodrops declare function Nri_CreateTypedBufferView(buffer: NriBufferHandle, format: NriFormat, storage: int): NriDescriptorHandle | null;
@nodrops declare function Nri_CreateConstantBufferView(buffer: NriBufferHandle, offset: int, byteSize: int): NriDescriptorHandle | null;
// Nri_CreateUploadedBuffer from an int array (index data).
@nodrops declare function Nri_CreateUploadedBufferFromInts(device: NriDeviceHandle, queue: NriQueueHandle, data: Ref<int>, byteSize: int, usage: NriBufferUsage): NriBufferHandle | null;
// The pixels of an 8-bit RGBA or BGRA texture, or an R10G10B10A2 one (each channel's top 8 bits, as
// Donut reads its HDR back buffers), read back into the buffer (rowPitch bytes a row), one int each
// with red in the low byte (0xAABBGGRR; BGRA swapped), row by row into dst (pixelCount ints; Ref of an
// int array element). 0 if the buffer can't be mapped or the format isn't one of those.
@nodrops declare function Nri_ReadBufferRGBA8(buffer: NriBufferHandle, rowPitch: int, width: int, height: int, format: NriFormat, dst: Ref<int>, pixelCount: int): int;
// -testOutput (if given) for an RGBA16_SFLOAT texture read back into the buffer (rowPitch bytes a row),
// as Donut saves a float back buffer: clamped to [0, 1], sRGB-encoded. 1, or 0 on failure.
@nodrops declare function Nri_WriteTestOutputRGBA16F(buffer: NriBufferHandle, rowPitch: int, width: int, height: int): int;

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
// Copies byteSize bytes of src (in NriBufferState.CopySource) from srcOffset to dst (in CopyDestination,
// or a readback buffer) at dstOffset.
@nodrops declare function Nri_CmdCopyBufferRegion(commandBuffer: NriCommandBufferHandle, dst: NriBufferHandle, dstOffset: int,
    src: NriBufferHandle, srcOffset: int, byteSize: int): void;
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
// Nri_CmdTextureBarrier for one mip level of the texture.
@nodrops declare function Nri_CmdTextureMipBarrier(commandBuffer: NriCommandBufferHandle, texture: NriTextureHandle, mip: int,
    before: NriTextureState, after: NriTextureState): void;
// Renders into one color attachment, a view Nri_CreateColorAttachmentView made.
@nodrops declare function Nri_CmdBeginRendering(commandBuffer: NriCommandBufferHandle, colorAttachment: NriDescriptorHandle): void;
// Renders into one color attachment and a depth attachment (Nri_CreateDepthAttachmentView's).
@nodrops declare function Nri_CmdBeginRenderingWithDepth(commandBuffer: NriCommandBufferHandle, colorAttachment: NriDescriptorHandle, depthAttachment: NriDescriptorHandle): void;
// Renders into a depth attachment alone (Nri_CreateDepthAttachmentView's), e.g. a shadow map.
@nodrops declare function Nri_CmdBeginRenderingDepthOnly(commandBuffer: NriCommandBufferHandle, depthAttachment: NriDescriptorHandle): void;
// Renders into three color attachments (SV_Target0 to 2), Nri_CreateColorAttachmentView's views.
@nodrops declare function Nri_CmdBeginRenderingWithThreeColors(commandBuffer: NriCommandBufferHandle, color0: NriDescriptorHandle,
    color1: NriDescriptorHandle, color2: NriDescriptorHandle): void;
// Renders into two color attachments (SV_Target0 and 1) and a depth attachment
// (Nri_CreateDepthAttachmentView's).
@nodrops declare function Nri_CmdBeginRenderingWithTwoColorsAndDepth(commandBuffer: NriCommandBufferHandle, color0: NriDescriptorHandle,
    color1: NriDescriptorHandle, depthAttachment: NriDescriptorHandle): void;
// Renders into three color attachments (SV_Target0 to 2) and a depth attachment
// (Nri_CreateDepthAttachmentView's): a G-buffer.
@nodrops declare function Nri_CmdBeginRenderingWithThreeColorsAndDepth(commandBuffer: NriCommandBufferHandle, color0: NriDescriptorHandle,
    color1: NriDescriptorHandle, color2: NriDescriptorHandle, depthAttachment: NriDescriptorHandle): void;
// Renders into four color attachments (SV_Target0 to 3) and a depth attachment: Donut's G-buffer.
@nodrops declare function Nri_CmdBeginRenderingWithFourColorsAndDepth(commandBuffer: NriCommandBufferHandle, color0: NriDescriptorHandle,
    color1: NriDescriptorHandle, color2: NriDescriptorHandle, color3: NriDescriptorHandle, depthAttachment: NriDescriptorHandle): void;
@nodrops declare function Nri_CmdEndRendering(commandBuffer: NriCommandBufferHandle): void;
// Renders into one or two color attachments (color1 null for one), a depth attachment (null for
// none) and a shading rate attachment (Nri_CreateShadingRateAttachmentView's; null for none).
@nodrops declare function Nri_CmdBeginRenderingWithShadingRate(commandBuffer: NriCommandBufferHandle, color0: NriDescriptorHandle,
    color1: NriDescriptorHandle | null, depthAttachment: NriDescriptorHandle | null, shadingRateAttachment: NriDescriptorHandle | null): void;
// Clears color attachment index within the rectangle to (r, g, b, a) (a UINT attachment: their bits).
@nodrops declare function Nri_CmdClearColorAttachmentRect(commandBuffer: NriCommandBufferHandle, index: int, x: int, y: int, width: int,
    height: int, r: float, g: float, b: float, a: float): void;
// Clears the depth attachment within the rectangle to depth.
@nodrops declare function Nri_CmdClearDepthRect(commandBuffer: NriCommandBufferHandle, x: int, y: int, width: int, height: int, depth: float): void;
// The draws' shading rate from now on, combined with the primitives' rate by primitiveCombiner, then
// with the shading rate attachment's by attachmentCombiner (pipelines with
// Nri_PipelineDescSetShadingRate).
@nodrops declare function Nri_CmdSetShadingRate(commandBuffer: NriCommandBufferHandle, shadingRate: NriShadingRate,
    primitiveCombiner: NriShadingRateCombiner, attachmentCombiner: NriShadingRateCombiner): void;
// The blend constants (NriBlendFactor.ConstantColor's, ConstantAlpha's).
@nodrops declare function Nri_CmdSetBlendConstants(commandBuffer: NriCommandBufferHandle, r: float, g: float, b: float, a: float): void;
// Clears the whole color attachment index (of those a multi-color Nri_CmdBeginRendering* renders
// into).
@nodrops declare function Nri_CmdClearColorAttachment(commandBuffer: NriCommandBufferHandle, index: int, r: float, g: float, b: float,
    a: float): void;
// Clears the whole depth attachment (after Nri_CmdBeginRenderingWithDepth).
@nodrops declare function Nri_CmdClearDepth(commandBuffer: NriCommandBufferHandle, depth: float): void;
// Clears the depth attachment's depth and stencil (a format with a stencil plane).
@nodrops declare function Nri_CmdClearDepthStencil(commandBuffer: NriCommandBufferHandle, depth: float, stencil: int): void;
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
// num viewports (x, y, width, height each: Ref of an f32 array element) and a scissor rect per
// viewport (its rect rounded outwards), for geometry shaders picking one (SV_ViewportArrayIndex).
@nodrops declare function Nri_CmdSetViewportsAndScissors(commandBuffer: NriCommandBufferHandle, viewports: Ref<f32>, num: int): void;
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
// Runs the command buffer after the work submitted before it, waiting for and signaling nothing.
@nodrops declare function Nri_QueueSubmitCommandBuffer(queue: NriQueueHandle, commandBuffer: NriCommandBufferHandle): void;

// Draw passes recorded on worker threads: a draw list is a pass's draws (pipelines by slot, sets,
// root constants, indexed draws), made once; a draw pass records it into a command buffer of its
// own, set up first (attachments cleared, viewport, layout, sets, root descriptors, index buffer), on
// the calling thread (Nri_RecordDrawPass) or on a worker thread (Nri_RecordDrawPassAsync, then
// Nri_WaitDrawPass): C++ doing what TypeScript can't do on threads its garbage collector doesn't
// know about.
@nodrops declare function Nri_CreateDrawList(): NriDrawListHandle;
@nodrops declare function Nri_DestroyDrawList(list: NriDrawListHandle): void;
// The draws from here on use the pass's pipeline in slot (Nri_DrawPassSetPipeline).
@nodrops declare function Nri_DrawListSetPipeline(list: NriDrawListHandle, slot: int): void;
@nodrops declare function Nri_DrawListSetDescriptorSet(list: NriDrawListHandle, setIndex: int, descriptorSet: NriDescriptorSetHandle): void;
// size bytes of root constants (copied from data) at root constant index.
@nodrops declare function Nri_DrawListSetRootConstants(list: NriDrawListHandle, rootConstantIndex: int, data: Ref<f32>, size: int): void;
@nodrops declare function Nri_DrawListDrawIndexed(list: NriDrawListHandle, indexNum: int, instanceNum: int, baseIndex: int,
    baseVertex: int, baseInstance: int): void;
// A pass recording the list (which must outlive it) into width x height color (null: none, a depth-only
// pass) and depth attachments, with the layout (graphics) and the pool's sets. Destroying it waits for
// its worker.
@nodrops declare function Nri_CreateDrawPass(list: NriDrawListHandle, colorAttachment: NriDescriptorHandle | null,
    depthAttachment: NriDescriptorHandle, width: int, height: int, layout: NriPipelineLayoutHandle,
    descriptorPool: NriDescriptorPoolHandle): NriDrawPassHandle;
@nodrops declare function Nri_DestroyDrawPass(pass: NriDrawPassHandle): void;
// The attachments' clear values (0 unless this says otherwise).
@nodrops declare function Nri_DrawPassSetClear(pass: NriDrawPassHandle, r: float, g: float, b: float, a: float, depth: float): void;
// A set bound before the draws (or replacing the one at setIndex).
@nodrops declare function Nri_DrawPassSetDescriptorSet(pass: NriDrawPassHandle, setIndex: int, descriptorSet: NriDescriptorSetHandle): void;
// A root descriptor (a view) bound before the draws.
@nodrops declare function Nri_DrawPassSetRootDescriptor(pass: NriDrawPassHandle, rootDescriptorIndex: int, descriptor: NriDescriptorHandle): void;
// The 32-bit index buffer the indexed draws read.
@nodrops declare function Nri_DrawPassSetIndexBuffer(pass: NriDrawPassHandle, buffer: NriBufferHandle): void;
// The vertex buffer the draws read (stream 0), its vertices stride bytes apart.
@nodrops declare function Nri_DrawPassSetVertexBuffer(pass: NriDrawPassHandle, buffer: NriBufferHandle, stride: int): void;
// Whether the attachments are cleared when the pass begins (1, the default) or kept (0).
@nodrops declare function Nri_DrawPassSetClearEnabled(pass: NriDrawPassHandle, enabled: int): void;
// The pipeline the list's slot means (changeable between recordings).
@nodrops declare function Nri_DrawPassSetPipeline(pass: NriDrawPassHandle, slot: int, pipeline: NriPipelineHandle): void;
// Records the pass into the command buffer (beginning and ending it), on this thread.
@nodrops declare function Nri_RecordDrawPass(pass: NriDrawPassHandle, commandBuffer: NriCommandBufferHandle): void;
// As Nri_RecordDrawPass, on a worker thread; Nri_WaitDrawPass before submitting the command buffer or
// changing the pass. Each pass recording at once needs its own command buffer and allocator.
@nodrops declare function Nri_RecordDrawPassAsync(pass: NriDrawPassHandle, commandBuffer: NriCommandBufferHandle): void;
@nodrops declare function Nri_WaitDrawPass(pass: NriDrawPassHandle): void;

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
// As Nri_PipelineDescAddShader, of a ShaderMake permutation blob (a .cfg line with -D), the
// permutation whose defines are permutation ("NAME=VALUE").
@nodrops declare function Nri_PipelineDescAddShaderPermutation(desc: NriPipelineDescHandle, stage: NriShaderStage, path: string,
    entry: string, permutation: string): int;
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
// Another color attachment after the first (Nri_PipelineDescSetColor's): its format and the channels
// written (NriColorWrite bits).
@nodrops declare function Nri_PipelineDescAddColor(desc: NriPipelineDescHandle, format: NriFormat, writeMask: int): void;
// Blending into the first color attachment: color srcColor * source colorOp dstColor * destination,
// alpha likewise.
@nodrops declare function Nri_PipelineDescSetBlend(desc: NriPipelineDescHandle, srcColor: NriBlendFactor, dstColor: NriBlendFactor,
    colorOp: NriBlendOp, srcAlpha: NriBlendFactor, dstAlpha: NriBlendFactor, alphaOp: NriBlendOp): void;
// The depth attachment's format, its test (NriCompareOp.None: off), whether it's written (1) and
// whether the depth bounds test is on (1; NriFeature.DepthBoundsTest).
@nodrops declare function Nri_PipelineDescSetDepth(desc: NriPipelineDescHandle, format: NriFormat, compareOp: NriCompareOp, write: int, boundsTest: int): void;
// The primitives drawn (TriangleList by default).
@nodrops declare function Nri_PipelineDescSetTopology(desc: NriPipelineDescHandle, topology: NriTopology): void;
// Patches of controlPointNum control points (NriTopology.PatchList: hull and domain shaders).
@nodrops declare function Nri_PipelineDescSetPatchControlPoints(desc: NriPipelineDescHandle, controlPointNum: int): void;
// Triangles drawn as their edges (1) or filled (0, the default).
@nodrops declare function Nri_PipelineDescSetWireframe(desc: NriPipelineDescHandle, wireframe: int): void;
// Conservative rasterization (1: every pixel a triangle touches at all; NriFeature.ConservativeRasterization)
// or not (0, the default).
@nodrops declare function Nri_PipelineDescSetConservativeRaster(desc: NriPipelineDescHandle, conservative: int): void;
// Vulkan's extra overestimation of conservative rasterization, in pixels (0 by default; at most
// Nri_GetVulkanConservativeRasterizationProperties' maxExtraPrimitiveOverestimationSize); ignored on D3D.
@nodrops declare function Nri_PipelineDescSetConservativeRasterExtraOverestimation(desc: NriPipelineDescHandle, size: float): void;
// How lines are drawn: their rasterization mode (NriLineRasterizationMode; Nri_GetLineRasterizationModes
// tells which the device has), width (up to Nri_GetMaxLineWidth) and stipple (stipple 1: each bit of the
// 16-bit pattern, from the lowest, a run of stippleFactor pixels drawn if set). D3D draws rectangular lines
// as quadrilateral lines, Bresenham ones aliased, smooth ones alpha antialiased, and has no width or stipple.
@nodrops declare function Nri_PipelineDescSetLineRasterization(desc: NriPipelineDescHandle, mode: NriLineRasterizationMode, width: float,
    stipple: int, stippleFactor: int, stipplePattern: int): void;
// The line rasterization modes pipelines can have: NriLineRasterizationBits (Vulkan's line rasterization
// features; D3D's three kinds of lines, unstippled).
@nodrops declare function Nri_GetLineRasterizationModes(device: NriDeviceHandle): int;
// The widest lines can be: Vulkan's lineWidthRange with the wideLines feature, else 1 (D3D).
@nodrops declare function Nri_GetMaxLineWidth(device: NriDeviceHandle): number;
// Counter-clockwise triangles are the front faces (1), or clockwise ones (0, the default).
@nodrops declare function Nri_PipelineDescSetFrontCounterClockwise(desc: NriPipelineDescHandle, counterClockwise: int): void;
// Whether primitives are clipped at the near and far planes (1) or not (0: depth clamped, Donut's
// default). Unset, NRI's default differs by API (clipped on Vulkan, not on D3D).
@nodrops declare function Nri_PipelineDescSetDepthClip(desc: NriPipelineDescHandle, clip: int): void;
// The color and depth attachments' samples (Nri_GetSupportedSampleCounts'; 1 by default): a pipeline
// per sample count (NRI has no dynamic one).
@nodrops declare function Nri_PipelineDescSetSampleCount(desc: NriPipelineDescHandle, sampleNum: int): void;
// The color attachment's logic operation instead of blending (NriFeature.LogicOp; a UNORM or UINT
// attachment, UINT on D3D12), in Vulkan's VkLogicOp order (0 CLEAR, 3 COPY, 5 NO_OP ... 15 SET).
// NRI has no NO_OP: the attachment's color writes are turned off instead (the same result).
@nodrops declare function Nri_PipelineDescSetLogicOp(desc: NriPipelineDescHandle, vkLogicOp: int): void;
// Variable rate shading (NriFeature.VariableRateShading): the draws' shading rate is the one
// Nri_CmdSetShadingRate sets, combined with the shading rate attachment's.
@nodrops declare function Nri_PipelineDescSetShadingRate(desc: NriPipelineDescHandle, enabled: int): void;
// The depth bias of the triangles drawn: constant (D3D's integer DepthBias), clamped to clamp (0: not
// clamped), plus slope times their depth slope, as NVRHI's setDepthBias (none by default).
@nodrops declare function Nri_PipelineDescSetDepthBias(desc: NriPipelineDescHandle, constant: number, clamp: number, slope: number): void;
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
// The register space of the root constants, descriptors and samplers (0 unless this says otherwise;
// on Vulkan, the set of the root descriptors): one no descriptor set uses.
@nodrops declare function Nri_PipelineLayoutDescSetRootRegisterSpace(desc: NriPipelineLayoutDescHandle, registerSpace: int): void;
// size bytes of root constants (push constants) at register b<registerIndex>, in the root register
// space, for stages.
@nodrops declare function Nri_PipelineLayoutDescAddRootConstants(desc: NriPipelineLayoutDescHandle, registerIndex: int, size: int, stages: NriStage): void;
// A root descriptor (push descriptor) of type (a constant buffer, or a structured buffer) at
// register b, t or u<registerIndex> (by type), in the root register space, for stages: bound per draw
// with an offset (Nri_CmdSetRootDescriptor), as a dynamic uniform buffer is, or per dispatch.
@nodrops declare function Nri_PipelineLayoutDescAddRootDescriptor(desc: NriPipelineLayoutDescHandle, registerIndex: int, type: NriDescriptorType, stages: NriStage): void;
// An immutable (static) sampler at register s<registerIndex>, in the root register space: filter for
// minification and magnification, mipFilter for mips, addressMode on all axes, for stages.
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
// As Nri_CreateDescriptorPool, with room for structuredBufferMaxNum structured buffers and
// storageStructuredBufferMaxNum storage ones too.
@nodrops declare function Nri_CreateDescriptorPoolWithBuffers(device: NriDeviceHandle, setMaxNum: int, samplerMaxNum: int,
    constantBufferMaxNum: int, textureMaxNum: int, storageTextureMaxNum: int, structuredBufferMaxNum: int,
    storageStructuredBufferMaxNum: int, updateAfterSet: int): NriDescriptorPoolHandle | null;
// As Nri_CreateDescriptorPoolWithBuffers, with room for bufferMaxNum typed buffers (Buffer<T>) and
// storageBufferMaxNum storage ones (RWBuffer<T>) too.
@nodrops declare function Nri_CreateDescriptorPoolWithTypedBuffers(device: NriDeviceHandle, setMaxNum: int, samplerMaxNum: int,
    constantBufferMaxNum: int, textureMaxNum: int, storageTextureMaxNum: int, structuredBufferMaxNum: int,
    storageStructuredBufferMaxNum: int, bufferMaxNum: int, storageBufferMaxNum: int): NriDescriptorPoolHandle | null;
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
// As Nri_CreateSamplerWithMipFilter, the levels of detail sampled clamped to [mipMin, mipMax] (mipMax
// 0: level 0 only), as Donut's sampler minLod and maxLod.
@nodrops declare function Nri_CreateSamplerWithLodRange(device: NriDeviceHandle, filter: NriFilter, mipFilter: NriFilter,
    addressMode: NriAddressMode, anisotropy: int, mipMin: number, mipMax: number): NriDescriptorHandle | null;
// A comparison sampler (SamplerComparisonState), linear, clamped, comparing with compareOp, as
// Donut's createComparisonSampler (NriCompareOp.Less); null on failure.
@nodrops declare function Nri_CreateComparisonSampler(device: NriDeviceHandle, compareOp: NriCompareOp): NriDescriptorHandle | null;
// A sampler (filter for minification, magnification and mips) returning the border color, white (1)
// or transparent black (0), outside [0, 1]: Donut's shadow samplers. Null on failure.
@nodrops declare function Nri_CreateBorderSampler(device: NriDeviceHandle, filter: NriFilter, white: int): NriDescriptorHandle | null;
// As Nri_CreateBorderSampler, mipFilter between mips (filter for minification and magnification).
@nodrops declare function Nri_CreateBorderSamplerWithMipFilter(device: NriDeviceHandle, filter: NriFilter, mipFilter: NriFilter,
    white: int): NriDescriptorHandle | null;
// The device's widest anisotropic filtering (16 on most).
@nodrops declare function Nri_GetMaxSamplerAnisotropy(device: NriDeviceHandle): int;
// The most draws one indirect draw call takes: above 1, multi-draw indirect (D3D12 always; Vulkan's
// multiDrawIndirect feature).
@nodrops declare function Nri_GetDrawIndirectMaxNum(device: NriDeviceHandle): int;
// Pixels per shading rate attachment texel in each dimension; 0 without shading rate attachments.
@nodrops declare function Nri_GetShadingRateTileSize(device: NriDeviceHandle): int;
// The device's conservative rasterization tier (D3D12's; on Vulkan NRI's estimate), 0 for none.
@nodrops declare function Nri_GetConservativeRasterTier(device: NriDeviceHandle): int;
// Vulkan's VkPhysicalDeviceConservativeRasterizationPropertiesEXT into dst (9 floats, as
// Donut_GetVulkanConservativeRasterizationProperties: the three sizes, then 1 or 0 for primitiveUnderestimation,
// conservativePointAndLineRasterization, degenerateTrianglesRasterized, degenerateLinesRasterized,
// fullyCoveredFragmentShaderInputVariable, conservativeRasterizationPostDepthCoverage); 0 (dst untouched) on
// other graphics APIs or without conservative rasterization.
@nodrops declare function Nri_GetVulkanConservativeRasterizationProperties(device: NriDeviceHandle, dst: Ref<f32>): int;
// The fewest and most lanes in the device's waves (WaveGetLaneCount()).
@nodrops declare function Nri_GetWaveLaneCountMin(device: NriDeviceHandle): int;
@nodrops declare function Nri_GetWaveLaneCountMax(device: NriDeviceHandle): int;
// The fragment sizes (shading rates) the device has, as width, height pairs into dst (Ref of an int
// array of 32), largest first, as Donut's getFragmentShadingRates gives them; their count, 0 without
// shading rate attachments.
@nodrops declare function Nri_GetFragmentShadingRates(device: NriDeviceHandle, dst: Ref<int>): int;
// The most root descriptors a pipeline layout can have: on Vulkan the device's maxPushDescriptors
// (root descriptors are push descriptors there), 0 without VK_KHR_push_descriptor.
@nodrops declare function Nri_GetRootDescriptorMaxNum(device: NriDeviceHandle): int;
@nodrops declare function Nri_CreateSampler(device: NriDeviceHandle, filter: NriFilter, addressMode: NriAddressMode, anisotropy: int): NriDescriptorHandle | null;
// A view of a 2D texture's mips for shaders to read.
@nodrops declare function Nri_CreateTextureView(texture: NriTextureHandle, format: NriFormat): NriDescriptorHandle;
// A view of one mip level of a 2D texture for shaders to read.
@nodrops declare function Nri_CreateTextureMipView(texture: NriTextureHandle, format: NriFormat, mip: int): NriDescriptorHandle;

// Textures shaders read (destroyed with Nri_DestroyTexture): committed, or placed in memory.
// A width x height texture (one mip) of NRI's choosing (D3D12: a committed resource); null on failure.
@nodrops declare function Nri_CreateCommittedTexture(device: NriDeviceHandle, width: int, height: int, format: NriFormat): NriTextureHandle | null;
// A width x height texture (one mip) rendered into (Nri_CreateColorAttachmentView) and read by pixel
// shaders, moved on the queue (which this waits for) to NriTextureState.ShaderResource; null on
// failure.
@nodrops declare function Nri_CreateRenderTargetTexture(device: NriDeviceHandle, queue: NriQueueHandle, width: int, height: int,
    format: NriFormat): NriTextureHandle | null;
// As Nri_CreateRenderTargetTexture, an array of layerNum layers (a cubemap's faces), in
// NriTextureState.ShaderResource.
@nodrops declare function Nri_CreateLayeredRenderTargetTexture(device: NriDeviceHandle, queue: NriQueueHandle, width: int, height: int,
    layerNum: int, format: NriFormat): NriTextureHandle | null;
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
// A texture's levels gathered on the CPU: width x height, levelNum levels of format (set each with
// Nri_SetTextureLevel), for Nri_CreateTextureFromLevels. Freed with Nri_DestroyTextureLevels.
@nodrops declare function Nri_CreateTextureLevels(width: int, height: int, levelNum: int, format: NriFormat): NriTextureLevelsHandle;
// A level's data (copied; data some other library holds, e.g. TranscodedTexture.getLevelData's): its rows
// (of blocks, for a block-compressed format) rowPitch bytes apart.
@nodrops declare function Nri_SetTextureLevel(levels: NriTextureLevelsHandle, level: int, data: Opaque, rowPitch: int): void;
// A texture of the levels (all set), uploaded on the queue (which this waits for) and left in
// NriTextureState.ShaderResource, as Donut's createTextureWithLevels and writeTextureLevel make it; null on
// failure.
@nodrops declare function Nri_CreateTextureFromLevels(device: NriDeviceHandle, queue: NriQueueHandle, levels: NriTextureLevelsHandle): NriTextureHandle | null;
@nodrops declare function Nri_DestroyTextureLevels(levels: NriTextureLevelsHandle): void;
// A width x height texture (one mip) of format filled with data (rows rowPitch bytes apart), read by
// compute shaders on either queue (shared by the queues, left as a compute shader resource: D3D12's
// NON_PIXEL_SHADER_RESOURCE, which the compute queue can use); null on failure. Destroyed with
// Nri_DestroyTexture.
@nodrops declare function Nri_CreateUploadedComputeTexture(device: NriDeviceHandle, queue: NriQueueHandle, width: int, height: int,
    format: NriFormat, data: Ref<int>, rowPitch: int): NriTextureHandle | null;
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
// The bytes of a file Nri_LoadFile read (valid until Nri_DestroyFile), e.g. for a loader taking them
// (MeshletModel.load), and their count.
@nodrops declare function Nri_GetFileData(file: NriFileHandle): Opaque;
@nodrops declare function Nri_GetFileSize(file: NriFileHandle): int;
// count bytes of the file from offset, one per int at dst (Ref of an int array element; 0 past its
// end): for parsers in TypeScript.
@nodrops declare function Nri_CopyFileBytes(file: NriFileHandle, offset: int, count: int, dst: Ref<int>): void;
// Nri_CreateUploadedBuffer from byteSize bytes of the file at offset; null if they're past its end.
@nodrops declare function Nri_CreateUploadedBufferFromFile(device: NriDeviceHandle, queue: NriQueueHandle, file: NriFileHandle, offset: int,
    byteSize: int, usage: NriBufferUsage): NriBufferHandle | null;
// Nri_CreateUploadedStructuredBuffer from byteSize bytes of the file at offset; null if they run past
// its end.
@nodrops declare function Nri_CreateUploadedStructuredBufferFromFile(device: NriDeviceHandle, queue: NriQueueHandle, file: NriFileHandle,
    offset: int, byteSize: int, stride: int): NriBufferHandle | null;
// Nri_CreateStorageBufferFromInts' buffer holding byteSize bytes of the file at offset, in state (e.g.
// CopySource, to copy regions of it into other buffers); null if they run past its end.
@nodrops declare function Nri_CreateStorageBufferFromFile(device: NriDeviceHandle, queue: NriQueueHandle, file: NriFileHandle, offset: int,
    byteSize: int, stride: int, state: NriBufferState): NriBufferHandle | null;
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
// A DDS file as tools/ktx_to_dds.py writes them (DX10 header; 2D textures, texture arrays, cubemaps), or a
// FourCC DXT1 / BC5U / R16F one, with all its layers and mips (sRGB: 1, RGBA8 and BC1/BC7 as sRGB, as Donut's sRGB
// loads), R16_UNORM, R16F, RGBA16F, BC1, BC5 and BC7 too,
// left in NriTextureState.ShaderResource; null if it can't be read. (Nri_LoadTexture reads one layer.)
@nodrops declare function Nri_LoadDdsTexture(device: NriDeviceHandle, queue: NriQueueHandle, path: string, sRGB: int): NriTextureHandle | null;
// The first level of an RGBA8 2D DDS file in a texture with the whole mip chain below it (1 +
// floor(log2(max(width, height))) levels; sRGB: 1, RGBA8_SRGB), the other levels zeroed, to be
// rendered into (Nri_CreateColorAttachmentMipView), left in NriTextureState.ShaderResource; null on
// failure. Its levels: Nri_GetTextureMipNum.
@nodrops declare function Nri_LoadDdsTextureWithMipChain(device: NriDeviceHandle, queue: NriQueueHandle, path: string,
    sRGB: int): NriTextureHandle | null;
// An image file (RGB or RGBA, as Nri_LoadImageTexture reads it) in a texture with the mip chain
// Donut's TextureCache gives the images it loads (1 + floor(log2(min(width, height))) levels), the
// levels below the first zeroed, to be rendered into from the level above (Donut blits each);
// RGBA8 (sRGB: 1, RGBA8_SRGB), left in NriTextureState.ShaderResource; null on failure.
@nodrops declare function Nri_LoadImageTextureWithMipChain(device: NriDeviceHandle, queue: NriQueueHandle, path: string,
    sRGB: int): NriTextureHandle | null;
// The first primitive of a glTF file's first mesh, as Donut's loadGltfMesh reads it (the
// Vulkan-Samples framework's load_model: float3 position, float3 normal, float2 texture coordinates,
// 32 bytes a vertex; 32-bit indices; the nodes' transforms ignored), uploaded into a vertex and an
// index buffer; null on failure. Destroyed with Nri_DestroyGltfMesh (its buffers with it).
@nodrops declare function Nri_LoadGltfMesh(device: NriDeviceHandle, queue: NriQueueHandle, path: string): NriGltfMeshHandle | null;
@nodrops declare function Nri_DestroyGltfMesh(mesh: NriGltfMeshHandle): void;
// Valid as long as the mesh.
@nodrops declare function Nri_GetGltfMeshVertexBuffer(mesh: NriGltfMeshHandle): NriBufferHandle;
@nodrops declare function Nri_GetGltfMeshIndexBuffer(mesh: NriGltfMeshHandle): NriBufferHandle;
@nodrops declare function Nri_GetGltfMeshIndexCount(mesh: NriGltfMeshHandle): int;
// Every primitive of a glTF file's meshes, in mesh and primitive order, with its material, the
// file's textures and the nodes that instantiate meshes, as Donut's loadGltfModel reads them; kept on
// the CPU to copy out with the functions below; null on failure. Destroyed with Nri_DestroyGltfModel.
@nodrops declare function Nri_LoadGltfModel(path: string): NriGltfModelHandle | null;
@nodrops declare function Nri_DestroyGltfModel(model: NriGltfModelHandle): void;
@nodrops declare function Nri_GetGltfModelPrimitiveCount(model: NriGltfModelHandle): int;
@nodrops declare function Nri_GetGltfModelVertexCount(model: NriGltfModelHandle, primitive: int): int;
@nodrops declare function Nri_GetGltfModelIndexCount(model: NriGltfModelHandle, primitive: int): int;
// Into dst: Ref(arr[0]) of an f32 array of 8 x the vertex count (float3 position, float3 normal,
// float2 texture coordinates) / an int array of the index count.
@nodrops declare function Nri_CopyGltfModelVertices(model: NriGltfModelHandle, primitive: int, dst: Ref<f32>): void;
@nodrops declare function Nri_CopyGltfModelIndices(model: NriGltfModelHandle, primitive: int, dst: Ref<int>): void;
// A primitive's vertex attribute by its name in the file ("COLOR_0"...): its elements (0 if none),
// floats per element, and the floats themselves (count * components into dst).
@nodrops declare function Nri_GetGltfModelAttributeCount(model: NriGltfModelHandle, primitive: int, name: string): int;
@nodrops declare function Nri_GetGltfModelAttributeComponents(model: NriGltfModelHandle, primitive: int, name: string): int;
@nodrops declare function Nri_CopyGltfModelAttribute(model: NriGltfModelHandle, primitive: int, name: string, dst: Ref<f32>): void;
// The URI of a primitive's material's base color image ("" if none).
@nodrops declare function Nri_GetGltfModelBaseColorImage(model: NriGltfModelHandle, primitive: int): string;
// A primitive's material's base color factor (RGBA) into dst (Ref of an f32 array of 4).
@nodrops declare function Nri_CopyGltfModelBaseColorFactor(model: NriGltfModelHandle, primitive: int, dst: Ref<f32>): void;
// The name of the primitive's mesh ("" if none), the mesh's index, and its material's alpha mode
// (0 opaque, 1 mask, 2 blend).
@nodrops declare function Nri_GetGltfModelMeshName(model: NriGltfModelHandle, primitive: int): string;
@nodrops declare function Nri_GetGltfModelPrimitiveMesh(model: NriGltfModelHandle, primitive: int): int;
@nodrops declare function Nri_GetGltfModelPrimitiveAlphaMode(model: NriGltfModelHandle, primitive: int): int;
// A primitive's material's texture (0 base color, 1 normal, 2 metallic-roughness) as an index into
// the file's textures (-1 if none), and its metallic (0) or roughness (1) factor.
@nodrops declare function Nri_GetGltfModelMaterialTexture(model: NriGltfModelHandle, primitive: int, which: int): int;
@nodrops declare function Nri_GetGltfModelMaterialFactor(model: NriGltfModelHandle, primitive: int, which: int): number;
// The file's textures, and a texture's image URI ("" if none).
@nodrops declare function Nri_GetGltfModelTextureCount(model: NriGltfModelHandle): int;
@nodrops declare function Nri_GetGltfModelTextureImage(model: NriGltfModelHandle, texture: int): string;
// The nodes that instantiate meshes, in node order: their mesh, and their world transform (16
// floats, column-major as glm) into dst.
@nodrops declare function Nri_GetGltfModelNodeCount(model: NriGltfModelHandle): int;
@nodrops declare function Nri_GetGltfModelNodeMesh(model: NriGltfModelHandle, node: int): int;
@nodrops declare function Nri_CopyGltfModelNodeTransform(model: NriGltfModelHandle, node: int, dst: Ref<f32>): void;
// A view of a cubemap's six faces and all its mips for shaders to read (TextureCube; Nri_LoadDdsTexture
// loads cubemaps).
@nodrops declare function Nri_CreateTextureCubeView(texture: NriTextureHandle, format: NriFormat): NriDescriptorHandle;
// A view of all the layers and mips of a 2D texture array for shaders to read (Texture2DArray).
@nodrops declare function Nri_CreateTextureArrayView(texture: NriTextureHandle, format: NriFormat): NriDescriptorHandle;
// A view of a texture's layers (six per cube) and mips as an array of cubemaps (TextureCubeArray).
@nodrops declare function Nri_CreateTextureCubeArrayView(texture: NriTextureHandle, format: NriFormat): NriDescriptorHandle;
// A 1 x 1 RGBA8_UNORM texture of layerNum layers (6 or more: cubemap views too), every texel rgba
// (0xAABBGGRR), left in state: Donut's CommonRenderPasses black and white textures, which its passes
// bind for the inputs they aren't given. Null on failure.
@nodrops declare function Nri_CreateSolidTexture(device: NriDeviceHandle, queue: NriQueueHandle, layerNum: int, rgba: int,
    state: NriTextureState): NriTextureHandle | null;

// Donut's renderer constants (core/nri/nri_donut_constants.cpp), for the ports of the Donut examples
// that draw with Donut's passes and shaders: the structs of donut/shaders/*_cb.h, filled as Donut's
// engine fills them. Matrices: 16 floats, row-major, row-vector convention (donut::math's).
// The size in bytes of 0 PlanarViewConstants, 1 MaterialConstants, 2 LightConstants,
// 3 DeferredLightingConstants, 4 ForwardShadingLightConstants, 5 ShadowConstants, 6 DepthPassConstants,
// 7 SkyConstants, 8 ToneMappingConstants, 9 TemporalAntiAliasingConstants (multiples of 16); 0 for others.
@nodrops declare function Nri_GetDonutConstantsSize(which: int): int;
// A planar view's PlanarViewConstants into dst, as Donut's PlanarView fills them for a viewport of
// width x height pixels.
@nodrops declare function Nri_FillDonutPlanarViewConstants(viewMatrix: Ref<f32>, projMatrix: Ref<f32>, width: int, height: int,
    dst: Ref<f32>): void;
// The MaterialConstants of a Donut material with a base or diffuse texture and default parameters
// (specularGloss 1: the specular-glossiness model) into dst.
@nodrops declare function Nri_FillDonutTexturedMaterialConstants(specularGloss: int, dst: Ref<f32>): void;
// The LightConstants of a white Donut DirectionalLight under an untransformed node, shining along
// (dirX, dirY, dirZ), angularSize in degrees, without shadows, into dst.
@nodrops declare function Nri_FillDonutDirectionalLightConstants(dirX: number, dirY: number, dirZ: number, angularSize: number,
    irradiance: number, dst: Ref<f32>): void;
// The DeferredLightingConstants DeferredLightingPass::Render writes for the view
// (Nri_FillDonutPlanarViewConstants' arguments), lightCount lights (LightConstants each, from lights),
// no shadows, light probes or ambient occlusion, a top and bottom ambient color, into dst.
@nodrops declare function Nri_FillDonutDeferredLightingConstants(viewMatrix: Ref<f32>, projMatrix: Ref<f32>, width: int, height: int,
    lights: Ref<f32>, lightCount: int, topR: number, topG: number, topB: number, bottomR: number, bottomG: number, bottomB: number,
    dst: Ref<f32>): void;

// A glTF scene as Donut's engine loads it (core/nri/nri_donut_scene.cpp): the buffers Donut's scene
// shaders read, the instances' transforms composed with Donut's math. Null (after printing why) on
// failure. Path relative to the executable's folder.
@nodrops declare function Nri_LoadDonutScene(path: string): NriDonutSceneHandle | null;
@nodrops declare function Nri_DestroyDonutScene(scene: NriDonutSceneHandle): void;
// One of the scene's buffers, which: 0 the vertices (each stream after the other:
// Nri_GetDonutSceneStreamOffset), 1 the indices (each geometry's from its first vertex; both
// ByteAddressBuffer: 4-byte structures; bindless buffers 0 and 1), 2 the InstanceData, 3 the
// GeometryData, 4 the MaterialConstants (StructuredBuffer), uploaded on the queue; 5 the indices as an
// index buffer (32-bit); 6 the InstanceData as a ByteAddressBuffer (D3D11's shaders read them so);
// 7 the vertices and 8 the indices without a structure stride, for typed views (Nri_CreateTypedBufferView:
// Vulkan's texel buffers); null on failure.
@nodrops declare function Nri_CreateDonutSceneBuffer(device: NriDeviceHandle, queue: NriQueueHandle, scene: NriDonutSceneHandle,
    which: int): NriBufferHandle | null;
// The materials' MaterialConstants in a host constant buffer, material m's at m * 256 (a constant
// buffer view each); null on failure.
@nodrops declare function Nri_CreateDonutSceneMaterialBuffer(device: NriDeviceHandle, scene: NriDonutSceneHandle): NriBufferHandle | null;
// The materials: their count, each's texture in a slot (0 base or diffuse, 1 metal-rough or
// specular, 2 normal, 3 emissive, 4 occlusion, 5 transmission, 6 opacity: the passes' t0 to t6; -1
// for none), its domain (0 opaque, 1 alpha-tested, 2 alpha-blended, 3 to 5 transmissive) and whether
// it's double-sided (drawn without culling).
@nodrops declare function Nri_GetDonutSceneMaterialCount(scene: NriDonutSceneHandle): int;
@nodrops declare function Nri_GetDonutSceneMaterialTexture(scene: NriDonutSceneHandle, material: int, slot: int): int;
@nodrops declare function Nri_GetDonutSceneMaterialDomain(scene: NriDonutSceneHandle, material: int): int;
@nodrops declare function Nri_GetDonutSceneMaterialDoubleSided(scene: NriDonutSceneHandle, material: int): int;
// The textures the materials number (their files relative to the executable's folder; 1 if sRGB).
@nodrops declare function Nri_GetDonutSceneTextureCount(scene: NriDonutSceneHandle): int;
@nodrops declare function Nri_GetDonutSceneTexturePath(scene: NriDonutSceneHandle, texture: int): string;
@nodrops declare function Nri_GetDonutSceneTextureSrgb(scene: NriDonutSceneHandle, texture: int): int;
// The scene's bounds (its scene graph root's global bounding box): 6 floats into dst, min x, y, z, max
// x, y, z.
@nodrops declare function Nri_GetDonutSceneBounds(scene: NriDonutSceneHandle, dst: Ref<f32>): void;
// The byte offset of a vertex stream in the vertex buffer: 0 positions (float3), 1 texture
// coordinates (float2), 2 normals, 3 tangents (snorm8 each).
@nodrops declare function Nri_GetDonutSceneStreamOffset(scene: NriDonutSceneHandle, stream: int): int;
// The mesh instances (each's InstanceData index its number), their geometries, each geometry's
// index count: a draw each.
// The meshes' geometries (the GeometryData buffer's entries), in global geometry order.
@nodrops declare function Nri_GetDonutSceneGeometryCount(scene: NriDonutSceneHandle): int;
@nodrops declare function Nri_GetDonutSceneInstanceCount(scene: NriDonutSceneHandle): int;
@nodrops declare function Nri_GetDonutSceneInstanceGeometryCount(scene: NriDonutSceneHandle, instance: int): int;
@nodrops declare function Nri_GetDonutSceneGeometryIndexCount(scene: NriDonutSceneHandle, instance: int, geometry: int): int;
// A geometry's first index in the index buffer, its first vertex in the streams (its indices count
// from it) and its material.
@nodrops declare function Nri_GetDonutSceneGeometryFirstIndex(scene: NriDonutSceneHandle, instance: int, geometry: int): int;
@nodrops declare function Nri_GetDonutSceneGeometryFirstVertex(scene: NriDonutSceneHandle, instance: int, geometry: int): int;
@nodrops declare function Nri_GetDonutSceneGeometryMaterial(scene: NriDonutSceneHandle, instance: int, geometry: int): int;
// A dynamic mesh (Donut_CreateDynamicMesh + Donut_AttachDynamicMesh) added to the scene: one geometry of
// maxVertices float3 positions followed by maxVertices float2 texture coordinates in bindless buffer
// vertexBufferIndex and maxIndices 32-bit indices in bindless buffer indexBufferIndex, its material
// alpha-blended (Donut's default otherwise), an instance (identity transform) after the scene's. Create
// the scene's buffers 2 to 4 after it. The instance's index.
@nodrops declare function Nri_AddDonutSceneDynamicMesh(scene: NriDonutSceneHandle, maxVertices: int, maxIndices: int,
    vertexBufferIndex: int, indexBufferIndex: int): int;
// A material's base or diffuse texture (its bindless texture index; -1: none), as
// Donut_SetDynamicMeshTexture sets the dynamic mesh's. Create the scene's buffer 4 after it.
@nodrops declare function Nri_SetDonutSceneMaterialBaseTexture(scene: NriDonutSceneHandle, material: int, textureIndex: int): void;
// The world-space position of a glTF file's node (path relative to the executable's folder; nodePath like
// "/Emitter"), as Donut's Scene.getNodePosition: 3 floats into dst (Ref of an f32 array element). 0 if there's
// no such node.
@nodrops declare function Nri_GetDonutSceneNodePosition(path: string, nodePath: string, dst: Ref<f32>): int;
// The PlanarViewConstants (ForwardShadingViewConstants) of one face (0 to 5) of a Donut CubemapView
// around the camera (its world-to-view matrix, 16 floats) with its reverse infinite projection from
// zNear, a resolution x resolution face, into dst.
@nodrops declare function Nri_FillDonutCubemapFaceViewConstants(worldToView: Ref<f32>, zNear: number, resolution: int, face: int,
    dst: Ref<f32>): void;
// The ForwardShadingLightConstants ForwardShadingPass::PrepareLights writes with no lights, light
// probes or shadow map, a top and bottom ambient color, into dst.
@nodrops declare function Nri_FillDonutForwardLightConstants(topR: number, topG: number, topB: number, bottomR: number, bottomG: number,
    bottomB: number, dst: Ref<f32>): void;
// A Donut PlanarShadowMap (one orthographic view; a D24S8 texture array of one resolution x
// resolution slice, depth cleared to 1) fitted to the directional light of
// Nri_FillDonutDirectionalLightConstants' arguments and world-space bounds (Nri_GetDonutSceneBounds'),
// as Donut_SetupPlanarShadowMapForScene fits it, shadows fading out over fadeRangeWorld at its edges:
// the DepthPassConstants into depthDst, the ShadowConstants into shadowDst. 1 if its view is mirrored
// (the depth pass's front faces counterclockwise).
@nodrops declare function Nri_SetupDonutPlanarShadowMap(dirX: number, dirY: number, dirZ: number, bounds: Ref<f32>, resolution: int,
    fadeRangeWorld: number, depthDst: Ref<f32>, shadowDst: Ref<f32>): int;
// The ForwardShadingLightConstants PrepareLights writes for that directional light, its shadow map of
// shadowMapResolution (its ShadowConstants: Nri_SetupDonutPlanarShadowMap's) or none (0), a top and
// bottom ambient color, into dst.
@nodrops declare function Nri_FillDonutForwardSunLightConstants(dirX: number, dirY: number, dirZ: number, angularSize: number,
    irradiance: number, shadow: Ref<f32>, shadowMapResolution: int, topR: number, topG: number, topB: number, bottomR: number,
    bottomG: number, bottomB: number, dst: Ref<f32>): void;
// The SkyConstants EnvironmentMapPass::Render writes for a planar view (Nri_FillDonutPlanarViewConstants'
// arguments), into dst.
@nodrops declare function Nri_FillDonutSkyConstants(viewMatrix: Ref<f32>, projMatrix: Ref<f32>, width: int, height: int, dst: Ref<f32>): void;
// The ToneMappingConstants ToneMappingPass writes with its default parameters and no color LUT, for
// a stage: 0 the histogram of a width x height view, 1 the exposure (adapting over frameTime seconds:
// 0 keeps it), 2 the tone mapping; into dst.
@nodrops declare function Nri_FillDonutToneMappingConstants(stage: int, width: int, height: int, frameTime: number, dst: Ref<f32>): void;
// The TemporalAntiAliasingConstants TemporalAntiAliasingPass::RenderMotionVectors writes for a planar
// view and the previous frame's (Nri_FillDonutPlanarViewConstants' matrices each, width x height
// viewports) and a stencil mask: the reprojection into the previous view.
@nodrops declare function Nri_FillDonutTaaMotionVectorConstants(viewMatrix: Ref<f32>, projMatrix: Ref<f32>, prevViewMatrix: Ref<f32>,
    prevProjMatrix: Ref<f32>, width: int, height: int, stencilMask: int, dst: Ref<f32>): void;
// The TemporalAntiAliasingConstants TemporalAntiAliasingPass::TemporalResolve writes with the default
// parameters for a width x height view and resolved color, no pixel offset; feedbackIsValid 0 on the
// first frame (the new frame's weight 1).
@nodrops declare function Nri_FillDonutTaaResolveConstants(width: int, height: int, feedbackIsValid: int, dst: Ref<f32>): void;

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
// Nri_CmdDrawImgui with the UI's colors as they are, not made linear for an attachment that isn't sRGB
// (as Donut's ImGui renderer draws: into an HDR scene, for one).
@nodrops declare function Nri_CmdDrawImguiUnconverted(sample: NriSampleHandle, commandBuffer: NriCommandBufferHandle, attachmentFormat: NriFormat): void;
@nodrops declare function Nri_ImguiEndFrame(sample: NriSampleHandle): void;
// 1 if ImGui uses the mouse (it's over a window, or dragging a widget): the example shouldn't.
@nodrops declare function Nri_ImguiWantsMouse(): int;
// A TrueType font (path relative to the executable's folder) at size pixels, as Donut's
// ImGuiPass.createFont loads it (after Nri_InitImgui); null if it can't be read.
@nodrops declare function Nri_ImguiCreateFont(path: string, size: number): NriImguiFontHandle | null;
// Draws with the font until Nri_ImguiPopFont.
@nodrops declare function Nri_ImguiPushFont(font: NriImguiFontHandle): void;
// Draws with the font at this size (pixels, as Nri_ImguiCreateFont's) until Nri_ImguiPopFont: one font
// serves every size.
@nodrops declare function Nri_ImguiPushFontSized(font: NriImguiFontHandle, size: number): void;
@nodrops declare function Nri_ImguiPopFont(): void;
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
// An input box with +/- buttons of step, the value shown in format ("%.3f"); the value after.
@nodrops declare function Nri_ImguiInputFloat(label: string, value: number, step: number, format: string): number;
@nodrops declare function Nri_ImguiSliderInt(label: string, value: int, min: int, max: int): int;
// 1 if the button was clicked.
@nodrops declare function Nri_ImguiButton(label: string): int;
// A radio button shown selected when active is non-zero; 1 if it was clicked.
@nodrops declare function Nri_ImguiRadioButton(label: string, active: int): int;
// Scopes the IDs of the widgets that follow (ones with the same labels apart) until Nri_ImguiPopID.
@nodrops declare function Nri_ImguiPushID(id: int): void;
@nodrops declare function Nri_ImguiPopID(): void;
// The next item on the same line as the last.
@nodrops declare function Nri_ImguiSameLine(): void;
// Places the next window with its pivot (0..1 of its size; 1, 0 = top right corner) at x, y.
@nodrops declare function Nri_ImguiSetNextWindowPosPivot(x: number, y: number, pivotX: number, pivotY: number): void;
// A value dragged by speed per pixel, within min and max; the new value.
@nodrops declare function Nri_ImguiDragFloat(label: string, value: number, speed: number, min: number, max: number): number;
// A line between the widgets above and below.
@nodrops declare function Nri_ImguiSeparator(): void;
// The widgets that follow indented, until Nri_ImguiUnindent.
@nodrops declare function Nri_ImguiIndent(): void;
@nodrops declare function Nri_ImguiUnindent(): void;
// Three values (Ref of an f32 array element, changed in place) dragged by speed per pixel; 1 when changed.
@nodrops declare function Nri_ImguiDragFloat3(label: string, values: Ref<f32>, speed: number): int;
// A color edit of the 4 floats at values (RGBA), width wide; 1 when changed.
@nodrops declare function Nri_ImguiColorEdit4(label: string, values: Ref<f32>, width: number): int;
// Text at (x, y) in UI coordinates (its top-left corner, or with alignRight its top-right one) in the
// current font (Nri_ImguiPushFont's, or the default) and color (r, g, b, a), behind the windows (between Nri_ImguiNewFrame and
// Nri_ImguiRender).
@nodrops declare function Nri_ImguiDrawText(x: number, y: number, text: string, r: number, g: number, b: number, a: number,
    alignRight: int): void;
// A filled rectangle from (x0, y0) to (x1, y1) in UI coordinates, behind the windows.
@nodrops declare function Nri_ImguiDrawRect(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number,
    a: number): void;
// The width of a line of text in the default font, in UI coordinates.
@nodrops declare function Nri_ImguiCalcTextWidth(text: string): number;
// The height of a line of text in the default font, in UI coordinates.
@nodrops declare function Nri_ImguiGetFontSize(): number;
// A color picker of the 3 floats at values (RGB, unbounded), width wide, without previews, as
// Vulkan-Samples' Drawer::color_op<Pick>; 1 when changed.
@nodrops declare function Nri_ImguiColorPicker3(label: string, values: Ref<f32>, width: number): int;

// Compute
// A compute pipeline of the shader read from path (as Nri_CreateGraphicsPipeline's); null on failure.
@nodrops declare function Nri_CreateComputePipeline(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle, path: string,
    entry: string): NriPipelineHandle | null;
// As Nri_CreateComputePipeline, of a ShaderMake permutation blob (a .cfg line with -D), the
// permutation whose defines are permutation ("NAME=VALUE").
@nodrops declare function Nri_CreateComputePipelinePermutation(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle,
    path: string, entry: string, permutation: string): NriPipelineHandle | null;
// A width x height texture (one mip) compute shaders write (RWTexture2D) and pixel shaders read,
// shared by the queues, moved on the queue (which this waits for) to NriTextureState.Storage; null on
// failure. Destroyed with Nri_DestroyTexture.
@nodrops declare function Nri_CreateStorageTexture(device: NriDeviceHandle, queue: NriQueueHandle, width: int, height: int,
    format: NriFormat): NriTextureHandle | null;
// As Nri_CreateStorageTexture, an array of layerNum layers (views: Nri_CreateStorageTextureArrayView,
// Nri_CreateTextureArrayView), left in NriTextureState.Storage.
@nodrops declare function Nri_CreateStorageTextureArray(device: NriDeviceHandle, queue: NriQueueHandle, width: int, height: int,
    layerNum: int, format: NriFormat): NriTextureHandle | null;
// As Nri_CreateStorageTexture, filled with data (Ref of an int array element; rows rowPitch bytes
// apart), left in state (NriTextureState.Storage, or PixelStorage); null on failure.
@nodrops declare function Nri_CreateStorageTextureWithData(device: NriDeviceHandle, queue: NriQueueHandle, width: int, height: int,
    format: NriFormat, data: Ref<int>, rowPitch: int, state: NriTextureState): NriTextureHandle | null;
// A view of a 2D texture's mip 0 for compute shaders to write.
@nodrops declare function Nri_CreateStorageTextureView(texture: NriTextureHandle, format: NriFormat): NriDescriptorHandle;
// A view of all the layers of a 2D texture array's mip 0 for compute shaders to write (RWTexture2DArray).
@nodrops declare function Nri_CreateStorageTextureArrayView(texture: NriTextureHandle, format: NriFormat): NriDescriptorHandle;
// A width x height R8_UINT shading rate attachment (a texel per Nri_GetShadingRateTileSize square of
// pixels: log2(width) << 2 | log2(height)), filled with data (Ref of an int array element: 4 texels
// an int; rows rowPitch bytes apart), written by compute shaders too if storage is 1 (a view:
// Nri_CreateStorageTextureView with R8_UINT), left in NriTextureState.ShadingRateAttachment; null on
// failure. Destroyed with Nri_DestroyTexture.
@nodrops declare function Nri_CreateShadingRateTexture(device: NriDeviceHandle, queue: NriQueueHandle, width: int, height: int,
    data: Ref<int>, rowPitch: int, storage: int): NriTextureHandle | null;
// The view a shading rate attachment is rendered with (Nri_CmdBeginRenderingWithShadingRate).
@nodrops declare function Nri_CreateShadingRateAttachmentView(texture: NriTextureHandle): NriDescriptorHandle;
// A width x height texture rendered into (a color attachment) and read and written by shaders
// (Nri_CreateStorageTextureView), left in state; null on failure. Clear it (as a color attachment)
// before shaders use it: D3D12 wants render targets initialized first.
@nodrops declare function Nri_CreateRenderTargetStorageTexture(device: NriDeviceHandle, queue: NriQueueHandle, width: int, height: int,
    format: NriFormat, state: NriTextureState): NriTextureHandle | null;

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
// The root constants of the loop's runs from now on (byteSize bytes from data, copied; the layout's
// root constants must be that size), instead of the run index.
@nodrops declare function Nri_SetAsyncComputeConstants(loop: NriAsyncComputeLoopHandle, data: Ref<f32>, byteSize: int): void;
// 1: the worker starts no more runs until resumed with 0 (the run under way finishes).
@nodrops declare function Nri_SetAsyncComputePaused(loop: NriAsyncComputeLoopHandle, paused: int): void;
// Runs the worker has submitted so far.
@nodrops declare function Nri_GetAsyncComputeRunCount(loop: NriAsyncComputeLoopHandle): int;

// Ray tracing (a device with NriFeature.RayTracing; not D3D11)
// The bottom level acceleration structure of an opaque triangle mesh: vertexNum float3 positions
// (Ref of an f32 array element), indexNum 32-bit indices (Ref of an int array element). Built on the
// queue (which this waits for); null on failure. Destroyed with Nri_DestroyAccelerationStructure.
@nodrops declare function Nri_BuildTriangleBLAS(device: NriDeviceHandle, queue: NriQueueHandle, vertices: Ref<f32>, vertexNum: int,
    indices: Ref<int>, indexNum: int, flags: NriAccelerationStructureFlags): NriAccelerationStructureHandle | null;
// A bottom level acceleration structure of one opaque triangle geometry (vertexNum float3 positions
// vertexStride bytes apart, indexNum 32-bit indices) read from buffers the example owns
// (NriBufferUsage.AccelerationStructureInput), with flags (AllowUpdate | PreferFastBuild, as Donut's
// updatable ones); not built yet. Null on failure.
@nodrops declare function Nri_CreateUpdatableTriangleBlas(device: NriDeviceHandle, vertexNum: int, vertexStride: int, indexNum: int,
    flags: NriAccelerationStructureFlags): NriUpdatableBlasHandle | null;
// Records its build, or once built its update in place, from the vertices at vertexOffset in
// vertexBuffer and the indices at indexOffset in indexBuffer, between barriers (after the rays and top
// level builds that read it before, before those that read it next).
@nodrops declare function Nri_CmdUpdateUpdatableBlas(commandBuffer: NriCommandBufferHandle, blas: NriUpdatableBlasHandle,
    vertexBuffer: NriBufferHandle, vertexOffset: int, indexBuffer: NriBufferHandle, indexOffset: int): void;
// Its first build, on the queue (which this waits for); 0 on failure.
@nodrops declare function Nri_BuildUpdatableBlasOnQueue(queue: NriQueueHandle, blas: NriUpdatableBlasHandle, vertexBuffer: NriBufferHandle,
    vertexOffset: int, indexBuffer: NriBufferHandle, indexOffset: int): int;
// The structure (for Nri_TopLevelASAddInstance).
@nodrops declare function Nri_GetUpdatableBlasAccelerationStructure(blas: NriUpdatableBlasHandle): NriAccelerationStructureHandle;
@nodrops declare function Nri_DestroyUpdatableBlas(blas: NriUpdatableBlasHandle): void;
// A BLAS of triangle geometries whose vertices are in a buffer the GPU writes, built again each time
// they move (Donut's skinned meshes'): created with flags (NriAccelerationStructureFlags), geometries
// added (vertexNum float3 positions at vertexOffset bytes in the builds' vertex buffer; indexNum 32-bit
// indices from indices, copied; opaque 1 or 0), then Nri_BufferBlasCreate (0 on failure); each build
// recorded with Nri_CmdBuildBufferBlas from vertexBuffer (in NriBufferState.AccelerationStructureInput).
@nodrops declare function Nri_CreateBufferBlas(flags: NriAccelerationStructureFlags): NriBufferBlasHandle;
@nodrops declare function Nri_BufferBlasAddTriangles(blas: NriBufferBlasHandle, vertexOffset: int, vertexNum: int, indices: Ref<int>,
    indexNum: int, opaque: int): void;
@nodrops declare function Nri_BufferBlasCreate(device: NriDeviceHandle, blas: NriBufferBlasHandle): int;
@nodrops declare function Nri_CmdBuildBufferBlas(commandBuffer: NriCommandBufferHandle, blas: NriBufferBlasHandle, vertexBuffer: NriBufferHandle): void;
@nodrops declare function Nri_GetBufferBlasAccelerationStructure(blas: NriBufferBlasHandle): NriAccelerationStructureHandle;
@nodrops declare function Nri_DestroyBufferBlas(blas: NriBufferBlasHandle): void;
// A bottom level acceleration structure of one triangle geometry rebuilt every frame from buffers the
// example owns (NriBufferUsage.AccelerationStructureInput), as Donut's dynamic meshes': room for
// maxVertexNum float3 positions vertexStride bytes apart and maxIndexNum 32-bit indices, flags
// (PreferFastTrace, as Donut's), opaque or (0) not (ray queries see its triangles as candidates); not
// built yet. Null on failure. Destroyed with Nri_DestroyUpdatableBlas; its structure is
// Nri_GetUpdatableBlasAccelerationStructure's.
@nodrops declare function Nri_CreateDynamicTriangleBlas(device: NriDeviceHandle, maxVertexNum: int, vertexStride: int, maxIndexNum: int,
    flags: NriAccelerationStructureFlags, opaque: int): NriUpdatableBlasHandle | null;
// Records its build from scratch from vertexNum vertices at vertexOffset in vertexBuffer and indexNum
// indices at indexOffset in indexBuffer (0: empty), between barriers (after the ray queries and top level
// builds that read it before, before those that read it next).
@nodrops declare function Nri_CmdBuildDynamicTriangleBlas(commandBuffer: NriCommandBufferHandle, blas: NriUpdatableBlasHandle,
    vertexBuffer: NriBufferHandle, vertexOffset: int, vertexNum: int, indexBuffer: NriBufferHandle, indexOffset: int, indexNum: int): void;
// The top level acceleration structure of one instance of blas, as Donut's examples make it (identity
// transform, instance ID 0, mask 1, counter-clockwise front faces), built on the queue (which this
// waits for); null on failure.
@nodrops declare function Nri_BuildSingleInstanceTLAS(device: NriDeviceHandle, queue: NriQueueHandle, blas: NriAccelerationStructureHandle,
    flags: NriAccelerationStructureFlags): NriAccelerationStructureHandle | null;
// The view of a top level acceleration structure that shaders trace rays into (a set's
// NriDescriptorType.AccelerationStructure range); null on failure.
@nodrops declare function Nri_CreateAccelerationStructureDescriptor(accelerationStructure: NriAccelerationStructureHandle): NriDescriptorHandle | null;
@nodrops declare function Nri_DestroyAccelerationStructure(accelerationStructure: NriAccelerationStructureHandle): void;
// As Nri_CreateDescriptorPoolWithBuffers (no storage structured buffers), with room for
// accelerationStructureMaxNum acceleration structures too.
@nodrops declare function Nri_CreateDescriptorPoolWithAccelerationStructures(device: NriDeviceHandle, setMaxNum: int, samplerMaxNum: int,
    constantBufferMaxNum: int, textureMaxNum: int, storageTextureMaxNum: int, structuredBufferMaxNum: int,
    accelerationStructureMaxNum: int): NriDescriptorPoolHandle | null;
// As Nri_CreateDescriptorPoolWithAccelerationStructures, with room for bufferMaxNum typed buffers (Buffer<T>)
// too.
@nodrops declare function Nri_CreateDescriptorPoolWithAccelerationStructuresAndTypedBuffers(device: NriDeviceHandle, setMaxNum: int,
    samplerMaxNum: int, constantBufferMaxNum: int, textureMaxNum: int, storageTextureMaxNum: int, structuredBufferMaxNum: int,
    bufferMaxNum: int, accelerationStructureMaxNum: int): NriDescriptorPoolHandle | null;
// As Nri_CreateDescriptorPoolWithAccelerationStructures, with room for storageStructuredBufferMaxNum
// storage structured buffers (RWStructuredBuffer, RWByteAddressBuffer) too.
@nodrops declare function Nri_CreateDescriptorPoolWithAccelerationStructuresAndStorageBuffers(device: NriDeviceHandle, setMaxNum: int,
    samplerMaxNum: int, constantBufferMaxNum: int, textureMaxNum: int, storageTextureMaxNum: int, structuredBufferMaxNum: int,
    storageStructuredBufferMaxNum: int, accelerationStructureMaxNum: int): NriDescriptorPoolHandle | null;
// A ray tracing pipeline of the library read from path (a .cfg's "-T lib" line, one blob), whose
// shader groups are the ray generation shader raygen, the miss shader miss and the hit group of the
// closest hit shader closestHit. Rays carry payloadSize bytes, hits attributeSize bytes; no recursion.
// Null on failure.
@nodrops declare function Nri_CreateRayTracingPipeline(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle, path: string,
    raygen: string, miss: string, closestHit: string, payloadSize: int, attributeSize: int): NriPipelineHandle | null;
// The shader table of a ray tracing pipeline whose groups are the ray generation shader, missNum miss
// shaders, then hitGroupNum hit groups (Nri_CreateRayTracingPipeline's: 1 and 1), uploaded on the
// queue (which this waits for); null on failure.
@nodrops declare function Nri_CreateShaderTable(device: NriDeviceHandle, queue: NriQueueHandle, pipeline: NriPipelineHandle, missNum: int,
    hitGroupNum: int): NriShaderTableHandle | null;
@nodrops declare function Nri_DestroyShaderTable(shaderTable: NriShaderTableHandle): void;
// The ray tracing bind point's Nri_CmdSetPipelineLayout and Nri_CmdSetDescriptorSet (for
// Nri_CmdDispatchRays; the pipeline is set with Nri_CmdSetPipeline).
@nodrops declare function Nri_CmdSetRayTracingPipelineLayout(commandBuffer: NriCommandBufferHandle, pipelineLayout: NriPipelineLayoutHandle): void;
@nodrops declare function Nri_CmdSetRayTracingDescriptorSet(commandBuffer: NriCommandBufferHandle, setIndex: int, descriptorSet: NriDescriptorSetHandle): void;
// Launches width x height rays of the ray tracing pipeline set, with its shader table's shaders.
@nodrops declare function Nri_CmdDispatchRays(commandBuffer: NriCommandBufferHandle, shaderTable: NriShaderTableHandle, width: int, height: int): void;
// Bottom level acceleration structures of several geometries: Nri_BlasDescAddTriangles adds an opaque
// triangle mesh (vertexNum float3 positions, indexNum 32-bit indices into them; copied) as the next
// geometry; Nri_BuildBlasFromDesc builds the structure on the queue (which it waits for), null on
// failure (Nri_BuildTriangleBLAS is it for one mesh).
@nodrops declare function Nri_CreateBlasDesc(): NriBlasDescHandle;
@nodrops declare function Nri_DestroyBlasDesc(desc: NriBlasDescHandle): void;
@nodrops declare function Nri_BlasDescAddTriangles(desc: NriBlasDescHandle, vertices: Ref<f32>, vertexNum: int, indices: Ref<int>, indexNum: int): void;
// As Nri_BlasDescAddTriangles, from data some other library holds (SdkMesh.getVertexBufferData's,
// getIndexBufferData's): vertexNum vertices vertexStride bytes apart, each starting with its float3
// position, and indexNum 32-bit indices; copied.
@nodrops declare function Nri_BlasDescAddTrianglesFromPointer(desc: NriBlasDescHandle, vertices: Opaque, vertexNum: int, vertexStride: int,
    indices: Opaque, indexNum: int): void;
// A geometry of aabbNum axis-aligned boxes (opaque; intersection shaders decide the hits) from aabbs (Ref
// of an f32 array element): 6 floats each, min x, y, z, max x, y, z; copied.
@nodrops declare function Nri_BlasDescAddAabbs(desc: NriBlasDescHandle, aabbs: Ref<f32>, aabbNum: int): void;
// The last geometry added (a triangle one)'s transform: a row-major 3 x 4 matrix (12 floats from Ref of
// an f32 array element; copied), applied to its positions as the structure is built.
@nodrops declare function Nri_BlasDescSetTransform(desc: NriBlasDescHandle, transform: Ref<f32>): void;
// The last geometry added: opaque (1, the default) or not (0: any-hit shaders run on its hits, ray
// queries see them as non-opaque candidates), as Donut's alpha-tested geometries.
@nodrops declare function Nri_BlasDescSetOpaque(desc: NriBlasDescHandle, opaque: int): void;
@nodrops declare function Nri_BuildBlasFromDesc(device: NriDeviceHandle, queue: NriQueueHandle, desc: NriBlasDescHandle,
    flags: NriAccelerationStructureFlags): NriAccelerationStructureHandle | null;
// Ray tracing pipelines of named shaders and groups: Nri_RayTracingPipelineDescAddShader adds the
// library's shader entry for the stage (an NriStage bit), returning its index (from 0);
// Nri_RayTracingPipelineDescAddGroup adds a group of up to three shaders (their indices, -1 for none:
// a ray generation or miss shader alone, or a hit group's closest hit, any hit and intersection
// shaders), returning its index (from 0), which shader tables name it by.
@nodrops declare function Nri_CreateRayTracingPipelineDesc(): NriRayTracingPipelineDescHandle;
@nodrops declare function Nri_DestroyRayTracingPipelineDesc(desc: NriRayTracingPipelineDescHandle): void;
@nodrops declare function Nri_RayTracingPipelineDescAddShader(desc: NriRayTracingPipelineDescHandle, stage: NriStage, entry: string): int;
@nodrops declare function Nri_RayTracingPipelineDescAddGroup(desc: NriRayTracingPipelineDescHandle, first: int, second: int, third: int): int;
// The pipeline of the desc's shaders from the library read from path (one blob). Rays carry
// payloadSize bytes at most, hits attributeSize bytes; rays trace rays recursionMaxDepth deep at most
// (1: the ray generation shader's alone). Null on failure.
@nodrops declare function Nri_CreateRayTracingPipelineFromDesc(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle, path: string,
    desc: NriRayTracingPipelineDescHandle, payloadSize: int, attributeSize: int, recursionMaxDepth: int): NriPipelineHandle | null;
// As Nri_CreateRayTracingPipelineFromDesc, of a ShaderMake permutation blob (a .cfg line with -D), the
// library whose defines are permutation ("NAME=VALUE").
@nodrops declare function Nri_CreateRayTracingPipelineFromDescPermutation(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle,
    path: string, permutation: string, desc: NriRayTracingPipelineDescHandle, payloadSize: int, attributeSize: int,
    recursionMaxDepth: int): NriPipelineHandle | null;
// The shader table whose records are the pipeline's groups raygenGroup, missGroups (missNum ints: miss
// shader index i is missGroups[i]) and hitGroups (hitGroupNum ints: hit group index i, an instance's
// hit group offset plus the ray's contribution, is hitGroups[i]; -1, a null record: a hit runs no
// shader); null on failure.
@nodrops declare function Nri_CreateShaderTableFromGroups(device: NriDeviceHandle, queue: NriQueueHandle, pipeline: NriPipelineHandle,
    raygenGroup: int, missGroups: Ref<int>, missNum: int, hitGroups: Ref<int>, hitGroupNum: int): NriShaderTableHandle | null;
// A top level acceleration structure of instanceMaxNum instances at most, with flags (AllowUpdate to
// refit it), its instances written to one of bufferNum buffers a frame (the frames in flight); null on
// failure. Its structure (for Nri_CreateAccelerationStructureDescriptor) is
// Nri_GetTopLevelAccelerationStructure's.
@nodrops declare function Nri_CreateTopLevelAS(device: NriDeviceHandle, instanceMaxNum: int, flags: NriAccelerationStructureFlags,
    bufferNum: int): NriTopLevelASHandle | null;
@nodrops declare function Nri_GetTopLevelAccelerationStructure(tlas: NriTopLevelASHandle): NriAccelerationStructureHandle;
@nodrops declare function Nri_TopLevelASClearInstances(tlas: NriTopLevelASHandle): void;
// An instance of blas: transform, a row-major 3x4 matrix (12 floats from Ref of an f32 array element);
// instanceId (InstanceID() in shaders); mask (ANDed with the rays'); hitGroupOffset, its first hit group
// in the shader table; flags (nri::TopLevelInstanceBits: 0, none). Ignored past instanceMaxNum.
@nodrops declare function Nri_TopLevelASAddInstance(tlas: NriTopLevelASHandle, blas: NriAccelerationStructureHandle, transform: Ref<f32>,
    instanceId: int, mask: int, hitGroupOffset: int, flags: int): void;
// Records the build of the TLAS from its instances (written to instance buffer bufferIndex: the
// frame's), or with update (1; AllowUpdate) its refit in place once it's built, between the barriers
// after the shaders that read it before (ray tracing shaders, ray queries in compute and pixel
// shaders) and before those that read it next.
@nodrops declare function Nri_CmdBuildTopLevelAS(commandBuffer: NriCommandBufferHandle, tlas: NriTopLevelASHandle, bufferIndex: int, update: int): void;
@nodrops declare function Nri_DestroyTopLevelAS(tlas: NriTopLevelASHandle): void;
// Copies the whole of src into dst (same size and format; src in NriTextureState.CopySource, dst in
// CopyDestination).
@nodrops declare function Nri_CmdCopyTexture(commandBuffer: NriCommandBufferHandle, dst: NriTextureHandle, src: NriTextureHandle): void;
// Builds the TLAS from its instances on the queue, and waits (a scene that doesn't move); 0 on failure.
@nodrops declare function Nri_BuildTopLevelASOnQueue(queue: NriQueueHandle, tlas: NriTopLevelASHandle): int;
// The scene's acceleration structures as Donut_BuildSceneAccelStructs builds them: a BLAS per mesh
// (its geometries' opaque triangles), a TLAS of the mesh instances (their transforms, mask 1, instance
// ID and hit group offset 0, no flags), built on the queue (which this waits for); null on failure.
@nodrops declare function Nri_BuildDonutSceneAccelStructs(device: NriDeviceHandle, queue: NriQueueHandle,
    scene: NriDonutSceneHandle): NriDonutSceneAccelStructsHandle | null;
// As Nri_BuildDonutSceneAccelStructs, for shader tables with hitGroupStride entries per geometry (in
// global geometry order, as Donut_BuildSceneAccelStructsWithHitGroupStride): an instance's hit group
// offset and instance ID are its mesh's first geometry index, the offset times hitGroupStride; in
// shaders InstanceID() + GeometryIndex() is the hit geometry's (its GeometryData's index).
@nodrops declare function Nri_BuildDonutSceneAccelStructsWithHitGroupStride(device: NriDeviceHandle, queue: NriQueueHandle,
    scene: NriDonutSceneHandle, hitGroupStride: int): NriDonutSceneAccelStructsHandle | null;
@nodrops declare function Nri_GetDonutSceneTopLevelAS(accelStructs: NriDonutSceneAccelStructsHandle): NriTopLevelASHandle;
// The BLAS Nri_BuildDonutSceneAccelStructs built for an instance's mesh, for TLASes the example builds
// itself (Nri_TopLevelASAddInstance); null if it built none for it.
@nodrops declare function Nri_GetDonutSceneInstanceBlas(scene: NriDonutSceneHandle, accelStructs: NriDonutSceneAccelStructsHandle,
    instance: int): NriAccelerationStructureHandle | null;
// An instance's transform, as the TLAS takes it (12 floats into dst, Ref of an f32 array element).
@nodrops declare function Nri_GetDonutSceneInstanceTransform(scene: NriDonutSceneHandle, instance: int, dst: Ref<f32>): void;
@nodrops declare function Nri_DestroyDonutSceneAccelStructs(accelStructs: NriDonutSceneAccelStructsHandle): void;
// An animated Donut scene: a scene file (Donut's .scene.json: models instanced by a node graph) or a glTF
// file (path relative to the executable's folder) with its skins and animations, as Donut's engine loads
// it; null on failure. Its static data is a Donut scene (Nri_GetDonutAnimatedSceneScene: valid as long as
// it) for Nri_CreateDonutSceneBuffer (0 the vertices, joint indices and weights: bindless buffer 0; 1
// the indices: bindless buffer 1; 3 the GeometryData; 4 the MaterialConstants) and its textures; the
// skinned instances' vertices are a buffer of their own (bindless buffer 2,
// Nri_GetDonutSkinnedVertexBufferSize bytes: Nri_CreateAccelerationStructureInputStorageBuffer).
@nodrops declare function Nri_LoadDonutAnimatedScene(path: string): NriDonutAnimatedSceneHandle | null;
@nodrops declare function Nri_DestroyDonutAnimatedScene(scene: NriDonutAnimatedSceneHandle): void;
@nodrops declare function Nri_GetDonutAnimatedSceneScene(scene: NriDonutAnimatedSceneHandle): NriDonutSceneHandle;
// The animations (the scene graph's order), each's duration in seconds; an animation's nodes posed at
// time seconds into it (SceneGraphAnimation::Apply(float(time))).
@nodrops declare function Nri_GetDonutAnimationCount(scene: NriDonutAnimatedSceneHandle): int;
@nodrops declare function Nri_GetDonutAnimationDuration(scene: NriDonutAnimatedSceneHandle, index: int): number;
@nodrops declare function Nri_ApplyDonutAnimation(scene: NriDonutAnimatedSceneHandle, index: int, time: number): void;
// After animations: the nodes' transforms, the instances' InstanceData, the joint matrices (Scene::Refresh).
@nodrops declare function Nri_RefreshDonutAnimatedScene(scene: NriDonutAnimatedSceneHandle): void;
// The instances' InstanceData (bindless.h's): size and stride in bytes; written into a host buffer at offset.
@nodrops declare function Nri_GetDonutAnimatedSceneInstanceDataSize(scene: NriDonutAnimatedSceneHandle): int;
@nodrops declare function Nri_GetDonutAnimatedSceneInstanceDataStride(scene: NriDonutAnimatedSceneHandle): int;
@nodrops declare function Nri_WriteDonutAnimatedSceneInstances(scene: NriDonutAnimatedSceneHandle, buffer: NriBufferHandle, offset: int): void;
// The skinned instances, each's joint count and joint matrices (float4x4 each: Donut's skinning shader's
// t1) written into a host buffer at offset, its SkinningConstants (15 uints into dst, Ref of an f32
// array element; SkinningFlag_FirstFrame the first time only): dispatch numVertices (the first) / 256
// groups, rounded up.
@nodrops declare function Nri_GetDonutSkinnedInstanceCount(scene: NriDonutAnimatedSceneHandle): int;
@nodrops declare function Nri_GetDonutSkinnedJointCount(scene: NriDonutAnimatedSceneHandle, skinned: int): int;
// The skinned instance's vertex count (SkinningConstants::numVertices).
@nodrops declare function Nri_GetDonutSkinnedVertexCount(scene: NriDonutAnimatedSceneHandle, skinned: int): int;
@nodrops declare function Nri_WriteDonutSkinnedJoints(scene: NriDonutAnimatedSceneHandle, skinned: int, buffer: NriBufferHandle, offset: int): void;
@nodrops declare function Nri_GetDonutSkinningConstants(scene: NriDonutAnimatedSceneHandle, skinned: int, dst: Ref<f32>): void;
@nodrops declare function Nri_GetDonutSkinnedVertexBufferSize(scene: NriDonutAnimatedSceneHandle): int;
// As Donut_CreateAnimatedSceneAccelStructs: the static meshes' BLASes built on the queue (which this
// waits for), the skinned instances' and the TLAS (its instances in one of bufferNum buffers a frame)
// created; null on failure. Nri_CmdBuildDonutAnimatedSceneAccelStructs, as Donut_UpdateSceneAccelStructs:
// with rebuildSkinned the skinned BLASes built from skinnedVertexBuffer (in
// NriBufferState.AccelerationStructureInput), then the TLAS from the current transforms (instance IDs the
// instance indices), its instances in buffer bufferIndex.
@nodrops declare function Nri_CreateDonutAnimatedSceneAccelStructs(device: NriDeviceHandle, queue: NriQueueHandle,
    scene: NriDonutAnimatedSceneHandle, bufferNum: int): NriDonutAnimatedSceneAccelStructsHandle | null;
@nodrops declare function Nri_GetDonutAnimatedSceneTopLevelAS(accelStructs: NriDonutAnimatedSceneAccelStructsHandle): NriTopLevelASHandle;
@nodrops declare function Nri_CmdBuildDonutAnimatedSceneAccelStructs(commandBuffer: NriCommandBufferHandle,
    accelStructs: NriDonutAnimatedSceneAccelStructsHandle, scene: NriDonutAnimatedSceneHandle, skinnedVertexBuffer: NriBufferHandle,
    bufferIndex: int, rebuildSkinned: int): void;
@nodrops declare function Nri_DestroyDonutAnimatedSceneAccelStructs(accelStructs: NriDonutAnimatedSceneAccelStructsHandle): void;

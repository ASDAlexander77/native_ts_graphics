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
    ComputeQueue = 0,
    ConservativeRasterization = 1,
    FastGeometryShader = 5,
    Meshlets = 9,
    RayQuery = 10,
    // Opacity micromaps in BLASes (Donut_CreateOpacityMicromap): D3D12 raytracing tier 1.2 (DXR 1.2,
    // the Agility SDK runtime: link core/d3d12_agility_sdk.cpp), Vulkan's VK_EXT_opacity_micromap
    // (AppOptions.RayTracing).
    RayTracingOpacityMicromap = 13,
    RayTracingPipeline = 14,
    // Hit shaders reading the vertex positions of the triangles they hit (Vulkan's
    // VK_KHR_ray_tracing_position_fetch, with AppOptions.RayTracing; D3D12 through NVAPI).
    RayTracingPositionFetch = 15,
    ShaderSpecializations = 18,
    VariableRateShading = 21,
    VirtualResources = 22
}

// Donut_TranscodeKtx2's target formats (core/basis_transcoder.cpp, linked into the examples that
// use it): RGBA8, BC7, BC3, ASTC 4x4, ETC2 RGBA.
enum TranscodeFormat {
    RGBA32 = 0,
    BC7 = 1,
    BC3 = 2,
    ASTC4x4 = 3,
    ETC2 = 4
}

// Basis Universal transcoding (core/basis_transcoder.cpp, linked only into the examples that list
// it): a KTX 2 file in memory (Basis Universal ETC1S or UASTC, Zstandard supercompressed or not)
// transcoded into format, every level, kept on the CPU; stats gets the milliseconds it took and
// the bytes (Ref of a `let` f32 array of 2). Null on failure; free it with
// Donut_DestroyTranscodedTexture.
declare function Donut_TranscodeKtx2(data: Opaque, byteSize: int, format: TranscodeFormat, stats: Opaque): Opaque | null;
declare function Donut_GetTranscodedWidth(transcodedTexture: Opaque): int;
declare function Donut_GetTranscodedHeight(transcodedTexture: Opaque): int;
declare function Donut_GetTranscodedLevelCount(transcodedTexture: Opaque): int;
// A level's data, block (or pixel) rows rowPitch bytes apart, valid until the texture is freed.
declare function Donut_GetTranscodedLevelData(transcodedTexture: Opaque, level: int): Opaque;
declare function Donut_GetTranscodedLevelRowPitch(transcodedTexture: Opaque, level: int): int;
declare function Donut_DestroyTranscodedTexture(transcodedTexture: Opaque): void;

// The Xbox ATG FastBlockCompress sample's CPU side (core/fast_block_compress.cpp with the sample's
// CPU compressor, core/fbc_cpu.cpp, linked only into the examples that list them). A DDS file in
// memory (square, a power of two, 32-bit BGRA / BGRX / RGBA) decoded to RGBA8 levels in the
// sample's CPU compressor layout (16-byte aligned, natural pitches, 2x2 and 1x1 replicated to 4x4;
// X8 alpha read as 255). Null on failure; free it with Donut_DestroyFbcTexture.
declare function Donut_FbcDecodeDds(data: Opaque, byteSize: int): Opaque | null;
// The sample's CPU compression of such an image into BC1_UNORM, BC3_UNORM or BC5_UNORM: its top
// level alone, then every level; stats gets the milliseconds of each (Ref of a `let` f32 array of
// 2). Null on failure; free it with Donut_DestroyFbcTexture.
declare function Donut_FbcCompressCpu(fbcTexture: Opaque, format: Format, stats: Opaque): Opaque | null;
declare function Donut_GetFbcTextureWidth(fbcTexture: Opaque): int;
declare function Donut_GetFbcTextureLevelCount(fbcTexture: Opaque): int;
// A level's data, its rows (of pixels, or of 4x4 blocks) rowPitch bytes apart, valid until the
// texture is freed.
declare function Donut_GetFbcTextureLevelData(fbcTexture: Opaque, level: int): Opaque;
declare function Donut_GetFbcTextureLevelRowPitch(fbcTexture: Opaque, level: int): int;
declare function Donut_DestroyFbcTexture(fbcTexture: Opaque): void;

// The Xbox ATG VideoTexturePC12 sample's MediaEnginePlayer (core/video_player.cpp, linked only into
// the examples that list it; Windows): Media Foundation's Media Engine playing a video file (path
// relative to the executable's directory) on a D3D11 device of the adapter with this LUID
// (Donut_GetAdapterLuid; 0, 0: any), muted or not, playing as soon as it can. Null (after printing
// why) on failure; free it with Donut_DestroyVideoPlayer.
declare function Donut_CreateVideoPlayer(path: string, luidLow: int, luidHigh: int, muted: int): Opaque | null;
declare function Donut_GetVideoWidth(videoPlayer: Opaque): int;
declare function Donut_GetVideoHeight(videoPlayer: Opaque): int;
// Non-zero once it played to its end.
declare function Donut_IsVideoFinished(videoPlayer: Opaque): int;
// The current frame, if there is a new one, into a shared texture (Donut_GetSharedTextureHandle),
// as the sample's TransferFrame; 1 if it drew one.
declare function Donut_TransferVideoFrame(videoPlayer: Opaque, sharedHandle: Opaque): int;
// The same into memory, for APIs that can't share textures with D3D11 (Vulkan): BGRA8 rows
// (Donut_GetVideoFrameData, rowPitch bytes apart), valid until the next transfer.
declare function Donut_TransferVideoFrameToMemory(videoPlayer: Opaque): int;
declare function Donut_GetVideoFrameData(videoPlayer: Opaque): Opaque;
declare function Donut_GetVideoFrameRowPitch(videoPlayer: Opaque): int;
// Moves playback to `seconds` into the video.
declare function Donut_SetVideoTime(videoPlayer: Opaque, seconds: number): void;
declare function Donut_DestroyVideoPlayer(videoPlayer: Opaque): void;

// SDKMESH files, the legacy DirectX SDK's mesh format the Xbox ATG samples load with DirectXTK
// (core/sdkmesh.cpp, linked only into the examples that list it). A file in memory (e.g.
// Donut_GetBinaryFileData; byteSize bytes, copied), checked as DirectXTK's Model::CreateFromSDKMESH
// checks it; its buffers, meshes, subsets, materials and frames as the file has them. Null (after
// printing why) on failure; free it with Donut_DestroySdkMesh. Strings are valid as long as the mesh.
declare function Donut_LoadSdkMesh(data: Opaque, byteSize: int): Opaque | null;
declare function Donut_DestroySdkMesh(sdkMesh: Opaque): void;
// 101, or 200 for files with PBR materials.
declare function Donut_GetSdkMeshVersion(sdkMesh: Opaque): int;
// Vertex buffers: their data (valid until the mesh is freed), size in bytes, stride, vertex count.
declare function Donut_GetSdkMeshVertexBufferCount(sdkMesh: Opaque): int;
declare function Donut_GetSdkMeshVertexBufferData(sdkMesh: Opaque, vertexBuffer: int): Opaque;
declare function Donut_GetSdkMeshVertexBufferSize(sdkMesh: Opaque, vertexBuffer: int): int;
declare function Donut_GetSdkMeshVertexBufferStride(sdkMesh: Opaque, vertexBuffer: int): int;
declare function Donut_GetSdkMeshVertexBufferVertexCount(sdkMesh: Opaque, vertexBuffer: int): int;
// The byte offset in a vertex and the D3DDECLTYPE (2 FLOAT3, 1 FLOAT2...) of a vertex element by its
// D3DDECLUSAGE (0 position, 3 normal, 5 texture coordinates, 6 tangent, 7 binormal, 10 color) and
// usage index; -1 if the vertices have none.
declare function Donut_GetSdkMeshVertexElementOffset(sdkMesh: Opaque, vertexBuffer: int, usage: int, usageIndex: int): int;
declare function Donut_GetSdkMeshVertexElementType(sdkMesh: Opaque, vertexBuffer: int, usage: int, usageIndex: int): int;
// Index buffers: their data, size in bytes, index count, and whether the indices are 32-bit (16-bit
// otherwise).
declare function Donut_GetSdkMeshIndexBufferCount(sdkMesh: Opaque): int;
declare function Donut_GetSdkMeshIndexBufferData(sdkMesh: Opaque, indexBuffer: int): Opaque;
declare function Donut_GetSdkMeshIndexBufferSize(sdkMesh: Opaque, indexBuffer: int): int;
declare function Donut_GetSdkMeshIndexBufferIndexCount(sdkMesh: Opaque, indexBuffer: int): int;
declare function Donut_IsSdkMeshIndexBuffer32Bit(sdkMesh: Opaque, indexBuffer: int): int;
// Meshes: their name, vertex and index buffers, subsets (indices into the file's subsets), and
// bounding box (center, then extents: 6 floats into dst, Ref of a `let` f32 array element).
declare function Donut_GetSdkMeshMeshCount(sdkMesh: Opaque): int;
declare function Donut_GetSdkMeshMeshName(sdkMesh: Opaque, mesh: int): string;
declare function Donut_GetSdkMeshMeshVertexBuffer(sdkMesh: Opaque, mesh: int): int;
declare function Donut_GetSdkMeshMeshIndexBuffer(sdkMesh: Opaque, mesh: int): int;
declare function Donut_GetSdkMeshMeshSubsetCount(sdkMesh: Opaque, mesh: int): int;
declare function Donut_GetSdkMeshMeshSubset(sdkMesh: Opaque, mesh: int, index: int): int;
declare function Donut_CopySdkMeshMeshBounds(sdkMesh: Opaque, mesh: int, dst: Opaque): void;
// Subsets: their material, primitive type (0 triangle list, 1 triangle strip, 2 line list, 3 line
// strip, 4 point list...), and ranges of their mesh's index and vertex buffers.
declare function Donut_GetSdkMeshSubsetMaterial(sdkMesh: Opaque, subset: int): int;
declare function Donut_GetSdkMeshSubsetPrimitiveType(sdkMesh: Opaque, subset: int): int;
declare function Donut_GetSdkMeshSubsetIndexStart(sdkMesh: Opaque, subset: int): int;
declare function Donut_GetSdkMeshSubsetIndexCount(sdkMesh: Opaque, subset: int): int;
declare function Donut_GetSdkMeshSubsetVertexStart(sdkMesh: Opaque, subset: int): int;
declare function Donut_GetSdkMeshSubsetVertexCount(sdkMesh: Opaque, subset: int): int;
// Materials: their name, a texture's file name ("" if none: which 0 diffuse, or albedo in version
// 200; 1 normal; 2 specular, or roughness / metallic / ambient occlusion in version 200; 3 emissive,
// version 200 only), and their colors into dst: version 101's diffuse, ambient, specular and
// emissive (RGBA each) and specular power (17 floats), version 200's alpha (1 float).
declare function Donut_GetSdkMeshMaterialCount(sdkMesh: Opaque): int;
declare function Donut_GetSdkMeshMaterialName(sdkMesh: Opaque, material: int): string;
declare function Donut_GetSdkMeshMaterialTexture(sdkMesh: Opaque, material: int, which: int): string;
declare function Donut_CopySdkMeshMaterialColors(sdkMesh: Opaque, material: int, dst: Opaque): void;
// Frames (the meshes' hierarchy): their name, mesh and parent frame (-1 for none), and transform
// relative to the parent (16 floats into dst, row-major for mul(vector, matrix) as DirectXMath).
declare function Donut_GetSdkMeshFrameCount(sdkMesh: Opaque): int;
declare function Donut_GetSdkMeshFrameName(sdkMesh: Opaque, frame: int): string;
declare function Donut_GetSdkMeshFrameMesh(sdkMesh: Opaque, frame: int): int;
declare function Donut_GetSdkMeshFrameParent(sdkMesh: Opaque, frame: int): int;
declare function Donut_CopySdkMeshFrameMatrix(sdkMesh: Opaque, frame: int, dst: Opaque): void;

// DirectXMath's collision types (core/directx_collision.cpp, linked only into the examples that
// list it), shapes passed as floats: CollisionShape says which, and how many.
enum CollisionShape {
    // Center (3), radius.
    Sphere = 0,
    // Axis-aligned: center (3), extents (3).
    Box = 1,
    // Center (3), extents (3), orientation (quaternion x, y, z, w).
    OrientedBox = 2,
    // Origin (3), orientation (4), right, left, top and bottom slopes, near and far distances.
    Frustum = 3,
    // Three points (3 floats each).
    Triangle = 4
}

// ContainmentType values.
enum Containment {
    Disjoint = 0,
    Intersects = 1,
    Contains = 2
}

// container.Contains(shape), a Containment; containers are spheres, boxes, oriented boxes and
// frustums.
declare function Donut_CollisionContains(containerShape: CollisionShape, container: Opaque, shape: CollisionShape, s: Opaque): Containment;
// shape.Intersects(rayOrigin, rayDirection, distance) (TriangleTests::Intersects for triangles):
// non-zero on a hit, with the distance along the (normalized) direction written to distance.
declare function Donut_CollisionIntersectsRay(shape: CollisionShape, s: Opaque, rayOrigin: Opaque, rayDirection: Opaque, distance: Opaque): int;
// BoundingFrustum::CreateFromMatrix of a projection matrix (16 floats, DirectXMath's row-major
// layout) into frustum (13 floats).
declare function Donut_CollisionFrustumFromMatrix(projection: Opaque, frustum: Opaque): void;
// BoundingFrustum::GetCorners: 8 points (24 floats), the near plane's then the far plane's.
declare function Donut_CollisionFrustumCorners(frustum: Opaque, corners: Opaque): void;
// XMQuaternionRotationRollPitchYaw into quaternion (x, y, z, w).
declare function Donut_QuaternionRotationRollPitchYaw(pitch: number, yaw: number, roll: number, quaternion: Opaque): void;
// XMMatrixRotationRollPitchYaw into matrix (16 floats, row-major).
declare function Donut_MatrixRotationRollPitchYaw(pitch: number, yaw: number, roll: number, matrix: Opaque): void;

// nvrhi::VariableShadingRate values: pixels per shading, width x height.
enum VariableShadingRate {
    Rate1x1 = 0,
    Rate1x2 = 1,
    Rate2x1 = 2,
    Rate2x2 = 3,
    Rate2x4 = 4,
    Rate4x2 = 5,
    Rate4x4 = 6
}

// nvrhi::ShadingRateCombiner values (Vulkan's VkFragmentShadingRateCombinerOpKHR).
enum ShadingRateCombiner {
    Passthrough = 0, // KEEP
    Override = 1, // REPLACE
    Min = 2,
    Max = 3,
    ApplyRelative = 4 // MUL
}

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

// nvrhi::ResolveMode values: how a multisampled depth buffer is resolved by a render pass
// (Donut_CreateResolveFramebuffer, Donut_GetDepthResolveModes).
enum ResolveMode {
    None = 0,
    SampleZero = 1,
    Average = 2,
    Min = 3,
    Max = 4
}

// glTF material alpha modes (Donut_GetGltfModelPrimitiveAlphaMode).
enum AlphaMode {
    Opaque = 0,
    Mask = 1,
    Blend = 2
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
    DebugRuntime = 4,
    // Starts in fullscreen at the monitor's native resolution.
    Fullscreen = 8,
    // Starts with vertical sync off.
    NoVsync = 16,
    // DPI aware, with ImGui scaled explicitly (as Donut's feature demo).
    PerMonitorDpi = 32,
    // With Vulkan, enables the extensions DLSS needs (when built with DONUT_WITH_DLSS).
    Dlss = 64,
    // UNORM back buffers instead of sRGB ones (RGBA8_UNORM with D3D, BGRA8_UNORM with Vulkan):
    // shader output stored as is.
    UnormBackBuffer = 128,
    // R10G10B10A2_UNORM back buffers, in sRGB until Donut_SetSwapChainColorSpace asks for HDR10.
    HdrBackBuffer = 256
}

// The color space of what the back buffers hold (donut::app::SwapChainColorSpace): sRGB (SDR),
// HDR10 (Rec.2020 primaries, ST.2084 curve; R10G10B10A2_UNORM back buffers), scRGB (linear Rec.709,
// 1.0 = 80 nits; RGBA16_FLOAT ones).
enum SwapChainColorSpace {
    SRGB = 0,
    HDR10 = 1,
    ScRGB = 2
}

// nvrhi::PrimitiveType values (only the ones used so far).
enum PrimitiveType {
    PointList = 0,
    LineList = 1,
    LineStrip = 2,
    TriangleList = 3,
    TriangleStrip = 4,
    PatchList = 8
}

// nvrhi::ComparisonFunc values: depth tests.
enum ComparisonFunc {
    Never = 1,
    Less = 2,
    Equal = 3,
    LessOrEqual = 4,
    Greater = 5,
    NotEqual = 6,
    GreaterOrEqual = 7,
    Always = 8
}

// nvrhi::RasterCullMode values.
enum CullMode {
    Back = 0,
    Front = 1,
    None = 2
}

// nvrhi::RasterFillMode values.
enum FillMode {
    Solid = 0,
    Wireframe = 1
}

// The framebuffer blending of Donut_CreateGraphicsPipelineWithBlend.
enum BlendMode {
    None = 0,
    // Color One + One, alpha SrcAlpha + DstAlpha.
    Additive = 1,
    // Color SrcAlpha + InvSrcAlpha, alpha InvSrcAlpha + Zero.
    AlphaBlend = 2,
    // Color SrcAlpha + InvSrcAlpha, alpha One + InvSrcAlpha ("over").
    AlphaOver = 3,
    // Premultiplied alpha: color and alpha One + InvSrcAlpha.
    Premultiplied = 4
}

// nvrhi::BlendFactor values (D3D's numbering; Vulkan's names in the comments).
enum BlendFactor {
    Zero = 1,
    One = 2,
    SrcColor = 3,
    InvSrcColor = 4, // ONE_MINUS_SRC_COLOR
    SrcAlpha = 5,
    InvSrcAlpha = 6, // ONE_MINUS_SRC_ALPHA
    DstAlpha = 7,
    InvDstAlpha = 8, // ONE_MINUS_DST_ALPHA
    DstColor = 9,
    InvDstColor = 10, // ONE_MINUS_DST_COLOR
    SrcAlphaSaturate = 11,
    // The graphics state's blend constant (0 in Donut's draws).
    ConstantColor = 14,
    InvConstantColor = 15 // ONE_MINUS_CONSTANT_COLOR
}

// nvrhi::BlendOp values.
enum BlendOp {
    Add = 1,
    Subtract = 2,
    ReverseSubtract = 3,
    Min = 4,
    Max = 5
}

// Bits of Donut_GetAdvancedBlendOperations.
enum AdvancedBlend {
    // The blend equation advanced operations, at least, coherent.
    Available = 1,
    // All of them (advancedBlendAllOperations).
    AllOperations = 2,
    // Sources not premultiplied by their alpha, destinations neither, correlated overlap.
    NonPremultipliedSrc = 4,
    NonPremultipliedDst = 8,
    CorrelatedOverlap = 16
}

// Bits of Donut_GetMemoryHeapFlags: Vulkan's VkMemoryHeapFlags.
enum MemoryHeapFlag {
    DeviceLocal = 1,
    MultiInstance = 2
}

// Bits of Donut_GetLineRasterizationModes.
enum LineRasterization {
    Rectangular = 1,
    Bresenham = 2,
    Smooth = 4,
    StippledRectangular = 8,
    StippledBresenham = 16,
    StippledSmooth = 32
}

// How lines are rasterized (Donut_GraphicsPipelineSetLineRasterization): Vulkan's
// VkLineRasterizationModeEXT.
enum LineRasterizationMode {
    Default = 0,
    Rectangular = 1,
    Bresenham = 2,
    Smooth = 3
}

// Logic operations between a pixel shader's output (s) and the target's bits (d)
// (Donut_GraphicsPipelineSetLogicOp): nvrhi::LogicOp, in Vulkan's order.
enum LogicOp {
    Clear = 0, // 0
    And = 1, // s & d
    AndReverse = 2, // s & ~d
    Copy = 3, // s
    AndInverted = 4, // ~s & d
    NoOp = 5, // d
    Xor = 6, // s ^ d
    Or = 7, // s | d
    Nor = 8, // ~(s | d)
    Equivalent = 9, // ~(s ^ d)
    Invert = 10, // ~d
    OrReverse = 11, // s | ~d
    CopyInverted = 12, // ~s
    OrInverted = 13, // ~s | d
    Nand = 14, // ~(s & d)
    Set = 15 // all ones
}

// nvrhi::ColorMask bits: the channels a pipeline writes (Donut_GraphicsPipelineSetColorWriteMask).
enum ColorMask {
    None = 0,
    Red = 1,
    Green = 2,
    Blue = 4,
    Alpha = 8,
    All = 15
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
declare function Donut_GetArg(argv: Ref<string>, index: int): string;
// -d3d11 / -dx11, -d3d12 / -dx12, -vk / -vulkan; D3D12 by default on Windows.
declare function Donut_GetGraphicsAPIFromCommandLine(argc: int, argv: Ref<string>): GraphicsAPI;
declare function Donut_GraphicsAPIToString(api: GraphicsAPI): string;
// Shaders load from bin/shaders/<name>/<api>; the executable's name by default. Under the
// JIT the executable is donut_interop.dll, so name the example before creating the app.
declare function Donut_SetAppName(name: string): void;
// Messages below the severity are dropped.
declare function Donut_SetLogMinSeverity(severity: LogSeverity): void;

// Picks the graphics API from the command line (-d3d11, -d3d12, -vk). Returns null on failure.
declare function Donut_CreateApp(argc: int, argv: Ref<string>, title: string, width: int, height: int): Opaque;
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

// Bits of Donut_GetIndirectDrawSupport.
enum IndirectDrawSupport {
    // One indirect draw call issues several draws (Vulkan's multiDrawIndirect; D3D12).
    MultiDraw = 1,
    // Indirect draws can start at an instance other than 0 (Vulkan's drawIndirectFirstInstance).
    FirstInstance = 2,
    // Shaders can write buffers through their device addresses (Vulkan's bufferDeviceAddress).
    BufferDeviceAddress = 4
}
// What the device of a windowed app does with indirect draws (0 for headless apps). Vulkan devices
// are created with multiDrawIndirect, drawIndirectFirstInstance and
// shaderSampledImageArrayDynamicIndexing when the GPU has them.
declare function Donut_GetIndirectDrawSupport(app: Opaque): IndirectDrawSupport;
// Donut_GetShaderExecutionReordering's values.
enum ShaderExecutionReordering {
    None = 0,
    // Hit objects; reordering may be a no-op (D3D12 doesn't say).
    HitObjects = 1,
    // Hit objects, and the GPU says it reorders.
    Reorders = 2
}
// Bits of Donut_GetComputeShaderDerivatives: how compute shaders can take derivatives (ddx, ddy,
// implicit-LOD samples; shader model 6.6).
enum ComputeDerivatives {
    // In quads of 2 x 2 threads: thread groups of an even width and height (DXC's SPIR-V for them
    // uses DerivativeGroupQuads).
    Quads = 1,
    // In 4 consecutive threads: one-dimensional thread groups (DerivativeGroupLinear).
    Linear = 2
}
// Non-zero if pixel shaders can write to UAVs and do atomics on them (Vulkan devices are created
// with fragmentStoresAndAtomics when the GPU has it; D3D11 and D3D12 always can).
declare function Donut_HasFragmentStoresAndAtomics(app: Opaque): int;
// Non-zero if 2D textures can be tiled (Donut_CreateTiledTexture) and shaders can tell whether what
// they sample is mapped (CheckAccessFullyMapped): D3D12 with tiled resources tier 2, Vulkan with
// sparse residency; never D3D11.
declare function Donut_HasSparseResidency(app: Opaque): int;
// Non-zero if draws can be skipped by a value in a buffer (Donut_CreatePredicationBuffer): D3D12's
// predication, Vulkan's VK_EXT_conditional_rendering; not D3D11 (whose predicates are queries).
declare function Donut_HasConditionalRendering(app: Opaque): int;
// Non-zero if pixel shaders can use rasterizer ordered views (RasterizerOrderedTexture2D...):
// accesses from overlapping pixels happen in primitive order. D3D11/D3D12 with ROVsSupported,
// Vulkan with fragment shader pixel interlock.
declare function Donut_HasRasterizerOrderedViews(app: Opaque): int;
// Non-zero if pixel shaders can read their barycentrics (SV_Barycentrics) and the triangle's vertex
// attributes (GetAttributeAtVertex): D3D12 with BarycentricsSupported, Vulkan with
// VK_KHR_fragment_shader_barycentric.
declare function Donut_HasBarycentrics(app: Opaque): int;
// Non-zero if shaders can compute with native 16-bit types (float16_t, int16_t, uint16_t) and read
// them from structured buffers: D3D12 with Native16BitShaderOpsSupported, Vulkan with shaderFloat16,
// shaderInt16 and storageBuffer16BitAccess.
declare function Donut_HasNative16BitShaderOps(app: Opaque): int;
// Non-zero if blend states can do logic operations (Donut_GraphicsPipelineSetLogicOp): D3D11 and
// D3D12 with OutputMergerLogicOp, Vulkan with the logicOp feature.
declare function Donut_HasLogicOps(app: Opaque): int;
// Non-zero if pipelines can test the depth target against bounds
// (Donut_GraphicsPipelineSetDepthBoundsTest): D3D12 with DepthBoundsTestSupported, Vulkan with the
// depthBounds feature; never D3D11.
declare function Donut_HasDepthBoundsTest(app: Opaque): int;
// The device's memory heaps now (their count): this process's usage of each and its budget, the
// memory it can use before the system has to page or fail allocations. Vulkan's memory heaps, with
// VK_EXT_memory_budget (without it the usage is 0 and the budget the heap's size); D3D's local
// (video) and non-local (system) memory segment groups, from DXGI.
declare function Donut_QueryMemoryBudget(app: Opaque): int;
// A memory heap's usage and budget in bytes, and its MemoryHeapFlag bits, as Donut_QueryMemoryBudget
// last found them.
declare function Donut_GetMemoryHeapUsage(app: Opaque, heap: int): number;
declare function Donut_GetMemoryHeapBudget(app: Opaque, heap: int): number;
declare function Donut_GetMemoryHeapFlags(app: Opaque, heap: int): int;
// LineRasterization bits: the line rasterization modes pipelines can have: Vulkan's with
// VK_EXT_line_rasterization's features, plain and stippled; D3D's rectangular (quadrilateral),
// Bresenham (aliased) and smooth (alpha antialiased) lines, unstippled.
declare function Donut_GetLineRasterizationModes(app: Opaque): int;
// The widest lines can be: Vulkan's lineWidthRange with the wideLines feature, else 1.
declare function Donut_GetMaxLineWidth(app: Opaque): number;
// Non-zero if pixel shaders can run in full quads, helper invocations taking part in quad operations
// (QuadReadLaneAt...): Vulkan with VK_KHR_shader_quad_control (SPIR-V's RequireFullQuadsKHR and
// QuadDerivativesKHR execution modes), D3D12 always.
declare function Donut_HasShaderQuadControl(app: Opaque): int;
// AdvancedBlend bits: the advanced blend operations blend states can do
// (Donut_GraphicsPipelineSetAdvancedBlendOp): Vulkan with VK_EXT_blend_operation_advanced and its
// coherent operations; 0 elsewhere.
declare function Donut_GetAdvancedBlendOperations(app: Opaque): int;
// ComputeDerivatives bits: whether compute shaders can take derivatives (ddx, ddy, implicit-LOD
// samples; shader model 6.6) in quads of 2 x 2 threads (2D thread groups) or in 4 consecutive
// threads (1D thread groups). D3D12 with shader model 6.6, Vulkan with
// VK_KHR_compute_shader_derivatives.
declare function Donut_GetComputeShaderDerivatives(app: Opaque): ComputeDerivatives;
// The fewest and most lanes a wave (subgroup) has: D3D12's WaveLaneCountMin and Max, Vulkan's one
// subgroupSize for both; 0 without wave intrinsics (D3D11).
declare function Donut_GetWaveLaneCountMin(app: Opaque): int;
declare function Donut_GetWaveLaneCountMax(app: Opaque): int;
// Whether ray generation shaders can trace rays into hit objects, reorder their threads by them
// (MaybeReorderThread) and invoke their hit or miss shaders: D3D12 with shader model 6.9 and
// raytracing tier 1.2, Vulkan with VK_NV_ray_tracing_invocation_reorder (AppOptions.RayTracing).
declare function Donut_GetShaderExecutionReordering(app: Opaque): ShaderExecutionReordering;
// Non-zero if push constants and constant buffers can hold 16-bit values as well (Vulkan's
// storagePushConstant16 and uniformAndStorageBuffer16BitAccess).
declare function Donut_HasNative16BitConstants(app: Opaque): int;
// A barrier between the draws or dispatches before and after that write and read a UAV texture
// (NVRHI only places one where the texture is bound anew).
declare function Donut_UavBarrier(commandList: Opaque, texture: Opaque): void;
// Vulkan's conservative rasterization properties into dst (Ref of a `let` f32 array of 9):
// primitiveOverestimationSize, maxExtraPrimitiveOverestimationSize,
// extraPrimitiveOverestimationSizeGranularity, then 1 or 0 for primitiveUnderestimation,
// conservativePointAndLineRasterization, degenerateTrianglesRasterized, degenerateLinesRasterized,
// fullyCoveredFragmentShaderInputVariable, conservativeRasterizationPostDepthCoverage. 0 (dst
// untouched) on other graphics APIs or without the extension.
declare function Donut_GetVulkanConservativeRasterizationProperties(app: Opaque, dst: Opaque): int;
// D3D12's conservative rasterization tier (0 for none); 0 on other graphics APIs.
declare function Donut_GetD3D12ConservativeRasterizationTier(app: Opaque): int;
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

// GLFW's cursor modes.
enum CursorMode {
    Normal = 0,
    Hidden = 1,
    // Hidden and captured: the mouse callback gets unbounded virtual positions (raw mouse motion
    // where the system has it), for camera controls.
    Disabled = 2
}

declare function Donut_SetCursorMode(app: Opaque, mode: CursorMode): void;
// Moves the mouse cursor to (x, y) in the mouse callback's coordinates.
declare function Donut_SetCursorPosition(app: Opaque, x: number, y: number): void;
// Non-zero while the window has the keyboard focus.
declare function Donut_IsWindowFocused(app: Opaque): int;

// nvrhi::Format values (only the ones used so far).
enum Format {
    UNKNOWN = 0,
    R8_UINT = 1,
    R8_UNORM = 3,
    RG8_UINT = 5,
    R16_UINT = 9,
    R16_FLOAT = 13,
    RGBA8_UINT = 17,
    RGBA8_UNORM = 19,
    BGRA8_UNORM = 21,
    SRGBA8_UNORM = 23,
    SBGRA8_UNORM = 24,
    R10G10B10A2_UNORM = 26,
    R11G11B10_FLOAT = 27,
    R32_UINT = 33,
    R32_SINT = 34,
    R32_FLOAT = 35,
    RGBA16_UINT = 36,
    RGBA16_FLOAT = 38,
    RGBA16_UNORM = 39,
    D16 = 50,
    D24S8 = 51,
    D32 = 53,
    RG32_UINT = 41,
    RG32_FLOAT = 43,
    RGB32_FLOAT = 46,
    RGBA32_UINT = 47,
    RGBA32_FLOAT = 49,
    BC1_UNORM = 56,
    BC3_UNORM = 60,
    BC3_UNORM_SRGB = 61,
    BC5_UNORM = 64,
    BC7_UNORM = 68,
    BC7_UNORM_SRGB = 69
}

// nvrhi::SamplerAddressMode values (Vulkan's names in the comments).
enum SamplerAddressMode {
    Clamp = 0, // CLAMP_TO_EDGE
    Wrap = 1, // REPEAT
    Border = 2, // CLAMP_TO_BORDER
    Mirror = 3, // MIRRORED_REPEAT
    MirrorOnce = 4 // MIRROR_CLAMP_TO_EDGE
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
    Hull = 0x0002,
    Domain = 0x0004,
    Geometry = 0x0008,
    Pixel = 0x0010,
    Compute = 0x0020,
    Amplification = 0x0040,
    Mesh = 0x0080,
    RayGeneration = 0x0100,
    AnyHit = 0x0200,
    ClosestHit = 0x0400,
    Miss = 0x0800,
    Intersection = 0x1000,
    Callable = 0x2000,
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
// Same, blending into the framebuffer with blendMode.
declare function Donut_CreateGraphicsPipelineWithBlend(app: Opaque, frame: Opaque, vertexShader: Opaque, pixelShader: Opaque,
    inputLayout: Opaque | null, bindingLayout: Opaque | null, primitiveType: PrimitiveType, blendMode: BlendMode): Opaque;
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
// Copies a level of a texture to dst (Ref of a `let` array element; byteSize bytes at most): its
// rows (of 4 x 4 blocks for block-compressed formats) one after the other, without padding.
// Submits its own command list and waits for it: call it while no other one is open (not in a
// render callback). Not for textures the texture cache loaded (Donut_LoadTexture: they stay
// shader resources, and can't be copied from). Returns the bytes copied, 0 on failure.
declare function Donut_ReadTextureLevel(app: Opaque, texture: Opaque, mipLevel: int, dst: Opaque, byteSize: int): int;
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
// Texture of width x height with mipLevels levels (block-compressed formats too) for shaders to
// read, its levels written with Donut_WriteTextureLevel; resting at ShaderResource.
declare function Donut_CreateTextureWithLevels(app: Opaque, width: int, height: int, mipLevels: int, format: Format,
    debugName: string): Opaque;
// Uploads a level of a texture from data, its rows (of 4 x 4 blocks for block-compressed formats)
// rowPitch bytes apart, copied during the call, into an open command list.
declare function Donut_WriteTextureLevel(commandList: Opaque, texture: Opaque, mipLevel: int, data: Opaque, rowPitch: int): void;
// Render target that shaders also read and write as a UAV (RWTexture2D<...>), resting at
// UnorderedAccess.
declare function Donut_CreateRenderTargetUAVTexture(app: Opaque, width: int, height: int, format: Format, debugName: string): Opaque;
// Same, with mipLevels levels (draw into one with Donut_CreateFramebufferForMip, read another with
// Donut_BindTextureSRVMip), typeless: copies of other formats of its family land (RGBA8_UNORM data
// into SRGBA8_UNORM).
declare function Donut_CreateMipmappedRenderTarget(app: Opaque, width: int, height: int, mipLevels: int, format: Format,
    debugName: string): Opaque;
// Same, typeless: framebuffers can see it in other formats of its family
// (Donut_CreateFramebufferWithColorFormat), e.g. an SRGBA8_UNORM texture as RGBA8_UNORM (stored
// without sRGB encoding) or RGBA8_UINT (logic operations, which D3D12 has on UINT targets only);
// shaders read it in `format`.
declare function Donut_CreateTypelessRenderTargetTexture(app: Opaque, width: int, height: int, format: Format, debugName: string): Opaque;
// Depth buffer (a depth format) whose clears to clearDepth are fast (e.g. 0 for reversed depth),
// read by shaders as Texture2D<float>; resting at ShaderResource.
declare function Donut_CreateDepthTexture(app: Opaque, width: int, height: int, format: Format, clearDepth: number, debugName: string): Opaque;
// Textures that compute shaders on the compute queue use too (they rest at NonPixelShaderResource):
// a render target that shaders read, and a texture that compute shaders write
// (RWTexture2D<float4>) and shaders read.
declare function Donut_CreateComputeReadableRenderTarget(app: Opaque, width: int, height: int, format: Format, debugName: string): Opaque;
declare function Donut_CreateComputeTexture(app: Opaque, width: int, height: int, format: Format, debugName: string): Opaque;
// Texture in `format` that shaders write and read as a UAV (RWTexture2D<...>), resting at
// UnorderedAccess; clear it with Donut_ClearTextureUInt / Donut_ClearTextureFloat.
declare function Donut_CreateUAVTextureWithFormat(app: Opaque, width: int, height: int, format: Format, debugName: string): Opaque;
// Same, an array of arraySize slices (RWTexture2DArray<...>; Texture2DArray when read: the bind
// functions bind all slices).
declare function Donut_CreateUAVTextureArray(app: Opaque, width: int, height: int, arraySize: int, format: Format,
    debugName: string): Opaque;
// One color target and an optional depth target; draw into it with Donut_BeginDrawToFramebuffer.
declare function Donut_CreateFramebuffer(app: Opaque, colorTexture: Opaque, depthTexture: Opaque | null): Opaque;
// Same, the color target seen in colorFormat (a format of its family, for a typeless texture:
// Donut_CreateTypelessRenderTargetTexture).
declare function Donut_CreateFramebufferWithColorFormat(app: Opaque, colorTexture: Opaque, colorFormat: Format, depthTexture: Opaque | null): Opaque;
// A depth target alone (e.g. a shadow map).
declare function Donut_CreateDepthFramebuffer(app: Opaque, depthTexture: Opaque): Opaque;
// Same, with two color targets (SV_Target0 and SV_Target1).
declare function Donut_CreateFramebufferWithTwoTargets(app: Opaque, colorTexture0: Opaque, colorTexture1: Opaque,
    depthTexture: Opaque | null): Opaque;
// Same, with three color targets (SV_Target0 to SV_Target2).
declare function Donut_CreateFramebufferWithThreeTargets(app: Opaque, colorTexture0: Opaque, colorTexture1: Opaque,
    colorTexture2: Opaque, depthTexture: Opaque | null): Opaque;
// One level of a color target, to draw into while sampling another (Donut_BindTextureSRVMip).
declare function Donut_CreateFramebufferForMip(app: Opaque, colorTexture: Opaque, mipLevel: int): Opaque;

// Tiled textures (requires Donut_HasSparseResidency): a 2D texture whose memory is mapped tile by
// tile from heaps; unmapped tiles read as zeros. It rests as a shader resource, and is a copy source
// and destination and a render target.
declare function Donut_CreateTiledTexture(app: Opaque, width: int, height: int, mipLevels: int, format: Format, debugName: string): Opaque;
// Into dst (Ref of a `let` int array of 4): the tile's width and height in texels, the number of
// levels made of whole tiles, the number of levels packed into the mip tail.
declare function Donut_GetTextureTiling(app: Opaque, texture: Opaque, dst: Opaque): void;
// Memory to map tiles into: byteSize bytes, a multiple of the 64 KiB tile. Release it once no tile
// is mapped to it and the GPU is done with what used it.
// Placed textures: textures sharing one heap's memory (D3D12's placed resources, Vulkan's
// textures bound to memory), versus committed ones with their own allocations. The bytes a
// width x height, one-level texture of `format` takes in a heap, its alignment included: on D3D12
// at the 4 KB small resource alignment when the device grants it (a committed texture rounds up to
// 64 KB), Vulkan's memory requirements.
declare function Donut_GetPlacedTextureSize(app: Opaque, width: int, height: int, format: Format): number;
// A heap of byteSize bytes of device memory for placed textures (D3D12, Vulkan); null on failure.
declare function Donut_CreateTextureHeap(app: Opaque, byteSize: number, debugName: string): Opaque | null;
// A texture that shaders read placed in a texture heap at byteOffset (a multiple of
// Donut_GetPlacedTextureSize's size), its first use recorded into an open command list. Fill it with
// Donut_WriteTextureLevel; release it before the heap. Null on failure.
declare function Donut_CreatePlacedTexture(app: Opaque, commandList: Opaque, textureHeap: Opaque, byteOffset: number,
    width: int, height: int, format: Format, debugName: string): Opaque | null;
declare function Donut_CreateTileHeap(app: Opaque, byteSize: number, debugName: string): Opaque;
// Tile mappings, applied in one go (and freed) by Donut_ApplyTileMappings.
declare function Donut_CreateTileMappings(): Opaque;
// Maps the tile at column x, row y of level mipLevel to byteOffset in a heap, or unmaps it (null).
declare function Donut_TileMappingsAdd(tileMappings: Opaque, mipLevel: int, x: int, y: int, heap: Opaque | null, byteOffset: number): void;
// On the graphics queue, after the work submitted before (on Vulkan the device is idle before and
// after: its sparse binding isn't ordered with other work).
declare function Donut_ApplyTileMappings(app: Opaque, texture: Opaque, tileMappings: Opaque): void;
// The first level of a DDS file (path relative to the executable's directory) in a staging
// texture: memory on the CPU's side the GPU copies from. Null (after logging why) on failure.
declare function Donut_LoadStagingTexture(app: Opaque, path: string): Opaque;
declare function Donut_GetStagingTextureWidth(stagingTexture: Opaque): int;
declare function Donut_GetStagingTextureHeight(stagingTexture: Opaque): int;
// Copies width x height texels at (srcX, srcY) of a staging texture to (dstX, dstY) of level dstMip.
declare function Donut_CopyStagingTextureRegion(commandList: Opaque, dstTexture: Opaque, dstMip: int, dstX: int, dstY: int,
    stagingTexture: Opaque, srcX: int, srcY: int, width: int, height: int): void;
// Same, between levels of textures (the same texture's other levels too).
declare function Donut_CopyTextureRegion(commandList: Opaque, dstTexture: Opaque, dstMip: int, dstX: int, dstY: int,
    srcTexture: Opaque, srcMip: int, srcX: int, srcY: int, width: int, height: int): void;
// Triangle list for a framebuffer's layout, NVRHI's default render state: depth test (less) and
// writes, back faces culled (clockwise triangles are front faces).
declare function Donut_CreateGraphicsPipelineForFramebuffer(app: Opaque, framebuffer: Opaque, vertexShader: Opaque,
    pixelShader: Opaque, inputLayout: Opaque, bindingLayout: Opaque): Opaque;
// Graphics pipelines of any shape: a description built with the Donut_GraphicsPipeline* functions,
// freed by Donut_CreateGraphicsPipelineFromDesc. It starts as a triangle list with NVRHI's default
// render state: depth test (less) and writes, back faces culled (clockwise triangles are front
// faces), solid fill, no blending.
declare function Donut_CreateGraphicsPipelineDesc(vertexShader: Opaque, pixelShader: Opaque): Opaque;
// Same, for a meshlet pipeline (Donut_CreateMeshletPipelineFromDesc): amplification (null for none),
// mesh and pixel shaders, the rest set with the same functions. Its primitive type is what the mesh
// shader outputs (its outputtopology).
declare function Donut_CreateMeshletPipelineDesc(amplificationShader: Opaque | null, meshShader: Opaque, pixelShader: Opaque): Opaque;
declare function Donut_GraphicsPipelineAddBindingLayout(graphicsPipelineDesc: Opaque, bindingLayout: Opaque): void;
declare function Donut_GraphicsPipelineSetInputLayout(graphicsPipelineDesc: Opaque, inputLayout: Opaque): void;
declare function Donut_GraphicsPipelineSetPrimitiveType(graphicsPipelineDesc: Opaque, primitiveType: PrimitiveType): void;
// A geometry shader between the vertex (or domain) shader and the rasterizer.
declare function Donut_GraphicsPipelineSetGeometryShader(graphicsPipelineDesc: Opaque, geometryShader: Opaque): void;
// Hull and domain shaders, drawing patches of controlPoints vertices.
declare function Donut_GraphicsPipelineSetTessellation(graphicsPipelineDesc: Opaque, hullShader: Opaque, domainShader: Opaque,
    controlPoints: int): void;
declare function Donut_GraphicsPipelineSetDepthState(graphicsPipelineDesc: Opaque, testEnable: int, writeEnable: int,
    depthFunc: ComparisonFunc): void;
// The depth bounds test: pixels whose depth target value is outside the draw's bounds
// (Donut_DrawSetDepthBounds) are discarded (requires Donut_HasDepthBoundsTest).
declare function Donut_GraphicsPipelineSetDepthBoundsTest(graphicsPipelineDesc: Opaque, enable: int): void;
declare function Donut_GraphicsPipelineSetRasterState(graphicsPipelineDesc: Opaque, cullMode: CullMode, fillMode: FillMode,
    frontCounterClockwise: int): void;
// Primitives clipped at the near and far planes (as Vulkan by default), or not (the default here:
// on D3D what lies beyond them is drawn, its depth clamped).
declare function Donut_GraphicsPipelineSetDepthClip(graphicsPipelineDesc: Opaque, enable: int): void;
// depthBias units of the depth format's resolution plus slopeScaledDepthBias times the depth
// slope, clamped to depthBiasClamp in magnitude (0: no clamp).
declare function Donut_GraphicsPipelineSetDepthBias(graphicsPipelineDesc: Opaque, depthBias: int, depthBiasClamp: number,
    slopeScaledDepthBias: number): void;
// Blending of every color target.
declare function Donut_GraphicsPipelineSetBlendMode(graphicsPipelineDesc: Opaque, blendMode: BlendMode): void;
// Blending of every color target, on or off, by the blend factors and operations of the color and
// of the alpha; the color write mask stays.
declare function Donut_GraphicsPipelineSetBlendState(graphicsPipelineDesc: Opaque, enable: int, srcBlend: BlendFactor,
    destBlend: BlendFactor, blendOp: BlendOp, srcBlendAlpha: BlendFactor, destBlendAlpha: BlendFactor, blendOpAlpha: BlendOp): void;
// An advanced blend operation for the targets that blend, instead of their factors and operations
// (Vulkan, with Donut_GetAdvancedBlendOperations): its number from VK_BLEND_OP_ZERO_EXT (0 Zero ...
// 45 Blue, -1 for none), whether the source and destination colors are premultiplied by their
// alpha, and how they overlap (0 uncorrelated, 1 disjoint, 2 conjoint).
declare function Donut_GraphicsPipelineSetAdvancedBlendOp(graphicsPipelineDesc: Opaque, advancedBlendOp: int,
    srcPremultiplied: int, dstPremultiplied: int, overlap: int): void;
// A logic operation between the pixel shader's output and the targets' bits instead of blending
// (requires Donut_HasLogicOps; UINT and UNORM targets).
declare function Donut_GraphicsPipelineSetLogicOp(graphicsPipelineDesc: Opaque, enable: int, logicOp: LogicOp): void;
// Conservative rasterization (requires Feature.ConservativeRasterization): every pixel a triangle
// touches is drawn; extraOverestimation enlarges triangles further, in pixels, on Vulkan only
// (clamped to the device's maximum).
declare function Donut_GraphicsPipelineSetConservativeRaster(graphicsPipelineDesc: Opaque, enable: int, extraOverestimation: number): void;
// Primitive restart: strips restart at the largest index of indexFormat (R16_UINT: 0xFFFF, R32_UINT:
// 0xFFFFFFFF; UNKNOWN for none), the format of the index buffers the pipeline draws with (D3D12
// needs it; D3D11 always restarts strips).
declare function Donut_GraphicsPipelineSetPrimitiveRestart(graphicsPipelineDesc: Opaque, indexFormat: Format): void;
// How lines are drawn: their rasterization mode (one Donut_GetLineRasterizationModes has), width (up to
// Donut_GetMaxLineWidth) and stipple (stippleEnable non-zero, with the mode's stippled bit: each bit
// of the 16-bit pattern, from the lowest, a run of stippleFactor pixels drawn if set). D3D has no
// width or stipple.
declare function Donut_GraphicsPipelineSetLineRasterization(graphicsPipelineDesc: Opaque, mode: LineRasterizationMode,
    width: number, stippleEnable: int, stippleFactor: int, stipplePattern: int): void;
// The channels every color target writes (ColorMask bits; None for a pass that only writes UAVs).
declare function Donut_GraphicsPipelineSetColorWriteMask(graphicsPipelineDesc: Opaque, mask: ColorMask): void;
// The channels one render target (SV_Target<target>) is written in (0 writes nothing to it).
declare function Donut_GraphicsPipelineSetTargetColorWriteMask(graphicsPipelineDesc: Opaque, target: int, mask: ColorMask): void;
// For a framebuffer's layout.
declare function Donut_CreateGraphicsPipelineFromDesc(app: Opaque, graphicsPipelineDesc: Opaque, framebuffer: Opaque): Opaque;
// Same, for the frame's framebuffer (the back buffer's layout).
declare function Donut_CreateGraphicsPipelineFromDescForFrame(app: Opaque, graphicsPipelineDesc: Opaque, frame: Opaque): Opaque;
// A meshlet pipeline from a Donut_CreateMeshletPipelineDesc description, for a framebuffer's layout,
// or the frame's; requires Feature.Meshlets.
declare function Donut_CreateMeshletPipelineFromDesc(app: Opaque, graphicsPipelineDesc: Opaque, framebuffer: Opaque): Opaque;
declare function Donut_CreateMeshletPipelineFromDescForFrame(app: Opaque, graphicsPipelineDesc: Opaque, frame: Opaque): Opaque;
// Vertex / index buffers uploaded once by an open command list (data copied during the call).
declare function Donut_CreateStaticVertexBuffer(app: Opaque, commandList: Opaque, data: Opaque, byteSize: int, debugName: string): Opaque;
// A vertex buffer to write (Donut_WriteBuffer) as often as needed, e.g. per frame.
declare function Donut_CreateDynamicVertexBuffer(app: Opaque, byteSize: int, debugName: string): Opaque;
declare function Donut_CreateStaticIndexBuffer(app: Opaque, commandList: Opaque, data: Opaque, byteSize: int, debugName: string): Opaque;
// A static vertex buffer (or index buffer if isIndexBuffer != 0) that shaders also read as a
// ByteAddressBuffer and acceleration structure builds take as input (Donut_AddTriangleBlasGeometry):
// one copy of a mesh for rasterization and ray tracing.
declare function Donut_CreateStaticGeometryBuffer(app: Opaque, commandList: Opaque, data: Opaque, byteSize: int,
    isIndexBuffer: int, debugName: string): Opaque;
// A static vertex buffer that shaders can also read as a ByteAddressBuffer.
declare function Donut_CreateStaticRawVertexBuffer(app: Opaque, commandList: Opaque, data: Opaque, byteSize: int, debugName: string): Opaque;
// The arguments of `count` indexed indirect draws (20 bytes each: index count, instance count,
// first index, vertex offset, first instance), filled with Donut_WriteBuffer, that shaders can
// also write as a RWByteAddressBuffer.
declare function Donut_CreateDrawIndexedIndirectBuffer(app: Opaque, count: int, debugName: string): Opaque;
// A buffer's GPU address (8 bytes; its device address on Vulkan) into dst (Ref of a `let` array
// element), for shaders that write it through the address; 0 if it has none.
declare function Donut_StoreBufferDeviceAddress(dst: Opaque, buffer: Opaque): void;
// Before a dispatch whose shaders write a buffer through its device address (NVRHI can't see
// that): marks it as written by shaders, so that its next use waits for the writes.
declare function Donut_SetBufferWrittenByShaders(commandList: Opaque, buffer: Opaque): void;
// The first primitive of a glTF file's first mesh (path relative to the executable's directory), as
// the Vulkan-Samples framework loads it: float3 position, float3 normal and float2 texture
// coordinates interleaved (32 bytes), R32_UINT indices, the nodes' transforms ignored. Uploaded by
// an open command list. Null (after logging why) on failure.
declare function Donut_LoadGltfMesh(app: Opaque, commandList: Opaque, path: string): Opaque;
// Valid as long as the mesh.
declare function Donut_GetGltfMeshVertexBuffer(gltfMesh: Opaque): Opaque;
declare function Donut_GetGltfMeshIndexBuffer(gltfMesh: Opaque): Opaque;
declare function Donut_GetGltfMeshIndexCount(gltfMesh: Opaque): int;
// Every primitive of a glTF file's meshes (path relative to the executable's directory), in mesh
// and primitive order, as the Vulkan-Samples framework's scene loader reads them into submeshes:
// vertices as Donut_LoadGltfMesh's (in mesh space, the nodes' transforms ignored), int indices,
// and the base color image's URI ("" if none). Kept on the CPU. Null (after logging why) on failure.
declare function Donut_LoadGltfModel(app: Opaque, path: string): Opaque;
// A file read whole (path relative to the executable's directory), for TypeScript to parse: its
// size, and bytes [offset, offset + count) into dst, an int (0..255) each (0 past the end).
declare function Donut_LoadBinaryFile(app: Opaque, path: string): Opaque;
declare function Donut_GetBinaryFileSize(binaryFile: Opaque): int;
// The file's bytes, valid as long as the file (e.g. for Donut_TranscodeKtx2).
declare function Donut_GetBinaryFileData(binaryFile: Opaque): Opaque;
declare function Donut_CopyBinaryFileBytes(binaryFile: Opaque, offset: int, count: int, dst: Opaque): void;
// count little-endian 32-bit values from byte offset into dst (Ref of a `let` int array element)
// as ints; those past the end of the file as 0.
declare function Donut_CopyBinaryFileUInts(binaryFile: Opaque, offset: int, count: int, dst: Opaque): void;
// byteSize bytes of the file from fileOffset into a buffer at bufferOffset, copied during the call
// into an open command list (e.g. a model's vertices from the middle of its file).
declare function Donut_WriteBufferFromBinaryFile(binaryFile: Opaque, commandList: Opaque, buffer: Opaque, bufferOffset: int,
    fileOffset: int, byteSize: int): void;
// The usage counts of an opacity micromap array by a geometry's triangles
// (Donut_SetTriangleBlasGeometryOpacityMicromap) from the file's data: indexCount OMM indices
// (indexFormat R16_UINT or R32_UINT) at indexOffset, indexing descCount per-OMM descs at descOffset
// (as Donut_CreateOpacityMicromap takes them). Writes up to maxEntries entries of three ints (count,
// subdivision level, format) into dst (Ref of a `let` int array); returns how many there are.
declare function Donut_CountOpacityMicromapUsage(binaryFile: Opaque, indexOffset: int, indexCount: int, indexFormat: Format,
    descOffset: int, descCount: int, dst: Opaque, maxEntries: int): int;
// Writes byteSize bytes of data (Ref of a `let` array element, or a Donut data pointer) to a file
// (path as given: absolute, or relative to the current directory). 1 on success.
declare function Donut_WriteBinaryFile(path: string, data: Opaque, byteSize: int): int;
declare function Donut_GetGltfModelPrimitiveCount(gltfModel: Opaque): int;
declare function Donut_GetGltfModelVertexCount(gltfModel: Opaque, primitive: int): int;
declare function Donut_GetGltfModelIndexCount(gltfModel: Opaque, primitive: int): int;
// Into dst: Ref(arr[0]) of a `let` f32 array of 8 x the vertex count / int array of the index count.
declare function Donut_CopyGltfModelVertices(gltfModel: Opaque, primitive: int, dst: Opaque): void;
// A primitive's vertex attribute by its name in the file ("COLOR_0",
// "KHR_gaussian_splatting:ROTATION"...): its elements (0 if none), floats per element, and the
// floats themselves (normalized integers converted; count * components into dst).
declare function Donut_GetGltfModelAttributeCount(gltfModel: Opaque, primitive: int, name: string): int;
declare function Donut_GetGltfModelAttributeComponents(gltfModel: Opaque, primitive: int, name: string): int;
declare function Donut_CopyGltfModelAttribute(gltfModel: Opaque, primitive: int, name: string, dst: Opaque): void;
declare function Donut_CopyGltfModelIndices(gltfModel: Opaque, primitive: int, dst: Opaque): void;
declare function Donut_GetGltfModelBaseColorImage(gltfModel: Opaque, primitive: int): string;
// The name of the primitive's mesh ("" if none).
// A primitive's material's base color factor (RGBA) into dst (Ref of a `let` f32 array of 4).
declare function Donut_CopyGltfModelBaseColorFactor(gltfModel: Opaque, primitive: int, dst: Opaque): void;
declare function Donut_GetGltfModelMeshName(gltfModel: Opaque, primitive: int): string;
// The index of the primitive's mesh, and its material's alpha mode.
declare function Donut_GetGltfModelPrimitiveMesh(gltfModel: Opaque, primitive: int): int;
declare function Donut_GetGltfModelPrimitiveAlphaMode(gltfModel: Opaque, primitive: int): AlphaMode;
// The nodes that instantiate meshes, in node order: their mesh, and their world transform (16
// floats, column-major as glm) into dst (Ref of a `let` f32 array element).
// A primitive's material's texture (0 base color, 1 normal, 2 metallic-roughness) as an index into
// the file's textures (-1 if none), and its metallic (0) or roughness (1) factor.
declare function Donut_GetGltfModelMaterialTexture(gltfModel: Opaque, primitive: int, which: int): int;
declare function Donut_GetGltfModelMaterialFactor(gltfModel: Opaque, primitive: int, which: int): number;
// The file's textures, and a texture's image URI ("" if none).
declare function Donut_GetGltfModelTextureCount(gltfModel: Opaque): int;
declare function Donut_GetGltfModelTextureImage(gltfModel: Opaque, texture: int): string;
declare function Donut_GetGltfModelNodeCount(gltfModel: Opaque): int;
declare function Donut_GetGltfModelNodeMesh(gltfModel: Opaque, node: int): int;
declare function Donut_CopyGltfModelNodeTransform(gltfModel: Opaque, node: int, dst: Opaque): void;
// Image file, path relative to the executable's directory, uploaded by an open command list.
// sRGB != 0 treats the data as sRGB. Null (after logging why) on failure.
declare function Donut_LoadTexture(app: Opaque, commandList: Opaque, path: string, sRGB: int): Opaque;
declare function Donut_GetCommonSampler(app: Opaque, which: CommonSampler): Opaque;
// SamplerComparisonState for depth textures: bilinear, clamped. Its comparison is "less" (NVRHI
// fixes it): SampleCmp returns the fraction of texels deeper than the reference.
declare function Donut_CreateComparisonSampler(app: Opaque): Opaque;
// linearFilter / linearMipFilter non-zero: linear filtering within / between levels (point
// otherwise); wrap non-zero: repeating (clamped otherwise).
declare function Donut_CreateSampler(app: Opaque, linearFilter: int, linearMipFilter: int, wrap: int): Opaque;
// A sampler by its whole description: linear (non-zero) or point filtering when minifying,
// magnifying and between levels; the address mode of all coordinates; a bias added to the level of
// detail, the range it's clamped to (maxLod 0: level 0 only), and anisotropic filtering up to
// maxAnisotropy samples (1: off; Donut_GetMaxSamplerAnisotropy).
declare function Donut_CreateSamplerWithDesc(app: Opaque, linearMin: int, linearMag: int, linearMip: int,
    addressMode: SamplerAddressMode, mipBias: number, minLod: number, maxLod: number, maxAnisotropy: number): Opaque;
// A sampler whose coordinates outside [0, 1] read a border color (r, g, b, a): linear (non-zero) or
// point filtering when minifying, magnifying and between levels, every level.
declare function Donut_CreateBorderSampler(app: Opaque, linearMin: int, linearMag: int, linearMip: int, r: number, g: number,
    b: number, a: number): Opaque;
// The most samples anisotropic filtering can take: Vulkan's maxSamplerAnisotropy with the
// samplerAnisotropy feature (1 without), 16 on D3D.
declare function Donut_GetMaxSamplerAnisotropy(app: Opaque): number;

// Built up with Donut_AddVertexAttribute, then consumed (freed) by Donut_CreateInputLayout.
declare function Donut_CreateInputLayoutDesc(): Opaque;
// Vertex shader input `name` (its semantic), read from vertex buffer slot bufferIndex at byte
// offset `offset` of each elementStride-byte element.
declare function Donut_AddVertexAttribute(inputLayoutDesc: Opaque, name: string, format: Format, offset: int, bufferIndex: int, elementStride: int): void;
// Same, read once per instance instead of once per vertex.
declare function Donut_AddInstanceVertexAttribute(inputLayoutDesc: Opaque, name: string, format: Format, offset: int, bufferIndex: int, elementStride: int): void;
declare function Donut_CreateInputLayout(app: Opaque, inputLayoutDesc: Opaque, vertexShader: Opaque): Opaque;

// Input for acceleration structure builds (index or vertex data).
declare function Donut_CreateAccelStructInputBuffer(app: Opaque, byteSize: int, debugName: string): Opaque;
// Same, that shaders also read as a ByteAddressBuffer (Donut_BindRawBufferSRV).
declare function Donut_CreateAccelStructInputRawBuffer(app: Opaque, byteSize: int, debugName: string): Opaque;
// Same, that shaders also read as a StructuredBuffer of count elements of stride bytes.
declare function Donut_CreateAccelStructInputStructuredBuffer(app: Opaque, stride: int, count: int, debugName: string): Opaque;
// RGBA8_UNORM texture of the frame's size that shaders write as RWTexture2D<float4>.
declare function Donut_CreateUAVTextureForFrame(app: Opaque, frame: Opaque, debugName: string): Opaque;
// Same, in another format.
declare function Donut_CreateUAVTextureForFrameWithFormat(app: Opaque, frame: Opaque, debugName: string, format: Format): Opaque;
// Same, in the back buffer's format without sRGB, for Donut_CopyTextureToFrame (a bit-for-bit copy).
declare function Donut_CreateUAVTextureForFrameCopy(app: Opaque, frame: Opaque, debugName: string): Opaque;

// Acceleration structures; both record their build into an open command list.
// Opaque triangles: R32_UINT indices, RGB32_FLOAT vertices.
declare function Donut_BuildTriangleBLAS(app: Opaque, commandList: Opaque, indexBuffer: Opaque, indexCount: int, vertexBuffer: Opaque, vertexCount: int): Opaque;
// One instance of bottomLevelAS: identity transform, mask 1, counter-clockwise front faces.
declare function Donut_BuildSingleInstanceTLAS(app: Opaque, commandList: Opaque, bottomLevelAS: Opaque): Opaque;
// One opaque triangle geometry: indexCount R32_UINT indices from indexByteOffset of indexBuffer,
// into vertexCount RGB32_FLOAT positions every vertexStride bytes from vertexByteOffset of
// vertexBuffer. Build recorded into an open command list, preferring fast tracing, or if
// updatable != 0 fast builds and updates.
declare function Donut_CreateTriangleBlas(app: Opaque, commandList: Opaque, indexBuffer: Opaque, indexByteOffset: int,
    indexCount: int, vertexBuffer: Opaque, vertexByteOffset: int, vertexCount: int, vertexStride: int, updatable: int,
    debugName: string): Opaque;
// An updatable one, in place, from its buffers' current contents, into an open command list.
declare function Donut_UpdateTriangleBlas(triangleBlas: Opaque, commandList: Opaque): void;
// A bottom-level acceleration structure of several geometries: add them with
// Donut_AddTriangleBlasGeometry, then build it with Donut_BuildTriangleBlas.
declare function Donut_CreateEmptyTriangleBlas(app: Opaque, debugName: string): Opaque;
// Opaque triangles: indexCount R32_UINT indices at indexByteOffset of indexBuffer, vertexCount
// RGB32_FLOAT positions vertexStride bytes apart at vertexByteOffset of vertexBuffer (acceleration
// structure input buffers), transformed by transform (12 floats, 3 rows of 4) or not (null).
declare function Donut_AddTriangleBlasGeometry(triangleBlas: Opaque, indexBuffer: Opaque, indexByteOffset: int, indexCount: int,
    vertexBuffer: Opaque, vertexByteOffset: int, vertexCount: int, vertexStride: int, transform: Opaque | null): void;
// Opaque procedural primitives instead: aabbCount boxes (6 floats each, min x y z then max x y z),
// aabbStride bytes apart at byteOffset of aabbBuffer (an acceleration structure input buffer),
// intersected by the hit groups' intersection shaders (Donut_RtPipelineAddProceduralHitGroup). A
// BLAS holds triangles or AABBs, not both.
declare function Donut_AddTriangleBlasAabbGeometry(triangleBlas: Opaque, aabbBuffer: Opaque, byteOffset: int, aabbCount: int,
    aabbStride: int): void;
// An unbuilt BLAS's geometryIndex-th geometry's nvrhi::rt::GeometryFlags (1 opaque, the default; 0
// for any-hit shaders to run on it; 2 no duplicate any-hit invocations).
declare function Donut_SetTriangleBlasGeometryFlags(triangleBlas: Opaque, geometryIndex: int, flags: int): void;
// Links an unbuilt BLAS's geometryIndex-th triangle geometry to an opacity micromap array
// (Donut_CreateOpacityMicromap): an OMM index per triangle, ommIndexFormat (R16_UINT or R32_UINT)
// values at ommIndexOffset of ommIndexBuffer (an acceleration structure input buffer; negative
// ones the special fully transparent / opaque indices); usageCounts (Ref of a `let` int array)
// holds numUsageCounts entries of three ints, how many triangles use OMMs of a subdivision level
// and format (Donut_CountOpacityMicromapUsage; Vulkan's builds need them). The BLAS keeps the array.
declare function Donut_SetTriangleBlasGeometryOpacityMicromap(triangleBlas: Opaque, geometryIndex: int, opacityMicromap: Opaque,
    ommIndexBuffer: Opaque, ommIndexOffset: int, ommIndexFormat: Format, usageCounts: Opaque, numUsageCounts: int): void;
// An opacity micromap array (requires Feature.RayTracingOpacityMicromap), built into an open
// command list from inputBuffer's raw OMM data at inputOffset and perOmmDescs' descs at
// descsOffset (acceleration structure input buffers; descs as D3D12_RAYTRACING_OPACITY_MICROMAP_DESC
// and VkMicromapTriangleEXT have them: 32-bit data offset, 16-bit subdivision level, 16-bit format);
// usageCounts (Ref of a `let` int array) holds numUsageCounts entries of three ints, how many OMMs
// the array has of a subdivision level and format (D3D12's histogram). buildFlags:
// nvrhi::rt::OpacityMicromapBuildFlags bits (1 fast trace, 2 fast build). Null on failure.
declare function Donut_CreateOpacityMicromap(app: Opaque, commandList: Opaque, inputBuffer: Opaque, inputOffset: int,
    perOmmDescs: Opaque, descsOffset: int, usageCounts: Opaque, numUsageCounts: int, buildFlags: int,
    debugName: string): Opaque | null;
// Builds such an array again, in place, from its inputs' current contents, into an open command list.
declare function Donut_BuildOpacityMicromap(commandList: Opaque, opacityMicromap: Opaque): void;
// Builds the BLAS of the geometries added (AccelStructBuildFlags bits), recorded into an open
// command list; 0 on failure.
declare function Donut_BuildTriangleBlas(triangleBlas: Opaque, app: Opaque, commandList: Opaque, buildFlags: AccelStructBuildFlags): int;
// Builds a built one again, in place (not an update), from its geometries' current contents, into
// an open command list.
declare function Donut_RebuildTriangleBlas(triangleBlas: Opaque, commandList: Opaque): void;
// For Donut_AddTopLevelASInstanceWithTransform; valid as long as the BLAS.
declare function Donut_GetTriangleBlasAccelStruct(triangleBlas: Opaque): Opaque;

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
// ByteAddressBuffer at t<slot> (e.g. Donut_CreateStaticRawVertexBuffer).
declare function Donut_BindRawBufferSRV(bindingSetDesc: Opaque, slot: int, buffer: Opaque): void;
// RWByteAddressBuffer at u<slot> (e.g. Donut_CreateDrawIndexedIndirectBuffer).
declare function Donut_BindRawBufferUAV(bindingSetDesc: Opaque, slot: int, buffer: Opaque): void;
// Element arrayElement of a Donut_LayoutTextureSRVArray array of Texture2D at t<slot>.
declare function Donut_BindTextureSRVArrayElement(bindingSetDesc: Opaque, slot: int, arrayElement: int, texture: Opaque): void;
// Push constants (Donut_LayoutPushConstants) at b<slot>; their values come with each dispatch or
// draw (Donut_DispatchWithPushConstants, Donut_DrawIndexedWithPushConstants).
declare function Donut_BindPushConstants(bindingSetDesc: Opaque, slot: int, byteSize: int): void;
// Texture2D at t<slot>.
declare function Donut_BindTextureSRV(bindingSetDesc: Opaque, slot: int, texture: Opaque): void;
// Same, one level of the texture only.
declare function Donut_BindTextureSRVMip(bindingSetDesc: Opaque, slot: int, texture: Opaque, mipLevel: int): void;
// Same, mipCount levels from firstMip on: the shader's level 0 is firstMip (SampleLevel(..., n)
// reads level firstMip + n, Load and Gather firstMip).
declare function Donut_BindTextureSRVMips(bindingSetDesc: Opaque, slot: int, texture: Opaque, firstMip: int, mipCount: int): void;
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
declare function Donut_LayoutRawBufferSRV(bindingLayoutDesc: Opaque, slot: int): void;
declare function Donut_LayoutRawBufferUAV(bindingLayoutDesc: Opaque, slot: int): void;
// An array of `count` Texture2D at t<slot> (t<slot> .. t<slot + count - 1> on D3D12, one binding on
// Vulkan); not on D3D11.
declare function Donut_LayoutTextureSRVArray(bindingLayoutDesc: Opaque, slot: int, count: int): void;
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
// Procedural primitive hit group, for AABB geometries (Donut_AddTriangleBlasAabbGeometry): its
// intersection shader by entry name, then closest-hit / any-hit shaders as above ("" for none).
declare function Donut_RtPipelineAddProceduralHitGroup(pipelineDesc: Opaque, shaderLibrary: Opaque, exportName: string,
    intersectionEntry: string, closestHitEntry: string, anyHitEntry: string, localBindingLayout: Opaque | null): void;
// The largest hit attributes the pipeline's shaders pass (ReportHit's attributes; the default is 8
// bytes, the triangles' barycentrics). D3D12 only: Vulkan takes it from the shaders.
declare function Donut_RtPipelineSetMaxAttributeSize(pipelineDesc: Opaque, byteSize: int): void;
// Whether the pipeline's rays see the opacity micromaps of the BLASes they trace (off by default).
declare function Donut_RtPipelineSetAllowOpacityMicromaps(pipelineDesc: Opaque, allow: int): void;
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
// A descriptor table of a bindless layout without a manager: room for `capacity` descriptors in
// each of its arrays, written slot by slot with Donut_WriteDescriptorTableTexture.
declare function Donut_CreateDescriptorTable(app: Opaque, bindlessLayout: Opaque, capacity: int): Opaque;
// Writes a texture's descriptor into slot `slot` of a descriptor table's Texture2D array, at once
// (also into a table bound by command lists still recording or running: the bindless layouts are
// update-after-bind on Vulkan). 0 if the slot is past the table's capacity.
declare function Donut_WriteDescriptorTableTexture(app: Opaque, descriptorTable: Opaque, slot: int, texture: Opaque): int;
// A C++ std::default_random_engine (std::mt19937 with MSVC's library), for data that samples make
// with one: the same seed gives the same numbers; a negative seed takes one from std::random_device
// (different every run).
declare function Donut_CreateRandomEngine(app: Opaque, seed: int): Opaque;
// The engine's next number from std::uniform_real_distribution<float>(a, b).
declare function Donut_RandomUniformFloat(randomEngine: Opaque, a: number, b: number): number;
// The engine's next number from std::uniform_int_distribution<int>(a, b).
declare function Donut_RandomUniformInt(randomEngine: Opaque, a: int, b: int): int;
// count numbers from one std::normal_distribution<float>(mean, stddev) over the engine, into dst
// (Ref of a `let` f32 array element): one distribution object, as the samples keep one (MSVC's makes
// values in pairs and keeps the second).
declare function Donut_RandomNormalFloats(randomEngine: Opaque, mean: number, stddev: number, count: int, dst: Opaque): void;
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
// Same, with the binding set (from the loop's layout) to write it with: its UAV at u0, the push
// constants at b0 and anything else the shader reads, instead of the loop's own set of those two.
declare function Donut_AddAsyncComputeTextureWithBindingSet(asyncComputeLoop: Opaque, texture: Opaque, bindingSet: Opaque): void;
// The push constants of the runs from now on, instead of the run index: byteSize bytes from data
// (Ref of a `let` array element), copied during the call; the layout's push constants' size.
declare function Donut_SetAsyncComputePushConstants(asyncComputeLoop: Opaque, data: Opaque, byteSize: int): void;
// Non-zero: no more runs start until resumed (one under way finishes).
declare function Donut_SetAsyncComputeLoopPaused(asyncComputeLoop: Opaque, paused: int): void;
// Runs submitted so far.
declare function Donut_GetAsyncComputeRunCount(asyncComputeLoop: Opaque): int;
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
// Draws vertexCount vertices (no vertex buffers: e.g. a triangle over the target from SV_VertexID)
// with a graphics pipeline into all of a framebuffer, with one binding set (null for none): for
// drawing outside the frames, e.g. into a texture's levels at load time.
declare function Donut_CommandListDraw(commandList: Opaque, pipeline: Opaque, framebuffer: Opaque, bindingSet: Opaque | null,
    vertexCount: int): void;
// A command list for the compute queue (needs AppOptions.ComputeQueue), recorded each frame and
// run with Donut_ExecuteFrameComputeWork; null if there's no compute queue.
declare function Donut_CreateComputeQueueCommandList(app: Opaque): Opaque | null;
// Blocks until the GPU has finished all submitted work.
declare function Donut_WaitForIdle(app: Opaque): void;
// Uploads byteSize bytes from data, copied during the call. Pass `Ref(array[0])` of a `let`
// int[] / f32[] array.
declare function Donut_WriteBuffer(commandList: Opaque, buffer: Opaque, data: Opaque, byteSize: int): void;
// Same, at byteOffset of a non-volatile buffer (e.g. a constant buffer's uints after its floats;
// D3D11 drops partial constant buffer writes).
declare function Donut_WriteBufferAt(commandList: Opaque, buffer: Opaque, byteOffset: int, data: Opaque, byteSize: int): void;
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
// Fills a color texture (Donut_CreateRenderTargetTexture) with r, g, b, a.
declare function Donut_ClearTextureFloat(commandList: Opaque, texture: Opaque, r: number, g: number, b: number, a: number): void;
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
// Draws the UI into framebuffer (e.g. an HDR scene's, Donut_CreateFramebuffer) instead of the back
// buffer; null: the back buffer again. Passes added after the ImGui pass draw after it (e.g. one
// that takes that framebuffer's texture to the back buffer).
declare function Donut_SetImGuiPassFramebuffer(imguiPass: Opaque, framebuffer: Opaque | null): void;
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
// Shown selected when active is non-zero; non-zero if clicked.
declare function Donut_ImGuiRadioButton(label: string, active: int): int;
// 4 floats (RGBA) at values (Ref of a `let` f32 array element), width pixels wide (0: default);
// non-zero if changed.
declare function Donut_ImGuiColorEdit4(label: string, values: Opaque, width: number): int;
// A color picker of 3 floats (Ref of a `let` f32 array; RGB, unbounded) without previews; non-zero
// when changed.
declare function Donut_ImGuiColorPicker3(label: string, values: Opaque, width: number): int;
// Scopes the IDs of the widgets that follow (same labels apart) until Donut_ImGuiPopID.
declare function Donut_ImGuiPushID(id: int): void;
declare function Donut_ImGuiPopID(): void;
declare function Donut_ImGuiEndCombo(): void;
// 3 floats at values (Ref of a `let` f32 array element); non-zero if changed.
declare function Donut_ImGuiDragFloat3(label: string, values: Opaque, speed: number): int;
// Places the next window with its pivot (0..1 of its size; 1, 0 = top right corner) at x, y.
declare function Donut_ImGuiSetNextWindowPosPivot(x: number, y: number, pivotX: number, pivotY: number): void;
// Value in, new value out.
declare function Donut_ImGuiSliderFloat(label: string, value: number, min: number, max: number): number;
// Keyboard navigation of the ImGui windows (Tab, arrows, Enter or Space, Escape); after
// Donut_AddImGuiPass. ImGui then takes the keyboard while one of its windows has the focus.
declare function Donut_ImGuiSetKeyboardNavigation(enable: int): void;
// Value in, new value out.
declare function Donut_ImGuiSliderInt(label: string, value: int, min: int, max: int): int;
// The next item on this line, offsetFromStartX pixels from the window's left (0: right after the
// previous item).
declare function Donut_ImGuiSameLineAt(offsetFromStartX: number): void;
// The text color of the items that follow, until Donut_ImGuiPopStyleColor.
declare function Donut_ImGuiPushTextColor(r: number, g: number, b: number, a: number): void;
declare function Donut_ImGuiPopStyleColor(): void;
// A window drawn over the scene at (x, y), width x height: no title bar, background or scrollbars,
// not movable, ignoring the mouse (an overlay graph). Pair with Donut_ImGuiEnd.
declare function Donut_ImGuiBeginOverlay(title: string, x: number, y: number, width: number, height: number): void;
// count values (Ref of a `let` f32 array element) as a line graph, starting at valuesOffset
// (wrapping around), scaleMin at the bottom and scaleMax at the top, width x height pixels;
// frameBackground 0: without the frame's background.
declare function Donut_ImGuiPlotLines(label: string, values: Opaque, count: int, valuesOffset: int, scaleMin: number,
    scaleMax: number, width: number, height: number, frameBackground: int): void;
// Value in, new value out: edited by dragging (speed per pixel), clamped to min .. max.
declare function Donut_ImGuiDragFloat(label: string, value: number, speed: number, min: number, max: number): number;
// A number field with - and + buttons stepping it by step, shown with a printf format ("%.3f");
// returns the new value.
declare function Donut_ImGuiInputFloat(label: string, value: number, step: number, format: string): number;
// Non-zero while expanded.
declare function Donut_ImGuiCollapsingHeader(label: string): int;
// Same, expanded until the user collapses it.
declare function Donut_ImGuiCollapsingHeaderDefaultOpen(label: string): int;
declare function Donut_ImGuiSameLine(): void;
// Ends the line: the next item starts on a new one (after Donut_ImGuiSameLine, an empty line).
declare function Donut_ImGuiNewLine(): void;
// A scrolling region of width x height pixels (0: the rest of the window); end it with
// Donut_ImGuiEndChild whatever this returns.
declare function Donut_ImGuiBeginChild(id: string, width: number, height: number, border: int): int;
declare function Donut_ImGuiEndChild(): void;
// Inside a combo box, after the selected item: scrolls to it when the list opens.
declare function Donut_ImGuiSetItemDefaultFocus(): void;
declare function Donut_ImGuiGetFontSize(): number;
// A TrueType font (path relative to the executable's directory) at a size in pixels; call right
// after Donut_AddImGuiPass (imguiPass is what it returned). Null if the file can't be read.
declare function Donut_ImGuiCreateFont(imguiPass: Opaque, path: string, size: number): Opaque;
declare function Donut_ImGuiPushFont(font: Opaque): void;
declare function Donut_ImGuiPopFont(): void;
// Text at (x, y) in UI coordinates (its top-left corner, or with alignRight its top-right one) in
// the current font and color, behind the windows (no window needed).
declare function Donut_ImGuiDrawText(x: number, y: number, text: string, r: number, g: number, b: number, a: number, alignRight: int): void;
// A filled rectangle from (x0, y0) to (x1, y1) in UI coordinates, behind the windows, over what was
// drawn behind them before (e.g. a box for Donut_ImGuiDrawText's text to go on).
declare function Donut_ImGuiDrawRect(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, a: number): void;
// The width of a line of text in the current font, in UI coordinates.
declare function Donut_ImGuiCalcTextWidth(text: string): number;
// A borderless window over the whole screen, with text centered on it (may span lines).
declare function Donut_ImGuiBeginFullScreenWindow(imguiPass: Opaque): void;
declare function Donut_ImGuiDrawScreenCenteredText(imguiPass: Opaque, text: string): void;
declare function Donut_ImGuiEndFullScreenWindow(imguiPass: Opaque): void;
// Donut's material / light editor widgets, for a scene material / light; non-zero if it changed.
declare function Donut_ImGuiMaterialEditor(material: Opaque, allowDomainChanges: int): int;
declare function Donut_ImGuiLightEditor(light: Opaque): int;
// The system's open (open != 0) or save file dialog; filters as "BMP files|*.bmp|All files|*.*".
// The chosen path, or "" if cancelled; valid until the next call.
declare function Donut_FileDialog(open: int, filters: string): string;

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
// Orbits the target from the position.
declare function Donut_ThirdPersonCameraLookAt(camera: Opaque, posX: number, posY: number, posZ: number, targetX: number, targetY: number, targetZ: number): void;
// Every frame, after Donut_SetPlanarView of the view it renders.
declare function Donut_ThirdPersonCameraSetView(camera: Opaque, view: Opaque): void;
// Forward / up directions: 3 floats into dst (Ref of a `let` f32 array element).
declare function Donut_GetCameraDirection(camera: Opaque, dst: Opaque): void;
declare function Donut_GetCameraUp(camera: Opaque, dst: Opaque): void;
// Units per second.
declare function Donut_CameraSetMoveSpeed(camera: Opaque, speed: number): void;
// Mouse sensitivity, radians per pixel.
declare function Donut_CameraSetRotateSpeed(camera: Opaque, speed: number): void;
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
// Same, built with buildFlags (e.g. AllowUpdate, for Donut_UpdateTopLevelAS).
declare function Donut_CreateTopLevelASWithFlags(app: Opaque, maxInstances: int, buildFlags: AccelStructBuildFlags): Opaque;
// The scene's mesh instances (instance ID = instance index) with instanceMask, dynamicMesh's (if
// not null) with dynamicMeshMask.
declare function Donut_AddSceneTopLevelASInstances(sceneAccelStructs: Opaque, scene: Opaque, instanceMask: int,
    dynamicMesh: Opaque | null, dynamicMeshMask: int): void;
// A BLAS instance scaled by `scale`, then moved to (x, y, z).
declare function Donut_AddTopLevelASInstance(sceneAccelStructs: Opaque, bottomLevelAS: Opaque, instanceMask: int, instanceID: int,
    scale: number, x: number, y: number, z: number): void;
// A BLAS instance with a transform: Ref(arr[0]) of a `let` f32[12], a row-major 3x4 matrix with the
// translation in the last column (Vulkan's VkTransformMatrixKHR). flags: nvrhi::rt::InstanceFlags bits
// (1 = no triangle culling).
declare function Donut_AddTopLevelASInstanceWithTransform(sceneAccelStructs: Opaque, bottomLevelAS: Opaque, instanceMask: int,
    instanceID: int, flags: int, transform: Opaque): void;
// Same, with the instance's hit group index offset (instanceContributionToHitGroupIndex): which of
// the shader table's hit groups its hits run.
declare function Donut_AddTopLevelASInstanceWithHitGroup(sceneAccelStructs: Opaque, bottomLevelAS: Opaque, instanceMask: int,
    instanceID: int, hitGroupIndex: int, flags: int, transform: Opaque): void;
// Valid only inside a render callback.
declare function Donut_BuildTopLevelAS(frame: Opaque, sceneAccelStructs: Opaque): void;
// Valid only inside a render callback: refits the TLAS in place to the instances added since the
// last build (new transforms, same instance count) instead of building it anew. Needs an AllowUpdate
// TLAS; builds it instead the first time or when the instance count changed. 1 if it refitted.
declare function Donut_UpdateTopLevelAS(frame: Opaque, sceneAccelStructs: Opaque): int;

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
// The fragment sizes (shading rates) the device has, as width, height pairs into dst (Ref of a
// `let` int array of 32), largest first (Vulkan's order; D3D12's tier rates); returns their count,
// 0 without variable rate shading.
declare function Donut_GetFragmentShadingRates(app: Opaque, dst: Opaque): int;
// Variable rate shading in a pipeline: its draws take the draw state's shading rate
// (Donut_DrawSetVariableRateShading) combined with the framebuffer's shading rate surface.
declare function Donut_GraphicsPipelineSetVariableRateShading(graphicsPipelineDesc: Opaque, enabled: int): void;
// The draw state's shading rate (after Donut_BeginDraw*): the per-draw rate, combined with the
// primitives' by primitiveCombiner, then with the framebuffer's shading rate surface by
// imageCombiner (Passthrough keeps the rate so far, Override takes the new one).
// The draw's depth bounds (after Donut_BeginDraw), for a pipeline with the depth bounds test: depth
// target values from minDepth to maxDepth pass (0 to 1 by default).
declare function Donut_DrawSetDepthBounds(frame: Opaque, minDepth: number, maxDepth: number): void;
declare function Donut_DrawSetVariableRateShading(frame: Opaque, enabled: int, shadingRate: VariableShadingRate,
    primitiveCombiner: ShadingRateCombiner, imageCombiner: ShadingRateCombiner): void;
// Framebuffer of one or two color targets (colorTexture1 null for one) and a depth buffer (null for
// none) whose draws can take their shading rates from shadingRateSurface (null for none).
declare function Donut_CreateFramebufferWithShadingRate(app: Opaque, colorTexture0: Opaque, colorTexture1: Opaque | null,
    depthTexture: Opaque | null, shadingRateSurface: Opaque | null): Opaque;
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
// A descriptor table (Donut_CreateDescriptorTable, Donut_GetDescriptorTable) for the draw, in the
// pipeline's binding layout order as Donut_DrawAddBindingSet.
declare function Donut_DrawAddDescriptorTable(frame: Opaque, descriptorTable: Opaque): void;
// R32_UINT indices.
declare function Donut_DrawSetIndexBuffer(frame: Opaque, indexBuffer: Opaque): void;
// R16_UINT indices.
declare function Donut_DrawSetIndexBuffer16(frame: Opaque, indexBuffer: Opaque): void;
// Binds a vertex buffer, from byteOffset, to an input layout slot.
declare function Donut_DrawAddVertexBuffer(frame: Opaque, vertexBuffer: Opaque, slot: int, byteOffset: int): void;
// Draws into this rectangle of the framebuffer (pixels) instead of all of it.
declare function Donut_DrawSetViewport(frame: Opaque, left: number, top: number, width: number, height: number): void;
// One more viewport (with its scissor rectangle) for the draw, after those set or added before:
// geometry shaders pick one per primitive (SV_ViewportArrayIndex).
declare function Donut_DrawAddViewport(frame: Opaque, left: number, top: number, width: number, height: number): void;
declare function Donut_DrawIndexed(frame: Opaque, indexCount: int): void;
// Same, instanceCount times (instance attributes advance per instance).
declare function Donut_DrawIndexedInstanced(frame: Opaque, indexCount: int, instanceCount: int): void;
// The buffer indirect draws read their arguments from (Donut_CreateDrawIndexedIndirectBuffer).
declare function Donut_DrawSetIndirectBuffer(frame: Opaque, indirectBuffer: Opaque): void;
// drawCount indexed draws, their arguments read from the indirect buffer from offsetBytes on (20
// bytes each); the draw described stays, so it can repeat with other offsets.
declare function Donut_DrawIndexedIndirect(frame: Opaque, offsetBytes: int, drawCount: int): void;
// Same, with byteSize bytes of push constants from data (the binding set's Donut_BindPushConstants
// item); the draw described stays, so it can repeat with other push constants.
declare function Donut_DrawIndexedWithPushConstants(frame: Opaque, indexCount: int, data: Opaque, byteSize: int): void;
// Values that decide whether draws happen (D3D12 predication, Vulkan conditional rendering): count
// of them, each 0 (skip) or not (draw), all 1 at first, in memory the CPU writes and the GPU reads
// when it executes the draws. Requires Donut_HasConditionalRendering. Null on failure.
declare function Donut_CreatePredicationBuffer(app: Opaque, count: int): Opaque | null;
declare function Donut_SetPredicationValue(predicationBuffer: Opaque, index: int, value: int): void;
// Binary occlusion queries whose results the GPU resolves into predication values (the CPU's
// Donut_SetPredicationValue's are the predication buffer's): count queries, every result 0
// (occluded) at first. D3D12's occlusion query heap and predication, Vulkan's occlusion query pool
// and conditional rendering (requires Donut_HasConditionalRendering). Null otherwise.
declare function Donut_CreateOcclusionPredication(app: Opaque, count: int): Opaque | null;
// Donut_DrawVertices inside occlusion query `index`: whether any of the vertices' samples pass the
// depth and stencil tests.
declare function Donut_DrawVerticesWithOcclusionQuery(frame: Opaque, vertexCount: int, occlusionPredication: Opaque, index: int): void;
// The queries' results into the predication values (1: samples passed; 0: none did) for the draws
// after it, e.g. the next frame's.
declare function Donut_ResolveOcclusionQueries(frame: Opaque, occlusionPredication: Opaque): void;
// Donut_DrawVertices, skipped if resolved result `index` is 0 when the GPU gets to it.
declare function Donut_DrawVerticesOcclusionPredicated(frame: Opaque, vertexCount: int, occlusionPredication: Opaque, index: int): void;
// Donut_DrawIndexedRangeWithPushConstants, drawn only if value `index` of the predication buffer
// isn't 0 when the GPU gets to it.
declare function Donut_DrawIndexedRangeWithPushConstantsPredicated(frame: Opaque, indexCount: int, startIndex: int, baseVertex: int,
    data: Opaque, byteSize: int, predicationBuffer: Opaque, index: int): void;
// Same, instanceCount times.
declare function Donut_DrawIndexedInstancedWithPushConstants(frame: Opaque, indexCount: int, instanceCount: int, data: Opaque, byteSize: int): void;
// Same, indexCount indices from startIndex of the index buffer, added to baseVertex.
declare function Donut_DrawIndexedRangeWithPushConstants(frame: Opaque, indexCount: int, startIndex: int, baseVertex: int,
    data: Opaque, byteSize: int): void;
// Same, without push constants.
declare function Donut_DrawIndexedRange(frame: Opaque, indexCount: int, startIndex: int, baseVertex: int): void;
// Copies a texture of the back buffer's size and a compatible format (e.g. RGBA8_UNORM) into the
// back buffer, as is.
declare function Donut_CopyTextureToFrame(frame: Opaque, texture: Opaque): void;
// Same, without an index buffer.
declare function Donut_DrawVertices(frame: Opaque, vertexCount: int): void;
// Same, with byteSize bytes of push constants from data (the binding set's Donut_BindPushConstants
// item); the draw described stays, so it can repeat with other push constants.
declare function Donut_DrawVerticesWithPushConstants(frame: Opaque, vertexCount: int, data: Opaque, byteSize: int): void;
// Executes what the frame's command list holds so far, and reopens it for the rest of the frame
// (e.g. so that copies out of a tiled texture run before Donut_ApplyTileMappings remaps it).
declare function Donut_SubmitFrameCommandList(app: Opaque, frame: Opaque): void;
// A mesh shader draw: begin with a meshlet pipeline (whole framebuffer by default), add binding sets
// (Donut_DrawAddBindingSet) and a viewport, then launch groupsX groups of its first shader
// (amplification, or mesh without one).
declare function Donut_BeginMeshDraw(frame: Opaque, meshletPipeline: Opaque): void;
declare function Donut_BeginMeshDrawToFramebuffer(frame: Opaque, meshletPipeline: Opaque, framebuffer: Opaque): void;
declare function Donut_DrawMeshTasks(frame: Opaque, groupsX: int): void;
// Same, groupsX x groupsY groups.
declare function Donut_DrawMeshTasks2D(frame: Opaque, groupsX: int, groupsY: int): void;
// Pipeline statistics of mesh shader draws (pixel, amplification and mesh shader invocations), read
// back a few frames late without waiting. Null when the device can't count mesh shader work (D3D11,
// D3D12 without MeshShaderPipelineStatsSupported, Vulkan without pipelineStatisticsQuery and
// meshShaderQueries).
declare function Donut_CreateMeshPipelineStatistics(app: Opaque): Opaque | null;
// Before the frame's first draw: reads back the results of the query the frame reuses.
declare function Donut_BeginMeshPipelineStatisticsFrame(frame: Opaque, meshPipelineStatistics: Opaque): void;
// Donut_DrawMeshTasks2D, counted by the frame's statistics.
declare function Donut_DrawMeshTasksWithStatistics(frame: Opaque, groupsX: int, groupsY: int, meshPipelineStatistics: Opaque): void;
// The latest results: which 0 for pixel, 1 for amplification (task), 2 for mesh shader invocations.
declare function Donut_GetMeshPipelineStatistic(meshPipelineStatistics: Opaque, which: int): number;
declare function Donut_GetFrameWidth(frame: Opaque): int;
declare function Donut_GetFrameHeight(frame: Opaque): int;

// Submits what the frame has recorded so far and goes on recording: work after it (e.g.
// Donut_ReadPixelUInts) sees the GPU results.
declare function Donut_FlushFrameCommandList(app: Opaque, frame: Opaque): void;
// Async compute: submits what the frame has recorded so far to the graphics queue, then a closed
// compute queue command list (Donut_CreateComputeQueueCommandList) that waits for it on the GPU,
// and goes on recording work that waits for the compute work.
declare function Donut_ExecuteFrameComputeWork(app: Opaque, frame: Opaque, commandList: Opaque): void;
// Saves the frame's color as recorded so far (BMP, PNG, JPG or TGA, by extension); non-zero on success.
declare function Donut_SaveFrameToFile(app: Opaque, frame: Opaque, path: string): int;

// --- Full renderer (Donut-Samples' feature_demo) ----------------------------------------------
// Functions taking a `view` accept a planar view (Donut_CreatePlanarView) or a stereo one
// (Donut_CreateStereoView) alike. They record into `commandList`: the frame's
// (Donut_GetFrameCommandList) or one opened with Donut_OpenCommandList. Framebuffer handles are
// valid as long as the object they came from.

// Values returned by Donut_UpdateSceneLoader.
enum SceneLoaderState {
    // No scene to render yet: draw a splash screen.
    Loading = 0,
    // The scene has just finished loading, this frame.
    Loaded = 1,
    Ready = 2
}

// LightType_* values (light_types.h).
enum LightType {
    Directional = 1,
    Spot = 2,
    Point = 3
}

// Textures of Donut_GetSceneRenderTargetsTexture.
enum SceneTexture {
    Depth = 0,
    HdrColor = 1,
    LdrColor = 2,
    MaterialIDs = 3,
    ResolvedColor = 4,
    AmbientOcclusion = 5,
    MotionVectors = 6
}

// Framebuffers of Donut_GetSceneRenderTargetsFramebuffer.
enum SceneFramebuffer {
    // G-buffer textures and depth.
    GBuffer = 0,
    // HDR color and depth.
    Forward = 1,
    Hdr = 2,
    Ldr = 3,
    Resolved = 4,
    // Material IDs and depth.
    MaterialIDs = 5
}

// donut::render::TemporalAntiAliasingJitter values.
enum TemporalJitter {
    MSAA = 0,
    Halton = 1,
    R2 = 2,
    WhiteNoise = 3
}

// The directory of the executable (of donut_interop.dll under the JIT), '/'-separated.
declare function Donut_GetExecutableDirectory(): string;
// Seconds per frame, averaged; 0 until measured.
declare function Donut_GetAverageFrameTime(app: Opaque): number;
declare function Donut_GetWindowWidth(app: Opaque): int;
declare function Donut_GetWindowHeight(app: Opaque): int;
// Drops the cached compiled shaders: passes created after this load them from disk again.
declare function Donut_ClearShaderCache(app: Opaque): void;
// Destroys resources the GPU has finished with; after Donut_WaitForIdle.
declare function Donut_RunGarbageCollection(app: Opaque): void;
// nvrhi::Format values 0 .. count-1, their names and nvrhi::FormatSupport bits.
declare function Donut_GetFormatCount(): int;
declare function Donut_GetFormatName(format: int): string;
declare function Donut_QueryFormatSupport(app: Opaque, format: int): int;

// Scene loading on a thread, as donut::app::ApplicationBase does it asynchronously.
declare function Donut_CreateSceneLoader(app: Opaque): Opaque;
// Non-zero once a scene has loaded, until the next Donut_BeginLoadingScene: unload what
// references it (the passes' binding caches) before starting another load.
declare function Donut_IsSceneLoaded(sceneLoader: Opaque): int;
// Non-zero while the loading thread runs.
declare function Donut_IsSceneLoading(sceneLoader: Opaque): int;
// Starts loading a scene (absolute path, or relative to the executable's directory), dropping
// the current one: its handle is invalid afterwards.
declare function Donut_BeginLoadingScene(sceneLoader: Opaque, path: string): void;
// In a render callback, every frame, first thing: uploads loaded textures and finishes the scene.
// Submits what the frame has recorded so far.
declare function Donut_UpdateSceneLoader(sceneLoader: Opaque, frame: Opaque): SceneLoaderState;
// The loaded scene, or null; valid until the next Donut_BeginLoadingScene.
declare function Donut_GetLoadedScene(sceneLoader: Opaque): Opaque;
// 4 ints into dst: objects loaded, objects total, textures loaded, textures requested.
declare function Donut_GetSceneLoadingStats(sceneLoader: Opaque, dst: Opaque): void;
// The scene files (glTF, .scene.json) under a directory, recursively, as a string list.
declare function Donut_FindScenes(app: Opaque, directory: string): Opaque;
declare function Donut_GetStringListCount(stringList: Opaque): int;
declare function Donut_GetStringListItem(stringList: Opaque, index: int): string;

// Scene graph queries; the handles are valid as long as the scene.
declare function Donut_GetSceneGraphLightCount(sceneGraph: Opaque): int;
declare function Donut_GetSceneGraphLight(sceneGraph: Opaque, index: int): Opaque;
declare function Donut_GetLightType(light: Opaque): LightType;
declare function Donut_GetLightName(light: Opaque): string;
// Directional lights only.
declare function Donut_GetDirectionalLightIrradiance(light: Opaque): number;
declare function Donut_SetDirectionalLightIrradiance(light: Opaque, irradiance: number): void;
// The shadow map (Donut_CreateCascadedShadowMap) the light casts shadows with, or null for none.
declare function Donut_SetLightShadowMap(light: Opaque, shadowMap: Opaque | null): void;
declare function Donut_GetSceneGraphCameraCount(sceneGraph: Opaque): int;
declare function Donut_GetSceneGraphCamera(sceneGraph: Opaque, index: int): Opaque;
declare function Donut_GetSceneCameraName(sceneCamera: Opaque): string;
// 16 floats into dst (row-major, row-vector convention).
declare function Donut_GetSceneCameraWorldToView(sceneCamera: Opaque, dst: Opaque): void;
declare function Donut_GetSceneCameraViewToWorld(sceneCamera: Opaque, dst: Opaque): void;
// Of a perspective camera (radians); negative for other cameras.
declare function Donut_GetSceneCameraVerticalFov(sceneCamera: Opaque): number;
declare function Donut_GetSceneCameraZNear(sceneCamera: Opaque): number;
// World-space bounds as 6 floats into dst: min x, y, z, max x, y, z.
declare function Donut_GetNodeBoundingBox(node: Opaque, dst: Opaque): void;
// Like "/Sponza/Mesh_12"; valid until the next call.
declare function Donut_GetNodePath(node: Opaque): string;
// Makes the scene re-sort the node's content (e.g. after a material changes domain).
declare function Donut_InvalidateNodeContent(node: Opaque): void;
declare function Donut_GetSceneGraphMaterialCount(sceneGraph: Opaque): int;
declare function Donut_GetSceneGraphMaterial(sceneGraph: Opaque, index: int): Opaque;
declare function Donut_GetMaterialID(material: Opaque): int;
declare function Donut_GetMaterialName(material: Opaque): string;
// A donut::engine::MaterialDomain value.
declare function Donut_GetMaterialDomain(material: Opaque): int;
declare function Donut_SetMaterialDirty(material: Opaque, dirty: int): void;
declare function Donut_GetSceneGraphMeshInstanceCount(sceneGraph: Opaque): int;
// The instance index (what material ID passes write) and node of the index-th mesh instance.
declare function Donut_GetMeshInstanceIndex(sceneGraph: Opaque, index: int): int;
declare function Donut_GetMeshInstanceNode(sceneGraph: Opaque, index: int): Opaque;

// Views.
declare function Donut_CreateStereoView(app: Opaque): Opaque;
// Donut_SetPlanarView with a sub-pixel projection jitter, in pixels.
declare function Donut_SetPlanarViewJittered(view: Opaque, viewMatrix: Opaque, projMatrix: Opaque, width: int, height: int, pixelOffsetX: number, pixelOffsetY: number): void;
// Left eye in the left half of width x height pixels, right eye in the right half.
declare function Donut_SetStereoView(view: Opaque, leftViewMatrix: Opaque, rightViewMatrix: Opaque, projMatrix: Opaque, width: int, height: int, pixelOffsetX: number, pixelOffsetY: number): void;
declare function Donut_CopyStereoView(dstView: Opaque, srcView: Opaque): void;
// The left eye's planar view, e.g. for Donut_ThirdPersonCameraSetView.
declare function Donut_GetStereoLeftView(view: Opaque): Opaque;
// First person cameras only.
declare function Donut_CameraLookAtWithUp(camera: Opaque, posX: number, posY: number, posZ: number, targetX: number, targetY: number, targetZ: number, upX: number, upY: number, upZ: number): void;
// 3 floats into dst.
declare function Donut_GetCameraPosition(camera: Opaque, dst: Opaque): void;

// Render targets of width x height (multisampled with sampleCount > 1): the G-buffer with motion
// vectors and reverse-Z depth, HDR color, material IDs, resolved color, TAA feedback, LDR color,
// ambient occlusion. Create new ones when the size or sample count changes.
declare function Donut_CreateSceneRenderTargets(app: Opaque, width: int, height: int, sampleCount: int): Opaque;
declare function Donut_ClearSceneRenderTargets(commandList: Opaque, sceneRenderTargets: Opaque): void;
declare function Donut_GetSceneRenderTargetsTexture(sceneRenderTargets: Opaque, which: SceneTexture): Opaque;
declare function Donut_GetSceneRenderTargetsFramebuffer(sceneRenderTargets: Opaque, which: SceneFramebuffer): Opaque;
// Resolves a multisampled texture's mip 0 / slice 0 into a single-sample one.
declare function Donut_ResolveTexture(commandList: Opaque, dstTexture: Opaque, srcTexture: Opaque): void;
declare function Donut_ClearTextureUInt(commandList: Opaque, texture: Opaque, value: int): void;

// Multisampling.
// The sample counts that a color target in colorFormat and a depth buffer in depthFormat can both
// have, as bits (bit n for n samples: 0x1 | 0x2 | 0x4 ...): on Vulkan the device's
// framebufferColorSampleCounts & framebufferDepthSampleCounts, on D3D the formats' quality levels.
declare function Donut_GetSupportedSampleCounts(app: Opaque, colorFormat: Format, depthFormat: Format): int;
// Non-zero if render passes resolve multisampled targets as they end (Vulkan's dynamic rendering;
// Donut_CreateResolveFramebuffer). NVRHI runs D3D without render passes: use Donut_ResolveTexture.
declare function Donut_HasRenderPassResolve(app: Opaque): int;
// The ResolveModes render passes can resolve depth by, as bits 1 << mode (Vulkan's
// supportedDepthResolveModes); 0 without render pass resolves.
declare function Donut_GetDepthResolveModes(app: Opaque): int;
// Render target (color format) or depth buffer (depth format, cleared to clearDepth) of width x
// height with sampleCount samples (Texture2DMS when more than 1) that shaders can read and that can
// be resolved; resting at ShaderResource. Null on failure.
declare function Donut_CreateMultisampledTexture(app: Opaque, width: int, height: int, format: Format, sampleCount: int,
    clearDepth: number, debugName: string): Opaque;
// Framebuffer drawing into colorTexture and depthTexture (null for none) whose render passes, as
// they end, resolve color into colorResolveTexture and depth into depthResolveTexture by
// depthResolveMode, where those aren't null. Needs Donut_HasRenderPassResolve; NVRHI ends a render
// pass at every barrier, so a pass may resolve more than once (with the same result).
declare function Donut_CreateResolveFramebuffer(app: Opaque, colorTexture: Opaque | null, colorResolveTexture: Opaque | null,
    depthTexture: Opaque | null, depthResolveTexture: Opaque | null, depthResolveMode: ResolveMode): Opaque;
// The swap chain's back buffers (valid until they're resized: recreate what refers to them in the
// back buffer resizing callback), the one the current frame renders into, and their format
// (SRGBA8_UNORM with D3D, SBGRA8_UNORM with Vulkan).
declare function Donut_GetBackBufferCount(app: Opaque): int;
declare function Donut_GetBackBuffer(app: Opaque, index: int): Opaque;
declare function Donut_GetCurrentBackBufferIndex(app: Opaque): int;
declare function Donut_GetBackBufferFormat(app: Opaque): Format;
declare function Donut_GetSwapChainColorSpace(app: Opaque): SwapChainColorSpace;
// A texture another D3D11 device writes and this one's shaders read (e.g. Media Foundation's video
// frames: Donut_TransferVideoFrame): a render target shared through an NT handle (on D3D12 with
// simultaneous access), resting at ShaderResource. D3D12 and D3D11 only (Windows): null with other
// APIs, and (after logging why) on failure.
declare function Donut_CreateSharedTexture(app: Opaque, width: int, height: int, format: Format, debugName: string): Opaque | null;
// Its texture (valid as long as it) and NT handle.
declare function Donut_GetSharedTexture(sharedTexture: Opaque): Opaque;
declare function Donut_GetSharedTextureHandle(sharedTexture: Opaque): Opaque;
// The LUID of the device's adapter into dst (Ref of a `let` int array of 2: low, high part), e.g. to
// make another API's device on the same GPU. 0 if the API doesn't give it.
declare function Donut_GetAdapterLuid(app: Opaque, dst: Opaque): int;
// Asks for another color space of the back buffers, from the next frame on (as a resize: back
// buffer resizing callbacks run). 0 (nothing changes) if the swap chain can't present it.
declare function Donut_SetSwapChainColorSpace(app: Opaque, colorSpace: SwapChainColorSpace): int;
// Non-zero if the display the window is mostly on is in HDR mode (Windows' HDR on: an HDR10
// output), as the ATG samples' UpdateColorSpace finds it; 0 elsewhere than on Windows.
declare function Donut_IsDisplayHdr(app: Opaque): int;

// Shadows.
declare function Donut_CreateCascadedShadowMap(app: Opaque, resolution: int, numCascades: int): Opaque;
// One array slice per cascade.
declare function Donut_GetShadowMapTexture(shadowMap: Opaque): Opaque;
// Fits the cascades to a directional light and the view, out to maxShadowDistance (stable).
declare function Donut_SetupShadowMapForView(shadowMap: Opaque, light: Opaque, view: Opaque, maxShadowDistance: number, zRange: number, exponent: number): void;
declare function Donut_ClearShadowMap(commandList: Opaque, shadowMap: Opaque): void;
declare function Donut_CreateShadowDepthPass(app: Opaque, depthBias: int, slopeScaledDepthBias: number): Opaque;
declare function Donut_ResetDepthPassBindingCache(depthPass: Opaque): void;
// Opaque meshes into all cascades; materialEvents != 0: a GPU marker per material.
declare function Donut_RenderShadowDepth(commandList: Opaque, depthPass: Opaque, shadowMap: Opaque, sceneGraph: Opaque, materialEvents: int): void;

// Geometry passes.
// singlePassCubemap != 0 renders cube map views in one pass (Feature.FastGeometryShader).
declare function Donut_CreateForwardShadingPassWithOptions(app: Opaque, singlePassCubemap: int, trackLiveness: int): Opaque;
declare function Donut_ResetForwardShadingBindingCache(forwardShadingPass: Opaque): void;
// The lights a forward shading pass renders with, kept between its draws.
declare function Donut_CreateForwardShadingContext(app: Opaque): Opaque;
// A scene graph's lights, top / bottom ambient, and the enabled probes of a set (or null).
declare function Donut_PrepareForwardLights(commandList: Opaque, forwardShadingPass: Opaque, forwardShadingContext: Opaque, sceneGraph: Opaque, topR: number, topG: number, topB: number, bottomR: number, bottomG: number, bottomB: number, lightProbeSet: Opaque | null): void;
// Opaque (transparent == 0) or transparent meshes into a framebuffer; previousView may be null.
declare function Donut_RenderForward(commandList: Opaque, forwardShadingPass: Opaque, forwardShadingContext: Opaque, view: Opaque, previousView: Opaque | null, framebuffer: Opaque, sceneGraph: Opaque, transparent: int, name: string, materialEvents: int): void;
// enableMotionVectors != 0 writes motion vectors, and stencilWriteMask into the stencil there.
declare function Donut_CreateGBufferFillPassWithOptions(app: Opaque, enableMotionVectors: int, stencilWriteMask: int): Opaque;
declare function Donut_ResetGBufferFillBindingCache(gbufferFillPass: Opaque): void;
declare function Donut_RenderGBufferFill(commandList: Opaque, gbufferFillPass: Opaque, view: Opaque, previousView: Opaque, sceneRenderTargets: Opaque, sceneGraph: Opaque, materialEvents: int): void;
// Writes each pixel's material ID and instance index.
declare function Donut_CreateMaterialIDPass(app: Opaque, stencilWriteMask: int): Opaque;
declare function Donut_RenderMaterialIDs(commandList: Opaque, materialIdPass: Opaque, view: Opaque, previousView: Opaque, sceneRenderTargets: Opaque, sceneGraph: Opaque, transparent: int): void;
// Lights the G-buffer into HDR color; the targets' ambient occlusion if useAmbientOcclusion != 0,
// and a light probe set (or null).
declare function Donut_RenderDeferredLightingToHdr(commandList: Opaque, deferredLightingPass: Opaque, view: Opaque, sceneRenderTargets: Opaque, sceneGraph: Opaque, useAmbientOcclusion: int, topR: number, topG: number, topB: number, bottomR: number, bottomG: number, bottomB: number, lightProbeSet: Opaque | null): void;

// Post-processing and other passes.
// Single-sample targets only; renders with default parameters.
declare function Donut_CreateSsaoPass(app: Opaque, sceneRenderTargets: Opaque): Opaque;
declare function Donut_RenderSsao(commandList: Opaque, ssaoPass: Opaque, view: Opaque): void;
declare function Donut_CreateSkyPass(app: Opaque, framebuffer: Opaque, view: Opaque): Opaque;
// Around a directional light; other SkyParameters keep their defaults.
declare function Donut_RenderSky(commandList: Opaque, skyPass: Opaque, view: Opaque, light: Opaque, brightness: number, glowSize: number, glowSharpness: number, glowIntensity: number, horizonSize: number): void;
declare function Donut_CreateSceneTemporalAntiAliasingPass(app: Opaque, view: Opaque, sceneRenderTargets: Opaque, motionVectorStencilMask: int): Opaque;
declare function Donut_SetTemporalJitter(temporalAntiAliasingPass: Opaque, jitter: TemporalJitter): void;
// This frame's jitter, 2 floats into dst.
declare function Donut_GetTemporalPixelOffset(temporalAntiAliasingPass: Opaque, dst: Opaque): void;
declare function Donut_RenderViewMotionVectors(commandList: Opaque, temporalAntiAliasingPass: Opaque, view: Opaque, previousView: Opaque): void;
declare function Donut_TemporalResolveView(commandList: Opaque, temporalAntiAliasingPass: Opaque, view: Opaque, feedbackIsValid: int, enableHistoryClamping: int): void;
declare function Donut_AdvanceTemporalFrame(temporalAntiAliasingPass: Opaque): void;
// Pass the tone mapping pass this one replaces (or null) to keep its adapted exposure.
declare function Donut_CreateToneMappingPass(app: Opaque, framebuffer: Opaque, view: Opaque, previousToneMappingPass: Opaque | null): Opaque;
declare function Donut_AdvanceToneMappingFrame(toneMappingPass: Opaque, elapsedSeconds: number): void;
declare function Donut_ResetExposure(commandList: Opaque, toneMappingPass: Opaque, initialExposure: number): void;
// Default parameters; freezeEyeAdaptation != 0 keeps the current exposure.
declare function Donut_RenderToneMapping(commandList: Opaque, toneMappingPass: Opaque, view: Opaque, sourceTexture: Opaque, freezeEyeAdaptation: int): void;
declare function Donut_CreateBloomPass(app: Opaque, framebuffer: Opaque, view: Opaque): Opaque;
declare function Donut_RenderBloom(commandList: Opaque, bloomPass: Opaque, framebuffer: Opaque, view: Opaque, sourceTexture: Opaque, sigma: number, alpha: number): void;
// NVIDIA DLSS (loads nvngx_dlss.dll from the executable's directory); null when built without
// DONUT_WITH_DLSS or the device can't create it.
declare function Donut_CreateDlss(app: Opaque): Opaque;
// For inputWidth x inputHeight images upscaled to outputWidth x outputHeight; non-zero if ready.
declare function Donut_InitDlss(dlss: Opaque, inputWidth: int, inputHeight: int, outputWidth: int, outputHeight: int): int;
declare function Donut_IsDlssInitialized(dlss: Opaque): int;
// HDR color into resolved color (instead of TAA), with the tone mapping pass's exposure. Planar views only.
declare function Donut_EvaluateDlss(commandList: Opaque, dlss: Opaque, view: Opaque, sceneRenderTargets: Opaque, toneMappingPass: Opaque): void;
// One pixel of a texture: capture, execute (Donut_FlushFrameCommandList), then read 4 ints into dst.
declare function Donut_CreatePixelReadbackPass(app: Opaque, texture: Opaque): Opaque;
declare function Donut_CapturePixel(commandList: Opaque, pixelReadbackPass: Opaque, x: int, y: int): void;
declare function Donut_ReadPixelUInts(pixelReadbackPass: Opaque, dst: Opaque): void;
// Mip generation for a color texture with mips; Display draws them over the frame.
declare function Donut_CreateMipMapGenPass(app: Opaque, texture: Opaque): Opaque;
declare function Donut_DispatchMipMapGen(commandList: Opaque, mipMapGenPass: Opaque): void;
declare function Donut_DisplayMipMapGen(app: Opaque, frame: Opaque, mipMapGenPass: Opaque): void;

// Light probes.
// numProbes probes named "1", "2", ..., disabled until rendered.
declare function Donut_CreateLightProbeSet(app: Opaque, numProbes: int): Opaque;
declare function Donut_GetLightProbeCount(lightProbeSet: Opaque): int;
declare function Donut_GetLightProbeName(lightProbeSet: Opaque, index: int): string;
declare function Donut_IsLightProbeEnabled(lightProbeSet: Opaque, index: int): int;
declare function Donut_SetLightProbeEnabled(lightProbeSet: Opaque, index: int, enabled: int): void;
declare function Donut_SetLightProbeScales(lightProbeSet: Opaque, index: int, diffuseScale: number, specularScale: number): void;
declare function Donut_GetLightProbeSpecularMipLevels(lightProbeSet: Opaque): int;
declare function Donut_CreateLightProbeProcessingPass(app: Opaque): Opaque;
declare function Donut_ResetLightProbeProcessingCaches(lightProbeProcessingPass: Opaque): void;
// An environment cube map (size x size, mipLevels mips) with depth, and its cube map view.
declare function Donut_CreateLightProbeCapture(app: Opaque, size: int, mipLevels: int): Opaque;
declare function Donut_SetLightProbeCaptureTransform(lightProbeCapture: Opaque, x: number, y: number, z: number, zNear: number, cullDistance: number): void;
declare function Donut_GetLightProbeCaptureView(lightProbeCapture: Opaque): Opaque;
declare function Donut_GetLightProbeCaptureFramebuffer(lightProbeCapture: Opaque): Opaque;
declare function Donut_ClearLightProbeCapture(commandList: Opaque, lightProbeCapture: Opaque): void;
declare function Donut_SetupShadowMapForLightProbeCapture(shadowMap: Opaque, light: Opaque, lightProbeCapture: Opaque, cullDistance: number, zRange: number, exponent: number): void;
declare function Donut_GenerateLightProbeCaptureMips(commandList: Opaque, lightProbeProcessingPass: Opaque, lightProbeCapture: Opaque): void;
declare function Donut_RenderLightProbeDiffuse(commandList: Opaque, lightProbeProcessingPass: Opaque, lightProbeCapture: Opaque, lightProbeSet: Opaque, index: int): void;
declare function Donut_RenderLightProbeSpecular(commandList: Opaque, lightProbeProcessingPass: Opaque, lightProbeCapture: Opaque, lightProbeSet: Opaque, index: int, roughness: number, mipLevel: int): void;
declare function Donut_RenderEnvironmentBrdf(commandList: Opaque, lightProbeProcessingPass: Opaque): void;
// Once the GPU is done: enables the probe within 10 units of where it was rendered from.
declare function Donut_FinishLightProbe(lightProbeSet: Opaque, index: int, lightProbeProcessingPass: Opaque, x: number, y: number, z: number): void;

/// <reference path="../donut_handles.d.ts" />
// Buffers, textures, samplers, framebuffers, heaps and tiled resources, readback and copies

// nvrhi::ResolveMode values: how a multisampled depth buffer is resolved by a render pass
// (Donut_CreateResolveFramebuffer, Donut_GetDepthResolveModes).
enum ResolveMode {
    None = 0,
    SampleZero = 1,
    Average = 2,
    Min = 3,
    Max = 4
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

// nvrhi::Format values (only the ones used so far).
enum Format {
    UNKNOWN = 0,
    R8_UINT = 1,
    R8_UNORM = 3,
    RG8_UINT = 5,
    R16_UINT = 9,
    R16_UNORM = 11,
    R16_FLOAT = 13,
    RGBA8_UINT = 17,
    RGBA8_UNORM = 19,
    BGRA8_UNORM = 21,
    SRGBA8_UNORM = 23,
    SBGRA8_UNORM = 24,
    R10G10B10A2_UNORM = 26,
    R11G11B10_FLOAT = 27,
    RG16_FLOAT = 32,
    R32_UINT = 33,
    R32_SINT = 34,
    R32_FLOAT = 35,
    RGBA16_UINT = 36,
    RGBA16_FLOAT = 38,
    RGBA16_UNORM = 39,
    RGBA16_SNORM = 40,
    D16 = 50,
    D24S8 = 51,
    D32 = 53,
    D32S8 = 54,
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
// A buffer's device address (uint64) into the 8 bytes at dst (Ref of an array element, e.g. of
// push constants), for shaders' vk::RawBufferLoad / vk::RawBufferStore.
@nodrops declare function Donut_CopyBufferDeviceAddress(buffer: BufferHandle, dst: Opaque): void;
// A pipeline keeps its own reference to its shaders, so they can be released once it exists.
@nodrops declare function Donut_ReleaseResource(app: AppHandle, resource: ResourceHandle): void;

// Typed buffer of elementCount R32_UINT values. writable != 0: a UAV the GPU writes to;
// otherwise shader-readable only, filled with Donut_WriteBuffer.
@nodrops declare function Donut_CreateUIntBuffer(app: AppHandle, elementCount: int, writable: int, debugName: string): BufferHandle;
// CPU-readable buffer to copy GPU results into.
@nodrops declare function Donut_CreateReadbackBuffer(app: AppHandle, byteSize: int, debugName: string): BufferHandle;
// Copies byteSize bytes of a readback buffer to dst once the GPU is done with it (see
// Donut_WaitForIdle). Pass `Ref(array[0])` of a `let` int[] / f32[] array. Returns 0 on failure.
@nodrops declare function Donut_ReadBuffer(app: AppHandle, readbackBuffer: BufferHandle, dst: Opaque, byteSize: int): int;
// Copies a level of a texture to dst (Ref of a `let` array element; byteSize bytes at most): its
// rows (of 4 x 4 blocks for block-compressed formats) one after the other, without padding.
// Submits its own command list and waits for it: call it while no other one is open (not in a
// render callback). Not for textures the texture cache loaded (Donut_LoadTexture: they stay
// shader resources, and can't be copied from). Returns the bytes copied, 0 on failure.
@nodrops declare function Donut_ReadTextureLevel(app: AppHandle, texture: TextureHandle, mipLevel: int, dst: Opaque, byteSize: int): int;
// For cbuffers; bind 256-byte-aligned slices of it with Donut_BindConstantBuffer.
@nodrops declare function Donut_CreateConstantBuffer(app: AppHandle, byteSize: int, debugName: string): BufferHandle;
// For cbuffers rewritten with Donut_WriteBuffer before each use (up to 16 times per frame); bind
// it with Donut_BindEntireConstantBuffer and Donut_LayoutVolatileConstantBuffer.
@nodrops declare function Donut_CreateVolatileConstantBuffer(app: AppHandle, byteSize: int, debugName: string): BufferHandle;
// StructuredBuffer of count elements of stride bytes, filled with Donut_WriteBuffer.
@nodrops declare function Donut_CreateStructuredBuffer(app: AppHandle, stride: int, count: int, debugName: string): BufferHandle;
// Same, that shaders can also write (RWStructuredBuffer).
@nodrops declare function Donut_CreateRWStructuredBuffer(app: AppHandle, stride: int, count: int, debugName: string): BufferHandle;
// Stores an int's bits at dst (Ref of an f32 array element), for int / uint fields of structures
// laid out as f32 arrays.
@nodrops declare function Donut_StoreInt32(dst: Opaque, value: int): void;
// RGBA8_UNORM texture that compute shaders write (RWTexture2D<float4>) and pixel shaders read;
// NVRHI tracks its state.
@nodrops declare function Donut_CreateUAVTexture(app: AppHandle, width: int, height: int, debugName: string): TextureHandle;
// Render target that shaders can also read (resting at ShaderResource). A depth format (D32)
// makes a depth buffer, cleared to 1 by default, read by shaders as Texture2D<float>.
@nodrops declare function Donut_CreateRenderTargetTexture(app: AppHandle, width: int, height: int, format: Format, debugName: string): TextureHandle;
// Texture of width x height with mipLevels levels (block-compressed formats too) for shaders to
// read, its levels written with Donut_WriteTextureLevel; resting at ShaderResource.
@nodrops declare function Donut_CreateTextureWithLevels(app: AppHandle, width: int, height: int, mipLevels: int, format: Format,
    debugName: string): TextureHandle;
// Uploads a level of a texture from data, its rows (of 4 x 4 blocks for block-compressed formats)
// rowPitch bytes apart, copied during the call, into an open command list.
@nodrops declare function Donut_WriteTextureLevel(commandList: CommandListHandle, texture: TextureHandle, mipLevel: int, data: Opaque, rowPitch: int): void;
// Render target that shaders also read and write as a UAV (RWTexture2D<...>), resting at
// UnorderedAccess.
@nodrops declare function Donut_CreateRenderTargetUAVTexture(app: AppHandle, width: int, height: int, format: Format, debugName: string): TextureHandle;
// Same, with mipLevels levels (draw into one with Donut_CreateFramebufferForMip, read another with
// Donut_BindTextureSRVMip), typeless: copies of other formats of its family land (RGBA8_UNORM data
// into SRGBA8_UNORM).
@nodrops declare function Donut_CreateMipmappedRenderTarget(app: AppHandle, width: int, height: int, mipLevels: int, format: Format,
    debugName: string): TextureHandle;
// Same, typeless: framebuffers can see it in other formats of its family
// (Donut_CreateFramebufferWithColorFormat), e.g. an SRGBA8_UNORM texture as RGBA8_UNORM (stored
// without sRGB encoding) or RGBA8_UINT (logic operations, which D3D12 has on UINT targets only);
// shaders read it in `format`.
@nodrops declare function Donut_CreateTypelessRenderTargetTexture(app: AppHandle, width: int, height: int, format: Format, debugName: string): TextureHandle;
// Depth buffer (a depth format) whose clears to clearDepth are fast (e.g. 0 for reversed depth),
// read by shaders as Texture2D<float>; resting at ShaderResource.
@nodrops declare function Donut_CreateDepthTexture(app: AppHandle, width: int, height: int, format: Format, clearDepth: number, debugName: string): TextureHandle;
// Textures that compute shaders on the compute queue use too (they rest at NonPixelShaderResource):
// a render target that shaders read, and a texture that compute shaders write
// (RWTexture2D<float4>) and shaders read.
@nodrops declare function Donut_CreateComputeReadableRenderTarget(app: AppHandle, width: int, height: int, format: Format, debugName: string): TextureHandle;
@nodrops declare function Donut_CreateComputeTexture(app: AppHandle, width: int, height: int, format: Format, debugName: string): TextureHandle;
// Texture in `format` that shaders write and read as a UAV (RWTexture2D<...>), resting at
// UnorderedAccess; clear it with Donut_ClearTextureUInt / Donut_ClearTextureFloat.
@nodrops declare function Donut_CreateUAVTextureWithFormat(app: AppHandle, width: int, height: int, format: Format, debugName: string): TextureHandle;
// Same, an array of arraySize slices (RWTexture2DArray<...>; Texture2DArray when read: the bind
// functions bind all slices).
@nodrops declare function Donut_CreateUAVTextureArray(app: AppHandle, width: int, height: int, arraySize: int, format: Format,
    debugName: string): TextureHandle;
// One color target and an optional depth target; draw into it with Donut_BeginDrawToFramebuffer.
@nodrops declare function Donut_CreateFramebuffer(app: AppHandle, colorTexture: TextureHandle, depthTexture: TextureHandle | null): FramebufferHandle;
// Same, the color target seen in colorFormat (a format of its family, for a typeless texture:
// Donut_CreateTypelessRenderTargetTexture).
@nodrops declare function Donut_CreateFramebufferWithColorFormat(app: AppHandle, colorTexture: TextureHandle, colorFormat: Format, depthTexture: TextureHandle | null): FramebufferHandle;
// A depth target alone (e.g. a shadow map).
@nodrops declare function Donut_CreateDepthFramebuffer(app: AppHandle, depthTexture: TextureHandle): FramebufferHandle;
// Same, with two color targets (SV_Target0 and SV_Target1).
@nodrops declare function Donut_CreateFramebufferWithTwoTargets(app: AppHandle, colorTexture0: TextureHandle, colorTexture1: TextureHandle,
    depthTexture: TextureHandle | null): FramebufferHandle;
// Same, with three color targets (SV_Target0 to SV_Target2).
@nodrops declare function Donut_CreateFramebufferWithThreeTargets(app: AppHandle, colorTexture0: TextureHandle, colorTexture1: TextureHandle,
    colorTexture2: TextureHandle, depthTexture: TextureHandle | null): FramebufferHandle;
// One level of a color target, to draw into while sampling another (Donut_BindTextureSRVMip).
@nodrops declare function Donut_CreateFramebufferForMip(app: AppHandle, colorTexture: TextureHandle, mipLevel: int): FramebufferHandle;
// A DDS file's texture (path relative to the executable's directory, all its levels; sRGB != 0
// views RGBA8 data as sRGB) written by the CPU, with no staging buffer or command list: Vulkan's
// VK_EXT_host_image_copy (vkTransitionImageLayoutEXT, vkCopyMemoryToImageEXT into an optimally
// tiled device-local image), D3D12's WriteToSubresource (a texture in a CPU-writable custom heap).
// It rests as a shader resource. Release it with Donut_ReleaseObject; null (after logging why) on
// failure.
@nodrops declare function Donut_CreateHostCopiedTexture(app: AppHandle, path: string, sRGB: int, debugName: string): HostCopiedTextureHandle | null;
@nodrops declare function Donut_GetHostCopiedTexture(hostCopiedTexture: HostCopiedTextureHandle): TextureHandle;
// Tiled textures (requires Donut_HasSparseResidency): a 2D texture whose memory is mapped tile by
// tile from heaps; unmapped tiles read as zeros. It rests as a shader resource, and is a copy source
// and destination and a render target.
@nodrops declare function Donut_CreateTiledTexture(app: AppHandle, width: int, height: int, mipLevels: int, format: Format, debugName: string): TextureHandle;
// Into dst (Ref of a `let` int array of 4): the tile's width and height in texels, the number of
// levels made of whole tiles, the number of levels packed into the mip tail.
@nodrops declare function Donut_GetTextureTiling(app: AppHandle, texture: TextureHandle, dst: Ref<int>): void;
// The number of tiles the packed levels (the mip tail) take together: 0 if there are none.
@nodrops declare function Donut_GetTexturePackedMipTileCount(app: AppHandle, texture: TextureHandle): int;
// Memory to map tiles into: byteSize bytes, a multiple of the 64 KiB tile. Release it once no tile
// is mapped to it and the GPU is done with what used it.
// Placed textures: textures sharing one heap's memory (D3D12's placed resources, Vulkan's
// textures bound to memory), versus committed ones with their own allocations. The bytes a
// width x height, one-level texture of `format` takes in a heap, its alignment included: on D3D12
// at the 4 KB small resource alignment when the device grants it (a committed texture rounds up to
// 64 KB), Vulkan's memory requirements.
@nodrops declare function Donut_GetPlacedTextureSize(app: AppHandle, width: int, height: int, format: Format): number;
// A heap of byteSize bytes of device memory for placed textures (D3D12, Vulkan); null on failure.
@nodrops declare function Donut_CreateTextureHeap(app: AppHandle, byteSize: number, debugName: string): TextureHeapHandle | null;
// A texture that shaders read placed in a texture heap at byteOffset (a multiple of
// Donut_GetPlacedTextureSize's size), its first use recorded into an open command list. Fill it with
// Donut_WriteTextureLevel; release it before the heap. Null on failure.
@nodrops declare function Donut_CreatePlacedTexture(app: AppHandle, commandList: CommandListHandle, textureHeap: TextureHeapHandle, byteOffset: number,
    width: int, height: int, format: Format, debugName: string): TextureHandle | null;
@nodrops declare function Donut_CreateTileHeap(app: AppHandle, byteSize: number, debugName: string): HeapHandle;
// Tile mappings, applied in one go (and freed) by Donut_ApplyTileMappings.
@nodrops declare function Donut_CreateTileMappings(): TileMappingsHandle;
// Maps the tile at column x, row y of level mipLevel to byteOffset in a heap, or unmaps it (null).
@nodrops declare function Donut_TileMappingsAdd(tileMappings: TileMappingsHandle, mipLevel: int, x: int, y: int, heap: HeapHandle | null, byteOffset: number): void;
// Maps all the packed levels (from level firstPackedMip on) to tileCount tiles from byteOffset in a
// heap, or unmaps them (null).
@nodrops declare function Donut_TileMappingsAddPackedMips(tileMappings: TileMappingsHandle, firstPackedMip: int, tileCount: int, heap: HeapHandle | null,
    byteOffset: number): void;
// On the graphics queue, after the work submitted before (on Vulkan the device is idle before and
// after: its sparse binding isn't ordered with other work).
@nodrops declare function Donut_ApplyTileMappings(app: AppHandle, texture: TextureHandle, tileMappings: TileMappingsHandle): void;
// The first level of a DDS file (path relative to the executable's directory) in a staging
// texture: memory on the CPU's side the GPU copies from. Null (after logging why) on failure.
@nodrops declare function Donut_LoadStagingTexture(app: AppHandle, path: string): StagingTextureHandle;
@nodrops declare function Donut_GetStagingTextureWidth(stagingTexture: StagingTextureHandle): int;
@nodrops declare function Donut_GetStagingTextureHeight(stagingTexture: StagingTextureHandle): int;
// Vertex / index buffers uploaded once by an open command list (data copied during the call).
@nodrops declare function Donut_CreateStaticVertexBuffer(app: AppHandle, commandList: CommandListHandle, data: Opaque, byteSize: int, debugName: string): BufferHandle;
// A vertex buffer to write (Donut_WriteBuffer) as often as needed, e.g. per frame.
@nodrops declare function Donut_CreateDynamicVertexBuffer(app: AppHandle, byteSize: int, debugName: string): BufferHandle;
// A static buffer of byteSize bytes of data for shaders to read: a StructuredBuffer of
// structStride-byte elements if structStride > 0, else a ByteAddressBuffer. Null on failure.
@nodrops declare function Donut_CreateStaticShaderBuffer(app: AppHandle, commandList: CommandListHandle, data: Opaque, byteSize: int, structStride: int, debugName: string): BufferHandle;
@nodrops declare function Donut_CreateStaticIndexBuffer(app: AppHandle, commandList: CommandListHandle, data: Opaque, byteSize: int, debugName: string): BufferHandle;
// A static vertex buffer (or index buffer if isIndexBuffer != 0) that shaders also read as a
// ByteAddressBuffer and acceleration structure builds take as input (Donut_AddTriangleBlasGeometry):
// one copy of a mesh for rasterization and ray tracing.
@nodrops declare function Donut_CreateStaticGeometryBuffer(app: AppHandle, commandList: CommandListHandle, data: Opaque, byteSize: int,
    isIndexBuffer: boolean, debugName: string): BufferHandle;
// A static vertex buffer that shaders can also read as a ByteAddressBuffer.
@nodrops declare function Donut_CreateStaticRawVertexBuffer(app: AppHandle, commandList: CommandListHandle, data: Opaque, byteSize: int, debugName: string): BufferHandle;
// The arguments of `count` indexed indirect draws (20 bytes each: index count, instance count,
// first index, vertex offset, first instance), filled with Donut_WriteBuffer, that shaders can
// also write as a RWByteAddressBuffer.
@nodrops declare function Donut_CreateDrawIndexedIndirectBuffer(app: AppHandle, count: int, debugName: string): BufferHandle;
// A buffer's GPU address (8 bytes; its device address on Vulkan) into dst (Ref of a `let` array
// element), for shaders that write it through the address; 0 if it has none.
@nodrops declare function Donut_StoreBufferDeviceAddress(dst: Opaque, buffer: BufferHandle): void;
// Before a dispatch whose shaders write a buffer through its device address (NVRHI can't see
// that): marks it as written by shaders, so that its next use waits for the writes.
@nodrops declare function Donut_SetBufferWrittenByShaders(commandList: CommandListHandle, buffer: BufferHandle): void;
@nodrops declare function Donut_GetCommonSampler(app: AppHandle, which: CommonSampler): SamplerHandle;
// SamplerComparisonState for depth textures: bilinear, clamped. Its comparison is "less" (NVRHI
// fixes it): SampleCmp returns the fraction of texels deeper than the reference.
@nodrops declare function Donut_CreateComparisonSampler(app: AppHandle): SamplerHandle;
// Same, comparing by func (patches/nvrhi-sampler-comparison-func.patch), bilinear between texels and
// point between levels: MiniEngine's shadow sampler (GreaterOrEqual for reversed depth).
@nodrops declare function Donut_CreateComparisonSamplerWithFunc(app: AppHandle, func: ComparisonFunc): SamplerHandle;
// linearFilter / linearMipFilter non-zero: linear filtering within / between levels (point
// otherwise); wrap non-zero: repeating (clamped otherwise).
@nodrops declare function Donut_CreateSampler(app: AppHandle, linearFilter: int, linearMipFilter: int, wrap: int): SamplerHandle;
// A sampler by its whole description: linear (non-zero) or point filtering when minifying,
// magnifying and between levels; the address mode of all coordinates; a bias added to the level of
// detail, the range it's clamped to (maxLod 0: level 0 only), and anisotropic filtering up to
// maxAnisotropy samples (1: off; Donut_GetMaxSamplerAnisotropy).
@nodrops declare function Donut_CreateSamplerWithDesc(app: AppHandle, linearMin: int, linearMag: int, linearMip: int,
    addressMode: SamplerAddressMode, mipBias: number, minLod: number, maxLod: number, maxAnisotropy: number): SamplerHandle;
// A sampler whose coordinates outside [0, 1] read a border color (r, g, b, a): linear (non-zero) or
// point filtering when minifying, magnifying and between levels, every level.
@nodrops declare function Donut_CreateBorderSampler(app: AppHandle, linearMin: int, linearMag: int, linearMip: int, r: number, g: number,
    b: number, a: number): SamplerHandle;
// A buffer that shaders read and write as a (RW)ByteAddressBuffer (Donut_BindRawBufferSRV / UAV) and
// Donut_WriteBuffer / Donut_CopyBuffer fill; it rests at UnorderedAccess.
@nodrops declare function Donut_CreateRawBuffer(app: AppHandle, byteSize: int, debugName: string): BufferHandle;
// RGBA8_UNORM texture of the frame's size that shaders write as RWTexture2D<float4>.
@nodrops declare function Donut_CreateUAVTextureForFrame(app: AppHandle, frame: FrameHandle, debugName: string): TextureHandle;
// Same, in another format.
@nodrops declare function Donut_CreateUAVTextureForFrameWithFormat(app: AppHandle, frame: FrameHandle, debugName: string, format: Format): TextureHandle;
// Same, in the back buffer's format without sRGB, for Donut_CopyTextureToFrame (a bit-for-bit copy).
@nodrops declare function Donut_CreateUAVTextureForFrameCopy(app: AppHandle, frame: FrameHandle, debugName: string): TextureHandle;

// C++ objects (scenes, cameras, ...) are owned by the app until released or the app is destroyed.
@nodrops declare function Donut_ReleaseObject(app: AppHandle, object: ObjectHandle): void;
// Render target (color format) or depth buffer (depth format, cleared to clearDepth) of width x
// height with sampleCount samples (Texture2DMS when more than 1) that shaders can read and that can
// be resolved; resting at ShaderResource. Null on failure.
@nodrops declare function Donut_CreateMultisampledTexture(app: AppHandle, width: int, height: int, format: Format, sampleCount: int,
    clearDepth: number, debugName: string): TextureHandle;
// Framebuffer drawing into colorTexture and depthTexture (null for none) whose render passes, as
// they end, resolve color into colorResolveTexture and depth into depthResolveTexture by
// depthResolveMode, where those aren't null. Needs Donut_HasRenderPassResolve; NVRHI ends a render
// pass at every barrier, so a pass may resolve more than once (with the same result).
@nodrops declare function Donut_CreateResolveFramebuffer(app: AppHandle, colorTexture: TextureHandle | null, colorResolveTexture: TextureHandle | null,
    depthTexture: TextureHandle | null, depthResolveTexture: TextureHandle | null, depthResolveMode: ResolveMode): FramebufferHandle;
// A texture another D3D11 device writes and this one's shaders read (e.g. Media Foundation's video
// frames: Donut_TransferVideoFrame): a render target shared through an NT handle (on D3D12 with
// simultaneous access), resting at ShaderResource. D3D12 and D3D11 only (Windows): null with other
// APIs, and (after logging why) on failure.
@nodrops declare function Donut_CreateSharedTexture(app: AppHandle, width: int, height: int, format: Format, debugName: string): SharedTextureHandle | null;
// Its texture (valid as long as it) and NT handle.
@nodrops declare function Donut_GetSharedTexture(sharedTexture: SharedTextureHandle): TextureHandle;
@nodrops declare function Donut_GetSharedTextureHandle(sharedTexture: SharedTextureHandle): Opaque;

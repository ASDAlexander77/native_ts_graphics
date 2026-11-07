/// <reference path="../donut_handles.d.ts" />
/// <reference path="resources.d.ts" />
// What the device supports (features, limits, formats, memory, timestamps) and NVRHI access

// nvrhi::Feature values (only the ones used so far).
enum Feature {
    ComputeQueue = 0,
    ConservativeRasterization = 1,
    FastGeometryShader = 5,
    // NVAPI's shader extensions through a UAV slot (Donut_RtPipelineSetHlslExtensionsUAV).
    HlslExtensionUAV = 7,
    // Linear swept sphere geometry in BLASes (D3D12 through NVAPI, Blackwell GPUs; Vulkan's
    // VK_NV_ray_tracing_linear_swept_spheres, with AppOptions.RayTracing).
    LinearSweptSpheres = 8,
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

// Donut_GetCalibratedTimeDomain's values: Vulkan's VkTimeDomainEXT.
enum TimeDomain {
    Device = 0,
    ClockMonotonic = 1,
    ClockMonotonicRaw = 2,
    QueryPerformanceCounter = 3,
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

// Bits of Donut_GetIndirectDrawSupport.
enum IndirectDrawSupport {
    // One indirect draw call issues several draws (Vulkan's multiDrawIndirect; D3D12).
    MultiDraw = 1,
    // Indirect draws can start at an instance other than 0 (Vulkan's drawIndirectFirstInstance).
    FirstInstance = 2,
    // Shaders can write buffers through their device addresses (Vulkan's bufferDeviceAddress).
    BufferDeviceAddress = 4,
    // Indirect draws can take their count from a buffer (D3D12; Vulkan's drawIndirectCount).
    Count = 8
}

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
@nodrops declare function Donut_IsFeatureSupported(app: AppHandle, feature: Feature): int;
// What the app's device does with indirect draws (a headless app's too). Vulkan devices are
// created with multiDrawIndirect, drawIndirectFirstInstance, drawIndirectCount and
// shaderSampledImageArrayDynamicIndexing when the GPU has them.
@nodrops declare function Donut_GetIndirectDrawSupport(app: AppHandle): IndirectDrawSupport;
// Non-zero if pixel shaders can write to UAVs and do atomics on them (Vulkan devices are created
// with fragmentStoresAndAtomics when the GPU has it; D3D11 and D3D12 always can).
@nodrops declare function Donut_HasFragmentStoresAndAtomics(app: AppHandle): int;
// Non-zero if 2D textures can be tiled (Donut_CreateTiledTexture) and shaders can tell whether what
// they sample is mapped (CheckAccessFullyMapped): D3D12 with tiled resources tier 2, Vulkan with
// sparse residency; never D3D11.
@nodrops declare function Donut_HasSparseResidency(app: AppHandle): int;
// Non-zero if draws can be skipped by a value in a buffer (Donut_CreatePredicationBuffer): D3D12's
// predication, Vulkan's VK_EXT_conditional_rendering; not D3D11 (whose predicates are queries).
@nodrops declare function Donut_HasConditionalRendering(app: AppHandle): int;
// Non-zero if pixel shaders can use rasterizer ordered views (RasterizerOrderedTexture2D...):
// accesses from overlapping pixels happen in primitive order. D3D11/D3D12 with ROVsSupported,
// Vulkan with fragment shader pixel interlock.
@nodrops declare function Donut_HasRasterizerOrderedViews(app: AppHandle): int;
// Non-zero if pixel shaders can read their barycentrics (SV_Barycentrics) and the triangle's vertex
// attributes (GetAttributeAtVertex): D3D12 with BarycentricsSupported, Vulkan with
// VK_KHR_fragment_shader_barycentric.
@nodrops declare function Donut_HasBarycentrics(app: AppHandle): int;
// Non-zero if shaders can compute with native 16-bit types (float16_t, int16_t, uint16_t) and read
// them from structured buffers: D3D12 with Native16BitShaderOpsSupported, Vulkan with shaderFloat16,
// shaderInt16 and storageBuffer16BitAccess.
@nodrops declare function Donut_HasNative16BitShaderOps(app: AppHandle): int;
// Non-zero if blend states can do logic operations (Donut_GraphicsPipelineSetLogicOp): D3D11 and
// D3D12 with OutputMergerLogicOp, Vulkan with the logicOp feature.
@nodrops declare function Donut_HasLogicOps(app: AppHandle): int;
// Non-zero if pipelines can test the depth target against bounds
// (Donut_GraphicsPipelineSetDepthBoundsTest): D3D12 with DepthBoundsTestSupported, Vulkan with the
// depthBounds feature; never D3D11.
@nodrops declare function Donut_HasDepthBoundsTest(app: AppHandle): int;
// The device's memory heaps now (their count): this process's usage of each and its budget, the
// memory it can use before the system has to page or fail allocations. Vulkan's memory heaps, with
// VK_EXT_memory_budget (without it the usage is 0 and the budget the heap's size); D3D's local
// (video) and non-local (system) memory segment groups, from DXGI.
@nodrops declare function Donut_QueryMemoryBudget(app: AppHandle): int;
// A memory heap's usage and budget in bytes, and its MemoryHeapFlag bits, as Donut_QueryMemoryBudget
// last found them.
@nodrops declare function Donut_GetMemoryHeapUsage(app: AppHandle, heap: int): number;
@nodrops declare function Donut_GetMemoryHeapBudget(app: AppHandle, heap: int): number;
@nodrops declare function Donut_GetMemoryHeapFlags(app: AppHandle, heap: int): int;
// Calibrated timestamps: timestamps of several time domains (clocks) sampled together, the
// device's among them. Vulkan's VK_EXT_calibrated_timestamps, D3D12's command queue clock
// calibration (the device's and QueryPerformanceCounter's). Null if the device can't (D3D11, or
// Vulkan without the extension). Release it with Donut_ReleaseObject.
@nodrops declare function Donut_CreateCalibratedTimestamps(app: AppHandle): CalibratedTimestampsHandle | null;
// Its time domains: their number, and each one's VkTimeDomainEXT value (TimeDomain).
@nodrops declare function Donut_GetCalibratedTimeDomainCount(calibratedTimestamps: CalibratedTimestampsHandle): int;
@nodrops declare function Donut_GetCalibratedTimeDomain(calibratedTimestamps: CalibratedTimestampsHandle, index: int): int;
// Samples all its domains' timestamps at once; 0 on failure.
@nodrops declare function Donut_SampleCalibratedTimestamps(calibratedTimestamps: CalibratedTimestampsHandle): int;
// The last sample's timestamp of a domain, in its ticks (the device's: Donut_GetTimestampPeriod
// nanoseconds each), and its maximum deviation between the domains in nanoseconds (0 on D3D12).
@nodrops declare function Donut_GetCalibratedTimestamp(calibratedTimestamps: CalibratedTimestampsHandle, index: int): number;
@nodrops declare function Donut_GetCalibratedTimestampsMaxDeviation(calibratedTimestamps: CalibratedTimestampsHandle): number;
// The nanoseconds of a tick of the device's timestamps (Vulkan's timestampPeriod; from the
// graphics queue's timestamp frequency on D3D12); 0 if unknown.
@nodrops declare function Donut_GetTimestampPeriod(app: AppHandle): number;
// LineRasterization bits: the line rasterization modes pipelines can have: Vulkan's with
// VK_EXT_line_rasterization's features, plain and stippled; D3D's rectangular (quadrilateral),
// Bresenham (aliased) and smooth (alpha antialiased) lines, unstippled.
@nodrops declare function Donut_GetLineRasterizationModes(app: AppHandle): int;
// The widest lines can be: Vulkan's lineWidthRange with the wideLines feature, else 1.
@nodrops declare function Donut_GetMaxLineWidth(app: AppHandle): number;
// Non-zero if pixel shaders can run in full quads, helper invocations taking part in quad operations
// (QuadReadLaneAt...): Vulkan with VK_KHR_shader_quad_control (SPIR-V's RequireFullQuadsKHR and
// QuadDerivativesKHR execution modes), D3D12 always.
@nodrops declare function Donut_HasShaderQuadControl(app: AppHandle): int;
// AdvancedBlend bits: the advanced blend operations blend states can do
// (Donut_GraphicsPipelineSetAdvancedBlendOp): Vulkan with VK_EXT_blend_operation_advanced and its
// coherent operations; 0 elsewhere.
@nodrops declare function Donut_GetAdvancedBlendOperations(app: AppHandle): int;
// ComputeDerivatives bits: whether compute shaders can take derivatives (ddx, ddy, implicit-LOD
// samples; shader model 6.6) in quads of 2 x 2 threads (2D thread groups) or in 4 consecutive
// threads (1D thread groups). D3D12 with shader model 6.6, Vulkan with
// VK_KHR_compute_shader_derivatives.
@nodrops declare function Donut_GetComputeShaderDerivatives(app: AppHandle): ComputeDerivatives;
// The fewest and most lanes a wave (subgroup) has: D3D12's WaveLaneCountMin and Max, Vulkan's one
// subgroupSize for both; 0 without wave intrinsics (D3D11).
@nodrops declare function Donut_GetWaveLaneCountMin(app: AppHandle): int;
@nodrops declare function Donut_GetWaveLaneCountMax(app: AppHandle): int;
// Whether ray generation shaders can trace rays into hit objects, reorder their threads by them
// (MaybeReorderThread) and invoke their hit or miss shaders: D3D12 with shader model 6.9 and
// raytracing tier 1.2, Vulkan with VK_NV_ray_tracing_invocation_reorder (AppOptions.RayTracing).
@nodrops declare function Donut_GetShaderExecutionReordering(app: AppHandle): ShaderExecutionReordering;
// Non-zero if push constants and constant buffers can hold 16-bit values as well (Vulkan's
// storagePushConstant16 and uniformAndStorageBuffer16BitAccess).
@nodrops declare function Donut_HasNative16BitConstants(app: AppHandle): int;

// Non-zero if shaders can reach buffers through device addresses (Vulkan's bufferDeviceAddress;
// not D3D, whose shaders have no pointers).
@nodrops declare function Donut_HasBufferDeviceAddress(app: AppHandle): int;
// Vulkan's conservative rasterization properties into dst (Ref of a `let` f32 array of 9):
// primitiveOverestimationSize, maxExtraPrimitiveOverestimationSize,
// extraPrimitiveOverestimationSizeGranularity, then 1 or 0 for primitiveUnderestimation,
// conservativePointAndLineRasterization, degenerateTrianglesRasterized, degenerateLinesRasterized,
// fullyCoveredFragmentShaderInputVariable, conservativeRasterizationPostDepthCoverage. 0 (dst
// untouched) on other graphics APIs or without the extension.
@nodrops declare function Donut_GetVulkanConservativeRasterizationProperties(app: AppHandle, dst: Ref<f32>): int;
// D3D12's conservative rasterization tier (0 for none); 0 on other graphics APIs.
@nodrops declare function Donut_GetD3D12ConservativeRasterizationTier(app: AppHandle): int;
@nodrops declare function Donut_GetRendererString(app: AppHandle): string;
// The app's nvrhi::IDevice, for code that works with NVRHI directly (e.g. core/paged_images.cpp).
@nodrops declare function Donut_GetNvrhiDevice(app: AppHandle): Opaque;
// 1 if core/nvrhi.ts can call NVRHI's interfaces in this build: their vtables, member function
// convention and std::string are MSVC x64's (core/nvrhi_abi.win32.ts) or those of Android's clang
// and libc++ on x86-64 or AArch64 (core/nvrhi_abi.linux.ts); 0 otherwise.
@nodrops declare function Donut_CanCallNvrhiDirectly(): int;
// The nvrhi::IMessageCallback the devices created after this get: an object of a tslang class
// implementing nvrhi.IMessageCallback (core/nvrhi.ts), which the caller keeps alive - in a global -
// for as long as the devices live, as C++ holds it where the collector doesn't look; null for
// Donut's, which logs the messages.
@nodrops declare function Donut_SetNvrhiMessageCallback(callback: Opaque | null): void;
// What Donut does with an NVRHI message (an nvrhi.MESSAGE_SEVERITY_* value): logs it, and a Fatal
// one ends the program. For a callback that passes messages on.
@nodrops declare function Donut_LogNvrhiMessage(severity: int, text: string): void;
// sizeof an NVRHI struct core/nvrhi.ts lays out as a tuple (named as in NVRHI), or -1: its layout
// depends on the C++ build (std::string's on the CRT), so nvrhi.layoutMatches() compares the two.
@nodrops declare function Donut_GetNvrhiStructSize(name: string): int;

// Non-zero if textures can be written by the CPU without a copy on the GPU: Vulkan with
// VK_EXT_host_image_copy, D3D12.
@nodrops declare function Donut_HasHostImageCopy(app: AppHandle): int;
// The most samples anisotropic filtering can take: Vulkan's maxSamplerAnisotropy with the
// samplerAnisotropy feature (1 without), 16 on D3D.
@nodrops declare function Donut_GetMaxSamplerAnisotropy(app: AppHandle): number;
// nvrhi::Format values 0 .. count-1, their names and nvrhi::FormatSupport bits.
@nodrops declare function Donut_GetFormatCount(): int;
@nodrops declare function Donut_GetFormatName(format: int): string;
@nodrops declare function Donut_QueryFormatSupport(app: AppHandle, format: int): int;

// Multisampling.
// The sample counts that a color target in colorFormat and a depth buffer in depthFormat can both
// have, as bits (bit n for n samples: 0x1 | 0x2 | 0x4 ...): on Vulkan the device's
// framebufferColorSampleCounts & framebufferDepthSampleCounts, on D3D the formats' quality levels.
@nodrops declare function Donut_GetSupportedSampleCounts(app: AppHandle, colorFormat: Format, depthFormat: Format): int;
// Non-zero if render passes resolve multisampled targets as they end (Vulkan's dynamic rendering;
// Donut_CreateResolveFramebuffer). NVRHI runs D3D without render passes: use Donut_ResolveTexture.
@nodrops declare function Donut_HasRenderPassResolve(app: AppHandle): int;
// The ResolveModes render passes can resolve depth by, as bits 1 << mode (Vulkan's
// supportedDepthResolveModes); 0 without render pass resolves.
@nodrops declare function Donut_GetDepthResolveModes(app: AppHandle): int;

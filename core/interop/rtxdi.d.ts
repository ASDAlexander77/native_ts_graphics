/// <reference path="../donut_handles.d.ts" />
// RTXDI (core/rtxdi.cpp; the rtxdi_minimal example links it)

// Handles of the module's objects (see donut_handles.d.ts).
@cpp declare class RtxdiDIContextHandle { private readonly __rtxdiDIContext: index; }
@cpp declare class RtxdiResourcesHandle { private readonly __rtxdiResources: index; }

// The buffers of Rtxdi_GetBuffer.
enum RtxdiBuffer {
    Tasks = 0,
    LightData = 1,
    GeometryInstanceToLight = 2,
    NeighborOffsets = 3,
    LightReservoirs = 4
}

// The host side of NVIDIA's RTXDI Minimal Sample (github.com/NVIDIA-RTX/RTXDI, Samples/MinimalSample): RTXDI's
// runtime library (RTXDI_DIR's, rtxdi_runtime in CMakeLists.txt) and the sample's resource, light preparation
// and constants code, over Donut's scene and NVRHI buffers; examples/rtxdi_minimal.ts runs the sample's two
// compute shaders on them. Free the context and the resources with the Destroy functions before the app.

// A ReSTIR DI context (rtxdi::ReSTIRDIContext) for width x height frames; every other static parameter is
// the library's default (8192 neighbor offsets, no checkerboard). Resize: destroy it and the resources, create
// them again.
@nodrops declare function Rtxdi_CreateDIContext(width: int, height: int): RtxdiDIContextHandle;
@nodrops declare function Rtxdi_DestroyDIContext(context: RtxdiDIContextHandle): void;
// The frame the context's runtime parameters (the random seed, which reservoir buffer is read and which
// written) are for: before the frame's Rtxdi_WriteResamplingConstants.
@nodrops declare function Rtxdi_SetFrameIndex(context: RtxdiDIContextHandle, frameIndex: int): void;

// The sample's RtxdiResources on the app's device (Donut_GetNvrhiDevice), sized for the scene: its task and
// light buffers for the emissive geometries (PrepareLightsPass::CountLightsInScene: those whose material's
// emissive color isn't black; one element where there are none), the geometry instance to light map, the
// neighbor offsets (RG8_SNORM, typed) and the light reservoirs (the context's size, three buffers). Null
// (after logging why) without a context or scene.
@nodrops declare function Rtxdi_CreateResources(app: AppHandle, context: RtxdiDIContextHandle, scene: SceneHandle): RtxdiResourcesHandle | null;
@nodrops declare function Rtxdi_DestroyResources(resources: RtxdiResourcesHandle): void;
// One of the resources' buffers (the resources': don't release it).
@nodrops declare function Rtxdi_GetBuffer(resources: RtxdiResourcesHandle, which: RtxdiBuffer): BufferHandle;
// Writes the neighbor offsets (RTXDI's FillNeighborOffsetBuffer) on the command list: once, nothing the
// next times.
@nodrops declare function Rtxdi_InitializeNeighborOffsets(resources: RtxdiResourcesHandle, context: RtxdiDIContextHandle,
    commandList: CommandListHandle): void;
// The two volatile constant buffers (PrepareLightsConstants and ResamplingConstants), made once, after the
// resources: the sample keeps the second as a volatile constant buffer in its render pass and passes the first
// as push constants, which tslang's pass binds as a constant buffer instead.
@nodrops declare function Rtxdi_CreateConstantBuffers(app: AppHandle, resources: RtxdiResourcesHandle): void;
@nodrops declare function Rtxdi_GetPrepareLightsConstantBuffer(resources: RtxdiResourcesHandle): BufferHandle;
@nodrops declare function Rtxdi_GetResamplingConstantBuffer(resources: RtxdiResourcesHandle): BufferHandle;

// The CPU part of PrepareLightsPass::Process, on the command list: the tasks (one per emissive geometry, as
// PrepareLightsTask), the geometry instance to light map (RTXDI_INVALID_LIGHT_INDEX for the others) and the
// PrepareLightsConstants, written to their buffers, and the light buffer parameters kept for
// Rtxdi_WriteResamplingConstants (all lights local, no environment light). Returns the number of lights
// (emissive triangles): dispatch the PrepareLights shader for div_ceil(count, 256) groups of 256 (none for 0).
@nodrops declare function Rtxdi_PrepareLights(resources: RtxdiResourcesHandle, scene: SceneHandle, commandList: CommandListHandle): int;

// RenderPass::Render's ResamplingConstants, written to the constant buffer on the command list: the two
// views' constants, the runtime parameters and reservoir buffer indices from the context (frame index, the
// last frame's and this frame's buffers), the light buffer parameters Rtxdi_PrepareLights kept, and the sample's
// sampling parameters (Rtxdi_GetDefaultSettings, the rest of them as the sample sets them) with the settings
// of its UI: resampling on or off, unbiased mode (non-zero: ray traced bias correction in the spatio-temporal
// resampling, else basic), the initial local light and BRDF samples, the BRDF cutoff, the spatial samples.
@nodrops declare function Rtxdi_WriteResamplingConstants(resources: RtxdiResourcesHandle, context: RtxdiDIContextHandle,
    commandList: CommandListHandle, view: ViewHandle, prevView: ViewHandle, enableResampling: int, unbiasedMode: int,
    numLocalLightSamples: int, numBrdfSamples: int, brdfCutoff: number, numSpatialSamples: int): void;
// The sample's defaults of the four settings the UI changes, into dst: the initial local light samples, the
// initial BRDF samples, the BRDF cutoff and the spatial samples.
@nodrops declare function Rtxdi_GetDefaultSettings(dst: Ref<f32>): void;

// Writes an RGBA16_FLOAT (or RGBA32_FLOAT) texture to a file, for comparing frames: width and height (int32),
// then width x height RGBA float32 pixels, little-endian, top row first (Donut_ReadTextureLevel's wait for
// the GPU: call it while no other immediate command list is open). Non-zero on success; logs why not.
@nodrops declare function Rtxdi_SaveTextureRGBA32F(app: AppHandle, texture: TextureHandle, path: string): int;

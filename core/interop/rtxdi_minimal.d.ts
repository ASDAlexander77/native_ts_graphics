/// <reference path="../donut_handles.d.ts" />
// The RTXDI Minimal Sample's resources, light preparation and constants (core/rtxdi_minimal.cpp, over the
// sample's ShaderParameters.h; the rtxdi_minimal example links it with core/rtxdi.cpp).

// Handles of the module's objects (see donut_handles.d.ts).
@cpp declare class RtxdiResourcesHandle { private readonly __rtxdiResources: index; }

// The buffers of Rtxdi_GetBuffer.
enum RtxdiBuffer {
    Tasks = 0,
    LightData = 1,
    GeometryInstanceToLight = 2,
    NeighborOffsets = 3,
    LightReservoirs = 4
}

// The host side of NVIDIA's RTXDI Minimal Sample (github.com/NVIDIA-RTX/RTXDI, Samples/MinimalSample) that
// depends on its shaders: the buffers they read and write, the CPU half of the light preparation and the
// resampling constants with the sample's settings; examples/rtxdi_minimal.ts runs the sample's two compute
// shaders on them. Free the resources with Rtxdi_DestroyResources before the app.

// The shaders' buffers on the app's device (Donut_GetNvrhiDevice), sized for the scene: the task and light
// buffers for the geometries whose material's emissive color isn't black (one element where there are none),
// the geometry instance to light map, the neighbor offsets (RG8_SNORM, typed; written by
// Rtxdi_InitializeNeighborOffsets) and the light reservoirs (the context's size, three buffers). Null (after
// logging why) without a context or scene.
@nodrops declare function Rtxdi_CreateResources(app: AppHandle, context: RtxdiDIContextHandle, scene: SceneHandle): RtxdiResourcesHandle | null;
@nodrops declare function Rtxdi_DestroyResources(resources: RtxdiResourcesHandle): void;
// One of the resources' buffers (the resources': don't release it). Null (logged) for an index out of range.
@nodrops declare function Rtxdi_GetBuffer(resources: RtxdiResourcesHandle, which: RtxdiBuffer): BufferHandle;
// The resampling constant buffer (ResamplingConstants, volatile), made once, after the resources. PrepareLights'
// constants (PrepareLightsConstants: numTasks) are push constants, as the sample's: push
// Rtxdi_GetPrepareLightsTaskCount's value (Donut_LayoutPushConstants, Donut_BindPushConstants).
@nodrops declare function Rtxdi_CreateConstantBuffers(app: AppHandle, resources: RtxdiResourcesHandle): void;
@nodrops declare function Rtxdi_GetResamplingConstantBuffer(resources: RtxdiResourcesHandle): BufferHandle;

// The CPU half of the light preparation, on the command list: the emissive geometries (emissive color not black,
// intensity above zero) laid out one after the other in the light buffer, their tasks (one per geometry, as
// PrepareLightsTask) and the geometry instance to light map (RTXDI_INVALID_LIGHT_INDEX for the others) written to
// their buffers, and the light buffer parameters kept for Rtxdi_WriteResamplingConstants (all lights local, no
// environment light). Returns the number of lights (emissive triangles): dispatch the PrepareLights shader for
// div_ceil(count, 256) groups of 256 (none for 0).
@nodrops declare function Rtxdi_PrepareLights(resources: RtxdiResourcesHandle, scene: SceneHandle, commandList: CommandListHandle): int;
// The task count of the last Rtxdi_PrepareLights: PrepareLightsConstants::numTasks, to push to the shader.
@nodrops declare function Rtxdi_GetPrepareLightsTaskCount(resources: RtxdiResourcesHandle): int;

// The frame's ResamplingConstants, written to the constant buffer on the command list: the two views' constants,
// the runtime parameters and reservoir buffer indices from the context (frame index, the last frame's and this
// frame's buffers), the light buffer parameters Rtxdi_PrepareLights kept, the sample's fixed resampling values
// and the settings of its window: resampling on or off, unbiased mode (non-zero: ray traced bias correction in
// the spatio-temporal resampling, else basic), the initial local light and BRDF samples, the BRDF cutoff, the
// spatial samples (Rtxdi_GetDefaultSettings' at the start).
@nodrops declare function Rtxdi_WriteResamplingConstants(resources: RtxdiResourcesHandle, context: RtxdiDIContextHandle,
    commandList: CommandListHandle, view: ViewHandle, prevView: ViewHandle, enableResampling: int, unbiasedMode: int,
    numLocalLightSamples: int, numBrdfSamples: int, brdfCutoff: number, numSpatialSamples: int): void;
// The sample's start values of the four settings its window changes, into dst: the initial local light samples,
// the initial BRDF samples, the BRDF cutoff and the spatial samples.
@nodrops declare function Rtxdi_GetDefaultSettings(dst: Ref<f32>): void;

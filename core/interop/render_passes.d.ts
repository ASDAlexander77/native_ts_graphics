/// <reference path="../donut_handles.d.ts" />
// Donut's render passes: forward and deferred shading, G-buffer, shadow maps, TAA, tone
// mapping, bloom, SSAO, sky and environment maps, light probes, cubemaps, draw batches

// Textures of Donut_GetGBufferTexture.
enum GBufferTexture {
    Depth = 0,
    Diffuse = 1,
    Specular = 2,
    Normals = 3,
    Emissive = 4,
    // Donut_CreateGBufferTargetsWithMotionVectors' only.
    MotionVectors = 5
}

// Textures of Donut_GetTemporalTargetsTexture.
enum TemporalTexture {
    Depth = 0,
    HdrColor = 1,
    ResolvedColor = 2,
    MotionVectors = 3
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
// numConstantBufferVersions bounds how many views it can render per frame.
@nodrops declare function Donut_CreateForwardShadingPass(app: AppHandle, numConstantBufferVersions: int): ForwardShadingPassHandle;
// Cube map render target, resolution x resolution faces: SRGBA8 color, D32 depth.
@nodrops declare function Donut_CreateCubemapTarget(app: AppHandle, resolution: int): CubemapTargetHandle;
// One array slice per face; valid as long as the target.
@nodrops declare function Donut_GetCubemapColorTexture(cubemapTarget: CubemapTargetHandle): TextureHandle;
@nodrops declare function Donut_SetCubemapViewFromCamera(cubemapTarget: CubemapTargetHandle, camera: CameraHandle, zNear: number, cullDistance: number): void;
// Records the scene as seen by one cube face (0..5) into commandList, opening and closing it.
@nodrops declare function Donut_RenderCubemapFace(cubemapTarget: CubemapTargetHandle, face: int, commandList: CommandListHandle, scene: SceneHandle, forwardShadingPass: ForwardShadingPassHandle): void;
// Same, on the app's worker threads (it runs C++ only); each concurrent task needs its own
// command list from Donut_CreateDeferredCommandList. Wait with Donut_WaitForTasks.
@nodrops declare function Donut_RenderCubemapFaceAsync(app: AppHandle, cubemapTarget: CubemapTargetHandle, face: int, commandList: CommandListHandle, scene: SceneHandle, forwardShadingPass: ForwardShadingPassHandle): void;
@nodrops declare function Donut_WaitForTasks(app: AppHandle): void;
// For recording on another thread and executing later.
@nodrops declare function Donut_CreateDeferredCommandList(app: AppHandle): CommandListHandle;
// Indexed draws described up front, to record into command lists on worker threads (where tslang
// code mustn't run) or to replay as a whole (as a D3D12 bundle): one pipeline (or one per draw),
// framebuffer (its whole viewport), vertex buffer (slot 0) and R32_UINT index buffer; binding sets
// every draw uses, then per draw an optional binding set of its own and its index range.
@nodrops declare function Donut_CreateDrawBatch(app: AppHandle, pipeline: GraphicsPipelineHandle, framebuffer: FramebufferHandle,
    vertexBuffer: BufferHandle, indexBuffer: BufferHandle): DrawBatchHandle;
// A binding set every draw uses, in the pipeline's binding layout order; add them before the draws.
@nodrops declare function Donut_DrawBatchAddBindingSet(drawBatch: DrawBatchHandle, bindingSet: BindingSetHandle): void;
// A draw of indexCount indices from startIndex, offset by baseVertex, with its own binding set
// (null for none) after the shared ones.
@nodrops declare function Donut_DrawBatchAddDraw(drawBatch: DrawBatchHandle, bindingSet: BindingSetHandle | null, indexCount: int, startIndex: int, baseVertex: int): void;
// Same, with a pipeline of its own (for the batch's framebuffer and binding layouts) instead of the
// batch's.
@nodrops declare function Donut_DrawBatchAddDrawWithPipeline(drawBatch: DrawBatchHandle, pipeline: GraphicsPipelineHandle, bindingSet: BindingSetHandle | null,
    indexCount: int, startIndex: int, baseVertex: int): void;
@nodrops declare function Donut_GetDrawBatchDrawCount(drawBatch: DrawBatchHandle): int;
// Records all the batch's draws into an open command list (e.g. the frame's), as a D3D12 command
// list executes a bundle.
@nodrops declare function Donut_ExecuteDrawBatch(drawBatch: DrawBatchHandle, commandList: CommandListHandle): void;
// Records the batch's draws first, first + step, ... into commandList, opening and closing it.
@nodrops declare function Donut_RecordDrawBatch(drawBatch: DrawBatchHandle, commandList: CommandListHandle, first: int, step: int): void;
// Same, as a task on the app's thread pool: wait with Donut_WaitForTasks before executing the
// command list (Donut_CreateDeferredCommandList; one per concurrent task).
@nodrops declare function Donut_RecordDrawBatchAsync(app: AppHandle, drawBatch: DrawBatchHandle, commandList: CommandListHandle, first: int, step: int): void;

// Deferred shading. G-buffer of width x height pixels plus an RGBA16_FLOAT texture for the lit
// result; create new ones when the frame size changes. reverseDepth != 0 clears depth to 0, for
// reverse-Z projections.
@nodrops declare function Donut_CreateGBufferTargets(app: AppHandle, width: int, height: int, reverseDepth: int): GBufferTargetsHandle;
// For Donut_BlitTexture, or as a UAV; valid as long as the targets.
@nodrops declare function Donut_GetGBufferShadedColor(gbufferTargets: GBufferTargetsHandle): TextureHandle;
// One of the G-buffer textures, e.g. to bind to a shader decoding the G-buffer; valid as long as
// the targets.
@nodrops declare function Donut_GetGBufferTexture(gbufferTargets: GBufferTargetsHandle, which: GBufferTexture): TextureHandle;
@nodrops declare function Donut_CreateGBufferFillPass(app: AppHandle): GBufferFillPassHandle;
@nodrops declare function Donut_CreateDeferredLightingPass(app: AppHandle): DeferredLightingPassHandle;
// Drops the pass's cached references to G-buffer textures.
@nodrops declare function Donut_ResetDeferredLightingBindingCache(deferredLightingPass: DeferredLightingPassHandle): void;
// These four are valid only inside a render callback.
@nodrops declare function Donut_ClearGBuffer(frame: FrameHandle, gbufferTargets: GBufferTargetsHandle): void;
// Draws the mesh instance of a Donut_AddMeshNode node into the G-buffer, back faces culled.
@nodrops declare function Donut_RenderMeshNodeToGBuffer(frame: FrameHandle, gbufferFillPass: GBufferFillPassHandle, view: ViewHandle, gbufferTargets: GBufferTargetsHandle, meshNode: NodeHandle): void;
// Draws the opaque meshes of a loaded scene into the G-buffer.
@nodrops declare function Donut_RenderSceneToGBuffer(frame: FrameHandle, gbufferFillPass: GBufferFillPassHandle, view: ViewHandle, gbufferTargets: GBufferTargetsHandle, scene: SceneHandle): void;
// Lights the G-buffer with the scene graph's lights plus a top / bottom ambient term, into the
// targets' shaded color texture.
@nodrops declare function Donut_RenderDeferredLighting(frame: FrameHandle, deferredLightingPass: DeferredLightingPassHandle, view: ViewHandle, gbufferTargets: GBufferTargetsHandle,
    sceneGraph: SceneGraphHandle, topR: number, topG: number, topB: number, bottomR: number, bottomG: number, bottomB: number): void;
// Valid only inside a render callback: the transparent meshes of a loaded scene, forward-shaded
// over the targets' shaded color, depth-tested against the G-buffer depth.
@nodrops declare function Donut_RenderSceneTransparentOverGBuffer(frame: FrameHandle, forwardShadingPass: ForwardShadingPassHandle, view: ViewHandle, gbufferTargets: GBufferTargetsHandle,
    scene: SceneHandle, topR: number, topG: number, topB: number, bottomR: number, bottomG: number, bottomB: number): void;

// Forward shading with TAA. Targets of width x height pixels: RGBA16_FLOAT HDR color and D24S8
// depth (cleared for reverse Z) to render into, motion vectors, and the TAA resolved color and
// feedback; create new ones when the frame size changes.
@nodrops declare function Donut_CreateTemporalTargets(app: AppHandle, width: int, height: int): TemporalTargetsHandle;
// Valid as long as the targets.
@nodrops declare function Donut_GetTemporalTargetsTexture(temporalTargets: TemporalTargetsHandle, which: TemporalTexture): TextureHandle;
// Rendering into the targets uses this surface whenever the view enables variable rate shading;
// set it before the first draw into them.
@nodrops declare function Donut_SetTemporalTargetsShadingRateSurface(temporalTargets: TemporalTargetsHandle, shadingRateSurface: TextureHandle): void;
// TAA over the targets (Catmull-Rom filter, stencil mask 0x01), for views like `view`; create a
// new one with new targets.
@nodrops declare function Donut_CreateTemporalAntiAliasingPass(app: AppHandle, view: ViewHandle, temporalTargets: TemporalTargetsHandle): TemporalAntiAliasingPassHandle;
// These four are valid only inside a render callback.
// Depth to 0 (reverse Z), HDR color to black.
@nodrops declare function Donut_ClearTemporalTargets(frame: FrameHandle, temporalTargets: TemporalTargetsHandle): void;
// A loaded scene, opaque then transparent meshes, with a Donut_CreateForwardShadingPass pass, lit
// by the scene graph's lights plus a top / bottom ambient term.
@nodrops declare function Donut_RenderSceneForward(frame: FrameHandle, forwardShadingPass: ForwardShadingPassHandle, view: ViewHandle, temporalTargets: TemporalTargetsHandle, scene: SceneHandle,
    topR: number, topG: number, topB: number, bottomR: number, bottomG: number, bottomB: number): void;
@nodrops declare function Donut_RenderMotionVectors(frame: FrameHandle, temporalAntiAliasingPass: TemporalAntiAliasingPassHandle, view: ViewHandle, previousView: ViewHandle): void;
// HDR color into the resolved color; feedbackIsValid 0 when there's no history yet.
@nodrops declare function Donut_TemporalResolve(frame: FrameHandle, temporalAntiAliasingPass: TemporalAntiAliasingPassHandle, view: ViewHandle, feedbackIsValid: int): void;
// The shadow map (Donut_CreateCascadedShadowMap) the light casts shadows with, or null for none.
@nodrops declare function Donut_SetLightShadowMap(light: LightHandle, shadowMap: ShadowMapHandle | null): void;

// Render targets of width x height (multisampled with sampleCount > 1): the G-buffer with motion
// vectors and reverse-Z depth, HDR color, material IDs, resolved color, TAA feedback, LDR color,
// ambient occlusion. Create new ones when the size or sample count changes.
@nodrops declare function Donut_CreateSceneRenderTargets(app: AppHandle, width: int, height: int, sampleCount: int): SceneRenderTargetsHandle;
@nodrops declare function Donut_ClearSceneRenderTargets(commandList: CommandListHandle, sceneRenderTargets: SceneRenderTargetsHandle): void;
@nodrops declare function Donut_GetSceneRenderTargetsTexture(sceneRenderTargets: SceneRenderTargetsHandle, which: SceneTexture): TextureHandle;
@nodrops declare function Donut_GetSceneRenderTargetsFramebuffer(sceneRenderTargets: SceneRenderTargetsHandle, which: SceneFramebuffer): FramebufferFactoryHandle;

// Shadows.
@nodrops declare function Donut_CreateCascadedShadowMap(app: AppHandle, resolution: int, numCascades: int): ShadowMapHandle;
// A light's shadow map in `slices` slices of a new array texture of arraySize slices: the first a cascade,
// the others per-object shadows (shading multiplies them in), each fitted with
// Donut_SetupShadowMapViewForBounds. Other lights' go in its other slices (Donut_CreateSlicedShadowMapSharing):
// the forward pass binds one shadow map texture for all lights.
@nodrops declare function Donut_CreateSlicedShadowMap(app: AppHandle, resolution: int, arraySize: int, slices: int): ShadowMapHandle;
// Another light's, in `slices` slices of that shadow map's texture from firstSlice; null if they aren't in it.
@nodrops declare function Donut_CreateSlicedShadowMapSharing(app: AppHandle, shadowMap: ShadowMapHandle, firstSlice: int, slices: int): ShadowMapHandle | null;
// A planar shadow map: one orthographic view for a directional light, fitted with
// Donut_SetupPlanarShadowMapForScene (the cascade fitting functions leave it unchanged).
@nodrops declare function Donut_CreatePlanarShadowMap(app: AppHandle, resolution: int): ShadowMapHandle;
// Fits a planar shadow map to a directional light and the whole scene graph's bounds, shadows
// fading out over fadeRangeWorld at its edges. 1 if the view changed (render the shadow map again).
@nodrops declare function Donut_SetupPlanarShadowMapForScene(shadowMap: ShadowMapHandle, light: LightHandle, sceneGraph: SceneGraphHandle, fadeRangeWorld: number): int;
// Fits one view (a planar shadow map's 0, a sliced one's index-th slice, else a cascade below the cascade count
// or the per-object shadow index - cascades) to a directional light and world-space bounds of 6 floats (min x, y, z, max x, y, z).
// Fitting a cascade makes the shadow map use at least that many. 1 if the view changed.
@nodrops declare function Donut_SetupShadowMapViewForBounds(shadowMap: ShadowMapHandle, light: LightHandle, index: int, bounds: Ref<f32>, fadeRangeWorld: number): int;
// One array slice per cascade (one for a planar shadow map).
@nodrops declare function Donut_GetShadowMapTexture(shadowMap: ShadowMapHandle): TextureHandle;
// Fits the cascades to a directional light and the view, out to maxShadowDistance (stable).
@nodrops declare function Donut_SetupShadowMapForView(shadowMap: ShadowMapHandle, light: LightHandle, view: ViewHandle, maxShadowDistance: number, zRange: number, exponent: number): void;
@nodrops declare function Donut_ClearShadowMap(commandList: CommandListHandle, shadowMap: ShadowMapHandle): void;
@nodrops declare function Donut_CreateShadowDepthPass(app: AppHandle, depthBias: int, slopeScaledDepthBias: number): DepthPassHandle;
@nodrops declare function Donut_ResetDepthPassBindingCache(depthPass: DepthPassHandle): void;
// Opaque meshes into all cascades; materialEvents != 0: a GPU marker per material.
@nodrops declare function Donut_RenderShadowDepth(commandList: CommandListHandle, depthPass: DepthPassHandle, shadowMap: ShadowMapHandle, sceneGraph: SceneGraphHandle, materialEvents: int): void;
// Into one view (Donut_SetupShadowMapViewForBounds's index), e.g. a per-object shadow, which the above leaves out.
@nodrops declare function Donut_RenderShadowDepthView(commandList: CommandListHandle, depthPass: DepthPassHandle, shadowMap: ShadowMapHandle, index: int, sceneGraph: SceneGraphHandle): void;

// Geometry passes.
// singlePassCubemap != 0 renders cube map views in one pass (Feature.FastGeometryShader).
@nodrops declare function Donut_CreateForwardShadingPassWithOptions(app: AppHandle, singlePassCubemap: int, trackLiveness: int): ForwardShadingPassHandle;
// A forward shading pass whose pixel shader is the example's own: fileName in bin/shaders/<example>
// (entry point main, the bindings and inputs of Donut's forward_ps.hlsl).
@nodrops declare function Donut_CreateForwardShadingPassWithPixelShader(app: AppHandle, fileName: string, numConstantBufferVersions: int): ForwardShadingPassHandle;
@nodrops declare function Donut_ResetForwardShadingBindingCache(forwardShadingPass: ForwardShadingPassHandle): void;
// The lights a forward shading pass renders with, kept between its draws.
@nodrops declare function Donut_CreateForwardShadingContext(app: AppHandle): ForwardShadingContextHandle;
// A scene graph's lights, top / bottom ambient, and the enabled probes of a set (or null).
@nodrops declare function Donut_PrepareForwardLights(commandList: CommandListHandle, forwardShadingPass: ForwardShadingPassHandle, forwardShadingContext: ForwardShadingContextHandle, sceneGraph: SceneGraphHandle, topR: number, topG: number, topB: number, bottomR: number, bottomG: number, bottomB: number, lightProbeSet: LightProbeSetHandle | null): void;
// Opaque (transparent == 0) or transparent meshes into a framebuffer; previousView may be null.
@nodrops declare function Donut_RenderForward(commandList: CommandListHandle, forwardShadingPass: ForwardShadingPassHandle, forwardShadingContext: ForwardShadingContextHandle, view: ViewHandle, previousView: ViewHandle | null, framebuffer: FramebufferFactoryHandle, sceneGraph: SceneGraphHandle, transparent: int, name: string, materialEvents: int): void;
// enableMotionVectors != 0 writes motion vectors, and stencilWriteMask into the stencil there.
@nodrops declare function Donut_CreateGBufferFillPassWithOptions(app: AppHandle, enableMotionVectors: int, stencilWriteMask: int): GBufferFillPassHandle;
@nodrops declare function Donut_ResetGBufferFillBindingCache(gbufferFillPass: GBufferFillPassHandle): void;
@nodrops declare function Donut_RenderGBufferFill(commandList: CommandListHandle, gbufferFillPass: GBufferFillPassHandle, view: ViewHandle, previousView: ViewHandle, sceneRenderTargets: SceneRenderTargetsHandle, sceneGraph: SceneGraphHandle, materialEvents: int): void;
// Writes each pixel's material ID and instance index.
@nodrops declare function Donut_CreateMaterialIDPass(app: AppHandle, stencilWriteMask: int): MaterialIdPassHandle;
@nodrops declare function Donut_RenderMaterialIDs(commandList: CommandListHandle, materialIdPass: MaterialIdPassHandle, view: ViewHandle, previousView: ViewHandle, sceneRenderTargets: SceneRenderTargetsHandle, sceneGraph: SceneGraphHandle, transparent: int): void;
// Lights the G-buffer into HDR color; the targets' ambient occlusion if useAmbientOcclusion != 0,
// and a light probe set (or null).
@nodrops declare function Donut_RenderDeferredLightingToHdr(commandList: CommandListHandle, deferredLightingPass: DeferredLightingPassHandle, view: ViewHandle, sceneRenderTargets: SceneRenderTargetsHandle, sceneGraph: SceneGraphHandle, useAmbientOcclusion: boolean, topR: number, topG: number, topB: number, bottomR: number, bottomG: number, bottomB: number, lightProbeSet: LightProbeSetHandle | null): void;

// Post-processing and other passes.
// Single-sample targets only; renders with default parameters.
@nodrops declare function Donut_CreateSsaoPass(app: AppHandle, sceneRenderTargets: SceneRenderTargetsHandle): SsaoPassHandle;
@nodrops declare function Donut_RenderSsao(commandList: CommandListHandle, ssaoPass: SsaoPassHandle, view: ViewHandle): void;
@nodrops declare function Donut_CreateSkyPass(app: AppHandle, framebuffer: FramebufferFactoryHandle, view: ViewHandle): SkyPassHandle;
// A lat-long (2D) or cube map environment texture drawn where the framebuffer's depth is still
// clear; set the view up before creating it (its depth direction picks the pipeline).
@nodrops declare function Donut_CreateEnvironmentMapPass(app: AppHandle, framebuffer: FramebufferFactoryHandle, view: ViewHandle, environmentMap: TextureHandle): EnvironmentMapPassHandle;
@nodrops declare function Donut_RenderEnvironmentMap(commandList: CommandListHandle, environmentMapPass: EnvironmentMapPassHandle, view: ViewHandle): void;
// Around a directional light; other SkyParameters keep their defaults.
@nodrops declare function Donut_RenderSky(commandList: CommandListHandle, skyPass: SkyPassHandle, view: ViewHandle, light: LightHandle, brightness: number, glowSize: number, glowSharpness: number, glowIntensity: number, horizonSize: number): void;
@nodrops declare function Donut_CreateSceneTemporalAntiAliasingPass(app: AppHandle, view: ViewHandle, sceneRenderTargets: SceneRenderTargetsHandle, motionVectorStencilMask: int): TemporalAntiAliasingPassHandle;
@nodrops declare function Donut_SetTemporalJitter(temporalAntiAliasingPass: TemporalAntiAliasingPassHandle, jitter: TemporalJitter): void;
// This frame's jitter, 2 floats into dst.
@nodrops declare function Donut_GetTemporalPixelOffset(temporalAntiAliasingPass: TemporalAntiAliasingPassHandle, dst: Ref<f32>): void;
@nodrops declare function Donut_RenderViewMotionVectors(commandList: CommandListHandle, temporalAntiAliasingPass: TemporalAntiAliasingPassHandle, view: ViewHandle, previousView: ViewHandle): void;
@nodrops declare function Donut_TemporalResolveView(commandList: CommandListHandle, temporalAntiAliasingPass: TemporalAntiAliasingPassHandle, view: ViewHandle, feedbackIsValid: int, enableHistoryClamping: int): void;
@nodrops declare function Donut_AdvanceTemporalFrame(temporalAntiAliasingPass: TemporalAntiAliasingPassHandle): void;
// Pass the tone mapping pass this one replaces (or null) to keep its adapted exposure.
@nodrops declare function Donut_CreateToneMappingPass(app: AppHandle, framebuffer: FramebufferFactoryHandle, view: ViewHandle, previousToneMappingPass: ToneMappingPassHandle | null): ToneMappingPassHandle;
@nodrops declare function Donut_AdvanceToneMappingFrame(toneMappingPass: ToneMappingPassHandle, elapsedSeconds: number): void;
@nodrops declare function Donut_ResetExposure(commandList: CommandListHandle, toneMappingPass: ToneMappingPassHandle, initialExposure: number): void;
// Default parameters. instantAdaptation != 0: the exposure set to this frame's at once (as after
// Donut_ResetExposure); else adapted over Donut_AdvanceToneMappingFrame's time (kept while that's 0).
@nodrops declare function Donut_RenderToneMapping(commandList: CommandListHandle, toneMappingPass: ToneMappingPassHandle, view: ViewHandle, sourceTexture: TextureHandle, instantAdaptation: int): void;
// With the exposure: the scale exp2(exposureBias) over the adapted luminance, adapted within
// [minAdaptedLuminance, maxAdaptedLuminance] (Donut's defaults: -0.5, 0.02, 0.5).
@nodrops declare function Donut_RenderToneMappingWithExposure(commandList: CommandListHandle, toneMappingPass: ToneMappingPassHandle, view: ViewHandle, sourceTexture: TextureHandle, instantAdaptation: int,
    exposureBias: number, minAdaptedLuminance: number, maxAdaptedLuminance: number): void;
@nodrops declare function Donut_CreateBloomPass(app: AppHandle, framebuffer: FramebufferFactoryHandle, view: ViewHandle): BloomPassHandle;
@nodrops declare function Donut_RenderBloom(commandList: CommandListHandle, bloomPass: BloomPassHandle, framebuffer: FramebufferFactoryHandle, view: ViewHandle, sourceTexture: TextureHandle, sigma: number, alpha: number): void;
// Passes over render targets an example lays out itself (streamline_demo's): a G-buffer as
// Donut_CreateGBufferTargets', with motion vectors (written by the G-buffer fill and TAA's camera motion pass).
@nodrops declare function Donut_CreateGBufferTargetsWithMotionVectors(app: AppHandle, width: int, height: int, reverseDepth: int): GBufferTargetsHandle;
// The G-buffer's framebuffer (its textures and depth); valid as long as the targets.
@nodrops declare function Donut_GetGBufferFramebuffer(gbufferTargets: GBufferTargetsHandle): FramebufferFactoryHandle;
// A framebuffer factory over a color target and / or a depth target (either may be null), for the passes
// that draw into one (sky, bloom, tone mapping, Donut_BlitTextureToFramebuffer); release it with the textures.
@nodrops declare function Donut_CreateFramebufferFactory(app: AppHandle, colorTexture: TextureHandle | null, depthTexture: TextureHandle | null): FramebufferFactoryHandle;
// Stretches a texture over a framebuffer factory's framebuffer for view.
@nodrops declare function Donut_BlitTextureToFramebuffer(app: AppHandle, commandList: CommandListHandle, framebuffer: FramebufferFactoryHandle,
    view: ViewHandle, texture: TextureHandle): void;
// Donut_RenderGBufferFill into a Donut_CreateGBufferTargetsWithMotionVectors G-buffer.
@nodrops declare function Donut_RenderGBufferFillTargets(commandList: CommandListHandle, gbufferFillPass: GBufferFillPassHandle, view: ViewHandle,
    previousView: ViewHandle, gbufferTargets: GBufferTargetsHandle, sceneGraph: SceneGraphHandle): void;
// Lights the G-buffer into output (a UAV texture): the scene graph's lights, ambient between the top and
// bottom colors, times ambientOcclusion (null for none).
@nodrops declare function Donut_RenderDeferredLightingTargets(commandList: CommandListHandle, deferredLightingPass: DeferredLightingPassHandle,
    view: ViewHandle, gbufferTargets: GBufferTargetsHandle, ambientOcclusion: TextureHandle | null, topR: number, topG: number, topB: number,
    bottomR: number, bottomG: number, bottomB: number, sceneGraph: SceneGraphHandle, output: TextureHandle): void;
// Donut's SSAO from depth and G-buffer normals into an R8 UAV texture; render it with Donut_RenderSsao.
@nodrops declare function Donut_CreateSsaoPassForTextures(app: AppHandle, depth: TextureHandle, normals: TextureHandle, output: TextureHandle): SsaoPassHandle;
// Donut's TAA over textures: resolves unresolvedColor into resolvedColor (Catmull-Rom filtering), with motion
// vectors where the stencil has motionVectorStencilMask set.
@nodrops declare function Donut_CreateTemporalAntiAliasingPassForTextures(app: AppHandle, view: ViewHandle, depth: TextureHandle,
    motionVectors: TextureHandle, unresolvedColor: TextureHandle, resolvedColor: TextureHandle, feedback1: TextureHandle,
    feedback2: TextureHandle, motionVectorStencilMask: int): TemporalAntiAliasingPassHandle;
// Donut_RenderSky with the light's radiance clamped at maxLightRadiance (100 in SkyParameters' defaults).
@nodrops declare function Donut_RenderSkyClamped(commandList: CommandListHandle, skyPass: SkyPassHandle, view: ViewHandle, light: LightHandle,
    brightness: number, glowSize: number, glowSharpness: number, glowIntensity: number, horizonSize: number, maxLightRadiance: number): void;
// Tone mapping with the eye adaptation's parameters (Donut's defaults: speeds 1 up, 0.5 down, the adapted
// luminance within 0.02 .. 0.5, exposure bias -0.5).
@nodrops declare function Donut_RenderToneMappingAdapted(commandList: CommandListHandle, toneMappingPass: ToneMappingPassHandle, view: ViewHandle,
    sourceTexture: TextureHandle, eyeAdaptationSpeedUp: number, eyeAdaptationSpeedDown: number, minAdaptedLuminance: number,
    maxAdaptedLuminance: number, exposureBias: number): void;
// Donut_SetupShadowMapForView with the view's frustum grown by `grow` first.
@nodrops declare function Donut_SetupShadowMapForGrownView(shadowMap: ShadowMapHandle, light: LightHandle, view: ViewHandle, grow: number,
    maxShadowDistance: number, zRange: number, exponent: number): void;
// One pixel of a texture: capture, execute (Donut_FlushFrameCommandList), then read 4 ints into dst.
@nodrops declare function Donut_CreatePixelReadbackPass(app: AppHandle, texture: TextureHandle): PixelReadbackPassHandle;
@nodrops declare function Donut_CapturePixel(commandList: CommandListHandle, pixelReadbackPass: PixelReadbackPassHandle, x: int, y: int): void;
@nodrops declare function Donut_ReadPixelUInts(pixelReadbackPass: PixelReadbackPassHandle, dst: Ref<int>): void;
// Mip generation for a color texture with mips; Display draws them over the frame.
@nodrops declare function Donut_CreateMipMapGenPass(app: AppHandle, texture: TextureHandle): MipMapGenPassHandle;
@nodrops declare function Donut_DispatchMipMapGen(commandList: CommandListHandle, mipMapGenPass: MipMapGenPassHandle): void;
@nodrops declare function Donut_DisplayMipMapGen(app: AppHandle, frame: FrameHandle, mipMapGenPass: MipMapGenPassHandle): void;

// Light probes.
// numProbes probes named "1", "2", ..., disabled until rendered.
@nodrops declare function Donut_CreateLightProbeSet(app: AppHandle, numProbes: int): LightProbeSetHandle;
@nodrops declare function Donut_GetLightProbeCount(lightProbeSet: LightProbeSetHandle): int;
@nodrops declare function Donut_GetLightProbeName(lightProbeSet: LightProbeSetHandle, index: int): string;
@nodrops declare function Donut_IsLightProbeEnabled(lightProbeSet: LightProbeSetHandle, index: int): int;
@nodrops declare function Donut_SetLightProbeEnabled(lightProbeSet: LightProbeSetHandle, index: int, enabled: boolean): void;
@nodrops declare function Donut_SetLightProbeScales(lightProbeSet: LightProbeSetHandle, index: int, diffuseScale: number, specularScale: number): void;
@nodrops declare function Donut_GetLightProbeSpecularMipLevels(lightProbeSet: LightProbeSetHandle): int;
@nodrops declare function Donut_CreateLightProbeProcessingPass(app: AppHandle): LightProbeProcessingPassHandle;
@nodrops declare function Donut_ResetLightProbeProcessingCaches(lightProbeProcessingPass: LightProbeProcessingPassHandle): void;
// An environment cube map (size x size, mipLevels mips) with depth, and its cube map view.
@nodrops declare function Donut_CreateLightProbeCapture(app: AppHandle, size: int, mipLevels: int): LightProbeCaptureHandle;
@nodrops declare function Donut_SetLightProbeCaptureTransform(lightProbeCapture: LightProbeCaptureHandle, x: number, y: number, z: number, zNear: number, cullDistance: number): void;
@nodrops declare function Donut_GetLightProbeCaptureView(lightProbeCapture: LightProbeCaptureHandle): ViewHandle;
@nodrops declare function Donut_GetLightProbeCaptureFramebuffer(lightProbeCapture: LightProbeCaptureHandle): FramebufferFactoryHandle;
@nodrops declare function Donut_ClearLightProbeCapture(commandList: CommandListHandle, lightProbeCapture: LightProbeCaptureHandle): void;
@nodrops declare function Donut_SetupShadowMapForLightProbeCapture(shadowMap: ShadowMapHandle, light: LightHandle, lightProbeCapture: LightProbeCaptureHandle, cullDistance: number, zRange: number, exponent: number): void;
@nodrops declare function Donut_GenerateLightProbeCaptureMips(commandList: CommandListHandle, lightProbeProcessingPass: LightProbeProcessingPassHandle, lightProbeCapture: LightProbeCaptureHandle): void;
@nodrops declare function Donut_RenderLightProbeDiffuse(commandList: CommandListHandle, lightProbeProcessingPass: LightProbeProcessingPassHandle, lightProbeCapture: LightProbeCaptureHandle, lightProbeSet: LightProbeSetHandle, index: int): void;
@nodrops declare function Donut_RenderLightProbeSpecular(commandList: CommandListHandle, lightProbeProcessingPass: LightProbeProcessingPassHandle, lightProbeCapture: LightProbeCaptureHandle, lightProbeSet: LightProbeSetHandle, index: int, roughness: number, mipLevel: int): void;
@nodrops declare function Donut_RenderEnvironmentBrdf(commandList: CommandListHandle, lightProbeProcessingPass: LightProbeProcessingPassHandle): void;
// Once the GPU is done: enables the probe within 10 units of where it was rendered from.
@nodrops declare function Donut_FinishLightProbe(lightProbeSet: LightProbeSetHandle, index: int, lightProbeProcessingPass: LightProbeProcessingPassHandle, x: number, y: number, z: number): void;

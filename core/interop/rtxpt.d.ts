/// <reference path="../donut_handles.d.ts" />
// RTX Path Tracing (core/rtxpt.cpp; the rtxpt example links it)

// Handles of the module's objects (see donut_handles.d.ts).
@cpp declare class RtxptRendererHandle { private readonly __rtxptRenderer: index; }

// Makes the sample's code find bin/ShaderDynamic (its run-time shader compiler and sources) next to the
// module holding it, under the JIT too: false if it isn't there.
@nodrops declare function Donut_RtxptSetup(): boolean;
// The sample's renderer (its scene, materials, lights, environment map, path tracer pipelines, render
// targets and passes) on the app's device (Donut_GetNvrhiDevice); assetsDirectory is RTXPT_DIR/Assets, which
// the scenes' materials and environment maps are found from. Null without bin/ShaderDynamic.
@nodrops declare function Donut_RtxptRendererCreate(device: Opaque, assetsDirectory: string): RtxptRendererHandle | null;
@nodrops declare function Donut_RtxptRendererDestroy(rtxptRenderer: RtxptRendererHandle): void;
// Starts loading a *.scene.json (absolute path) on a thread, as Donut's SceneLoader, dropping the current scene; poll
// Donut_RtxptRendererUpdateLoading every frame (between frames): 0 still loading, 1 just loaded (then the game's step and
// Donut_RtxptRendererFinishLoadingScene), 2 loaded before, -1 failed. The loading stats as Donut_GetSceneLoadingStats'
// 4 ints (objects loaded, objects total, textures loaded, textures requested).
@nodrops declare function Donut_RtxptRendererBeginLoadingScene(rtxptRenderer: RtxptRendererHandle, scenePath: string): void;
@nodrops declare function Donut_RtxptRendererUpdateLoading(rtxptRenderer: RtxptRendererHandle): int;
@nodrops declare function Donut_RtxptRendererGetSceneLoadingStats(rtxptRenderer: RtxptRendererHandle, dst: Ref<int>): void;
// The rest of the scene's loading, after the game's step (SampleGame's GameScene::SceneLoaded).
@nodrops declare function Donut_RtxptRendererFinishLoadingScene(rtxptRenderer: RtxptRendererHandle): boolean;
// SampleGame (core/rtxpt_game.ts): whether the scene has a GameSettings node (an RTXPT node type).
@nodrops declare function Donut_RtxptRendererHasGameSettings(rtxptRenderer: RtxptRendererHandle): boolean;
// The loaded scene (an ExtendedScene, a Donut Scene), or null: the game edits its graph (Donut_GetSceneGraph).
@nodrops declare function Donut_RtxptRendererGetScene(rtxptRenderer: RtxptRendererHandle): SceneHandle | null;
@nodrops declare function Donut_RtxptRendererGetSceneCameraCount(rtxptRenderer: RtxptRendererHandle): int;
// The scene's camera `index` into 16 floats: position, direction, up, vertical field of view, near plane, then its
// exposure (auto exposure 0/1, compensation, value, min, max; NaN where the scene doesn't set it). False if none.
@nodrops declare function Donut_RtxptRendererGetSceneCamera(rtxptRenderer: RtxptRendererHandle, index: int, out: Ref<f32>): boolean;
// The scene's sample settings, NaN where unset: 0 realtime mode, 1 animations, 2 starting camera, 3 real-time
// firefly filter, 4 max bounces, 5 max diffuse bounces, 6 texture MIP bias, 7 the environment light's intensity.
@nodrops declare function Donut_RtxptRendererGetSceneSetting(rtxptRenderer: RtxptRendererHandle, key: int): number;
// The scene's togglable nodes (named *_togglable, or *_togglable_off: hidden at load), for the UI: their names
// without the suffix, and whether they're shown. Showing or hiding one moves it back or far away.
@nodrops declare function Donut_RtxptRendererGetTogglableNodeCount(rtxptRenderer: RtxptRendererHandle): int;
@nodrops declare function Donut_RtxptRendererGetTogglableNodeName(rtxptRenderer: RtxptRendererHandle, index: int): string;
@nodrops declare function Donut_RtxptRendererIsTogglableNodeShown(rtxptRenderer: RtxptRendererHandle, index: int): boolean;
@nodrops declare function Donut_RtxptRendererShowTogglableNode(rtxptRenderer: RtxptRendererHandle, index: int, shown: boolean): void;
// The path tracer's global shader macros: cleared, then added one by one; a change recompiles it at the next Prepare.
@nodrops declare function Donut_RtxptRendererClearShaderMacros(rtxptRenderer: RtxptRendererHandle): void;
@nodrops declare function Donut_RtxptRendererAddShaderMacro(rtxptRenderer: RtxptRendererHandle, name: string, value: string): void;
// Advances the tone mapper's auto exposure by elapsedSeconds; applies the scene's animations at sceneTime
// (looped) if applyAnimations.
@nodrops declare function Donut_RtxptRendererAnimate(rtxptRenderer: RtxptRendererHandle, sceneTime: number, applyAnimations: boolean, elapsedSeconds: number): void;
// The renderer's setup for width x height frames shown at displayWidth x displayHeight (bigger with DLSS upscaling),
// between frames (the animate callback: it executes command lists of its own): render targets, passes (needNewPasses),
// acceleration structures (rebuildAccelStructs), and the path tracer's pipelines (compiled here). Bits of the result:
// 1 render targets made, 2 passes, 4 acceleration structures.
@nodrops declare function Donut_RtxptRendererPrepare(rtxptRenderer: RtxptRendererHandle, width: int, height: int, displayWidth: int, displayHeight: int, needNewPasses: boolean,
    rebuildAccelStructs: boolean, neeatQualityPreset: int): int;
// Takes the frame's settings (examples/rtxpt.ts's FRAME_SETTINGS_SIZE bytes) and records everything up to the path
// tracing pass. True if the environment map changed: reset the accumulation at the next frame.
@nodrops declare function Donut_RtxptRendererBeginFrame(rtxptRenderer: RtxptRendererHandle, commandList: CommandListHandle, frameSettings: Ref<f32>): boolean;
// The path tracer (the frame settings' samples per pixel): the reference one, or in real-time mode the denoising
// layers' build and fill passes, then the denoiser (NRD) if it's on.
@nodrops declare function Donut_RtxptRendererPathTrace(rtxptRenderer: RtxptRendererHandle, commandList: CommandListHandle): void;
// Accumulates with accumulationWeight (1 / (n + 1); 0 keeps the accumulated image), or in real-time mode TAA, DLSS (or
// a copy), then bloom and tone mapping into the LDR color.
@nodrops declare function Donut_RtxptRendererResolve(rtxptRenderer: RtxptRendererHandle, commandList: CommandListHandle, accumulationWeight: number): void;
@nodrops declare function Donut_RtxptRendererEndFrame(rtxptRenderer: RtxptRendererHandle): void;
// The tone-mapped frame (RGBA8), to blit to the back buffer.
@nodrops declare function Donut_RtxptRendererGetLdrColor(rtxptRenderer: RtxptRendererHandle): TextureHandle;
// DLSS (Donut_CreateDlss, initialized by the caller for the render and display sizes) for the real-time mode's
// realtimeAA 2; null: none (a copy instead).
@nodrops declare function Donut_RtxptRendererSetDlss(rtxptRenderer: RtxptRendererHandle, dlss: DlssHandle | null): void;
// DLSS-RR (Donut_CreateDlssRayReconstruction, initialized by the caller for the render and display sizes) for the
// real-time mode's realtimeAA 3; null: none.
@nodrops declare function Donut_RtxptRendererSetDlssRayReconstruction(rtxptRenderer: RtxptRendererHandle, dlssRayReconstruction: DlssRayReconstructionHandle | null): void;
// The frame's depth (R32_FLOAT, reverse-Z), screen motion vectors (RGBA16_FLOAT, pixels, previous minus current) and
// camera jitter in pixels (between BeginFrame and EndFrame): DLSS-NR's guides.
@nodrops declare function Donut_RtxptRendererGetDepth(rtxptRenderer: RtxptRendererHandle): TextureHandle;
@nodrops declare function Donut_RtxptRendererGetMotionVectors(rtxptRenderer: RtxptRendererHandle): TextureHandle;
@nodrops declare function Donut_RtxptRendererGetJitterX(rtxptRenderer: RtxptRendererHandle): number;
@nodrops declare function Donut_RtxptRendererGetJitterY(rtxptRenderer: RtxptRendererHandle): number;
// The accumulated radiance (RGBA32_FLOAT, linear).
@nodrops declare function Donut_RtxptRendererGetAccumulatedRadiance(rtxptRenderer: RtxptRendererHandle): TextureHandle;

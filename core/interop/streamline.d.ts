/// <reference path="../donut_handles.d.ts" />
/// <reference path="app.d.ts" />
// NVIDIA Streamline (core/streamline.cpp; the streamline_demo example links it, with WITH_STREAMLINE)

// Streamline's features (sl::kFeature* in sl_core_types.h).
enum StreamlineFeature {
    DLSS = 0,
    Reflex = 3,
    PCL = 4,
    DeepDVC = 5,
    Latewarp = 6,
    DLSS_G = 1000,
    DLSS_RR = 1001
}

// Starts Streamline, before the app (Donut_CreateAppWithOptions with AppOptions.Streamline, whose device it
// then makes): loads pluginDir/sl.interposer.dll (empty: bin/streamline/ next to the executable, or to
// donut_interop_shared.dll under the JIT) after checking its signature, and its plugins (DLSS, DLSS-RR, DeepDVC,
// Reflex, PCL, and DLSS-G or with latewarp != 0 Latewarp, which Streamline 2.12.0 doesn't have: then it fails).
// log != 0: Streamline's log in the console. Non-zero on success; logs why not.
@nodrops declare function Streamline_Init(api: GraphicsAPI, pluginDir: string, latewarp: int, log: int): int;
// Non-zero if the app's adapter (GPU, driver, OS) supports the feature; zero also without Streamline_Init.
@nodrops declare function Streamline_IsFeatureSupported(app: AppHandle, feature: StreamlineFeature): int;
// Why the last Streamline_IsFeatureSupported of the feature said what it did ("supported", or Streamline's
// reason, e.g. "eErrorNoSupportedAdapterFound").
@nodrops declare function Streamline_FeatureStatusText(feature: StreamlineFeature): string;
// Clears the resource tags and shuts Streamline down: before Donut_DestroyApp. Nothing without Streamline_Init.
@nodrops declare function Streamline_Shutdown(): void;

// --- Per frame. The app made with AppOptions.Streamline does the first two itself, in its device manager's
// frame callbacks (also in test mode): Streamline_BeginFrame before the frame, PCL markers around its
// animation, rendering and present. The rest need the frame's token.

// A new frame: Streamline's frame token (returned, -1 without Streamline), then Reflex's sleep (Reflex
// supported).
@nodrops declare function Streamline_BeginFrame(): int;
// A PCL marker for this frame (sl::PCLMarker: 0 simulation start, 1 its end, 2 render submit start, 3 its
// end, 4 present start, 5 its end), PCL supported.
@nodrops declare function Streamline_PclMarker(marker: int): void;
// Reflex's mode (0 off, 1 low latency, 2 with boost) and a frame rate cap (0: none), Reflex supported.
@nodrops declare function Streamline_SetReflex(mode: int, fpsCap: int): void;
// Reflex's latest latency, the simulation's start to the GPU's end of rendering, in milliseconds; -1 without
// a report (no Reflex, nothing presented yet).
@nodrops declare function Streamline_ReflexLatencyMs(): number;
// The frame's camera, every frame Streamline runs: the view rendered and the previous frame's (Donut planar
// views; their projections without jitter, and this one's jitter), the camera's position and its forward,
// up and right directions (3 floats each), the render size (motion vectors are in its pixels), reset non-zero
// for a frame without history. Near plane 0.01, far plane 200.
@nodrops declare function Streamline_SetConstants(view: ViewHandle, prevView: ViewHandle, cameraPos: Ref<f32>, fwd: Ref<f32>,
    up: Ref<f32>, right: Ref<f32>, renderW: int, renderH: int, reset: int): void;
// Tags the frame's motion vectors and depth (at the render size; depth is copied now) and its final color
// without the UI (at the display size), on the command list.
@nodrops declare function Streamline_TagCommon(cmd: CommandListHandle, motionVectors: TextureHandle, depth: TextureHandle,
    hudless: TextureHandle): void;
// DLSS's render size for the mode (the -DLSS_mode numbering: 1 MaxPerformance, 2 Balanced, 3 MaxQuality,
// 4 UltraPerformance, 6 DLAA) at the display size: w | h << 16; 0 if DLSS can't. Mode 0 turns DLSS off,
// frees its resources (wait for the GPU first) and returns the display size.
@nodrops declare function Streamline_DlssOptimalRenderSize(mode: int, displayW: int, displayH: int): int;
// Upscales input's top-left renderW x renderH (HDR color) into output (at the display size) with DLSS in
// the mode, on the command list, whose state is cleared after (Streamline binds its own).
@nodrops declare function Streamline_EvaluateDlss(cmd: CommandListHandle, mode: int, input: TextureHandle, output: TextureHandle,
    renderW: int, renderH: int): void;
// DLSS-RR's render size for the mode (the -DLSSRR_mode numbering, as DLSS's) at the display size: w | h << 16;
// 0 if DLSS-RR can't. Mode 0 turns DLSS-RR off, frees its resources (wait for the GPU first) and returns the
// display size.
@nodrops declare function Streamline_DlssRROptimalRenderSize(mode: int, displayW: int, displayH: int): int;
// DLSS Ray Reconstruction: denoises and upscales input (HDR color at the render size: its whole size) into
// output (at the display size) in the mode, on the command list, whose state is cleared after. Its guides,
// read over the input's size: diffuse and specular albedo, normals with roughness in w, the specular hit
// distance; the camera's world-to-view matrix and its inverse (16 floats each, row-major). The common tags
// (motion vectors, depth) and constants are the frame's.
@nodrops declare function Streamline_EvaluateDlssRR(cmd: CommandListHandle, mode: int, input: TextureHandle, output: TextureHandle,
    diffuse: TextureHandle, specular: TextureHandle, normalRoughness: TextureHandle, specHitDistance: TextureHandle,
    worldToView: Ref<f32>, viewToWorld: Ref<f32>): void;
// DeepDVC (AI-driven digital vibrance) on color, in place: the final color before the UI (at the display
// size), on the command list, whose state is cleared after. intensity and saturationBoost in [0, 1].
@nodrops declare function Streamline_EvaluateDeepDvc(cmd: CommandListHandle, color: TextureHandle, intensity: number,
    saturationBoost: number): void;
// DeepDVC turned off: its mode set to off (its plugin has no explicit resource free).
@nodrops declare function Streamline_DeepDvcOff(): void;
// Drops the resource tags: before releasing tagged resources (Streamline holds them until then).
@nodrops declare function Streamline_ClearTags(): void;

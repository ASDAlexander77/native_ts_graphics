# Streamline Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tslang example, `streamline_demo`, that ports NVIDIA's Streamline Sample 2.12.0 frame on its `sponza-plus` scene and drives Streamline's DLSS-SR, DLSS-RR, DeepDVC, Reflex, DLSS-G (and Latewarp if the public SDK has it) on D3D12 and Vulkan.

**Architecture:** Streamline 2.12.0 (MIT) is fetched at configure time as the signed release zip. The sample itself (NVIDIA RTX SDKs license) is used in place from a checkout, the RTXPT/RTXCR way: `STREAMLINE_SAMPLE_DIR` points at it, its ray-gen and UI-composite HLSL compile from there, nothing is copied. Native glue `core/streamline.cpp` loads `sl.interposer.dll` by full path (works under the JIT), hooks Donut's device creation through a new Donut patch, and exposes a flat C API typed in `core/interop/streamline.d.ts`. `examples/streamline_demo.ts` is the sample's host (`StreamlineSample.cpp`), reusing Donut render passes the way `examples/feature_demo.ts` does.

**Tech Stack:** tslang, Donut/NVRHI (D3D12, Vulkan), Streamline SDK 2.12.0, CMake/CTest, HLSL via ShaderMake.

**Spec:** `docs/superpowers/specs/2026-11-08-streamline-demo-design.md`

## Global Constraints

- Streamline SDK 2.12.0, GitHub `NVIDIA-RTX/Streamline` release asset `streamline-sdk-v2.12.0.zip` (231,958,617 bytes). **Ask the user before the first download** (name, source, size).
- Nothing from `E:\Gits\Streamline_Sample` (RTX SDKs license) is committed: no code, no shaders, no reference images. SL binaries / `nvngx_*.dll` never committed.
- APIs: D3D12 and Vulkan only. No D3D11. No NIS (don't enable `kFeatureNIS`, no UI for it).
- Features: DLSS-SR, DLSS-RR, DeepDVC, Reflex (+PCL markers), DLSS-G; Latewarp only if the release zip contains `sl.latewarp.dll` and `sl_latewarp.h`.
- DLSS-G and Latewarp are mutually exclusive: chosen at startup by `-latewarp`; only that plugin loads.
- Tests stay headless (no visible windows on the user's desktop); anything needing a presented swapchain is a manual run the user agrees to first.
- `core/donut.ts` is generated: regenerate with `tools/generate_donut_wrappers.py`, never hand-edit.
- tslang bugs go to `I:\TypeScriptCompiler\TSLANG_ISSUES.md` (Open section) with a repro and our workaround.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Facts found while planning (from reading the sample; affect every task)

- Default lighting on DX12/VK is **ray traced** (`UIData::RayTracing_Mode = 1`): a ray-gen pass from `src/StreamlineSample.hlsl` writes `HdrColor` + `SpecHitDistance`, dispatched at the *backbuffer* size; no camera-motion-vector pass in that path. Deferred + SSAO run only with RT off.
- Sky and bloom run twice on the RT path (inside the RT branch, then again after it). Port as-is for parity.
- DLSS-RR's `GBuffer{Diffuse,Specular,Normals}RR` guides are cleared, never written; `reset` in `slSetConstants` is always false (shadowed variable). Port as-is, comment both.
- Defaults: 1920×1080 BGRA8 swapchain, camera `LookAt((0,1.8,0)→(1,1.8,0))`, FOV 60, near 0.01, far 200 (SL constants), reverse-Z infinite projection, CSM 2048 px × 4 cascades, ambient 0.2, bloom σ 32 α 0.05, exposure reset 8.0, `AAMode` NONE, animation by wall-clock × 1.
- The sample has no dump facility and uses wall-clock time. Reference frames come from a **local, uncommitted patch** of the sample build (Task 2).
- SL init: manual hooking (`eUseManualHooking`), frame-based tagging (`eUseFrameBasedResourceTagging`), `applicationId` 231313132; D3D12 device = `D3D12CreateDevice` through the interposer → `slGetNativeInterface` → `slSetD3DDevice`; Vulkan = interposer as the Vulkan loader plus extensions `VK_NVX_binary_import`, `VK_NVX_image_view_handle`, `VK_KHR_buffer_device_address`, `VK_KHR_push_descriptor`.

## Review Focus

1. **No RTX GPU / old driver / feature unsupported** → each feature's toggle disabled with the reason from `slIsFeatureSupported`; `-test` exits SKIPPED, not failed. Test: Task 3 Step 1 (`-slDisable` forces the unsupported path).
2. **Running under the tslang JIT** (exe is `tslang.exe`, not `bin/streamline_demo.exe`) → interposer and plugins found from `bin/`. Test: Task 3 Step 5 runs the JIT launcher.
3. **Window resize / DLSS mode change** → render targets and SL resources recreated without leaks or validation errors (`-debug`). Test: Task 5 Step 1 switches mode mid-run under `-test`.
4. **Toggling DLSS-G on D3D12** → swapchain re-created; no device removal. Test: Task 8 Step 4 (manual, user-approved visible run) + headless state check.
5. **Shutdown order** → tags cleared, `slShutdown` before device destruction; no crash at exit (cf. rc exit-crash history). Test: every `-test` run must exit 0; Task 3 Step 1 asserts clean exit.

---

### Task 1: Fetch Streamline 2.12.0 at configure time

**Files:**
- Modify: `CMakeLists.txt` (new block after the DLSS-RR block, ~line 622)
- Modify: `CMakePresets.json` (presets `streamline`, `release-streamline` inheriting `base`)

**Interfaces:**
- Produces: CMake option `WITH_STREAMLINE` (default OFF); variables `STREAMLINE_INCLUDE_DIR`, `STREAMLINE_BIN_DIR` (signed `bin/x64`), `STREAMLINE_HAS_LATEWARP` (BOOL); custom target `copy_streamline_binaries` copying `sl.interposer.dll`, `sl.common.dll`, `sl.pcl.dll`, `sl.reflex.dll`, `sl.dlss.dll`, `sl.dlss_d.dll`, `sl.deepdvc.dll`, `sl.dlss_g.dll`, (`sl.latewarp.dll`), every `nvngx_*.dll`, `NvLowLatencyVk.dll`, `*.json` into `${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/streamline/`.

- [ ] **Step 1: Ask the user to approve the download** (`streamline-sdk-v2.12.0.zip`, github.com/NVIDIA-RTX/Streamline releases, ~232 MB). Stop until they say yes.
- [ ] **Step 2: Add the FetchContent block** (`URL` the release asset, `URL_HASH SHA256=` of the downloaded zip, `DOWNLOAD_EXTRACT_TIMESTAMP TRUE`, `STREAMLINE_FETCH_DIR` cache var like `DONUT_DLSS_NR_FETCH_DIR`), comment the license (SDK MIT; plugins/NGX DLLs NVIDIA-licensed, never committed). Set `STREAMLINE_HAS_LATEWARP` from `EXISTS` of both `bin/x64/sl.latewarp.dll` and `include/sl_latewarp.h`; `message(STATUS ...)` the result.
- [ ] **Step 3: Configure**
  Run: `cmake --preset streamline`
  Expected: `Fetching Streamline SDK 2.12.0`, then `Streamline Latewarp: ON|OFF`. **Report the Latewarp result to the user.** If OFF, Task 9 is dropped (spec decision).
- [ ] **Step 4: Build the copy target** — `cmake --build --preset streamline --target copy_streamline_binaries`; Expected: the DLLs listed above under `build-streamline/bin/streamline/`.
- [ ] **Step 5: Commit** — `git add CMakeLists.txt CMakePresets.json` and commit `build: fetch Streamline SDK 2.12.0 (WITH_STREAMLINE)`.

### Task 2: Reference build of the Streamline Sample (outside the repo)

Nothing here is committed. Work in `E:\Gits\Streamline_Sample`; keep the dump patch as `<scratchpad>/streamline_sample_dump.patch` and record its path in memory.

- [ ] **Step 1:** Copy the fetched SDK (Task 1's `include/`, `lib/`, `bin/`) into the sample's `streamline/` folder; `make.bat` then `build.bat` (Release). Expected: `_bin/StreamlineSample.exe` plus SL DLLs.
- [ ] **Step 2: Local dump patch** in `src/StreamlineSample.cpp` / `main.cpp`: `-fixedDt <seconds>` replaces wall-clock elapsed time; `-dumpFrame N -dumpPath <file>` reads back the backbuffer (pre-UI, `PreUIColor`) at frame N via Donut's `PixelReadbackPass`/`SaveTextureToFile`, then exits; also fix the `-scene` arg bug locally only if needed.
- [ ] **Step 3: Produce references** at 1920×1080, `-fixedDt 0.0166667 -dumpFrame 120`, hidden window (ask the user before any visible run), D3D12 and Vulkan, for: RT on/AA none; RT off (deferred)/AA none; TAA; DLSS-SR mode 3 (MaxQuality); DLSS-RR; DeepDVC on. Save to `E:\Gits\Streamline_Sample\_refdumps\<api>_<mode>.png`.
- [ ] **Step 4:** Write `<scratchpad>/compare_frames.py` (`-I` mode): mean absolute difference per channel and % pixels over 8/255; pass thresholds per mode (exact-ish ≤1% for no-AA modes; DLSS-family ≤5% over threshold, as DLSS varies run to run).

### Task 3: Native Streamline glue + device hook

**Files:**
- Create: `core/streamline.cpp`, `core/interop/streamline.d.ts`
- Create: `patches/Donut-streamline-device-hooks.patch` (appended last to the Donut patch list in `CMakeLists.txt` ~line 170)
- Modify: `core/donut_interop.cpp` (`Donut_CreateAppWithOptions`: new option bit), `core/interop/app.d.ts` (`AppOptions.Streamline = 4096`)
- Modify: `CMakeLists.txt` (`core/streamline.cpp` into `JIT_MODULE_SOURCES` and the example when `WITH_STREAMLINE`)
- Regenerate: `core/donut.ts`

**Interfaces (C API, all `@nodrops declare function` in `streamline.d.ts`):**
- `Streamline_Init(api: GraphicsAPI, pluginDir: string, latewarp: int, log: int): int` — before the app; nonzero on success. Loads `<pluginDir>/sl.interposer.dll` with `LoadLibraryW` (full path), calls `slInit` with `pathsToPlugins = {pluginDir}`, features `{DLSS, DLSS_RR, DeepDVC, Reflex, PCL, DLSS_G | Latewarp}`, flags `eUseManualHooking | eUseFrameBasedResourceTagging`, `applicationId` 231313132. On D3D12 then `slSetFeatureLoaded(kFeatureDLSS_G, false)`.
- `Streamline_IsFeatureSupported(app: AppHandle, feature: StreamlineFeature): int` and `Streamline_FeatureStatusText(feature): string` (copied string).
- `Streamline_Shutdown(): void` — clears tags, `slShutdown`; must run before `Donut_DestroyApp`.
- `enum StreamlineFeature { DLSS = 0, Reflex = 3, PCL = 4, DeepDVC = 5, Latewarp = 6, DLSS_G = 1000, DLSS_RR = 1001 }` (= `sl::kFeature*` in `sl_core_types.h`).
- Donut patch: `DeviceCreationParameters` gains `std::function<HRESULT(IUnknown* adapter, D3D_FEATURE_LEVEL, REFIID, void**)> d3d12CreateDevice` and `std::function<HRESULT(UINT, REFIID, void**)> createDxgiFactory2`, used by `DeviceManager_DX12` when set; Vulkan uses Donut's existing `vulkanLibraryName` (set to the interposer's full path) and the GLFW loader (`glfwInitVulkanLoader` with the interposer's `vkGetInstanceProcAddr`). `AppOption_Streamline` fills these from `core/streamline.cpp` and adds the four Vulkan extensions above.

- [ ] **Step 1: Write the failing test** — `examples/streamline_demo.ts` minimal: `Streamline_Init`, create app with `AppOptions.Streamline`, log one line per feature `"<name>: supported|<reason>"`, `Streamline_Shutdown`, destroy app. Under `-test` with `-slDisable` (skip `Streamline_Init`): every feature reports unsupported, exit `TEST_SKIPPED`. Register `add_tslang_example_test(streamline_demo ARGS -width 1280 -height 720)` and a `_vk` variant.
- [ ] **Step 2:** Build; run `ctest --preset streamline -R streamline_demo` → FAIL (symbols undefined).
- [ ] **Step 3:** Implement the patch, glue and option as above; regenerate `donut.ts`.
- [ ] **Step 4:** Run the tests. Expected on RTX GPU: PASS with DLSS, DLSS_RR, DeepDVC, Reflex supported; exit 0 (clean shutdown). Also run with `-debug`: no NVRHI/D3D/VK validation errors.
- [ ] **Step 5:** Run under the JIT launcher (`run_jit*.bat streamline_demo -- -test`) → same result.
- [ ] **Step 6: Commit** — `streamline_demo: Streamline init and device hooks (D3D12, Vulkan)`.

### Task 4: Port the sample's frame (no Streamline features)

**Files:**
- Modify: `examples/streamline_demo.ts` (scene, passes, UI, `StreamlineDemoArgs extends Args`)
- Create: `shaders/streamline_demo.cfg` (compiles `${STREAMLINE_SAMPLE_DIR}/src/StreamlineSample.hlsl` `-T lib -D REFLECT_MATERIALS={0,1}` and the UI-composite PS, `--sourceDir ${STREAMLINE_SAMPLE_DIR}/src`)
- Modify: `CMakeLists.txt` (`STREAMLINE_SAMPLE_DIR` cache PATH; example built only when it and `WITH_STREAMLINE` are set; `MEDIA fonts sponza-plus.scene.json glTF-Sample-Assets`)

**Interfaces:**
- Consumes: Task 3's C API.
- Produces: in `streamline_demo.ts`, `class RenderTargets` (render-size and display-size targets as listed in Facts, formats exact), `class StreamlineDemo` with `renderScene(framebuffer)` and fields `hdrColor`, `aaResolvedColor`, `preUIColor`, `specHitDistance`, `motionVectors`, `depth`; `UIData` with sample defaults; args `-noRT`, `-aa none|taa`, `-pauseAnimation`.

- [ ] **Step 1: Write the failing test** — `checkFrame` for `-test` (fixed dt 1/60, 120 frames): TestCheck shares for Sponza lit (≥95% non-black), robot/sphere present (colored share band measured from the reference), plus `-testOutput` dump.
- [ ] **Step 2:** Run → FAIL (black frame).
- [ ] **Step 3:** Implement passes in the sample's order (Facts + `SS.cpp:1158-1506`): CSM `DepthPass` → `GBufferFillPass` → RT ray-gen (BLAS/TLAS rebuilt per frame, backbuffer-size dispatch) *or* motion vectors + `SsaoPass` + `DeferredLightingPass` → `SkyPass` → `BloomPass` (RT path: both twice) → TAA / blit → `ToneMappingPass` (auto exposure, reset 8.0) → blit to `PreUIColor` → backbuffer. Reuse `feature_demo.ts` wrappers for the Donut passes.
- [ ] **Step 4:** Run tests (D3D12, Vulkan) → PASS. Compare `-testOutput` dumps with Task 2's `rt_none`, `deferred_none`, `taa` references via `compare_frames.py` → within thresholds.
- [ ] **Step 5: Commit** — `streamline_demo: port the Streamline Sample's frame (RT + deferred, TAA)`.

### Task 5: DLSS-SR, constants, common tags, Reflex/PCL markers

**Files:** Modify `core/streamline.cpp`, `core/interop/streamline.d.ts`, `examples/streamline_demo.ts`; regenerate `core/donut.ts`.

**Interfaces:**
- `Streamline_BeginFrame(): int` (frame token + `slReflexSleep` — get the token **always**, not only with Reflex, unlike the sample), `Streamline_PclMarker(marker: int): void`, `Streamline_SetReflex(mode: int, fpsCap: int): void`, `Streamline_ReflexLatencyMs(): number`.
- `Streamline_SetConstants(view: ViewHandle, prevView: ViewHandle, cameraPos: Ref<f32>, fwd: Ref<f32>, up: Ref<f32>, right: Ref<f32>, renderW: int, renderH: int, reset: int): void` (fields per Facts: near 0.01, far 200, `mvecScale` 1/render size, `motionVectorsInvalidValue` FLT_MIN, `cameraMotionIncluded` 1).
- `Streamline_TagCommon(cmd: CommandListHandle, motionVectors: TextureHandle, depth: TextureHandle, hudless: TextureHandle): void`.
- `Streamline_DlssOptimalRenderSize(mode: int, displayW: int, displayH: int): int` (`w | h << 16`), `Streamline_EvaluateDlss(cmd, mode: int, input: TextureHandle, output: TextureHandle, renderW: int, renderH: int): void` (`colorBuffersHDR` 1, `useAutoExposure` 0; `clearState()` after).
- Args: `-dlss <0..5>` (sample `-DLSS_mode` numbering), `-reflex <0..2>`, `-reflexFpsCap <n>`.

- [ ] **Step 1: Failing test** — `-test -dlss 3`: frame check as Task 4, plus `-testDlssModeSwitch` switching to mode 1 at frame 60 (Review Focus 3), no validation errors under `-debug`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; LOD bias `log2(renderW/displayW) - 1`; markers around animate/render/present via Donut callbacks.
- [ ] **Step 4:** Tests PASS on both APIs; compare against `dlss3` reference (DLSS thresholds). Log Reflex latency once.
- [ ] **Step 5: Commit** — `streamline_demo: DLSS-SR and Reflex through Streamline`.

### Task 6: DLSS-RR

**Files:** as Task 5.

**Interfaces:** `Streamline_EvaluateDlssRR(cmd, mode: int, input, output, diffuse: TextureHandle, specular: TextureHandle, normalRoughness: TextureHandle, specHitDistance: TextureHandle, worldToView: Ref<f32>, viewToWorld: Ref<f32>): void`; arg `-dlssRR <mode>`.

- [ ] **Step 1: Failing test** — `-test -dlssRR 3`, frame check.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with the `*RR` guide targets cleared only (sample parity; comment it).
- [ ] **Step 4:** PASS on both APIs; compare to `dlssrr` reference.
- [ ] **Step 5: Commit** — `streamline_demo: DLSS Ray Reconstruction`.

### Task 7: DeepDVC

**Interfaces:** `Streamline_EvaluateDeepDvc(cmd, color: TextureHandle, intensity: number, saturationBoost: number): void` (in place on `PreUIColor`); args `-deepdvc`, defaults intensity 0.5, saturation 0.75.

- [ ] **Step 1: Failing test** — `-test -deepdvc`: frame check; saturation share higher than the plain run's (measure both, assert ordering).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS both APIs; compare to `deepdvc` reference.
- [ ] **Step 5: Commit** — `streamline_demo: DeepDVC`.

### Task 8: DLSS Frame Generation (+ UI tagging, swapchain recreation)

**Files:** `core/streamline.cpp`, `streamline.d.ts`, the Donut patch (D3D12 swapchain re-creation hook in `BeginFrame`), `examples/streamline_demo.ts`.

**Interfaces:** `Streamline_SetDlssG(mode: int, framesToGenerate: int): void` (`eRetainResourcesWhenOff`; off while the mouse is over ImGui), `Streamline_DlssGState(): int` (`status | numFramesActuallyPresented << 8`), `Streamline_TagUi(cmd, uiColorAlpha: TextureHandle, uiAlpha: TextureHandle, backbufferW: int, backbufferH: int): void`; args `-dlssg <multiplier 2..4>` (forces Reflex ≥1, as the sample).

- [ ] **Step 1: Failing test** — headless `-test -dlssg 2`: no swapchain, so assert `Streamline_IsFeatureSupported(DLSS_G)` path reports and the run logs `DLSS-G: needs a presented swapchain, skipped` and exits 0.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (D3D12: wait idle → `slSetFeatureLoaded` → recreate swapchain with `DXGI_MWA_NO_ALT_ENTER` → targets; Vulkan: feature stays loaded).
- [ ] **Step 4: Manual check — ask the user first** (visible window): `streamline_demo -dx12 -dlssg 2` and `-vk`; overlay shows presented-frames multiplier ≈2× and latency; toggle FG on/off three times; no device removal.
- [ ] **Step 5: Commit** — `streamline_demo: DLSS Frame Generation`.

### Task 9: Latewarp (only if `STREAMLINE_HAS_LATEWARP`)

**Interfaces:** `Streamline_EvaluateLatewarp(cmd, color, depth, motionVectors, ...)` per `sl_latewarp.h`; `-latewarp` makes `Streamline_Init` load Latewarp instead of DLSS-G; UI shows which one.

- [ ] Steps as Task 8 (headless skip test, implement, user-approved manual run), then commit `streamline_demo: Latewarp`.
- [ ] If Task 1 found no Latewarp: delete this task, note "Latewarp: not in public SL 2.12.0" in the README section.

### Task 10: Docs, presets, PR

- [ ] **Step 1:** README: `streamline_demo` section (build with `cmake --preset streamline -DSTREAMLINE_SAMPLE_DIR=E:/Gits/Streamline_Sample`, switches, features, license note, what `-test` covers vs. manual FG check); link from the RTX SDK list.
- [ ] **Step 2:** Full `ctest --preset streamline -R streamline_demo` on both APIs → PASS (or SKIPPED on non-RTX).
- [ ] **Step 3:** Commit, push branch `streamline-demo`, open PR (body ends with the Claude Code line); bind with ccd_pr tools.

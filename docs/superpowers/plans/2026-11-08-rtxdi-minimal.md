# RTXDI Minimal Sample Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tslang example, `rtxdi_minimal`, that ports RTXDI 3.0.0's Minimal Sample (fused single-pass ReSTIR DI on the Arcade) on D3D12 and Vulkan and matches the reference build frame by frame.

**Architecture:** RTXDI (NVIDIA RTX SDKs License) is used in place from a checkout via `RTXDI_DIR`, the `rtxpt` way: its host library compiles as static `rtxdi_runtime`, the Minimal Sample's two HLSL files compile by ShaderMake from `RTXDI_DIR/Samples/MinimalSample/Shaders`. Native glue `core/rtxdi.cpp` owns everything touching RTXDI C++ types or `ShaderParameters.h` layouts (context, resources, light preparation, constant buffers) behind a flat C API typed in `core/interop/rtxdi.d.ts`. TypeScript holds the app: reusable `core/rtxdi_di.ts` (context/resources/light-prep wrappers, render targets) and the minimal frame in `examples/rtxdi_minimal.ts`.

**Tech Stack:** tslang, Donut/NVRHI (D3D12, Vulkan, inline ray queries), RTXDI SDK 3.0.0, CMake/CTest, HLSL via ShaderMake (DXC).

**Spec:** `docs/superpowers/specs/2026-11-08-rtxdi-minimal-design.md`

## Global Constraints

- Reference checkout `E:\Gits\RTXDI`, RTXDI SDK v3.0.0 (commit `1b55517`, library `Libraries/Rtxdi` at `d28e20f`). Reference exe `E:\Gits\RTXDI\build\bin\MinimalSample.exe`.
- Nothing from `RTXDI_DIR` committed: no code, no shaders, no assets, no reference images. The reference dump patch stays uncommitted in the RTXDI working tree, saved as a file in the session-notes folder.
- `core/rtxdi.cpp` carries the notice "This software contains source code provided by NVIDIA Corporation." (as `core/rtxpt.cpp`).
- `RTXDI_DIR` and `RTXPT_DIR` together: configure fails with `message(FATAL_ERROR ...)` explaining why (old RTXDI headers in `rtxpt_core`'s PUBLIC includes).
- Shader compile options as the reference: `--shaderModel 6_5 --vulkanVersion 1.2 --relaxedInclude "../Types.h" -D SPIRV` (SPIR-V) and `NVRHI_DEFAULT_VK_REGISTER_OFFSETS`.
- Frame parameters as the sample: camera `LookAt((-1.658, 1.577, 1.69), (-0.9645, 1.2672, 1.0396))`, move speed 3, vertical FOV 60°, `perspProjD3DStyleReverse(60°, aspect, 0.01)`, no jitter, render size = back buffer, HDR output (RGBA16_FLOAT) blitted unmodified.
- APIs: D3D12 and Vulkan. Tests headless only (no visible windows without asking the user).
- `core/donut.ts` is generated: `python tools/generate_donut_wrappers.py`, never hand-edited.
- tslang bugs go to `I:\TypeScriptCompiler\TSLANG_ISSUES.md` (Open section) with repro and workaround.
- Work in a git worktree of branch `rtxdi-minimal` (`superpowers:using-git-worktrees`; memory `worktree-build-setup` for submodules/_deps) — never `git switch` the main checkout `I:\native_ts_graphics`, other sessions share it.
- Commits on branch `rtxdi-minimal`; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage the unrelated working-tree files (`core/pbrt_scene.ts`, `core/rtxcr_scene.ts`, `core/rtxmg.ts`, `docs/mimalloc.md`).

## Review Focus

1. **Async scene load / first frame index** — the first rendered frame index must be deterministic in `-test` (load synchronously in test mode, or start RTXDI's frame index at the first rendered frame) so frame N is the same frame as the reference's. Test: Task 6 Step 3 runs `-test` twice and requires bit-identical dumps.
2. **Ping-pong swap order** — binding sets, G-buffer current/previous and `viewPrevious` swapped *after* submit, once per frame; an off-by-one only shows with a moving camera. Test: Task 6 Step 4 (moving-camera compare).
3. **Window resize** — context, render targets, RTXDI resources and binding sets recreated (sample nulls them in `BackBufferResized`), no validation errors. Test: Task 5 Step 5 (`-test -resizeAt 10`).
4. **Vulkan validation** — the neighbor-offsets buffer padding must silence the README's known warning; `-debug` runs must log zero validation messages. Test: Task 4 Step 4.
5. **JIT vs AOT** — `core/rtxdi.cpp` + `rtxdi_runtime` linked into `donut_interop_shared`; shaders found from `bin/` under `tslang.exe`. Test: Task 7 Step 2.

---

### Task 1: Build wiring — `RTXDI_DIR`, `rtxdi_runtime`, shaders

**Files:**
- Modify: `CMakeLists.txt` (cache var next to `RTXPT_DIR` ~line 424; new block after the rtxpt block ~line 5440)
- Create: `shaders/rtxdi_minimal.cfg`
- Modify: `CMakePresets.json` (configure/build presets `default-rtxdi`, `release-rtxdi`, binaryDir `build-rtxdi` / `build-release-rtxdi`, `RTXDI_DIR = E:/Gits/RTXDI`, inheriting like `default-rtxpt`)

**Interfaces:**
- Produces: CMake `RTXDI_DIR` (PATH, default ""); static target `rtxdi_runtime` (all of `RTXDI_DIR/Libraries/Rtxdi/Source/*.cpp`, PUBLIC include `RTXDI_DIR/Libraries/Rtxdi/Include`); target `rtxdi_minimal_shaders` → `bin/shaders/rtxdi_minimal/{dxil,spirv}/{PrepareLights,Render}_main.*`; CMake var `RTXDI_GLUE_SOURCES = core/rtxdi.cpp` appended to `JIT_MODULE_SOURCES`; a `bin/Assets` junction → `RTXDI_DIR/Assets` (as rtxpt's, guarded by `NOT EXISTS`).

- [ ] **Step 1:** Add the block: guard `if (RTXDI_DIR AND RTXPT_DIR) message(FATAL_ERROR "...")`; `rtxdi_runtime` (or `add_subdirectory(${RTXDI_DIR}/Libraries/Rtxdi ...)` if it configures cleanly — pick one, comment why); `donut_compile_shaders(TARGET rtxdi_minimal_shaders PROJECT_NAME "RTXDI" CONFIG shaders/rtxdi_minimal.cfg INCLUDES ${RTXDI_DIR}/Libraries/Rtxdi/Include ... SHADER_MODEL 6_5 SHADERMAKE_OPTIONS "--sourceDir ${RTXDI_DIR}/Samples/MinimalSample/Shaders --vulkanVersion 1.2 --relaxedInclude ../Types.h" ...)` (our `compileshaders.cmake` emits `--shaderModel` from `SHADER_MODEL`, default 6_5 — keep it explicit; don't use rtxpt's `-m 6_9`), with the reference's `-D SPIRV` for SPIR-V and VK register offsets (match `E:\Gits\RTXDI\External\donut\compileshaders.cmake`'s handling of `NVRHI_DEFAULT_VK_REGISTER_OFFSETS`). Donut shader includes are ours. License comment like rtxpt's.
- [ ] **Step 2:** `shaders/rtxdi_minimal.cfg`: `PrepareLights.hlsl -T cs -E main` and `Render.hlsl -T cs -E main`.
- [ ] **Step 3: Configure + build the pieces**
  Run (vcvars, see memory `worktree-build-setup`): `cmake --preset default-rtxdi` then `cmake --build build-rtxdi --target rtxdi_runtime rtxdi_minimal_shaders`
  Expected: library builds; four shader binaries under `build-rtxdi/bin/shaders/rtxdi_minimal/`.
- [ ] **Step 4: Negative check:** `cmake -S . -B <scratch> -DRTXDI_DIR=E:/Gits/RTXDI -DRTXPT_DIR=E:/Gits/RTXPT` → FATAL_ERROR text shown. Delete the scratch dir.
- [ ] **Step 5: Commit** `build: RTXDI_DIR, rtxdi_runtime and the Minimal Sample's shaders in place`.

### Task 2: Reference dumps (outside the repo, nothing committed)

Work in `E:\Gits\RTXDI`. Save the patch as `<notes folder>/rtxdi_minimal_reference.patch` and record the recipe in memory.

- [ ] **Step 1: Local patch to `Samples/MinimalSample/Source/main.cpp`:** args `--width W --height H` (back buffer), `--hidden` (window not shown; use the same hidden-window approach as the Streamline reference), `--sync` (`SetAsynchronousLoadingEnabled(false)`), `--dumpFrame N --dumpPath <file>` (after frame index N's `RenderScene`, read back `HdrColor` RGBA16F → write raw little-endian float32 RGBA, header `int32 width, int32 height`, then exit), `--camera px py pz tx ty tz` (overrides LookAt), `--moveCamera dx dy dz` (camera position += d per frame, target too), `--noResampling`, `--unbiased`. Also log the frame index of the first rendered frame.
- [ ] **Step 2:** Rebuild `MinimalSample` only (`cmake --build E:/Gits/RTXDI/build --config Release --target MinimalSample`). Expected: exe timestamp updated.
- [ ] **Step 3: Produce references** at 1280×720, `--sync --hidden`, D3D12 and `--vk`: `default_f60`, `noresampling_f60`, `unbiased_f60`, `moving_f60` (`--moveCamera 0.01 0 0`). Into `E:\Gits\RTXDI\_refdumps\<api>_<case>.bin`. Run each case twice; record ref-vs-ref difference (the noise floor). Also run the reference once with `--vk --debug` and record the exact validation message(s) (VUID, text) in the notes folder: Task 3's neighbor-offsets padding is a hypothesis until that message says the cause is the buffer size/range (if it is usage flags or the view, fix that cause instead).
- [ ] **Step 4:** `<scratchpad>/cmp_hdr.py` (run with `python -I`): loads two dumps, prints max abs diff, mean abs diff, % pixels with any channel diff > 1e-3, and the first-row/col of the worst block. Exit 0 if within given thresholds.

### Task 3: Native glue — context, resources, constants

**Files:**
- Create: `core/rtxdi.cpp`, `core/interop/rtxdi.d.ts`
- Modify: `CMakeLists.txt` (`core/rtxdi.cpp` per-source includes: `RTXDI_DIR/Libraries/Rtxdi/Include`, `RTXDI_DIR/Samples/MinimalSample/Shaders` for `ShaderParameters.h`; link `rtxdi_runtime` into `donut_interop_shared` and the example)
- Regenerate: `core/donut.ts`

**Interfaces (all `@nodrops declare function` in `rtxdi.d.ts`; handle types declared like other interop handles):**
- `Rtxdi_CreateDIContext(width: int, height: int): RtxdiDIContextHandle` — `rtxdi::ReSTIRDIContext` with `RenderWidth/Height` set, other static params default.
- `Rtxdi_SetFrameIndex(context: RtxdiDIContextHandle, frameIndex: int): void`
- `Rtxdi_CreateResources(app: AppHandle, context: RtxdiDIContextHandle, scene: SceneHandle): RtxdiResourcesHandle` — counts emissive meshes/triangles over mesh instances (the sample's `CountLightsInScene`: instances whose geometry material has emissive color·intensity > 0) and geometry instances; creates `TaskBuffer`, `LightDataBuffer`, `GeometryInstanceToLightBuffer`, `NeighborOffsetsBuffer` (RG8_SNORM typed, byte size `NeighborOffsetCount*2` **rounded up to the device's texel-buffer alignment** — 256 is safe on both APIs), `LightReservoirBuffer` with the sample's descs.
- `enum RtxdiBuffer { Tasks = 0, LightData = 1, GeometryInstanceToLight = 2, NeighborOffsets = 3, LightReservoirs = 4 }`; `Rtxdi_GetBuffer(resources: RtxdiResourcesHandle, which: RtxdiBuffer): BufferHandle`
- `Rtxdi_InitializeNeighborOffsets(resources, context, commandList: CommandListHandle): void` — once (`FillNeighborOffsetBuffer`).
- `Rtxdi_CreateConstantBuffers(app: AppHandle, resources): void`; `Rtxdi_GetPrepareLightsConstantBuffer(resources): BufferHandle`; `Rtxdi_GetResamplingConstantBuffer(resources): BufferHandle` — volatile CBs sized `sizeof(PrepareLightsConstants)` / `sizeof(ResamplingConstants)`.
- `Rtxdi_PrepareLights(resources, scene: SceneHandle, commandList): int` — the sample's `PrepareLightsPass::Process` CPU part: task list, geometry-instance→light map (init `RTXDI_INVALID_LIGHT_INDEX`), writes both buffers and the PrepareLights CB, keeps the resulting `RTXDI_LightBufferParameters` in `resources`; returns the total light count (the sample's final `lightBufferOffset`); TS dispatches `div_ceil(count, 256)` groups as `PrepareLightsPass.cpp:165`.
- `Rtxdi_WriteResamplingConstants(resources, context, commandList, view: ViewHandle, prevView: ViewHandle, enableResampling: int, unbiasedMode: int, numLocalLightSamples: int, numBrdfSamples: int, brdfCutoff: number, numSpatialSamples: int): void` — fills `ResamplingConstants` exactly as `RenderPass::Render` (runtime params, buffer indices from the context). `unbiasedMode` sets `spatioTemporalResamplingParams.biasCorrectionMode` exactly as `UserInterface.cpp:80` does (that is all it changes there).
- Defaults: `Rtxdi_GetDefaultSettings(dst: Ref<f32>): void` writes `[numLocalLightSamples, numBrdfSamples, brdfCutoff, numSpatialSamples]` from the sample's `GetDefaultMinimalSampleInitialSamplingParams` / `GetDefaultMinimalSpaioTemporalParams` values (copy the *values*, not the code).
- `Rtxdi_SaveTextureRGBA32F(app: AppHandle, texture: TextureHandle, path: string): int` — readback + the Task 2 dump format; nonzero on success.

- [ ] **Step 1:** Write `rtxdi.d.ts` with the declarations above and comments in the house style; regenerate `core/donut.ts`; expected: generator succeeds, `git diff --stat core/donut.ts` shows only rtxdi additions.
- [ ] **Step 2:** Implement `core/rtxdi.cpp`. `static_assert` that `sizeof(RAB_LightInfo) == 32` and `sizeof(PrepareLightsTask) == 16` so layout drift fails at compile time.
- [ ] **Step 3: Build** `cmake --build build-rtxdi --target donut_interop_shared`; expected: links (no duplicate `rtxdi::` symbols).
- [ ] **Step 4: Commit** `rtxdi: native glue for ReSTIR DI context, resources and constants`.

### Task 4: Reusable TS module + PrepareLights pass

**Files:**
- Create: `core/rtxdi_di.ts`
- Test: `examples/rtxdi_minimal.ts` (skeleton: loads Arcade synchronously in test mode, builds AS, runs PrepareLights only, test checks)

**Interfaces:**
- Consumes: Task 3 API.
- Produces (in `core/rtxdi_di.ts`):
  - `class RtxdiDI { context; resources; constructor(app: App, scene: SceneHandle, width: int, height: int); prepareLights(commandList): int; setFrameIndex(i: int): void; buffer(which: RtxdiBuffer): BufferHandle; dispose(): void }`
  - `class RtxdiGBuffer { depth; normals; geoNormals; diffuseAlbedo; specularRough; hdrColor; constructor(app: App, width: int, height: int) }` — formats R32_FLOAT, R32_UINT×4, RGBA16_FLOAT as `RenderTargets.cpp`; `class RtxdiRenderTargets { current: RtxdiGBuffer; previous: RtxdiGBuffer; swap(): void }` (check `RenderTargets.cpp` for which textures are doubled and mirror it).
  - `class PrepareLightsPass { constructor(app, bindlessLayout, scene); createBindingSet(di: RtxdiDI): void; dispatch(commandList, di: RtxdiDI): void }` — bindings as `PrepareLightsPass.cpp` (register numbers from `PrepareLights.hlsl`), shader `rtxdi_minimal/PrepareLights_main`.
- Bindless layout: firstSlot 0, register spaces 1 (RawBuffer_SRV), 2 (Texture_SRV), 3 (Texture_UAV), visibility All, capacity 1024; the scene loaded with that descriptor table (`Donut_LoadSceneWithDescriptorTable`).
- AS: `Donut_BuildSceneAccelStructs` **only if** its BLAS flags match `SampleScene::BuildMeshBLASes` (Opaque flag by `MaterialDomain::Opaque`, skinned skipped, PreferFastTrace + AllowCompaction) and TLAS instance flags/mask match `BuildTopLevelAccelStruct`; else add `Rtxdi_BuildSceneAccelStructs(app, commandList, scene): AccelStructHandle` to Task 3's glue mirroring the sample. Record which, with the reason, in a code comment.

- [ ] **Step 1: Write the failing test** — skeleton's `-test` check: `Rtxdi_PrepareLights` returned > 0 lights, and the read-back `LightDataBuffer` has every light's `radiance` nonzero and `center` finite (`isFinite32`); `TestCheck` result names the first failing light.
- [ ] **Step 2: Run** `build-rtxdi/bin/rtxdi_minimal.exe -dx12 -test`; expected FAIL (pass not implemented).
- [ ] **Step 3:** Implement `core/rtxdi_di.ts` and the skeleton.
- [ ] **Step 4: Run** `-dx12 -test -debug` and `-vk -test -debug`; expected PASS, zero validation messages on both (Review Focus 4).
- [ ] **Step 5: Commit** `rtxdi_minimal: RTXDI resources and light preparation`.

### Task 5: The Render pass, UI, Args — the full minimal frame

**Files:**
- Modify: `examples/rtxdi_minimal.ts`, `core/rtxdi_di.ts` (add `RenderPass`)
- Modify: `CMakeLists.txt` (`add_tslang_example(rtxdi_minimal core/rtxdi_di.ts ${RTXDI_GLUE_SOURCES} MEDIA fonts)`; add `rtxdi_minimal_shaders` dependency; D3D12 needs no Agility for SM 6.5 — don't link it unless the ray query needs it)

**Interfaces:**
- `class RenderPass { constructor(app, bindlessLayout, scene); createBindingSets(tlas: AccelStructHandle, targets: RtxdiRenderTargets, di: RtxdiDI): void; render(commandList, di: RtxdiDI, view: ViewHandle, prevView: ViewHandle, s: RtxdiMinimalSettings, width: int, height: int): void; nextFrame(): void }` — two binding sets (current/previous G-buffer as UAVs t0–t4/u2–u6 per `RAB_Buffers.hlsli`), `nextFrame` swaps them; dispatch `div_ceil(w, RTXDI_SCREEN_SPACE_GROUP_SIZE) × div_ceil(h, ...)` (group size value read from the RTXDI header, as a TS const with a comment).
- `class RtxdiMinimalSettings { enableResampling = true; unbiasedMode = false; numLocalLightSamples; numBrdfSamples; brdfCutoff; numSpatialSamples }` — defaults from `Rtxdi_GetDefaultSettings`.
- `class RtxdiMinimalArgs extends Args` — switches `-noResampling`, `-unbiased`, `-initialSamples n` (1–32), `-spatialSamples n` (0–4), `-brdfSamples n` (0–8), `-brdfCutoff x` (0–1), `-camera px py pz tx ty tz`, `-moveCamera dx dy dz`, `-dumpFrame N -dumpPath file`, `-resizeAt N` (test: resize window at frame N); out-of-range values clamp to the UI ranges.
- UI: ImGui window "Settings (Tilde key to hide)" at (10,10), min width 375, AlwaysAutoResize, item width 100: Enable Resampling, Unbiased Mode, Initial Samples, Spatial Samples, Initial BRDF Samples, BRDF Cutoff, separator, `"%05.2f ms/frame (%05.1f FPS)"`. Tilde toggles; camera gets the remaining input.
- Frame order exactly as the design's "Frame structure" (refresh → neighbor offsets once → `setFrameIndex` → PrepareLights → Render → blit HDR → submit → `renderPass.nextFrame()`, `targets.swap()`, `Donut_CopyPlanarView(prevView, view)`). `prevView` seeded from `view` on the first rendered frame. Frame index = the app's frame index, made deterministic in test mode (Review Focus 1).

- [ ] **Step 1: Write the failing test** — `-test` checks: frame read; center pixel not black; mean luminance of the dump within (0.01, 100); no NaN/Inf in the HDR readback.
- [ ] **Step 2: Run** `-dx12 -test`; expected FAIL.
- [ ] **Step 3:** Implement RenderPass, settings, Args, UI, frame loop, `-dumpFrame`.
- [ ] **Step 4: Run** `-dx12 -test -debug`, `-vk -test -debug`; expected PASS, zero validation messages.
- [ ] **Step 5: Resize test** `-test -resizeAt 10 -frames 20` both APIs (`-resizeAt` resizes the test's hidden window — `core/args.ts` has no resize support yet, add it there; if a resize cannot stay hidden on either API, stop and ask the user before running it, per the headless-only rule); expected PASS, no validation messages, no leaks reported at exit (Review Focus 3).
- [ ] **Step 6: Commit** `rtxdi_minimal: fused ReSTIR DI render pass, UI and command line`.

### Task 6: Match the reference

- [ ] **Step 1:** Port dumps for Task 2's cases with identical args (`-width 1280 -height 720 -dumpFrame 60 ...`), both APIs.
- [ ] **Step 2: Compare** with `cmp_hdr.py`; expected: within the ref-vs-ref floor (ideally bit-identical) for `default`, `noresampling`, `unbiased`. If not, debug with `superpowers:systematic-debugging` (compare frame 0 first — no temporal history — then frame 1).
- [ ] **Step 3: Determinism:** the port's `default` twice → bit-identical (Review Focus 1).
- [ ] **Step 4: Moving camera:** `moving` case within the floor (Review Focus 2).
- [ ] **Step 5:** Record the results (numbers per case/API) in the PR description draft and memory.

### Task 7: CTest, JIT, README

**Files:**
- Modify: `CMakeLists.txt` (tests inside `if (RTXDI_DIR)`), `README.md` (example section + screenshot from a headless dump converted to JPG, credits/license note as rtxpt's)

- [ ] **Step 1:** `add_tslang_example_test(rtxdi_minimal ARGS -width 1280 -height 720 -frames 60)` plus `SUFFIX unbiased ARGS ... -unbiased` and `SUFFIX moving ARGS ... -moveCamera 0.01 0 0`; `NO_DEBUG` on vk only if Task 4 Step 4 could not silence the warning (comment why). Run `ctest --test-dir build-rtxdi -R rtxdi_minimal`; expected all pass.
- [ ] **Step 2: JIT:** `tslang --shared-libs=build-rtxdi/bin/donut_interop_shared.dll examples/rtxdi_minimal.ts -- -dx12 -test -dumpFrame 60 -dumpPath <scratch>/jit.bin -width 1280 -height 720` → bit-identical to the AOT dump (Review Focus 5).
- [ ] **Step 3:** Full `ctest` in `build-rtxdi` (needs the asset dirs per memory `asset-folders-for-full-ctest`); expected no new failures vs main.
- [ ] **Step 4: Commit** `rtxdi_minimal: tests and README`; then ask the user before pushing / opening the PR.

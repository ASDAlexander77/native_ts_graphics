# rtxcr_pathtracer_nri Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An NRI port of `examples/rtxcr_pathtracer.ts`: Claire's path-traced hair and skin, on D3D12 and Vulkan, rendering the Donut port's frames.

**Architecture:** The Donut port's C++ side (`core/rtxcr.cpp`) is written against Donut's engine and NVRHI, so it isn't reused. The NRI port splits that work in two:
- **Generic glTF features** go into the existing NRI scene loader (`core/nri/nri_donut_scene.cpp`, which already loads scenes "as Donut's engine loads them"): curve meshes, morph targets and the scene file's lights. No RTXCR code is needed for these.
- **RTXCR-specific work** goes into a new `core/nri/nri_rtxcr.cpp`: curve tessellation (RTXCR's header-only `CurveTessellation.h`), morph-target buffers and NRD. It's compiled into `nri_interop` only when `RTXCR_DIR` is given.

The example, `examples/nri/rtxcr_pathtracer_nri.ts`, mirrors the Donut example's `Renderer` pass for pass. It uses the same shaders, compiled in place from `RTXCR_DIR` by the existing `rtxcr_pathtracer_shaders` target.

**Tech Stack:** tslang, NRI v176 / NRIFramework (`core/nri/nri_interop`), RTXCR (`E:/Gits/RTXCR`: shaders, `libraries/rtxcr/geometry/include`, assets), NRD 4.17 with its NRI integration layer (`external/RayTracingDenoiser/Integration/NRDIntegration.h`).

**Spec:** the conversation of 2026-11-03 ("Yes, plan it") plus the existing Donut port: `examples/rtxcr_pathtracer.ts`, `core/rtxcr.cpp`, `core/rtxcr_scene.ts`, its CTest entries (CMakeLists.txt, about line 4678) and memory note `rtxcr-pathtracer-port.md`.

## Global Constraints

- **License:** RTXCR is under the NVIDIA RTX SDKs License. Nothing from `RTXCR_DIR` is copied into the repo: shaders and headers are used in place. `core/nri/nri_rtxcr.cpp` carries the same 2(b) notice as `core/rtxcr.cpp`. Ask before pushing the branch or opening a PR.
- **Build gating:** without `RTXCR_DIR`, `nri_interop` builds without `nri_rtxcr.cpp`, and the example and its tests aren't registered (as the Donut port).
- **Same shaders:** reuse `rtxcr_pathtracer_shaders` (`shaders/rtxcr_pathtracer.cfg`). On both APIs, use the `LSS_GEOMETRY_SUPPORTED=0 API_DX12=0` permutations: NRI has no NVAPI shader extensions, so no linear swept spheres.
- **Hair default:** polytubes on both APIs. `-hairTessellationType 2` (LSS) prints "Linear swept spheres need NVAPI, which NRI doesn't expose: polytubes instead" and uses 0.
- **APIs:** D3D12 and Vulkan; D3D11 exits with 77 (TEST_SKIPPED), as the other ray tracing NRI ports.
- **Port conventions:** resizable from the start (`Nri_UseResizableWindow`, `resizeIfNeeded`, off under `-test`); ImGui settings window via `Nri_UseImgui`.
- **Command line:** the Donut port's options and defaults, by the same names: `-frames`, `-noAccumulate`, `-hairTessellationType`, `-hairRadiusScale`, `-switchTessellation`, `-enableAnimation`, `-denoiser`, `-nrdMode`, `-width`, `-height`, `--scene`, `-noUI`.
- **Working rules:**
  - Work in a worktree off `origin/main`, never in the shared checkout `I:\native_ts_graphics`, whose branch the powder-sandbox session owns.
  - Build in `build-rtxcr/` (configured with `-DRTXCR_DIR=E:/Gits/RTXCR`). It also holds the Donut reference exe `rtxcr_pathtracer.exe`.
  - Tests only headless (`-test`, hidden window). Ask before anything that shows windows (resize test, screenshots).
  - tslang bugs: write them up in `I:\TypeScriptCompiler\TSLANG_ISSUES.md` (Open section) and work around them.

## Review Focus

1. **Resize while accumulating or denoising** resets accumulation and resizes NRD; no stale-size textures. Task 4 covers it with the resize test; Task 7 re-runs it with `-denoiser 1`.
2. **Switching tessellation while animating** rebuilds the curve geometry, the morph buffers and the BLASes without validation errors (`-switchTessellation` together with `-enableAnimation 1`). Covered by a test in Task 6.
3. **Missing `RTXCR_DIR` or assets:** with no `--scene` file, the example prints "Cannot load the scene: set RTXCR_DIR and pass --scene <RTXCR_DIR>/assets/claire.scene.json" and returns 1. Covered by a test in Task 3.
4. **`-hairTessellationType 2`** falls back to polytubes with the message above, on both APIs. Covered by a test in Task 2.
5. **`-debug` output stays clean** on both APIs: no "NRI ERROR" / "NRI WARNING" lines. Every task's verification greps for them.

---

### Task 1: Curves, morph targets and lights in the NRI scene loader

**Files:**
- Modify: `core/nri/nri_donut_scene.cpp` (the importer: mirror Donut's `GltfImporter` curve and morph handling, about lines 1017-1116 and 1549-1580; the `.scene.json` graph loader near line 1452), `core/nri/nri_interop.d.ts`
- Modify: `examples/rtxcr_pathtracer.ts` (the Donut port) and `core/rtxcr.cpp`: add a `-printScene` option for the reference numbers

**Interfaces:**
- Produces, in `nri_interop.d.ts`, on `NriDonutSceneHandle`:
  - `Nri_GetDonutSceneMeshCount(scene): int`, `Nri_GetDonutSceneMeshName(scene, mesh): string`
  - `Nri_GetDonutSceneMeshType(scene, mesh): int`: Donut's `MeshType` values (0 triangles, 1 curve polytubes, 2 curve DOTS, 3 curve LSS)
  - `Nri_GetDonutSceneCurveVertexCount(scene, mesh): int` and `Nri_CopyDonutSceneCurveVertices(scene, mesh, dst: Ref<f32>)`: position and radius, 4 floats per vertex, in line-strip or lines order, plus `Nri_GetDonutSceneCurvePrimitiveType(scene, mesh): int` (0 lines, 1 line strip)
  - `Nri_GetDonutSceneMorphTargetCount(scene, mesh): int` and `Nri_CopyDonutSceneMorphTarget(scene, mesh, target, dst: Ref<f32>)`: 3 floats per vertex
  - `Nri_GetDonutSceneLightCount(scene): int` and `Nri_GetDonutSceneLight(scene, light, dst: Ref<f32>)`: 12 floats (type, direction xyz, color rgb, irradiance, angular size, 3 reserved), directional lights from the graph's `"Lights"` node
  - The existing instance, geometry and material getters keep their meaning. Curve meshes get instances whose geometry is filled in Task 2.

- [ ] **Step 1:** Add `-printScene` to the Donut port. It prints one line per mesh, `mesh <i> <name> type <t> curveVertices <n> morphTargets <m>`, then `light <i> <type> <dir> <color> <irradiance> <angularSize>`, and exits 0 before rendering. Record its output for `claire.scene.json` and `claire.animation.scene.json` in the scratchpad (`ref_scene.txt`, `ref_scene_anim.txt`).
- [ ] **Step 2:** Implement the getters above. Curves follow the importer's rules: a `LINES` or `LINE_STRIP` primitive with a radius attribute becomes a curve mesh. Morph targets are read only for curve meshes, as the importer's `isMorphTargetAnimationMesh` does. Lights follow `Scene::Load`'s light parsing: rotation quaternion to direction, `irradiance`, `angularSize`, `color` default (1,1,1).
- [ ] **Step 3:** Add a throwaway scratchpad `.ts` (not committed) that loads the scene through these getters and prints the same lines. Run it on both scene files and diff against Step 1. Expected: identical text.
- [ ] **Step 4:** Rebuild and run every NRI test that loads Donut scenes, headless (`headless_ctest.py` with regex `bindless_rendering_nri|threaded_rendering_nri|rt_bindless_nri|deferred_shading_nri|feature`). Expected: all pass (no regression from the importer changes).
- [ ] **Step 5:** Commit: "NRI: scene loader imports curves, morph targets and lights".

### Task 2: Curve tessellation and acceleration structures (`nri_rtxcr.cpp`)

**Files:**
- Create: `core/nri/nri_rtxcr.cpp` (2(b) notice; includes `rtxcr/geometry/include/CurveTessellation.h`)
- Modify: `core/nri/CMakeLists.txt`:
  - Add `NRI_RTXCR_DIR`.
  - When it's set, add `nri_rtxcr.cpp` with include directories `${NRI_RTXCR_DIR}/libraries` and `${NRI_RTXCR_DIR}/samples/pathtracer`, and define `NRI_WITH_RTXCR`.
- Modify: root `CMakeLists.txt`: pass `-DNRI_RTXCR_DIR=${RTXCR_DIR}` to `nri_interop_build`, next to `NRI_D3D_AGILITY_SDK_VERSION`.
- Modify: `core/nri/nri_interop.d.ts`

**Interfaces:**
- Consumes: Task 1's curve getters.
- Produces (`NriRtxcrSceneHandle`), mirroring `Donut_Rtxcr*` in `core/rtxcr.cpp`:
  - `Nri_RtxcrCreateScene(device, queue, scene: NriDonutSceneHandle, hairRadiusScale: number, tessellationType: int): NriRtxcrSceneHandle | null`
  - `Nri_RtxcrDestroyScene(s)`
  - `Nri_RtxcrSetTessellationType(s, type: int): int`: 1 if it changed. It rebuilds the curve meshes' vertex and index data and their BLASes.
  - `Nri_RtxcrGetCurveMeshCount(s): int`
  - `Nri_RtxcrCmdBuildTlas(s, commandBuffer, showEmissiveSurfaces: int, bufferIndex: int)`
  - `Nri_RtxcrGetTlas(s): NriAccelerationStructureHandle`
  - `Nri_RtxcrGetInstanceBuffer(s)`, `Nri_RtxcrGetGeometryBuffer(s)`, `Nri_RtxcrGetVertexBuffer(s, index)`, `Nri_RtxcrGetIndexBuffer(s, index)`: Donut bindless layout (`InstanceData`, `GeometryData`), the curve meshes' tessellated buffers appended after the scene's
  - `Nri_RtxcrGetBindlessBufferCount(s): int`

- [ ] **Step 1:** Extend Task 1's Donut `-printScene` with the tessellation output: per curve mesh `tess <mesh> <type> vertices <v> indices <i>`, for types 0 and 1. Record it as `ref_tess.txt`.
- [ ] **Step 2:** Implement the functions above: line segments from the curve strips (as `convertCurveLineStripsToLineSegments` in `core/rtxcr.cpp`), then polytubes or DOTS via `CurveTessellation.h`, BLASes per mesh, and TLAS instance masks and flags as `Donut_RtxcrBuildTlas`.
- [ ] **Step 3:** Print the same `tess` lines from the scratchpad loader through the NRI functions. Diff against `ref_tess.txt`. Expected: identical.
- [ ] **Step 4:** Add the LSS fallback (Global Constraints) in `Nri_RtxcrCreateScene` / `Nri_RtxcrSetTessellationType`: type 2 becomes 0, with the message. Verify that the scratchpad loader passed type 2 prints the message and the type 0 counts.
- [ ] **Step 5:** Configure `build-rtxcr` without `RTXCR_DIR` in a throwaway build dir and build `nri_interop`. Expected: it builds and doesn't export `Nri_Rtxcr*`.
- [ ] **Step 6:** Commit: "NRI: RTXCR curve tessellation and acceleration structures".

### Task 3: The path-traced frame (static scene)

**Files:**
- Create: `examples/nri/rtxcr_pathtracer_nri.ts`
- Modify: root `CMakeLists.txt`, next to the Donut port's block (about line 4678), inside its `if (RTXCR_DIR)`:
  - `add_tslang_nri_example(rtxcr_pathtracer_nri SHADERS rtxcr_pathtracer_shaders core/donut_first_person_camera.ts)`
  - `add_tslang_example_test(rtxcr_pathtracer_nri ARGS -width 960 -height 540 --scene ${RTXCR_DIR}/assets/claire.scene.json)`
  - `add_tslang_example_test(rtxcr_pathtracer_nri SUFFIX noscene ARGS --scene does_not_exist.scene.json WILL_FAIL)`, or the repo's equivalent for an expected exit 1 (check how other tests expect failure)
- Modify: `core/nri/nri_interop.cpp` only if a binding the passes need is missing. Check first: raw buffer ranges in a bindless set, `RGBA32_SFLOAT` storage textures, graphics pipeline to an sRGB target.

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: the `Renderer`-equivalent class `RtxcrPathtracer`. Its methods, in the Donut example's order:
  - `createTargets()`: the window-size UAV textures, the Donut list at `examples/rtxcr_pathtracer.ts:975-999`, same formats
  - `createPipelines()`: GBuffer RT, path tracer RT, tonemap graphics
  - `createSets()`
  - `updateConstants(queuedFrameIndex)`: the `GlobalConstants` / `LightingConstants` byte layout, copied from the Donut example's offset table
  - `recordFrame(commandBuffer, queuedFrameIndex)`

- [ ] **Step 1:** Make the pass structure match the Donut example's: GBuffer trace, then path trace with accumulation into `accumulation`, then the tonemap pass into the `ldr` sRGB target, then a copy to the swap chain.
  - **Pipeline layout:** set 0 holds the per-pass bindings at the Donut example's binding slots. Set 1 is the bindless set: raw buffers in space 2 and textures in space 3 (Donut's `addRawBuffers(2)` / `addTextures(3)`), up to 1024 entries.
  - **Shader tables:** groups in the Donut example's order (ray generation, miss, then closest-hit groups).
- [ ] **Step 2:** Write `checkFrame`: the Donut example's thresholds, from `examples/rtxcr_pathtracer.ts:1652`.
- [ ] **Step 3:** Run the reference at 960x540 with polytubes, 32 frames, and save the frames:
  - `rtxcr_pathtracer.exe -vk|-dx12 -test -width 960 -height 540 -hairTessellationType 0 -frames 32 -testOutput <scratch>/ref_static_<api>.png --scene E:/Gits/RTXCR/assets/claire.scene.json`
- [ ] **Step 4:** Run the port the same way, `-testOutput <scratch>/nri_static_<api>.png`, and compare with `cmp.py`, the settings window masked.
  - **Pass:** 0 differing pixels outside the window.
  - **Otherwise:** record the count and the mean difference, and find the cause before moving on. Accumulation is deterministic in the Donut port.
- [ ] **Step 5:** Run both tests through CTest headless with `-debug` and grep for messages. Expected: the main test passes, `noscene` exits 1 with the message, and there are no NRI error or warning lines.
- [ ] **Step 6:** Commit: "NRI: rtxcr_pathtracer_nri path traces Claire".

### Task 4: Camera, settings window, resizing

**Files:**
- Modify: `examples/nri/rtxcr_pathtracer_nri.ts`

**Interfaces:**
- Consumes: Task 3's class.
- Produces:
  - `buildUI()`: the Donut `UserInterface` subset (`examples/rtxcr_pathtracer.ts:321-540`) minus the DLSS and DLSS-NR sections
  - `resizeIfNeeded()`: recreates the swap chain and every `createTargets()` texture, re-points every set's slots, and resets accumulation and the frame counter

- [ ] **Step 1:** Port the camera (`DonutFirstPersonCamera`; mouse ignored while ImGui wants it), the settings window and `-noAccumulate`.
- [ ] **Step 2:** Implement `resizeIfNeeded()` as described in Interfaces.
- [ ] **Step 3:** Re-run Task 3's comparison. Expected: unchanged (0 differing pixels outside the window).
- [ ] **Step 4:** Ask the user before running `resize_batch.py dx12,vk rtxcr_pathtracer_nri` (visible windows); run it on a yes. Expected: OK on both APIs.
- [ ] **Step 5:** Commit: "NRI: rtxcr_pathtracer_nri settings window and resizing".

### Task 5: Morph-target hair animation

**Files:**
- Modify: `core/nri/nri_rtxcr.cpp`, `core/nri/nri_interop.d.ts`, `examples/nri/rtxcr_pathtracer_nri.ts`, root `CMakeLists.txt` (test)

**Interfaces:**
- Consumes: Task 1's morph getters and Task 2's scene.
- Produces:
  - `Nri_RtxcrCreateMorphTargets(s, pipelineLayout, shaderPathPrefix: string): int`: animated mesh count. It loads `morphTargetAnimation.cs.hlsl`'s permutation for the current tessellation type.
  - `Nri_RtxcrCmdAnimateMorphTargets(s, commandBuffer, frameIndex: int, elapsedSeconds: number, enable: int): int`: runs the compute pass and rebuilds the animated BLASes.
  - `Nri_RtxcrGetMorphTargetMask(s): NriBufferHandle`
  - Double vertex buffers: the hit shaders read the frame's buffer and the previous frame's, through consecutive bindless descriptors (as `DynamicVertexBuffers` in `core/rtxcr.cpp`).

- [ ] **Step 1:** Add the test `add_tslang_example_test(rtxcr_pathtracer_nri SUFFIX animation ARGS -width 960 -height 540 -enableAnimation 1 --scene ${RTXCR_DIR}/assets/claire.animation.scene.json)`.
- [ ] **Step 2:** Implement the functions above with the Donut port's timing: the frame's elapsed seconds, fixed at 1/60 under `-test`.
- [ ] **Step 3:** Compare against the reference with `-enableAnimation 1 -frames 32` on both APIs, as in Task 3 Step 4. Expected: 0 differing pixels outside the window.
- [ ] **Step 4:** Run the CTest entries headless with `-debug`. Expected: pass, no messages.
- [ ] **Step 5:** Commit: "NRI: rtxcr_pathtracer_nri hair animation".

### Task 6: Switching tessellation at run time

**Files:**
- Modify: `examples/nri/rtxcr_pathtracer_nri.ts`, root `CMakeLists.txt` (tests)

**Interfaces:**
- Consumes: `Nri_RtxcrSetTessellationType`, `Nri_RtxcrCreateMorphTargets`.

- [ ] **Step 1:** Add the tests `SUFFIX switch ARGS ... -switchTessellation <frame>` (the Donut port's value) and `SUFFIX switch_animation ARGS ... -switchTessellation <frame> -enableAnimation 1 --scene .../claire.animation.scene.json`.
- [ ] **Step 2:** Implement the switch:
  - When: at the start of a frame (the settings window's combo, or `-switchTessellation`).
  - Order: wait for the device, then `Nri_RtxcrSetTessellationType`, recreate the morph targets, rewrite the bindless set's curve entries, then reset accumulation.
- [ ] **Step 3:** Compare against the reference with the same arguments, as in Task 3 Step 4. Expected: 0 differing pixels outside the window. Then run CTest headless with `-debug`: pass, no messages.
- [ ] **Step 4:** Commit: "NRI: rtxcr_pathtracer_nri switches hair tessellation".

### Task 7: NRD (ReBLUR and ReLAX)

**Files:**
- Modify: `core/nri/CMakeLists.txt`: build NRD from `${NRI_RTXCR_DIR}/external/RayTracingDenoiser` as a static library, shaders embedded (`NRD_EMBEDS_DXIL_SHADERS` / `NRD_EMBEDS_SPIRV_SHADERS` ON).
- Modify: `core/nri/nri_rtxcr.cpp`: NRD through `NRDIntegration.h` / `.hpp`.
- Modify: `core/nri/nri_interop.d.ts`, the example, root `CMakeLists.txt` (tests)

**Interfaces:**
- Produces, mirroring `Donut_RtxcrNrd*`:
  - `Nri_RtxcrNrdCreate(device, mode: int, width: int, height: int): NriRtxcrNrdHandle | null`, where mode 0 is ReBLUR and 1 is ReLAX
  - `Nri_RtxcrNrdResize(n, width, height): int`, `Nri_RtxcrNrdDestroy(n)`
  - `Nri_RtxcrNrdSetSetting(n, key: int, value: number)`: the Donut port's keys
  - `Nri_RtxcrNrdGetHitDistanceParameter(n, index: int): number`
  - `Nri_RtxcrNrdDenoise(n, commandBuffer, frameIndex, viewMatrices: Ref<f32>, textures...)`: same inputs as `Donut_RtxcrNrdDenoise`

- [ ] **Step 1:** Check that NRD 4.17's `NRDIntegration` compiles against NRI v176 (it checks `NRI_VERSION`). If it doesn't, stop and report the mismatch with the version numbers: a patch versus an NRD bump is the user's call.
- [ ] **Step 2:** Add tests matching the Donut port's: `nrd_reblur` (`-denoiser 1 -nrdMode 0 -frames 32`), `nrd_relax` (`-nrdMode 1`), and `nrd_animation` (`-nrdMode 0 -enableAnimation 1`, animation scene).
- [ ] **Step 3:** Implement the functions above, plus the `denoiser.hlsl` `demodulate` / `composite` passes (`USE_RELAX` permutations) around NRD, as the Donut example does.
- [ ] **Step 4:** Compare with the Donut port's `-denoiser 1` frames.
  - Expected: mean absolute difference no worse than the Donut port's own NRD-against-reference level (about 1.7/255; see the memory note). Report the number.
  - Exact equality isn't required: NRD's NRI integration and our NVRHI glue differ in resource handling.
- [ ] **Step 5:** Run CTest headless with `-debug`: pass, no messages. Then ask the user to re-run the resize test with `-denoiser 1`.
- [ ] **Step 6:** Commit: "NRI: rtxcr_pathtracer_nri denoises with NRD".

### Task 8: Docs and PR

**Files:**
- Modify: `docs/nri_migration_order.md`:
  - Move rtxcr out of Excluded (keep `rtxcr_raster`, `rtxpt` there).
  - Describe the port, the LSS fallback, DLSS not ported (NRI's upscaler extension could add DLSS-SR later; DLSS 5 has no NRI path), and the verification numbers.
  - Add it to the "Resizable windows" list.
- Modify: `README.md` if its RTXCR section lists the examples.

- [ ] **Step 1:** Run the whole NRI suite headless in `build-rtxcr` (`headless_ctest.py`). Expected: all pass, no visible windows.
- [ ] **Step 2:** Write the docs.
- [ ] **Step 3:** Commit: "NRI: rtxcr_pathtracer_nri docs".
- [ ] **Step 4:** Ask the user before pushing or opening the PR (RTXCR license). Then push, open the PR with the Claude Code footer, and bind it.

**Out of scope** (say so in the PR): DLSS-SR and DLSS-RR (possible later through NRI's upscaler extension), DLSS 5, linear swept spheres on D3D12, `rtxcr_raster`.

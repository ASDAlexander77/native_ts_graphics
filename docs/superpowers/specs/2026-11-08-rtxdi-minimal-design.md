# RTXDI minimal sample — design

Date: 2026-11-08. Status: reviewed (builder check done), awaiting user approval.

## Intent

Add a TypeScript (tslang) example that demonstrates NVIDIA RTXDI (ReSTIR DI) in native_ts_graphics,
the way `rtxcr_*`, `rtxpt`, `rtxmg_demo` and `streamline_demo` demonstrate the other RTX SDKs. RTXDI
is next in the user's RTX SDK order (then RTXGI 2.x SHARC + NRC, RTX Neural Shaders, RTX Neural
Texture Compression, RTX Texture Filtering; NIS is not wanted).

**Scope (user, 2026-11-08):** the RTXDI **Minimal Sample** — single-pass fused ReSTIR DI on the
Arcade scene — as a stand-alone minimal demo now, before moving on to RTXGI. It is a stepping stone
toward a later port of the Full Sample (ReSTIR DI/GI/PT, NRD, DLSS, four scenes), so the pieces that
the Full Sample will need again are built to be reused, but nothing of the Full Sample is built now.

The reference is the local clone `E:\Gits\RTXDI` (RTXDI SDK **v3.0.0**, commit `1b55517`, one past
the tag; library submodule `Libraries/Rtxdi` at `d28e20f`).

## Goals

- New example `rtxdi_minimal` (`examples/rtxdi_minimal.ts`) reproducing the Minimal Sample's frame:
  - loads `Assets/Media/Arcade/Arcade.gltf` from the RTXDI checkout;
  - the sample's camera: first-person, `LookAt((-1.658, 1.577, 1.69), (-0.9645, 1.2672, 1.0396))`,
    move speed 3, vertical FOV 60°, reverse-Z infinite projection with near 0.01
    (`perspProjD3DStyleReverse`), no pixel jitter;
  - per frame: `PrepareLights` compute pass (emissive triangles → RTXDI light buffer), then the
    `Render` compute pass (primary rays, G-buffer write, fused spatiotemporal ReSTIR DI, shading),
    then blit of the HDR output straight to the swapchain (no tone mapping, no denoiser, no TAA —
    exactly as the sample);
  - ImGui window "Settings (Tilde key to hide)": Enable Resampling, Unbiased Mode, Initial Samples
    (1–32), Spatial Samples (0–4), Initial BRDF Samples (0–8), BRDF Cutoff (0–1), frame time; Tilde
    toggles it.
- Each UI knob also has a command-line switch on a per-example `Args` subclass (`core/args.ts`).
- D3D12 and Vulkan (`-dx12` / `-vk`, the repo's usual switches), both of which the reference
  supports (`--vk` in the sample).
- Headless `-test` mode with ctest entries for both APIs (`core/test_check.ts`).
- Verified frame by frame against the reference build of the Minimal Sample, same API.

## Non-goals / anti-goals

- No Full Sample features now: no ReSTIR GI/PT, no ReGIR, no presampling/RIS buffers, no NRD, no
  DLSS, no TAA, no environment map, no other scenes. (They come with the later Full Sample port.)
- Nothing of RTXDI's code copied into this repository. RTXDI (library and samples) is under the
  NVIDIA RTX SDKs License; the sample headers even carry a "proprietary" notice. Same model as
  `rtxpt`: everything is used in place from the checkout via a CMake `RTXDI_DIR` path; we write our
  own host code.
- No RTXDI assets committed (the Arcade is MIT, but it stays in the checkout like RTXPT's assets).
- No visible windows on the user's desktop during tests (headless / hidden-window only; ask first
  for anything visible).
- Ctrl+R shader reload is **not** ported *(Claude's call: shaders are prebuilt by ShaderMake; the
  repo's examples don't hot-reload)*.

## Constraints and facts (from the survey)

- `E:\Gits\RTXDI` has all submodules and LFS assets pulled. A reference build already exists:
  `E:\Gits\RTXDI\build\bin\MinimalSample.exe` (and `FullSample.exe`), DX12 + Vulkan on, DX11 off,
  NVAPI on, DLSS on. Shaders at `build/bin/shaders/minimal-sample/{dxil,spirv}`.
- The reference's DXC is the one RTXDI's CMake downloads (`External/dxc`, v1.8.2505.1). The Minimal
  Sample's `Shaders/CMakeLists.txt` passes ShaderMake `--shaderModel 6_5 --vulkanVersion 1.2
  --relaxedInclude "../Types.h" -D SPIRV` (SPIR-V only) and `NVRHI_DEFAULT_VK_REGISTER_OFFSETS`. Our
  config uses the same options; a different DXC build is an accepted source of float noise (note
  any residual).
- RTXDI pins Donut `2c10776` (Feb 2026); ours (`35d1cba`, Oct 2026) contains it, so no Donut bump.
  `rtxpt` already includes an *older* RTXDI copy (`RTXPT_DIR/External/Rtxdi`, Mar 2026, pre-3.0);
  the two must not mix — `rtxdi_minimal` uses only `RTXDI_DIR`'s headers.
- The Minimal Sample's command line is only `--debug` and `--vk`. It has no frame dump, no
  resolution switch (window 1920×1080, render size = back buffer), no fixed-frame-count exit.
- The sample loads the scene **asynchronously** (`SetAsynchronousLoadingEnabled(true)`); ReSTIR's
  random sequences and the RTXDI context are seeded by `GetFrameIndex()`, so the frame index of the
  first rendered frame can differ run to run. Fused ReSTIR is temporal — frame N depends on every
  rendered frame before it — so verification must align the whole frame-index sequence, not just
  "frame N" (see Verification).
- The Arcade has no glTF animations; the camera is static unless moved. Emissive materials exist
  (the arcade cabinets' `Cabinet_Emissive.png`): the light set is the emissive triangles only, no
  analytic lights.
- Known reference noise: the Vulkan validation layer warns that `t_NeighborOffsets` doesn't align
  with its buffer (RTXDI README "Known Issues"; the sample creates it `NeighborOffsetCount * 2`
  bytes, `RtxdiResources.cpp:60`). Our `-test` fails on any validation message, so *(Claude's
  call)* our host code allocates that buffer padded to the device's texel-buffer alignment (same
  format, same contents — the image is unaffected) so the warning doesn't occur. Only if that
  doesn't silence it does the Vulkan ctest fall back to `NO_DEBUG` (as the PTLAS test), with the
  reason in a comment.
- `RTXPT_DIR` and `RTXDI_DIR` in one build tree are **unsupported for now** *(Claude's call)*:
  `rtxpt_core` exports RTXPT's older RTXDI headers as a PUBLIC include into the one JIT DLL
  (`donut_interop_shared`), which would leak into `core/rtxdi.cpp`. Configure stops with a clear
  error if both are set; the separate `*-rtxdi` presets keep them apart. Revisit (per-source
  include isolation) when the Full Sample port needs it.
- Vulkan: the Render pass uses inline ray queries (`RaytracingAccelerationStructure` + `RayQuery`
  in a compute shader); the device must enable ray tracing extensions as the repo's other ray-query
  examples do (`Feature.RayQuery` is in `core/interop/device.d.ts`).
- Existing interop that covers most of the host side: `Donut_BuildSceneAccelStructs` /
  `Donut_GetSceneTopLevelAS` (BLAS per mesh + TLAS over a loaded Donut scene), mesh-instance and
  geometry walking in `core/interop/scene.d.ts` (`Donut_GetSceneGraphMeshInstanceCount`,
  `Donut_GetMeshInstanceGeometryCount`, …), scene buffers (`Donut_GetSceneBuffer`), descriptor
  table manager / bindless layout, scene loading with a descriptor table.
- `core/donut.ts` is generated — never hand-edited; new interop goes in a new `.d.ts` in
  `core/interop/` (e.g. `rtxdi.d.ts`) plus `core/rtxdi.cpp`, then the generator is rerun.

## Decided shape

### Build (*Claude's call, following `rtxpt`*)

- CMake cache path `RTXDI_DIR` ("RTXDI checkout (github.com/NVIDIA-RTX/RTXDI) with its submodules and
  assets"), empty by default; the example and its tests build only when it is set. New presets
  `default-rtxdi` / `release-rtxdi` inheriting the base presets, `RTXDI_DIR = E:/Gits/RTXDI`, own
  build folder (reusing `_deps` like the other SDK presets).
- **RTXDI host library** compiled in place as a static library `rtxdi_runtime` from
  `RTXDI_DIR/Libraries/Rtxdi/Source/*.cpp` (all of it — `ReSTIRDI.cpp`, `RtxdiUtils.cpp`, and the
  GI/PT/ReGIR/ImportanceSampling sources the Full Sample will need later; they are small and
  self-contained), include dir `Libraries/Rtxdi/Include`. Alternatively RTXDI's own
  `Libraries/Rtxdi/CMakeLists.txt` via `add_subdirectory` if it builds cleanly against our tree —
  builder's choice.
- **Shaders** compiled in place by `donut_compile_shaders` with a config of our own
  (`shaders/rtxdi_minimal.cfg`, two lines: `PrepareLights.hlsl -T cs -E main`,
  `Render.hlsl -T cs -E main`), `--sourceDir RTXDI_DIR/Samples/MinimalSample/Shaders`, includes
  `RTXDI_DIR/Libraries/Rtxdi/Include` and **our** Donut shader headers (the scene's
  `InstanceData`/`GeometryData`/`MaterialConstants` layouts must match our Donut's scene buffers —
  the RTXPT precedent). Output `bin/shaders/rtxdi_minimal/{dxil,spirv}`.
- **Native glue** `core/rtxdi.cpp` (with the license notice "This software contains source code
  provided by NVIDIA Corporation." where the supplement asks for it, as `core/rtxpt.cpp` does), and
  `core/interop/rtxdi.d.ts`.
- **Assets** referenced in place (`RTXDI_DIR/Assets/Media`); the example takes the Arcade path from
  a build-time define or a link next to the executable, like rtxpt's `Assets` junction. For ctest
  this is the same `RTXDI_DIR`, so no extra `*_ASSETS_DIR` variable is needed.
- README section and credits entry, as for rtxpt.

### Host split: what is TypeScript, what is C++

The sample's own C++ (~1.7k lines: `main.cpp`, `PrepareLightsPass`, `RenderPass`, `RtxdiResources`,
`RenderTargets`, `SampleScene`, `UserInterface`) is rewritten as our code.

- **TypeScript** (`examples/rtxdi_minimal.ts` + reusable `core/rtxdi_*.ts` modules): app/frame loop,
  camera, view + previous view, UI, Args, render targets (two G-buffer sets ping-ponged), the two
  passes' pipelines and binding sets, dispatch, blit, test mode.
- **C++ glue** (`core/rtxdi.cpp`), *Claude's call*: everything that touches RTXDI's C++ types or the
  sample's `ShaderParameters.h` struct layouts:
  - an opaque `RtxdiDIContext` handle wrapping `rtxdi::ReSTIRDIContext` (create with render size,
    `SetFrameIndex`, buffer indices, reservoir buffer parameters, neighbor-offset count);
  - neighbor-offset buffer fill (`rtxdi::FillNeighborOffsetBuffer`), and the reservoir buffer size;
  - **constant buffers filled in C++**: `ResamplingConstants` (two `PlanarViewConstants` + RTXDI
    parameter structs) and the PrepareLights constants, written by glue functions that take the
    TS-side view matrices/settings. The struct headers are included in place from
    `RTXDI_DIR/Samples/MinimalSample/Shaders/ShaderParameters.h`; TS never mirrors their byte
    layout (hand-mirrored layouts drift).
  - light preparation's CPU part (counting emissive meshes/triangles, the `PrepareLightsTask` list
    and the geometry-instance → light index map), since it reads Donut material emissive data
    and RTXDI types — unless the existing scene interop already exposes everything, in which case
    the walk may stay in TS (builder's choice; the output buffers' layouts stay in C++).
  - the sample's default sampling parameters (`GetDefaultMinimalSampleInitialSamplingParams`,
    `GetDefaultMinimalSpaioTemporalParams`) — reproduced in our glue with the same values.
- Acceleration structures: reuse `Donut_BuildSceneAccelStructs` if its per-geometry flags match the
  sample's `SampleScene::BuildMeshBLASes` (Opaque flag only for opaque-domain materials, skinned
  meshes skipped, TLAS instance mask/flags as the sample's `BuildTopLevelAccelStruct`); otherwise a
  small new glue function. Differences there change visibility and so the image.

### Frame structure (must match the sample exactly)

1. Set up view (viewport = back buffer size, no jitter) and seed `viewPrevious = view` on the first
   rendered frame.
2. Create on first use / after resize: RTXDI context (render size), render targets, RTXDI resources
   (light data, neighbor offsets, geometry-instance-to-light, reservoirs), binding sets.
3. Command list: scene refresh → neighbor offsets (once) → `context.SetFrameIndex(frameIndex)` →
   PrepareLights → Render (constants: views, enableResampling, sampling params, reservoir params,
   light buffer params, `neighborOffsetMask`, `activeCheckerboardField = 0`, frame index,
   `inputBufferIndex = temporalResamplingInputBufferIndex`,
   `outputBufferIndex = initialSamplingOutputBufferIndex`) → blit HDR to back buffer.
4. After submit: swap the two Render binding sets (current/previous G-buffer) and the render
   targets' current/previous, `viewPrevious = view`. This ping-pong is where temporal ports break:
   it gets its own check in the plan.

### Reuse toward the Full Sample (one paragraph, by design not built now)

What carries over: the `RTXDI_DIR` build (library + in-place shader compile), `rtxdi_runtime`, the
context/constant glue pattern, light preparation (the Full Sample's `PrepareLightsPass` is a
superset: adds analytic and environment lights), RTXDI resources, render-target ping-pong and the
reference-verification recipe. What gets replaced: the single fused `Render.hlsl` becomes the Full
Sample's multi-pass pipeline (G-buffer pass, initial/temporal/spatial passes, shading, denoisers).
So `core/rtxdi_*.ts` holds the reusable parts (context wrapper, resources, light preparation) and
`examples/rtxdi_minimal.ts` only the minimal-specific frame.

## Verification

- **Reference:** `E:\Gits\RTXDI\build\bin\MinimalSample.exe`, rebuilt with a **local, uncommitted
  patch** in the RTXDI working tree (as done for Streamline) that adds: synchronous scene loading
  (or a logged frame index of the first rendered frame), a fixed render size switch, a hidden
  window, and "dump the HDR output of frame N to a float file and exit". The patch is kept as a file
  in the session notes / scratchpad, not in this repo.
- **Port:** `rtxdi_minimal -test -testOutput <file>` with the same size, the same frame-index
  sequence (first rendered frame index matches the reference's; a `-captureStart`-style alignment
  as in rtxpt if needed), dumps the same frame.
- Compare same API only (D3D12 vs D3D12, Vulkan vs Vulkan), on the HDR float output before blit.
  Expect bit-identical or near (compiler/shader-model differences aside); check the static camera
  case over a warm-up of several frames (temporal reservoirs), and at least one setting change
  (resampling off; unbiased mode on) and one moved-camera case (test-mode camera path or a second
  fixed `LookAt`) so the temporal reprojection with `viewPrevious` is exercised.
- Ref-vs-ref run-to-run variation is measured first, so port differences are judged against it.
- ctest: `rtxdi_minimal.dx12`, `rtxdi_minimal.vk` (headless, `test_check.ts` thresholds), only when
  `RTXDI_DIR` is set.
- JIT run (`tslang --shared-libs=... examples/rtxdi_minimal.ts -- ...`) matches the AOT build.

## Left to the builder

- Exact CMake wiring (own `add_library` vs RTXDI's `Libraries/Rtxdi/CMakeLists.txt`).
- Which light-preparation steps stay in TS vs C++, within the rule that RTXDI/`ShaderParameters.h`
  struct layouts live only in C++.
- Whether `Donut_BuildSceneAccelStructs` is reused or a matching glue function is added.
- The reference patch details and test frame counts/thresholds.
- Branch/PR flow as usual (design + plan committed on branch `rtxdi-minimal`; implementation on the
  same branch, PR at the end).

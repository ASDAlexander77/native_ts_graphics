# rtxmg_demo (cluster tessellation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A port of RTX Mega Geometry v2.2.0's `rtxmg_demo` (github.com/NVIDIA-RTX/RTXMG), stage 1: the cluster-tessellation path (Catmull-Clark subdivision surfaces, tessellated into clusters and rebuilt as CLAS/BLAS every frame), path traced with accumulation, matching the reference exe's `--shot-list` frames of `subdivision/amy_kitchenset.scene.json` on Vulkan.

**Architecture (RTXCR-style split, chosen 2026-11-07):**
- **Native glue `core/rtxmg.cpp`** (in `donut_interop_shared` when `RTXMG_DIR` is set) owns the RTXMG library objects: `RTXMGScene` (load, pose animation, refresh), `ClusterTessellator` + `ClusterTessAccels`, the HiZ `ZBuffer` and its prepass, and the TLAS (instance descs + `fill_instance_descs`). It hands the TypeScript side the TLAS, buffers and descriptor table it binds.
- **TypeScript `examples/rtxmg_demo.ts`** owns the app: args and scene settings, camera, the path tracer pipeline and shader table, its binding sets, accumulation, envmap importance-sampling tables, the blit (expose, ACES, sRGB), `-test`.
- **Library build:** our CMake adds `${RTXMG_DIR}/rtxmg` and `${RTXMG_DIR}/extern/osd_lite` as subdirectories against our Donut (same commit since PR #290), fetching what RTXMG's root CMake fetches (meshoptimizer v1.1, mimalloc v2.1.7, implot v0.17) and defining the variables its sub-CMake files read (`DONUT_DIR`, `RTXMG_SHADERS_*`, `RTXMG_SHADERMAKE_OPTIONS*`). `rtxmg/CMakeLists.txt` links `envmap` (a `demo/envmap` target): add `${RTXMG_DIR}/demo/envmap` as well.
- **Demo shaders** (`rtxmg_demo_path_tracer.hlsl` with `VERTEX_NORMALS=0 CLUSTER_LOD_SHADING=0`, `blit.hlsl`, `lerp_keyframes.hlsl`, `zrender.hlsl`) compile in place via our own `shaders/rtxmg_demo.cfg` with `--sourceDir ${RTXMG_DIR}/demo`, RTXMG's options (`--hlsl2021`, SM 6_6, SPIR-V `--vulkanMemoryLayout scalar -Vd`).

**Tech stack:** tslang, Donut 35d1cba / NVRHI 2e21b39 (header 28), RTXMG at `E:/Gits/RTXMG` (v2.2.0, assets submodule pulled), Vulkan `VK_NV_cluster_acceleration_structure`.

**Spec:** the conversation of 2026-11-07 (evaluation, NVRHI bump PR #290, reference build, "Start the port"), memory note `rtxmg-evaluation.md`.

## Global Constraints

- **License:** RTXMG (code, shaders, assets) is under the NVIDIA RTX SDKs License: nothing from `RTXMG_DIR` is copied into the repo. Headers and shaders are used in place; `core/rtxmg.cpp` carries the 2(b) notice ("This software contains source code provided by NVIDIA Corporation."). Ask before pushing the branch or opening a PR.
- **Build gating:** without `RTXMG_DIR`, nothing changes: no library, no example, no tests.
- **APIs:** stage 1 is Vulkan only. Our NVRHI has neither NVAPI nor `NVRHI_D3D12_WITH_DXRCLUSTER`, so D3D12 has no cluster operations: `-dx12` prints why and exits 77 (TEST_SKIPPED). D3D12 is a later decision (NVAPI under `RTXMG_DIR`, or native DXR clusters).
- **Stage 1 scope:** cluster tessellation only. The library still compiles cluster-LOD (its `scene` links it), but the app never initializes it (`scene->HasClusterLod()` false); bind dummies at t12-t15. No DLSS/denoiser, motion vectors, audio, korgi, maya logger, inspector, profiler UI, timeline. Animation paused at the scene's first frame (the reference's default), but `lerp_keyframes` still runs once: the kitchen set's pose buffers are filled only by it.
- **Matching the reference:** same settings as the reference's shot: scene JSON settings (spp 1, max bounces 3, firefly 1, exposure 1, envmap rotation 72), sun along the camera (irradiance 3, angular size 0.53, ambient 0.05), the default `TessellatorConfig` (tessMode SPHERICAL_PROJECTION, adaptive rate, HiZ visibility), N+1 accumulated subframes for a "pt N" shot, blit's separator line at the right edge included.
- **Reference:** `E:\Gits\RTXMG\bin\rtxmg_demo_ref.exe` (hidden window with `DONUT_HIDDEN_WINDOW=1`), shot list and frames in the session scratchpad (`rtxmg_shots/kitchen.json`: 1280x720, pt 256 + primary base). Recipe in memory note `rtxmg-evaluation.md`.
- **Working rules:** worktree off `origin/main` (`.claude/worktrees/rtxmg`), build dir `build-rtxmg/` there with `-DRTXMG_DIR=E:/Gits/RTXMG`; tests headless only; tslang bugs into `I:\TypeScriptCompiler\TSLANG_ISSUES.md`.

## Tasks

### Task 1: Build the RTXMG library from RTXMG_DIR
- [ ] `RTXMG_DIR` cache path; when set: fetch meshoptimizer, mimalloc (`MI_OVERRIDE OFF`), implot (RTXMG's `CMake/FetchImplot.cmake`), set the `RTXMG_*` shader variables (include dirs: `RTXMG_DIR`, `RTXMG_DIR/extern`, Donut include, `RTXMG_DIR/rtxmg/include`, NVRHI include; nvapi headers only if a shader needs them on SPIR-V), `add_subdirectory` osd_lite, `rtxmg`, `demo/envmap` with binary dirs under `build-rtxmg/rtxmg`.
- [ ] Compiler differences from RTXMG's own build: our `/MT` CRT, `/wd5333` for osd_lite's `/WX`, C++20; fix only through flags/target properties, never by editing RTXMG.
- [ ] Builds `rtxmg`, `cluster_tess_shaders`, `hiz_shaders`, `envmap_shaders` (SPIR-V + DXIL) into `bin/shaders/<lib>/`.

### Task 2: Demo shaders
- [ ] `shaders/rtxmg_demo.cfg` + `donut_compile_shaders` target `rtxmg_demo_shaders` (`--sourceDir ${RTXMG_DIR}/demo`), output `bin/shaders/rtxmg_demo/<api>`.
- [ ] Check `ENABLE_SHADER_DEBUG` agrees between C++ (glue) and shaders (u12).

### Task 3: Native glue, scene + accels
- [ ] `core/rtxmg.cpp`: `Rtxmg_Create(device, shaderFactory, commonPasses, descriptorTable, textureCache)` with the bindless layout (`MakeGlobalBindlessLayoutDesc`, capacity reserved before any descriptor), `Rtxmg_LoadScene(path)` (synchronous `LoadWithThreadPool`, `FinishedLoading`), scene settings accessors (camera view, envmap path/rotation, spp, bounces, exposure...), `Rtxmg_UpdateAccels(camera, cl)` (poses, `ResizeAccelStorage`, HiZ prepass, `BuildAccel` while `tessRateAdjusted`, `Refresh`, TLAS), getters for TLAS / instance / material / shading-data / cluster vertex buffers.
- [ ] Wrappers via `generate_donut_wrappers.py` conventions; donut.ts regenerated, never hand-edited.

### Task 4: TypeScript example, first frame
- [ ] `examples/rtxmg_demo.ts`: Args (`--scene`, `-width`, `-height`, `-frames`, `-test`, `-testOutput`), Vulkan device with ray tracing + cluster extension, bindless layout from the glue, path tracer pipeline (raygen, miss, shadow miss, subd hit group, null shadow hit group, LOD hit groups with dummies), `allowClusters`, accumulation, envmap CDFs (`compute_conditional`, prefix scan, `compute_marginal`), blit.
- [ ] `-dx12` exits 77 with the reason.

### Task 5: Match the reference, tests
- [ ] `-test -frames 256 -testOutput` at 1280x720 vs `kitchen-default.pt.png` (expect noise-level block means, like RTXCR's ~3/255) and a primary/base-color mode vs `kitchen-default.primary-base.png` (near exact).
- [ ] CTest entries (vk) under `RTXMG_DIR`; memory note and docs.

# Task 7 report: CTest, JIT, README

Status: DONE. Commit cf401f0 "rtxdi_minimal: tests and README" (base dc98f42). Not pushed.

## Tests added (CMakeLists.txt, inside `if (RTXDI_DIR)`, after the example; both APIs, -debug on, no NO_DEBUG)
- rtxdi_minimal: `-width 1280 -height 720 -frames 60`; SUFFIX unbiased (`-unbiased`); SUFFIX moving (`-moveCamera 0.01 0 0`); SUFFIX resize (`-frames 20 -resizeAt 10`). Comment says they are sanity checks, reference compare in notes.
- `ctest -R rtxdi_minimal -j1`: 8/8 passed (dx12/vk x default/unbiased/moving/resize, ~1.1 s each).

## JIT
`tslang.exe --shared-libs=build-rtxdi/bin/donut_interop_shared.dll examples/rtxdi_minimal.ts -- -dx12 -test -dumpFrame 60 -dumpPath .../task7/jit.bin -width 1280 -height 720` (from repo root, tslang at I:/tslang on PATH; 4.8 s, headless). vs AOT dump (build-rtxdi/bin/rtxdi_minimal.exe, same args): cmp_hdr max abs 0, mean 0, 0 % px; `cmp` byte-identical. Vulkan JIT (-vk) also runs, Test PASSED. Added run_jit_rtxdi.bat (like run_jit_rtxcr.bat).

## Full ctest
Build: `cmake --build build-rtxdi -- -k 0` exit 0 (1573 steps; asset dirs were already in the cache). `ctest -j1 --timeout 180`: 638/639 passed (1632 s). Failure: 162 powder_sandbox_nri.c4.vk (SEGFAULT after 43 s; passing tests of its family take ~3 s). Not caused by this branch: unrelated example (NRI powder sandbox); the branch diff vs main touches core/args.ts (+7), donut.ts, donut_interop.cpp/.d.ts, interop .d.ts (rtxdi additions) only; re-run alone 3/3 passed (3.0 s each) -> flaky GPU/driver crash. No main-checkout reproduction was needed.

## README
New section before streamline_demo: rtxdi_minimal port description (RTXDI 3.0.0, NVIDIA RTX SDKs License, nothing copied, RTXDI_DIR, presets default-rtxdi/release-rtxdi, RTXDI_DIR vs RTXPT_DIR exclusion, flags, bit-exact vs reference on both APIs, no validation messages, "This software contains source code provided by NVIDIA Corporation."), screenshot, credits list entry.
Screenshot docs/screenshots/rtxdi_minimal.jpg (1280x720, 178 KB, JPEG q85): from build-rtxdi dx12 default dump (frame 60), HDR clamped to [0,1] then sRGB-encoded, because the example's swapchain is Donut's default SRGBA8_UNORM (DeviceManager.h swapChainFormat; the example doesn't change it), i.e. the hardware encodes on the blit. Stated in the README caption. (Script: scratchpad/task7/mkjpg.py.)

## Files changed
CMakeLists.txt, README.md, docs/screenshots/rtxdi_minimal.jpg, run_jit_rtxdi.bat. Nothing else staged (pbrt_scene/rtxcr_scene/rtxmg/Donut etc. left alone).

## Concerns
- CMakeLists.txt LF/CRLF warning on commit is the repo's usual autocrlf notice; diff is 7 lines only.
- c4.vk powder sandbox segfault is a one-off flake (see above).

## Fix round 1
1. README screenshot caption/command now say what was done: Debug build `build-rtxdi`, `build-rtxdi/bin/rtxdi_minimal.exe -dx12 -test -width 1280 -height 720 -dumpFrame 60 -dumpPath ...`, one sentence on the clamp [0,1] + sRGB encode conversion. Script not committed.
2. `ctest --test-dir build-rtxdi -R powder_sandbox_nri.c4.vk --repeat until-fail:3 --output-on-failure` (vcvars): 3 repetitions, each Passed (3.05, 3.05, 3.03 s), "100% tests passed, 0 tests failed out of 1" (scratchpad/task7/repeat.log). On the main checkout's I:/native_ts_graphics/build (read-only, no rebuild): `ctest -R powder_sandbox_nri.c4.vk` Passed (3.11 s) (scratchpad/task7/main.log). The full-run segfault (43 s) did not reproduce in 4 runs; it is a flake, not shown caused by this branch (the example doesn't use any RTXDI code).
3. run_jit_rtxdi.bat comment: dropped input_pass.dll, and says -dx12 is hardcoded (edit for Vulkan); I did not claim last-flag-wins (unverified).
4. CMakeLists comment now: sanity checks; reference comparisons need a build of the original sample (its Minimal.exe from RTXDI_DIR).

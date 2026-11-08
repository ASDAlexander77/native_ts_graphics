# Streamline demo — design

Date: 2026-11-08. Status: reviewed (builder check done), awaiting user approval.

## Intent

Add a TypeScript (tslang) example that demonstrates NVIDIA Streamline (SL) in native_ts_graphics,
the way `rtxcr_*`, `rtxpt` and `rtxmg_demo` demonstrate the other RTX SDKs. Streamline is the
first RTX SDK picked from the remaining list (before RTXDI, RTXGI, RTXNS, RTXNTC, RTXTF). NIS is
explicitly not wanted.

The reference is NVIDIA's Streamline Sample 2.12.0 at `E:\Gits\Streamline_Sample` (Donut-based),
with the Streamline SDK 2.12.0 at `E:\Gits\Streamline`.

## Goals (decided by the user)

- **Scene:** the Streamline Sample's own scene (`sponza-plus.scene.json`; a copy already exists in
  this repo's `media/`). Fallback order if it proves unusable: the `rtxpt` scene, then the
  `feature_demo` scene.
- **Features:** DLSS Frame Generation (DLSS-G), Reflex, DLSS Super Resolution (DLSS-SR),
  DLSS Ray Reconstruction (DLSS-RR), DeepDVC, Latewarp. **Not** NIS.
- **APIs:** D3D12 and Vulkan. (D3D11, which the sample also supports, is not in scope.)

## Non-goals / anti-goals

- No NIS.
- No D3D11.
- Nothing from the Streamline Sample (RTX SDKs license) copied into the repo: port behaviour, write
  our own code (same model as RTXCR / RTXPT / RTXMG).
- No Streamline binaries, plugin DLLs or NGX DLLs committed. They're fetched at configure time into
  the build folder, like the DLSS / DLSS-NR SDKs today.
- No visible test windows on the user's desktop (tests stay headless; ask before anything that
  needs a visible/presented window).

## Constraints and facts

- Streamline SDK source/headers are MIT (`E:\Gits\Streamline\license.txt`); headers may be used
  directly. The sample app is under the NVIDIA RTX SDKs license.
- The local `E:\Gits\Streamline` is an unpackaged source checkout (no `bin/`); the sample's
  `streamline/` folder is empty and `_bin/` is empty, so **no reference build exists yet**. The
  public GitHub release of SL 2.12.0 ships prebuilt, signed plugin DLLs; fetching it is a download
  that must be confirmed with the user (name, source, size) before it happens.
- Binaries *(Claude's call)*: use the whole signed SL 2.12.0 release (`streamline-sdk-v2.12.0.zip`,
  ~232 MB, GitHub NVIDIA-RTX/Streamline) for both the reference build and ours, rather than mixing the
  source-built plugins already in `E:\Gits\Streamline_Sample\streamline\_artifacts` (they lack
  `sl.dlss_g.dll` and the `nvngx_*` model DLLs, and a source-built interposer with signed release
  plugins complicates signature checks).
- Latewarp is not in the public Streamline 2.12.0 SDK source or release notes (only
  `kFeatureLatewarp = 6` in `sl_core_types.h`); the sample's alternative path needs the NGX
  FrameWarp SDK, which isn't on disk.
- In the sample, DLSS-G and Latewarp are mutually exclusive: `sl.dlss_g.dll` overrides
  `sl.latewarp.dll`.
- Sample integration styles: D3D12 uses SL's "advanced hooking" (separate native/proxy device and
  swapchain, `sl.interposer.lib` linked instead of D3D libs, swapchain re-created when DLSS-G is
  toggled); Vulkan uses the "basic" mechanism (`sl.interposer.dll` loaded in place of
  `vulkan-1.dll`, SL hooks all calls). The sample replaces Donut's DeviceManager per API
  (`src/DeviceManagerOverride_DX12.cpp`, `_VK.cpp`).
- Existing repo patterns to follow: SDK fetched at configure behind a CMake option/preset
  (`DONUT_WITH_DLSS`, DLSS-NR fetch in `CMakeLists.txt`); native glue in `core/<sdk>.cpp` with a
  typed `.d.ts` in `core/interop/`; Donut patches in `patches/` applied in order; per-example
  `Args` subclass (`core/args.ts`); `-test` / `-testOutput` headless mode with `core/test_check.ts`;
  `donut.ts` is generated, never hand-edited.
- DLSS-RR on a raster scene: the sample feeds DLSS-RR the G-buffer guides (albedo, normals,
  roughness, etc.) from its raster renderer. We do the same.

## Decided shape

- **Latewarp (user, 2026-11-08):** when the SL 2.12.0 release zip is downloaded, check whether it
  contains `sl.latewarp.dll` (and its header). Keep Latewarp only if it does; otherwise drop it
  (no `-latewarp` switch, no NGX FrameWarp path).
- **Renderer (user, 2026-11-08):** full port of the sample's frame — deferred G-buffer, SSAO, sky,
  bloom, tone mapping with auto-exposure, TAA as the "DLSS off" path, the animated BrainStem robots
  on the same animation clock, and the sample's camera/jitter/lighting — so DLSS-SR, DLSS-RR and
  DeepDVC output (and the no-SL frame) are compared pixel-for-pixel against the reference build.
  Non-SL UI knobs the frame depends on come along.
- A new example (working name `streamline_demo.ts`), not an option bolted onto `rtxpt` or
  `feature_demo`.
- Each feature has a UI toggle and a command-line switch.
- **DLSS-G vs Latewarp:** chosen at startup by a switch (e.g. `-latewarp`); only the matching plugin
  is loaded. *(Claude's call; the user can override.)*
- Toggling DLSS-G / Latewarp at runtime may re-create the swapchain, as the sample does on D3D12.
- Reflex: sleep + latency markers around the frame loop; reported latency shown in the overlay;
  mode and FPS cap settable from the command line (sample: `-Reflex_mode`, `-Reflex_fpsCap`).
- DLSS-SR mode settable from the command line (sample: `-DLSS_mode` 0..5).

## Verification (Claude's call)

- Build and run the Streamline Sample (with the fetched SL 2.12.0 binaries) as the reference, at the
  same resolution, on D3D12 and Vulkan.
- `-test` headless mode: DLSS-SR, DLSS-RR and DeepDVC write normal render targets, so they get
  reference-dump comparisons against the sample. DLSS-G and Latewarp only act on a presented
  swapchain, so under `-test` they verify load/feature-supported state and log status (e.g. the
  generated-frame count SL reports) instead of pixels. Reflex verifies its markers are accepted and
  latency stats come back.
- Expect cross-run noise from DLSS-family features (DLSS-NR was non-deterministic run-to-run);
  comparisons use tolerances, not exact equality.

## Left to the builder

- Exact switch names, UI layout, the example's file name.
- Where the device-creation hook goes: a Donut patch vs. our own DeviceManager override in
  `core/`, per API.
- How SL resource tagging / constants are exposed to TypeScript (interop `.d.ts` shape).
- CMake option/preset name and fetch mechanism for SL binaries.
- Runtime fallback when a feature is unsupported on the GPU/driver (should disable the toggle and
  say why, not crash).

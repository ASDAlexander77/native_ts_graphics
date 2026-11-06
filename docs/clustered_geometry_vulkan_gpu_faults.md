# ClusteredGeometry on Vulkan: GPU faults (parked)

`examples/clustered_geometry.ts` (the port of DirectX-Graphics-Samples' D3D12RaytracingClusteredGeometry) runs on
D3D12 only. A Vulkan path was written on top of `VK_NV_cluster_acceleration_structure`, but its test runs faulted
the GPU twice, badly enough that the second time only a reboot brought the machine back. The work is parked: it is
not on `main`, and nothing in this repository runs it.

This document records what happened, what is known about the cause, and how to resume safely.

## Status

| | |
|---|---|
| Code | local branch `clustered-geometry-vulkan`, commit `e1a5913` (based on #277; not pushed) |
| Machine | NVIDIA GeForce RTX 5080, driver 621.14, Windows 11, Vulkan SDK 1.4.321.1 |
| Works | `clustered_geometry -vk -test` (clusters) and `-geometryMode traditional`: pass with the validation layer clean |
| Faults | the mode-switch run, `-vk -test -at 1:geom-traditional -at 2:geom-clusters -at 2:extra-1k -at 3:alloc-getsizes` |

## What the Vulkan path does

- `core/clas.cpp` calls `vkGetClusterAccelerationStructureBuildSizesNV` and `vkCmdBuildClusterAccelerationStructureIndirectNV`
  through `vkGetDeviceProcAddr`, as `core/ptlas.cpp` does for partitioned TLASes. It translates the D3D12 operation
  description (types, modes, flags, limits) into `VkClusterAccelerationStructureInputInfoNV`.
  - Allow data access `0x100` becomes `VK_BUILD_ACCELERATION_STRUCTURE_ALLOW_DATA_ACCESS_BIT_KHR`.
  - Move no-overlap becomes `noMoveOverlap`.
  - FLOAT32_3 becomes `VK_FORMAT_R32G32B32_SFLOAT`.
  - Each build is wrapped in global memory barriers on both sides.
- The argument-filling compute shaders write Vulkan's argument layouts when compiled to SPIR-V (`#if defined(__spirv__)`).
  - `VkClusterAccelerationStructureBuildTriangleClusterInfoNV` is 64 bytes against D3D12's 80, with its counts
    bit-packed and the index buffer address first.
  - The template arguments are 72 bytes against 96.
  - The instantiation arguments have the cluster ID offset first.
  - BLAS-from-CLAS and move arguments are the same on both APIs.
  - COMPRESSED1 vertices don't exist on Vulkan, so `-vertexFormat compressed` falls back to FLOAT32_3.
- `ClusterID()` and `TriangleObjectPositions()` are inline SPIR-V built-ins (`ClusterIDNV`, `HitTriangleVertexPositionsKHR`),
  compiled by the Vulkan SDK's DXC (`shaders/clustered_geometry_spirv.cfg`).
- The device enables `VK_NV_cluster_acceleration_structure` (and position fetch on headless devices); Donut chains
  the feature.

## Incident 1: garbage device addresses

The first Vulkan test run (2026-11-06, about 13:47) wedged the GPU.

- **Cause, found afterwards:** the argument-filling compute shaders read their settings from `cbuffer` blocks.
  - On D3D12 those were the root constants the TS side pushes.
  - On Vulkan they were bound as nothing: `[[vk::push_constant]]` only applies to a `ConstantBuffer<Struct>`, not a `cbuffer`.
  - The validation layer said so: *"uses descriptor [Set 0, Binding 256, variable "Constants"] ... but was not
    declared in the pipeline layout"*.
  - The shaders therefore wrote cluster-operation arguments with garbage vertex, index and CLAS addresses.
  - The cluster builds then wrote through those addresses.
- **Symptoms:**
  - Windows' System event log, source `nvlddmkm`: event 13 *"Graphics SM Warp Exception ... MMU Fault"* and
    *"Graphics Exception: ESR 0x...=0x8010017"*, then an endless stream of event 153.
  - After that, every program failed: Vulkan programs crashed in `vkCreateDevice` (exit `0xC0000409`, fail-fast
    inside `nvoglv64.dll`), D3D12 programs reported `Device Removed`.
  - Every test result from that point on was meaningless.
- **Fix in the code:** the compute shaders' constants became `ConstantBuffer<...>` with `[[vk::push_constant]]`
  under `SPIRV`. After a graphics driver reset (Win+Ctrl+Shift+B), the plain and traditional runs passed with
  validation clean and no new `nvlddmkm` events.

## Incident 2: the mode-switch run

After the driver reset, the third run was the mode-switch test (about 14:23).

- It crashed (exit `0xC0000409`) and the GPU faulted again: event 153, then event 13 *"Graphics SM Global Exception
  ... Multiple Warp Errors"* and *"SM Warp Exception ... MMU Fault"* on several GPCs.
- This time a driver reset did **not** recover the GPU; the machine needed a reboot.
- The validation layer reported nothing before the crash, as it doesn't check the contents of cluster-operation
  arguments.

What the run does that the passing runs don't is rebuild everything partway through.
- `-at` actions call `requestRebuild`.
- The rebuild waits for the GPU, destroys the `Clas` object with all its buffers and TLAS, creates a new one, and
  rebuilds with new settings.
- The settings change from clusters to the traditional path, back to clusters with 1000 clones, then to the
  "get sizes first, then build into explicit destinations" allocation.

**Every `-at` variant run after the first fault is invalid evidence**: the GPU was already wedged. So it is not known
which of the actions (or which build in the rebuild) faults, or whether a single rebuild with no setting change does.

### Ruled out

- **Buffers freed while in use:** NVRHI's `setBufferState` keeps every buffer a native cluster build touches alive
  until its command list retires, on Vulkan as on D3D12. The rebuild also calls `waitForIdle` first.
- **Binding sets:** each compute dispatch's binding set holds its buffers.
- **D3D12:** the identical TypeScript code passes the same mode-switch test there (with its own argument layouts).

### Suspects (unverified)

1. **Alignment of explicit destinations.** The "get sizes" mode and the cluster BLAS pool place results at addresses
   computed on the CPU with D3D12's alignments (CLAS 128 bytes). Vulkan reports its own in
   `VkPhysicalDeviceClusterAccelerationStructurePropertiesNV` (`clusterByteAlignment`,
   `clusterBottomLevelByteAlignment`, `clusterTemplateByteAlignment`, `clusterScratchByteAlignment`). The port never
   queried them.
2. **Sizes from compute-sizes mode.** D3D12 writes 64-bit sizes; Vulkan's `dstSizesArray` elements are 32-bit
   values at the given stride. The TS side reads the low word only, which should be safe, but the upper words of
   the size buffer are never written on Vulkan.
3. **Move operations (compaction).** `maxMovedBytes`, the destination layout after a move, and whether Vulkan
   allows overlapping moves the way the D3D12 path assumes.
4. **Scratch sizes for the larger clone count.** 1000 clones grow every limit; the scratch buffers are sized from
   `vkGetClusterAccelerationStructureBuildSizesNV` with the D3D12 limits translated, with no Vulkan-specific
   scratch alignment applied.
5. **Instantiation and template inputs** after a rebuild (template addresses from the new `Clas`'s storage).

## Resuming safely

Each fault here cost a driver reset, and the second one a reboot, so:

- **Ask the user before every run of this path**, and run nothing else on the GPU at the same time.
- **Run with `-debug`** (validation) and fix every warning before looking at results. Incident 1 was announced by a
  warning.
- **Check the driver's event log after every run.** Stop at the first new entry, because everything after it is
  invalid:
  ```powershell
  Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='nvlddmkm'; StartTime=(Get-Date).AddMinutes(-5)}
  ```
  If entries appear, run `basic_triangle -test` on D3D12 and Vulkan. If either fails, the GPU is wedged: reset the
  driver (Win+Ctrl+Shift+B), and reboot if that doesn't help.
- **Bisect one action at a time**, one run per GPU state, starting from the least risky:
  1. A rebuild with no setting change (an action that only calls `requestRebuild`).
  2. `geom-traditional` alone.
  3. Each of `extra-1k`, `alloc-getsizes` and the compaction (default) allocation alone.
- **Before running, check the suspects in code**: query the Vulkan cluster properties (Donut's `DeviceManager_VK`
  already fills `VkPhysicalDeviceClusterAccelerationStructurePropertiesNV`) and align explicit destinations and
  scratch to them; zero the size buffers.
- **Get more information from a fault:** `VK_EXT_device_fault` (`vkGetDeviceFaultInfoEXT` after
  `VK_ERROR_DEVICE_LOST`) or NVIDIA Nsight Aftermath can report the faulting address and which command was running.
  The validation layer's GPU-assisted validation doesn't cover cluster operations.

# Migrating the examples to NRI and NRIFramework

Each migration adds `examples/nri/<name>_nri.ts` (registered with `add_tslang_nri_example`
and `add_tslang_example_test`) alongside the Donut example, using the same compiled shaders. The
Donut version stays. The order comes from what `core/nri/nri_interop` must gain for each example:
an example comes earlier when it needs few new `Nri_*` functions, and each tier adds one reusable
group of them.

Ranking: every example was scored by the Donut/NVRHI features it uses (scene loading, ImGui,
textures from files, ray tracing, mesh shaders, compute, binding sets, vertex/index/constant
buffers, cameras, render targets, multiple queues, native C++ helpers), and then checked against
NRI's headers. Examples using something NRI lacks are excluded.

## Done

| Example | Interop added |
|---|---|
| basic_triangle_nri (#174) | device, swap chain, frames, empty pipeline layout, VS+PS pipeline, draw, test readback |
| mesh_shading_nri (#177) | `Nri_IsFeatureSupported` (`NriFeature.MeshShader`), `Nri_CreateMeshPipeline`, `Nri_CmdDrawMeshTasks` |
| meshlets_nri (#178) | `Nri_CreateTaskMeshPipeline` (task shader), `Nri_GetSrgbFormat` (sRGB color attachment views of the UNORM swap chain, as Donut's sRGB back buffers: pixels match the Donut examples) |
| depth_bounds_test_nri (#180) | pipeline descs (`Nri_CreatePipelineDesc`, shaders, vertex attributes, color write mask, depth test and bounds), `Nri_CreateUploadedBuffer` (vertex buffer), `Nri_CreateDepthTexture` (moved to its layout once, at creation), `Nri_CmdBeginRenderingWithDepth`, `Nri_CmdClearDepth`, `Nri_CmdSetVertexBuffer`, `Nri_CmdSetDepthBounds`, `NriFeature.DepthBoundsTest`, the `NriFormat` / `NriCompareOp` enums |
| small_resources_nri (#181) | pipeline layout descs (descriptor set ranges), descriptor pools and sets, samplers, texture views, committed and placed textures (`Nri_GetPlacedTextureSize`, `Nri_AllocateTextureMemory`), `Nri_UploadTexture`, triangle strips, vertex buffer offsets, `Nri_IsKeyToggled`, `Nri_SetWindowTitle`, `Nri_GetDeviceMemoryUsage`, the example's own options (`Nri_AddExampleOption`, `Nri_GetArg`), extra module sources in `add_tslang_nri_example`; Vulkan binding offsets set to Donut's register shifts |
| descriptor_indexing_nri (#182) | root constants and root (immutable) samplers, descriptor range flags (bindless variable-sized arrays updated after binding), set register spaces, update-after-set pools, variable-sized set allocation, index buffers and indexed draws, `Nri_StoreInt32`, `Nri_GetFrameTime`, `std::default_random_engine` numbers (`Nri_CreateRandomEngine`) |
| dynamic_uniform_buffers_nri (#183) | host-visible constant buffers (`Nri_CreateHostBuffer`, `Nri_WriteBuffer`), constant buffer views, root descriptors bound per draw with an offset (the sample's dynamic uniform buffer offsets), mouse input (`Nri_IsButtonPressed`, `Nri_GetMouseDeltaX/Y`, `Nri_GetMouseWheel`), normal-distributed random numbers |
| bundles_nri (#184) | the scene only (NRI has no bundles: the draws are recorded every frame); files (`Nri_LoadFile`, buffers and textures uploaded from file regions), BC1 textures, `Nri_IsKeyPressed` (SimpleCamera, with Donut's Key values: declarations only) |
| dynamic_indexing_nri (#185) | nothing new: root constants (the draw's matrix and material index) and a descriptor set with a 120-texture array, from the interop the earlier examples added |
| vertex_buffer_nri (#186) | image textures (`Nri_LoadImageTexture`: stb_image through NRIFramework, sRGB as Donut's), vertex attributes from more than one stream (`Nri_PipelineDescAddVertexAttributeFromStream`), cull modes, anisotropic samplers |
| async_compute_nri (#187) | compute queue, compute pipelines, storage textures and views, `Nri_QueueWait`, a C++ worker thread's async compute loop (`Nri_CreateAsyncComputeLoop`, as Donut's); layouts' stages from what they bind |
| timeline_semaphore_nri (#188) | `Nri_CmdDispatch` and the compute bind point's layout, sets and root constants on the render thread; `Nri_QueueSubmitWithFences` (a submission waiting for one fence's value and signaling another's: NRI's fences are timeline semaphores); textures read by compute and pixel shaders (`NriTextureState.AllShaderResource`) |
| compute_nbody_nri (#189) | storage buffers (`Nri_CreateStorageBuffer`, structured views) bound as root descriptors, buffer barriers and copies, additive blending; shaders from ShaderMake permutation blobs (a .cfg line with -D); Donut's ThirdPersonCamera view matrix in float32 |
| execute_indirect_nri (#190) | indexed indirect draws with a count buffer (`Nri_CmdDrawIndexedIndirect`, `NriFeature.DrawIndirectCount`), raw (byte address) buffers as stride-4 structured views, `Nri_CmdZeroBuffer`, host-written structured buffers, per-instance vertex streams |
| buffer_device_address_nri | buffers' device addresses (`Nri_GetBufferDeviceAddress`: vkGetBufferDeviceAddress through NRI's Vulkan wrapper, as NRI has no call for it) in push constants, primitive restart; Vulkan only |

## Tier 1: constant buffers and more descriptor types

Descriptor sets, samplers, textures (from image files too), root constants, bindless arrays and
constant buffers are in (vertex_buffer_nri). Still to add: structured buffers, offscreen color
targets and a blit or copy to the swap chain; tier 1's examples are done.

## Tier 2: compute and queues

Compute pipelines, storage textures, the compute queue and cross-queue waits are in
(async_compute_nri), dispatches from the render thread and fenced submissions
(timeline_semaphore_nri), storage buffers (compute_nbody_nri), indirect draws
(execute_indirect_nri), device addresses (buffer_device_address_nri). Done; none of these
examples needed a copy queue.

## Tier 3: ImGui (NRIImgui.h)

NRIFramework draws ImGui through `CmdCopyImguiData` / `CmdDrawImgui`. After this tier, the
examples whose only blocker was ImGui become portable: shader_quad_control, color_write_enable
(static `colorWriteMask` only, because NRI has no dynamic color write enable),
compute_shader_derivatives, 16bit_arithmetic, simple_compute, texture_loading,
separate_image_sampler, dynamic_line_rasterization, and others.

## Tier 4: scenes (NRIFramework utils::Scene, cgltf)

This tier covers deferred_shading, threaded_rendering, environment_map, bindless_rendering, and
the Vulkan-Samples ports that load glTF. NRIFramework's scene loader is not Donut's, so the
material and vertex layouts need checking for each example.

## Tier 5: ray tracing (NRIRayTracing.h)

The order is rt_triangle, dxr_refit, rt_shadows, rt_reflections, raytracing_simple_lighting, and
ray_queries. After that come the scene-heavy ray-traced examples.

## Notes

- D3D12 runs with legacy resource barriers here (nri_interop has no Agility SDK): depth access is
  the write bit alone, and textures are moved to their layout once at creation instead of from
  Undefined each frame.
- The examples reuse Donut's SPIR-V, compiled with register shifts t 0, s 128, b 256, u 384:
  `Nri_CreateDevice` sets NRI's `vkBindingOffsets` to those (NRIFramework's defaults differ).
- NRI's D3D12 descriptor pool gives every set its ranges' whole descriptorNum, ignoring the
  variable-sized array's length, and doesn't check the heap's bounds: size pools for whole arrays.
- A worker thread's GPU work (async compute) is C++ in nri_interop, as Donut's: tslang code can't
  run on threads its GC doesn't know about.
- NRI's D3D11 backend unbinds a UAV slot when a set binds, as an SRV, a texture an earlier set in
  the same command buffer bound to that slot as a UAV, without checking what's bound there now: a
  dispatch whose set swaps two textures' roles gets no UAV. Record such dispatches in separate
  command buffers (each resets the tracking when it ends), as timeline_semaphore_nri's setup does.
- NRI's D3D11 buffer views take neither `WHOLE_SIZE` nor the buffer's structure stride (both
  documented as defaults): nri_interop passes the buffer's size and stride.
- Shaders a .cfg compiles with -D are ShaderMake permutation blobs ("NVSP"); nri_interop's shader
  loader unpacks a blob holding one permutation.
- An animation that the original sample steps in OnUpdate counts the frame before it's drawn
  (frame number = frameIndex + 1), as Donut's test mode does.

## Excluded

These need something NRI does not provide:

- **generic_programs**: D3D12 generic programs / AddToStateObject.
- **shader_specializations**: NRI has no specialization constants.
- **predication_queries**, **conditional_rendering**: NRI has no predication.
- **reserved_resources**, **sparse_image**: NRI has no sparse/tiled resources.
- **work_graphs**, **host_image_copy**, **shader_object**, **graphics_pipeline_library**,
  **descriptor_buffer_basic**, **memory_budget**: NRI does not expose these API features.
- **nvrhi_direct**, **headless**: these examples are about NVRHI itself.
- **rtxcr_***, **rtxpt**, **feature_demo**, **opacity_micromaps**, **fast_block_compress**,
  **video_texture**, **denoised_rtao**: they are built on C++ SDK integrations through
  Donut/NVRHI.

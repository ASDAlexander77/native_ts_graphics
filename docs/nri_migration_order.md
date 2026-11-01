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
| vertex_buffer_nri | image textures (`Nri_LoadImageTexture`: stb_image through NRIFramework, sRGB as Donut's), vertex attributes from more than one stream (`Nri_PipelineDescAddVertexAttributeFromStream`), cull modes, anisotropic samplers |

## Tier 1: constant buffers and more descriptor types

Descriptor sets, samplers, textures (from image files too), root constants, bindless arrays and
constant buffers are in (vertex_buffer_nri). Still to add: structured buffers, offscreen color
targets and a blit or copy to the swap chain; tier 1's examples are done.

## Tier 2: compute and queues

Adds compute pipelines, `CmdDispatch`, storage buffers and textures, compute/copy queues and
timeline fences.

1. **async_compute**
2. **timeline_semaphore**
3. **compute_nbody**
4. **execute_indirect**: `CmdDrawIndirect` / `CmdDrawIndexedIndirect`.
5. **buffer_device_address**: needs the buffer's `deviceAddress` passed to the shader.

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

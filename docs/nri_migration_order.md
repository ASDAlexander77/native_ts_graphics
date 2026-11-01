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
| depth_bounds_test_nri | pipeline descs (`Nri_CreatePipelineDesc`, shaders, vertex attributes, color write mask, depth test and bounds), `Nri_CreateUploadedBuffer` (vertex buffer), `Nri_CreateDepthTexture` (moved to its layout once, at creation), `Nri_CmdBeginRenderingWithDepth`, `Nri_CmdClearDepth`, `Nri_CmdSetVertexBuffer`, `Nri_CmdSetDepthBounds`, `NriFeature.DepthBoundsTest`, the `NriFormat` / `NriCompareOp` enums |

## Tier 1: vertex buffers, offscreen targets, fixed-function state

Buffer upload, vertex input, depth targets and pipeline descs are in (depth_bounds_test_nri).
Still to add: offscreen color targets and a blit or copy to the swap chain.

1. **small_resources**: adds a first binding set (descriptor pool and sets).

## Tier 2: descriptor sets and constant buffers

Adds pipeline layouts with descriptor sets and root constants (push constants), constant
buffers, structured buffers and samplers.

2. **descriptor_indexing**: descriptor ranges with partially bound / variable-size arrays.
3. **dynamic_uniform_buffers**: constant buffer slices, with a camera matrix computed in TypeScript.
4. **bundles**: draws the same scene without D3D12 bundles, since NRI has none. Port only the scene, or skip it.
5. **dynamic_indexing**
6. **vertex_buffer**: adds the first texture loaded from a file (NRIFramework `utils::LoadTexture`).

## Tier 3: compute and queues

Adds compute pipelines, `CmdDispatch`, storage buffers and textures, compute/copy queues and
timeline fences.

7. **async_compute**
8. **timeline_semaphore**
9. **compute_nbody**
10. **execute_indirect**: `CmdDrawIndirect` / `CmdDrawIndexedIndirect`.
11. **buffer_device_address**: needs the buffer's `deviceAddress` passed to the shader.

## Tier 4: ImGui (NRIImgui.h)

NRIFramework draws ImGui through `CmdCopyImguiData` / `CmdDrawImgui`. After this tier, the
examples whose only blocker was ImGui become portable: shader_quad_control, color_write_enable
(static `colorWriteMask` only, because NRI has no dynamic color write enable),
compute_shader_derivatives, 16bit_arithmetic, simple_compute, texture_loading,
separate_image_sampler, dynamic_line_rasterization, and others.

## Tier 5: scenes (NRIFramework utils::Scene, cgltf)

This tier covers deferred_shading, threaded_rendering, environment_map, bindless_rendering, and
the Vulkan-Samples ports that load glTF. NRIFramework's scene loader is not Donut's, so the
material and vertex layouts need checking for each example.

## Tier 6: ray tracing (NRIRayTracing.h)

The order is rt_triangle, dxr_refit, rt_shadows, rt_reflections, raytracing_simple_lighting, and
ray_queries. After that come the scene-heavy ray-traced examples.

## Notes

- D3D12 runs with legacy resource barriers here (nri_interop has no Agility SDK): depth access is
  the write bit alone, and textures are moved to their layout once at creation instead of from
  Undefined each frame.
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

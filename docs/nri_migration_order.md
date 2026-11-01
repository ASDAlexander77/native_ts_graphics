# Migrating the examples to NRI and NRIFramework

Each migration adds a sibling `examples/<name>_nri.ts` (registered with `add_tslang_nri_example`
and `add_tslang_example_test`) next to the Donut example, using the same compiled shaders. The
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
| mesh_shading_nri | `Nri_IsFeatureSupported` (`NriFeature.MeshShader`), `Nri_CreateMeshPipeline`, `Nri_CmdDrawMeshTasks` |

## Tier 1: mesh shaders, nothing bound

1. **meshlets**: adds a task (amplification) shader to the mesh pipeline.

## Tier 2: vertex buffers, offscreen targets, fixed-function state

Adds buffer upload (`HelperInterface::UploadData`, memory via `AllocateAndBindMemory`), vertex
input layouts, depth and color render targets, and a blit or copy to the swap chain.

2. **depth_bounds_test**: vertex buffer, D32 depth target, depth bounds (`features.depthBoundsTest`, `CmdSetDepthBounds`).
3. **small_resources**: adds a first binding set (descriptor pool and sets).

## Tier 3: descriptor sets and constant buffers

Adds pipeline layouts with descriptor sets and root constants (push constants), constant
buffers, structured buffers and samplers.

4. **descriptor_indexing**: descriptor ranges with partially bound / variable-size arrays.
5. **dynamic_uniform_buffers**: constant buffer slices, with a camera matrix computed in TypeScript.
6. **bundles**: draws the same scene without D3D12 bundles, since NRI has none. Port only the scene, or skip it.
7. **dynamic_indexing**
8. **vertex_buffer**: adds the first texture loaded from a file (NRIFramework `utils::LoadTexture`).

## Tier 4: compute and queues

Adds compute pipelines, `CmdDispatch`, storage buffers and textures, compute/copy queues and
timeline fences.

9. **async_compute**
10. **timeline_semaphore**
11. **compute_nbody**
12. **execute_indirect**: `CmdDrawIndirect` / `CmdDrawIndexedIndirect`.
13. **buffer_device_address**: needs the buffer's `deviceAddress` passed to the shader.

## Tier 5: ImGui (NRIImgui.h)

NRIFramework draws ImGui through `CmdCopyImguiData` / `CmdDrawImgui`. After this tier, the
examples whose only blocker was ImGui become portable: shader_quad_control, color_write_enable
(static `colorWriteMask` only, because NRI has no dynamic color write enable),
compute_shader_derivatives, 16bit_arithmetic, simple_compute, texture_loading,
separate_image_sampler, dynamic_line_rasterization, and others.

## Tier 6: scenes (NRIFramework utils::Scene, cgltf)

This tier covers deferred_shading, threaded_rendering, environment_map, bindless_rendering, and
the Vulkan-Samples ports that load glTF. NRIFramework's scene loader is not Donut's, so the
material and vertex layouts need checking for each example.

## Tier 7: ray tracing (NRIRayTracing.h)

The order is rt_triangle, dxr_refit, rt_shadows, rt_reflections, raytracing_simple_lighting, and
ray_queries. After that come the scene-heavy ray-traced examples.

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

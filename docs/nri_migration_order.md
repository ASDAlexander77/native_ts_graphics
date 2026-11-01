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
| buffer_device_address_nri (#191) | buffers' device addresses (`Nri_GetBufferDeviceAddress`: vkGetBufferDeviceAddress through NRI's Vulkan wrapper, as NRI has no call for it) in push constants, primitive restart; Vulkan only |
| texture_loading_nri (#192) | NRIFramework's ImGui (`Nri_UseImgui`, `Nri_InitImgui`, the frame calls and widgets), textures with all their mips (`Nri_LoadTexture`, detex), the device's widest anisotropy; `-testOutput` for every NRI example |
| separate_image_sampler_nri (#192) | samplers with their own mip filter, the sampler in a set of its own (space 1: the shader and the Donut example changed with it) |
| compute_shader_derivatives_nri (#192) | `NriFeature.ComputeShaderDerivatives` |
| shader_quad_control_nri (#193) | a permutation picked from a ShaderMake blob of several (`Nri_PipelineDescAddShaderPermutation`), `NriFeature.ShaderQuadControl` (NRI patched to enable VK_KHR_shader_quad_control, queried with vkGetPhysicalDeviceFeatures2 through NRI's Vulkan wrapper) |
| color_write_enable_nri (#193) | render target textures (`Nri_CreateRenderTargetTexture`), three color attachments (`Nri_CmdBeginRenderingWithThreeColors`, `Nri_PipelineDescAddColor`) cleared one by one (`Nri_CmdClearColorAttachment`), `Nri_ImguiColorPicker3`, options with values (`Nri_AddExampleOptionWithValues`); a pipeline per write-mask combination (NRI has no dynamic color write enable) |
| 16bit_arithmetic_nri (#193) | `NriFeature.Native16Bit` and `Native16BitConstants`, compute permutations (`Nri_CreateComputePipelinePermutation`), structured buffers in descriptor sets (`Nri_CreateDescriptorPoolWithBuffers`), RGBA16F storage textures; no GPU time (no timer queries) |
| mesh_shader_culling_nri (#193) | nothing new: a task shader's constant buffer as a root descriptor; no pipeline statistics (no queries) |
| n_body_gravity_nri (#193) | geometry shaders, point lists, blend factors (`Nri_PipelineDescSetBlend`), buffers read by vertex and compute shaders (`NriBufferState.VertexAndComputeShaderResource`); the steps on the graphics queue (the Donut example's path without a compute queue) |
| meshlet_render_nri (#194) | uploaded structured buffers (`Nri_CreateUploadedStructuredBuffer`, from ints, files and native pointers), a loaded file's bytes (`Nri_GetFileData`, `Nri_GetFileSize`) for core/meshlet_model.cpp's loader |
| meshlet_instancing_nri (#194) | nothing new: host-written instances (rewritten after the device is idle when they change) |
| dynamic_lod_nri (#194) | nothing new: buffer arrays in a descriptor set, a constant buffer array |
| meshlet_cull_nri (#194) | the cursor's position (`Nri_GetMouseX/Y`), line lists from mesh shaders |
| simple_compute_nri (#194) | the async compute loop's own root constants, pause and run count (`Nri_SetAsyncComputeConstants`, `Nri_SetAsyncComputePaused`, `Nri_GetAsyncComputeRunCount`), textures the compute queue reads (`Nri_CreateUploadedComputeTexture`), ImGui text drawn anywhere (`Nri_ImguiDrawText`, `Nri_ImguiDrawRect`); the fractal drawn with 16bit_arithmetic's visualization shaders; on D3D11 with the HUD, no async compute (the HUD's command buffer emulation breaks the compute queue) |
| collision_nri (#194) | line lists, CPU-written vertex buffers (`Nri_CreateHostBuffer` with `NriBufferUsage.VertexBuffer`), a captured cursor (`Nri_SetCursorDisabled`) |
| simple_bezier_nri (#194) | hull and domain shaders, patch lists (`Nri_PipelineDescSetPatchControlPoints`), wireframe (`Nri_PipelineDescSetWireframe`); NRI patched for D3D12's patch-list topology |
| terrain_tessellation_nri (#194) | DDS texture arrays with their mips (`Nri_LoadDdsTexture`, `Nri_CreateTextureArrayView`), Donut's own blit shaders into the sRGB swap chain, Donut's FirstPersonCamera in float32 |
| dynamic_blending_nri (#194) | all blend factors and ops, blend constants (`Nri_CmdSetBlendConstants`), more ImGui widgets (`Nri_ImguiColorEdit4`, `Nri_ImguiButton`, `Nri_ImguiRadioButton`, `Nri_ImguiPushID`, `Nri_ImguiSameLine`); no advanced blend operations (NRI has none) |
| atom_orbitals_nri (#194) | front-face winding (`Nri_PipelineDescSetFrontCounterClockwise`), three root descriptors in one layout, `Nri_ImguiSetNextWindowPosPivot`, `Nri_ImguiDragFloat` |
| dynamic_rendering_nri (#195) | glTF meshes as Donut loads them (`Nri_LoadGltfMesh`: core/vulkan_samples_gltf.h, shared with Donut's interop), DDS cubemaps and cube views (`Nri_CreateTextureCubeView`) |
| vertex_dynamic_state_nri (#195) | nothing new: a pipeline per vertex layout (NRI has no dynamic vertex input) |
| dynamic_primitive_clipping_nri (#195) | depth clipping on or off (`Nri_PipelineDescSetDepthClip`, which sets NRI's depthClamp for the API) |
| fragment_shader_barycentric_nri (#195) | `NriFeature.Barycentrics`; no D3D11 (shader model 6.1) |
| push_descriptors_nri (#195) | root descriptors as Vulkan push descriptors (`Nri_GetRootDescriptorMaxNum`); its own shaders (shaders/push_descriptors_nri.hlsl): NRI has no combined image samplers, so the texture and sampler are in a descriptor set; Vulkan only |
| patch_control_points_nri (#196) | nothing new: tessellation with root constants |
| instancing_nri (#196) | 32-bit signed integer vertex attributes (`NriFormat.R32_SINT`), Donut's ThirdPersonCamera in float32 |
| logic_op_dynamic_state_nri (#196) | logic operations (`Nri_PipelineDescSetLogicOp`, `NriFeature.LogicOp`; a pipeline per operation, NRI having no dynamic one), RGBA8_UINT views of a UNORM texture on D3D; NRI patched for logic operations on D3D11 and D3D12 |
| oit_linked_lists_nri (#196) | storage buffers and textures in pixel shaders (`NriBufferState.PixelStorage`, `NriTextureState.PixelStorage`), storage textures with data (`Nri_CreateStorageTextureWithData`), buffers without data (`Nri_CreateUninitializedStorageBuffer`: NRI patched for uploads without data); no D3D11 (see the notes) |
| oit_depth_peeling_nri (#196) | depth textures shaders read (`Nri_CreateSampledDepthTexture`), moved between depth attachment and shader resource each pass |
| hdr_nri (#197) | two color attachments with depth (`Nri_CmdBeginRenderingWithTwoColorsAndDepth`), RGBA32F render targets, `Nri_ImguiInputFloat` |
| timestamp_queries_nri (#197) | timestamp queries (`Nri_CreateTimestampQueryPool`, `Nri_CmdResetQueries`, `Nri_CmdWriteTimestamp`, `Nri_CmdCopyQueries`, `Nri_ReadTimestampIntervalMs`) |
| fragment_shading_rate_nri (#197) | variable rate shading (`NriFeature.VariableRateShading`, `Nri_PipelineDescSetShadingRate`, `Nri_CmdSetShadingRate`, `Nri_CmdBeginRenderingWithShadingRate`), shading rate attachments (`Nri_CreateShadingRateTexture`, `NriTextureState.ShadingRateAttachment`), the device's rates (`Nri_GetFragmentShadingRates`, `Nri_GetShadingRateTileSize`); no D3D11 (shader model 6.4) |
| fragment_shading_rate_dynamic_nri (#197) | shading rates a compute shader writes (storage and shading rate attachment in one texture), render targets compute shaders read (`Nri_CreateRenderTargetStorageTexture`), rect clears (`Nri_CmdClearColorAttachmentRect`, `Nri_CmdClearDepthRect`); no D3D11 |
| mobile_nerf_nri (#197) | a file's bytes for parsers in TypeScript (`Nri_CopyFileBytes`): core/mobile_nerf_common.ts no longer depends on Donut and is shared with the Donut ports |
| gshader_to_mshader_nri | glTF models as Donut loads them (`Nri_LoadGltfModel` and its accessors: core/vulkan_samples_gltf.h's GltfModel, shared with Donut's interop) |
| multi_draw_indirect_nri | `Nri_ReadBufferInts`, `Nri_GetDrawIndirectMaxNum`, a 225-texture array (`NriRangeFlags.Array`), Donut's FirstPersonCamera as a shared module (core/donut_first_person_camera.ts, terrain_tessellation_nri's too); no D3D11 |
| dynamic_rendering_local_read_nri | three color attachments with depth (`Nri_CmdBeginRenderingWithThreeColorsAndDepth`) |
| extended_dynamic_state2_nri | depth bias (`Nri_PipelineDescSetDepthBias`); rasterizer discard by skipping the draw, as Donut does |
| dynamic_multisample_rasterization_nri | multisampled targets (`Nri_PipelineDescSetSampleCount`, `Nri_CreateMultisampledRenderTarget`, `Nri_CreateMultisampledDepthTexture`, `Nri_GetSupportedSampleCounts`), resolved by a shader (shaders/nri_msaa_resolve.hlsl) |

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

NRIFramework's ImGui is in, ported in batches: texture_loading_nri, separate_image_sampler_nri and
compute_shader_derivatives_nri; then shader_quad_control_nri, color_write_enable_nri,
16bit_arithmetic_nri, mesh_shader_culling_nri and n_body_gravity_nri (which has no UI); then the
ten examples that need neither a scene nor ray tracing: meshlet_render_nri, meshlet_instancing_nri,
dynamic_lod_nri, meshlet_cull_nri, simple_compute_nri, collision_nri, simple_bezier_nri,
terrain_tessellation_nri, dynamic_blending_nri and atom_orbitals_nri. Text overlays use ImGui's
default font, as the UI isn't compared.

Left out of tier 3: dynamic_line_rasterization (NRI's rasterization desc has line smoothing only:
no line width, rasterization mode or stipple), texture_compression_basisu (the Basis Universal
transcoder is C++ in Donut's interop) and multithreading (Donut's draw batches are recorded on C++
threads; recorded serially, the port would lose its point).

## Tier 4: scenes (NRIFramework utils::Scene, cgltf)

This tier covers the Vulkan-Samples ports that load glTF, then deferred_shading,
threaded_rendering, environment_map and bindless_rendering. The meshes come from Donut's own glTF
reader (core/vulkan_samples_gltf.h, through `Nri_LoadGltfMesh`), not NRIFramework's utils::Scene,
whose vertex layout and transforms differ: the frames then match Donut's pixel for pixel.

First batch: dynamic_rendering_nri, vertex_dynamic_state_nri, dynamic_primitive_clipping_nri,
fragment_shader_barycentric_nri and push_descriptors_nri. deferred_shading, threaded_rendering and
environment_map draw with Donut's C++ render passes, and bindless_rendering reads Donut's scene
buffers: they come last.

Second batch: patch_control_points_nri, instancing_nri, logic_op_dynamic_state_nri,
oit_linked_lists_nri and oit_depth_peeling_nri.

Third batch: hdr_nri, timestamp_queries_nri, fragment_shading_rate_nri,
fragment_shading_rate_dynamic_nri and mobile_nerf_nri. Left for later: calibrated_timestamps (NRI
has no calibrated timestamps), rasterization_order_attachment_access, texture_mipmap_generation
(NRI has no blits), and the examples that load whole glTF models with materials
(`loadGltfModel`: extended_dynamic_state2, msaa, multi_draw_indirect and others).

Fourth batch, the first with whole glTF models (`Nri_LoadGltfModel`): gshader_to_mshader_nri,
multi_draw_indirect_nri, dynamic_rendering_local_read_nri, extended_dynamic_state2_nri and
dynamic_multisample_rasterization_nri. Still to come with models: msaa, async_compute_bloom,
render_octomap, texture_compression_comparison.

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
- The UI isn't compared: NRIFramework's ImGui is a newer version, scaled by the monitor's DPI, and
  Donut's examples draw theirs even with -noUI. The scene is compared pixel for pixel against the
  Donut example's -testOutput with -noUI on the NRI side, outside Donut's UI window.
- On D3D11, an example that draws ImGui gets NRI's command buffer emulation (`Nri_UseImgui`): from
  NRI's deferred contexts the UI's geometry, which the streamer writes into a DYNAMIC buffer, is
  drawn as nothing. The emulation isn't on for the others: it breaks the compute queue examples.
- NRI's validation rejects two descriptor sets in the same register space, which D3D12 allows: a
  set of its own needs a space of its own (on Vulkan the space is the set's index anyway).
- NRI's Vulkan backend chains only the feature structs of the extensions it knows:
  `patches/NRI-shader-quad-control.patch` adds VK_KHR_shader_quad_control and
  VK_KHR_shader_maximal_reconvergence (enabled where the device has them, as Donut does). NRI
  doesn't say whether they're on; `Nri_IsFeatureSupported` asks vkGetPhysicalDeviceFeatures2
  through NRI's Vulkan wrapper, as NRI passes what it queried to vkCreateDevice.
- D3D12's legacy barriers have one state for buffers read by vertex and by compute shaders
  (NON_PIXEL_SHADER_RESOURCE): a barrier between NRI's two is "before and after states must be
  different". A buffer both read goes between `VertexAndComputeShaderResource` and `Storage`.
- NRI's D3D12 backend gets patch lists' topology wrong (TRIANGLESTRIP_ADJ plus the control points
  instead of 1_CONTROL_POINT_PATCHLIST minus one plus them: "primitive topology mismatch" at the
  draw); `patches/NRI-d3d12-patch-list-topology.patch` fixes it. D3D11's is right.
- NRI draws its default lines only, with no line rasterization mode or width. Where a Donut example
  asks for rectangular lines (D3D's quadrilateral lines; on Vulkan 1.4 pixels wide: collision) or
  Bresenham ones (Vulkan: simple_bezier's wireframe), the NRI port differs along every line, and
  only there.
- NRI expands a descriptor range without `NriRangeFlags.Array` into one Vulkan binding per
  descriptor: a shader's texture array (`Texture2D textures[225] : register(t0)`, one binding) needs
  the flag, or its bindings run into the samplers' shifted ones (s128) and the layout is rejected.
- NRI creates sRGB images as their UNORM format on Vulkan (to make views of either), so its
  CmdResolveTexture averages encoded values there; Donut's resolves (render pass resolve on Vulkan,
  ResolveSubresource on D3D) average linear ones. shaders/nri_msaa_resolve.hlsl resolves through
  sRGB views instead: within 1 of Donut's frames on Vulkan. On D3D11 and D3D12 (identical to each
  other) dynamic_multisample_rasterization_nri also differs by up to 12 along the background's edges
  seen through the translucent column, above 1x only; Donut's frames are the same on all three APIs.
- Donut's test mode passes each frame's 1/60 second as a float: the ports step their animations by
  `Math.fround(1.0 / 60.0)`, or a state that integrates time (atom_orbitals' superposition) drifts.
- `Nri_RunSample` leaves the example's options out of NRIFramework's command line; an option with
  values (`Nri_AddExampleOptionWithValues`) has its values left out too, or NRIFramework rejects
  them.
- An animation that the original sample steps in OnUpdate counts the frame before it's drawn
  (frame number = frameIndex + 1), as Donut's test mode does.
- NRI's `depthClamp` is D3D's DepthClipEnable on D3D11 and D3D12 but Vulkan's depthClampEnable,
  the opposite: `Nri_PipelineDescSetDepthClip` sets it for the API. With depth clipping off, Donut
  on Vulkan neither clips nor clamps (VK_EXT_depth_clip_enable without depth clamp), so depths out
  of range are the driver's: dynamic_primitive_clipping's torus knot (`-object 1`) differs from
  Donut's Vulkan frame there, while the NRI port clamps on both APIs and matches Donut's D3D12 frame.
- NRI's D3D11 and D3D12 backends set IndependentBlendEnable with logic operations, which both
  reject, and its D3D12 backend sets the logic operation only with blending, which D3D12 doesn't
  allow with it (so it was never used): `patches/NRI-logic-op.patch`.
- NRI's upload helper maps an upload buffer it never created when no buffer upload has data (only
  the state transitions): `patches/NRI-upload-buffers-without-data.patch`.
- NRI's D3D11 backend makes every buffer of 4-byte structures a raw buffer (to allow raw views of
  it), so a shader's `RWStructuredBuffer<uint>` can't be bound there: oit_linked_lists_nri skips
  D3D11.
- D3D12 rejects reading a render target or depth texture (NRI creates them not zeroed) before a
  clear, discard or copy initializes it: a port that binds them before rendering into them clears
  them once first (oit_depth_peeling_nri).
- NRI's D3D11 barriers don't unbind shader resources: rendering into a texture the previous pass
  read gets the runtime's "still bound on input" warnings (it unbinds it itself), as in
  terrain_tessellation_nri and color_write_enable_nri.
- instancing_nri on D3D11 differs from Donut's D3D11 frame in about 170 faint stars: the star field
  hashes interpolated coordinates scaled by about 440 (frac), so the last bit of D3D11's attribute
  interpolation decides some stars. Both are deterministic; D3D12 and Vulkan match exactly.
- NRI's Vulkan swap chain needn't hand out its textures in order (D3D12's flip model does): an
  example that reads what "the frame before" rendered into a per-texture target tracks the texture
  it last rendered into instead of taking the one before the current
  (fragment_shading_rate_dynamic_nri's frequency content).
- A test that passes isn't a frame that matches: fragment_shading_rate_dynamic_nri passed with its
  compute shader writing nothing (its parameters were written before the shading rate image's size
  was known), and logic_op_dynamic_state_nri with D3D12 ignoring the logic operation. Compare every
  option against Donut.

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

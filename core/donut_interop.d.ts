/// <reference path="donut_handles.d.ts" />
/// <reference path="interop/resources.d.ts" />
/// <reference path="interop/device.d.ts" />
/// <reference path="interop/app.d.ts" />
/// <reference path="interop/pipelines.d.ts" />
/// <reference path="interop/bindings.d.ts" />
/// <reference path="interop/vulkan_descriptors.d.ts" />
/// <reference path="interop/commands.d.ts" />
/// <reference path="interop/raytracing.d.ts" />
/// <reference path="interop/d3d12.d.ts" />
/// <reference path="interop/assets.d.ts" />
/// <reference path="interop/scene.d.ts" />
/// <reference path="interop/render_passes.d.ts" />
/// <reference path="interop/dlss.d.ts" />
/// <reference path="interop/imgui.d.ts" />
/// <reference path="interop/math.d.ts" />
/// <reference path="interop/directx_collision.d.ts" />
/// <reference path="interop/basis_transcoder.d.ts" />
/// <reference path="interop/fast_block_compress.d.ts" />
/// <reference path="interop/video_player.d.ts" />
/// <reference path="interop/sdkmesh.d.ts" />
/// <reference path="interop/obj_model.d.ts" />
/// <reference path="interop/meshlet_model.d.ts" />
/// <reference path="interop/paged_images.d.ts" />
/// <reference path="interop/omm_bake.d.ts" />
/// <reference path="interop/ptlas.d.ts" />
/// <reference path="interop/clas.d.ts" />
/// <reference path="interop/denoised_rtao.d.ts" />
/// <reference path="interop/rtxpt.d.ts" />
/// <reference path="interop/rtxmg.d.ts" />
/// <reference path="interop/rtxcr.d.ts" />
/// <reference path="interop/streamline.d.ts" />
/// <reference path="interop/rtxdi.d.ts" />
/// <reference path="interop/rtxdi_minimal.d.ts" />
// --- Donut interop: the C functions core/*.cpp export, declared for TypeScript ------------------
//
// This file only gathers the declarations, grouped by what they do, in core/interop/: the app and
// window, the device's support, resources, pipelines, bindings, commands, ray tracing, D3D12-only
// features, assets, Donut's scene and render passes, DLSS, ImGui and math, implemented in
// core/donut_interop.cpp (math also in core/msvc_fast_math.cpp); then one file per optional C++
// module (core/<module>.cpp, linked only into the examples that use it), with the handles of its
// objects. A part references the parts whose enums and types it uses (tslang, unlike tsc, needs a
// type declared before it's used), and the order here follows that. tools/check_interop_types.py
// and tools/generate_donut_wrappers.py read the files referenced here, in this order.
//
// Every function is @nodrops but Donut_RunApp and Donut_SetSwapChainFormat, the two that run the
// passes' callbacks (TypeScript methods) before they return: the others never call into
// TypeScript, and C++ never frees a TypeScript block, so under -mm=own a borrow (a field's array
// given as Ref(this.constants[0])) outlives a call of them. A new function that calls a TypeScript
// callback before it returns must go without the mark.

cmake_minimum_required(VERSION 3.21)

# Ninja is a single-config generator, so CMAKE_BUILD_TYPE must be set at configure time
# (there's no per-build --config switch like with multi-config generators).
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE "Debug" CACHE STRING "Build type" FORCE)
    set_property(CACHE CMAKE_BUILD_TYPE PROPERTY STRINGS "Debug" "Release" "RelWithDebInfo" "MinSizeRel")
endif()

# Make CMake find ts-language modules
list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

# CXX is enabled for its linker only: TSLANG objects are linked by the C++ toolchain, so no
# .cpp source is needed in the target.
project(native_ts_graphics CXX TSLANG)

# The Windows build is x64 only (tslang's default library, the Agility SDK, the NVRHI bindings'
# ABI). A 32-bit developer prompt picks the x86 cl, which fails later and less clearly
# (ShaderMake's /W4 /WX on 32-bit conversions, among others).
if (WIN32 AND NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "The C++ compiler targets 32-bit x86 (${CMAKE_CXX_COMPILER}): configure from an x64 "
        "developer prompt (vcvars64.bat, \"x64 Native Tools Command Prompt\") and delete this build folder's "
        "CMakeCache.txt first")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS ON)

# Include folders
include_directories(${CMAKE_TSLANG_DIR}/defaultlib)

# The compiled default lib is split into per-target subfolders, then per build (debug/release),
# then per memory model (gc/rc/none); tslang names the one matching this build (below), so that
# the CRT, the allocator and the default-lib binaries all agree. A library built for one model
# cannot be linked into a program built for another. tslang tells the debug build by --di, as it
# does when it links itself.
if (CMAKE_BUILD_TYPE STREQUAL "Release")
	set(TSLANG_DEFAULTLIB_BUILD_FLAG "")
else()
	set(TSLANG_DEFAULTLIB_BUILD_FLAG "--di")
endif()

set(TSLANG_MEMORY_MODEL "gc" CACHE STRING "Memory model of compiled code: gc, rc or none")
set_property(CACHE TSLANG_MEMORY_MODEL PROPERTY STRINGS gc rc none)

# Android (the NDK's toolchain file, see the android-* presets): the TypeScript is compiled for the
# toolchain's ABI and API level, the same triple the C++ is compiled for, and that triple also picks
# the default lib below. Objects for Android are position independent without -relocation-model.
if (ANDROID)
	if (CMAKE_ANDROID_ARCH_ABI STREQUAL "arm64-v8a")
		set(TSLANG_ANDROID_ARCH "aarch64")
		set(TSLANG_ANDROID_ENV "android")
	elseif (CMAKE_ANDROID_ARCH_ABI STREQUAL "armeabi-v7a")
		set(TSLANG_ANDROID_ARCH "armv7a")
		set(TSLANG_ANDROID_ENV "androideabi")
	elseif (CMAKE_ANDROID_ARCH_ABI STREQUAL "x86_64")
		set(TSLANG_ANDROID_ARCH "x86_64")
		set(TSLANG_ANDROID_ENV "android")
	else()
		message(FATAL_ERROR "No tslang runtime for the Android ABI '${CMAKE_ANDROID_ARCH_ABI}': use arm64-v8a, armeabi-v7a or x86_64")
	endif()
	set(TSLANG_TARGET_TRIPLE_FLAG "-mtriple=${TSLANG_ANDROID_ARCH}-linux-${TSLANG_ANDROID_ENV}${CMAKE_SYSTEM_VERSION}")
	if (CMAKE_ANDROID_ARCH_ABI STREQUAL "armeabi-v7a")
		# Vulkan's non-dispatchable handles are 64-bit integers on 32-bit targets, not pointers: Vulkan-Hpp
		# then converts its wrappers to and from the C handles implicitly, which NVRHI and Donut rely on
		# (the rest of NVRHI's 32-bit changes are patches/nvrhi-vulkan-32bit-handles.patch).
		add_compile_definitions(VULKAN_HPP_TYPESAFE_CONVERSION=1)
	endif()
else()
	set(TSLANG_TARGET_TRIPLE_FLAG "")
endif()

execute_process(COMMAND "${CMAKE_TSLANG_COMPILER}" --print-default-lib-dir=lib ${TSLANG_DEFAULTLIB_BUILD_FLAG} -mm=${TSLANG_MEMORY_MODEL} ${TSLANG_TARGET_TRIPLE_FLAG}
	OUTPUT_VARIABLE TSLANG_DEFAULTLIB_SUBDIR
	OUTPUT_STRIP_TRAILING_WHITESPACE
	COMMAND_ERROR_IS_FATAL ANY)

# Lib folders
if (ANDROID)
	# The collector and the async runtime built for Android sit in a folder per ABI, not next to
	# tslang where the host's are.
	set(TSLANG_ANDROID_LIB_DIR "${CMAKE_TSLANG_DIR}/android/${CMAKE_ANDROID_ARCH_ABI}/lib" CACHE PATH
		"libgc.a and libTypeScriptAsyncRuntime.a built for the Android ABI")
	link_directories(${CMAKE_TSLANG_DIR}/${TSLANG_DEFAULTLIB_SUBDIR} ${TSLANG_ANDROID_LIB_DIR})
else()
	link_directories(${CMAKE_TSLANG_DIR} ${CMAKE_TSLANG_DIR}/${TSLANG_DEFAULTLIB_SUBDIR})
endif()

# set options
if (CMAKE_BUILD_TYPE STREQUAL "Release")
	set(CMAKE_TSLANG_FLAGS "--opt --opt_level=3") # global
else()
	set(CMAKE_TSLANG_FLAGS "--di --opt_level=0") # global
endif()

# The same variable that picked the link directory has to reach the compiler as well, or the
# program is compiled for one model and linked against another model's default lib.
set(CMAKE_TSLANG_FLAGS "${CMAKE_TSLANG_FLAGS} -mm=${TSLANG_MEMORY_MODEL} ${TSLANG_TARGET_TRIPLE_FLAG}") # global

set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Donut
# TypeScriptDefaultLib and TypeScriptAsyncRuntime are built against the release static CRT
# (/MT) even in their debug folder; everything linked with them, Donut included, has to use
# the same CRT, or the linker reports RuntimeLibrary/_ITERATOR_DEBUG_LEVEL mismatches.
if (MSVC)
	set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")
	# Donut adds -D_DEBUG to Debug flags, which would make the headers reference the debug CRT
	# (_malloc_dbg, libcpmtd) that /MT doesn't provide; patches/Donut-no-D_DEBUG-on-MSVC.patch
	# leaves it out on MSVC (a /U_DEBUG here instead made cl warn D9025).
endif()

# Keyed off CMAKE_BINARY_DIR (not CMAKE_SOURCE_DIR) so each config's own build folder
# (build/ for Debug, build-release/ for Release) gets its own output instead of sharing one.
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}")
set(DONUT_SHADERS_OUTPUT_DIR "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/framework")

# Local patches to the external/Donut submodule, applied before add_subdirectory() picks up its
# sources (same scheme as PyDonut). Idempotent and non-fatal: a patch already applied is detected
# and skipped, and one that doesn't apply only warns, so a hand-edited submodule doesn't break
# every configure.
set(DONUT_PATCHES
    # GLFW's joystick enumeration can stall startup for tens of seconds on Windows; none of the
    # examples read joysticks.
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/DeviceManager-skip-joystick-init-by-default.patch"
    # Building with the Android NDK: Bionic has glob but no glob64, libc++ needs <sstream> spelled
    # out, and neither stdc++fs nor a separate pthread library exists there.
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/Donut-build-for-Android.patch"
    # Android's window: Donut picks no X11 there, takes the surface's swap chain formats, alpha and
    # present modes, and stops before a frame once its window is closing.
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/Donut-Android-window.patch"
    # Vulkan's compute queue (AppOptions.ComputeQueue, async_compute): Donut wants a family with
    # compute and no graphics, which most mobile GPUs don't have; take the graphics family's second
    # queue then.
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/Donut-compute-queue-fallback.patch"
    # MSVC defines _DEBUG itself with /MTd; Donut's -D_DEBUG would pull in the debug CRT under /MT.
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/Donut-no-D_DEBUG-on-MSVC.patch"
    # DeviceCreationParameters::swapChainColorSpace and Set/IsSwapChainColorSpaceSupported: swap
    # chains in sRGB, HDR10 (ST.2084, Rec.2020) or scRGB, through SetColorSpace1 on D3D11 and D3D12
    # and the surface's color space on Vulkan; changes go through the resize path (simple_hdr).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/Donut-swap-chain-color-space.patch"
    # PlanarShadowMap::Clear cleared its depth texture with clearTextureFloat, which NVRHI refuses
    # for depth textures; and SetupWholeSceneDirectionalLightView gave the projection the scene's
    # depth range along the light negated, right only for scenes centered on the light's node (D3D
    # clamps the rest to the near or far plane, Vulkan clips it away). environment_map uses both.
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/Donut-planar-shadow-map-clear.patch"
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/Donut-planar-shadow-map-whole-scene-depth-range.patch"
    # DeviceCreationParameters::messageCallback, NVRHI's IMessageCallback, on Vulkan and D3D11 too
    # (D3D12 has it): the application's, as a tslang class implementing it (nvrhi_direct).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/Donut-message-callback-all-apis.patch"
    # Donut's chunk file structs hold pointers, and static_assert their 64-bit sizes; those asserts
    # only hold on 64-bit targets (armeabi-v7a would otherwise stop at them).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/Donut-chunk-layout-64bit-only.patch"
    # Scene::CreateMeshBuffers passes a size_t as the uint64_t& AppendBufferRange takes: 32-bit targets
    # have the two apart.
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/Donut-skinned-buffer-size-uint64.patch"
    # RenderView set up the material only when it changed, and passes without the input assembler put
    # the buffers' binding set into the state there: a draw with other buffers but the same material
    # read the previous draw's vertices. Skinned meshes have buffers each, so a character whose skinned
    # meshes share a material (a Mixamo one: body, shirt, pants) drew garbage (rtxcr_raster).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/Donut-geometry-pass-rebind-input-buffers.patch"
    # A skinned mesh's bounds were its prototype's, in the model's space, though the skinning writes
    # the vertices in the mesh node's: a node under a transform (a Mixamo armature's 0.01 scale and
    # rotation) culled the character away and fitted the shadow maps to the wrong box.
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/Donut-skinned-mesh-bounds.patch"
    # DLSS::Init creates its feature on a command list of its own while the frame's is open: as a second
    # immediate one, which NVRHI's validation (-debug) refuses (feature_demo's tests with DONUT_WITH_DLSS).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/Donut-dlss-non-immediate-command-list.patch"
    # DLSS::InitParameters::useAutoExposure was never turned into NGX's AutoExposure flag: rtxpt's DLSS, which
    # has no exposure texture, measures the exposure itself as the sample's (Streamline's) does.
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/Donut-dlss-auto-exposure.patch"
    # The forward and depth passes kept a buffer group's input binding set (without the input assembler)
    # for good: rtxcr_raster's animated hair, which the morph target pass writes into one of two vertex
    # buffers a frame, drew from the first one in every frame (in a state nothing tracked: device lost).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/Donut-input-binding-set-vertex-buffer-change.patch"
    # SetDirectoryWithExecutable: GetDirectoryWithExecutable is where code looks for files next to the
    # executable, which under tslang's JIT is tslang.exe's folder, not bin/; rtxpt's run-time shader
    # compiler (RTXPT_DIR's) finds ShaderDynamic/ there, so core/rtxpt.cpp points it at bin/.
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/Donut-executable-directory-override.patch"
)

# The same for Donut's GLFW submodule (external/Donut/thirdparty/glfw), which is a repository of
# its own: an Android platform, a NativeActivity's window through android_native_app_glue.
set(DONUT_GLFW_PATCHES
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/glfw-android-platform.patch"
)

# And for NVRHI's (external/Donut/nvrhi).
set(DONUT_NVRHI_PATCHES
    # D3D11 rebinds the binding sets when a pipeline has other shader stages than the previous one,
    # so the same sets reach a geometry shader drawn after a draw without one (gshader_to_mshader).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-d3d11-rebind-on-shader-stage-change.patch"
    # Vulkan binds a tiled texture's edge tiles up to the level's edge, not a whole tile past it,
    # for levels that aren't a whole number of tiles (sparse_image).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-vulkan-sparse-edge-tiles.patch"
    # Vulkan copies between staging textures and textures from the right place when the region
    # doesn't start at column 0: its offset counted the columns in blocks, not bytes (sparse_image).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-vulkan-staging-copy-offset.patch"
    # RasterState::conservativeRasterExtraOverestimation, Vulkan's extraPrimitiveOverestimationSize
    # (conservative_rasterization).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-vulkan-conservative-extra-overestimation.patch"
    # BlendState::logicOpEnable and logicOp: logic operations instead of blending, on D3D11 (11.1's
    # blend state), D3D12 and Vulkan (logic_op_dynamic_state).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-logic-op.patch"
    # FramebufferDesc::colorResolveAttachments, depthResolveAttachment and depthResolveMode: Vulkan
    # render passes resolve multisampled attachments as they end, through dynamic rendering's
    # resolve attachments (msaa).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-vulkan-render-pass-resolve.patch"
    # BlendState::advancedBlendOp and its premultiplication and overlap: Vulkan's advanced blend
    # operations (VK_EXT_blend_operation_advanced) instead of the blend factors (dynamic_blending).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-vulkan-advanced-blend.patch"
    # SamplerDesc::minLod and maxLod: the levels of detail sampled clamped, e.g. to level 0 only, on
    # D3D11, D3D12 and Vulkan (texture_mipmap_generation).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-sampler-lod-range.patch"
    # rt::AccelStructBuildFlags::AllowDataAccess: Vulkan BLASes whose vertex positions hit shaders
    # read (VK_KHR_ray_tracing_position_fetch; ray_tracing_position_fetch).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-accel-struct-allow-data-access.patch"
    # Vulkan render passes take their framebuffer's shading rate attachment (it was made but never
    # passed to vkCmdBeginRendering, so shading rate images did nothing), with pipelines made for it
    # (fragment_shading_rate_dynamic).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-vulkan-shading-rate-attachment.patch"
    # RasterState::lineRasterizationMode, lineWidth and line stipple: Vulkan's line rasterization
    # modes (VK_EXT_line_rasterization), wide and stippled lines (dynamic_line_rasterization).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-vulkan-line-rasterization.patch"
    # GraphicsPipelineDesc::primitiveRestartIndexFormat: strips restart at the largest index, on
    # Vulkan and D3D12 (D3D11 always restarts them; extended_dynamic_state2).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-primitive-restart.patch"
    # Opacity micromaps on Vulkan: rt::PipelineDesc::allowOpacityMicromaps makes ray tracing
    # pipelines with VK_PIPELINE_CREATE_RAY_TRACING_OPACITY_MICROMAP_BIT_EXT (D3D12 has its pipeline
    # flag already), and acceleration structure input buffers can be micromap build inputs too
    # (opacity_micromaps).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-vulkan-opacity-micromaps.patch"
    # D3D12's DXR 1.2 opacity micromaps in BLASes where only some geometries have them: the others
    # stay plain triangles (their linkage dereferenced a null micromap array), and the micromapped
    # ones keep their geometry flags (opacity_micromaps).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-d3d12-omm-linkage.patch"
    # DepthStencilState::depthBoundsTestEnable and GraphicsState::depthBoundsMin, Max: pixels whose
    # depth target value is outside the bounds are discarded, on D3D12 (pipeline state streams with
    # D3D12_DEPTH_STENCIL_DESC1, OMSetDepthBounds) and Vulkan (dynamic depth bounds; depth_bounds_test).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-depth-bounds-test.patch"
    # Vulkan puts depth/stencil textures in a shader resource state into eDepthStencilReadOnlyOptimal,
    # the layout their SRV descriptors declare, also when the state isn't set through a binding set:
    # Donut's CommonRenderPasses gives its black depth textures a permanent ShaderResource state, so
    # DeferredLightingPass's default shadow map was sampled in the wrong layout (deferred_shading).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-vulkan-depth-srv-layout.patch"
    # Vulkan handles on 32-bit targets (armeabi-v7a), where non-dispatchable ones are 64-bit integers, not
    # pointers: names, null defaults and the debug string in the backend take them through rawHandle().
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-vulkan-32bit-handles.patch"
    # vulkan::DeviceDesc's queues are null unless given: Donut gives the compute and transfer queues
    # only when asked for them, and NVRHI took the uninitialized handles for queues it had, saying
    # it had a compute queue (queryFeatureSupport) and crashing in a command list's open() for it
    # (nvrhi_direct).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-vulkan-null-queues.patch"
    # The validation layer's createSamplerFeedbackForNativeTexture called itself, not the device's,
    # until the stack overflowed (nvrhi_direct, -debug).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-validation-sampler-feedback-native.patch"
    # D3D12 buffers of acceleration structures have their resource flag also when virtual: placed
    # by bindAccelStructMemory without it, a TLAS traced through removed the device (nvrhi_direct).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-d3d12-virtual-accel-struct-flag.patch"
    # Vulkan micromaps are created with no device address: one is for capture replay, which needs
    # micromapCaptureReplay (the validation layer's VUID-vkCreateMicromapEXT-deviceAddress-07431;
    # nvrhi_direct, opacity_micromaps). After nvrhi-vulkan-opacity-micromaps.patch.
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-vulkan-micromap-no-capture-address.patch"
    # Draws and dispatches that reuse the binding sets already bound get their barriers too: UAV
    # barriers after the previous one, and on D3D12 the states their resources lost to copies and
    # clears since. Only bindings that changed got any, so passes writing and reading one binding
    # set overlapped (compute_nbody_collisions).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-uav-barriers-same-binding-set.patch"
    # Vulkan pipelines take their viewport and scissor counts from each draw state (Vulkan 1.3's
    # eViewportWithCount), not 1: a geometry shader's SV_ViewportArrayIndex must be below the
    # pipeline's count, and lavapipe drops the primitives past it (bokeh's far layer, on Android's
    # emulator).
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/nvrhi-vulkan-viewport-count.patch"
)

# Applies the patches to the repository in <folder>, unless they are applied already.
function(apply_patches folder)
    foreach(PATCH_FILE ${ARGN})
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" apply --check "${PATCH_FILE}"
            WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/${folder}"
            RESULT_VARIABLE PATCH_CHECK
            OUTPUT_QUIET ERROR_QUIET)
        if (PATCH_CHECK EQUAL 0)
            message(STATUS "Applying patch to ${folder}: ${PATCH_FILE}")
            execute_process(
                COMMAND "${GIT_EXECUTABLE}" apply "${PATCH_FILE}"
                WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/${folder}"
                RESULT_VARIABLE PATCH_APPLY)
            if (NOT PATCH_APPLY EQUAL 0)
                message(WARNING "Failed to apply patch: ${PATCH_FILE}")
            endif()
        else()
            # Doesn't apply forward: it's already applied if it applies in reverse. With less context
            # (-C1): a later patch touching the lines around a hunk would fail the full-context check.
            execute_process(
                COMMAND "${GIT_EXECUTABLE}" apply --check --reverse -C1 "${PATCH_FILE}"
                WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/${folder}"
                RESULT_VARIABLE PATCH_REVERSE_CHECK
                OUTPUT_QUIET ERROR_QUIET)
            if (PATCH_REVERSE_CHECK EQUAL 0)
                message(STATUS "Patch already applied to ${folder}: ${PATCH_FILE}")
            else()
                message(WARNING "Patch does not apply cleanly to ${folder} (skipped): ${PATCH_FILE}")
            endif()
        endif()
    endforeach()
endfunction()

find_package(Git QUIET)
if (GIT_EXECUTABLE)
    # A clone without --recurse-submodules leaves external/Donut empty, which would otherwise fail
    # later with a much less obvious error. A no-op when already up to date.
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" submodule update --init --recursive
        WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
        RESULT_VARIABLE DONUT_SUBMODULE_UPDATE_RESULT)
    if (NOT DONUT_SUBMODULE_UPDATE_RESULT EQUAL 0)
        message(FATAL_ERROR "'git submodule update --init --recursive' failed: "
                            "cannot configure without external/Donut checked out.")
    endif()

    apply_patches(external/Donut ${DONUT_PATCHES})
    apply_patches(external/Donut/thirdparty/glfw ${DONUT_GLFW_PATCHES})
    apply_patches(external/Donut/nvrhi ${DONUT_NVRHI_PATCHES})
else()
    message(WARNING "git not found: skipping the external/Donut patches")
endif()

# NVIDIA DLSS, for feature_demo's DLSS anti-aliasing mode (needs an RTX GPU at run time):
#   cmake --preset dlss (or release-dlss), or -DDONUT_WITH_DLSS=ON
# Donut then fetches the DLSS SDK from GitHub at configure time; into the build folder here rather
# than into the external/Donut submodule (set DONUT_DLSS_FETCH_DIR to share one checkout).
option(DONUT_WITH_DLSS "Enable the NGX DLSS integration (fetches the DLSS SDK)" OFF)
set(DONUT_DLSS_FETCH_DIR "" CACHE STRING "Directory to fetch DLSS to, empty uses build directory default")
# DLSS SDK 310.9.16 (Donut pins 310.3.0): the NGX headers the DLSS-NR package below is built against.
set(DONUT_DLSS_FETCH_TAG "9981c6350dc58c0ce21f024fd65e31e851c31689" CACHE STRING "Git commit hash or tag for DLSS")
if (MSVC AND DONUT_WITH_DLSS)
    # The SDK's debug library (IMPORTED_IMPLIB_DEBUG of Donut's DLSS target) is built against the
    # debug CRT (/MTd); everything here uses the release static CRT (/MT, see above), so Debug links
    # its release library (the configuration-less IMPORTED_IMPLIB) too. This initializes the
    # imported targets Donut creates; its DLSS target isn't GLOBAL, so it can't be changed after.
    set(CMAKE_MAP_IMPORTED_CONFIG_DEBUG "Release;")
endif()

# Quiet two warnings from zstd (Donut's thirdparty/zstd) that don't affect the build:
# - it enables ASM, which CMake 4.1+ no longer lets MSVC's cl.exe stand in for (CMP0194); its one
#   assembly file is never compiled with MSVC (ZSTD_DISABLE_ASM), so keep the old behavior quietly
#   (NEW would make configure look for a real assembler). CMAKE_POLICY_DEFAULT_CMP0194 is ignored,
#   so set the policy from a file zstd's project() includes before it enables its languages;
# - it declares cmake_minimum_required(3.5), which CMake 4.x deprecates (below 3.10): take its
#   policies as of 3.10 instead (it says it was validated with 3.13's).
# Both only for the Donut subtree. The ASM check runs only when the compiler is first detected,
# so the warning showed on a fresh configure only.
if (ANDROID)
    # GLFW's Android platform (patches/glfw-android-platform.patch) gives Donut its window: the
    # NativeActivity's, through android_native_app_glue (see core/android_main.cpp).

    # ShaderMake runs at build time, so it has to be a program for this machine, not one built
    # with the NDK: take the one a desktop build of this project made. Donut then doesn't build
    # it (it checks for the target), which leaves out ShaderMakeBlob too, so that is built here.
    find_program(DONUT_HOST_SHADERMAKE ShaderMake
        HINTS "${CMAKE_CURRENT_SOURCE_DIR}/build-release/bin" "${CMAKE_CURRENT_SOURCE_DIR}/build/bin"
        DOC "ShaderMake built for the host (by a desktop build of this project)"
        NO_CMAKE_FIND_ROOT_PATH)
    if (NOT DONUT_HOST_SHADERMAKE)
        message(FATAL_ERROR "No ShaderMake for the host: build the desktop preset first "
                            "(cmake --preset release && cmake --build --preset release --target ShaderMake), "
                            "or set DONUT_HOST_SHADERMAKE")
    endif()
    add_executable(ShaderMake IMPORTED GLOBAL)
    set_target_properties(ShaderMake PROPERTIES IMPORTED_LOCATION "${DONUT_HOST_SHADERMAKE}")
    set(SHADERMAKE_PATH ShaderMake CACHE INTERNAL "")

    # Vulkan only, so SPIR-V only: DXC from the Vulkan SDK.
    find_program(SHADERMAKE_DXC_VK_PATH dxc
        HINTS "$ENV{VULKAN_SDK}/Bin" "$ENV{VULKAN_SDK}/bin"
        DOC "DXC with SPIR-V output (Vulkan SDK)"
        NO_CMAKE_FIND_ROOT_PATH)

    add_library(ShaderMakeBlob STATIC external/Donut/ShaderMake/ShaderMake/ShaderBlob.cpp)
    target_include_directories(ShaderMakeBlob PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/external/Donut/ShaderMake")
endif()

# rtxcr_pathtracer (see the end of this file) builds only with RTXCR_DIR: a checkout of NVIDIA's
# RTXCR (github.com/NVIDIA-RTX/RTXCR) with its submodules and assets.
set(RTXCR_DIR "" CACHE PATH "RTXCR checkout (github.com/NVIDIA-RTX/RTXCR) with its submodules and assets")
# rtxpt (see the end of this file) builds only with RTXPT_DIR: a checkout of NVIDIA's RTX Path
# Tracing (github.com/NVIDIA-RTX/RTXPT) with its submodules and assets, configured once by its own
# CMake (which downloads the DXC its run-time shader compiler uses, External/dxc).
set(RTXPT_DIR "" CACHE PATH "RTXPT checkout (github.com/NVIDIA-RTX/RTXPT) with its submodules and assets")

# Opacity micromaps on D3D12 through the Agility SDK's DXR 1.2 (raytracing tier 1.2) rather than
# NVAPI (opacity_micromaps; Vulkan has them through VK_EXT_opacity_micromap).
if (RTXCR_DIR AND WIN32)
    # rtxcr_pathtracer's linear swept spheres on D3D12 come through NVAPI, which NVRHI leaves out
    # while it uses DXR 1.2's opacity micromaps: with RTXCR_DIR the micromaps are NVAPI's too, and
    # NVAPI is the RTXCR checkout's.
    set(NVRHI_D3D12_WITH_DXR12_OPACITY_MICROMAP OFF CACHE BOOL "Use D3D12 native Opacity Micromaps from DXR 1.2" FORCE)
    set(NVRHI_WITH_NVAPI ON CACHE BOOL "Include NVAPI support (requires NVAPI SDK)" FORCE)
    set(NVAPI_INCLUDE_DIR "${RTXCR_DIR}/external/nvapi" CACHE PATH "NVAPI headers" FORCE)
    set(NVAPI_LIBRARY "${RTXCR_DIR}/external/nvapi/amd64/nvapi64.lib" CACHE FILEPATH "NVAPI library" FORCE)
else()
    set(NVRHI_D3D12_WITH_DXR12_OPACITY_MICROMAP ON CACHE BOOL "Use D3D12 native Opacity Micromaps from DXR 1.2" FORCE)
endif()

set(CMAKE_PROJECT_zstd_INCLUDE_BEFORE "${CMAKE_CURRENT_SOURCE_DIR}/cmake/zstd_policies.cmake")
set(CMAKE_POLICY_VERSION_MINIMUM 3.10)
add_subdirectory(external/Donut)
unset(CMAKE_POLICY_VERSION_MINIMUM)
unset(CMAKE_PROJECT_zstd_INCLUDE_BEFORE)

if (NVRHI_WITH_DX12)
    set(DONUT_D3D_AGILITY_SDK_URL "https://www.nuget.org/api/v2/package/Microsoft.Direct3D.D3D12/1.619.6")
    set(DONUT_D3D_AGILITY_SDK_FETCH_DIR "" CACHE STRING "" FORCE)
    include("${CMAKE_CURRENT_SOURCE_DIR}/external/Donut/cmake/FetchAgilitySDK.cmake")

    file(COPY
        "${DONUT_D3D_AGILITY_SDK_PATH}/build/native/bin/x64/D3D12Core.dll"
        "${DONUT_D3D_AGILITY_SDK_PATH}/build/native/bin/x64/D3D12SDKLayers.dll"
        DESTINATION "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/D3D12/")
    # Linked into the examples that need the Agility SDK runtime rather than the OS's (work
    # graphs, shader model 6.9): exports its version.
    set_source_files_properties(core/d3d12_agility_sdk.cpp PROPERTIES
        COMPILE_DEFINITIONS DONUT_D3D_AGILITY_SDK_VERSION=${DONUT_D3D_AGILITY_SDK_VERSION})
endif()

# DLSS 5, NVIDIA's DLSS 3D-Guided Neural Rendering (DLSS-NR), for feature_demo (Vulkan or D3D12, RTX GPU,
# driver 616.92+). Its SDK isn't in the public DLSS one: RTX Remix's build fetches it as a packman
# package (dxvk-remix/packman-external.xml), from the public remote downloaded here, at configure
# time, into the build folder (DONUT_DLSS_NR_FETCH_DIR to share one). It's under the NVIDIA RTX SDKs
# license (LICENSE.txt in it): its headers and nvngx_dlssnr.dll must not be committed here.
option(DONUT_WITH_DLSS_NR "With DONUT_WITH_DLSS, also fetch the DLSS-NR (DLSS 5) SDK (~370 MB)" ON)
set(DONUT_DLSS_NR_FETCH_DIR "" CACHE STRING "Directory to fetch DLSS-NR to, empty uses build directory default")
if (DONUT_WITH_DLSS AND DONUT_WITH_DLSS_NR AND WIN32 AND DONUT_WITH_VULKAN)
    if (DONUT_DLSS_NR_FETCH_DIR)
        set(DLSS_NR_SOURCE_DIR_OPTION SOURCE_DIR "${DONUT_DLSS_NR_FETCH_DIR}")
    endif()
    message(STATUS "Fetching the DLSS-NR SDK (rtx-remix-ngx_sdk_dlnr 2, ~370 MB the first time)")
    include(FetchContent)
    FetchContent_Declare(dlss_nr
        URL "https://d1oqksizpb0e3d.cloudfront.net/rtx-remix-ngx_sdk_dlnr@2.7z"
        URL_HASH SHA256=4bb8651b3ac2180f23df1f39422c489810a13d445a94dc836c876c18c93ecefe
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE
        ${DLSS_NR_SOURCE_DIR_OPTION})
    FetchContent_MakeAvailable(dlss_nr)
    # The DLSS SDK's headers, which the DLSS-NR ones include (Donut's DLSS target isn't GLOBAL).
    FetchContent_GetProperties(DLSS SOURCE_DIR DLSS_SDK_SOURCE_DIR)
    set(DLSS_NR_INCLUDE_DIRS "${DLSS_SDK_SOURCE_DIR}/include" "${dlss_nr_SOURCE_DIR}/include")
    set(DLSS_NR_SHARED_LIBRARY_PATH "${dlss_nr_SOURCE_DIR}/lib/Windows_x86_64/rel/nvngx_dlssnr.dll")
endif()

# DLSS Ray Reconstruction (DLSS-RR, nvngx_dlssd.dll), for rtxpt's real-time mode: core/donut_interop.cpp drives
# the NGX feature itself (Donut's DLSS has no specular motion vectors or view matrices), over the DLSS SDK's
# headers (Donut's DLSS target isn't GLOBAL, so not through it).
if (DONUT_WITH_DLSS AND WIN32)
    include(FetchContent)
    FetchContent_GetProperties(DLSS SOURCE_DIR DLSS_SDK_SOURCE_DIR)
    if (DLSS_SDK_SOURCE_DIR)
        set(DLSS_RR_INCLUDE_DIRS "${DLSS_SDK_SOURCE_DIR}/include")
    endif()
endif()

# NVIDIA's Opacity Micro-Map SDK (github.com/NVIDIAGameWorks/Opacity-MicroMap-SDK): its GPU baker and
# the baker's NVRHI layer (omm-lib, omm-gpu-nvrhi), for opacity_micromaps -bake, which bakes the
# micromaps at run time (core/omm_bake.cpp). Fetched at configure time into the build folder, with
# only the submodules omm-lib builds from (ShaderMake is Donut's). It's under the NVIDIA RTX SDKs
# license (LICENSE.txt in it): nothing of it may be committed here. Its layer links nvrhi_d3d12, so
# Windows only.
option(WITH_OMM_SDK "Fetch the Opacity Micro-Map SDK for opacity_micromaps -bake" ON)
if (WITH_OMM_SDK AND WIN32 AND NVRHI_WITH_DX12)
    set(OMM_ENABLE_TESTS OFF CACHE BOOL "" FORCE)
    set(OMM_BUILD_VIEWER OFF CACHE BOOL "" FORCE)
    set(OMM_ENABLE_BENCHMARK OFF CACHE BOOL "" FORCE)
    set(OMM_INTEGRATION_LAYER_NVRHI ON CACHE BOOL "" FORCE)
    set(OMM_BUILD_OMM_GPU_NVRHI ON CACHE BOOL "" FORCE)
    # Static, as NRD: under tslang's JIT a DLL beside donut_interop_shared.dll would not be found.
    set(OMM_STATIC_LIBRARY ON CACHE BOOL "" FORCE)
    # Only the CPU baker uses OpenMP.
    set(OMM_ENABLE_OPENMP OFF CACHE BOOL "" FORCE)
    set(OMM_LIB_INSTALL OFF CACHE BOOL "" FORCE)
    set(OMM_PROJECT_FOLDER "Opacity Micro-Map SDK")
    message(STATUS "Fetching the Opacity Micro-Map SDK (v1.9.2)")
    include(FetchContent)
    FetchContent_Declare(omm_sdk
        GIT_REPOSITORY "https://github.com/NVIDIAGameWorks/Opacity-MicroMap-SDK.git"
        GIT_TAG v1.9.2
        GIT_SHALLOW TRUE
        GIT_SUBMODULES "external/glm;external/lz4;external/stb;external/xxHash")
    FetchContent_MakeAvailable(omm_sdk)
    set(OMM_SDK_LIBRARIES omm-lib omm-gpu-nvrhi)
endif()

# end of Donut

# Flat C API over Donut, shared by the TypeScript examples.
# C++17 is required to match Donut's own targets (Donut headers use std::filesystem); MSVC
# defaults to an older standard without it.
function(configure_donut_interop target)
    set_target_properties(${target} PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)
    target_link_libraries(${target} PUBLIC
        donut_core
        donut_render
        donut_app
        donut_engine
    )

    if (NVRHI_WITH_DX12)
        # Forwards the CMake option as a C++ preprocessor macro so _pydonut.cpp can guard its
        # D3D12 Work Graphs interop code the same way it already guards DXC via PYDONUT_HAVE_DXC.
        target_compile_definitions(${target} PRIVATE NVRHI_WITH_DX12=1)
        # The D3D12 headers, d3dx12.h (CD3DX12_STATE_OBJECT_DESC, ...) included, are NVRHI's
        # DirectX-Headers: not the Agility SDK package's, whose d3dx12.h needs its own d3d12.h,
        # newer than the one Donut's headers include first.
    endif()

    if (DLSS_NR_INCLUDE_DIRS)
        target_include_directories(${target} PRIVATE ${DLSS_NR_INCLUDE_DIRS})
        target_compile_definitions(${target} PRIVATE DONUT_WITH_DLSS_NR=1)
    endif()
    if (DLSS_RR_INCLUDE_DIRS)
        target_include_directories(${target} PRIVATE ${DLSS_RR_INCLUDE_DIRS})
        target_compile_definitions(${target} PRIVATE DONUT_WITH_DLSS_RR=1)
    endif()
endfunction()

# Linked into every example executable.
add_library(donut_interop_static STATIC core/donut_interop.cpp)
configure_donut_interop(donut_interop_static)

# core/donut_interop.d.ts declares the functions core/*.cpp define, by hand: check that each
# declaration matches its definition, handle types included, and that no handle is a void*,
# before building the C++.
find_package(Python3 REQUIRED COMPONENTS Interpreter)
file(GLOB INTEROP_CPP_SOURCES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/core/*.cpp")
add_custom_command(
    OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/check_interop_types.stamp"
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/check_interop_types.py" --strict
        --stamp "${CMAKE_CURRENT_BINARY_DIR}/check_interop_types.stamp"
    DEPENDS
        "${CMAKE_CURRENT_SOURCE_DIR}/tools/check_interop_types.py"
        "${CMAKE_CURRENT_SOURCE_DIR}/core/donut_interop.d.ts"
        "${CMAKE_CURRENT_SOURCE_DIR}/core/donut_handles.d.ts"
        ${INTEROP_CPP_SOURCES}
    COMMENT "Checking core/donut_interop.d.ts against the C++ interop functions"
    VERBATIM)
add_custom_target(check_interop_types DEPENDS "${CMAKE_CURRENT_BINARY_DIR}/check_interop_types.stamp")
add_dependencies(donut_interop_static check_interop_types)

# The same API as bin/donut_interop_shared.dll, for running the .ts files under tslang's JIT:
#   tslang --emit=jit --shared-libs=build/bin/donut_interop_shared.dll examples/<example>.ts
# It sits next to bin/shaders and bin/media, where it looks them up (see Donut_SetAppName).
# It exports the functions marked DONUT_API (core/donut_api.h), the Donut_* ones, and nothing else:
# tslang --jit-native links its import library, which mustn't also export the CRT inlines the DLL
# compiled (sprintf_s, ...), as TypeScriptAsyncRuntime.lib defines them too.
# There is no JIT on Android, so no shared build there either.
# Under the JIT this one library is all an example gets, so it also holds the C++ modules that only
# some examples link into their executables (their add_tslang_example sources), with what those
# need: the OBJ, SDKMESH and meshlet loaders, the PBRT scene, DirectXCollision, Basis Universal's
# transcoder, the fast block compressor, the paged images, and (Windows) the video player.
set(JIT_MODULE_SOURCES
    core/obj_model.cpp
    core/sdkmesh.cpp
    core/meshlet_model.cpp
    core/directx_collision.cpp
    core/basis_transcoder.cpp
    core/fast_block_compress.cpp
    core/fbc_cpu.cpp
    core/paged_images.cpp
    core/omm_bake.cpp)
if (WIN32)
    # denoised_rtao is Windows only (its PBRT parser includes windows.h, it decodes with WIC).
    list(APPEND JIT_MODULE_SOURCES core/denoised_rtao.cpp core/pbrt/PBRTParser.cpp core/pbrt/PlyParser.cpp
        core/video_player.cpp)
endif()
if (OMM_SDK_LIBRARIES)
    set_source_files_properties(core/omm_bake.cpp PROPERTIES COMPILE_DEFINITIONS DONUT_WITH_OMM_SDK=1)
endif()
if (RTXPT_DIR)
    list(APPEND JIT_MODULE_SOURCES core/rtxpt.cpp)
endif()
if (RTXCR_DIR)
    list(APPEND JIT_MODULE_SOURCES core/rtxcr.cpp)
    set_source_files_properties(core/rtxcr.cpp PROPERTIES INCLUDE_DIRECTORIES "${RTXCR_DIR}/libraries;${RTXCR_DIR}/samples/pathtracer;${RTXCR_DIR}/external/RayTracingDenoiser/Include")
endif()
if (NOT ANDROID)
    add_library(donut_interop_shared SHARED core/donut_interop.cpp ${JIT_MODULE_SOURCES})
    configure_donut_interop(donut_interop_shared)
    target_compile_definitions(donut_interop_shared PRIVATE DONUT_INTEROP_SHARED)
    target_link_libraries(donut_interop_shared PRIVATE basisu_transcoder ${OMM_SDK_LIBRARIES})
    # On Linux a shared library goes to LIBRARY_OUTPUT_DIRECTORY, not bin/ as a DLL does: put it next
    # to bin/shaders and bin/media too.
    set_target_properties(donut_interop_shared PROPERTIES LIBRARY_OUTPUT_DIRECTORY "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}")
    # The Agility SDK runtime for the examples whose executables opt into it (see
    # UseAgilitySdkUnderJit): tslang.exe doesn't.
    if (DONUT_D3D_AGILITY_SDK_VERSION)
        target_compile_definitions(donut_interop_shared PRIVATE DONUT_JIT_AGILITY_SDK_VERSION=${DONUT_D3D_AGILITY_SDK_VERSION})
    endif()
    if (WIN32)
        # As video_texture's: mfplat.dll delay-loaded (Windows N editions lack it).
        target_link_libraries(donut_interop_shared PRIVATE delayimp)
        target_link_options(donut_interop_shared PRIVATE /DELAYLOAD:mfplat.dll)
    endif()
endif()

# With DONUT_WITH_DLSS, NGX loads nvngx_dlss.dll from the directory of the executable (of
# donut_interop_shared.dll under the JIT): bin/, where both are. Set by Donut's cmake/DLSS.cmake.
# So are DLSS-RR's nvngx_dlssd.dll and DLSS-NR's nvngx_dlssnr.dll (DONUT_WITH_DLSS_NR, above).
function(copy_dlss_library target)
    if (DLSS_SHARED_LIBRARY_PATH)
        add_custom_command(TARGET ${target} POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different "${DLSS_SHARED_LIBRARY_PATH}" "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/")
    endif()
    if (DLSS_RR_SHARED_LIBRARY_PATH)
        add_custom_command(TARGET ${target} POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different "${DLSS_RR_SHARED_LIBRARY_PATH}" "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/")
    endif()
    if (DLSS_NR_SHARED_LIBRARY_PATH)
        add_custom_command(TARGET ${target} POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different "${DLSS_NR_SHARED_LIBRARY_PATH}" "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/")
    endif()
endfunction()
if (TARGET donut_interop_shared)
    copy_dlss_library(donut_interop_shared)
endif()

# required libs
set(TSLANG_LINK_LIBS "TypeScriptDefaultLib" "TypeScriptAsyncRuntime")

# Boehm is only referenced by the gc default lib; the rc and none builds allocate through the
# CRT and must not drag a collector in.
if (TSLANG_MEMORY_MODEL STREQUAL "gc")
    list(APPEND TSLANG_LINK_LIBS "gc")
endif()

if(ANDROID)
    # Bionic's libc holds pthread and rt; the C++ runtime is the toolchain's ANDROID_STL.
    list(APPEND TSLANG_LINK_LIBS "m" "dl")
elseif(NOT WIN32)
    list(APPEND TSLANG_LINK_LIBS "stdc++" "m" "pthread" "dl" "rt")
endif()

# One executable per example, built from examples/<name>.ts, plus any further sources given after the name.
# Its shaders, if any (the <name>_shaders target), must be compiled into
# bin/shaders/<name>/<dxbc|dxil|spirv>: donut_interop loads them from the folder named after the
# executable.
if (ANDROID)
    # On Android each example is an app as well: <name>_app builds lib<name>.so, the example with
    # core/android_main.cpp and the NDK's android_native_app_glue (a NativeActivity), and <name>_apk
    # packages it as bin/<name>.apk with its shaders and media (tools/package_apk.py). Neither is
    # built by default:
    #   cmake --build --preset android-x86_64 --target basic_triangle_apk
    # The executables stay, for the examples that need no window (headless, run through adb shell).
    # The glue is C.
    enable_language(C)
    set(ANDROID_NATIVE_APP_GLUE_DIR "${ANDROID_NDK}/sources/android/native_app_glue")
    # Renamed, so that core/android_main.cpp's ANativeActivity_onCreate runs first (it starts the
    # collector on the activity's main thread) and calls the glue's.
    set_source_files_properties("${ANDROID_NATIVE_APP_GLUE_DIR}/android_native_app_glue.c" PROPERTIES
        COMPILE_DEFINITIONS "ANativeActivity_onCreate=glue_ANativeActivity_onCreate")
    if (TSLANG_MEMORY_MODEL STREQUAL "gc")
        set_source_files_properties(core/android_main.cpp PROPERTIES COMPILE_DEFINITIONS "TSLANG_MEMORY_MODEL_GC=1")
    endif()

    # Packaging needs the SDK's build tools and platform (not the NDK's), a JDK for apksigner and
    # keytool, and Python. The SDK is ANDROID_HOME's, or next to the NDK, or the NDK is in it.
    foreach(candidate "$ENV{ANDROID_HOME}" "$ENV{ANDROID_SDK_ROOT}" "${ANDROID_NDK}/../sdk" "${ANDROID_NDK}/../..")
        if (candidate AND IS_DIRECTORY "${candidate}/build-tools")
            cmake_path(NORMAL_PATH candidate)
            set(ANDROID_SDK_DIR_DEFAULT "${candidate}")
            break()
        endif()
    endforeach()
    set(ANDROID_SDK_DIR "${ANDROID_SDK_DIR_DEFAULT}" CACHE PATH "Android SDK (build-tools, platforms) for the *_apk targets")

    set(ANDROID_JAVA_HOME_DEFAULT "$ENV{JAVA_HOME}")
    if (NOT ANDROID_JAVA_HOME_DEFAULT AND ANDROID_SDK_DIR)
        # a JDK installed next to the SDK
        file(GLOB ANDROID_JDKS LIST_DIRECTORIES true "${ANDROID_SDK_DIR}/../jdk/*")
        foreach(jdk ${ANDROID_JDKS})
            if (EXISTS "${jdk}/bin/keytool${CMAKE_HOST_EXECUTABLE_SUFFIX}")
                cmake_path(NORMAL_PATH jdk)
                set(ANDROID_JAVA_HOME_DEFAULT "${jdk}")
                break()
            endif()
        endforeach()
    endif()
    set(ANDROID_JAVA_HOME "${ANDROID_JAVA_HOME_DEFAULT}" CACHE PATH "JDK for apksigner and keytool (the *_apk targets)")

    # Made on first use. Every build folder has its own, so an app from another one has to be
    # uninstalled first; point this at ~/.android/debug.keystore to share Android Studio's.
    set(ANDROID_DEBUG_KEYSTORE "${CMAKE_BINARY_DIR}/debug.keystore" CACHE FILEPATH "Keystore the APKs are signed with")

    find_package(Python3 COMPONENTS Interpreter)
    if (NOT ANDROID_SDK_DIR OR NOT Python3_Interpreter_FOUND)
        message(STATUS "No Android SDK (set ANDROID_HOME or ANDROID_SDK_DIR) or no Python: no *_apk targets")
    endif()
endif()

# lib<name>.so and bin/<name>.apk (see above), with the media files and folders listed in
# <media> (paths in the media folder) and the further sources after it
function(add_tslang_android_app name media)
    add_library(${name}_app SHARED EXCLUDE_FROM_ALL examples/${name}.ts ${ARGN}
        core/android_main.cpp "${ANDROID_NATIVE_APP_GLUE_DIR}/android_native_app_glue.c")
    set_target_properties(${name}_app PROPERTIES
        OUTPUT_NAME ${name}
        LINKER_LANGUAGE CXX
        LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/android/${name}")
    target_include_directories(${name}_app PRIVATE "${ANDROID_NATIVE_APP_GLUE_DIR}")
    target_link_libraries(${name}_app PRIVATE tslang_core ${TSLANG_LINK_LIBS} donut_interop_static glfw android log)
    if (TARGET ${name}_shaders)
        add_dependencies(${name}_app ${name}_shaders)
    endif()

    if (NOT ANDROID_SDK_DIR OR NOT Python3_Interpreter_FOUND)
        return()
    endif()

    set(assets --assets "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/framework=shaders/framework")
    if (TARGET ${name}_shaders)
        list(APPEND assets --assets "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/${name}=shaders/${name}")
    endif()
    foreach(path ${media})
        list(APPEND assets --assets "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/${path}=media/${path}")
    endforeach()
    add_custom_target(${name}_apk
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/package_apk.py"
            --name ${name} --lib "$<TARGET_FILE:${name}_app>" --abi ${CMAKE_ANDROID_ARCH_ABI}
            ${assets}
            --sdk "${ANDROID_SDK_DIR}" --java-home "${ANDROID_JAVA_HOME}"
            --min-sdk ${CMAKE_SYSTEM_VERSION} --keystore "${ANDROID_DEBUG_KEYSTORE}" --strip "${CMAKE_STRIP}"
            --work "${CMAKE_BINARY_DIR}/android/${name}/apk"
            --out "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/${name}.apk"
        COMMENT "Packaging ${name}.apk"
        VERBATIM)
    add_dependencies(${name}_apk ${name}_app copy_media)
    if (TARGET donut_shaders)
        add_dependencies(${name}_apk donut_shaders)
    endif()
    # What the executable is made to depend on after this (the copies of the media of the samples'
    # checkouts: <name>_media and the like), the APK packages too, and `tools/android.py build`
    # builds APKs, not executables: taken at the end of the file, when all of it is known. (A
    # deferred call's arguments are evaluated when it runs, hence the EVAL.)
    cmake_language(EVAL CODE "cmake_language(DEFER CALL add_tslang_apk_dependencies [[${name}]])")
endfunction()

function(add_tslang_apk_dependencies name)
    get_target_property(dependencies ${name} MANUALLY_ADDED_DEPENDENCIES)
    if (dependencies)
        add_dependencies(${name}_apk ${dependencies})
    endif()
endfunction()

# The files the examples' .ts files compile in, which their objects have to be rebuilt after: a
# TSLANG object depends on its own .ts only, as tslang can't write a depfile (the DEP_FILE of the
# rule is never made), so changing App in donut.ts left the examples' objects with the old layout.
#   examples/<name>.ts imports core/input_pass.ts, which imports core/donut.ts, which references
#   core/donut_interop.d.ts, which references core/donut_handles.d.ts. donut_globals.d.ts is
#   for the editor only, but it's generated with donut.ts.
# Listed by hand, so a change to any of them rebuilds every example's .ts, and a new import has to
# be added here. Once tslang can write a depfile, set CMAKE_DEPFILE_FLAGS_TSLANG in
# cmake/CMakeTSLANGInformation.cmake and drop these.
set(TSLANG_DONUT_DECLARATIONS
    "${CMAKE_CURRENT_SOURCE_DIR}/core/donut_interop.d.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/core/donut_handles.d.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/core/donut_globals.d.ts")
set(TSLANG_CORE_SOURCES
    "${CMAKE_CURRENT_SOURCE_DIR}/core/input_pass.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/core/args.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/core/test_check.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/core/donut.ts")
set(TSLANG_CORE_SOURCES_WITH_DECLARATIONS
    ${TSLANG_CORE_SOURCES}
    ${TSLANG_DONUT_DECLARATIONS})
set_source_files_properties(core/donut.ts PROPERTIES OBJECT_DEPENDS "${TSLANG_DONUT_DECLARATIONS}")

# -mm=own: a call into another module may destroy anything unless the compiler knows that
# module's ownership facts, which tslang reads from the module's object (--own-facts). So under
# own each .ts object is compiled after objects of the modules it imports, directly or not, and
# given them. Not the objects a target links: a source compiled in every target that lists it (a
# module given to add_tslang_example) has one per target, which a source's OBJECT_DEPENDS can't name (it takes no generator expression).
# Each imported module is compiled once more instead, into own-facts/<path>.obj, from the same
# source with the same flags, so its facts are those of every copy linked. tslang picks
# <name>.<os>.ts for `import "./<name>"`.
if (WIN32)
    set(TSLANG_IMPORT_OS_SUFFIX win32)
else()
    set(TSLANG_IMPORT_OS_SUFFIX linux)
endif()

# The .ts files a .ts file imports, directly or not (absolute paths).
function(tslang_module_imports source out)
    set(found)
    set(work "${source}")
    while(work)
        list(POP_FRONT work current)
        get_filename_component(dir "${current}" DIRECTORY)
        # `from "./x"` anywhere outside a line comment (a module's header shows how to import it):
        # an import's names may span lines, and `export ... from` imports too
        file(READ "${current}" text)
        string(REGEX REPLACE "//[^\n]*" "" text "${text}")
        string(REGEX MATCHALL "from[ \t\r\n]+\"\\.\\.?/[A-Za-z0-9_/]+\"" lines "${text}")
        foreach(line IN LISTS lines)
            if (NOT line MATCHES "\"(\\.\\.?/[A-Za-z0-9_/]+)\"")
                continue()
            endif()
            set(relative "${CMAKE_MATCH_1}")
            foreach(candidate "${dir}/${relative}.ts" "${dir}/${relative}.${TSLANG_IMPORT_OS_SUFFIX}.ts")
                get_filename_component(candidate "${candidate}" ABSOLUTE)
                if (EXISTS "${candidate}")
                    if (NOT candidate IN_LIST found)
                        list(APPEND found "${candidate}")
                        list(APPEND work "${candidate}")
                    endif()
                    break()
                endif()
            endforeach()
        endforeach()
    endwhile()
    list(REMOVE_ITEM found "${source}")
    set(${out} ${found} PARENT_SCOPE)
endfunction()

# The facts object of a module (own-facts/<path>.obj), its compile added once.
function(tslang_own_facts_object source out)
    file(RELATIVE_PATH relative "${CMAKE_CURRENT_SOURCE_DIR}" "${source}")
    set(object "${CMAKE_CURRENT_BINARY_DIR}/own-facts/${relative}.obj")
    set(${out} "${object}" PARENT_SCOPE)
    get_property(added GLOBAL PROPERTY TSLANG_OWN_FACTS_OBJECTS)
    if (object IN_LIST added)
        return()
    endif()
    set_property(GLOBAL APPEND PROPERTY TSLANG_OWN_FACTS_OBJECTS "${object}")
    tslang_own_facts_of("${source}" options depends)
    separate_arguments(flags NATIVE_COMMAND "${CMAKE_TSLANG_FLAGS}")
    get_filename_component(object_dir "${object}" DIRECTORY)
    add_custom_command(OUTPUT "${object}"
        COMMAND ${CMAKE_COMMAND} -E make_directory "${object_dir}"
        COMMAND "${CMAKE_TSLANG_COMPILER}" ${flags} ${options} "--default-lib-path=${CMAKE_TSLANG_DIR}"
                --emit=obj "-o=${object}" "${source}"
        DEPENDS "${source}" ${depends} ${TSLANG_DONUT_DECLARATIONS}
        COMMENT "Compiling ${relative} for its -mm=own facts"
        VERBATIM)
endfunction()

# What a module is compiled with to know its imports' facts: --own-facts options, and the objects.
function(tslang_own_facts_of source out_options out_objects)
    tslang_module_imports("${source}" imports)
    set(objects)
    foreach(import IN LISTS imports)
        tslang_own_facts_object("${import}" object)
        list(APPEND objects "${object}")
    endforeach()
    set(options ${objects})
    list(TRANSFORM options PREPEND "--own-facts=")
    set(${out_options} ${options} PARENT_SCOPE)
    set(${out_objects} ${objects} PARENT_SCOPE)
endfunction()

# Gives each of the .ts sources the facts objects of the modules it imports: --own-facts, and the
# objects among its OBJECT_DEPENDS (kept beside the ones it has: add_tslang_example sets those).
function(tslang_own_facts)
    if (NOT TSLANG_MEMORY_MODEL STREQUAL "own")
        return()
    endif()
    foreach(source IN LISTS ARGN)
        get_filename_component(source "${source}" ABSOLUTE)
        tslang_own_facts_of("${source}" options objects)
        if (NOT objects)
            continue()
        endif()
        get_source_file_property(depends "${source}" OBJECT_DEPENDS)
        if (NOT depends)
            set(depends)
        endif()
        list(APPEND depends ${objects})
        list(REMOVE_DUPLICATES depends)
        set_source_files_properties("${source}" PROPERTIES OBJECT_DEPENDS "${depends}" COMPILE_OPTIONS "${options}")
    endforeach()
endfunction()
foreach(TSLANG_CORE_SOURCE IN LISTS TSLANG_CORE_SOURCES)
    set_source_files_properties(${TSLANG_CORE_SOURCE} PROPERTIES OBJECT_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/core/donut.ts;${TSLANG_DONUT_DECLARATIONS}")
endforeach()

# The core .ts files, compiled once and linked into every example (and Android app): the tslang
# flags are global, so each target's own copy was the same object. An OBJECT library, not a
# STATIC one, so that every object is linked as before, whether the example references it or not.
add_library(tslang_core OBJECT ${TSLANG_CORE_SOURCES})
tslang_own_facts(${TSLANG_CORE_SOURCES})

# add_tslang_example(<name> [MEDIA <path>...] [<source>...]): examples/<name>.ts and the further
# sources. MEDIA lists the files and folders of the media folder it reads (paths in it), which
# go into its APK on Android; on the desktop the whole folder is next to the executables.
function(add_tslang_example name)
    cmake_parse_arguments(PARSE_ARGV 1 EXAMPLE "" "" "MEDIA")
    # .ts files compile with the TSLANG command. Most targets have no .cpp, so link with the C++
    # rule explicitly: the C++ link flags (debug info, CRT) apply and the tslang compile flags
    # stay off the link line.
    add_executable(${name} examples/${name}.ts ${EXAMPLE_UNPARSED_ARGUMENTS})
    set(module_ts ${EXAMPLE_UNPARSED_ARGUMENTS})
    list(FILTER module_ts INCLUDE REGEX "\\.ts$")
    # The example imports the modules listed with it, and compiles their declarations in; so may
    # they each other (core/nvrhi.ts imports core/nvrhi_classes.<os>.ts).
    set(module_ts_paths ${module_ts})
    list(TRANSFORM module_ts_paths PREPEND "${CMAKE_CURRENT_SOURCE_DIR}/")
    set_source_files_properties(${module_ts} PROPERTIES OBJECT_DEPENDS "${TSLANG_CORE_SOURCES_WITH_DECLARATIONS};${module_ts_paths}")
    set_source_files_properties(examples/${name}.ts PROPERTIES OBJECT_DEPENDS "${TSLANG_CORE_SOURCES_WITH_DECLARATIONS};${module_ts_paths}")
    tslang_own_facts(examples/${name}.ts ${module_ts})
    set_target_properties(${name} PROPERTIES LINKER_LANGUAGE CXX)
    target_link_libraries(${name} PRIVATE tslang_core ${TSLANG_LINK_LIBS} donut_interop_static)
    if (TARGET ${name}_shaders)
        add_dependencies(${name} ${name}_shaders)
    endif()
    if (ANDROID)
        add_tslang_android_app(${name} "${EXAMPLE_MEDIA}" ${EXAMPLE_UNPARSED_ARGUMENTS})
    endif()
    # For jit_runtime (the end of this file): what the example depends on, its shaders among them.
    set_property(GLOBAL APPEND PROPERTY TSLANG_EXAMPLES ${name})
endfunction()

# Headless run tests, run by ctest: add_tslang_example_test(<name> [SUFFIX <suffix>] [APIS <api>...]
# [ARGS <arg>...]) runs <name> with -test (its test mode: a headless device, a fixed number of
# frames at a fixed time step, checks of what it rendered, read back) and -debug on each API (dx12
# and vk unless APIS names others), as the tests <name>.<api> (<name>.<suffix>.<api> with SUFFIX,
# for another set of ARGS), labeled <api>. A test fails on a non-zero exit
# code, or an error line from Donut, NVRHI's validation or the API's (D3D12's, Vulkan's) layer;
# Donut logs every message of Vulkan's validation layer as a warning, so those fail it too.
enable_testing()
function(add_tslang_example_test name)
    cmake_parse_arguments(PARSE_ARGV 1 TEST "" "SUFFIX" "APIS;ARGS")
    if (ANDROID)
        return()
    endif()
    if (NOT TEST_APIS)
        set(TEST_APIS dx12 vk)
    endif()
    set(test_name ${name})
    if (TEST_SUFFIX)
        set(test_name ${name}.${TEST_SUFFIX})
    endif()
    foreach(api ${TEST_APIS})
        add_test(NAME ${test_name}.${api}
            COMMAND ${name} -${api} -debug -test ${TEST_ARGS}
            WORKING_DIRECTORY ${CMAKE_RUNTIME_OUTPUT_DIRECTORY})
        set_tests_properties(${test_name}.${api} PROPERTIES
            FAIL_REGULAR_EXPRESSION "ERROR|Validation Error|D3D12 ERROR|D3D12 CORRUPTION|layerPrefix='Validation'"
            # core/test_check.ts' unsupported: the device lacks a feature the example needs
            SKIP_RETURN_CODE 77
            LABELS ${api}
            TIMEOUT 300)
    endforeach()
endfunction()

include(external/Donut/compileshaders.cmake)

# Port of Donut-Samples' basic_triangle.
donut_compile_shaders_all_platforms(
    TARGET basic_triangle_shaders
    PROJECT_NAME "Basic Triangle"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/basic_triangle.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/basic_triangle.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/basic_triangle
)
add_tslang_example(basic_triangle)
add_tslang_example_test(basic_triangle)

# Port of Donut-Samples' meshlets. D3D11 has no mesh shaders, so no DXBC.
donut_compile_shaders(
    TARGET meshlets_shaders
    PROJECT_NAME "Meshlets"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/meshlets.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/meshlets.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/meshlets/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/meshlets/spirv
    SHADERMAKE_OPTIONS_SPIRV "--spirvExt SPV_EXT_mesh_shader"
)
add_tslang_example(meshlets)
add_tslang_example_test(meshlets)

# Port of Donut-Samples' shader_specializations. Specialization constants are Vulkan-only.
donut_compile_shaders(
    TARGET shader_specializations_shaders
    PROJECT_NAME "Shader Specializations"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/shader_specializations.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/shader_specializations.hlsl
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/shader_specializations/spirv
)
add_tslang_example(shader_specializations)
add_tslang_example_test(shader_specializations)

# Port of Donut-Samples' headless: compute only, no window.
donut_compile_shaders_all_platforms(
    TARGET headless_shaders
    PROJECT_NAME "Headless"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/headless.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/headless.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/headless
)
# core/nvrhi.ts, NVRHI's interfaces called directly, and the modules it is made of: the layouts of
# the C++ ABI are core/nvrhi_abi.<os>.ts and the classes core/nvrhi_classes.<os>.ts (generated by
# tools/gen_nvrhi_classes.py), the files its imports take for the target (MSVC's on Windows, the
# Itanium ABI of Android's clang on Android).
if (WIN32)
    set(NVRHI_ABI_OS win32)
else()
    set(NVRHI_ABI_OS linux)
endif()
set(NVRHI_TS_SOURCES core/nvrhi_types.ts core/nvrhi_abi.${NVRHI_ABI_OS}.ts core/nvrhi_classes.${NVRHI_ABI_OS}.ts core/nvrhi.ts)
# tslang has no @cpp struct returns for 32-bit ARM (the Itanium ABI there returns them another
# way than x86-64 and AArch64), so armeabi-v7a has no core/nvrhi.ts: no headless or nvrhi_direct.
if (ANDROID AND CMAKE_ANDROID_ARCH_ABI STREQUAL "armeabi-v7a")
    set(NVRHI_DIRECT_BUILDS OFF)
else()
    set(NVRHI_DIRECT_BUILDS ON)
endif()

# It calls NVRHI directly through core/nvrhi.ts where the build can (MSVC, Android), as headless.cpp
# does, and through Donut's wrappers elsewhere or with -donut: headless.<api> tests the one path,
# headless.donut.<api> the other.
if (NVRHI_DIRECT_BUILDS)
    add_tslang_example(headless ${NVRHI_TS_SOURCES})
endif()
if (NOT ANDROID)
    set(headless_result "[\r\n]+Expected result: [0-9]+, computed result: [0-9]+[\r\n]+Test PASSED")
    if (MSVC)
        set(headless_path "Calling NVRHI directly \\(core/nvrhi\\.ts\\)\\.")
    else()
        set(headless_path "Calling NVRHI through Donut's wrappers\\.")
    endif()
    foreach(api dx12 vk)
        add_test(NAME headless.${api} COMMAND headless -${api} -debug WORKING_DIRECTORY ${CMAKE_RUNTIME_OUTPUT_DIRECTORY})
        set_tests_properties(headless.${api} PROPERTIES PASS_REGULAR_EXPRESSION "${headless_path}${headless_result}"
            LABELS ${api} TIMEOUT 120)
        add_test(NAME headless.donut.${api} COMMAND headless -${api} -debug -donut WORKING_DIRECTORY ${CMAKE_RUNTIME_OUTPUT_DIRECTORY})
        set_tests_properties(headless.donut.${api} PROPERTIES
            PASS_REGULAR_EXPRESSION "Calling NVRHI through Donut's wrappers\\.${headless_result}" LABELS ${api} TIMEOUT 120)
    endforeach()
endif()

# Not a port: a headless test of core/nvrhi.ts, NVRHI's interfaces called directly through their
# vtables (tslang @cpp classes), under MSVC's ABI or Android's (tools/gen_nvrhi_classes.py
# generates both). On Android it runs through adb shell, as headless does. It runs on D3D12 and
# Vulkan, so no DXBC (its bindless test's unbounded array needs shader model 5.1 at least).
donut_compile_shaders(
    TARGET nvrhi_direct_shaders
    PROJECT_NAME "NVRHI Direct"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/nvrhi_direct.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/nvrhi_direct.hlsl ${CMAKE_CURRENT_SOURCE_DIR}/shaders/nvrhi_direct_textured.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/nvrhi_direct_depth.hlsl ${CMAKE_CURRENT_SOURCE_DIR}/shaders/nvrhi_direct_blend.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/nvrhi_direct_push_constants.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/nvrhi_direct_mrt.hlsl ${CMAKE_CURRENT_SOURCE_DIR}/shaders/nvrhi_direct_msaa.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/nvrhi_direct_instanced.hlsl ${CMAKE_CURRENT_SOURCE_DIR}/shaders/nvrhi_direct_texture_uav.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/nvrhi_direct_buffers.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/nvrhi_direct_specialization.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/nvrhi_direct_bindless.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/nvrhi_direct_rt.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/nvrhi_direct/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/nvrhi_direct/spirv
)
# Its mesh shader on its own: SPIR-V's mesh shader extension named (ShaderMake's --spirvExt lists
# the only extensions DXC may use, which the other shaders need others of).
donut_compile_shaders(
    TARGET nvrhi_direct_mesh_shaders
    PROJECT_NAME "NVRHI Direct Mesh"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/nvrhi_direct_mesh.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/nvrhi_direct_mesh.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/nvrhi_direct/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/nvrhi_direct/spirv
    SHADERMAKE_OPTIONS_SPIRV "--spirvExt SPV_EXT_mesh_shader"
)
# And its sampler feedback shader: D3D12 only (FeedbackTexture2D), so DXIL only.
donut_compile_shaders(
    TARGET nvrhi_direct_feedback_shaders
    PROJECT_NAME "NVRHI Direct Feedback"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/nvrhi_direct_feedback.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/nvrhi_direct_feedback.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/nvrhi_direct/dxil
)
if (NVRHI_DIRECT_BUILDS)
    add_tslang_example(nvrhi_direct ${NVRHI_TS_SOURCES})
    add_dependencies(nvrhi_direct nvrhi_direct_mesh_shaders nvrhi_direct_feedback_shaders)
endif()
if (NOT ANDROID)
    add_tslang_example_test(nvrhi_direct)
endif()

# Port of Donut-Samples' rt_triangle. Ray tracing needs D3D12 or Vulkan, so no DXBC.
donut_compile_shaders(
    TARGET rt_triangle_shaders
    PROJECT_NAME "Ray Traced Triangle"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rt_triangle.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rt_triangle.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rt_triangle/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rt_triangle/spirv
)
add_tslang_example(rt_triangle)
add_tslang_example_test(rt_triangle)

# Port of Donut-Samples' vertex_buffer.
donut_compile_shaders_all_platforms(
    TARGET vertex_buffer_shaders
    PROJECT_NAME "Vertex Buffer"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/vertex_buffer.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/vertex_buffer.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/vertex_buffer
)
add_tslang_example(vertex_buffer core/matrix.ts MEDIA nvidia-logo.png)
add_tslang_example_test(vertex_buffer)

# The whole media folder goes next to the executables, at build time so files added to it later are
# picked up without reconfiguring. copy_directory_if_different needs CMake 3.26.
if (CMAKE_VERSION VERSION_GREATER_EQUAL 3.26)
    set(MEDIA_COPY_COMMAND copy_directory_if_different)
else()
    set(MEDIA_COPY_COMMAND copy_directory)
endif()
add_custom_target(copy_media ALL
    COMMAND ${CMAKE_COMMAND} -E ${MEDIA_COPY_COMMAND} "${CMAKE_CURRENT_SOURCE_DIR}/media" "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media"
    COMMENT "Copying media to ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media")

# Port of Donut-Samples' threaded_rendering: no shaders of its own (Donut's forward shading).
# It renders Sponza from Khronos' glTF-Sample-Assets (52 MB, not in this repo); point this at a
# Donut-Samples media folder to have it copied next to the executables, or pass --scene <path>.
set(DONUT_SAMPLES_MEDIA_DIR "" CACHE PATH "Donut-Samples media folder, with glTF-Sample-Assets")
if (DONUT_SAMPLES_MEDIA_DIR)
    file(COPY "${DONUT_SAMPLES_MEDIA_DIR}/glTF-Sample-Assets/Models/Sponza/glTF"
        DESTINATION "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/glTF-Sample-Assets/Models/Sponza")
    # rt_bindless: Sponza plus two animated BrainStem robots.
    file(COPY "${DONUT_SAMPLES_MEDIA_DIR}/glTF-Sample-Assets/Models/BrainStem/glTF"
        DESTINATION "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/glTF-Sample-Assets/Models/BrainStem")
    file(COPY "${DONUT_SAMPLES_MEDIA_DIR}/sponza-plus.scene.json"
        DESTINATION "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media")
    # rt_particles: its scene, environment map and smoke texture.
    file(COPY "${DONUT_SAMPLES_MEDIA_DIR}/rt_particles"
        DESTINATION "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media")
    # feature_demo: its UI fonts. It lists the scenes copied above (sponza-plus.scene.json, its
    # default, Sponza, BrainStem, rt_particles'); pass any other scene file on its command line.
    file(COPY "${DONUT_SAMPLES_MEDIA_DIR}/fonts"
        DESTINATION "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media")
endif()
add_tslang_example(threaded_rendering MEDIA glTF-Sample-Assets/Models/Sponza)
add_tslang_example_test(threaded_rendering)

# Port of Donut-Samples' deferred_shading: no shaders of its own (Donut's G-buffer fill and
# deferred lighting passes); uses media/nvidia-logo.png, copied with the media folder above.
add_tslang_example(deferred_shading core/matrix.ts MEDIA nvidia-logo.png)
add_tslang_example_test(deferred_shading)

# Port of Donut-Samples' rt_shadows: ray traced sun shadows on Sponza (see DONUT_SAMPLES_MEDIA_DIR
# above). Ray tracing needs D3D12 or Vulkan, so no DXBC.
donut_compile_shaders(
    TARGET rt_shadows_shaders
    PROJECT_NAME "Ray Traced Shadows"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rt_shadows.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rt_shadows.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rt_shadows/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rt_shadows/spirv
)
add_tslang_example(rt_shadows core/matrix.ts MEDIA glTF-Sample-Assets/Models/Sponza)
add_tslang_example_test(rt_shadows)

# Port of Donut-Samples' variable_shading: variable rate shading of Sponza (see
# DONUT_SAMPLES_MEDIA_DIR above) from a compute-generated shading rate surface. D3D12 or Vulkan.
donut_compile_shaders(
    TARGET variable_shading_shaders
    PROJECT_NAME "Variable Shading"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/variable_shading.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/variable_shading.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/variable_shading/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/variable_shading/spirv
)
add_tslang_example(variable_shading core/matrix.ts MEDIA glTF-Sample-Assets/Models/Sponza)
add_tslang_example_test(variable_shading)

# Port of Donut-Samples' async_compute: a compute-queue worker thread animates textures that the
# render thread shows.
donut_compile_shaders_all_platforms(
    TARGET async_compute_shaders
    PROJECT_NAME "Async Compute"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/async_compute.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/async_compute.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/async_compute
)
add_tslang_example(async_compute)
add_tslang_example_test(async_compute)

# Port of Vulkan-Samples' compute_nbody: an N-body simulation in two compute passes, drawn as
# additively blended sprites.
donut_compile_shaders_all_platforms(
    TARGET compute_nbody_shaders
    PROJECT_NAME "Compute N-Body"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/compute_nbody.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/compute_nbody.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/compute_nbody
)
add_tslang_example(compute_nbody core/random.ts core/matrix.ts)
add_tslang_example_test(compute_nbody)

# compute_nbody with collisions: a third compute pass makes the particles bounce off each other
# and off the heavy centers.
donut_compile_shaders_all_platforms(
    TARGET compute_nbody_collisions_shaders
    PROJECT_NAME "Compute N-Body Collisions"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/compute_nbody_collisions.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/compute_nbody_collisions.hlsl ${CMAKE_CURRENT_SOURCE_DIR}/shaders/compute_nbody_collisions_post.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/compute_nbody_collisions
)
add_tslang_example(compute_nbody_collisions core/matrix.ts)
add_tslang_example_test(compute_nbody_collisions)
# Two heavy centers head on: their bounce keeps the momentum only if the compute passes, which
# share one binding set, are separated by UAV barriers (patches/nvrhi-uav-barriers-same-binding-set.patch).
add_tslang_example_test(compute_nbody_collisions SUFFIX head_on ARGS -attractors 2 -particles 1)
# Particles touching slower than 2 merge: the survivors absorb the others, keeping the total mass and volume.
add_tslang_example_test(compute_nbody_collisions SUFFIX merge ARGS -merge 2)
# Gravity between all pairs keeps the momentum, and so do the merges of the six heavy centers (-merge 20):
# the test checks the momentum and the angular momentum drifted by little (the merged spin keeps the
# angular momentum: their average drifts it 70 times more).
add_tslang_example_test(compute_nbody_collisions SUFFIX merge_heavy ARGS -fullgravity -attractors 6 -particles 1 -merge 20)
# Particles hit faster than 10 break in two, into room left for half as many again: the test checks
# some did, and the mass, the volume and (gravity between all pairs) the momentum were kept.
add_tslang_example_test(compute_nbody_collisions SUFFIX fragment ARGS -fullgravity -fragment 10 -room 50)
# The energy, with the heat kept: what the bounces, the friction, the springs' damping and the breaks
# lose is heat, so kinetic, potential and heat energy add up to what they started at.
add_tslang_example_test(compute_nbody_collisions SUFFIX energy ARGS -fullgravity -nocool -fragment 10 -room 50)
# And with merging: what a merge loses (motion, spins, the gravity's potential energy, the springs) is
# heat too. (Not with breaking as well: its free slots are taken in whatever order the GPU's atomics
# give, so the runs differ, and now and then one drifts past the limit.)
add_tslang_example_test(compute_nbody_collisions SUFFIX energy_merge ARGS -fullgravity -nocool -merge 2)

# Port of Vulkan-Samples' terrain_tessellation: a heightmap terrain of quad patches, tessellated by
# their size on screen. Its textures (Vulkan-Samples' assets, KTX 1, not in this repo) are converted
# to DDS next to the executables; point this at a Vulkan-Samples assets folder.
set(VULKAN_SAMPLES_ASSETS_DIR "" CACHE PATH "Vulkan-Samples assets folder, with textures/terrain_*.ktx")
# A host tool for those assets: the mip levels the framework generates for the ASTC textures it
# decodes, with the same stb_image_resize (Donut's copy of it), into DDS files.
if (VULKAN_SAMPLES_ASSETS_DIR AND NOT CMAKE_CROSSCOMPILING)
    add_executable(dds_mips tools/dds_mips.cpp)
    target_include_directories(dds_mips PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/external/Donut/thirdparty/stb/deprecated")
elseif (VULKAN_SAMPLES_ASSETS_DIR)
    # Cross-compiling (Android), it runs on this machine: the one a desktop build made, as ShaderMake.
    find_program(DONUT_HOST_DDS_MIPS dds_mips
        HINTS "${CMAKE_CURRENT_SOURCE_DIR}/build-release/bin" "${CMAKE_CURRENT_SOURCE_DIR}/build/bin"
        DOC "dds_mips built for the host (by a desktop build of this project)"
        NO_CMAKE_FIND_ROOT_PATH)
    if (NOT DONUT_HOST_DDS_MIPS)
        message(FATAL_ERROR "No dds_mips for the host, which the media of VULKAN_SAMPLES_ASSETS_DIR need: build "
                            "the desktop preset's (cmake --build --preset release --target dds_mips), "
                            "or set DONUT_HOST_DDS_MIPS")
    endif()
    add_executable(dds_mips IMPORTED GLOBAL)
    set_target_properties(dds_mips PROPERTIES IMPORTED_LOCATION "${DONUT_HOST_DDS_MIPS}")
endif()
donut_compile_shaders_all_platforms(
    TARGET terrain_tessellation_shaders
    PROJECT_NAME "Terrain Tessellation"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/terrain_tessellation.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/terrain_tessellation.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/terrain_tessellation
)
add_tslang_example(terrain_tessellation core/matrix.ts MEDIA terrain_tessellation)
add_tslang_example_test(terrain_tessellation)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(terrain_textures)
    foreach(texture skysphere_rgba terrain_texturearray_rgba terrain_heightmap_r16)
        set(source "${VULKAN_SAMPLES_ASSETS_DIR}/textures/${texture}.ktx")
        set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/terrain_tessellation/${texture}.dds")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${source}" "${output}"
            DEPENDS "${source}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py"
            COMMENT "Converting ${texture}.ktx to DDS"
            VERBATIM)
        list(APPEND terrain_textures "${output}")
    endforeach()
    add_custom_target(terrain_tessellation_media DEPENDS ${terrain_textures})
    add_dependencies(terrain_tessellation terrain_tessellation_media)
endif()

# Port of Vulkan-Samples' instancing: thousands of rocks around a planet in one instanced draw, their
# positions, rotations, scales and texture layers in a per-instance vertex buffer. Its models and
# textures are Vulkan-Samples' assets too (see VULKAN_SAMPLES_ASSETS_DIR above): the glTF files
# are copied, the KTX textures converted to DDS.
donut_compile_shaders_all_platforms(
    TARGET instancing_shaders
    PROJECT_NAME "Instancing"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/instancing.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/instancing.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/instancing
)
add_tslang_example(instancing core/random.ts core/matrix.ts MEDIA instancing)
add_tslang_example_test(instancing)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(instancing_media)
    foreach(texture texturearray_rocks_color_rgba lavaplanet_color_rgba)
        set(source "${VULKAN_SAMPLES_ASSETS_DIR}/textures/${texture}.ktx")
        set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/instancing/${texture}.dds")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${source}" "${output}"
            DEPENDS "${source}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py"
            COMMENT "Converting ${texture}.ktx to DDS"
            VERBATIM)
        list(APPEND instancing_media "${output}")
    endforeach()
    foreach(model rock planet)
        set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/${model}.gltf")
        set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/instancing/${model}.gltf")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
            DEPENDS "${source}"
            COMMENT "Copying ${model}.gltf"
            VERBATIM)
        list(APPEND instancing_media "${output}")
    endforeach()
    add_custom_target(instancing_media DEPENDS ${instancing_media})
    add_dependencies(instancing instancing_media)
endif()

# Port of Vulkan-Samples' hdr: a reflective object in front of an HDR environment cube map, rendered
# to float targets with exposure, then a two-pass bloom of its bright parts. Its models and cube
# map are Vulkan-Samples' assets too (see VULKAN_SAMPLES_ASSETS_DIR above): the glTF files are
# copied, the KTX cube map converted to DDS.
donut_compile_shaders_all_platforms(
    TARGET hdr_shaders
    PROJECT_NAME "HDR"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/hdr.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/hdr.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/hdr
)
add_tslang_example(hdr core/matrix.ts MEDIA hdr)
add_tslang_example_test(hdr)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(source "${VULKAN_SAMPLES_ASSETS_DIR}/textures/uffizi_rgba16f_cube.ktx")
    set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/hdr/uffizi_rgba16f_cube.dds")
    add_custom_command(OUTPUT "${output}"
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${source}" "${output}"
        DEPENDS "${source}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py"
        COMMENT "Converting uffizi_rgba16f_cube.ktx to DDS"
        VERBATIM)
    set(hdr_media "${output}")
    foreach(model cube geosphere teapot torusknot)
        set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/${model}.gltf")
        set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/hdr/${model}.gltf")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
            DEPENDS "${source}"
            COMMENT "Copying ${model}.gltf"
            VERBATIM)
        list(APPEND hdr_media "${output}")
    endforeach()
    add_custom_target(hdr_media DEPENDS ${hdr_media})
    add_dependencies(hdr hdr_media)
endif()

# Port of Vulkan-Samples' calibrated_timestamps: its hdr sample (above: the same shaders, models and
# cube map), with pieces of its code timed by calibrated timestamps of the device's clock
# (VK_EXT_calibrated_timestamps; D3D12's command queue clock calibration), shown in the overlay.
donut_compile_shaders_all_platforms(
    TARGET calibrated_timestamps_shaders
    PROJECT_NAME "Calibrated Timestamps"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/hdr.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/hdr.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/calibrated_timestamps
)
add_tslang_example(calibrated_timestamps core/matrix.ts MEDIA fonts hdr)
if (TARGET hdr_media)
    add_dependencies(calibrated_timestamps hdr_media)
endif()
add_tslang_example_test(calibrated_timestamps)

# Port of Vulkan-Samples' ray_tracing_extended: Sponza ray traced with shadows and ambient
# occlusion, a refracting sheet whose BLAS is updated every frame, and flame particles instanced
# in a TLAS rebuilt every frame. Its scene and textures are Vulkan-Samples' assets too (see
# VULKAN_SAMPLES_ASSETS_DIR above): the glTF scene is copied, its ASTC textures decoded to DDS and
# the flame's KTX 2 texture converted. Ray tracing needs D3D12 or Vulkan, so no DXBC.
donut_compile_shaders(
    TARGET ray_tracing_extended_shaders
    PROJECT_NAME "Ray Tracing Extended"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/ray_tracing_extended.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/ray_tracing_extended.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/ray_tracing_extended/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/ray_tracing_extended/spirv
)
add_tslang_example(ray_tracing_extended core/random.ts core/ray_tracing_extended_scene.ts core/matrix.ts MEDIA ray_tracing_extended)
add_tslang_example_test(ray_tracing_extended)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(sponza_source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/sponza")
    set(ray_tracing_extended_output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/ray_tracing_extended")
    set(ray_tracing_extended_media)
    foreach(file Sponza01.gltf Sponza01.bin)
        set(output "${ray_tracing_extended_output}/sponza/${file}")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${sponza_source}/${file}" "${output}"
            DEPENDS "${sponza_source}/${file}"
            COMMENT "Copying ${file}"
            VERBATIM)
        list(APPEND ray_tracing_extended_media "${output}")
    endforeach()
    # The scene's base color textures, and the flame's.
    set(sources)
    set(outputs)
    foreach(name background chain_texture lion spnza_bricks_a_diff sponza_arch_diff sponza_ceiling_a_diff
            sponza_column_a_diff sponza_column_b_diff sponza_column_c_diff sponza_curtain_blue_diff
            sponza_curtain_diff sponza_curtain_green_diff sponza_details_diff sponza_fabric_blue_diff
            sponza_fabric_diff sponza_fabric_green_diff sponza_flagpole_diff sponza_floor_a_diff sponza_roof_diff
            sponza_thorn_diff vase_dif vase_hanging vase_plant vase_round)
        list(APPEND sources "${sponza_source}/${name}.ktx")
        list(APPEND outputs "${ray_tracing_extended_output}/sponza/${name}.dds")
    endforeach()
    list(APPEND sources "${VULKAN_SAMPLES_ASSETS_DIR}/textures/generated_flame.ktx")
    list(APPEND outputs "${ray_tracing_extended_output}/generated_flame.dds")
    foreach(source output IN ZIP_LISTS sources outputs)
        get_filename_component(name "${source}" NAME)
        add_custom_command(OUTPUT "${output}"
            COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${source}" "${output}"
            DEPENDS "${source}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${CMAKE_CURRENT_SOURCE_DIR}/tools/astc.py"
            COMMENT "Converting ${name} to DDS"
            VERBATIM)
        list(APPEND ray_tracing_extended_media "${output}")
    endforeach()
    add_custom_target(ray_tracing_extended_media DEPENDS ${ray_tracing_extended_media})
    add_dependencies(ray_tracing_extended ray_tracing_extended_media)
endif()

# Port of Vulkan-Samples' multi_draw_indirect: 225 meshes drawn by one indirect draw call, culled on
# the CPU or by a compute shader that writes the draws' instance counts. Its scene is Vulkan-Samples'
# assets too (see VULKAN_SAMPLES_ASSETS_DIR above): the glTF scene is copied and the meshes' KTX
# textures (named after them, 0000_0000 .. 0014_0014) converted to DDS. The textures are one array
# of 225, more than D3D11 has slots for, so no DXBC.
donut_compile_shaders(
    TARGET multi_draw_indirect_shaders
    PROJECT_NAME "Multi-Draw Indirect"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/multi_draw_indirect.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/multi_draw_indirect.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/multi_draw_indirect/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/multi_draw_indirect/spirv
)
add_tslang_example(multi_draw_indirect core/matrix.ts MEDIA multi_draw_indirect)
add_tslang_example_test(multi_draw_indirect)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(vokselia_source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/vokselia")
    set(vokselia_output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/multi_draw_indirect/vokselia")
    add_custom_command(OUTPUT "${vokselia_output}/vokselia.gltf"
        COMMAND "${CMAKE_COMMAND}" -E copy "${vokselia_source}/vokselia.gltf" "${vokselia_output}/vokselia.gltf"
        DEPENDS "${vokselia_source}/vokselia.gltf"
        COMMENT "Copying vokselia.gltf"
        VERBATIM)
    # One conversion for all the textures: a Python process each would take longer than the work.
    set(sources)
    set(outputs)
    set(arguments)
    foreach(row RANGE 14)
        foreach(column RANGE 14)
            set(name "000${row}_000${column}")
            string(REGEX REPLACE "0+([0-9][0-9][0-9][0-9])" "\\1" name "${name}")
            list(APPEND sources "${vokselia_source}/${name}.ktx")
            list(APPEND outputs "${vokselia_output}/${name}.dds")
            list(APPEND arguments "${vokselia_source}/${name}.ktx" "${vokselia_output}/${name}.dds")
        endforeach()
    endforeach()
    # 225 of them: their paths, in a file, as on a command line they would pass Windows' limit.
    string(JOIN "
" vokselia_list ${arguments})
    file(CONFIGURE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/vokselia_ktx_to_dds.txt" CONTENT "${vokselia_list}
" @ONLY)
    add_custom_command(OUTPUT ${outputs}
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "@${CMAKE_CURRENT_BINARY_DIR}/vokselia_ktx_to_dds.txt"
        DEPENDS ${sources} "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${CMAKE_CURRENT_SOURCE_DIR}/tools/astc.py"
            "${CMAKE_CURRENT_BINARY_DIR}/vokselia_ktx_to_dds.txt"
        COMMENT "Converting the vokselia textures to DDS"
        VERBATIM)
    add_custom_target(multi_draw_indirect_media DEPENDS "${vokselia_output}/vokselia.gltf" ${outputs})
    add_dependencies(multi_draw_indirect multi_draw_indirect_media)
endif()

# Port of Vulkan-Samples' async_compute (named apart from Donut-Samples' async_compute above): a
# shadow map and a 4K HDR forward pass of the Bonza scene, a bloom in compute shaders (on the
# compute queue with async queues on), and a tone mapping composite. Its scene is Vulkan-Samples'
# assets too (see VULKAN_SAMPLES_ASSETS_DIR above): the glTF scene is copied and its base color
# textures (KTX 2 ASTC) decoded to DDS.
donut_compile_shaders_all_platforms(
    TARGET async_compute_bloom_shaders
    PROJECT_NAME "Async Compute Bloom"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/async_compute_bloom.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/async_compute_bloom.hlsl ${CMAKE_CURRENT_SOURCE_DIR}/shaders/async_compute_bloom_post.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/async_compute_bloom
)
add_tslang_example(async_compute_bloom core/matrix.ts MEDIA async_compute_bloom)
add_tslang_example_test(async_compute_bloom)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(bonza_source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/bonza")
    set(bonza_output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/async_compute_bloom/bonza")
    set(async_compute_bloom_media)
    foreach(file Bonza.gltf Bonza.bin)
        set(output "${bonza_output}/${file}")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${bonza_source}/${file}" "${output}"
            DEPENDS "${bonza_source}/${file}"
            COMMENT "Copying ${file}"
            VERBATIM)
        list(APPEND async_compute_bloom_media "${output}")
    endforeach()
    # The scene's base color textures, in one conversion: it decodes them in parallel. Then their
    # mip levels, which the framework generates for the ASTC textures it decodes (see
    # tools/dds_mips.cpp).
    set(sources)
    set(outputs)
    set(arguments)
    foreach(name SM_1MPlane_DefaultMaterial_BaseColor T_AtriumCrossStruts_D T_Banner_D T_Carpet_D T_CenterStatue_D
            T_ConcreteFloor_D T_Door_D T_FireEx_D T_Gray01 T_MetalBitsMerged_Part01_D T_Metal_Pillar_01_D T_Panel02_D
            T_Pillar_Tall_D T_Plant_D T_Plate_D T_Sofa_Long_D T_Statue_D T_Steel_D T_TrimAtlas01_D T_Trim_01 T_Wall2_D
            T_Wall_D T_Wall_RandomCrossStruts_D)
        list(APPEND sources "${bonza_source}/${name}.ktx")
        list(APPEND outputs "${bonza_output}/${name}.dds")
        list(APPEND arguments "${bonza_source}/${name}.ktx" "${bonza_output}/${name}.dds")
    endforeach()
    add_custom_command(OUTPUT ${outputs}
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" ${arguments}
        COMMAND dds_mips ${outputs}
        DEPENDS ${sources} "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${CMAKE_CURRENT_SOURCE_DIR}/tools/astc.py" dds_mips
        COMMENT "Decoding the Bonza textures to DDS"
        VERBATIM)
    add_custom_target(async_compute_bloom_media DEPENDS ${async_compute_bloom_media} ${outputs})
    add_dependencies(async_compute_bloom async_compute_bloom_media)
endif()

# Port of Vulkan-Samples' oit_linked_lists: order-independent transparency, the fragments of 64
# transparent spheres gathered into per-pixel linked lists by their pixel shaders (atomics on a
# UAV texture and a counter), then sorted and blended over a background. Its model and texture are
# Vulkan-Samples' assets too (see VULKAN_SAMPLES_ASSETS_DIR above): the glTF file is copied, the KTX
# texture converted to DDS.
donut_compile_shaders_all_platforms(
    TARGET oit_linked_lists_shaders
    PROJECT_NAME "OIT Linked Lists"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/oit_linked_lists.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/oit_linked_lists.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/oit_linked_lists
)
add_tslang_example(oit_linked_lists core/random.ts core/matrix.ts MEDIA oit_linked_lists)
add_tslang_example_test(oit_linked_lists)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(oit_linked_lists_output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/oit_linked_lists")
    set(source "${VULKAN_SAMPLES_ASSETS_DIR}/textures/vulkan_logo_full.ktx")
    set(output "${oit_linked_lists_output}/vulkan_logo_full.dds")
    add_custom_command(OUTPUT "${output}"
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${source}" "${output}"
        DEPENDS "${source}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py"
        COMMENT "Converting vulkan_logo_full.ktx to DDS"
        VERBATIM)
    set(oit_linked_lists_media "${output}")
    set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/geosphere.gltf")
    set(output "${oit_linked_lists_output}/geosphere.gltf")
    add_custom_command(OUTPUT "${output}"
        COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
        DEPENDS "${source}"
        COMMENT "Copying geosphere.gltf"
        VERBATIM)
    list(APPEND oit_linked_lists_media "${output}")
    add_custom_target(oit_linked_lists_media DEPENDS ${oit_linked_lists_media})
    add_dependencies(oit_linked_lists oit_linked_lists_media)
endif()

# Port of Vulkan-Samples' gshader_to_mshader: a model's normals drawn by a geometry shader, or by a
# mesh shader over meshlets. The mesh shader has a file of its own, without DXBC: D3D11 has no mesh
# shaders. The model is Vulkan-Samples' (see VULKAN_SAMPLES_ASSETS_DIR above), copied.
donut_compile_shaders_all_platforms(
    TARGET gshader_to_mshader_shaders
    PROJECT_NAME "Geometry Shader to Mesh Shader"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/gshader_to_mshader.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/gshader_to_mshader.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/gshader_to_mshader
)
donut_compile_shaders(
    TARGET gshader_to_mshader_mesh_shaders
    PROJECT_NAME "Geometry Shader to Mesh Shader"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/gshader_to_mshader_mesh.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/gshader_to_mshader_mesh.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/gshader_to_mshader/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/gshader_to_mshader/spirv
    SHADERMAKE_OPTIONS_SPIRV "--spirvExt SPV_EXT_mesh_shader"
)
add_tslang_example(gshader_to_mshader core/matrix.ts MEDIA gshader_to_mshader)
add_tslang_example_test(gshader_to_mshader)
add_dependencies(gshader_to_mshader gshader_to_mshader_mesh_shaders)
if (VULKAN_SAMPLES_ASSETS_DIR)
    set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/teapot.gltf")
    set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/gshader_to_mshader/teapot.gltf")
    add_custom_command(OUTPUT "${output}"
        COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
        DEPENDS "${source}"
        COMMENT "Copying teapot.gltf"
        VERBATIM)
    add_custom_target(gshader_to_mshader_media DEPENDS "${output}")
    add_dependencies(gshader_to_mshader gshader_to_mshader_media)
endif()

# Port of Vulkan-Samples' sparse_image: a large texture on a plane, its pages mapped to memory and
# filled (level 0 from CPU-side data, the others from the level above) as the view needs them.
# Tiled textures: D3D12 and Vulkan only, so no DXBC. The texture is Vulkan-Samples' (see
# VULKAN_SAMPLES_ASSETS_DIR above), converted to DDS.
donut_compile_shaders(
    TARGET sparse_image_shaders
    PROJECT_NAME "Sparse Image"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/sparse_image.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/sparse_image.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/sparse_image/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/sparse_image/spirv
)
add_tslang_example(sparse_image core/matrix.ts MEDIA sparse_image)
add_tslang_example_test(sparse_image)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(source "${VULKAN_SAMPLES_ASSETS_DIR}/textures/vulkan_logo_full.ktx")
    set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/sparse_image/vulkan_logo_full.dds")
    add_custom_command(OUTPUT "${output}"
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${source}" "${output}"
        DEPENDS "${source}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py"
        COMMENT "Converting vulkan_logo_full.ktx to DDS"
        VERBATIM)
    add_custom_target(sparse_image_media DEPENDS "${output}")
    add_dependencies(sparse_image sparse_image_media)
endif()

# Port of Vulkan-Samples' mesh_shader_culling: task (amplification) shaders cull the sub-rects of a
# square against a circle and launch mesh shaders for those kept, with the pipeline statistics of
# the draw. D3D11 has no mesh shaders, so no DXBC.
donut_compile_shaders(
    TARGET mesh_shader_culling_shaders
    PROJECT_NAME "Mesh Shader Culling"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/mesh_shader_culling.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/mesh_shader_culling.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/mesh_shader_culling/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/mesh_shader_culling/spirv
    SHADERMAKE_OPTIONS_SPIRV "--spirvExt SPV_EXT_mesh_shader"
)
add_tslang_example(mesh_shader_culling)
add_tslang_example_test(mesh_shader_culling)

# Port of Vulkan-Samples' conservative_rasterization: a triangle drawn at low resolution with and
# without conservative rasterization, stretched over the screen, its real outline over it.
donut_compile_shaders_all_platforms(
    TARGET conservative_rasterization_shaders
    PROJECT_NAME "Conservative Rasterization"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/conservative_rasterization.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/conservative_rasterization.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/conservative_rasterization
)
add_tslang_example(conservative_rasterization core/matrix.ts)
add_tslang_example_test(conservative_rasterization)

# Port of Vulkan-Samples' conditional_rendering: each node of a glTF model drawn or skipped by a
# value in a buffer the GPU reads as it executes the draws (D3D12 predication, Vulkan
# VK_EXT_conditional_rendering). Its model is Vulkan-Samples' (see VULKAN_SAMPLES_ASSETS_DIR above),
# copied.
donut_compile_shaders_all_platforms(
    TARGET conditional_rendering_shaders
    PROJECT_NAME "Conditional Rendering"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/conditional_rendering.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/conditional_rendering.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/conditional_rendering
)
add_tslang_example(conditional_rendering core/matrix.ts MEDIA conditional_rendering)
add_tslang_example_test(conditional_rendering)
if (VULKAN_SAMPLES_ASSETS_DIR)
    set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/Buggy/glTF-Embedded/Buggy.gltf")
    set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/conditional_rendering/Buggy.gltf")
    add_custom_command(OUTPUT "${output}"
        COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
        DEPENDS "${source}"
        COMMENT "Copying Buggy.gltf"
        VERBATIM)
    add_custom_target(conditional_rendering_media DEPENDS "${output}")
    add_dependencies(conditional_rendering conditional_rendering_media)
endif()

# Port of Vulkan-Samples' rasterization_order_attachment_access: transparent spheres blended in the
# pixel shader over what it reads at the pixel, overlapping fragments of one draw ordered by
# rasterizer ordered views (D3D's ROVs, Vulkan's fragment shader interlock), or each sphere drawn
# alone with a barrier after it. Its model and texture are Vulkan-Samples' (see
# VULKAN_SAMPLES_ASSETS_DIR above): the glTF file copied, the KTX texture converted to DDS.
donut_compile_shaders_all_platforms(
    TARGET rasterization_order_attachment_access_shaders
    PROJECT_NAME "Rasterization Order Attachment Access"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rasterization_order_attachment_access.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rasterization_order_attachment_access.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rasterization_order_attachment_access
    SHADERMAKE_OPTIONS_SPIRV "--spirvExt SPV_EXT_fragment_shader_interlock"
)
add_tslang_example(rasterization_order_attachment_access core/random.ts core/matrix.ts MEDIA rasterization_order_attachment_access)
add_tslang_example_test(rasterization_order_attachment_access)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(roaa_output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/rasterization_order_attachment_access")
    set(source "${VULKAN_SAMPLES_ASSETS_DIR}/textures/vulkan_logo_full.ktx")
    set(output "${roaa_output}/vulkan_logo_full.dds")
    add_custom_command(OUTPUT "${output}"
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${source}" "${output}"
        DEPENDS "${source}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py"
        COMMENT "Converting vulkan_logo_full.ktx to DDS"
        VERBATIM)
    set(roaa_media "${output}")
    set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/geosphere.gltf")
    set(output "${roaa_output}/geosphere.gltf")
    add_custom_command(OUTPUT "${output}"
        COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
        DEPENDS "${source}"
        COMMENT "Copying geosphere.gltf"
        VERBATIM)
    list(APPEND roaa_media "${output}")
    add_custom_target(rasterization_order_attachment_access_media DEPENDS ${roaa_media})
    add_dependencies(rasterization_order_attachment_access rasterization_order_attachment_access_media)
endif()

# Port of Vulkan-Samples' fragment_shader_barycentric: a cube in front of a skybox, its pixel shader
# reading its barycentrics and the triangle's vertex colors (SV_Barycentrics, GetAttributeAtVertex:
# shader model 6.1, so no DXBC). Its models and textures are Vulkan-Samples' (see
# VULKAN_SAMPLES_ASSETS_DIR above): the glTF files copied, the KTX textures converted to DDS.
donut_compile_shaders(
    TARGET fragment_shader_barycentric_shaders
    PROJECT_NAME "Fragment Shader Barycentric"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/fragment_shader_barycentric.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/fragment_shader_barycentric.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/fragment_shader_barycentric/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/fragment_shader_barycentric/spirv
)
add_tslang_example(fragment_shader_barycentric core/matrix.ts MEDIA fragment_shader_barycentric)
add_tslang_example_test(fragment_shader_barycentric)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(barycentric_output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/fragment_shader_barycentric")
    set(barycentric_media "")
    foreach(texture uffizi_rgba16f_cube checkerboard_rgba)
        set(source "${VULKAN_SAMPLES_ASSETS_DIR}/textures/${texture}.ktx")
        set(output "${barycentric_output}/${texture}.dds")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${source}" "${output}"
            DEPENDS "${source}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py"
            COMMENT "Converting ${texture}.ktx to DDS"
            VERBATIM)
        list(APPEND barycentric_media "${output}")
    endforeach()
    foreach(model cube textured_unit_cube)
        set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/${model}.gltf")
        set(output "${barycentric_output}/${model}.gltf")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
            DEPENDS "${source}"
            COMMENT "Copying ${model}.gltf"
            VERBATIM)
        list(APPEND barycentric_media "${output}")
    endforeach()
    add_custom_target(fragment_shader_barycentric_media DEPENDS ${barycentric_media})
    add_dependencies(fragment_shader_barycentric fragment_shader_barycentric_media)
endif()

# Port of Vulkan-Samples' 16bit_arithmetic: a compute shader rendering blobs in FP32, or in FP16 with
# native 16-bit types (shader model 6.2: DXIL and SPIR-V only, in a file of their own, so the FP32
# path runs on D3D11 too).
donut_compile_shaders_all_platforms(
    TARGET 16bit_arithmetic_shaders
    PROJECT_NAME "16-bit Arithmetic"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/16bit_arithmetic.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/16bit_arithmetic.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/16bit_arithmetic
)
donut_compile_shaders(
    TARGET 16bit_arithmetic_fp16_shaders
    PROJECT_NAME "16-bit Arithmetic (FP16)"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/16bit_arithmetic_fp16.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/16bit_arithmetic_fp16.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/16bit_arithmetic/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/16bit_arithmetic/spirv
)
add_tslang_example(16bit_arithmetic)
add_tslang_example_test(16bit_arithmetic)
add_dependencies(16bit_arithmetic 16bit_arithmetic_fp16_shaders)

# Port of Vulkan-Samples' compute_shader_derivatives: a compute shader taking derivatives of a
# procedural pattern (shader model 6.6, so no DXBC) to draw its edges.
donut_compile_shaders(
    TARGET compute_shader_derivatives_shaders
    PROJECT_NAME "Compute Shader Derivatives"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/compute_shader_derivatives.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/compute_shader_derivatives.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/compute_shader_derivatives/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/compute_shader_derivatives/spirv
    SHADER_MODEL 6_6
)
add_tslang_example(compute_shader_derivatives)
add_tslang_example_test(compute_shader_derivatives)

# Port of Vulkan-Samples' logic_op_dynamic_state: a cube combined with the background by a logic
# operation picked in the UI (an NVRHI patch adds them, see DONUT_NVRHI_PATCHES above). Its model
# and cube map are Vulkan-Samples' (see VULKAN_SAMPLES_ASSETS_DIR above): the glTF file copied, the
# KTX cube map converted to DDS.
donut_compile_shaders_all_platforms(
    TARGET logic_op_dynamic_state_shaders
    PROJECT_NAME "Logic Operations Dynamic State"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/logic_op_dynamic_state.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/logic_op_dynamic_state.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/logic_op_dynamic_state
)
add_tslang_example(logic_op_dynamic_state core/matrix.ts MEDIA logic_op_dynamic_state)
add_tslang_example_test(logic_op_dynamic_state)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(logic_op_output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/logic_op_dynamic_state")
    set(source "${VULKAN_SAMPLES_ASSETS_DIR}/textures/uffizi_rgba16f_cube.ktx")
    set(output "${logic_op_output}/uffizi_rgba16f_cube.dds")
    add_custom_command(OUTPUT "${output}"
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${source}" "${output}"
        DEPENDS "${source}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py"
        COMMENT "Converting uffizi_rgba16f_cube.ktx to DDS"
        VERBATIM)
    set(logic_op_media "${output}")
    set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/cube.gltf")
    set(output "${logic_op_output}/cube.gltf")
    add_custom_command(OUTPUT "${output}"
        COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
        DEPENDS "${source}"
        COMMENT "Copying cube.gltf"
        VERBATIM)
    list(APPEND logic_op_media "${output}")
    add_custom_target(logic_op_dynamic_state_media DEPENDS ${logic_op_media})
    add_dependencies(logic_op_dynamic_state logic_op_dynamic_state_media)
endif()

# Port of Vulkan-Samples' oit_depth_peeling: order-independent transparency by depth peeling, up to 8
# layers combined over a background. Its model and texture are Vulkan-Samples' (see
# VULKAN_SAMPLES_ASSETS_DIR above): the glTF file copied, the KTX texture converted to DDS.
donut_compile_shaders_all_platforms(
    TARGET oit_depth_peeling_shaders
    PROJECT_NAME "OIT Depth Peeling"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/oit_depth_peeling.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/oit_depth_peeling.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/oit_depth_peeling
)
add_tslang_example(oit_depth_peeling core/matrix.ts MEDIA oit_depth_peeling)
add_tslang_example_test(oit_depth_peeling)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(depth_peeling_output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/oit_depth_peeling")
    set(source "${VULKAN_SAMPLES_ASSETS_DIR}/textures/vulkan_logo_full.ktx")
    set(output "${depth_peeling_output}/vulkan_logo_full.dds")
    add_custom_command(OUTPUT "${output}"
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${source}" "${output}"
        DEPENDS "${source}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py"
        COMMENT "Converting vulkan_logo_full.ktx to DDS"
        VERBATIM)
    set(depth_peeling_media "${output}")
    set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/torusknot.gltf")
    set(output "${depth_peeling_output}/torusknot.gltf")
    add_custom_command(OUTPUT "${output}"
        COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
        DEPENDS "${source}"
        COMMENT "Copying torusknot.gltf"
        VERBATIM)
    list(APPEND depth_peeling_media "${output}")
    add_custom_target(oit_depth_peeling_media DEPENDS ${depth_peeling_media})
    add_dependencies(oit_depth_peeling oit_depth_peeling_media)
endif()

# Port of Vulkan-Samples' render_octomap: a SLAM map as an octomap (instanced voxels), a glTF mesh
# and Gaussian splats. Its map files are Vulkan-Samples' (see VULKAN_SAMPLES_ASSETS_DIR above),
# copied.
donut_compile_shaders_all_platforms(
    TARGET render_octomap_shaders
    PROJECT_NAME "Render Octomap"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/render_octomap.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/render_octomap.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/render_octomap
)
add_tslang_example(render_octomap core/matrix.ts MEDIA render_octomap)
add_tslang_example_test(render_octomap)
if (VULKAN_SAMPLES_ASSETS_DIR)
    set(octomap_source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/octmap_and_splats")
    file(GLOB octomap_files RELATIVE "${octomap_source}" "${octomap_source}/*.bin" "${octomap_source}/*.gltf")
    set(octomap_media "")
    foreach(name ${octomap_files})
        set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/render_octomap/${name}")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${octomap_source}/${name}" "${output}"
            DEPENDS "${octomap_source}/${name}"
            COMMENT "Copying ${name}"
            VERBATIM)
        list(APPEND octomap_media "${output}")
    endforeach()
    add_custom_target(render_octomap_media DEPENDS ${octomap_media})
    add_dependencies(render_octomap render_octomap_media)
endif()

# Port of Vulkan-Samples' ray_tracing_invocation_reorder: ray_tracing_extended's scene with shader
# execution reordering of the primary rays (shader model 6.9's hit objects; Vulkan's
# SPV_NV_shader_invocation_reorder as inline SPIR-V), and a hit group per material. Ray tracing
# needs D3D12 or Vulkan, so no DXBC. Its scene and textures are ray_tracing_extended's (see there).
donut_compile_shaders(
    TARGET ray_tracing_invocation_reorder_shaders
    PROJECT_NAME "Ray Tracing Invocation Reorder"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/ray_tracing_invocation_reorder.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/ray_tracing_invocation_reorder.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/ray_tracing_invocation_reorder/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/ray_tracing_invocation_reorder/spirv
)
# Hit objects are shader model 6.9: the Agility SDK runtime on D3D12 (the OS's may not have it).
if (NVRHI_WITH_DX12)
    add_tslang_example(ray_tracing_invocation_reorder core/random.ts core/ray_tracing_extended_scene.ts core/matrix.ts core/d3d12_agility_sdk.cpp)
else()
    add_tslang_example(ray_tracing_invocation_reorder core/random.ts core/matrix.ts core/ray_tracing_extended_scene.ts MEDIA ray_tracing_extended)
endif()
add_tslang_example_test(ray_tracing_invocation_reorder)
if (TARGET ray_tracing_extended_media)
    add_dependencies(ray_tracing_invocation_reorder ray_tracing_extended_media)
endif()

# Port of Vulkan-Samples' msaa: the Space Module scene forward shaded with or without
# multisampling, its color (and, before an outline post-processing pass, depth) resolved by the
# render pass (Vulkan) or in a separate pass. Its scene is Vulkan-Samples' assets too (see
# VULKAN_SAMPLES_ASSETS_DIR above): the glTF scene is copied and its base color textures (KTX 1
# ASTC) decoded to DDS, with the mip levels the framework generates for them.
donut_compile_shaders_all_platforms(
    TARGET msaa_shaders
    PROJECT_NAME "MSAA"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/msaa.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/msaa.hlsl ${CMAKE_CURRENT_SOURCE_DIR}/shaders/msaa_post.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/msaa
)
add_tslang_example(msaa core/matrix.ts MEDIA msaa)
add_tslang_example_test(msaa)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(space_module_source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/space_module")
    set(space_module_output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/msaa/space_module")
    set(msaa_media)
    foreach(file SpaceModule.gltf SpaceModule.bin)
        set(output "${space_module_output}/${file}")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${space_module_source}/${file}" "${output}"
            DEPENDS "${space_module_source}/${file}"
            COMMENT "Copying ${file}"
            VERBATIM)
        list(APPEND msaa_media "${output}")
    endforeach()
    # The scene's base color textures, in one conversion (in parallel), then their mip levels (see
    # tools/dds_mips.cpp).
    set(sources)
    set(outputs)
    set(arguments)
    foreach(name T_CylinderRoom T_Metal_D T_Glass_D T_ScreenUIV2 T_Pedestal_D T_Phone_D T_CircuitBoardV2_LowerRes)
        list(APPEND sources "${space_module_source}/${name}.ktx")
        list(APPEND outputs "${space_module_output}/${name}.dds")
        list(APPEND arguments "${space_module_source}/${name}.ktx" "${space_module_output}/${name}.dds")
    endforeach()
    add_custom_command(OUTPUT ${outputs}
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" ${arguments}
        COMMAND dds_mips ${outputs}
        DEPENDS ${sources} "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${CMAKE_CURRENT_SOURCE_DIR}/tools/astc.py" dds_mips
        COMMENT "Decoding the Space Module textures to DDS"
        VERBATIM)
    add_custom_target(msaa_media DEPENDS ${msaa_media} ${outputs})
    add_dependencies(msaa msaa_media)
endif()

# Port of Vulkan-Samples' dynamic_blending: two overlapping faces blended by a blend state set in
# the UI (the sample's dynamic state is a pipeline per combination here): blending on or off, its
# operations and factors, Vulkan's advanced blend operations, and each face's color write mask.
donut_compile_shaders_all_platforms(
    TARGET dynamic_blending_shaders
    PROJECT_NAME "Dynamic Blending"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dynamic_blending.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dynamic_blending.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/dynamic_blending
)
add_tslang_example(dynamic_blending core/vulkan_samples_camera.ts core/matrix.ts core/text_format.ts)
add_tslang_example_test(dynamic_blending)

# Port of Vulkan-Samples' texture_mipmap_generation: a texture's mip chain generated on the GPU from
# its first level, and a tunnel sampled through it without mip maps, with them, and with
# anisotropic filtering. Its model and texture are Vulkan-Samples' assets too (see
# VULKAN_SAMPLES_ASSETS_DIR above): the glTF file is copied, the KTX texture converted to DDS.
donut_compile_shaders_all_platforms(
    TARGET texture_mipmap_generation_shaders
    PROJECT_NAME "Texture MipMap Generation"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/texture_mipmap_generation.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/texture_mipmap_generation.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/texture_mipmap_generation
)
add_tslang_example(texture_mipmap_generation core/matrix.ts MEDIA texture_mipmap_generation)
add_tslang_example_test(texture_mipmap_generation)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(mipmap_output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/texture_mipmap_generation")
    set(source "${VULKAN_SAMPLES_ASSETS_DIR}/textures/checkerboard_rgba.ktx")
    set(output "${mipmap_output}/checkerboard_rgba.dds")
    add_custom_command(OUTPUT "${output}"
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${source}" "${output}"
        DEPENDS "${source}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py"
        COMMENT "Converting checkerboard_rgba.ktx to DDS"
        VERBATIM)
    set(mipmap_media "${output}")
    set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/tunnel_cylinder.gltf")
    set(output "${mipmap_output}/tunnel_cylinder.gltf")
    add_custom_command(OUTPUT "${output}"
        COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
        DEPENDS "${source}"
        COMMENT "Copying tunnel_cylinder.gltf"
        VERBATIM)
    list(APPEND mipmap_media "${output}")
    add_custom_target(texture_mipmap_generation_media DEPENDS ${mipmap_media})
    add_dependencies(texture_mipmap_generation texture_mipmap_generation_media)
endif()

# Port of Vulkan-Samples' ray_tracing_position_fetch: a robot ray traced, its closest hit shader
# reading the hit triangles' vertex positions from the acceleration structure. Vulkan only
# (VK_KHR_ray_tracing_position_fetch; D3D12 has it through NVAPI only), so SPIR-V only. Its scene is
# Vulkan-Samples' assets too (see VULKAN_SAMPLES_ASSETS_DIR above), copied.
donut_compile_shaders(
    TARGET ray_tracing_position_fetch_shaders
    PROJECT_NAME "Ray Tracing Position Fetch"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/ray_tracing_position_fetch.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/ray_tracing_position_fetch.hlsl
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/ray_tracing_position_fetch/spirv
)
add_tslang_example(ray_tracing_position_fetch core/matrix.ts MEDIA ray_tracing_position_fetch)
add_tslang_example_test(ray_tracing_position_fetch APIS vk)
if (VULKAN_SAMPLES_ASSETS_DIR)
    set(position_fetch_media)
    foreach(file scene.gltf scene.bin)
        set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/pica_pica_robot/${file}")
        set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/ray_tracing_position_fetch/pica_pica_robot/${file}")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
            DEPENDS "${source}"
            COMMENT "Copying pica_pica_robot/${file}"
            VERBATIM)
        list(APPEND position_fetch_media "${output}")
    endforeach()
    add_custom_target(ray_tracing_position_fetch_media DEPENDS ${position_fetch_media})
    add_dependencies(ray_tracing_position_fetch ray_tracing_position_fetch_media)
endif()

# Port of Vulkan-Samples' fragment_shading_rate_dynamic: a scene drawn with a shading rate image
# that a compute shader makes each frame from the scene's frequency content (its colors'
# screen-space derivatives, from a reduced size pass). Variable rate shading with shading rate
# images needs D3D12 or Vulkan, so no DXBC. Its models and textures are Vulkan-Samples' assets too
# (see VULKAN_SAMPLES_ASSETS_DIR above): the glTF files are copied, the KTX textures converted to DDS.
donut_compile_shaders(
    TARGET fragment_shading_rate_dynamic_shaders
    PROJECT_NAME "Dynamic Fragment Shading Rate"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/fragment_shading_rate_dynamic.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/fragment_shading_rate_dynamic.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/fragment_shading_rate_dynamic_compute.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/fragment_shading_rate_dynamic/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/fragment_shading_rate_dynamic/spirv
)
add_tslang_example(fragment_shading_rate_dynamic core/vulkan_samples_camera.ts core/matrix.ts MEDIA fragment_shading_rate_dynamic)
add_tslang_example_test(fragment_shading_rate_dynamic)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(shading_rate_output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/fragment_shading_rate_dynamic")
    set(shading_rate_media)
    foreach(texture skysphere_rgba vulkan_logo_full)
        set(source "${VULKAN_SAMPLES_ASSETS_DIR}/textures/${texture}.ktx")
        set(output "${shading_rate_output}/${texture}.dds")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${source}" "${output}"
            DEPENDS "${source}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py"
            COMMENT "Converting ${texture}.ktx to DDS"
            VERBATIM)
        list(APPEND shading_rate_media "${output}")
    endforeach()
    foreach(model geosphere textured_unit_cube)
        set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/${model}.gltf")
        set(output "${shading_rate_output}/${model}.gltf")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
            DEPENDS "${source}"
            COMMENT "Copying ${model}.gltf"
            VERBATIM)
        list(APPEND shading_rate_media "${output}")
    endforeach()
    add_custom_target(fragment_shading_rate_dynamic_media DEPENDS ${shading_rate_media})
    add_dependencies(fragment_shading_rate_dynamic fragment_shading_rate_dynamic_media)
endif()

# Port of Vulkan-Samples' texture_compression_comparison: Sponza with its textures transcoded at
# load time from Basis Universal KTX 2 files (UASTC, Zstandard supercompressed) into the format
# picked: RGBA8, BC7 or BC3 (ASTC and ETC2 where the GPU has them and NVRHI the formats), timed. The
# transcoding is Basis Universal's own transcoder (BASIS_UNIVERSAL_FETCH_TAG), fetched at configure
# time and linked into this example only, through core/basis_transcoder.cpp. Its scene is
# Vulkan-Samples' assets too (see VULKAN_SAMPLES_ASSETS_DIR above): the glTF scene and the KTX 2
# textures are copied. Its shaders are msaa's (the framework's base.vert and base.frag).
set(BASIS_UNIVERSAL_FETCH_TAG "v1_60" CACHE STRING "Git tag of Basis Universal, whose transcoder texture_compression_comparison uses")
include(FetchContent)
FetchContent_Declare(basis_universal
    GIT_REPOSITORY https://github.com/BinomialLLC/basis_universal.git
    GIT_TAG ${BASIS_UNIVERSAL_FETCH_TAG}
    GIT_SHALLOW TRUE
    # The transcoder only: not its CMake project (the encoder and tools).
    SOURCE_SUBDIR transcoder-only)
FetchContent_MakeAvailable(basis_universal)
# Its Zstandard decoder is C.
enable_language(C)
add_library(basisu_transcoder STATIC
    "${basis_universal_SOURCE_DIR}/transcoder/basisu_transcoder.cpp"
    "${basis_universal_SOURCE_DIR}/zstd/zstddeclib.c")
target_include_directories(basisu_transcoder PUBLIC "${basis_universal_SOURCE_DIR}/transcoder")
# KTX 2 files, with Zstandard supercompression (its own decoder); no texture formats it doesn't need.
target_compile_definitions(basisu_transcoder PUBLIC BASISD_SUPPORT_KTX2=1 BASISD_SUPPORT_KTX2_ZSTD=1)
if (MSVC)
    target_compile_options(basisu_transcoder PRIVATE /W0)
else()
    target_compile_options(basisu_transcoder PRIVATE -w)
endif()
# Its hash_map asserts call safe_shift_left(1ULL, ...), ambiguous between the uint32_t and uint64_t
# overloads where uint64_t is unsigned long (64-bit Linux); GCC 14+ rejects that in a template body
# even when the template isn't instantiated. Also its users', which include the header.
target_compile_options(basisu_transcoder PUBLIC $<$<AND:$<COMPILE_LANGUAGE:CXX>,$<CXX_COMPILER_ID:GNU>>:-Wno-template-body>)
donut_compile_shaders_all_platforms(
    TARGET texture_compression_comparison_shaders
    PROJECT_NAME "Texture Compression Comparison"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/texture_compression_comparison.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/msaa.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/texture_compression_comparison
)
add_tslang_example(texture_compression_comparison core/matrix.ts core/transcoded_texture.ts core/basis_transcoder.cpp MEDIA texture_compression_comparison)
add_tslang_example_test(texture_compression_comparison)
target_link_libraries(texture_compression_comparison PRIVATE basisu_transcoder)
if (TARGET texture_compression_comparison_app)
    target_link_libraries(texture_compression_comparison_app PRIVATE basisu_transcoder)
endif()
if (VULKAN_SAMPLES_ASSETS_DIR)
    set(sponza_ktx2_source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/sponza")
    set(sponza_ktx2_output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/texture_compression_comparison/sponza")
    set(compression_media)
    foreach(file Sponza01.gltf Sponza01.bin)
        set(output "${sponza_ktx2_output}/${file}")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${sponza_ktx2_source}/${file}" "${output}"
            DEPENDS "${sponza_ktx2_source}/${file}"
            COMMENT "Copying ${file}"
            VERBATIM)
        list(APPEND compression_media "${output}")
    endforeach()
    # The scene's images (KTX 1 files) as the sample loads them instead: ktx2/<name>.ktx2.
    foreach(name sponza_flagpole_diff lion background sponza_thorn_diff vase_plant spnza_bricks_a_diff
            sponza_ceiling_a_diff sponza_column_a_diff sponza_arch_diff sponza_column_c_diff sponza_details_diff
            sponza_floor_a_diff sponza_column_b_diff vase_dif vase_hanging vase_round chain_texture
            sponza_curtain_blue_diff sponza_curtain_diff sponza_curtain_green_diff sponza_fabric_green_diff
            sponza_fabric_blue_diff sponza_fabric_diff sponza_roof_diff)
        set(output "${sponza_ktx2_output}/ktx2/${name}.ktx2")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${sponza_ktx2_source}/ktx2/${name}.ktx2" "${output}"
            DEPENDS "${sponza_ktx2_source}/ktx2/${name}.ktx2"
            COMMENT "Copying ${name}.ktx2"
            VERBATIM)
        list(APPEND compression_media "${output}")
    endforeach()
    add_custom_target(texture_compression_comparison_media DEPENDS ${compression_media})
    add_dependencies(texture_compression_comparison texture_compression_comparison_media)
endif()

# Port of Vulkan-Samples' shader_quad_control: a triangle over the screen, its pixel shader run in
# full quads (VK_KHR_shader_quad_control's execution mode, as DXC's inline SPIR-V; D3D12 runs whole
# quads anyway), optionally each quad showing its top left pixel's value. Quad operations need
# shader model 6, so no DXBC.
donut_compile_shaders(
    TARGET shader_quad_control_shaders
    PROJECT_NAME "Shader Quad Control"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/shader_quad_control.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/shader_quad_control.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/shader_quad_control/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/shader_quad_control/spirv
)
add_tslang_example(shader_quad_control)
add_tslang_example_test(shader_quad_control)

# Port of Vulkan-Samples' dynamic_line_rasterization: a cube's edges drawn as lines whose
# rasterization mode (rectangular, Bresenham, smooth), width and stipple are set in the UI (the
# sample's dynamic state is a pipeline per combination here; an NVRHI patch adds them, see
# DONUT_NVRHI_PATCHES above), over a grid on the ground. Width and stipple are Vulkan's only.
donut_compile_shaders_all_platforms(
    TARGET dynamic_line_rasterization_shaders
    PROJECT_NAME "Dynamic Line Rasterization"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dynamic_line_rasterization.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dynamic_line_rasterization.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/dynamic_line_rasterization
)
add_tslang_example(dynamic_line_rasterization core/vulkan_samples_camera.ts core/matrix.ts core/text_format.ts)
add_tslang_example_test(dynamic_line_rasterization)

# Port of Vulkan-Samples' extended_dynamic_state2: primitives over an environment cube map, each
# with depth bias and rasterizer discard switched in the UI, a cube of triangle strips with
# primitive restart (an NVRHI patch adds it, see DONUT_NVRHI_PATCHES above) and a tessellated
# wireframe geosphere (the sample's dynamic state is pipelines here). Its scene, cube and cube map
# are Vulkan-Samples' assets too (see VULKAN_SAMPLES_ASSETS_DIR above): the glTF files are copied,
# the KTX cube map converted to DDS.
donut_compile_shaders_all_platforms(
    TARGET extended_dynamic_state2_shaders
    PROJECT_NAME "Extended Dynamic State 2"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/extended_dynamic_state2.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/extended_dynamic_state2.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/extended_dynamic_state2
)
add_tslang_example(extended_dynamic_state2 core/vulkan_samples_camera.ts core/matrix.ts core/text_format.ts MEDIA extended_dynamic_state2)
add_tslang_example_test(extended_dynamic_state2)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(source "${VULKAN_SAMPLES_ASSETS_DIR}/textures/uffizi_rgba16f_cube.ktx")
    set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/extended_dynamic_state2/uffizi_rgba16f_cube.dds")
    add_custom_command(OUTPUT "${output}"
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${source}" "${output}"
        DEPENDS "${source}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py"
        COMMENT "Converting uffizi_rgba16f_cube.ktx to DDS"
        VERBATIM)
    set(extended_dynamic_state2_media "${output}")
    foreach(model primitives/primitives cube)
        get_filename_component(name "${model}" NAME)
        set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/${model}.gltf")
        set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/extended_dynamic_state2/${name}.gltf")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
            DEPENDS "${source}"
            COMMENT "Copying ${name}.gltf"
            VERBATIM)
        list(APPEND extended_dynamic_state2_media "${output}")
    endforeach()
    add_custom_target(extended_dynamic_state2_media DEPENDS ${extended_dynamic_state2_media})
    add_dependencies(extended_dynamic_state2 extended_dynamic_state2_media)
endif()

# Port of Vulkan-Samples' fragment_shading_rate: a scene drawn with a shading rate image made once
# on the CPU, rings of coarser rates around the center. Variable rate shading with shading rate
# images needs D3D12 or Vulkan, so no DXBC. Its models and textures are Vulkan-Samples' assets too
# (see VULKAN_SAMPLES_ASSETS_DIR above): the glTF files are copied, the KTX textures converted to DDS.
donut_compile_shaders(
    TARGET fragment_shading_rate_shaders
    PROJECT_NAME "Fragment Shading Rate"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/fragment_shading_rate.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/fragment_shading_rate.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/fragment_shading_rate/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/fragment_shading_rate/spirv
)
add_tslang_example(fragment_shading_rate core/matrix.ts MEDIA fragment_shading_rate)
add_tslang_example_test(fragment_shading_rate)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(fragment_shading_rate_output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/fragment_shading_rate")
    set(fragment_shading_rate_media)
    foreach(texture skysphere_rgba metalplate01_rgba)
        set(source "${VULKAN_SAMPLES_ASSETS_DIR}/textures/${texture}.ktx")
        set(output "${fragment_shading_rate_output}/${texture}.dds")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${source}" "${output}"
            DEPENDS "${source}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py"
            COMMENT "Converting ${texture}.ktx to DDS"
            VERBATIM)
        list(APPEND fragment_shading_rate_media "${output}")
    endforeach()
    foreach(model geosphere textured_unit_cube)
        set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/${model}.gltf")
        set(output "${fragment_shading_rate_output}/${model}.gltf")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
            DEPENDS "${source}"
            COMMENT "Copying ${model}.gltf"
            VERBATIM)
        list(APPEND fragment_shading_rate_media "${output}")
    endforeach()
    add_custom_target(fragment_shading_rate_media DEPENDS ${fragment_shading_rate_media})
    add_dependencies(fragment_shading_rate fragment_shading_rate_media)
endif()

# Port of Vulkan-Samples' memory_budget: its instancing sample's rocks around a planet (instancing's
# shaders) with the memory heaps' usage and budget (VK_EXT_memory_budget, or DXGI's on D3D). Its
# models and textures are Vulkan-Samples' assets too (see VULKAN_SAMPLES_ASSETS_DIR above): the
# glTF files are copied, the KTX textures converted to DDS.
donut_compile_shaders_all_platforms(
    TARGET memory_budget_shaders
    PROJECT_NAME "Memory Budget"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/memory_budget.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/instancing.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/memory_budget
)
add_tslang_example(memory_budget core/random.ts core/matrix.ts core/text_format.ts MEDIA memory_budget)
add_tslang_example_test(memory_budget)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(memory_budget_media)
    foreach(texture texturearray_rocks_color_rgba lavaplanet_color_rgba)
        set(source "${VULKAN_SAMPLES_ASSETS_DIR}/textures/${texture}.ktx")
        set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/memory_budget/${texture}.dds")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${source}" "${output}"
            DEPENDS "${source}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py"
            COMMENT "Converting ${texture}.ktx to DDS"
            VERBATIM)
        list(APPEND memory_budget_media "${output}")
    endforeach()
    foreach(model rock planet)
        set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/${model}.gltf")
        set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/memory_budget/${model}.gltf")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
            DEPENDS "${source}"
            COMMENT "Copying ${model}.gltf"
            VERBATIM)
        list(APPEND memory_budget_media "${output}")
    endforeach()
    add_custom_target(memory_budget_media DEPENDS ${memory_budget_media})
    add_dependencies(memory_budget memory_budget_media)
endif()

# Port of Vulkan-Samples' mobile_nerf (after Google's MobileNeRF): neural radiance fields baked into
# textured meshes, each pixel's color from its two feature textures run through the model's small
# MLP in the pixel shader; four Lego models, instanced. Its models are Vulkan-Samples' assets too
# (see VULKAN_SAMPLES_ASSETS_DIR above): each model's glTF mesh, feature textures and MLP are copied.
donut_compile_shaders_all_platforms(
    TARGET mobile_nerf_shaders
    PROJECT_NAME "Mobile NeRF"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/mobile_nerf.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/mobile_nerf.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/mobile_nerf
)
add_tslang_example(mobile_nerf core/mobile_nerf_common.ts core/matrix.ts MEDIA mobile_nerf)
add_tslang_example_test(mobile_nerf)
if (VULKAN_SAMPLES_ASSETS_DIR)
    set(mobile_nerf_media)
    foreach(model lego_ball_phone lego_boba_fett_phone lego_monster_truck_phone lego_tractor_phone)
        foreach(file shape0.gltf shape0.pngfeat0.png shape0.pngfeat1.png mlp.json)
            set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/morpheus_team/${model}/${file}")
            set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/mobile_nerf/${model}/${file}")
            add_custom_command(OUTPUT "${output}"
                COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
                DEPENDS "${source}"
                COMMENT "Copying ${model}/${file}"
                VERBATIM)
            list(APPEND mobile_nerf_media "${output}")
        endforeach()
    endforeach()
    add_custom_target(mobile_nerf_media DEPENDS ${mobile_nerf_media})
    add_dependencies(mobile_nerf mobile_nerf_media)
endif()

# Port of Vulkan-Samples' dynamic_primitive_clipping: an object drawn twice with user clip distances
# (SV_ClipDistance), the second time negated, the clip distance function picked in the UI, and
# depth clipping switched (the sample's dynamic state is a pipeline of its own here). Its models are
# Vulkan-Samples' assets too (see VULKAN_SAMPLES_ASSETS_DIR above): the glTF files are copied.
donut_compile_shaders_all_platforms(
    TARGET dynamic_primitive_clipping_shaders
    PROJECT_NAME "Dynamic Primitive Clipping"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dynamic_primitive_clipping.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dynamic_primitive_clipping.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/dynamic_primitive_clipping
)
add_tslang_example(dynamic_primitive_clipping core/vulkan_samples_camera.ts core/matrix.ts core/text_format.ts MEDIA dynamic_primitive_clipping)
add_tslang_example_test(dynamic_primitive_clipping)
if (VULKAN_SAMPLES_ASSETS_DIR)
    set(dynamic_primitive_clipping_media)
    foreach(model teapot torusknot geosphere)
        set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/${model}.gltf")
        set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/dynamic_primitive_clipping/${model}.gltf")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
            DEPENDS "${source}"
            COMMENT "Copying ${model}.gltf"
            VERBATIM)
        list(APPEND dynamic_primitive_clipping_media "${output}")
    endforeach()
    add_custom_target(dynamic_primitive_clipping_media DEPENDS ${dynamic_primitive_clipping_media})
    add_dependencies(dynamic_primitive_clipping dynamic_primitive_clipping_media)
endif()

# Port of Vulkan-Samples' mobile_nerf_rayquery: mobile_nerf's NeRFs found by inline ray queries in a
# pixel shader (a TLAS of the models' meshes) instead of rasterized, each hit's feature textures run
# through its model's MLP. It reads mobile_nerf's copy of the models. Ray queries need D3D12 or
# Vulkan, so no DXBC.
donut_compile_shaders(
    TARGET mobile_nerf_rayquery_shaders
    PROJECT_NAME "Mobile NeRF Ray Query"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/mobile_nerf_rayquery.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/mobile_nerf_rayquery.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/mobile_nerf_rayquery/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/mobile_nerf_rayquery/spirv
)
add_tslang_example(mobile_nerf_rayquery core/mobile_nerf_common.ts core/matrix.ts MEDIA mobile_nerf)
add_tslang_example_test(mobile_nerf_rayquery)
if (TARGET mobile_nerf_media)
    add_dependencies(mobile_nerf_rayquery mobile_nerf_media)
endif()

# Port of Vulkan-Samples' ray_queries: Sponza rasterized, each pixel shaded by inline ray queries
# from its pixel shader against a TLAS of the scene (ambient occlusion and a hard shadow from a
# moving light). It reads ray_tracing_extended's copy of the scene. Ray queries need D3D12 or
# Vulkan, so no DXBC.
donut_compile_shaders(
    TARGET ray_queries_shaders
    PROJECT_NAME "Ray Queries"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/ray_queries.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/ray_queries.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/ray_queries/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/ray_queries/spirv
)
add_tslang_example(ray_queries core/vulkan_samples_camera.ts core/matrix.ts MEDIA ray_tracing_extended)
add_tslang_example_test(ray_queries)
if (TARGET ray_tracing_extended_media)
    add_dependencies(ray_queries ray_tracing_extended_media)
endif()

# Port of Vulkan-Samples' ray_tracing_reflection: two colored cubes over a slightly reflective floor
# between two mirrors, ray traced with reflections (rays bounced up to 64 times) and shadow rays.
# The scene is built in code. Ray tracing needs D3D12 or Vulkan, so no DXBC.
donut_compile_shaders(
    TARGET ray_tracing_reflection_shaders
    PROJECT_NAME "Ray Tracing Reflection"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/ray_tracing_reflection.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/ray_tracing_reflection.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/ray_tracing_reflection/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/ray_tracing_reflection/spirv
)
add_tslang_example(ray_tracing_reflection core/vulkan_samples_camera.ts core/matrix.ts)
add_tslang_example_test(ray_tracing_reflection)

# Port of Vulkan-Samples' timestamp_queries: its hdr sample (hdr's shaders and models) with the GPU
# time of each pass measured by timer queries and shown in the UI.
donut_compile_shaders_all_platforms(
    TARGET timestamp_queries_shaders
    PROJECT_NAME "Timestamp Queries"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/timestamp_queries.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/hdr.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/timestamp_queries
)
add_tslang_example(timestamp_queries core/matrix.ts MEDIA hdr)
add_tslang_example_test(timestamp_queries)
if (TARGET hdr_media)
    add_dependencies(timestamp_queries hdr_media)
endif()

# Port of Vulkan-Samples' patch_control_points: a terrain drawn twice as wireframe tessellated
# patches, tessellated and colored by their edges' distance from the camera; the sample's second
# pipeline sets its patch control points dynamically. Its model is a Vulkan-Samples asset too (see
# VULKAN_SAMPLES_ASSETS_DIR above): the glTF file is copied.
donut_compile_shaders_all_platforms(
    TARGET patch_control_points_shaders
    PROJECT_NAME "Patch Control Points"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/patch_control_points.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/patch_control_points.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/patch_control_points
)
add_tslang_example(patch_control_points core/vulkan_samples_camera.ts core/matrix.ts MEDIA patch_control_points)
add_tslang_example_test(patch_control_points)
if (VULKAN_SAMPLES_ASSETS_DIR)
    set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/terrain/terrain.gltf")
    set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/patch_control_points/terrain.gltf")
    add_custom_command(OUTPUT "${output}"
        COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
        DEPENDS "${source}"
        COMMENT "Copying terrain.gltf"
        VERBATIM)
    add_custom_target(patch_control_points_media DEPENDS "${output}")
    add_dependencies(patch_control_points patch_control_points_media)
endif()

# Port of Vulkan-Samples' descriptor_indexing: two grids of rotating quads reading 64 small textures
# from bindless texture arrays, one by a non-uniform index, the other by streaming each quad's
# texture into a table already bound (update after bind). Bindless needs D3D12 or Vulkan, so no
# DXBC.
donut_compile_shaders(
    TARGET descriptor_indexing_shaders
    PROJECT_NAME "Descriptor Indexing"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/descriptor_indexing.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/descriptor_indexing.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/descriptor_indexing/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/descriptor_indexing/spirv
)
add_tslang_example(descriptor_indexing)
add_tslang_example_test(descriptor_indexing)

# Port of Vulkan-Samples' timeline_semaphore: Conway's Game of Life stepped on the compute queue,
# drawn by the graphics queue once the compute work is done (the sample orders its two queues'
# threads with a timeline semaphore; NVRHI orders the queues itself).
donut_compile_shaders_all_platforms(
    TARGET timeline_semaphore_shaders
    PROJECT_NAME "Timeline Semaphore"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/timeline_semaphore.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/timeline_semaphore.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/timeline_semaphore
)
add_tslang_example(timeline_semaphore)
add_tslang_example_test(timeline_semaphore)

# Port of Vulkan-Samples' color_write_enable: a triangle drawn into three targets, each written in
# one channel (or not at all, switched in the UI), then added up into the back buffer.
donut_compile_shaders_all_platforms(
    TARGET color_write_enable_shaders
    PROJECT_NAME "Color Write Enable"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/color_write_enable.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/color_write_enable.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/color_write_enable
)
add_tslang_example(color_write_enable)
add_tslang_example_test(color_write_enable)

# Port of Vulkan-Samples' dynamic_multisample_rasterization: the Space Module scene with its normal
# and metallic-roughness maps, drawn with the sample count picked in the UI (the sample's dynamic
# rasterization samples; pipelines per count here) and resolved into the back buffer. It reads
# msaa's copy of the scene and base color textures (see VULKAN_SAMPLES_ASSETS_DIR above); its
# other textures are decoded to DDS here.
donut_compile_shaders_all_platforms(
    TARGET dynamic_multisample_rasterization_shaders
    PROJECT_NAME "Dynamic Multisample Rasterization"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dynamic_multisample_rasterization.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dynamic_multisample_rasterization.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/dynamic_multisample_rasterization
)
add_tslang_example(dynamic_multisample_rasterization core/matrix.ts MEDIA msaa dynamic_multisample_rasterization)
add_tslang_example_test(dynamic_multisample_rasterization)
if (VULKAN_SAMPLES_ASSETS_DIR)
    set(sources)
    set(outputs)
    set(arguments)
    foreach(name PlaneCylinderRoom_M_CylinderRoom_Normal PlaneCylinderRoom_M_CylinderRoom_OcclusionRoughnessMetallic
            T_Metal_S T_Pedestal_N T_Pedestal_S phone_NORM phone_SPEC)
        list(APPEND sources "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/space_module/${name}.ktx")
        list(APPEND outputs "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/dynamic_multisample_rasterization/${name}.dds")
        list(APPEND arguments "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/space_module/${name}.ktx"
            "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/dynamic_multisample_rasterization/${name}.dds")
    endforeach()
    add_custom_command(OUTPUT ${outputs}
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" ${arguments}
        COMMAND dds_mips ${outputs}
        DEPENDS ${sources} "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${CMAKE_CURRENT_SOURCE_DIR}/tools/astc.py" dds_mips
        COMMENT "Decoding the Space Module's normal and metallic-roughness textures to DDS"
        VERBATIM)
    add_custom_target(dynamic_multisample_rasterization_media DEPENDS ${outputs})
    add_dependencies(dynamic_multisample_rasterization dynamic_multisample_rasterization_media msaa_media)
endif()

# Port of Vulkan-Samples' vertex_dynamic_state: hdr's skybox and a reflective cube, then a cube made
# in code with another vertex layout (the sample's dynamic vertex input; a pipeline per layout
# here). It reads hdr's copies of the models and cube map.
donut_compile_shaders_all_platforms(
    TARGET vertex_dynamic_state_shaders
    PROJECT_NAME "Vertex Dynamic State"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/vertex_dynamic_state.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/vertex_dynamic_state.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/vertex_dynamic_state
)
add_tslang_example(vertex_dynamic_state core/vulkan_samples_camera.ts core/matrix.ts MEDIA hdr)
add_tslang_example_test(vertex_dynamic_state)
if (TARGET hdr_media)
    add_dependencies(vertex_dynamic_state hdr_media)
endif()

# Port of Vulkan-Samples' dynamic_rendering: hdr's skybox and a reflective geosphere (the sample's
# point, rendering without render pass objects, is how NVRHI draws anyway). vertex_dynamic_state's
# shaders; hdr's copies of the models and cube map.
donut_compile_shaders_all_platforms(
    TARGET dynamic_rendering_shaders
    PROJECT_NAME "Dynamic Rendering"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dynamic_rendering.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/vertex_dynamic_state.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/dynamic_rendering
)
add_tslang_example(dynamic_rendering core/vulkan_samples_camera.ts core/matrix.ts MEDIA hdr)
add_tslang_example_test(dynamic_rendering)
if (TARGET hdr_media)
    add_dependencies(dynamic_rendering hdr_media)
endif()

# Port of Vulkan-Samples' graphics_pipeline_library: a grid of spinning teapots, each with a pipeline
# of its own and a lighting model picked at random ("Add pipeline" adds one). The sample links them
# from pipeline libraries on a thread; NVRHI has no pipeline libraries: ordinary pipelines here. It
# reads hdr's copy of the model.
donut_compile_shaders_all_platforms(
    TARGET graphics_pipeline_library_shaders
    PROJECT_NAME "Graphics Pipeline Library"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/graphics_pipeline_library.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/graphics_pipeline_library.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/graphics_pipeline_library
)
add_tslang_example(graphics_pipeline_library core/vulkan_samples_camera.ts core/matrix.ts MEDIA hdr)
add_tslang_example_test(graphics_pipeline_library)
if (TARGET hdr_media)
    add_dependencies(graphics_pipeline_library hdr_media)
endif()

# Port of Vulkan-Samples' mesh_shading: one mesh shader workgroup outputs a red triangle (no vertex
# input, no task shader). Mesh shaders need D3D12 or Vulkan, so no DXBC.
donut_compile_shaders(
    TARGET mesh_shading_shaders
    PROJECT_NAME "Mesh Shading"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/mesh_shading.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/mesh_shading.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/mesh_shading/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/mesh_shading/spirv
    SHADERMAKE_OPTIONS_SPIRV "--spirvExt SPV_EXT_mesh_shader"
)
add_tslang_example(mesh_shading)
add_tslang_example_test(mesh_shading)

# Port of Vulkan-Samples' dynamic_uniform_buffers: 125 spinning cubes, one draw each, their model
# matrices in slices of one uniform buffer (the sample's dynamic offsets are a binding set per slice
# here).
donut_compile_shaders_all_platforms(
    TARGET dynamic_uniform_buffers_shaders
    PROJECT_NAME "Dynamic Uniform Buffers"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dynamic_uniform_buffers.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dynamic_uniform_buffers.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/dynamic_uniform_buffers
)
add_tslang_example(dynamic_uniform_buffers core/vulkan_samples_camera.ts core/matrix.ts)
add_tslang_example_test(dynamic_uniform_buffers)

# Port of Vulkan-Samples' texture_loading: a lit quad with a texture loaded with its mip levels,
# sampled with a level of detail bias set in the UI. It reads fragment_shading_rate's copy of the
# texture (see VULKAN_SAMPLES_ASSETS_DIR above).
donut_compile_shaders_all_platforms(
    TARGET texture_loading_shaders
    PROJECT_NAME "Texture Loading"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/texture_loading.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/texture_loading.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/texture_loading
)
add_tslang_example(texture_loading core/vulkan_samples_camera.ts core/matrix.ts MEDIA fragment_shading_rate)
add_tslang_example_test(texture_loading)
if (TARGET fragment_shading_rate_media)
    add_dependencies(texture_loading fragment_shading_rate_media)
endif()

# Port of Vulkan-Samples' host_image_copy: texture_loading's lit, textured cube (its shaders), the
# texture written by the CPU with no staging buffer or command buffer: VK_EXT_host_image_copy on
# Vulkan, WriteToSubresource into a CPU-writable heap on D3D12 (Donut_CreateHostCopiedTexture).
# It reads fragment_shading_rate's copies of the texture and the cube.
donut_compile_shaders_all_platforms(
    TARGET host_image_copy_shaders
    PROJECT_NAME "Host Image Copy"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/texture_loading.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/texture_loading.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/host_image_copy
)
add_tslang_example(host_image_copy core/vulkan_samples_camera.ts core/matrix.ts MEDIA fonts fragment_shading_rate)
if (TARGET fragment_shading_rate_media)
    add_dependencies(host_image_copy fragment_shading_rate_media)
endif()
add_tslang_example_test(host_image_copy APIS dx12 vk)

# Port of Vulkan-Samples' buffer_device_address: 64 meshes animated by a compute shader and drawn
# instanced, each in a buffer the shaders reach only through its device address (vk::RawBufferLoad /
# vk::RawBufferStore), the table of addresses through its own, in push constants: no descriptors.
# Vulkan only (D3D shaders have no pointers), so SPIR-V only.
donut_compile_shaders(
    TARGET buffer_device_address_shaders
    PROJECT_NAME "Buffer Device Address"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/buffer_device_address.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/buffer_device_address.hlsl
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/buffer_device_address/spirv
)
add_tslang_example(buffer_device_address)
add_tslang_example_test(buffer_device_address APIS vk)

# Port of Vulkan-Samples' shader_debugprintf: a sky sphere and three lit spheres, the vertex shader
# printing positions with printf, which the validation layer (its printf setting on) instruments,
# reads back and delivers as messages that the UI shows (AppOptions.ShaderPrintf,
# Donut_UpdateShaderPrintfOutput). Vulkan only, with the validation layer (Vulkan SDK) installed, so
# SPIR-V only. It reads fragment_shading_rate_dynamic's copies of the sky sphere and its texture.
donut_compile_shaders(
    TARGET shader_debugprintf_shaders
    PROJECT_NAME "Shader debugprintf"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/shader_debugprintf.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/shader_debugprintf.hlsl
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/shader_debugprintf/spirv
)
add_tslang_example(shader_debugprintf core/matrix.ts MEDIA fonts fragment_shading_rate_dynamic)
if (TARGET fragment_shading_rate_dynamic_media)
    add_dependencies(shader_debugprintf fragment_shading_rate_dynamic_media)
endif()
add_tslang_example_test(shader_debugprintf APIS vk)

# Port of Vulkan-Samples' push_descriptors: two textured cubes, each draw's descriptors (the
# scene's and the cube's uniform buffers, its texture) pushed into the command buffer
# (VK_KHR_push_descriptor) instead of allocated sets: Donut_CreatePushDescriptorPipeline, raw
# Vulkan recorded into NVRHI's command list. Vulkan only, so SPIR-V only. Its crate textures are
# Vulkan-Samples' assets (see VULKAN_SAMPLES_ASSETS_DIR above), converted to DDS; the cube is
# fragment_shading_rate's copy.
donut_compile_shaders(
    TARGET push_descriptors_shaders
    PROJECT_NAME "Push Descriptors"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/push_descriptors.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/push_descriptors.hlsl
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/push_descriptors/spirv
)
add_tslang_example(push_descriptors core/vulkan_samples_camera.ts core/matrix.ts MEDIA fonts fragment_shading_rate push_descriptors)
if (VULKAN_SAMPLES_ASSETS_DIR)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(push_descriptors_media)
    foreach(texture crate01_color_height_rgba crate02_color_height_rgba)
        set(source "${VULKAN_SAMPLES_ASSETS_DIR}/textures/${texture}.ktx")
        set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/push_descriptors/${texture}.dds")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${source}" "${output}"
            DEPENDS "${source}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py"
            COMMENT "Converting ${texture}.ktx to DDS"
            VERBATIM)
        list(APPEND push_descriptors_media "${output}")
    endforeach()
    add_custom_target(push_descriptors_media DEPENDS ${push_descriptors_media})
    add_dependencies(push_descriptors push_descriptors_media fragment_shading_rate_media)
endif()
add_tslang_example_test(push_descriptors APIS vk)

# Port of Vulkan-Samples' descriptor_buffer_basic: push_descriptors' two textured cubes, their
# descriptor sets in descriptor buffers (VK_EXT_descriptor_buffer): buffers the CPU writes the
# descriptors into, bound once, each draw's sets at offsets in them
# (Donut_CreateDescriptorBufferPipeline, Donut_CreateDescriptorBuffer: raw Vulkan in NVRHI's command
# list). Vulkan only, so SPIR-V only. It reads push_descriptors' crate textures and
# fragment_shading_rate's cube.
donut_compile_shaders(
    TARGET descriptor_buffer_basic_shaders
    PROJECT_NAME "Descriptor Buffer Basic"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/descriptor_buffer_basic.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/descriptor_buffer_basic.hlsl
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/descriptor_buffer_basic/spirv
)
add_tslang_example(descriptor_buffer_basic core/vulkan_samples_camera.ts core/matrix.ts MEDIA fonts fragment_shading_rate push_descriptors)
if (TARGET push_descriptors_media)
    add_dependencies(descriptor_buffer_basic push_descriptors_media fragment_shading_rate_media)
endif()
add_tslang_example_test(descriptor_buffer_basic APIS vk)

# Port of Vulkan-Samples' separate_image_sampler: a textured quad, its sampler bound apart from the
# image (a binding set of its own), linear or nearest filtering picked in the UI. It reads
# fragment_shading_rate's copy of the texture.
donut_compile_shaders_all_platforms(
    TARGET separate_image_sampler_shaders
    PROJECT_NAME "Separate Image Sampler"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/separate_image_sampler.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/separate_image_sampler.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/separate_image_sampler
)
add_tslang_example(separate_image_sampler core/vulkan_samples_camera.ts core/matrix.ts MEDIA fragment_shading_rate)
add_tslang_example_test(separate_image_sampler)
if (TARGET fragment_shading_rate_media)
    add_dependencies(separate_image_sampler fragment_shading_rate_media)
endif()

# Port of Vulkan-Samples' dynamic_rendering_local_read: deferred shading of a room lit by 64 point
# lights, then glass drawn forward over it. The sample reads its G-buffer in the same dynamic render
# pass (local read); here the composition and the glass are passes of their own. Its scenes and
# texture are Vulkan-Samples' assets too (see VULKAN_SAMPLES_ASSETS_DIR above): the glTF files are
# copied, the KTX texture converted to DDS.
donut_compile_shaders_all_platforms(
    TARGET dynamic_rendering_local_read_shaders
    PROJECT_NAME "Dynamic Rendering Local Read"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dynamic_rendering_local_read.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dynamic_rendering_local_read.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/dynamic_rendering_local_read
)
add_tslang_example(dynamic_rendering_local_read core/vulkan_samples_camera.ts core/matrix.ts MEDIA dynamic_rendering_local_read)
add_tslang_example_test(dynamic_rendering_local_read)
if (VULKAN_SAMPLES_ASSETS_DIR)
    set(dynamic_rendering_local_read_media)
    foreach(scene subpass_scene_opaque subpass_scene_transparent)
        set(source "${VULKAN_SAMPLES_ASSETS_DIR}/scenes/${scene}.gltf")
        set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/dynamic_rendering_local_read/${scene}.gltf")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
            DEPENDS "${source}"
            COMMENT "Copying ${scene}.gltf"
            VERBATIM)
        list(APPEND dynamic_rendering_local_read_media "${output}")
    endforeach()
    set(source "${VULKAN_SAMPLES_ASSETS_DIR}/textures/transparent_glass_rgba.ktx")
    set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/dynamic_rendering_local_read/transparent_glass_rgba.dds")
    add_custom_command(OUTPUT "${output}"
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${source}" "${output}"
        DEPENDS "${source}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py"
        COMMENT "Converting transparent_glass_rgba.ktx to DDS"
        VERBATIM)
    list(APPEND dynamic_rendering_local_read_media "${output}")
    add_custom_target(dynamic_rendering_local_read_media DEPENDS ${dynamic_rendering_local_read_media})
    add_dependencies(dynamic_rendering_local_read dynamic_rendering_local_read_media)
endif()

# Port of Vulkan-Samples' shader_object: a scene drawn with shader objects combined at draw time
# (any material vertex shader with any geometry shader and fragment shader), into output images of
# every supported format in turn, then post-processed. NVRHI has no shader objects: a pipeline per
# combination in use, created when first drawn. Its models and textures are other ports' copies (hdr,
# instancing, terrain_tessellation, texture_mipmap_generation).
donut_compile_shaders_all_platforms(
    TARGET shader_object_shaders
    PROJECT_NAME "Shader Object"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/shader_object.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/shader_object.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/shader_object
)
add_tslang_example(shader_object core/matrix.ts MEDIA hdr instancing/rock.gltf terrain_tessellation texture_mipmap_generation/checkerboard_rgba.dds)
add_tslang_example_test(shader_object)
foreach(media hdr_media instancing_media terrain_tessellation_media texture_mipmap_generation_media)
    if (TARGET ${media})
        add_dependencies(shader_object ${media})
    endif()
endforeach()

# Port of Vulkan-Samples' texture_compression_basisu: a quad with a Kodak image from a Basis Universal
# KTX 2 file (UASTC or ETC1S), transcoded on the CPU into the format picked (BC7, BC3 or RGBA8 here),
# timed. Basis Universal's transcoder (see texture_compression_comparison above), through
# core/basis_transcoder.cpp. Its KTX 2 files are Vulkan-Samples' assets (see VULKAN_SAMPLES_ASSETS_DIR
# above), copied.
donut_compile_shaders_all_platforms(
    TARGET texture_compression_basisu_shaders
    PROJECT_NAME "Texture Compression Basisu"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/texture_compression_basisu.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/texture_compression_basisu.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/texture_compression_basisu
)
add_tslang_example(texture_compression_basisu core/vulkan_samples_camera.ts core/matrix.ts core/text_format.ts core/transcoded_texture.ts core/basis_transcoder.cpp MEDIA texture_compression_basisu)
add_tslang_example_test(texture_compression_basisu)
target_link_libraries(texture_compression_basisu PRIVATE basisu_transcoder)
if (TARGET texture_compression_basisu_app)
    target_link_libraries(texture_compression_basisu_app PRIVATE basisu_transcoder)
endif()
if (VULKAN_SAMPLES_ASSETS_DIR)
    set(basisu_media)
    foreach(image kodim23 kodim20 kodim05 kodim03)
        foreach(codec UASTC ETC1S)
            set(file "${image}_${codec}.ktx2")
            set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/texture_compression_basisu/${file}")
            add_custom_command(OUTPUT "${output}"
                COMMAND "${CMAKE_COMMAND}" -E copy "${VULKAN_SAMPLES_ASSETS_DIR}/textures/basisu/${file}" "${output}"
                DEPENDS "${VULKAN_SAMPLES_ASSETS_DIR}/textures/basisu/${file}"
                COMMENT "Copying ${file}"
                VERBATIM)
            list(APPEND basisu_media "${output}")
        endforeach()
    endforeach()
    add_custom_target(texture_compression_basisu_media DEPENDS ${basisu_media})
    add_dependencies(texture_compression_basisu texture_compression_basisu_media)
endif()

# Port of the Xbox ATG FastBlockCompress sample (github.com/microsoft/Xbox-ATG-Samples,
# XDKSamples/Graphics/FastBlockCompress): BC1, BC3 and BC5 compression at run time in compute shaders
# (into R32G32_UINT / R32G32B32A32_UINT textures copied into BC textures) or on the CPU (the sample's
# SSE2 compressor, core/fbc_cpu.cpp), compared with offline BC and BC7 versions side by side, RMS
# errors and timings shown. Its images are the sample's, not in this repo: point
# XBOX_ATG_SAMPLES_DIR at an Xbox-ATG-Samples checkout.
set(XBOX_ATG_SAMPLES_DIR "" CACHE PATH "Xbox-ATG-Samples checkout (github.com/microsoft/Xbox-ATG-Samples)")
donut_compile_shaders_all_platforms(
    TARGET fast_block_compress_shaders
    PROJECT_NAME "Fast Block Compress"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/fast_block_compress.cfg
    SOURCES
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/fast_block_compress.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/fast_block_compress.hlsli
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/fast_block_compress_rms.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/fast_block_compress_quad.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/fast_block_compress
)
add_tslang_example(fast_block_compress core/text_format.ts core/fbc_texture.ts core/fast_block_compress.cpp core/fbc_cpu.cpp MEDIA fast_block_compress)
add_tslang_example_test(fast_block_compress)
if (XBOX_ATG_SAMPLES_DIR)
    set(fbc_media)
    foreach(file opaque_1024.DDS opaque_1024_offline_bc1.DDS opaque_1024_offline_bc7.dds
            opaque_512.dds opaque_512_offline_bc1.DDS opaque_512_offline_bc7.dds
            alpha.DDS alpha_offline_bc3.DDS alpha_offline_bc7.dds
            normal.dds normal_offline_bc5.DDS normal_offline_bc7.dds)
        set(source "${XBOX_ATG_SAMPLES_DIR}/XDKSamples/Graphics/FastBlockCompress/Assets/${file}")
        set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/fast_block_compress/${file}")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
            DEPENDS "${source}"
            COMMENT "Copying ${file}"
            VERBATIM)
        list(APPEND fbc_media "${output}")
    endforeach()
    add_custom_target(fast_block_compress_media DEPENDS ${fbc_media})
    add_dependencies(fast_block_compress fast_block_compress_media)
endif()

# Port of the Xbox ATG SimpleHDR_PC12 sample (PCSamples/Graphics/SimpleHDR_PC12): an HDR scene of
# blocks brighter than paper white, or the ST.2084 curve, in an HDR10 back buffer (R10G10B10A2,
# Rec.2020, ST.2084) when the display is in HDR mode, clipped to SDR otherwise. Its text uses the
# fonts of DONUT_SAMPLES_MEDIA_DIR above.
donut_compile_shaders_all_platforms(
    TARGET simple_hdr_shaders
    PROJECT_NAME "Simple HDR"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/simple_hdr.cfg
    SOURCES
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/simple_hdr_scene.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/simple_hdr_convert.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/simple_hdr
)
add_tslang_example(simple_hdr core/text_format.ts MEDIA fonts)
add_tslang_example_test(simple_hdr)

# Port of the Xbox ATG VideoTexturePC12 sample (PCSamples/Graphics/VideoTexturePC12): a video played
# by Media Foundation's Media Engine (core/video_player.cpp) into a texture shared with the app's
# device (D3D12, D3D11; through memory on Vulkan), on a spinning lit cube or as a sprite. Windows
# only; mfplat.dll is delay-loaded (Windows N editions lack it). The video is the sample's
# (XBOX_ATG_SAMPLES_DIR above), the text's font DONUT_SAMPLES_MEDIA_DIR's.
if (WIN32)
    donut_compile_shaders_all_platforms(
        TARGET video_texture_shaders
        PROJECT_NAME "Video Texture"
        CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/video_texture.cfg
        SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/video_texture.hlsl
        OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/video_texture
    )
    add_tslang_example(video_texture core/matrix.ts core/video_player.ts core/video_player.cpp MEDIA fonts video_texture)
    add_tslang_example_test(video_texture)
    target_link_libraries(video_texture PRIVATE delayimp)
    target_link_options(video_texture PRIVATE /DELAYLOAD:mfplat.dll)
    if (XBOX_ATG_SAMPLES_DIR)
        set(source "${XBOX_ATG_SAMPLES_DIR}/Media/Videos/SampleVideo.mp4")
        set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/video_texture/SampleVideo.mp4")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
            DEPENDS "${source}"
            COMMENT "Copying SampleVideo.mp4"
            VERBATIM)
        add_custom_target(video_texture_media DEPENDS "${output}")
        add_dependencies(video_texture video_texture_media)
    endif()
endif()

# Copies files of the Xbox-ATG-Samples checkout (XBOX_ATG_SAMPLES_DIR; paths relative to it) into
# media/<dir> for an example, if the checkout is set; "path|name" copies the file under another name.
function(add_atg_media target dir)
    if (NOT XBOX_ATG_SAMPLES_DIR)
        return()
    endif()
    set(outputs)
    foreach(item ${ARGN})
        string(REPLACE "|" ";" parts "${item}")
        list(GET parts 0 file)
        list(LENGTH parts count)
        if (count GREATER 1)
            list(GET parts 1 name)
        else()
            get_filename_component(name "${file}" NAME)
        endif()
        set(source "${XBOX_ATG_SAMPLES_DIR}/${file}")
        set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/${dir}/${name}")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
            DEPENDS "${source}"
            COMMENT "Copying ${name}"
            VERBATIM)
        list(APPEND outputs "${output}")
    endforeach()
    add_custom_target(${target}_media DEPENDS ${outputs})
    add_dependencies(${target} ${target}_media)
endfunction()

# Port of the Xbox ATG Bokeh12 sample (XDKSamples/Graphics/Bokeh12): depth of field by point sprites,
# a sprite per pixel of a quarter-resolution copy of the scene, its size the circle of confusion,
# expanded by a geometry shader into near and far layers of three resolutions (viewports of one
# target, SV_ViewportArrayIndex), recombined with the in-focus scene. The scene is the sample's
# SDKMESH models (core/sdkmesh.cpp) from XBOX_ATG_SAMPLES_DIR; the text's font is
# DONUT_SAMPLES_MEDIA_DIR's.
donut_compile_shaders_all_platforms(
    TARGET bokeh_shaders
    PROJECT_NAME "Bokeh"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/bokeh.cfg
    SOURCES
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/bokeh.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/bokeh_energy.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/bokeh_scene.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/bokeh
)
add_tslang_example(bokeh core/matrix.ts core/text_format.ts core/sdk_mesh.ts core/sdkmesh.cpp MEDIA fonts bokeh)
add_tslang_example_test(bokeh)
add_atg_media(bokeh bokeh
    Media/Meshes/MicroscopeCity/scanner.sdkmesh
    Media/Meshes/MicroscopeCity/occcity.sdkmesh
    Media/Meshes/MicroscopeCity/column.sdkmesh
    Media/Meshes/MicroscopeCity/scanner.dds
    Media/Meshes/MicroscopeCity/city.dds
    Media/Meshes/MicroscopeCity/column.dds
    XDKSamples/Graphics/Bokeh12/Assets/irishexa32.dds)

# Port of the Xbox ATG RaytracingAO_PC12 sample (PCSamples/Raytracing/RaytracingAO_PC12): ambient
# occlusion by ray tracing (DXR: primary rays, then a hemisphere of AO rays at each hit) beside
# MiniEngine's screen-space AO (a G-buffer, depth and normals downsampled and deinterleaved,
# SSAO at four resolutions, blurred and upsampled), split screen or one at a time, on the
# sample's SDKMESH dragon and maze (core/sdkmesh.cpp) from XBOX_ATG_SAMPLES_DIR; the text's font is
# DONUT_SAMPLES_MEDIA_DIR's. Ray tracing needs D3D12 or Vulkan, so no DXBC.
donut_compile_shaders(
    TARGET raytracing_ao_shaders
    PROJECT_NAME "Raytracing AO"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/raytracing_ao.cfg
    SOURCES
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/raytracing_ao.hlsli
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/raytracing_ao.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/raytracing_ao_gbuffer.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/raytracing_ao_ssao_prepare1.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/raytracing_ao_ssao_prepare2.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/raytracing_ao_ssao_render.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/raytracing_ao_ssao_blur.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/raytracing_ao_ssao_composite.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/raytracing_ao/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/raytracing_ao/spirv
)
add_tslang_example(raytracing_ao core/matrix.ts core/text_format.ts core/sdk_mesh.ts core/sdkmesh.cpp MEDIA fonts raytracing_ao)
add_tslang_example_test(raytracing_ao)
add_atg_media(raytracing_ao raytracing_ao
    Media/Meshes/Dragon/Dragon.sdkmesh
    Media/Meshes/Dragon/Dragon_Normal.dds
    Media/Meshes/Maze/Maze1.sdkmesh)

# Port of the Xbox ATG SimplePBR12_UWP sample (UWPSamples/Graphics/SimplePBR12_UWP): physically based
# rendering (ATGTK's PBREffect: Disney-style, image based lighting from radiance and irradiance cube
# maps) of a toy robot, blocks and a floor (SDKMESH, core/sdkmesh.cpp) with albedo, normal and
# roughness / metallic / ambient occlusion textures, under a sky box, into an HDR scene tone mapped
# (ACES filmic) or sent as HDR10 when the display is in HDR mode; an orbit camera on the mouse and
# keys. Its assets are XBOX_ATG_SAMPLES_DIR's, the text's font DONUT_SAMPLES_MEDIA_DIR's.
donut_compile_shaders_all_platforms(
    TARGET simple_pbr_shaders
    PROJECT_NAME "Simple PBR"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/simple_pbr.cfg
    SOURCES
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/simple_pbr.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/simple_pbr_sky.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/simple_pbr_tonemap.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/simple_pbr
)
add_tslang_example(simple_pbr core/matrix.ts core/sdk_mesh.ts core/sdkmesh.cpp MEDIA fonts simple_pbr)
add_tslang_example_test(simple_pbr)
add_atg_media(simple_pbr simple_pbr
    Media/PBR/ToyRobot/Floor/Floor.sdkmesh
    Media/PBR/ToyRobot/Floor/Floor_BaseColor.dds
    "Media/PBR/ToyRobot/Floor/Floor_Normal.DDS|Floor_Normal.dds"
    "Media/PBR/ToyRobot/Floor/Floor_RMA.DDS|Floor_RMA.dds"
    Media/PBR/ToyRobot/ToyRobot/ToyRobot.sdkmesh
    Media/PBR/ToyRobot/ToyRobot/ToyRobot_BaseColor.dds
    "Media/PBR/ToyRobot/ToyRobot/Toyrobot_Normal.DDS|ToyRobot_Normal.dds"
    "Media/PBR/ToyRobot/ToyRobot/Toyrobot_RMA.DDS|ToyRobot_RMA.dds"
    Media/PBR/ToyRobot/WoodBlocks/WoodBlocks.sdkmesh
    Media/PBR/ToyRobot/WoodBlocks/WoodBlocks_BaseColor.dds
    "Media/PBR/ToyRobot/WoodBlocks/WoodBlocks_Normal.DDS|WoodBlocks_Normal.dds"
    "Media/PBR/ToyRobot/WoodBlocks/WoodBlocks_RMA.DDS|WoodBlocks_RMA.dds"
    Media/HDR/Stonewall_Ref_radiance.dds
    Media/HDR/Stonewall_Ref_irradiance.dds)

# Port of the Xbox ATG SimpleComputePC12 sample (PCSamples/IntroGraphics/SimpleComputePC12): a
# Mandelbrot fractal drawn by a compute shader, synchronously in the frame's command list or
# asynchronously on the compute queue by a worker thread (Donut_CreateAsyncComputeLoop), panned and
# zoomed with the keyboard. Async compute needs a compute queue (D3D12, Vulkan); D3D11 runs only
# the synchronous path. The text's font is DONUT_SAMPLES_MEDIA_DIR's.
donut_compile_shaders_all_platforms(
    TARGET simple_compute_shaders
    PROJECT_NAME "Simple Compute"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/simple_compute.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/simple_compute.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/simple_compute
)
add_tslang_example(simple_compute core/text_format.ts MEDIA fonts)
add_tslang_example_test(simple_compute)

# Port of the Xbox ATG SimpleBezierPC12 sample (PCSamples/IntroGraphics/SimpleBezierPC12): a Mobius
# strip of four Bezier patches tessellated by hull and domain shaders, in integer, fractional even
# or fractional odd partitioning, solid or wireframe. The text's font is DONUT_SAMPLES_MEDIA_DIR's.
donut_compile_shaders_all_platforms(
    TARGET simple_bezier_shaders
    PROJECT_NAME "Simple Bezier"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/simple_bezier.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/simple_bezier.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/simple_bezier
)
add_tslang_example(simple_bezier core/text_format.ts MEDIA fonts)
add_tslang_example_test(simple_bezier)

# Port of the Xbox ATG MouseCursor UWP sample (UWPSamples/System/MouseCursor): a menu picked with the
# absolute mouse cursor, a first-person room turned by the captured mouse's relative motion, and a
# real-time strategy map with a cursor of the sample's own that scrolls it at the window's edges.
# Its SDKMESH models (core/sdkmesh.cpp) and menu images are XBOX_ATG_SAMPLES_DIR's, the text's font
# DONUT_SAMPLES_MEDIA_DIR's.
donut_compile_shaders_all_platforms(
    TARGET mouse_cursor_shaders
    PROJECT_NAME "Mouse Cursor"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/mouse_cursor.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/mouse_cursor.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/mouse_cursor
)
add_tslang_example(mouse_cursor core/matrix.ts core/sdk_mesh.ts core/sdkmesh.cpp MEDIA fonts mouse_cursor)
add_tslang_example_test(mouse_cursor)
add_atg_media(mouse_cursor mouse_cursor
    Media/Meshes/FPSRoom/FPSRoom.sdkmesh
    Media/Meshes/FPSRoom/ABox001LightingMap.dds
    Media/Meshes/FPSRoom/ACeilingLightingMap.dds
    Media/Meshes/FPSRoom/AFloortLightingMap.dds
    Media/Meshes/FPSRoom/AWallsLightingMap.dds
    Media/Meshes/FPSRoom/Ceiling.dds
    Media/Meshes/FPSRoom/Cement.dds
    Media/Meshes/FPSRoom/clouds.dds
    Media/Meshes/FPSRoom/Pillar.dds
    Media/Meshes/RTSMap/3DRTSMap.sdkmesh
    Media/Meshes/RTSMap/LabelBase.dds
    Media/Meshes/RTSMap/Labels.dds
    Media/Meshes/RTSMap/Map3DColor.dds
    UWPSamples/System/MouseCursor/Assets/background_flat.png
    UWPSamples/System/MouseCursor/Assets/green_tile.png
    UWPSamples/System/MouseCursor/Assets/green_tile_border.png)

# Port of the Xbox ATG Collision UWP sample (UWPSamples/System/CollisionUWP): DirectXMath's collision
# types (core/directx_collision.cpp: frustum, boxes, oriented boxes, spheres, triangles, rays) tested
# against each other, the objects drawn as lines colored by the results, with an orbit camera. The
# text's font is DONUT_SAMPLES_MEDIA_DIR's.
donut_compile_shaders_all_platforms(
    TARGET collision_shaders
    PROJECT_NAME "Collision"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/collision.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/collision.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/collision
)
# DirectXMath is the Windows SDK's; elsewhere (Android, Linux) it is fetched at configure time
# (DIRECTXMATH_FETCH_TAG; headers only, not its CMake project), with core/sal/sal.h for the
# annotations it uses.
if (NOT WIN32)
    set(DIRECTXMATH_FETCH_TAG "jun2026" CACHE STRING "Git tag of DirectXMath, which collision uses on Android")
    FetchContent_Declare(directxmath
        GIT_REPOSITORY https://github.com/microsoft/DirectXMath.git
        GIT_TAG ${DIRECTXMATH_FETCH_TAG}
        GIT_SHALLOW TRUE
        SOURCE_SUBDIR Inc)
    FetchContent_MakeAvailable(directxmath)
    set_source_files_properties(core/directx_collision.cpp PROPERTIES
        INCLUDE_DIRECTORIES "${directxmath_SOURCE_DIR}/Inc;${CMAKE_CURRENT_SOURCE_DIR}/core/sal")
endif()
add_tslang_example(collision core/matrix.ts core/directx_collision.ts core/directx_collision.cpp MEDIA fonts)
add_tslang_example_test(collision)

# Port of NVIDIA's DXR tutorial 14 (Refit, github.com/NVIDIAGameWorks/DxrTutorials): three
# triangles and a plane, two rotating, ray traced with per-instance colors and shadow rays; the
# top-level acceleration structure refitted in place every frame. Needs D3D12 or Vulkan.
donut_compile_shaders(
    TARGET dxr_refit_shaders
    PROJECT_NAME "DXR Refit"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dxr_refit.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dxr_refit.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/dxr_refit/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/dxr_refit/spirv
)
add_tslang_example(dxr_refit)
add_tslang_example_test(dxr_refit)

# Port of DirectX-Graphics-Samples' D3D12RaytracingProceduralGeometry: procedural geometry in AABBs
# (analytic, volumetric metaballs, signed distance fields and a fractal) intersected by
# intersection shaders, over a checkered plane, with reflection and shadow rays and a hit group
# per AABB geometry and ray type. Needs D3D12 or Vulkan.
donut_compile_shaders(
    TARGET procedural_geometry_shaders
    PROJECT_NAME "Procedural Geometry"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/procedural_geometry.cfg
    SOURCES
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/procedural_geometry.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/procedural_geometry_compat.h
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/procedural_geometry_helper.hlsli
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/procedural_geometry_primitives.hlsli
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/procedural_geometry_analytic.hlsli
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/procedural_geometry_volumetric.hlsli
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/procedural_geometry_sdf.hlsli
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/procedural_geometry_fractals.hlsli
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/procedural_geometry/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/procedural_geometry/spirv
)
add_tslang_example(procedural_geometry core/directx_math.ts)
add_tslang_example_test(procedural_geometry)

# Copies files of a DirectX-Graphics-Samples checkout (DIRECTX_GRAPHICS_SAMPLES_DIR; paths relative
# to it) into media/<dir> for an example, if the checkout is set.
set(DIRECTX_GRAPHICS_SAMPLES_DIR "" CACHE PATH "DirectX-Graphics-Samples checkout (github.com/microsoft/DirectX-Graphics-Samples)")
function(add_dxgs_media target dir)
    if (NOT DIRECTX_GRAPHICS_SAMPLES_DIR)
        return()
    endif()
    set(outputs)
    foreach(file ${ARGN})
        get_filename_component(name "${file}" NAME)
        set(source "${DIRECTX_GRAPHICS_SAMPLES_DIR}/${file}")
        set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/${dir}/${name}")
        add_custom_command(OUTPUT "${output}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${source}" "${output}"
            DEPENDS "${source}"
            COMMENT "Copying ${name}"
            VERBATIM)
        list(APPEND outputs "${output}")
    endforeach()
    add_custom_target(${target}_media DEPENDS ${outputs})
    add_dependencies(${target} ${target}_media)
endfunction()

# Port of DirectX-Graphics-Samples' D3D12RaytracingOpacityMicromaps: an alpha-tested tree (its
# leaves' any-hit shader samples an alpha texture) ray traced with shadow rays, its leaves'
# triangles carrying opacity micromaps baked offline (2- or 4-state, subdivision levels 1 to 12)
# that settle most hits without the any-hit shader; keys toggle the micromaps, their format and
# level, the any-hit shader, a view of where it ran, and rebuilding the acceleration structures
# every frame. D3D12 needs raytracing tier 1.2 (the Agility SDK runtime, with NVRHI's DXR 1.2
# path), Vulkan VK_EXT_opacity_micromap. Its model, micromaps and textures (~190 MB) are the
# sample's: point DIRECTX_GRAPHICS_SAMPLES_DIR at a DirectX-Graphics-Samples checkout. With -bake
# (WITH_OMM_SDK) the micromaps are baked at run time instead, by the Opacity Micro-Map SDK's GPU
# baker (core/omm_bake.cpp).
donut_compile_shaders(
    TARGET opacity_micromaps_shaders
    PROJECT_NAME "Opacity Micromaps"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/opacity_micromaps.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/opacity_micromaps.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/opacity_micromaps/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/opacity_micromaps/spirv
)
if (NVRHI_WITH_DX12)
    add_tslang_example(opacity_micromaps core/directx_math.ts core/omm_bake.ts core/omm_bake.cpp core/d3d12_agility_sdk.cpp
        MEDIA fonts opacity_micromaps)
else()
    add_tslang_example(opacity_micromaps core/directx_math.ts core/omm_bake.ts core/omm_bake.cpp MEDIA fonts opacity_micromaps)
endif()
target_link_libraries(opacity_micromaps PRIVATE ${OMM_SDK_LIBRARIES})
add_tslang_example_test(opacity_micromaps)
if (OMM_SDK_LIBRARIES)
    # -bake: the micromaps baked at run time by the Opacity Micro-Map SDK's GPU baker rather than
    # loaded from the sample's files.
    add_tslang_example_test(opacity_micromaps SUFFIX bake ARGS -bake)
endif()
set(omm_media)
set(omm_dir "Samples/Desktop/D3D12Raytracing/src/D3D12RaytracingOpacityMicromaps")
foreach(file treeModel.bin jacaranda_tree_leaves_alpha_4k.dds jacaranda_tree_trunk_diff_4k.dds
        jacaranda_tree_branches_diff_4k.dds jacaranda_tree_leaves_diff_4k.dds)
    list(APPEND omm_media "${omm_dir}/${file}")
endforeach()
foreach(level RANGE 1 12)
    list(APPEND omm_media "${omm_dir}/treeOMM_SubD${level}_2State.bin" "${omm_dir}/treeOMM_SubD${level}_4State.bin")
endforeach()
add_dxgs_media(opacity_micromaps opacity_micromaps ${omm_media})

# Port of DirectX-Graphics-Samples' D3D12MeshShaders MeshletRender: the Stanford dragon drawn by a
# mesh shader alone (a group per meshlet, no vertex or index buffers bound), each meshlet in a color
# of its own. Its model is the sample's meshlet file (core/meshlet_model.cpp reads it), from
# DIRECTX_GRAPHICS_SAMPLES_DIR. Mesh shaders need D3D12 or Vulkan, so no DXBC.
donut_compile_shaders(
    TARGET meshlet_render_shaders
    PROJECT_NAME "Meshlet Render"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/meshlet_render.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/meshlet_render.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/meshlet_render/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/meshlet_render/spirv
    SHADERMAKE_OPTIONS_SPIRV "--spirvExt SPV_EXT_mesh_shader"
)
add_tslang_example(meshlet_render core/simple_camera.ts core/directx_math.ts core/meshlet_model.ts core/meshlet_model.cpp MEDIA meshlet_render)
add_dxgs_media(meshlet_render meshlet_render Samples/Desktop/D3D12MeshShaders/src/Assets/Dragon_LOD0.bin)
add_tslang_example_test(meshlet_render)

# Port of DirectX-Graphics-Samples' D3D12MeshShaders MeshletCull: amplification shaders cull the
# dragon's meshlets against a second camera's frustum and by their normal cones; that camera's
# frustum and model are drawn, the meshlet under the mouse highlighted (a ray cast on the CPU) and,
# selected with Tab, its bounding sphere and normal cone drawn by mesh shaders. Its models are the
# sample's (core/meshlet_model.cpp), from DIRECTX_GRAPHICS_SAMPLES_DIR. Mesh shaders need D3D12 or
# Vulkan, so no DXBC.
donut_compile_shaders(
    TARGET meshlet_cull_shaders
    PROJECT_NAME "Meshlet Cull"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/meshlet_cull.cfg
    SOURCES
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/meshlet_cull.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/meshlet_cull_visualizers.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/meshlet_cull/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/meshlet_cull/spirv
    SHADERMAKE_OPTIONS_SPIRV "--spirvExt SPV_EXT_mesh_shader"
)
add_tslang_example(meshlet_cull core/directx_math.ts core/meshlet_model.ts core/meshlet_model.cpp MEDIA meshlet_cull)
add_dxgs_media(meshlet_cull meshlet_cull
    Samples/Desktop/D3D12MeshShaders/src/Assets/Dragon_LOD0.bin
    Samples/Desktop/D3D12MeshShaders/src/Assets/Camera.bin)
add_tslang_example_test(meshlet_cull)

# Port of DirectX-Graphics-Samples' D3D12MeshShaders MeshletInstancing: a cube of toy robots drawn by a
# mesh shader alone, a group per meshlet and instance, several instances of each subset's last meshlet
# packed into one group, in batches of at most 65536 groups. Its model is the sample's
# (core/meshlet_model.cpp), from DIRECTX_GRAPHICS_SAMPLES_DIR. Mesh shaders need D3D12 or Vulkan, so
# no DXBC.
donut_compile_shaders(
    TARGET meshlet_instancing_shaders
    PROJECT_NAME "Meshlet Instancing"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/meshlet_instancing.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/meshlet_instancing.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/meshlet_instancing/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/meshlet_instancing/spirv
    SHADERMAKE_OPTIONS_SPIRV "--spirvExt SPV_EXT_mesh_shader"
)
add_tslang_example(meshlet_instancing core/simple_camera.ts core/directx_math.ts core/meshlet_model.ts core/meshlet_model.cpp MEDIA meshlet_instancing)
add_dxgs_media(meshlet_instancing meshlet_instancing Samples/Desktop/D3D12MeshShaders/src/Assets/ToyRobot.bin)
add_tslang_example_test(meshlet_instancing)

# Port of DirectX-Graphics-Samples' D3D12MeshShaders DynamicLOD: a cube of dragons, an amplification
# shader thread per dragon culling it and picking one of six levels of detail by its size on screen,
# then mesh shader groups reading that LOD's meshlets from arrays of buffers. Its models are the
# sample's (core/meshlet_model.cpp), from DIRECTX_GRAPHICS_SAMPLES_DIR. Mesh shaders need D3D12 or
# Vulkan, so no DXBC.
donut_compile_shaders(
    TARGET dynamic_lod_shaders
    PROJECT_NAME "Dynamic LOD"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dynamic_lod.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dynamic_lod.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/dynamic_lod/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/dynamic_lod/spirv
    SHADERMAKE_OPTIONS_SPIRV "--spirvExt SPV_EXT_mesh_shader"
)
add_tslang_example(dynamic_lod core/simple_camera.ts core/directx_math.ts core/meshlet_model.ts core/meshlet_model.cpp MEDIA dynamic_lod)
set(dynamic_lod_media)
foreach(level RANGE 0 5)
    list(APPEND dynamic_lod_media "Samples/Desktop/D3D12MeshShaders/src/Assets/Dragon_LOD${level}.bin")
endforeach()
add_dxgs_media(dynamic_lod dynamic_lod ${dynamic_lod_media})
add_tslang_example_test(dynamic_lod)

# Port of DirectX-Graphics-Samples' D3D12ExecuteIndirect: 1024 triangles drawn by one indirect call,
# a compute shader first culling their commands to the middle of the screen and the call taking their
# count from a buffer (Vulkan's drawIndirectCount). The sample's per-command root CBVs are instance
# indices here (see shaders/execute_indirect.hlsl). D3D12 or Vulkan (D3D11 has no indirect counts).
donut_compile_shaders(
    TARGET execute_indirect_shaders
    PROJECT_NAME "Execute Indirect"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/execute_indirect.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/execute_indirect.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/execute_indirect/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/execute_indirect/spirv
)
add_tslang_example(execute_indirect core/random.ts core/directx_math.ts)
add_tslang_example_test(execute_indirect)

# Port of DirectX-Graphics-Samples' D3D12DynamicIndexing: 120 copies of a city, each draw's pixel shader
# picking the city's material from an array of 120 textures by an index set per draw. Its data file
# (the city's mesh and BC1 texture) is the sample's, from DIRECTX_GRAPHICS_SAMPLES_DIR. Texture arrays
# need D3D12 or Vulkan here, so no DXBC.
donut_compile_shaders(
    TARGET dynamic_indexing_shaders
    PROJECT_NAME "Dynamic Indexing"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dynamic_indexing.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/dynamic_indexing.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/dynamic_indexing/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/dynamic_indexing/spirv
)
add_tslang_example(dynamic_indexing core/directx_math.ts core/simple_camera.ts MEDIA dynamic_indexing)
add_dxgs_media(dynamic_indexing dynamic_indexing Samples/Desktop/D3D12DynamicIndexing/src/occcity.bin)
add_tslang_example_test(dynamic_indexing)

# Port of DirectX-Graphics-Samples' D3D12HDR: SDR and HDR gradients and the Rec.709 and Rec.2020 gamuts
# drawn linearly into a float target and presented with the display's curve (sRGB, ST.2084 for
# HDR10, linear for scRGB), the back buffers' format switched at run time (8-bit, R10G10B10A2,
# RGBA16_FLOAT), the UI's text composed over the scene. Its tests run each format. D3D12 or Vulkan
# (D3D11 can't change the back buffers' format here).
donut_compile_shaders(
    TARGET hdr_display_shaders
    PROJECT_NAME "HDR Display"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/hdr_display.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/hdr_display.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/hdr_display/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/hdr_display/spirv
)
add_tslang_example(hdr_display MEDIA fonts)
add_tslang_example_test(hdr_display)
add_tslang_example_test(hdr_display SUFFIX 10bit ARGS -testFormat 10)
add_tslang_example_test(hdr_display SUFFIX 16bit ARGS -testFormat 16)

# Port of DirectX-Graphics-Samples' D3D12nBodyGravity: two clusters of 5000 particles, every particle
# pulling on every other, stepped by a compute shader on the compute queue and drawn as additive point
# sprites a geometry shader expands.
donut_compile_shaders(
    TARGET n_body_gravity_shaders
    PROJECT_NAME "n-Body Gravity"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/n_body_gravity.cfg
    SOURCES
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/n_body_gravity_draw.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/n_body_gravity_cs.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/n_body_gravity/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/n_body_gravity/spirv
)
add_tslang_example(n_body_gravity core/random.ts core/simple_camera.ts core/directx_math.ts)
add_tslang_example_test(n_body_gravity)

# Copies a folder of the DirectX-Graphics-Samples checkout into an example's media folder, whole.
function(add_dxgs_media_directory target dir source_dir)
    if (NOT DIRECTX_GRAPHICS_SAMPLES_DIR)
        return()
    endif()
    get_filename_component(name "${source_dir}" NAME)
    set(stamp "${CMAKE_CURRENT_BINARY_DIR}/${target}_${name}_media.stamp")
    file(GLOB_RECURSE sources "${DIRECTX_GRAPHICS_SAMPLES_DIR}/${source_dir}/*")
    add_custom_command(OUTPUT "${stamp}"
        COMMAND "${CMAKE_COMMAND}" -E copy_directory "${DIRECTX_GRAPHICS_SAMPLES_DIR}/${source_dir}"
            "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/${dir}/${name}"
        COMMAND "${CMAKE_COMMAND}" -E touch "${stamp}"
        DEPENDS ${sources}
        COMMENT "Copying ${name}"
        VERBATIM)
    add_custom_target(${target}_${name}_media DEPENDS "${stamp}")
    add_dependencies(${target} ${target}_${name}_media)
endfunction()

# Port of DirectX-Graphics-Samples' D3D12RaytracingRealTimeDenoisedAmbientOcclusion: ray traced
# ambient occlusion at one ray per pixel, denoised spatio-temporally (reverse reprojection into a
# temporal cache, variance-guided blending, an edge-stopping a-trous filter, a disocclusion blur),
# over a scene of PBRT models (a house, cars, a dragon, a spaceship: the sample's parser, in
# core/pbrt) and procedural grass a compute shader regenerates every frame; a specular path tracer
# makes the G-buffer. Its assets (~140 MB) are the sample's, from DIRECTX_GRAPHICS_SAMPLES_DIR.
# Ray tracing pipelines: D3D12 or Vulkan. Windows only: the textures are loaded through WIC, and the
# PBRT parser takes its definitions from windows.h.
if (WIN32)
    file(GLOB DENOISED_RTAO_SHADER_SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/denoised_rtao/*)
    donut_compile_shaders(
        TARGET denoised_rtao_shaders
        PROJECT_NAME "Denoised RTAO"
        CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/denoised_rtao.cfg
        SOURCES ${DENOISED_RTAO_SHADER_SOURCES}
        DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/denoised_rtao/dxil
        SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/denoised_rtao/spirv
        SHADERMAKE_OPTIONS_SPIRV "--vulkanMemoryLayout dx"
    )
    add_tslang_example(denoised_rtao core/directx_math.ts core/pbrt_scene.ts core/denoised_rtao.cpp core/pbrt/PBRTParser.cpp core/pbrt/PlyParser.cpp
        MEDIA denoised_rtao)
    add_dxgs_media_directory(denoised_rtao denoised_rtao
        Samples/Desktop/D3D12Raytracing/src/D3D12RaytracingRealTimeDenoisedAmbientOcclusion/Assets)
    add_tslang_example_test(denoised_rtao)
    add_tslang_example_test(denoised_rtao SUFFIX raw ARGS -raw)
    add_tslang_example_test(denoised_rtao SUFFIX shaded ARGS -shaded)
endif()

# Port of DirectX-Graphics-Samples' D3D12Multithreading: a room of 1025 draws lit by three moving
# spotlights, the first casting shadows, its shadow pass and scene pass recorded by three worker
# threads into command lists of their own (DrawBatch in core/donut_interop.cpp). Its data file
# (SquidRoom.bin: the mesh and 74 textures; core/squid_room.ts says where) is the sample's, from
# DIRECTX_GRAPHICS_SAMPLES_DIR. Command lists recorded on other threads: D3D12 or Vulkan.
donut_compile_shaders(
    TARGET multithreading_shaders
    PROJECT_NAME "Multithreading"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/multithreading.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/multithreading.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/multithreading/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/multithreading/spirv
)
add_tslang_example(multithreading core/directx_math.ts core/squid_room.ts MEDIA multithreading)
add_dxgs_media(multithreading multithreading Samples/Desktop/D3D12Multithreading/src/SquidRoom.bin)
add_tslang_example_test(multithreading)
add_tslang_example_test(multithreading SUFFIX single_threaded ARGS -singleThreaded)

# Port of DirectX-Graphics-Samples' D3D12Bundles: 30 copies of a city drawn with two pipeline states
# taking turns, from a bundle recorded once (a draw batch here: DrawBatch in core/donut_interop.cpp)
# that every frame executes. Its data file (the city's mesh and BC1 texture) is the sample's, from
# DIRECTX_GRAPHICS_SAMPLES_DIR. D3D12 or Vulkan here, as the other DirectX-Graphics-Samples ports.
donut_compile_shaders(
    TARGET bundles_shaders
    PROJECT_NAME "Bundles"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/bundles.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/bundles.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/bundles/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/bundles/spirv
)
add_tslang_example(bundles core/directx_math.ts core/simple_camera.ts MEDIA bundles)
add_dxgs_media(bundles bundles Samples/Desktop/D3D12Bundles/src/occcity.bin)
add_tslang_example_test(bundles)

# Port of DirectX-Graphics-Samples' D3D12RaytracingSimpleLighting: a ray traced cube lit by a point
# light circling it, the closest hit shader interpolating the hit triangle's vertex normals (found
# through its 16-bit indices). Ray tracing pipelines: D3D12 or Vulkan. The vertices' 24-byte struct
# keeps its D3D layout in SPIR-V (--vulkanMemoryLayout dx).
donut_compile_shaders(
    TARGET raytracing_simple_lighting_shaders
    PROJECT_NAME "Raytracing Simple Lighting"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/raytracing_simple_lighting.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/raytracing_simple_lighting.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/raytracing_simple_lighting/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/raytracing_simple_lighting/spirv
    SHADERMAKE_OPTIONS_SPIRV "--vulkanMemoryLayout dx"
)
add_tslang_example(raytracing_simple_lighting core/directx_math.ts)
add_tslang_example_test(raytracing_simple_lighting)

# Port of DirectX-Graphics-Samples' D3D12RaytracingLibrarySubobjects: the Simple Lighting cube (lit
# green), its ray tracing state object made of the DXIL library alone, whose HLSL defines the
# subobjects: the global and local root signatures, the association, the hit group, the shader and
# pipeline configs. DXIL subobjects: D3D12 only, through D3D12 directly
# (Donut_CreateD3D12LibraryRtPipeline).
if (NVRHI_WITH_DX12)
    donut_compile_shaders(
        TARGET raytracing_library_subobjects_shaders
        PROJECT_NAME "Raytracing Library Subobjects"
        CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/raytracing_library_subobjects.cfg
        SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/raytracing_library_subobjects.hlsl
        DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/raytracing_library_subobjects/dxil
    )
    add_tslang_example(raytracing_library_subobjects core/directx_math.ts)
    add_tslang_example_test(raytracing_library_subobjects APIS dx12)
endif()

# Port of DirectX-Graphics-Samples' D3D12HelloGenericPrograms: a triangle drawn twice with generic
# programs (graphics pipelines made as state objects from shaders and subobjects) instead of
# pipeline state objects, the second program added to the first one's state object. D3D12 only,
# shader model 6.8: the Agility SDK runtime (core/d3d12_agility_sdk.cpp).
if (NVRHI_WITH_DX12)
    donut_compile_shaders(
        TARGET generic_programs_shaders
        PROJECT_NAME "Generic Programs"
        CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/generic_programs.cfg
        SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/generic_programs.hlsl
        DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/generic_programs/dxil
    )
    add_tslang_example(generic_programs core/d3d12_agility_sdk.cpp)
    add_tslang_example_test(generic_programs APIS dx12)
endif()

# Port of DirectX-Graphics-Samples' D3D12RaytracingSakuraForestSER: a ray traced forest (13525
# instances: floor cubes, reflective cubes, trees, bushes) under a fractal sky, its primary rays
# traced into hit objects and reordered (MaybeReorderThread) by the hit, a reflection hint, or both.
# D3D12 only (shader model 6.9 hit objects, the Agility SDK runtime); the state object comes from
# the DXIL library's subobjects (the sample builds them in C++), its OBJ models load with the
# sample's loader (core/obj_model.cpp). Its models and textures come from DIRECTX_GRAPHICS_SAMPLES_DIR,
# a checkout from August 2025 or later (the sample is newer than some). The tests fix the
# random forest's seeds and run each sort mode.
if (NVRHI_WITH_DX12)
    donut_compile_shaders(
        TARGET sakura_forest_ser_shaders
        PROJECT_NAME "Sakura Forest SER"
        CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/sakura_forest_ser.cfg
        SOURCES
            ${CMAKE_CURRENT_SOURCE_DIR}/shaders/sakura_forest_ser.hlsl
            ${CMAKE_CURRENT_SOURCE_DIR}/shaders/sakura_forest_ser_star.hlsli
        DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/sakura_forest_ser/dxil
        SHADER_MODEL 6_9
    )
    add_tslang_example(sakura_forest_ser core/directx_math.ts core/obj_model.ts core/obj_model.cpp core/d3d12_agility_sdk.cpp
        MEDIA fonts)
    set(sakura_dir "Samples/Desktop/D3D12Raytracing/src/D3D12RaytracingSakuraForestSER")
    if (DIRECTX_GRAPHICS_SAMPLES_DIR AND NOT EXISTS "${DIRECTX_GRAPHICS_SAMPLES_DIR}/${sakura_dir}")
        message(STATUS "sakura_forest_ser: ${DIRECTX_GRAPHICS_SAMPLES_DIR} has no ${sakura_dir} (an older checkout): no media")
    else()
        add_dxgs_media(sakura_forest_ser sakura_forest_ser ${sakura_dir}/trunk.obj ${sakura_dir}/leaves.obj ${sakura_dir}/bush.obj
            ${sakura_dir}/tree-trunk.jpg ${sakura_dir}/bush-texture.jpg)
    endif()
    foreach(mode 0 1 2 3)
        add_tslang_example_test(sakura_forest_ser SUFFIX sort${mode} APIS dx12 ARGS -seed 1 2 -sortMode ${mode})
    endforeach()
endif()

# Port of DirectX-Graphics-Samples' D3D12MemoryManagement: a grid of large images (TileGrid.dds and
# 4096 x 4096 generated checkerboards) streamed into video memory a mip level at a time under the
# process's DXGI budget: reserved textures, each level backed by heaps of its own, mapped and filled
# on a copy queue by a paging thread that makes them resident again (MakeResident) or evicts them
# (Evict) by priority (core/paged_images.cpp). D3D12 only. TileGrid.dds comes from
# DIRECTX_GRAPHICS_SAMPLES_DIR (without it, only the generated images). The tests: everything paged
# in under the kernel's budget (a 16 GB card's), paging under a 512 MB override, and trimming to it
# once everything is in.
if (NVRHI_WITH_DX12)
    donut_compile_shaders(
        TARGET memory_management_shaders
        PROJECT_NAME "Memory Management"
        CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/memory_management.cfg
        SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/memory_management.hlsl
        DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/memory_management/dxil
    )
    add_tslang_example(memory_management core/paged_images.ts core/paged_images.cpp MEDIA fonts)
    add_dxgs_media(memory_management memory_management TechniqueDemos/D3D12MemoryManagement/src/TileGrid.dds)
    add_tslang_example_test(memory_management APIS dx12)
    add_tslang_example_test(memory_management SUFFIX budget APIS dx12 ARGS -budget 512)
    add_tslang_example_test(memory_management SUFFIX trim APIS dx12 ARGS -budget 512 -budgetFrame 10)
endif()

# Port of DirectX-Graphics-Samples' D3D12SM6WaveIntrinsics: a triangle whose pixels show wave
# intrinsics at work (lane indices, first and last lanes, active lanes, broadcasts, reductions,
# prefix sums, quad shuffles; keys 1-9), composed with a UI layer and magnified around the mouse
# while its left button is down. Shader model 6 wave intrinsics: D3D12 or Vulkan, so no DXBC.
donut_compile_shaders(
    TARGET wave_intrinsics_shaders
    PROJECT_NAME "Wave Intrinsics"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/wave_intrinsics.cfg
    SOURCES
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/wave_intrinsics.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/wave_intrinsics_magnify.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/wave_intrinsics/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/wave_intrinsics/spirv
)
add_tslang_example(wave_intrinsics MEDIA fonts)
add_tslang_example_test(wave_intrinsics)

# Port of DirectX-Graphics-Samples' D3D12DepthBoundsTest: a triangle at depths 0.1 to 0.9 drawn into
# the depth buffer, then again with depth testing off and the depth bounds test on (an NVRHI patch
# adds it, see DONUT_NVRHI_PATCHES above), animated bounds keeping only part of it. D3D12 and Vulkan
# have the test; D3D11 draws the whole triangle, as the sample without it.
donut_compile_shaders_all_platforms(
    TARGET depth_bounds_test_shaders
    PROJECT_NAME "Depth Bounds Test"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/depth_bounds_test.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/depth_bounds_test.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/depth_bounds_test
)
add_tslang_example(depth_bounds_test)
add_tslang_example_test(depth_bounds_test)

# Port of DirectX-Graphics-Samples' D3D12PredicationQueries: a translucent quad moving across a far
# one, which is drawn only if the previous frame's binary occlusion query found its bounding box
# visible: occlusion queries resolved on the GPU into the values that predicate the draw (D3D12's
# predication, Vulkan's VK_EXT_conditional_rendering). Not D3D11.
donut_compile_shaders(
    TARGET predication_queries_shaders
    PROJECT_NAME "Predication Queries"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/predication_queries.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/predication_queries.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/predication_queries/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/predication_queries/spirv
)
add_tslang_example(predication_queries)
add_tslang_example_test(predication_queries)

# Port of DirectX-Graphics-Samples' D3D12SmallResources: 77 small (32 x 32) textures, either placed
# in one heap at D3D12's 4 KB small resource alignment or created as committed resources (64 KB each);
# Space switches, the window title shows the GPU memory in use. D3D12 and Vulkan.
donut_compile_shaders(
    TARGET small_resources_shaders
    PROJECT_NAME "Small Resources"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/small_resources.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/small_resources.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/small_resources/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/small_resources/spirv
)
add_tslang_example(small_resources core/random.ts)
add_tslang_example_test(small_resources)

# Port of DirectX-Graphics-Samples' D3D12ReservedResources: a quad sampling one level of a reserved
# (tiled) 256 x 256 texture; the arrow keys pick the level, whose tiles get mapped to its own heap
# (the packed levels of the mip tail to one shared heap) while the previous level's are unmapped.
# D3D12 (tiled resources) or Vulkan (sparse residency). The tests step from the last level to level
# 0 (a level of whole tiles) and to level 3 (packed into the mip tail on NVIDIA's D3D12).
donut_compile_shaders(
    TARGET reserved_resources_shaders
    PROJECT_NAME "Reserved Resources"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/reserved_resources.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/reserved_resources.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/reserved_resources/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/reserved_resources/spirv
)
add_tslang_example(reserved_resources)
add_tslang_example_test(reserved_resources)
add_tslang_example_test(reserved_resources SUFFIX packed ARGS -mip 3)

# Port of Donut-Samples' rt_bindless: bindless ray tracing of an animated scene (see
# DONUT_SAMPLES_MEDIA_DIR above), with a ray tracing pipeline or, with -rayQuery, inline ray
# queries in a compute shader. Ray tracing needs D3D12 or Vulkan, so no DXBC.
donut_compile_shaders(
    TARGET rt_bindless_shaders
    PROJECT_NAME "Bindless Ray Tracing"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rt_bindless.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rt_bindless.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rt_bindless/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rt_bindless/spirv
)
add_tslang_example(rt_bindless core/matrix.ts MEDIA sponza-plus.scene.json glTF-Sample-Assets/Models/Sponza glTF-Sample-Assets/Models/BrainStem)
add_tslang_example_test(rt_bindless)

# Port of Donut-Samples' bindless_rendering: Sponza (see DONUT_SAMPLES_MEDIA_DIR above) drawn with
# no vertex or index buffers bound, the vertex shader fetching them, and the pixel shader the
# material textures, from the scene's bindless buffer and texture arrays. Bindless needs D3D12 or
# Vulkan, so no DXBC.
donut_compile_shaders(
    TARGET bindless_rendering_shaders
    PROJECT_NAME "Bindless Rendering"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/bindless_rendering.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/bindless_rendering.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/bindless_rendering/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/bindless_rendering/spirv
)
add_tslang_example(bindless_rendering core/matrix.ts MEDIA glTF-Sample-Assets/Models/Sponza)
add_tslang_example_test(bindless_rendering)

# Donut's forward shading of Sponza (see DONUT_SAMPLES_MEDIA_DIR above) under an environment map
# (Donut's EnvironmentMapPass), its sun's shadows from a PlanarShadowMap fitted to the whole scene.
# The environment map is rt_particles' lat-long BC7 DDS, or with -ktx2 the KTX 2 file
# tools/dds_to_ktx2.py makes of it here (the same blocks, through Donut's KTX 2 loader). No shaders
# of its own; all APIs.
add_tslang_example(environment_map core/matrix.ts MEDIA glTF-Sample-Assets/Models/Sponza rt_particles)
add_tslang_example_test(environment_map)
find_package(Python3 REQUIRED COMPONENTS Interpreter)
set(source "${CMAKE_CURRENT_SOURCE_DIR}/media/rt_particles/environment-map.dds")
set(output "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/environment_map/environment-map.ktx2")
add_custom_command(OUTPUT "${output}"
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/media/environment_map"
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/dds_to_ktx2.py" "${source}" "${output}"
    DEPENDS "${source}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/dds_to_ktx2.py"
    COMMENT "Converting environment-map.dds to KTX 2"
    VERBATIM)
add_custom_target(environment_map_media DEPENDS "${output}")
add_dependencies(environment_map environment_map_media)

# Port of Donut-Samples' rt_reflections: ray traced shadows and reflections on Sponza (see
# DONUT_SAMPLES_MEDIA_DIR above). D3D12 only, as in the sample: its hit groups use local
# binding layouts (local root signatures), so no SPIR-V.
donut_compile_shaders(
    TARGET rt_reflections_shaders
    PROJECT_NAME "Ray Traced Reflections"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rt_reflections.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rt_reflections.hlsl
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rt_reflections/dxil
)
add_tslang_example(rt_reflections core/matrix.ts MEDIA glTF-Sample-Assets/Models/Sponza)
add_tslang_example_test(rt_reflections)

# Port of Donut-Samples' rt_particles: ray query rendering of billboard and intersection
# particles with multi-layer alpha blending (see DONUT_SAMPLES_MEDIA_DIR above), with an ImGui
# settings window. D3D12 or Vulkan.
donut_compile_shaders(
    TARGET rt_particles_shaders
    PROJECT_NAME "Ray Traced Particles"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rt_particles.cfg
    SOURCES
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rt_particles.hlsl
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rt_particles_geometry.hlsli
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rt_particles_mlab.hlsli
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rt_particles_utils.hlsli
        ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rt_particles_cb.h
    DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rt_particles/dxil
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rt_particles/spirv
)
add_tslang_example(rt_particles core/random.ts core/matrix.ts MEDIA rt_particles nvidia-logo.png)
add_tslang_example_test(rt_particles)

# Port of Donut-Samples' work_graphs: deferred shading of a procedural scene with one D3D12 work
# graph (light culling and per-material shading nodes), or with two compute dispatches. D3D12 only,
# shader model 6.8, and the Agility SDK runtime (core/d3d12_agility_sdk.cpp exports its version).
if (NVRHI_WITH_DX12)
    donut_compile_shaders(
        TARGET work_graphs_shaders
        PROJECT_NAME "Work Graphs"
        CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/work_graphs.cfg
        SOURCES
            ${CMAKE_CURRENT_SOURCE_DIR}/shaders/work_graphs_animation.hlsl
            ${CMAKE_CURRENT_SOURCE_DIR}/shaders/work_graphs_gbuffer_fill.hlsl
            ${CMAKE_CURRENT_SOURCE_DIR}/shaders/work_graphs_light_culling.hlsl
            ${CMAKE_CURRENT_SOURCE_DIR}/shaders/work_graphs_deferred_shading.hlsl
            ${CMAKE_CURRENT_SOURCE_DIR}/shaders/work_graphs_broadcasting.hlsl
            ${CMAKE_CURRENT_SOURCE_DIR}/shaders/work_graphs_scene_data.hlsli
            ${CMAKE_CURRENT_SOURCE_DIR}/shaders/work_graphs_materials.hlsli
            ${CMAKE_CURRENT_SOURCE_DIR}/shaders/work_graphs_lighting.hlsli
        DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/work_graphs/dxil
        SHADER_MODEL 6_8
    )
    add_tslang_example(work_graphs core/random.ts core/matrix.ts core/d3d12_agility_sdk.cpp)
    add_tslang_example_test(work_graphs APIS dx12)
endif()

# Port of Donut-Samples' feature_demo: Donut's full renderer (deferred or forward shading, cascaded
# shadows, SSAO, procedural sky, TAA or MSAA, bloom, tone mapping, light probes, material picking)
# over a loaded scene, with an ImGui settings window and material editor; DLSS with
# DONUT_WITH_DLSS=ON. No shaders of its own; needs the scenes and fonts of DONUT_SAMPLES_MEDIA_DIR above.
add_tslang_example(feature_demo core/matrix.ts core/text_format.ts MEDIA fonts sponza-plus.scene.json glTF-Sample-Assets rt_particles)
add_tslang_example_test(feature_demo)
copy_dlss_library(feature_demo)

# NVIDIA's Real-Time Denoisers (NRD), the RTXCR checkout's: rtxcr_pathtracer's ReBLUR and ReLAX
# denoising. Built as RTXCR builds it (its external/CMakeLists.txt): the library without its shaders
# embedded, the shaders compiled to bin/shaders/nrd/<dxil|spirv> with the register shifts NRD's
# Vulkan bindings are made for. The encodings (NRD_NORMAL_ENCODING, NRD_ROUGHNESS_ENCODING) are
# written to the checkout's NRDConfig.hlsli, which NRD's shaders and rtxcr_pathtracer's denoiser
# shaders both include, so the three agree. NRD is under the same license as RTXCR: nothing of it
# is copied here.
if (RTXCR_DIR)
    set(RTXCR_NRD_DIR "${RTXCR_DIR}/external/RayTracingDenoiser")
    set(NRD_NORMAL_ENCODING "2" CACHE STRING "Normal encoding variant (0-4, matches nrd::NormalEncoding)")
    set(NRD_ROUGHNESS_ENCODING "1" CACHE STRING "Roughness encoding variant (0-2, matches nrd::RoughnessEncoding)")
    set(NRD_EMBEDS_SPIRV_SHADERS OFF CACHE BOOL "NRD embeds SPIRV shaders" FORCE)
    set(NRD_EMBEDS_DXIL_SHADERS OFF CACHE BOOL "NRD embeds DXIL shaders" FORCE)
    set(NRD_EMBEDS_DXBC_SHADERS OFF CACHE BOOL "NRD embeds DXBC shaders" FORCE)
    # A static library: under tslang's JIT donut_interop_shared.dll is loaded without its folder in the DLL
    # search path, so an NRD.dll beside it would not be found.
    set(NRD_STATIC_LIBRARY ON CACHE BOOL "Build static library" FORCE)
    add_subdirectory("${RTXCR_NRD_DIR}" "${CMAKE_BINARY_DIR}/nrd")

    file(GLOB_RECURSE NRD_SHADER_SOURCES CONFIGURE_DEPENDS "${RTXCR_NRD_DIR}/Shaders/*.hlsl" "${RTXCR_NRD_DIR}/Shaders/*.hlsli")
    get_target_property(NRD_MATHLIB_SOURCE_DIR MathLib SOURCE_DIR)
    set(NRD_SHADERMAKE_GENERAL "--flatten --stripReflection --WX --allResourcesBound -D NRD_INTERNAL")
    donut_compile_shaders(
        TARGET nrd_shaders
        PROJECT_NAME "NRD"
        CONFIG ${RTXCR_NRD_DIR}/Shaders/Shaders.cfg
        SOURCES ${NRD_SHADER_SOURCES}
        INCLUDES ${NRD_MATHLIB_SOURCE_DIR} ${RTXCR_NRD_DIR}/Shaders
        DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/nrd/dxil
        SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/nrd/spirv
        SHADERMAKE_OPTIONS_DXIL ${NRD_SHADERMAKE_GENERAL}
        SHADERMAKE_OPTIONS_SPIRV "${NRD_SHADERMAKE_GENERAL} --sRegShift 0 --bRegShift 2 --uRegShift 3 --tRegShift 20"
    )
    if (TARGET donut_interop_shared)
        target_link_libraries(donut_interop_shared PRIVATE NRD)
        add_dependencies(donut_interop_shared nrd_shaders)
    endif()
endif()

# Port of NVIDIA's RTX Character Rendering pathtracer sample (github.com/NVIDIA-RTX/RTXCR): a path
# tracer for hair and skin (the Claire scene). The sample is under the NVIDIA RTX SDKs License,
# which doesn't allow copying it into an open source repository, so nothing of it is copied: with
# RTXCR_DIR set to a checkout (with its submodules and assets pulled, see its README), the sample's
# shaders compile in place (shaders/rtxcr_pathtracer.cfg names them) and the example loads its
# scene from RTXCR_DIR/assets.
if (RTXCR_DIR)
    donut_compile_shaders(
        TARGET rtxcr_pathtracer_shaders
        PROJECT_NAME "RTXCR Pathtracer"
        CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rtxcr_pathtracer.cfg
        SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rtxcr_pathtracer.cfg
        INCLUDES
            ${RTXCR_DIR}/samples/pathtracer
            ${RTXCR_DIR}/libraries/rtxcr/material/shaders/include
            ${RTXCR_DIR}/libraries/rtxcr/geometry/shaders/include
            ${RTXCR_NRD_DIR}/Shaders
        DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rtxcr_pathtracer/dxil
        SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rtxcr_pathtracer/spirv
        SHADERMAKE_OPTIONS "--sourceDir ${RTXCR_DIR}/samples/pathtracer/shaders"
    )
    donut_compile_shaders(
        TARGET rtxcr_pathtracer_vs_shaders
        PROJECT_NAME "RTXCR Pathtracer Full-screen"
        CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rtxcr_pathtracer_vs.cfg
        SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rtxcr_pathtracer_vs.hlsl
        DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rtxcr_pathtracer/dxil
        SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rtxcr_pathtracer/spirv
    )
    add_tslang_example(rtxcr_pathtracer core/matrix.ts core/rtxcr_scene.ts core/rtxcr.cpp MEDIA fonts)
    add_dependencies(rtxcr_pathtracer rtxcr_pathtracer_vs_shaders nrd_shaders)
    target_link_libraries(rtxcr_pathtracer PRIVATE NRD)
    add_tslang_example_test(rtxcr_pathtracer ARGS -width 960 -height 540 --scene ${RTXCR_DIR}/assets/claire.scene.json)
    add_tslang_example_test(rtxcr_pathtracer SUFFIX animation
        ARGS -width 960 -height 540 -enableAnimation 1 --scene ${RTXCR_DIR}/assets/claire.animation.scene.json)
    # Denoised with NRD instead of accumulating: ReBLUR and ReLAX, the animated hair too.
    add_tslang_example_test(rtxcr_pathtracer SUFFIX nrd_reblur
        ARGS -width 960 -height 540 -denoiser 1 -nrdMode 0 -frames 32 --scene ${RTXCR_DIR}/assets/claire.scene.json)
    add_tslang_example_test(rtxcr_pathtracer SUFFIX nrd_relax
        ARGS -width 960 -height 540 -denoiser 1 -nrdMode 1 -frames 32 --scene ${RTXCR_DIR}/assets/claire.scene.json)
    add_tslang_example_test(rtxcr_pathtracer SUFFIX nrd_animation
        ARGS -width 960 -height 540 -denoiser 1 -nrdMode 0 -enableAnimation 1 --scene ${RTXCR_DIR}/assets/claire.animation.scene.json)
    # The hair's tessellation changed while rendering: from DOTS to polytubes, the animated hair too.
    add_tslang_example_test(rtxcr_pathtracer SUFFIX switch
        ARGS -width 960 -height 540 -hairTessellationType 1 -switchTessellation 0 --scene ${RTXCR_DIR}/assets/claire.scene.json)
    add_tslang_example_test(rtxcr_pathtracer SUFFIX animation_switch
        ARGS -width 960 -height 540 -hairTessellationType 1 -switchTessellation 0 -enableAnimation 1
        --scene ${RTXCR_DIR}/assets/claire.animation.scene.json)
    # D3D12: to and from linear swept spheres.
    add_tslang_example_test(rtxcr_pathtracer SUFFIX lss_switch APIS dx12
        ARGS -width 960 -height 540 -hairTessellationType 2 -switchTessellation 1 --scene ${RTXCR_DIR}/assets/claire.scene.json)
    add_tslang_example_test(rtxcr_pathtracer SUFFIX animation_lss_switch APIS dx12
        ARGS -width 960 -height 540 -hairTessellationType 1 -switchTessellation 2 -enableAnimation 1
        --scene ${RTXCR_DIR}/assets/claire.animation.scene.json)

    # The same scene rasterized (examples/rtxcr_raster.ts): Donut's forward shading pass with a pixel shader of its
    # own, which shades the hair with RTXCR's far-field hair BCSDF (RTXCR_DIR's material library, included).
    donut_compile_shaders(
        TARGET rtxcr_raster_shaders
        PROJECT_NAME "RTXCR Raster"
        CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rtxcr_raster.cfg
        SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rtxcr_raster_ps.hlsl
        INCLUDES ${RTXCR_DIR}/libraries/rtxcr/material/shaders/include
        DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rtxcr_raster/dxil
        SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rtxcr_raster/spirv
    )
    # The sample's morph target pass for the animated hair (polytubes, DOTS), compiled in place beside it.
    donut_compile_shaders(
        TARGET rtxcr_raster_morph_shaders
        PROJECT_NAME "RTXCR Raster Morph Targets"
        CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rtxcr_raster_morph.cfg
        SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rtxcr_raster_morph.cfg
        INCLUDES
            ${RTXCR_DIR}/samples/pathtracer
            ${RTXCR_DIR}/libraries/rtxcr/material/shaders/include
            ${RTXCR_DIR}/libraries/rtxcr/geometry/shaders/include
        DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rtxcr_raster/dxil
        SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rtxcr_raster/spirv
        SHADERMAKE_OPTIONS "--sourceDir ${RTXCR_DIR}/samples/pathtracer/shaders"
    )
    add_tslang_example(rtxcr_raster core/matrix.ts core/rtxcr_scene.ts core/rtxcr.cpp MEDIA fonts)
    add_dependencies(rtxcr_raster rtxcr_raster_shaders rtxcr_raster_morph_shaders)
    target_link_libraries(rtxcr_raster PRIVATE NRD)
    add_tslang_example_test(rtxcr_raster ARGS -width 960 -height 540 --scene ${RTXCR_DIR}/assets/claire.scene.json)
    add_tslang_example_test(rtxcr_raster SUFFIX dots
        ARGS -width 960 -height 540 -hairTessellationType 1 --scene ${RTXCR_DIR}/assets/claire.scene.json)
    # The animation scene's hair: morph target vertex buffers (no permanent state) the morph target pass writes.
    add_tslang_example_test(rtxcr_raster SUFFIX animation
        ARGS -width 960 -height 540 -enableAnimation 1 --scene ${RTXCR_DIR}/assets/claire.animation.scene.json)
    add_tslang_example_test(rtxcr_raster SUFFIX animation_dots
        ARGS -width 960 -height 540 -hairTessellationType 1 -enableAnimation 1
        --scene ${RTXCR_DIR}/assets/claire.animation.scene.json)
endif()

# Port of NVIDIA's RTX Path Tracing sample (github.com/NVIDIA-RTX/RTXPT): its reference path tracer, its
# real-time mode (NRD, TAA) and its game (SampleGame, core/rtxpt_game.ts; its props are read from the checkout's
# Assets/SampleGame at run time).
# Under the NVIDIA RTX SDKs License like RTXCR, so nothing of it is copied here: with RTXPT_DIR set to
# a checkout, the sample's renderer library (scene, materials, lights, environment map, the path tracer's
# run-time pipeline baker, tone mapping, accumulation: rtxpt_core) and its shaders compile in place;
# examples/rtxpt.ts is the sample's host (Sample.cpp) and core/rtxpt.cpp the glue.
if (RTXPT_DIR)
    # Tracy's headers: RTXPT's code marks profiler zones, which are empty without TRACY_ENABLE.
    FetchContent_Declare(tracy
        GIT_REPOSITORY https://github.com/wolfpld/tracy.git
        GIT_TAG v0.14.1
        GIT_SHALLOW TRUE
        SOURCE_SUBDIR do-not-build)
    FetchContent_MakeAvailable(tracy)

    # NRD (the real-time mode's denoiser, also under the NVIDIA RTX SDKs License): RTXPT's submodule, built
    # in place as a static library with RTXPT's settings (External/CMakeLists.txt). Its shaders are compiled
    # below by ShaderMake, not embedded; NRD's CMake fetches MathLib (its shaders' include).
    set(NRD_STATIC_LIBRARY ON CACHE BOOL "" FORCE)
    set(NRD_NORMAL_ENCODING "2" CACHE STRING "" FORCE)
    set(NRD_ROUGHNESS_ENCODING "1" CACHE STRING "" FORCE)
    set(NRD_IS_SUBMODULE ON)
    set(NRD_EMBEDS_SPIRV_SHADERS OFF CACHE BOOL "" FORCE)
    set(NRD_EMBEDS_DXIL_SHADERS OFF CACHE BOOL "" FORCE)
    set(NRD_EMBEDS_DXBC_SHADERS OFF CACHE BOOL "" FORCE)
    set(NRD_DISABLE_SHADER_COMPILATION ON CACHE BOOL "" FORCE)
    set(NRD_SHADERS_PATH "${CMAKE_BINARY_DIR}/NRDShaders" CACHE STRING "" FORCE)
    add_subdirectory(${RTXPT_DIR}/External/Nrd ${CMAKE_BINARY_DIR}/rtxpt_nrd EXCLUDE_FROM_ALL)
    get_target_property(RTXPT_MATHLIB_DIR MathLib SOURCE_DIR)

    set(RTXPT_SOURCE_DIR "${RTXPT_DIR}/Rtxpt")
    add_library(rtxpt_core STATIC
        ${RTXPT_SOURCE_DIR}/SampleCommon/SampleCommon.cpp
        ${RTXPT_SOURCE_DIR}/SampleCommon/ExtendedScene.cpp
        ${RTXPT_SOURCE_DIR}/SampleCommon/PTPipelineBaker.cpp
        ${RTXPT_SOURCE_DIR}/SampleCommon/ComputePipelineBaker.cpp
        ${RTXPT_SOURCE_DIR}/SampleCommon/ShaderCompilerUtils.cpp
        ${RTXPT_SOURCE_DIR}/SampleCommon/RenderTargets.cpp
        ${RTXPT_SOURCE_DIR}/SampleCommon/PackingUtils.cpp
        ${RTXPT_SOURCE_DIR}/SampleCommon/ComputePass.cpp
        ${RTXPT_SOURCE_DIR}/SampleCommon/BlasPool.cpp
        ${RTXPT_SOURCE_DIR}/SampleCommon/BlasCompactor.cpp
        ${RTXPT_SOURCE_DIR}/SampleCommon/GpuProfiler.cpp
        ${RTXPT_SOURCE_DIR}/SampleCommon/DirectoryModifiedMonitor.cpp
        ${RTXPT_SOURCE_DIR}/Lighting/LightsBaker.cpp
        ${RTXPT_SOURCE_DIR}/Lighting/Distant/EnvMapBaker.cpp
        ${RTXPT_SOURCE_DIR}/Lighting/Distant/EnvMapImportanceSamplingBaker.cpp
        ${RTXPT_SOURCE_DIR}/Lighting/Distant/SampleProceduralSky.cpp
        ${RTXPT_SOURCE_DIR}/Materials/MaterialsBaker.cpp
        ${RTXPT_SOURCE_DIR}/ToneMapper/ToneMappingPasses.cpp
        ${RTXPT_SOURCE_DIR}/ProcessingPasses/AccumulationPass.cpp
        ${RTXPT_SOURCE_DIR}/ProcessingPasses/PostProcess.cpp
        ${RTXPT_SOURCE_DIR}/ProcessingPasses/DenoisingGuidesBaker.cpp
        ${RTXPT_SOURCE_DIR}/NRD/NrdIntegration.cpp
        ${RTXPT_SOURCE_DIR}/NRD/NrdConfig.cpp
        ${RTXPT_SOURCE_DIR}/SceneRenderCache.cpp
        ${RTXPT_SOURCE_DIR}/Misc/ShaderDebug.cpp)
    set_target_properties(rtxpt_core PROPERTIES CXX_STANDARD 20 CXX_STANDARD_REQUIRED ON)
    target_link_libraries(rtxpt_core PUBLIC donut_core donut_render donut_app donut_engine NRD)
    target_include_directories(rtxpt_core PUBLIC
        ${RTXPT_SOURCE_DIR}
        ${RTXPT_DIR}/External
        ${RTXPT_DIR}/External/Rtxdi/Include
        ${RTXPT_DIR}/External/Nrd/Include
        ${RTXPT_DIR}/External/cxxopts/include
        ${tracy_SOURCE_DIR}/public)
    # No NVAPI (NVRHI_WITH_NVAPI is off without RTXCR_DIR): shader execution reordering and opacity
    # micromaps through DXR 1.2, the Agility SDK's.
    target_compile_definitions(rtxpt_core PUBLIC RTXPT_D3D12_WITH_NVAPI=0
        RTXPT_D3D_AGILITY_SDK_VERSION=${DONUT_D3D_AGILITY_SDK_VERSION})
    set(RTXPT_GLUE_INCLUDES "${RTXPT_SOURCE_DIR};${RTXPT_DIR}/External;${RTXPT_DIR}/External/Rtxdi/Include;${RTXPT_DIR}/External/Nrd/Include;${RTXPT_DIR}/External/cxxopts/include;${tracy_SOURCE_DIR}/public")
    set_source_files_properties(core/rtxpt.cpp PROPERTIES
        INCLUDE_DIRECTORIES "${RTXPT_GLUE_INCLUDES}"
        COMPILE_DEFINITIONS "RTXPT_D3D12_WITH_NVAPI=0;RTXPT_D3D_AGILITY_SDK_VERSION=${DONUT_D3D_AGILITY_SDK_VERSION}"
        COMPILE_OPTIONS "$<IF:$<CXX_COMPILER_ID:MSVC>,/std:c++20,-std=c++20>")

    # The shaders RTXPT's passes create through the ShaderFactory, at bin/shaders/rtxpt/<dxil|spirv>.
    set(RTXPT_SHADERMAKE_OPTIONS "--sourceDir ${RTXPT_SOURCE_DIR}")
    if (DONUT_D3D_AGILITY_SDK_VERSION GREATER_EQUAL 619)
        string(APPEND RTXPT_SHADERMAKE_OPTIONS " -m 6_9")
    endif()
    donut_compile_shaders(
        TARGET rtxpt_shaders
        PROJECT_NAME "RTXPT"
        CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rtxpt.cfg
        SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/rtxpt.cfg
        INCLUDES ${RTXPT_DIR}/External ${RTXPT_DIR}/External/Rtxdi/Include ${RTXPT_DIR}/External/Nrd/Shaders
        DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rtxpt/dxil
        SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/rtxpt/spirv
        SHADERMAKE_OPTIONS "${RTXPT_SHADERMAKE_OPTIONS}"
    )
    # NRD's shaders, at bin/shaders/nrd/<dxil|spirv> (NrdIntegration asks the ShaderFactory for "nrd/...").
    # NRD_INTERNAL enables the permutation macros its Shaders.cfg uses, as in RTXPT's build.
    donut_compile_shaders(
        TARGET rtxpt_nrd_shaders
        PROJECT_NAME "NRD"
        CONFIG ${RTXPT_DIR}/External/Nrd/Shaders/Shaders.cfg
        SOURCES ${RTXPT_DIR}/External/Nrd/Shaders/Shaders.cfg
        INCLUDES ${RTXPT_MATHLIB_DIR} ${RTXPT_DIR}/External/Nrd/Shaders
        DXIL ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/nrd/dxil
        SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/nrd/spirv
        SHADERMAKE_OPTIONS "-D NRD_INTERNAL"
    )

    # The sample's code finds its Assets folder (environment maps, the procedural sky's textures) next to the
    # executable or one folder up (SampleCommon.cpp's GetLocalPath): a link to RTXPT_DIR/Assets there.
    if (NOT EXISTS "${CMAKE_BINARY_DIR}/Assets")
        if (WIN32)
            file(TO_NATIVE_PATH "${CMAKE_BINARY_DIR}/Assets" RTXPT_ASSETS_LINK)
            file(TO_NATIVE_PATH "${RTXPT_DIR}/Assets" RTXPT_ASSETS_TARGET)
            execute_process(COMMAND cmd /c mklink /J "${RTXPT_ASSETS_LINK}" "${RTXPT_ASSETS_TARGET}" OUTPUT_QUIET)
        else()
            file(CREATE_LINK "${RTXPT_DIR}/Assets" "${CMAKE_BINARY_DIR}/Assets" SYMBOLIC)
        endif()
    endif()

    # The path tracer's shaders compile at run time (a permutation per material and setting), by the DXC
    # of RTXPT's checkout, from bin/ShaderDynamic/: the layout RTXPT's ShaderCompilerUtils looks for
    # next to the executable (core/rtxpt.cpp makes that bin/ under the JIT too). Donut's shader headers
    # are this repository's, which the C++ side's structures (materials, lights) come from.
    set(RTXPT_DYNAMIC_DIR "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ShaderDynamic")
    set(RTXPT_DXC_DIR "${RTXPT_DIR}/External/dxc/build/native/bin/x64")
    if (NOT EXISTS "${RTXPT_DXC_DIR}/dxc.exe")
        message(WARNING "RTXPT_DIR has no ${RTXPT_DXC_DIR}/dxc.exe: configure the checkout with its own CMake once, which downloads it")
    endif()
    file(GLOB RTXPT_NVAPI_SHADER_HEADERS "${RTXPT_DIR}/External/NVAPI/nvHLSL*.h" "${RTXPT_DIR}/External/NVAPI/nvShader*.h")
    add_custom_target(rtxpt_dynamic_shaders
        COMMAND ${CMAKE_COMMAND} -E copy_directory_if_different "${RTXPT_DXC_DIR}" "${RTXPT_DYNAMIC_DIR}/Tools/d3d12/x64"
        COMMAND ${CMAKE_COMMAND} -E copy_directory_if_different "${RTXPT_DXC_DIR}" "${RTXPT_DYNAMIC_DIR}/Tools/vk/x64"
        COMMAND ${CMAKE_COMMAND} -E copy_directory_if_different "${RTXPT_SOURCE_DIR}/Shaders" "${RTXPT_DYNAMIC_DIR}/Source/Rtxpt"
        COMMAND ${CMAKE_COMMAND} -E copy_directory_if_different "${CMAKE_CURRENT_SOURCE_DIR}/external/Donut/include/donut/shaders" "${RTXPT_DYNAMIC_DIR}/Source/External/donut/shaders"
        COMMAND ${CMAKE_COMMAND} -E make_directory "${RTXPT_DYNAMIC_DIR}/Source/External/NVAPI"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different ${RTXPT_NVAPI_SHADER_HEADERS} "${RTXPT_DYNAMIC_DIR}/Source/External/NVAPI"
        COMMAND ${CMAKE_COMMAND} -E copy_directory_if_different "${RTXPT_DIR}/External/Rtxdi/Include" "${RTXPT_DYNAMIC_DIR}/Source/External/Rtxdi/Include"
        COMMAND ${CMAKE_COMMAND} -E copy_directory_if_different "${RTXPT_DIR}/External/SHARC/include" "${RTXPT_DYNAMIC_DIR}/Source/External/SHARC/include"
        COMMENT "Copying RTXPT's run-time shader compiler and shader sources to bin/ShaderDynamic")

    if (TARGET donut_interop_shared)
        target_link_libraries(donut_interop_shared PRIVATE rtxpt_core)
        add_dependencies(donut_interop_shared rtxpt_shaders rtxpt_nrd_shaders rtxpt_dynamic_shaders)
    endif()

    # The path tracer is shader model 6.9 on D3D12 (DXR 1.2's hit objects): the Agility SDK runtime.
    if (NVRHI_WITH_DX12)
        add_tslang_example(rtxpt core/rtxpt_renderer.ts core/rtxpt_game.ts core/rtxpt.cpp core/d3d12_agility_sdk.cpp MEDIA fonts)
    else()
        add_tslang_example(rtxpt core/rtxpt_renderer.ts core/rtxpt_game.ts core/rtxpt.cpp MEDIA fonts)
    endif()
    add_dependencies(rtxpt rtxpt_shaders rtxpt_nrd_shaders rtxpt_dynamic_shaders)
    target_link_libraries(rtxpt PRIVATE rtxpt_core)
    copy_dlss_library(rtxpt)
    # 32 samples after the sample's capture warm-up (its --captureSimple): the frame Rtxpt.exe saves with
    # --referenceSamplesPerPixel 32 --overrideToReferenceMode --captureSimple (bit-identical on D3D12 for these scenes).
    add_tslang_example_test(rtxpt ARGS -width 960 -height 540 -frames 127 -referenceSamplesPerPixel 32 -captureWarmup 64
        -overrideToReferenceMode --scene ${RTXPT_DIR}/Assets/kitchen.scene.json)
    # D3D12 only: with an environment map that isn't a cubemap (this scene's .exr), the sample's EnvMapBaker binds
    # a black cube map array where its shader declares a cube map, which Vulkan's validation reports.
    add_tslang_example_test(rtxpt SUFFIX transparent_machines APIS dx12 ARGS -width 960 -height 540 -frames 127
        -referenceSamplesPerPixel 32 -captureWarmup 64 -overrideToReferenceMode --scene ${RTXPT_DIR}/Assets/transparent-machines.scene.json)
    add_tslang_example_test(rtxpt SUFFIX programmer_art ARGS -width 960 -height 540 -frames 127 -referenceSamplesPerPixel 32
        -captureWarmup 64 -overrideToReferenceMode --scene ${RTXPT_DIR}/Assets/programmer-art.scene.json)
    # The real-time mode with the denoiser (NRD) and TAA, as Rtxpt.exe --overrideToRealtimeMode --realtimeAA 1
    # --useReSTIRGI 0 --overrideRadianceCacheMode 0 --overrideSubSamplingMode 0 renders it (within ~1/255 mean).
    add_tslang_example_test(rtxpt SUFFIX realtime_reblur ARGS -width 960 -height 540 -frames 200 -overrideToRealtimeMode
        -overrideAutoexposureOff -stopAnimations -realtimeAA 1 -nrdMethod 0 --scene ${RTXPT_DIR}/Assets/kitchen.scene.json)
    add_tslang_example_test(rtxpt SUFFIX realtime_relax ARGS -width 960 -height 540 -frames 200 -overrideToRealtimeMode
        -overrideAutoexposureOff -stopAnimations -realtimeAA 1 -nrdMethod 1 --scene ${RTXPT_DIR}/Assets/kitchen.scene.json)
    # SampleGame (core/rtxpt_game.ts): the camera attached to the police ship, its lights on, the frame at 25 s as
    # Rtxpt.exe --propCameraAttach SHIP_police_squad --captureSequence --sequenceWarmupStart 24 --sequenceRecordStart 25
    # --sequenceFPS 60 saves it (which starts its warm-up once the scene has loaded, about 46 frames in).
    add_tslang_example_test(rtxpt SUFFIX samplegame ARGS -width 960 -height 540 -frames 106 -captureStart 46
        -captureStartTime 24 -captureWarmup 60 -overrideToRealtimeMode -overrideAutoexposureOff -realtimeAA 1
        -propCameraAttach SHIP_police_squad --scene ${RTXPT_DIR}/Assets/bistro-programmer-art.scene.json)
    if (DONUT_WITH_DLSS)
        # DLSS in place of TAA (-dlss, the real-time mode's realtimeAA 2) and DLSS-RR (3, the sample's default), both
        # upscaling at the default balanced mode, and DLSS 5 over the reference image (TAA, DLSS and the plain image
        # where they aren't available).
        add_tslang_example_test(rtxpt SUFFIX realtime_dlss ARGS -width 960 -height 540 -frames 200 -overrideToRealtimeMode
            -overrideAutoexposureOff -stopAnimations -dlss --scene ${RTXPT_DIR}/Assets/kitchen.scene.json)
        add_tslang_example_test(rtxpt SUFFIX realtime_dlss_rr ARGS -width 960 -height 540 -frames 200 -overrideToRealtimeMode
            -overrideAutoexposureOff -stopAnimations -realtimeAA 3 --scene ${RTXPT_DIR}/Assets/kitchen.scene.json)
        add_tslang_example_test(rtxpt SUFFIX dlss5 ARGS -width 960 -height 540 -frames 127 -referenceSamplesPerPixel 32
            -captureWarmup 64 -overrideToReferenceMode -dlss5 --scene ${RTXPT_DIR}/Assets/kitchen.scene.json)
    endif()
endif()

# jit_runtime: what running the examples' .ts under the tslang JIT (run_jit*.bat, .vscode/launch.json)
# loads from a build directory, without compiling the examples themselves: donut_interop_shared, the
# media and every example's dependencies (its shaders, and those some add, e.g. rtxcr_raster's morph
# target pass). Collected here, after the last add_tslang_example.
if (NOT ANDROID)
    add_custom_target(jit_runtime)
    add_dependencies(jit_runtime donut_interop_shared copy_media)
    get_property(TSLANG_EXAMPLES GLOBAL PROPERTY TSLANG_EXAMPLES)
    foreach(example IN LISTS TSLANG_EXAMPLES)
        get_target_property(example_dependencies ${example} MANUALLY_ADDED_DEPENDENCIES)
        if (example_dependencies)
            add_dependencies(jit_runtime ${example_dependencies})
        endif()
    endforeach()
endif()

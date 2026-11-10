# nri_interop: a flat C API over NVIDIA's NRI (NVIDIA Rendering Interface) and NRIFramework, the
# framework of NRISamples (a window, a command line, a render loop), for the examples that render
# with NRI instead of Donut (basic_triangle_nri).
#
# Built as a project of its own (the main CMakeLists.txt adds it with ExternalProject_Add): NRIFramework
# adds targets named imgui, glfw and ShaderMake, as Donut does, with other versions (its NRI Imgui
# extension needs a newer ImGui than Donut's). Everything NRI and NRIFramework link is inside
# nri_interop's shared library, which exports the Nri_* functions only (core/nri/nri_interop.d.ts),
# so the examples link nothing else of it, and its glfw never meets Donut's.
#
# nri_interop.cpp stays in core/nri/, not core/: tools/check_interop_types.py checks every core/*.cpp
# against donut_interop.d.ts. Under tslang's JIT the library is all an example needs:
#   tslang --emit=jit --shared-libs=build/bin/nri_interop.dll examples/basic_triangle_nri.ts -- -dx12
#
# NRI_OUTPUT_DIR: where nri_interop's and NRI's shared libraries go (the main project's bin/, next to the
# shaders they load).
cmake_minimum_required(VERSION 3.30)
project(nri_interop LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if (NOT NRI_OUTPUT_DIR)
    set(NRI_OUTPUT_DIR "${CMAKE_BINARY_DIR}/bin")
endif()
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${NRI_OUTPUT_DIR}")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${NRI_OUTPUT_DIR}")

# NRIFramework v0.23 (15 October 2025), MIT; its submodules NRI (v176) and MathLib come with it.
# Set FETCHCONTENT_SOURCE_DIR_NRIFRAMEWORK to use a checkout instead (NRISamples' External/NRIFramework).
# Patched for Android (see patches/): NRI's Vulkan backend makes an ANativeWindow's surface, and
# NRIFramework takes the activity's window from GLFW's Android platform (Donut's GLFW, below).
# NRI also enables VK_KHR_shader_quad_control (and VK_KHR_shader_maximal_reconvergence, which it
# needs) where the device has it, as Donut does: shader_quad_control_nri's pixel shader asks for
# full quads.
# NRI's D3D12 backend also gets patch lists' topology wrong (TRIANGLESTRIP_ADJ + control points
# instead of 1_CONTROL_POINT_PATCHLIST - 1 + control points): patched, for the tessellation examples.
# Its D3D11 and D3D12 backends set IndependentBlendEnable with logic operations, which both reject,
# and D3D12's sets the logic operation only with blending, which it can't be used with: patched, for
# logic_op_dynamic_state_nri.
# Its upload helper maps an upload buffer it didn't create when no buffer has data (only transitions):
# patched, for oit_linked_lists_nri's uninitialized fragment buffer.
# Its D3D12 committed textures (without the Agility SDK) keep a "small resource" alignment guessed
# from the first mip's bytes, which D3D12 rejects when the 4 KB tiles don't fit (a 120 x 67 RGBA16F
# texture): patched to leave the alignment to D3D12MA, as the Agility SDK path does.
# Its D3D11 binding tracker keeps a slot's earlier storage (or resource) after another is bound
# there, and unbinds the slot when that earlier one is bound the other way: a chain of dispatches
# each reading the one before's output loses its UAVs. Patched to forget a slot's earlier binding.
# Its D3D11 CmdEndRendering leaves the render targets bound, so a compute pass reading what was
# just rendered gets a null view (D3D11 drops shader resources still bound as outputs): patched to
# unbind them (UAVs kept), in the emulated command buffers' replay too.
# Its D3D12 ray tracing pipelines make a DXIL library of each shader exporting all the library's
# entry points, so shaders sharing one library (a .cfg's "-T lib" blob) export them repeatedly, which
# CreateStateObject rejects: patched to export each shader's entry point alone, for rt_triangle_nri.
# Its Vulkan conservative rasterization has no extra overestimation (0 always): patched with a
# RasterizationDesc field for it, as Donut's NVRHI patch gives conservative_rasterization's Vulkan pipeline.
# Its validation layer unwraps the HAS_BUFFER marker of a bottom level structure's creation desc as a
# buffer (an access violation with -debug): patched to pass it through, for ray_tracing_extended_nri's
# updatable BLAS.
# It has no line width, line rasterization mode or stipple (RasterizationDesc's lineSmoothing only):
# patched with RasterizationDesc fields for them (Vulkan: VkPipelineRasterizationLineStateCreateInfo and
# lineWidth; D3D: rectangular lines as quadrilateral, smooth ones alpha antialiased, others aliased) and
# DeviceDesc::other.lineRasterizationModes / lineWidthMax, for dynamic_line_rasterization_nri.
# It doesn't enable VK_EXT_calibrated_timestamps: patched to, for calibrated_timestamps_nri (whose
# vkGetCalibratedTimestampsEXT comes through NRI's Vulkan wrapper).
# Its D3D12 shading rate attachment views have no heap descriptor, yet destroying one gives an empty
# handle (the first heap's first slot) back to the CBV/SRV/UAV free list, so a later view lands in
# another heap: patched to give back only allocated handles, for resizing fragment_shading_rate_dynamic_nri.
# It doesn't enable VK_NV_ray_tracing_invocation_reorder: patched to, where the device has it, for
# ray_tracing_invocation_reorder_nri's hit objects (Shader Execution Reordering).
# NRIFramework's debug allocator (Debug builds' host memory, the Vulkan driver's too) reallocates with
# realloc, which keeps the bytes at the old block's alignment offset while the returned pointer takes
# the new block's, which differ when the alignment is above malloc's: the data comes back shifted. And
# NVIDIA's Vulkan driver frees, with a ray tracing pipeline's callbacks, a block it didn't allocate
# through them (raytracing_ao_nri after a few resizes), whose "header" the allocator read: it aborted.
# Patched to allocate, copy and free, and to keep the blocks it handed out, ignoring others.
# Its Vulkan backend needs Vulkan 1.3's dynamic rendering, synchronization2 and extended dynamic state, which
# Vulkan 1.1 drivers (Samsung Galaxy S21's Mali-G78) lack: patched to take Vulkan 1.1 with the 1.2 features as
# extensions, render passes, vkCmdPipelineBarrier/vkQueueSubmit and static viewport counts and vertex strides
# (VertexStreamDesc::stride) instead; NRI_VK_LEGACY=1 runs a newer GPU that way (the S21's extensions only).
# With validation it always asks the Vulkan layer for debug printf (GPU-assisted validation, every
# shader instrumented; layer 1.4.321 dereferenced null in gpuav PostSubmit now and then): patched to
# ask only when VK_KHRONOS_VALIDATION_PRINTF_ENABLE is set, as Nri_CreateDevice does for shader printf.
# Its window is always shown: patched with SampleBase::m_HiddenWindow, which -test sets (headless runs).
# The patch step resets both checkouts first, so the patches always apply to clean files.
# A checkout given with FETCHCONTENT_SOURCE_DIR_NRIFRAMEWORK isn't patched.
include(FetchContent)
set(NRI_PATCHES_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../patches")
FetchContent_Declare(nriframework
    GIT_REPOSITORY https://github.com/NVIDIA-RTX/NRIFramework.git
    GIT_TAG 80fd6380500b9228c615fb71e5cd62d3c05df03b
    GIT_SUBMODULES_RECURSE ON
    PATCH_COMMAND
        "${CMAKE_COMMAND}" -P "${CMAKE_CURRENT_SOURCE_DIR}/reset_checkout.cmake"
    COMMAND
        "${CMAKE_COMMAND}" -DREPOSITORY=External/NRI -P "${CMAKE_CURRENT_SOURCE_DIR}/reset_checkout.cmake"
    COMMAND
        "${CMAKE_COMMAND}" -DREPOSITORY=External/NRI "-DPATCH=${NRI_PATCHES_DIR}/NRI-android-surface.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" -DREPOSITORY=External/NRI "-DPATCH=${NRI_PATCHES_DIR}/NRI-shader-quad-control.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" -DREPOSITORY=External/NRI "-DPATCH=${NRI_PATCHES_DIR}/NRI-d3d12-patch-list-topology.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" -DREPOSITORY=External/NRI "-DPATCH=${NRI_PATCHES_DIR}/NRI-logic-op.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" -DREPOSITORY=External/NRI "-DPATCH=${NRI_PATCHES_DIR}/NRI-upload-buffers-without-data.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" -DREPOSITORY=External/NRI "-DPATCH=${NRI_PATCHES_DIR}/NRI-d3d12-committed-texture-alignment.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" -DREPOSITORY=External/NRI "-DPATCH=${NRI_PATCHES_DIR}/NRI-d3d11-binding-slots.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" -DREPOSITORY=External/NRI "-DPATCH=${NRI_PATCHES_DIR}/NRI-d3d11-end-rendering.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" -DREPOSITORY=External/NRI "-DPATCH=${NRI_PATCHES_DIR}/NRI-d3d12-library-exports.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" -DREPOSITORY=External/NRI "-DPATCH=${NRI_PATCHES_DIR}/NRI-conservative-extra-overestimation.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" -DREPOSITORY=External/NRI "-DPATCH=${NRI_PATCHES_DIR}/NRI-validation-has-buffer.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" -DREPOSITORY=External/NRI "-DPATCH=${NRI_PATCHES_DIR}/NRI-line-rasterization.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" -DREPOSITORY=External/NRI "-DPATCH=${NRI_PATCHES_DIR}/NRI-calibrated-timestamps.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" -DREPOSITORY=External/NRI "-DPATCH=${NRI_PATCHES_DIR}/NRI-d3d12-shading-rate-descriptor-free.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" -DREPOSITORY=External/NRI "-DPATCH=${NRI_PATCHES_DIR}/NRI-vk-ray-tracing-invocation-reorder.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" -DREPOSITORY=External/NRI "-DPATCH=${NRI_PATCHES_DIR}/NRI-vulkan-1.1.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" -DREPOSITORY=External/NRI "-DPATCH=${NRI_PATCHES_DIR}/NRI-vk-debug-printf-on-request.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" "-DPATCH=${NRI_PATCHES_DIR}/NRIFramework-android-platform.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" "-DPATCH=${NRI_PATCHES_DIR}/NRIFramework-debug-allocator.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake"
    COMMAND
        "${CMAKE_COMMAND}" "-DPATCH=${NRI_PATCHES_DIR}/NRIFramework-hidden-window.patch"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/apply_patch.cmake")

# NRI's memory allocators, at the commits NRI v176 names but cloned whole: NRI clones them shallow,
# which checks out a commit only while it's the tip of a branch. The first declaration is the one
# FetchContent uses.
FetchContent_Declare(vma
    GIT_REPOSITORY https://github.com/GPUOpen-LibrariesAndSDKs/VulkanMemoryAllocator.git
    GIT_TAG 6d36dca2c71a7f0468a129f664bc9b474da5a886
    SOURCE_SUBDIR "ignore CMakeLists.txt")
FetchContent_Declare(d3d12ma
    GIT_REPOSITORY https://github.com/GPUOpen-LibrariesAndSDKs/D3D12MemoryAllocator.git
    GIT_TAG 2ac8a9bdada39ad75210be7b6da8b2b0f61e84f5
    SOURCE_SUBDIR "ignore CMakeLists.txt")

# NRI linked in, not NRI.dll next to it: tslang's JIT loads nri_interop.dll from bin/, but Windows
# looks for the libraries a library imports in the executable's directory (tslang.exe's), not bin/.
set(NRI_STATIC_LIBRARY ON CACHE BOOL "" FORCE)

# NRI built without its Agility SDK support (its own package and code paths: enhanced barriers,
# ...), which would need D3D12SDKVersion and D3D12SDKPath exported from the executable (tslang's
# JIT runs tslang.exe). The D3D12 runtime is the Agility SDK's all the same: nri_interop applies the
# main project's (bin/D3D12, NRI_D3D_AGILITY_SDK_VERSION) to D3D12's global state before the first
# device (Nri_CreateDevice), for shader model 6.9 and DXR 1.2 (ray_tracing_invocation_reorder_nri's
# hit objects).
set(NRI_ENABLE_AGILITY_SDK_SUPPORT OFF CACHE BOOL "" FORCE)

if (ANDROID)
    # NRIFramework's GLFW is Donut's there (NRI_GLFW_SOURCE_DIR, the main project's
    # external/Donut/thirdparty/glfw), patched with an Android platform: the NativeActivity's window,
    # which core/android_main.cpp hands over with Nri_SetAndroidApp.
    set(FETCHCONTENT_SOURCE_DIR_GLFW "${NRI_GLFW_SOURCE_DIR}")
endif()
FetchContent_MakeAvailable(nriframework)

# Donut's math sources (vectorToSnorm8, orthoProjD3DStyle...) with the header-only rest.
set(DONUT_MATH_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../external/Donut/src/core/math")
add_library(nri_interop SHARED nri_interop.cpp nri_donut_constants.cpp nri_donut_scene.cpp "${DONUT_MATH_DIR}/matrix.cpp"
    "${DONUT_MATH_DIR}/vector.cpp" ../sdkmesh.cpp)
# The SDKMESH reader (core/sdk_mesh.ts's Donut_*SdkMesh* functions), exported as donut_interop_shared
# exports it, for the ports of the Xbox ATG examples.
set_source_files_properties(../sdkmesh.cpp PROPERTIES COMPILE_DEFINITIONS DONUT_INTEROP_SHARED)
# Basis Universal's KTX 2 transcoder (core/transcoded_texture.ts's Donut_*Transcode* functions,
# core/basis_transcoder.cpp), exported as donut_interop_shared exports it, for the ports of the
# Vulkan-Samples texture compression examples: the main project's checkout (BASIS_UNIVERSAL_SOURCE_DIR),
# else fetched here, the main project's tag; its transcoder and Zstandard decoder only.
if (BASIS_UNIVERSAL_SOURCE_DIR AND EXISTS "${BASIS_UNIVERSAL_SOURCE_DIR}/transcoder/basisu_transcoder.cpp")
    set(NRI_BASIS_UNIVERSAL_DIR "${BASIS_UNIVERSAL_SOURCE_DIR}")
else()
    FetchContent_Declare(basis_universal
        GIT_REPOSITORY https://github.com/BinomialLLC/basis_universal.git
        GIT_TAG v1_60
        GIT_SHALLOW TRUE
        SOURCE_SUBDIR transcoder-only)
    FetchContent_MakeAvailable(basis_universal)
    set(NRI_BASIS_UNIVERSAL_DIR "${basis_universal_SOURCE_DIR}")
endif()
target_sources(nri_interop PRIVATE ../basis_transcoder.cpp "${NRI_BASIS_UNIVERSAL_DIR}/transcoder/basisu_transcoder.cpp"
    "${NRI_BASIS_UNIVERSAL_DIR}/zstd/zstddeclib.c")
set_source_files_properties(../basis_transcoder.cpp PROPERTIES COMPILE_DEFINITIONS DONUT_INTEROP_SHARED)
target_include_directories(nri_interop PRIVATE "${NRI_BASIS_UNIVERSAL_DIR}/transcoder")
# KTX 2 files, with Zstandard supercompression (its own decoder), as the main project builds it.
target_compile_definitions(nri_interop PRIVATE BASISD_SUPPORT_KTX2=1 BASISD_SUPPORT_KTX2_ZSTD=1)
if (MSVC)
    set_source_files_properties("${NRI_BASIS_UNIVERSAL_DIR}/transcoder/basisu_transcoder.cpp"
        "${NRI_BASIS_UNIVERSAL_DIR}/zstd/zstddeclib.c" PROPERTIES COMPILE_OPTIONS /W0)
else()
    set_source_files_properties("${NRI_BASIS_UNIVERSAL_DIR}/transcoder/basisu_transcoder.cpp"
        "${NRI_BASIS_UNIVERSAL_DIR}/zstd/zstddeclib.c" PROPERTIES COMPILE_OPTIONS -w)
    # Its hash_map asserts (see the main project's basisu_transcoder): GCC 14+ rejects them.
    target_compile_options(nri_interop PRIVATE $<$<AND:$<COMPILE_LANGUAGE:CXX>,$<CXX_COMPILER_ID:GNU>>:-Wno-template-body>)
endif()
target_link_libraries(nri_interop PRIVATE NRIFramework)
# miniaudio (one header, public domain or MIT-0): sound (nri_audio.cpp: a playback device, WASAPI on
# Windows, AAudio or OpenSL ES on Android, loaded at run time, and its synthesized sounds). Its own
# CMake project isn't used (SOURCE_SUBDIR names no folder of it).
FetchContent_Declare(miniaudio
    GIT_REPOSITORY https://github.com/mackron/miniaudio.git
    GIT_TAG 0.11.21
    GIT_SHALLOW TRUE
    SOURCE_SUBDIR header-only)
FetchContent_MakeAvailable(miniaudio)
target_sources(nri_interop PRIVATE nri_audio.cpp)
target_include_directories(nri_interop PRIVATE "${miniaudio_SOURCE_DIR}")
if (MSVC)
    set_source_files_properties(nri_audio.cpp PROPERTIES COMPILE_OPTIONS /W0)
else()
    set_source_files_properties(nri_audio.cpp PROPERTIES COMPILE_OPTIONS -w)
endif()
# Donut's header-only math and its shaders' constant structs (nri_donut_constants.cpp,
# nri_donut_scene.cpp), for the ports of the Donut examples that draw with Donut's passes or scenes.
target_include_directories(nri_interop PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../../external/Donut/include")
# cgltf, which NRIFramework compiles (and keeps its include directory to itself): Nri_LoadGltfMesh
# reads glTF files with it, as core/vulkan_samples_gltf.h does for Donut's interop.
FetchContent_GetProperties(cgltf)
target_include_directories(nri_interop PRIVATE "${cgltf_SOURCE_DIR}")
if (WIN32)
    target_compile_definitions(nri_interop PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
    # The Agility SDK runtime's version (D3D12Core.dll in bin/D3D12, copied by the main project).
    if (NRI_D3D_AGILITY_SDK_VERSION)
        target_compile_definitions(nri_interop PRIVATE NRI_D3D_AGILITY_SDK_VERSION=${NRI_D3D_AGILITY_SDK_VERSION})
    endif()
    # NRIFramework's link options (/NOIMPLIB, /NOEXP: for an executable exporting the Agility SDK's
    # symbols) would leave this library without the import library the examples link.
    set_property(TARGET NRIFramework PROPERTY INTERFACE_LINK_OPTIONS "")
else()
    set_target_properties(nri_interop PROPERTIES CXX_VISIBILITY_PRESET hidden)
endif()
# The import library (Windows) where the main project looks for it.
set_target_properties(nri_interop PROPERTIES ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")

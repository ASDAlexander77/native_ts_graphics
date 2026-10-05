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
project(powdertoy_game CXX TSLANG)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS ON)

# Include folders
include_directories(${CMAKE_TSLANG_DIR}/defaultlib)

# The compiled default lib is split into per-build subfolders (debug/release) and then per
# memory model (gc/rc/none); pick the pair matching this build, so that the CRT, the allocator
# and the default-lib binaries all agree. A library built for one model cannot be linked into
# a program built for another.
if (CMAKE_BUILD_TYPE STREQUAL "Release")
	set(TSLANG_DEFAULTLIB_BUILD "release")
else()
	set(TSLANG_DEFAULTLIB_BUILD "debug")
endif()

set(TSLANG_MEMORY_MODEL "gc" CACHE STRING "Memory model of compiled code: gc, rc or none")
set_property(CACHE TSLANG_MEMORY_MODEL PROPERTY STRINGS gc rc none)

# Lib folders
link_directories(${CMAKE_TSLANG_DIR} ${CMAKE_TSLANG_DIR}/defaultlib/lib/${TSLANG_DEFAULTLIB_BUILD}/${TSLANG_MEMORY_MODEL})

# set options
if (CMAKE_BUILD_TYPE STREQUAL "Release")
	set(CMAKE_TSLANG_FLAGS "--opt --opt_level=3") # global
else()
	set(CMAKE_TSLANG_FLAGS "--di --opt_level=0") # global
endif()

# The same variable that picked the link directory has to reach the compiler as well, or the
# program is compiled for one model and linked against another model's default lib.
set(CMAKE_TSLANG_FLAGS "${CMAKE_TSLANG_FLAGS} -mm=${TSLANG_MEMORY_MODEL}") # global

set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Donut
# TypeScriptDefaultLib and TypeScriptAsyncRuntime are built against the release static CRT
# (/MT) even in their debug folder; everything linked with them, Donut included, has to use
# the same CRT, or the linker reports RuntimeLibrary/_ITERATOR_DEBUG_LEVEL mismatches.
if (MSVC)
	set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")
	# Donut unconditionally adds -D_DEBUG to Debug flags, which makes the headers reference the
	# debug CRT (_malloc_dbg, libcpmtd) that /MT doesn't provide; cancel it.
	add_compile_options($<$<AND:$<CONFIG:Debug>,$<COMPILE_LANGUAGE:C,CXX>>:/U_DEBUG>)
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
)

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

    foreach(PATCH_FILE ${DONUT_PATCHES})
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" apply --check "${PATCH_FILE}"
            WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/external/Donut"
            RESULT_VARIABLE DONUT_PATCH_CHECK
            OUTPUT_QUIET ERROR_QUIET)
        if (DONUT_PATCH_CHECK EQUAL 0)
            message(STATUS "Applying patch to external/Donut: ${PATCH_FILE}")
            execute_process(
                COMMAND "${GIT_EXECUTABLE}" apply "${PATCH_FILE}"
                WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/external/Donut"
                RESULT_VARIABLE DONUT_PATCH_APPLY)
            if (NOT DONUT_PATCH_APPLY EQUAL 0)
                message(WARNING "Failed to apply patch: ${PATCH_FILE}")
            endif()
        else()
            # Doesn't apply forward: it's already applied if it applies in reverse.
            execute_process(
                COMMAND "${GIT_EXECUTABLE}" apply --check --reverse "${PATCH_FILE}"
                WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/external/Donut"
                RESULT_VARIABLE DONUT_PATCH_REVERSE_CHECK
                OUTPUT_QUIET ERROR_QUIET)
            if (DONUT_PATCH_REVERSE_CHECK EQUAL 0)
                message(STATUS "Patch already applied to external/Donut: ${PATCH_FILE}")
            else()
                message(WARNING "Patch does not apply cleanly to external/Donut (skipped): ${PATCH_FILE}")
            endif()
        endif()
    endforeach()
else()
    message(WARNING "git not found: skipping the external/Donut patches")
endif()

# NVIDIA DLSS, for feature_demo's DLSS anti-aliasing mode (needs an RTX GPU at run time):
#   cmake --preset dlss (or release-dlss), or -DDONUT_WITH_DLSS=ON
# Donut then fetches the DLSS SDK from GitHub at configure time; into the build folder here rather
# than into the external/Donut submodule (set DONUT_DLSS_FETCH_DIR to share one checkout).
option(DONUT_WITH_DLSS "Enable the NGX DLSS integration (fetches the DLSS SDK)" OFF)
set(DONUT_DLSS_FETCH_DIR "" CACHE STRING "Directory to fetch DLSS to, empty uses build directory default")
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
set(CMAKE_PROJECT_zstd_INCLUDE_BEFORE "${CMAKE_CURRENT_SOURCE_DIR}/cmake/zstd_policies.cmake")
set(CMAKE_POLICY_VERSION_MINIMUM 3.10)
add_subdirectory(external/Donut)
unset(CMAKE_POLICY_VERSION_MINIMUM)
unset(CMAKE_PROJECT_zstd_INCLUDE_BEFORE)

if (NVRHI_WITH_DX12)
    set(DONUT_D3D_AGILITY_SDK_URL "https://www.nuget.org/api/v2/package/Microsoft.Direct3D.D3D12/1.616.1")
    set(DONUT_D3D_AGILITY_SDK_FETCH_DIR "" CACHE STRING "" FORCE)
    include("${CMAKE_CURRENT_SOURCE_DIR}/external/Donut/cmake/FetchAgilitySDK.cmake")

    file(COPY
        "${DONUT_D3D_AGILITY_SDK_PATH}/build/native/bin/x64/D3D12Core.dll"
        "${DONUT_D3D_AGILITY_SDK_PATH}/build/native/bin/x64/D3D12SDKLayers.dll"
        DESTINATION "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/D3D12/")
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
        # d3dx12/d3dx12.h (CD3DX12_STATE_OBJECT_DESC, CD3DX12_WORK_GRAPH_SUBOBJECT, ...) ships in the
        # Agility SDK package fetched above by FetchAgilitySDK.cmake, not on any include path yet.
        target_include_directories(${target} PRIVATE "${DONUT_D3D_AGILITY_SDK_PATH}/build/native/include")
    endif()
endfunction()

# Linked into every example executable.
add_library(donut_interop STATIC core/donut_interop.cpp)
configure_donut_interop(donut_interop)

# The same API as bin/donut_interop.dll, for running the .ts files under tslang's JIT:
#   tslang --emit=jit --shared-libs=build/bin/donut_interop.dll examples/<example>.ts
# It sits next to bin/shaders and bin/media, where it looks them up (see Donut_SetAppName).
# The functions have no dllexport, so export all of core/donut_interop.cpp's symbols; its import library
# is renamed so it doesn't overwrite the static donut_interop.lib.
add_library(donut_interop_shared SHARED core/donut_interop.cpp)
configure_donut_interop(donut_interop_shared)
set_target_properties(donut_interop_shared PROPERTIES
    OUTPUT_NAME donut_interop
    ARCHIVE_OUTPUT_NAME donut_interop_shared
    WINDOWS_EXPORT_ALL_SYMBOLS ON)

# With DONUT_WITH_DLSS, NGX loads nvngx_dlss.dll from the directory of the executable (of
# donut_interop.dll under the JIT): bin/, where both are. Set by Donut's cmake/DLSS.cmake.
function(copy_dlss_library target)
    if (DLSS_SHARED_LIBRARY_PATH)
        add_custom_command(TARGET ${target} POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different "${DLSS_SHARED_LIBRARY_PATH}" "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/")
    endif()
endfunction()
copy_dlss_library(donut_interop_shared)

# required libs
set(TSLANG_LINK_LIBS "TypeScriptDefaultLib" "TypeScriptAsyncRuntime")

# Boehm is only referenced by the gc default lib; the rc and none builds allocate through the
# CRT and must not drag a collector in.
if (TSLANG_MEMORY_MODEL STREQUAL "gc")
    list(APPEND TSLANG_LINK_LIBS "gc")
endif()

if(NOT WIN32)
    list(APPEND TSLANG_LINK_LIBS "stdc++" "m" "pthread" "dl" "rt")
endif()

# TypeScript shared by the examples (core/input_pass.ts). An example's
# `import { X } from "../core/input_pass"` only reads the declarations (the path is relative to the
# example); the code is compiled once here and linked into every example. tslang resolves such an
# import to ../core/input_pass.dll instead when that exists relative to its working directory, which
# for these compiles is the build folder: keep the DLL below out of reach of it.
# input_pass.ts references donut.ts, the class wrappers over donut_interop.d.ts (generated by
# tools/generate_donut_wrappers.py), so its object holds their code as well.
set(TSLANG_SHARED_SOURCES "${CMAKE_CURRENT_SOURCE_DIR}/core/input_pass.ts")
set(TSLANG_SHARED_INCLUDES
    "${CMAKE_CURRENT_SOURCE_DIR}/core/donut.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/core/donut_interop.d.ts")
add_library(tslang_shared OBJECT ${TSLANG_SHARED_SOURCES})
set_source_files_properties(${TSLANG_SHARED_SOURCES} PROPERTIES OBJECT_DEPENDS "${TSLANG_SHARED_INCLUDES}")

# The same code as bin/input_pass.dll, for running an example under the JIT: list it in
# --shared-libs after donut_interop.dll (which it calls into, through its import library) and the
# DLL build of the default library it links, copied next to it (see run_jit.bat). Run from a
# directory without an input_pass.dll, so the import reads input_pass.ts as in the build above.
set(TSLANG_DEFAULTLIB_DLL
    "${CMAKE_TSLANG_DIR}/defaultlib/dll/${TSLANG_DEFAULTLIB_BUILD}/${TSLANG_MEMORY_MODEL}/TypeScriptDefaultLib.dll")
separate_arguments(TSLANG_FLAGS_LIST NATIVE_COMMAND "${CMAKE_TSLANG_FLAGS}")
add_custom_command(
    OUTPUT "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/input_pass.dll"
    COMMAND "${CMAKE_TSLANG_COMPILER}" ${TSLANG_FLAGS_LIST} "--default-lib-path=${CMAKE_TSLANG_DIR}" --emit=dll
        "--obj=$<TARGET_LINKER_FILE:donut_interop_shared>"
        "-o=${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/input_pass.dll" "${CMAKE_CURRENT_SOURCE_DIR}/core/input_pass.ts"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${TSLANG_DEFAULTLIB_DLL}" "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/"
    DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/core/input_pass.ts" ${TSLANG_SHARED_INCLUDES} donut_interop_shared
    WORKING_DIRECTORY "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}"
    COMMENT "Building input_pass.dll for the JIT")
add_custom_target(tslang_shared_dll ALL DEPENDS "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/input_pass.dll")

# One executable per example, built from examples/<name>.ts, plus any further sources given after the name.
# Its shaders, if any (the <name>_shaders target), must be compiled into
# bin/shaders/<name>/<dxbc|dxil|spirv>: donut_interop loads them from the folder named after the
# executable.
function(add_tslang_example name)
    # .ts files compile with the TSLANG command. Most targets have no .cpp, so link with the C++
    # rule explicitly: the C++ link flags (debug info, CRT) apply and the tslang compile flags
    # stay off the link line.
    add_executable(${name} examples/${name}.ts ${ARGN})
    set_target_properties(${name} PROPERTIES LINKER_LANGUAGE CXX)
    target_link_libraries(${name} PRIVATE ${TSLANG_LINK_LIBS} donut_interop tslang_shared)
    # The TSLANG rule doesn't report dependencies: recompile when the imported declarations change.
    set_source_files_properties(examples/${name}.ts PROPERTIES OBJECT_DEPENDS "${TSLANG_SHARED_SOURCES};${TSLANG_SHARED_INCLUDES}")
    if (TARGET ${name}_shaders)
        add_dependencies(${name} ${name}_shaders)
    endif()
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

# Port of Donut-Samples' shader_specializations. Specialization constants are Vulkan-only.
donut_compile_shaders(
    TARGET shader_specializations_shaders
    PROJECT_NAME "Shader Specializations"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/shader_specializations.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/shader_specializations.hlsl
    SPIRV_DXC ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/shader_specializations/spirv
)
add_tslang_example(shader_specializations)

# Port of Donut-Samples' headless: compute only, no window.
donut_compile_shaders_all_platforms(
    TARGET headless_shaders
    PROJECT_NAME "Headless"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/headless.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/headless.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/headless
)
add_tslang_example(headless)

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

# Port of Donut-Samples' vertex_buffer.
donut_compile_shaders_all_platforms(
    TARGET vertex_buffer_shaders
    PROJECT_NAME "Vertex Buffer"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/vertex_buffer.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/vertex_buffer.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/vertex_buffer
)
add_tslang_example(vertex_buffer)

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
add_tslang_example(threaded_rendering)

# Port of Donut-Samples' deferred_shading: no shaders of its own (Donut's G-buffer fill and
# deferred lighting passes); uses media/nvidia-logo.png, copied with the media folder above.
add_tslang_example(deferred_shading)

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
add_tslang_example(rt_shadows)

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
add_tslang_example(variable_shading)

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
add_tslang_example(rt_bindless)

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
add_tslang_example(rt_reflections)

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
add_tslang_example(rt_particles)

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
    set_source_files_properties(core/d3d12_agility_sdk.cpp PROPERTIES
        COMPILE_DEFINITIONS DONUT_D3D_AGILITY_SDK_VERSION=${DONUT_D3D_AGILITY_SDK_VERSION})
    add_tslang_example(work_graphs core/d3d12_agility_sdk.cpp)
endif()

# Port of Donut-Samples' feature_demo: Donut's full renderer (deferred or forward shading, cascaded
# shadows, SSAO, procedural sky, TAA or MSAA, bloom, tone mapping, light probes, material picking)
# over a loaded scene, with an ImGui settings window and material editor; DLSS with
# DONUT_WITH_DLSS=ON. No shaders of its own; needs the scenes and fonts of DONUT_SAMPLES_MEDIA_DIR above.
add_tslang_example(feature_demo)
copy_dlss_library(feature_demo)

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
	elseif (CMAKE_ANDROID_ARCH_ABI STREQUAL "x86_64")
		set(TSLANG_ANDROID_ARCH "x86_64")
	else()
		message(FATAL_ERROR "No tslang runtime for the Android ABI '${CMAKE_ANDROID_ARCH_ABI}': use arm64-v8a or x86_64")
	endif()
	set(TSLANG_TARGET_TRIPLE_FLAG "-mtriple=${TSLANG_ANDROID_ARCH}-linux-android${CMAKE_SYSTEM_VERSION}")
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
            # Doesn't apply forward: it's already applied if it applies in reverse.
            execute_process(
                COMMAND "${GIT_EXECUTABLE}" apply --check --reverse "${PATCH_FILE}"
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
    # Linked into the examples that need the Agility SDK runtime rather than the OS's (work
    # graphs, shader model 6.9): exports its version.
    set_source_files_properties(core/d3d12_agility_sdk.cpp PROPERTIES
        COMPILE_DEFINITIONS DONUT_D3D_AGILITY_SDK_VERSION=${DONUT_D3D_AGILITY_SDK_VERSION})
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
# There is no JIT on Android, so no shared build there either.
if (NOT ANDROID)
    add_library(donut_interop_shared SHARED core/donut_interop.cpp)
    configure_donut_interop(donut_interop_shared)
    set_target_properties(donut_interop_shared PROPERTIES
        OUTPUT_NAME donut_interop
        ARCHIVE_OUTPUT_NAME donut_interop_shared
        WINDOWS_EXPORT_ALL_SYMBOLS ON)
endif()

# With DONUT_WITH_DLSS, NGX loads nvngx_dlss.dll from the directory of the executable (of
# donut_interop.dll under the JIT): bin/, where both are. Set by Donut's cmake/DLSS.cmake.
function(copy_dlss_library target)
    if (DLSS_SHARED_LIBRARY_PATH)
        add_custom_command(TARGET ${target} POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different "${DLSS_SHARED_LIBRARY_PATH}" "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/")
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
    add_library(${name}_app SHARED EXCLUDE_FROM_ALL examples/${name}.ts core/input_pass.ts core/donut.ts ${ARGN}
        core/android_main.cpp "${ANDROID_NATIVE_APP_GLUE_DIR}/android_native_app_glue.c")
    set_target_properties(${name}_app PROPERTIES
        OUTPUT_NAME ${name}
        LINKER_LANGUAGE CXX
        LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/android/${name}")
    target_include_directories(${name}_app PRIVATE "${ANDROID_NATIVE_APP_GLUE_DIR}")
    target_link_libraries(${name}_app PRIVATE ${TSLANG_LINK_LIBS} donut_interop glfw android log)
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
endfunction()

# The files the examples' .ts files compile in, which their objects have to be rebuilt after: a
# TSLANG object depends on its own .ts only, as tslang can't write a depfile (the DEP_FILE of the
# rule is never made), so changing App in donut.ts left the examples' objects with the old layout.
#   examples/<name>.ts imports core/input_pass.ts, which imports core/donut.ts, which references
#   core/donut_interop.d.ts. donut_globals.d.ts is for the editor only, but it's generated with
#   donut.ts.
# Listed by hand, so a change to any of them rebuilds every example's .ts, and a new import has to
# be added here. Once tslang can write a depfile, set CMAKE_DEPFILE_FLAGS_TSLANG in
# cmake/CMakeTSLANGInformation.cmake and drop these.
set(TSLANG_DONUT_DECLARATIONS
    "${CMAKE_CURRENT_SOURCE_DIR}/core/donut_interop.d.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/core/donut_globals.d.ts")
set(TSLANG_CORE_SOURCES
    "${CMAKE_CURRENT_SOURCE_DIR}/core/input_pass.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/core/donut.ts"
    ${TSLANG_DONUT_DECLARATIONS})
set_source_files_properties(core/donut.ts PROPERTIES OBJECT_DEPENDS "${TSLANG_DONUT_DECLARATIONS}")
set_source_files_properties(core/input_pass.ts PROPERTIES OBJECT_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/core/donut.ts;${TSLANG_DONUT_DECLARATIONS}")

# add_tslang_example(<name> [MEDIA <path>...] [<source>...]): examples/<name>.ts and the further
# sources. MEDIA lists the files and folders of the media folder it reads (paths in it), which
# go into its APK on Android; on the desktop the whole folder is next to the executables.
function(add_tslang_example name)
    cmake_parse_arguments(PARSE_ARGV 1 EXAMPLE "" "" "MEDIA")
    # .ts files compile with the TSLANG command. Most targets have no .cpp, so link with the C++
    # rule explicitly: the C++ link flags (debug info, CRT) apply and the tslang compile flags
    # stay off the link line.
    add_executable(${name} examples/${name}.ts core/input_pass.ts core/donut.ts ${EXAMPLE_UNPARSED_ARGUMENTS})
    set(example_ts examples/${name}.ts ${EXAMPLE_UNPARSED_ARGUMENTS})
    list(FILTER example_ts INCLUDE REGEX "\\.ts$")
    set_source_files_properties(${example_ts} PROPERTIES OBJECT_DEPENDS "${TSLANG_CORE_SOURCES}")
    set_target_properties(${name} PROPERTIES LINKER_LANGUAGE CXX)
    target_link_libraries(${name} PRIVATE ${TSLANG_LINK_LIBS} donut_interop)
    if (TARGET ${name}_shaders)
        add_dependencies(${name} ${name}_shaders)
    endif()
    if (ANDROID)
        add_tslang_android_app(${name} "${EXAMPLE_MEDIA}" ${EXAMPLE_UNPARSED_ARGUMENTS})
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
add_tslang_example(vertex_buffer MEDIA nvidia-logo.png)

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

# Port of Donut-Samples' deferred_shading: no shaders of its own (Donut's G-buffer fill and
# deferred lighting passes); uses media/nvidia-logo.png, copied with the media folder above.
add_tslang_example(deferred_shading MEDIA nvidia-logo.png)

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
add_tslang_example(rt_shadows MEDIA glTF-Sample-Assets/Models/Sponza)

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
add_tslang_example(variable_shading MEDIA glTF-Sample-Assets/Models/Sponza)

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

# Port of Vulkan-Samples' compute_nbody: an N-body simulation in two compute passes, drawn as
# additively blended sprites.
donut_compile_shaders_all_platforms(
    TARGET compute_nbody_shaders
    PROJECT_NAME "Compute N-Body"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/compute_nbody.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/compute_nbody.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/compute_nbody
)
add_tslang_example(compute_nbody)

# Port of Vulkan-Samples' terrain_tessellation: a heightmap terrain of quad patches, tessellated by
# their size on screen. Its textures (Vulkan-Samples' assets, KTX 1, not in this repo) are converted
# to DDS next to the executables; point this at a Vulkan-Samples assets folder.
set(VULKAN_SAMPLES_ASSETS_DIR "" CACHE PATH "Vulkan-Samples assets folder, with textures/terrain_*.ktx")
# A host tool for those assets: the mip levels the framework generates for the ASTC textures it
# decodes, with the same stb_image_resize (Donut's copy of it), into DDS files.
if (VULKAN_SAMPLES_ASSETS_DIR AND NOT CMAKE_CROSSCOMPILING)
    add_executable(dds_mips tools/dds_mips.cpp)
    target_include_directories(dds_mips PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/external/Donut/thirdparty/stb/deprecated")
endif()
donut_compile_shaders_all_platforms(
    TARGET terrain_tessellation_shaders
    PROJECT_NAME "Terrain Tessellation"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/terrain_tessellation.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/terrain_tessellation.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/terrain_tessellation
)
add_tslang_example(terrain_tessellation)
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
add_tslang_example(instancing)
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
add_tslang_example(hdr)
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
add_tslang_example(ray_tracing_extended)
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
add_tslang_example(multi_draw_indirect)
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
    add_custom_command(OUTPUT ${outputs}
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" ${arguments}
        DEPENDS ${sources} "${CMAKE_CURRENT_SOURCE_DIR}/tools/ktx_to_dds.py" "${CMAKE_CURRENT_SOURCE_DIR}/tools/astc.py"
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
add_tslang_example(async_compute_bloom)
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
add_tslang_example(oit_linked_lists)
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
add_tslang_example(gshader_to_mshader)
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
add_tslang_example(sparse_image)
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

# Port of Vulkan-Samples' conservative_rasterization: a triangle drawn at low resolution with and
# without conservative rasterization, stretched over the screen, its real outline over it.
donut_compile_shaders_all_platforms(
    TARGET conservative_rasterization_shaders
    PROJECT_NAME "Conservative Rasterization"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/conservative_rasterization.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/conservative_rasterization.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/conservative_rasterization
)
add_tslang_example(conservative_rasterization)

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
add_tslang_example(conditional_rendering)
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
add_tslang_example(rasterization_order_attachment_access)
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
add_tslang_example(fragment_shader_barycentric)
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
add_tslang_example(logic_op_dynamic_state)
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
add_tslang_example(oit_depth_peeling)
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
add_tslang_example(render_octomap)
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
    add_tslang_example(ray_tracing_invocation_reorder core/d3d12_agility_sdk.cpp)
else()
    add_tslang_example(ray_tracing_invocation_reorder)
endif()
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
add_tslang_example(msaa MEDIA msaa)
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
add_tslang_example(dynamic_blending)

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
add_tslang_example(texture_mipmap_generation MEDIA texture_mipmap_generation)
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
add_tslang_example(ray_tracing_position_fetch MEDIA ray_tracing_position_fetch)
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
add_tslang_example(fragment_shading_rate_dynamic MEDIA fragment_shading_rate_dynamic)
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
donut_compile_shaders_all_platforms(
    TARGET texture_compression_comparison_shaders
    PROJECT_NAME "Texture Compression Comparison"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/texture_compression_comparison.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/msaa.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/texture_compression_comparison
)
add_tslang_example(texture_compression_comparison core/basis_transcoder.cpp MEDIA texture_compression_comparison)
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
add_tslang_example(dynamic_line_rasterization)

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
add_tslang_example(extended_dynamic_state2 MEDIA extended_dynamic_state2)
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
add_tslang_example(fragment_shading_rate MEDIA fragment_shading_rate)
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
add_tslang_example(memory_budget MEDIA memory_budget)
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
add_tslang_example(mobile_nerf MEDIA mobile_nerf)
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
add_tslang_example(dynamic_primitive_clipping MEDIA dynamic_primitive_clipping)
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
add_tslang_example(mobile_nerf_rayquery MEDIA mobile_nerf)
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
add_tslang_example(ray_queries MEDIA ray_tracing_extended)
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
add_tslang_example(ray_tracing_reflection)

# Port of Vulkan-Samples' timestamp_queries: its hdr sample (hdr's shaders and models) with the GPU
# time of each pass measured by timer queries and shown in the UI.
donut_compile_shaders_all_platforms(
    TARGET timestamp_queries_shaders
    PROJECT_NAME "Timestamp Queries"
    CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/shaders/timestamp_queries.cfg
    SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/shaders/hdr.hlsl
    OUTPUT_BASE ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/shaders/timestamp_queries
)
add_tslang_example(timestamp_queries MEDIA hdr)
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
add_tslang_example(patch_control_points MEDIA patch_control_points)
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
add_tslang_example(dynamic_multisample_rasterization MEDIA msaa dynamic_multisample_rasterization)
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
add_tslang_example(vertex_dynamic_state MEDIA hdr)
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
add_tslang_example(dynamic_rendering MEDIA hdr)
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
add_tslang_example(graphics_pipeline_library MEDIA hdr)
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
add_tslang_example(dynamic_uniform_buffers)

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
add_tslang_example(texture_loading MEDIA fragment_shading_rate)
if (TARGET fragment_shading_rate_media)
    add_dependencies(texture_loading fragment_shading_rate_media)
endif()

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
add_tslang_example(separate_image_sampler MEDIA fragment_shading_rate)
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
add_tslang_example(dynamic_rendering_local_read MEDIA dynamic_rendering_local_read)
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
add_tslang_example(shader_object MEDIA hdr instancing/rock.gltf terrain_tessellation texture_mipmap_generation/checkerboard_rgba.dds)
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
add_tslang_example(texture_compression_basisu core/basis_transcoder.cpp MEDIA texture_compression_basisu)
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
add_tslang_example(fast_block_compress core/fast_block_compress.cpp core/fbc_cpu.cpp MEDIA fast_block_compress)
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
add_tslang_example(simple_hdr MEDIA fonts)

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
    add_tslang_example(video_texture core/video_player.cpp MEDIA fonts video_texture)
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
add_tslang_example(bokeh core/sdkmesh.cpp MEDIA fonts bokeh)
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
add_tslang_example(raytracing_ao core/sdkmesh.cpp MEDIA fonts raytracing_ao)
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
add_tslang_example(simple_pbr core/sdkmesh.cpp MEDIA fonts simple_pbr)
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
add_tslang_example(simple_compute MEDIA fonts)

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
add_tslang_example(rt_bindless MEDIA sponza-plus.scene.json glTF-Sample-Assets/Models/Sponza glTF-Sample-Assets/Models/BrainStem)

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
add_tslang_example(rt_reflections MEDIA glTF-Sample-Assets/Models/Sponza)

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
add_tslang_example(rt_particles MEDIA rt_particles nvidia-logo.png)

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
    add_tslang_example(work_graphs core/d3d12_agility_sdk.cpp)
endif()

# Port of Donut-Samples' feature_demo: Donut's full renderer (deferred or forward shading, cascaded
# shadows, SSAO, procedural sky, TAA or MSAA, bloom, tone mapping, light probes, material picking)
# over a loaded scene, with an ImGui settings window and material editor; DLSS with
# DONUT_WITH_DLSS=ON. No shaders of its own; needs the scenes and fonts of DONUT_SAMPLES_MEDIA_DIR above.
add_tslang_example(feature_demo MEDIA fonts sponza-plus.scene.json glTF-Sample-Assets rt_particles)
copy_dlss_library(feature_demo)

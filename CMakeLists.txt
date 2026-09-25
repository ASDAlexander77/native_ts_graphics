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

add_subdirectory(external/Donut)

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
add_library(donut_interop STATIC donut_interop.cpp)
set_target_properties(donut_interop PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)
target_link_libraries(donut_interop PUBLIC
    donut_core
    donut_render
    donut_app
    donut_engine
)

if (NVRHI_WITH_DX12)
    # Forwards the CMake option as a C++ preprocessor macro so _pydonut.cpp can guard its
    # D3D12 Work Graphs interop code the same way it already guards DXC via PYDONUT_HAVE_DXC.
    target_compile_definitions(donut_interop PRIVATE NVRHI_WITH_DX12=1)
    # d3dx12/d3dx12.h (CD3DX12_STATE_OBJECT_DESC, CD3DX12_WORK_GRAPH_SUBOBJECT, ...) ships in the
    # Agility SDK package fetched above by FetchAgilitySDK.cmake, not on any include path yet.
    target_include_directories(donut_interop PRIVATE "${DONUT_D3D_AGILITY_SDK_PATH}/build/native/include")
endif()

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

# One executable per example, built from <name>.ts. Its shaders (the <name>_shaders target)
# must be compiled into bin/shaders/<name>/<dxbc|dxil|spirv>: donut_interop loads them from
# the folder named after the executable.
function(add_tslang_example name)
    # .ts files compile with the TSLANG command. The target has no .cpp, so link with the C++
    # rule explicitly: the C++ link flags (debug info, CRT) apply and the tslang compile flags
    # stay off the link line.
    add_executable(${name} ${name}.ts)
    set_target_properties(${name} PROPERTIES LINKER_LANGUAGE CXX)
    target_link_libraries(${name} PRIVATE ${TSLANG_LINK_LIBS} donut_interop)
    add_dependencies(${name} ${name}_shaders)
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

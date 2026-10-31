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
include(FetchContent)
FetchContent_Declare(nriframework
    GIT_REPOSITORY https://github.com/NVIDIA-RTX/NRIFramework.git
    GIT_TAG 80fd6380500b9228c615fb71e5cd62d3c05df03b
    GIT_SUBMODULES_RECURSE ON)

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

# Without the Agility SDK: NRI's D3D12 backend would then need D3D12SDKVersion and D3D12SDKPath
# exported from the executable (a tslang one exports nothing), and the triangle needs no new D3D12.
set(NRI_ENABLE_AGILITY_SDK_SUPPORT OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(nriframework)

add_library(nri_interop SHARED nri_interop.cpp)
target_link_libraries(nri_interop PRIVATE NRIFramework)
if (WIN32)
    target_compile_definitions(nri_interop PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
    # NRIFramework's link options (/NOIMPLIB, /NOEXP: for an executable exporting the Agility SDK's
    # symbols) would leave this library without the import library the examples link.
    set_property(TARGET NRIFramework PROPERTY INTERFACE_LINK_OPTIONS "")
else()
    set_target_properties(nri_interop PROPERTIES CXX_VISIBILITY_PRESET hidden)
endif()
# The import library (Windows) where the main project looks for it.
set_target_properties(nri_interop PROPERTIES ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")

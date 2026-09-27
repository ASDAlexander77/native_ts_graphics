// Makes D3D12 load the Agility SDK runtime (D3D12Core.dll in the D3D12 folder next to the
// executable, copied there by CMakeLists.txt) instead of the system's, for features the OS's
// runtime may lack (work graphs). D3D12 looks these two up among the executable's own exports, so
// this file is linked into the executables that need them only, by add_tslang_example.

#include <cstdint>

extern "C"
{
    // Version of the runtime the executable is built for (DONUT_D3D_AGILITY_SDK_VERSION, from the
    // package's d3d12.idl).
    __declspec(dllexport) extern const uint32_t D3D12SDKVersion = DONUT_D3D_AGILITY_SDK_VERSION;
    // Relative to the executable's directory.
    __declspec(dllexport) extern const char* D3D12SDKPath = ".\\D3D12\\";
}

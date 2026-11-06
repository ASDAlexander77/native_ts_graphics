// Makes D3D12 load the preview Agility SDK runtime (D3D12Core.dll in the D3D12Preview folder next to
// the executable, copied there by CMakeLists.txt when WITH_D3D12_PREVIEW_SDK fetched it) instead of the
// system's: the D3D12 PTLAS preview (ptlas, core/ptlas.cpp). As core/d3d12_agility_sdk.cpp, for the
// executables that link this file instead. The preview runtime loads only with Windows' Developer
// Mode on; without it D3D12 device creation fails (D3D12_ERROR_INVALID_REDIST).

#include <cstdint>

extern "C"
{
    // D3D12_PREVIEW_SDK_VERSION of the package's d3d12.h.
    __declspec(dllexport) extern const uint32_t D3D12SDKVersion = DONUT_D3D12_PREVIEW_SDK_VERSION;
    // Relative to the executable's directory.
    __declspec(dllexport) extern const char* D3D12SDKPath = ".\\D3D12Preview\\";
}

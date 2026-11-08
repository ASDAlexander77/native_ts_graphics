@rem Runs the RTXDI Minimal Sample under the JIT (run_jit_rtxdi.bat [args]), against %D%: donut_interop_shared.dll (with
@rem core/rtxdi.cpp, from a build with RTXDI_DIR). From the repo root. Runs on D3D12 (-dx12 is hardcoded: edit it for Vulkan).
@pushd %~dp0
set D=build-rtxdi/bin
"tslang.exe" --shared-libs=%D%/donut_interop_shared.dll examples/rtxdi_minimal.ts -- -dx12 %*
@popd

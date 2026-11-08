@rem Runs the RTXDI Minimal Sample under the JIT (run_jit_rtxdi.bat [args], e.g. -vk), against %D%: donut_interop_shared.dll
@rem (with core/rtxdi.cpp, from a build with RTXDI_DIR) and input_pass.dll as run_jit_rtxcr.bat. From the repo root.
@pushd %~dp0
set D=build-rtxdi/bin
"tslang.exe" --shared-libs=%D%/donut_interop_shared.dll examples/rtxdi_minimal.ts -- -dx12 %*
@popd

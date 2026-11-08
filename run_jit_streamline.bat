@rem Runs streamline_demo under the JIT (run_jit_streamline.bat [args], e.g. -test, -vk), against %D%:
@rem donut_interop_shared.dll, whose folder has the Streamline runtime in streamline/ (copy_streamline_binaries).
@pushd %~dp0
rem set D=build-release-streamline/bin
set D=build-streamline/bin
"tslang.exe" --shared-libs=%D%/donut_interop_shared.dll examples/streamline_demo.ts -- -dx12 %*
@popd

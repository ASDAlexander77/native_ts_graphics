@rem Runs an example under the JIT for debugging (run_jitd.bat examples/<name>.ts [-- args]), as
@rem run_jit.bat but with --jit-native: the JIT cache (__jit_dbg) is linked into a DLL with a PDB by
@rem lld-link (LLVM\bin), so Visual Studio and WinDbg debug it with symbols and source. It links
@rem donut_interop_shared.dll's import library and loads the DLL and its dependencies from %D%.
@setlocal
@pushd %~dp0
rem set B=build-dlss
set B=build
set D=%B%/bin
@rem tslang.exe's folder, with its runtime and GC libraries.
for %%i in (tslang.exe) do set T=%%~dp$PATH:i
set PATH=%~dp0%B%\bin;C:\Program Files\LLVM\bin;%PATH%
@rem nri_interop: the NRI examples' (basic_triangle_nri).
"tslang.exe" --jit-native --jit-cache-dir=%~dp0__jit_dbg --tslang-lib-path=%T% --gc-shared-lib-path=%T%gcdll --lib=%B%/donut_interop_shared.lib --lib=%B%/nri/nri_interop.lib --shared-libs=%D%/donut_interop_shared.dll --shared-libs=%D%/nri_interop.dll %* -- -dx12
@popd
@endlocal

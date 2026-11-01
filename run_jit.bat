@rem Runs an example under the JIT (run_jit.bat examples/<name>.ts [-- args]), against %D%: donut_interop_shared.dll,
@rem and input_pass.dll (with the default library it links) for the shared InputPass the example
@rem imports. From the repo root, where no ../core/input_pass.dll is, so the import reads
@rem core/input_pass.ts for its declarations.
@pushd %~dp0
rem set D=build-release-dlss/bin
rem set D=build-release-rtxcr/bin
set D=build-release/bin
@rem nri_interop.dll: the NRI examples' (basic_triangle_nri, mesh_shading_nri).
"tslang.exe" --shared-libs=%D%/donut_interop_shared.dll --shared-libs=%D%/nri_interop.dll %* -- -dx12
@popd

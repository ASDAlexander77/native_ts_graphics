@rem Runs an example under the JIT (run_jit.bat examples/<name>.ts [args]), against %D%: donut_interop.dll,
@rem and input_pass.dll (with the default library it links) for the shared InputPass the example
@rem imports. From the repo root, where no ../core/input_pass.dll is, so the import reads
@rem core/input_pass.ts for its declarations.
@pushd %~dp0
set D=build-release-dlss/bin
tslang --shared-libs=%D%/donut_interop.dll,%D%/TypeScriptDefaultLib.dll,%D%/input_pass.dll %*
@popd

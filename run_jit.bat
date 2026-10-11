@rem Runs an example under the JIT (run_jit.bat examples/<name>.ts [-- args]), against %D%: donut_interop.dll,
@rem and input_pass.dll (with the default library it links) for the shared InputPass the example
@rem imports. From the repo root, where no ../core/input_pass.dll is, so the import reads
@rem core/input_pass.ts for its declarations.
@pushd %~dp0
rem set D=build-release-dlss/bin
set D=build/bin
@rem --jit-cache=false: tslang pre-alpha93's JIT cache crashes (0xC0000005) in a run that compiles
@rem two or more modules (TypeScriptCompiler#548): an example's first two runs, with its imports.
tslang --jit-cache=false --shared-libs=%D%/donut_interop.dll %*
@popd

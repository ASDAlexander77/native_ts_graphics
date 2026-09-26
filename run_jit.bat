@rem Runs basic_triangle_jit.ts under the JIT, against build-release: donut_interop.dll, and input_pass.dll
@rem (with the default library it links) for the shared InputPass the example imports. From the repo
@rem root, where no input_pass.dll is, so the import reads input_pass.ts for its declarations.
@pushd %~dp0
tslang --shared-libs=build-release/bin/donut_interop.dll,build-release/bin/TypeScriptDefaultLib.dll,build-release/bin/input_pass.dll basic_triangle_jit.ts %*
@popd

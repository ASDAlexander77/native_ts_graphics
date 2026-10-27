@rem Runs an example under the JIT (run_jit.bat examples/<name>.ts [-- args]), against %D%: donut_interop_shared.dll,
@rem and input_pass.dll (with the default library it links) for the shared InputPass the example
@rem imports. From the repo root, where no ../core/input_pass.dll is, so the import reads
@rem core/input_pass.ts for its declarations.
@pushd %~dp0
set D=build-release-rtxcr/bin
rem "tslang.exe" --shared-libs=%D%/donut_interop_shared.dll examples/rtxcr_pathtracer.ts -- -dx12 -dlss -dlss5 --scene E:/Gits/RTXCR/assets/claire.animation.scene.json %*
"tslang.exe" --shared-libs=%D%/donut_interop_shared.dll examples/rtxcr_raster.ts -- -dx12 -dlss -dlss5 --scene E:/Gits/RTXCR/assets/claire.animation.scene.json %*
rem "tslang.exe" --shared-libs=%D%/donut_interop_shared.dll examples/rtxcr_raster.ts -- -dx12 -dlss -dlss5 --scene E:/Gits/RTXCR/assets/try1.scene.json %*
@popd

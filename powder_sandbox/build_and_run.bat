rem Builds powder_sandbox_nri (release-rc) and runs it on D3D12, from the repository's root.
cd /d "%~dp0.."
set r="C:\Program Files\Microsoft Visual Studio\18\Professional\VC\Auxiliary\Build\vcvars64.bat"
set p=release-rc
cmd /c "call %r% && cmake --preset %p% && cmake --build --preset %p% --target powder_sandbox_nri copy_media"
.\build-release-rc\bin\powder_sandbox_nri.exe -dx12
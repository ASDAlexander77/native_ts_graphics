rem Builds examples (release)
set r="C:\Program Files\Microsoft Visual Studio\18\Professional\VC\Auxiliary\Build\vcvars64.bat"
rem set p=default
rem set p=default-rc
rem set p=default-own
REM set p=release
set p=release-rc
rem set p=release-own
cmd /c "call %r% && cmake --preset %p% && cmake --build --preset %p%"

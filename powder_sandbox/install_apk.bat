@echo off
rem Installs the debug powder_sandbox_nri.apk built for the device's ABI (arm64-v8a: a phone,
rem x86_64: the emulator). With several devices connected, set ANDROID_SERIAL to the one to use.
rem `install_apk.bat release` installs the release APK instead (both ABIs; signed with the upload
rem key, so a debug install has to be uninstalled first).
setlocal
set root=%~dp0..
set adb=adb
where adb >nul 2>nul || set adb=C:\Android\sdk\platform-tools\adb.exe
for /f "usebackq delims=" %%a in (`"%adb%" shell getprop ro.product.cpu.abi`) do set abi=%%a
if "%abi%"=="arm64-v8a" (set build=build-android-arm64) else if "%abi%"=="x86_64" (set build=build-android-x86_64) else (
    echo install_apk: no build for the device's ABI "%abi%"
    exit /b 1
)
if /i "%~1"=="release" (
    set apk=%root%\build-android-arm64\bin\powder_sandbox_nri-release.apk
) else (
    set apk=%root%\%build%\bin\powder_sandbox_nri.apk
)
echo install_apk: %abi%: %apk%
"%adb%" install -r "%apk%" && exit /b 0
rem each build folder signs with its own debug key: INSTALL_FAILED_UPDATE_INCOMPATIBLE means the
rem installed copy came from another one (its saves go with it if it's uninstalled)
echo install_apk: if the signatures don't match, uninstall the installed copy first:
echo     "%adb%" uninstall org.native_ts_graphics.powder_sandbox_nri  (the release: io.github.asdalexander77.powdersandbox)
exit /b 1

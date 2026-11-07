@echo off
rem Configures the Android builds the Play release is made from (once, or after a CMake change):
rem the arm64 build makes the release and packages the x86_64 build's libraries with its own, so one
rem .aab (and one .apk) carries both ABIs.
pushd "%~dp0.."
set root=%CD:\=/%
rem the Android builds compile their shaders with a desktop ShaderMake: build it if there is none
python tools\android.py shadermake || goto :failed
cmake --preset android-x86_64 || goto :failed
cmake --preset android-arm64 -DANDROID_RELEASE_KEYSTORE=I:/keys/powder-sandbox-upload.jks ^
    -DANDROID_RELEASE_MERGE_BUILDS=%root%/build-android-x86_64 || goto :failed
popd
exit /b 0

:failed
popd
exit /b 1

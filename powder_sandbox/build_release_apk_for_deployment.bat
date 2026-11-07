@echo off
rem Builds the Play release (run config_release_apk_for_deployment.bat once first): the x86_64
rem libraries, then the arm64 build's release, which packages both ABIs into
rem build-android-arm64/bin/powder_sandbox_nri-release.aab (upload it), -release.apk (both ABIs,
rem to install and check) and -native-debug-symbols.zip.
rem Set ANDROID_RELEASE_STORE_PASSWORD and ANDROID_RELEASE_KEY_PASSWORD first.
pushd "%~dp0.."
cmake --build --preset android-x86_64 --target powder_sandbox_nri_apk || goto :failed
cmake --build --preset android-arm64 --target powder_sandbox_nri_release || goto :failed
popd
exit /b 0

:failed
popd
exit /b 1

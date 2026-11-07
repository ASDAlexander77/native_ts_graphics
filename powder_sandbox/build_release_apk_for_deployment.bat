pushd
cd..
rem ANDROID_RELEASE_STORE_PASSWORD
rem ANDROID_RELEASE_KEY_PASSWORD
cmake --build --preset android-arm64 --target powder_sandbox_nri_release
cmake --build --preset android-x86_64 --target powder_sandbox_nri_release

popd
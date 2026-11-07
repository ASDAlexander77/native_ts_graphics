pushd
cd..
cmake --preset android-arm64 -DANDROID_RELEASE_KEYSTORE=I:\keys\powder-sandbox-upload.jks
cmake --preset android-x86_64 -DANDROID_RELEASE_KEYSTORE=I:\keys\powder-sandbox-upload.jks
popd

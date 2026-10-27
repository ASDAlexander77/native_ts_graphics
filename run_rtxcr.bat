@pushd %~dp0
set D=build-release-rtxcr/bin
"%D%/rtxcr_raster.exe" -dx12 -dlss -dlss5 --scene E:/Gits/RTXCR/assets/claire.animation.scene.json -enableAnimation 1 %*
@popd

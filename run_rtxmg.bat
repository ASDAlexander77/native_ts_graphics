@pushd %~dp0
set D=build-release-rtxmg/bin
"%D%/rtxmg_demo.exe" -dx12 --media E:/Gits/RTXMG/assets --scene subdivision/amy_kitchenset.scene.json %*
@popd

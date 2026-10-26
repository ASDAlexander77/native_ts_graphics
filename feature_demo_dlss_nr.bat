@pushd %~dp0
set D=%~dp0build-release-dlss-nr\bin
%D%\feature_demo.exe -dx12 -dlss -dlss5 %*
@popd

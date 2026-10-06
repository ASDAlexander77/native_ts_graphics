# Custom language with your own extension and compile command in CMake

This registers TypeScript CMake *language* (`TSLANG`) that:

- owns its own source extension (`.ts`),
- is built with **tslang --emit=obj**,
- produces `.obj` files that CMake links automatically alongside regular C++.

CMake then handles dependency tracking and incremental builds for `.ts`
sources the same way it does for `.cpp`.

## Layout

```
custom_lang/
├── CMakeLists.txt
├── cmake/
│   ├── CMakeDetermineTSLANGCompiler.cmake
│   ├── CMakeTSLANGCompiler.cmake.in
│   ├── CMakeTSLANGInformation.cmake
│   └── CMakeTestTSLANGCompiler.cmake
├── main.cpp
└── mycode.ts
```

## How it works

- `enable_language(TSLANG)` runs `CMakeDetermineTSLANGCompiler.cmake`, which finds
  `tslangc`, then loads `CMakeTSLANGInformation.cmake`, which registers the compile
  rule (`CMAKE_TSLANG_COMPILE_OBJECT` — *tslang --emit=obj*).
- Because `CMAKE_TSLANG_SOURCE_FILE_EXTENSIONS` contains `tslang`, any `.ts` source
  is routed to your command and compiled to a `.obj`.
- That `.obj` is added to the target and linked with `main.cpp`'s object using
  the C++ linker (`CMAKE_TSLANG_LINK_EXECUTABLE`).
- Change `mycode.ts` and only it recompiles.
- Compile: `cmake --preset default && cmake --build --preset default`

## Passing flags

```cmake
set(CMAKE_TSLANG_FLAGS "--opt_level=3")                       # global
set_source_files_properties(mycode.ts PROPERTIES
    COMPILE_OPTIONS "--define;TSLANG=1")                      # per-file
```

## Memory model

The default library is compiled separately for each memory model, and a program has to link
the build matching the model it was compiled with. One variable drives both:

```
cmake --preset default -DTSLANG_MEMORY_MODEL=rc
```

It selects `defaultlib/lib/<target>/<debug|release>/<model>` (on Windows
`defaultlib/lib/x86_64/pc/windows/msvc/release/gc`, as `tslang --print-default-lib-dir=lib` names
it) as the link directory and adds `-mm=<model>` to the compile flags, so the two cannot disagree.
Valid values are `gc` (default), `rc` and `none`; only `gc` links Boehm.

## Android

The `android-x86_64` (emulator) and `android-arm64` (devices) presets cross-compile with the
Android NDK for API 29, Vulkan only.

Shaders are compiled at build time by ShaderMake, which has to run on this machine, so build the
desktop preset first; its `build-release/bin/ShaderMake.exe` is found (or set
`DONUT_HOST_SHADERMAKE`). DXC comes from the Vulkan SDK.

```
set ANDROID_NDK_HOME=C:\Android\android-ndk-r30
cmake --preset android-x86_64
cmake --build --preset android-x86_64 --target basic_triangle_apk
```

Each example is an app, `<example>_apk` (not built by default): `bin/<example>.apk`, a
NativeActivity running `lib<example>.so` (the example with `core/android_main.cpp`), with its
shaders and the media its `add_tslang_example(<example> MEDIA ...)` lists (the files and folders
of `media/` it reads), signed with a debug key made in the build folder. Packaging
(`tools/package_apk.py`) needs the Android SDK's build tools and platform 29 (`ANDROID_HOME`, or
the SDK next to the NDK, or `ANDROID_SDK_DIR`), a JDK (`JAVA_HOME`, or `ANDROID_JAVA_HOME`) and
Python.

```
adb install -r build-android-x86_64/bin/basic_triangle.apk
adb shell am start -n org.powdertoy_game.basic_triangle/android.app.NativeActivity
adb logcat -s basic_triangle
```

The window is the activity's, through GLFW's Android platform
(`patches/glfw-android-platform.patch`): touch drives the mouse cursor and left button, Back is
Escape, and the display density is the content scale. What the examples print goes to logcat
under their name. An example runs once per process: Back, or the activity leaving the screen,
closes it and the process exits. Their shaders and media are extracted into the app's storage on
the first start after an install.

`headless` needs no window, and runs as a plain executable as well, from `bin/`:

```
adb push build-android-x86_64/bin /data/local/tmp/
adb shell "cd /data/local/tmp/bin && ./headless"
```

The default library comes from tslang's tree for the Android triple; the collector and the async
runtime from `<tslang>/android/<abi>/lib` (`TSLANG_ANDROID_LIB_DIR`).

## Minimal alternative

If you don't need a first-class language, either:

- Mark a file as an already-built object and just link it:
  `set_source_files_properties(mycode.obj PROPERTIES EXTERNAL_OBJECT TRUE GENERATED TRUE)`
  and add it to `add_executable`, producing it with `add_custom_command`; or
- Compile a differently-named file *as C++*:
  `set_source_files_properties(mycode.tslang PROPERTIES LANGUAGE CXX)`.

Use the typescript-language setup below when `.ts` is a source type you
compile often and want CMake to treat as first-class.

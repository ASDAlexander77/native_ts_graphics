# Native TypeScript Graphics

Graphics samples written for the TypeScript native compiler, tslang.

The samples run on top of the Donut rendering framework (D3D12 and Vulkan,
including Android). Under the hood, the project registers a CMake *language*
(`TSLANG`) that:

- owns its own source extension (`.ts`),
- is built with **tslang --emit=obj**,
- produces `.obj` files that CMake links automatically alongside regular C++.

CMake then handles dependency tracking and incremental builds for `.ts`
sources the same way it does for `.cpp`.

TypeScript is a trademark of Microsoft; this project is not affiliated with or
endorsed by Microsoft.

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
Android NDK for API 29, Vulkan only. `tools/android.py` builds them, starts an emulator, and runs
and tests the examples on it; what it does by hand is under *Without the script*.

### What to install

- the Android NDK (r30 is the one tested), in `ANDROID_NDK_HOME`;
- the Android SDK, in `ANDROID_HOME` (or next to the NDK): platform-tools, build-tools,
  platform 29, and for an emulator the emulator, an x86_64 system image and a virtual device:

  ```
  sdkmanager "platform-tools" "build-tools;35.0.0" "platforms;android-29" "emulator" "system-images;android-34;google_apis;x86_64"
  avdmanager create avd -n api34_x86_64 -k "system-images;android-34;google_apis;x86_64"
  ```

  The API 34 Google APIs image also runs arm64 apps, translated (simple ones: `feature_demo`
  crashes the emulator);
- a JDK (17 or later) for signing, in `JAVA_HOME` (or in `jdk/` next to the SDK);
- Python 3, and the Vulkan SDK (`VULKAN_SDK`) for DXC;
- tslang with its Android libraries, `<tslang>/android/<abi>/lib`.

Shaders are compiled at build time by ShaderMake, which has to run on this machine, so the
Android build takes the desktop build's `build-release/bin/ShaderMake.exe` (or
`DONUT_HOST_SHADERMAKE`). The script builds it if it isn't there, in the Visual Studio
environment.

### Build and test

```
python tools/android.py build
python tools/android.py emulator
python tools/android.py test
```

- `build` configures `build-android-x86_64` if it isn't, and builds `headless` and every
  example's APK, `bin/<example>.apk`; name examples to build only theirs
  (`build basic_triangle vertex_buffer`), and `--abi arm64` builds for devices.
- `emulator` starts the newest virtual device (`--avd <name>` picks one, `--no-window` hides
  it) unless a device is connected, and waits for it to boot. `adb emu kill` stops it.
- `test` runs `headless`, then installs and starts each example: it has to be running after 20 s
  (`--seconds`), and to close without a crash on Back. Screenshots and logs go to
  `build-android-x86_64/android-test`. With no examples named, it tests the ones that run on the
  emulator, whose Vulkan is lavapipe, on the CPU, with no ray tracing or mesh shaders:
  basic_triangle, vertex_buffer, deferred_shading, shader_specializations, threaded_rendering,
  async_compute and feature_demo.
- `run <example>` installs and starts one and follows its log (Ctrl+C stops following);
  `--screenshot shot.png` takes a screenshot instead. `headless` runs headless alone.

`test`, `run` and `headless` start an emulator themselves if no device is connected; with more
than one, pass `--serial`. On a phone: enable USB debugging, `build --abi arm64`, and
`test --abi arm64 <examples>`.

### How the examples run

Each example is an app, `<example>_apk` (not built by default): `bin/<example>.apk`, a
NativeActivity running `lib<example>.so` (the example with `core/android_main.cpp`), with its
shaders and the media its `add_tslang_example(<example> MEDIA ...)` lists (the files and folders
of `media/` it reads), signed with a debug key made in the build folder (an app installed from
another build folder has to be uninstalled first; the script does that). Packaging
(`tools/package_apk.py`) needs the SDK's build tools and platform 29 (`ANDROID_HOME`, or the SDK
next to the NDK, or `ANDROID_SDK_DIR`), a JDK (`JAVA_HOME`, or `ANDROID_JAVA_HOME`) and Python.
`rt_reflections` has no APK that builds: it is D3D12-only.

The window is the activity's, through GLFW's Android platform
(`patches/glfw-android-platform.patch`): touch drives the mouse cursor and left button, Back is
Escape, and the display density is the content scale. What the examples print goes to logcat
under their name. An example runs once per process: Back, or the activity leaving the screen,
closes it and the process exits. Their shaders and media are extracted into the app's storage on
the first start after an install.

The default library comes from tslang's tree for the Android triple; the collector and the async
runtime from `<tslang>/android/<abi>/lib` (`TSLANG_ANDROID_LIB_DIR`).

### Without the script

With `ANDROID_NDK_HOME` set, and `adb` and `emulator` (the SDK's `platform-tools` and `emulator`)
on the `PATH`:

```
cmake --preset android-x86_64
cmake --build --preset android-x86_64 --target headless basic_triangle_apk

emulator -avd api34_x86_64 -no-audio -no-boot-anim
adb wait-for-device

adb install -r build-android-x86_64/bin/basic_triangle.apk
adb shell am start -n org.native_ts_graphics.basic_triangle/android.app.NativeActivity
adb logcat -s basic_triangle DEBUG
adb exec-out screencap -p > shot.png
adb shell am force-stop org.native_ts_graphics.basic_triangle
```

`headless` needs no window and runs as a plain executable, next to its shaders as in `bin/`:

```
adb shell mkdir -p /data/local/tmp/native_ts_graphics/shaders
adb push build-android-x86_64/bin/headless /data/local/tmp/native_ts_graphics/
adb push build-android-x86_64/bin/shaders/framework build-android-x86_64/bin/shaders/headless /data/local/tmp/native_ts_graphics/shaders/
adb shell "cd /data/local/tmp/native_ts_graphics && chmod +x headless && ./headless"
```

It prints `Test PASSED`. A native crash shows in logcat under `DEBUG`; the APKs hold a stripped
library, and the build folder's `android/<example>/lib<example>.so` keeps the symbols for
`ndk-stack -sym build-android-x86_64/android/<example>`.

## Minimal alternative

If you don't need a first-class language, either:

- Mark a file as an already-built object and just link it:
  `set_source_files_properties(mycode.obj PROPERTIES EXTERNAL_OBJECT TRUE GENERATED TRUE)`
  and add it to `add_executable`, producing it with `add_custom_command`; or
- Compile a differently-named file *as C++*:
  `set_source_files_properties(mycode.tslang PROPERTIES LANGUAGE CXX)`.

Use the typescript-language setup below when `.ts` is a source type you
compile often and want CMake to treat as first-class.

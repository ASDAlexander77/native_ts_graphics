# Moving to tslang's mimalloc heap

tslang gives Windows programs [mimalloc](https://github.com/microsoft/mimalloc) as their heap
under `-mm=rc`, `-mm=own` and `-mm=none` (TypeScriptCompiler PRs #778 and #779; first released in
v0.0-pre-alpha118). A program built by `tslang --emit=exe` gets it automatically. This project links
its executables with its own CMake, which now links `TypeScriptMimalloc` for every model but gc
(step 2). `-DTSLANG_PROCESS_HEAP=ON` goes back to the Windows process heap (`HeapAlloc`).

## Why bother

Measured in tslang's own benchmarks, the same program on the process heap and on mimalloc:

| program | model | process heap → mimalloc |
| --- | --- | --- |
| ray tracer, every vector and colour an object on the heap | own | 529 → 180 ms (2.9×) |
| 20,000 arrays of 200 new objects | rc / own | 131 → 48 ms (2.7×) |
| 5 million strings built with `+` | own | 910 → 696 ms (1.3×) |
| ray tracer with `@value` vectors and colours | own / rc | about 5% |

The gain is in code that makes and drops many small objects, arrays and strings: scene loading,
per-frame temporary objects, string building. Code whose data is already `@value` or on the stack
barely changes. The GPU side is unaffected.

## What does not change

- **`-mm=gc` builds.** Boehm allocates for itself; mimalloc does not apply.
- **Android and Linux builds.** mimalloc is Windows-only in tslang for now (Linux is being worked
  on).
- **The C++ code** (Donut, NVRHI, the interop libraries) keeps the CRT's heap. Only memory that
  TypeScript code allocates moves.

## 1. Get a matching tslang and default library

- A tslang build with both PRs. Its runtime library folder (`TSLANG_LIB_PATH` /
  `--tslang-lib-path`) must hold **`TypeScriptMimalloc.lib`** next to `TypeScriptAsyncRuntime.lib`.
  The Windows release zip includes it from the release that contains #778.
- **A default library rebuilt with that tslang.** Its DLL then carries the marker that says it uses
  the program's heap (`__tslang_heap_shared`). An older build still works, but the JIT then stays
  on the process heap (step 4).
- Rebuild **every** TypeScript library this project builds as a DLL (`input_pass.dll`) with the
  same tslang. A program on mimalloc refuses to load a tslang library built before #779, which
  would keep a heap of its own, with the message "does not allocate from the program's heap ...
  rebuild it".

## 2. Link `TypeScriptMimalloc` into the executables (done)

All executables take their tslang libraries from `TSLANG_LINK_LIBS` in `CMakeLists.txt`
(`add_tslang_example`, the NRI examples). `TypeScriptMimalloc` has to come **before**
`TypeScriptAsyncRuntime`: both define the same five heap functions
(`__tslang_heap_malloc` and the rest), and the linker takes the first definition it finds.

```cmake
# required libs
set(TSLANG_LINK_LIBS "TypeScriptDefaultLib" "TypeScriptAsyncRuntime")

# tslang's mimalloc heap (Windows, every model but gc): ahead of TypeScriptAsyncRuntime, whose
# process-heap definitions of the same functions it replaces. TSLANG_PROCESS_HEAP keeps the
# process heap, for page heap / Application Verifier.
option(TSLANG_PROCESS_HEAP "Allocate TypeScript objects from the Windows process heap instead of mimalloc" OFF)
if (WIN32 AND NOT TSLANG_MEMORY_MODEL STREQUAL "gc" AND NOT TSLANG_PROCESS_HEAP)
    list(INSERT TSLANG_LINK_LIBS 1 "TypeScriptMimalloc")
endif()
```

Rules:

- **Executables only.** A library (`SHARED`) must not link it. A tslang library never owns the
  heap: it borrows the program's.
- `TypeScriptMimalloc.lib` asks for `advapi32.lib` itself; nothing else needs adding.
- It is built against the release static CRT (`/MT`), like `TypeScriptAsyncRuntime.lib`. This
  project already uses `MultiThreaded` everywhere, so there is nothing to change.

## 3. RTX Mega Geometry builds: one mimalloc for both

With `RTXMG_DIR` set, this project fetches **mimalloc v2.1.7** for RTXMG and links its
`mimalloc-static` (`MI_OVERRIDE OFF`). `TypeScriptMimalloc.lib` contains **mimalloc v2.2.4**, all of
it in one object (`static.obj`) next to the heap functions (`MimallocHeap.obj`). Both define `mi_malloc`,
`mi_free` and so on, but the link does not fail: the tslang libraries come first on the link line, so
when the TypeScript side pulls `__tslang_heap_malloc` in, every `mi_*` symbol is already defined by
tslang's copy, and nothing of RTXMG's `mimalloc-static.lib` is linked. The whole process, RTXMG
included, runs on tslang's mimalloc 2.2.4.

Checked on 2026-11-08 (pre-alpha118): `rtxmg_demo` linked that way (its map file has every `mi_*`
from `TypeScriptMimalloc:static.obj`, none from `mimalloc-static`) passes its D3D12 and Vulkan tests.
The C API RTXMG uses is the same in 2.1 and 2.2. If RTXMG misbehaves on 2.2.4, configure with
`-DTSLANG_PROCESS_HEAP=ON`: the TypeScript side then uses the process heap and RTXMG its own 2.1.7.

The RTXMG presets build with the gc model, which does not link `TypeScriptMimalloc` at all.

## 4. The JIT

`run_jit*.bat` load `donut_interop_shared.dll` and `nri_interop.dll` with `--shared-libs`. Under
the JIT, tslang gives the program mimalloc only if every library it is given carries the marker.
These two are C++ libraries without it, so **JIT runs stay on the process heap**. That is safe,
and it is what happens today.

To let JIT runs use mimalloc too, a C++ library can say it is safe by exporting the marker:

```cpp
// donut_interop.cpp (and nri_interop), shared build only: this library never frees memory the
// TypeScript side allocated, and never hands it memory to free, so it is safe beside a program on
// tslang's mimalloc heap.
#ifdef DONUT_INTEROP_SHARED
extern "C" __declspec(dllexport) const int __tslang_heap_shared = 1;
#endif
```

**Only do this after the audit in step 5 holds for that library.** The marker is a promise. If the
library ever frees a TypeScript block, or returns a buffer that TypeScript frees, the process
corrupts memory instead of falling back.

With the marker in place, `tslang --verbose` prints `JIT heap: mimalloc`. Without it, it prints
`JIT heap: process heap`. `input_pass.dll` is built by tslang and gets the marker by being rebuilt
(step 1).

## 5. Audit what crosses between C++ and TypeScript

Until now, a block that crossed by mistake between the CRT's `malloc` and the TypeScript heap was
harmless: in a release build both are the process heap. On mimalloc they are different heaps. Look
for two patterns:

- **C++ freeing something TypeScript allocated:** `free`, `delete` or `HeapFree` on a pointer that
  came in from TypeScript (an array's data, a string, an object).
- **TypeScript freeing something C++ allocated:** a function returning a `malloc`/`new` buffer that
  the TypeScript side frees, or that it treats as its own string or array without copying.

Fine as they are:

- C++ objects behind handles with an explicit destroy function (`Donut_*Destroy`, `*_free`): both
  ends are C++.
- `const char *` results from C++: tslang copies a C string returned by a foreign call into a
  string of its own.
- TypeScript data the C++ side only reads or writes during the call (vertex data, staging
  buffers).

Checked on 2026-11-08: the only `malloc`/`free` calls in `core/` are `FbcAlignedMalloc` /
`FbcAlignedFree` (`core/fbc_cpu_compat.h`) and the BMP buffer in `core/pbrt/PBRTParser.cpp`, both
allocated and freed on the C++ side; `cgltf_free` in `core/donut_interop.cpp` releases cgltf's own
data. Everything else crosses as handles with a destroy function. `nri_interop` has not been
checked. A quick search to repeat:

```bat
findstr /s /n /r "malloc free( strdup HeapFree delete" core\*.cpp core\*.h core\interop\*
```

## 6. Check it works, then measure

1. Configure an rc preset, build, and run a few examples, including one that loads a big scene
   (Sponza: `threaded_rendering`, `rt_shadows`, `variable_shading`).
2. Confirm an executable really has mimalloc: run it with `set MIMALLOC_SHOW_STATS=1`. mimalloc
   prints a `heap stats:` table when the program exits. On the process heap nothing is printed.
3. Measure before and after with the same build and `-DTSLANG_PROCESS_HEAP=ON` / `OFF`: scene load
   time and CPU frame time. Expect the gain mostly in loading and in examples that create objects
   every frame.
4. If anything misbehaves, `-DTSLANG_PROCESS_HEAP=ON` puts the TypeScript side back on the process
   heap, where page heap and Application Verifier work. An actual cross-heap free usually shows up
   as a crash in `mi_free` or in `HeapFree`.

Results on 2026-11-08 (pre-alpha118, Windows, Debug): the gc build (no mimalloc) and an rc build on
mimalloc both pass all 631 tests; `MIMALLOC_SHOW_STATS=1` prints the `heap stats:` table for the rc
build. JIT runs under `-mm=rc` print `JIT heap: process heap` (step 4) and pass. Not measured yet:
the own model, Release timings against `-DTSLANG_PROCESS_HEAP=ON`.

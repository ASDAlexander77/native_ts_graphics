#pragma once

// Marks the extern "C" functions core/donut_interop.d.ts declares for TypeScript. donut_interop_shared
// (the DLL for tslang's JIT) exports them, and only them, so its import library holds just the
// Donut_* functions; donut_interop_static, which the example executables link, exports nothing.
#if defined(DONUT_INTEROP_SHARED)
#if defined(_WIN32)
#define DONUT_API __declspec(dllexport)
#else
#define DONUT_API __attribute__((visibility("default")))
#endif
#else
#define DONUT_API
#endif

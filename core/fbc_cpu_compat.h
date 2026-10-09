// What the Xbox ATG FastBlockCompress sample's CPU compressor (fbc_cpu.cpp, fbc_cpu.h) took from the
// sample's precompiled header: the few DXGI / D3D12 / COM definitions it uses, with the values of
// the Windows SDK, without Windows headers (the example builds for Android too), plus aligned
// allocation and SSE2.

#pragma once

#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <vector>

#if defined(_M_X64) || defined(_M_IX86) || defined(__x86_64__) || defined(__i386__)
#include <emmintrin.h>
#endif

#ifdef _WIN32
#include <malloc.h>
#endif

using HRESULT = int32_t;

#ifndef S_OK
#define S_OK ((HRESULT)0)
#define E_INVALIDARG ((HRESULT)0x80070057L)
#define E_OUTOFMEMORY ((HRESULT)0x8007000EL)
#define ERROR_NOT_SUPPORTED 50L
#define HRESULT_FROM_WIN32(x) ((HRESULT)(((x) & 0x0000FFFF) | (7 << 16) | 0x80000000))
#endif

#ifndef _Use_decl_annotations_
#define _Use_decl_annotations_
#define _In_reads_(n)
#endif

// The DXGI_FORMAT values the compressor uses.
enum DXGI_FORMAT
{
    DXGI_FORMAT_UNKNOWN = 0,
    DXGI_FORMAT_R8G8B8A8_UNORM = 28,
    DXGI_FORMAT_BC1_TYPELESS = 70,
    DXGI_FORMAT_BC1_UNORM = 71,
    DXGI_FORMAT_BC1_UNORM_SRGB = 72,
    DXGI_FORMAT_BC3_UNORM = 77,
    DXGI_FORMAT_BC4_TYPELESS = 79,
    DXGI_FORMAT_BC4_UNORM = 80,
    DXGI_FORMAT_BC4_SNORM = 81,
    DXGI_FORMAT_BC5_UNORM = 83,
};

#define D3D12_REQ_MIP_LEVELS 15

struct D3D12_SUBRESOURCE_DATA
{
    const void* pData;
    intptr_t RowPitch;
    intptr_t SlicePitch;
};

inline void* FbcAlignedMalloc(size_t size, size_t alignment)
{
#ifdef _WIN32
    return _aligned_malloc(size, alignment);
#else
    void* p = nullptr;
    return posix_memalign(&p, alignment, size) == 0 ? p : nullptr;
#endif
}

inline void FbcAlignedFree(void* p)
{
#ifdef _WIN32
    _aligned_free(p);
#else
    free(p);
#endif
}

#define _aligned_malloc FbcAlignedMalloc

struct aligned_deleter { void operator()(void* p) { FbcAlignedFree(p); } };

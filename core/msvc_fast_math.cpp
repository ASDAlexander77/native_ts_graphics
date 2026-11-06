// MSVC's /fp:fast float math, for ports of samples built with it (MiniEngine) whose results depend on
// it to the last bit: its optimizer turns sinf and cosf of one argument into one call of the C
// runtime's __libm_sse2_sincosf_, whose cosine can differ from cosf's in the last bits (MiniEngine's
// sun direction: cosf(-0.5f) is 0.877582431 there, not 0.87758255). Called directly, so the result
// doesn't depend on how this file is built; compilers other than MSVC get sinf and cosf.

#include <cmath>

#if defined(_MSC_VER) && defined(_M_X64)
#include <emmintrin.h>
// sin(x) in lane 0, cos(x) in lane 1.
extern "C" __m128 __libm_sse2_sincosf_(float x);
#endif

#include "donut_api.h"

extern "C"
{
    // dst[0] = sinf((float)x), dst[1] = cosf((float)x), as MSVC's /fp:fast code computes the pair.
    DONUT_API void Donut_FastSinCosf(double x, float* dst)
    {
        const float value = static_cast<float>(x);
#if defined(_MSC_VER) && defined(_M_X64)
        alignas(16) float lanes[4];
        _mm_store_ps(lanes, __libm_sse2_sincosf_(value));
        dst[0] = lanes[0];
        dst[1] = lanes[1];
#else
        dst[0] = sinf(value);
        dst[1] = cosf(value);
#endif
    }
}

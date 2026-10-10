//*********************************************************
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).
// THIS CODE IS PROVIDED *AS IS* WITHOUT WARRANTY OF
// ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING ANY
// IMPLIED WARRANTIES OF FITNESS FOR A PARTICULAR
// PURPOSE, MERCHANTABILITY, OR NON-INFRINGEMENT.
//
//*********************************************************

#ifndef HLSLCOMPAT_H
#define HLSLCOMPAT_H

typedef float2 XMFLOAT2;
typedef float3 XMFLOAT3;
typedef float4 XMFLOAT4;
typedef float4 XMVECTOR;
typedef float4x4 XMMATRIX;
typedef uint UINT;
typedef uint2 XMUINT2;
typedef uint3 XMUINT3;
typedef int2 XMINT2;
typedef int BOOL;

#ifdef SPIRV
// Port: f32tof16 as D3D12 converts (rounding toward zero; SPIR-V's conversion rounds to nearest),
// so the packed half floats (the temporal cache's, the G-buffer's depths) come out the same.
uint F32ToF16TowardZero(float value)
{
    const uint f = asuint(value);
    const uint sign = (f >> 16) & 0x8000;
    const uint exponent = (f >> 23) & 0xFF;
    uint mantissa = f & 0x7FFFFF;
    if (exponent == 0xFF)
    {
        return sign | 0x7C00 | (mantissa != 0 ? 0x200 : 0);
    }
    const int halfExponent = int(exponent) - 112;
    if (halfExponent >= 0x1F)
    {
        return sign | 0x7BFF;
    }
    if (halfExponent <= 0)
    {
        // A half float denormal (or zero): the mantissa with its implicit bit, in 2^-24 units.
        if (halfExponent < -10)
        {
            return sign;
        }
        mantissa |= 0x800000;
        return sign | (mantissa >> uint(14 - halfExponent));
    }
    return sign | (uint(halfExponent) << 10) | (mantissa >> 13);
}
uint2 F32ToF16TowardZero(float2 value) { return uint2(F32ToF16TowardZero(value.x), F32ToF16TowardZero(value.y)); }
uint3 F32ToF16TowardZero(float3 value) { return uint3(F32ToF16TowardZero(value.x), F32ToF16TowardZero(value.y), F32ToF16TowardZero(value.z)); }
#define f32tof16 F32ToF16TowardZero
#endif

#endif // HLSLCOMPAT_H
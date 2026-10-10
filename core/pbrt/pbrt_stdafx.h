// What DirectX-Graphics-Samples' PBRT parser (PBRTParser.cpp, PlyParser.cpp: copies of the
// D3D12RaytracingRealTimeDenoisedAmbientOcclusion sample's, based on DuosRenderer) takes from the
// sample's stdafx.h: the standard and Windows headers, DirectXMath, the material types of
// RaytracingHlslCompat.h, and DXSampleHelper.h's ThrowIfFalse, ThrowIfTrue and CalculateTangent.
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).

#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <stdlib.h>
#include <sstream>
#include <iomanip>
#include <iostream>
#include <fstream>
#include <string>
#include <memory>
#include <unordered_map>
#include <vector>
#include <algorithm>
#include <assert.h>
#include <functional>
#include <stack>
#include <stdexcept>
#include <stdint.h>
#include <float.h>
#include <sal.h>

#include <DirectXMath.h>

using namespace DirectX;

// RaytracingHlslCompat.h's material types.
namespace MaterialType {
    enum Type {
        Default,
        Matte,      // Lambertian scattering
        Mirror,     // Specular reflector that isn't modified by the Fresnel equations.
        AnalyticalCheckerboardTexture
    };
}

inline void ThrowIfFalse(bool value, const wchar_t* msg = nullptr)
{
    if (!value)
    {
        (void)msg;
        throw std::runtime_error("PBRT parser: unexpected input");
    }
}

inline void ThrowIfTrue(bool value, const wchar_t* msg = nullptr)
{
    ThrowIfFalse(!value, msg);
}

// Calculates a normalized tangent vector for a triangle given vertices' positions p* and their uv* coordinates.
inline XMFLOAT3 CalculateTangent(const XMFLOAT3& p0, const XMFLOAT3& p1, const XMFLOAT3& p2, const XMFLOAT2& uv0, const XMFLOAT2& uv1, const XMFLOAT2& uv2)
{
    // A tangent can be computed by solving the following equations
    // E1 = (P1 - P0) = T * (u1 - u0) + B * (v1 - v0)
    // E2 = (P2 - P0) = T * (u2 - u0) + B * (v2 - v0)
    //   expressed in Matrix form as
    //   (  E1  ) =  (  u10  v10  ) (  T  )
    //   (  E2  ) =  (  u20  v20  ) (  B  )
    //
    //  That is by multiplying with an inverse UV matrix and solving for T
    //
    //   (  T  ) =   1 /     (  v20  -v10  )  (  E1  )
    //   (  B  ) =   det(UV) (  -u20  u10  )  (  E2  )
    //  where det(UV) = u10 * v20 - v10 * u20

    XMFLOAT3 e10 = XMFLOAT3(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
    XMFLOAT3 e20 = XMFLOAT3(p2.x - p0.x, p2.y - p0.y, p2.z - p0.z);

    XMFLOAT2 d_uv10 = XMFLOAT2(uv1.x - uv0.x, uv1.y - uv0.y);
    XMFLOAT2 d_uv20 = XMFLOAT2(uv2.x - uv0.x, uv2.y - uv0.y);

    float invDetUV = 1 / (d_uv10.x * d_uv20.y - d_uv10.y * d_uv20.x);

    XMFLOAT3 tangent;
    tangent.x = invDetUV * (e10.x * d_uv20.y - e20.x * d_uv10.y);
    tangent.y = invDetUV * (e10.y * d_uv20.y - e20.y * d_uv10.y);
    tangent.z = invDetUV * (e10.z * d_uv20.y - e20.z * d_uv10.y);

    return tangent;
}

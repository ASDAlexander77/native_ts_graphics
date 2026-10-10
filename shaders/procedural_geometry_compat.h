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

// The HLSL half of the D3D12RaytracingProceduralGeometry sample's RaytracingHlslCompat.h (its
// C++ half lives in examples/procedural_geometry.ts). Changes: the matrices are row_major (the
// sample compiles with /Zpr; its C++ side writes DirectXMath's row-major XMMATRIX), the
// material's float3 padding is three floats (a float3 would start a new 16-byte row in a
// Vulkan StructuredBuffer), and the shadow payload's bool is a uint (as the other ports').

#ifndef RAYTRACINGHLSLCOMPAT_H
#define RAYTRACINGHLSLCOMPAT_H

typedef uint UINT;

// Number of metaballs to use within an AABB.
#define N_METABALLS 3    // = {3, 5}

// Limitting calculations only to metaballs a ray intersects can speed up raytracing
// dramatically particularly when there is a higher number of metaballs used.
// Use of dynamic loops can have detrimental effects to performance for low iteration counts
// and outweighing any potential gains from avoiding redundant calculations.
// Requires: USE_DYNAMIC_LOOPS set to 1 to take effect.
#if N_METABALLS >= 5
#define USE_DYNAMIC_LOOPS 1
#define LIMIT_TO_ACTIVE_METABALLS 1
#else
#define USE_DYNAMIC_LOOPS 0
#define LIMIT_TO_ACTIVE_METABALLS 0
#endif

#define N_FRACTAL_ITERATIONS 4      // = <1,...>

// PERFORMANCE TIP: Set max recursion depth as low as needed
// as drivers may apply optimization strategies for low recursion depths.
#define MAX_RAY_RECURSION_DEPTH 3    // ~ primary rays + reflections + shadow rays from reflected geometry.


struct ProceduralPrimitiveAttributes
{
    float3 normal;
};

struct RayPayload
{
    float4 color;
    UINT   recursionDepth;
};

struct ShadowRayPayload
{
    UINT hit;
};

struct SceneConstantBuffer
{
    row_major float4x4 projectionToWorld;
    float4   cameraPosition;
    float4   lightPosition;
    float4   lightAmbientColor;
    float4   lightDiffuseColor;
    float    reflectance;
    float    elapsedTime;                 // Elapsed application time.
};

// Attributes per primitive type.
struct PrimitiveConstantBuffer
{
    float4 albedo;
    float reflectanceCoef;
    float diffuseCoef;
    float specularCoef;
    float specularPower;
    float stepScale;                      // Step scale for ray marching of signed distance primitives.
                                          // - Some object transformations don't preserve the distances and
                                          //   thus require shorter steps.
    float padding0;
    float padding1;
    float padding2;
};

// Attributes per primitive instance.
struct PrimitiveInstanceConstantBuffer
{
    UINT instanceIndex;
    UINT primitiveType; // Procedural primitive type
};

// Dynamic attributes per primitive instance.
struct PrimitiveInstancePerFrameBuffer
{
    row_major float4x4 localSpaceToBottomLevelAS;   // Matrix from local primitive space to bottom-level object space.
    row_major float4x4 bottomLevelASToLocalSpace;   // Matrix from bottom-level object space to local primitive space.
};

struct Vertex
{
    float3 position;
    float3 normal;
};


// Ray types traced in this sample.
namespace RayType {
    enum Enum {
        Radiance = 0,   // ~ Primary, reflected camera/view rays calculating color for each hit.
        Shadow,         // ~ Shadow/visibility rays, only testing for occlusion
        Count
    };
}

namespace TraceRayParameters
{
    static const UINT InstanceMask = ~0;   // Everything is visible.
    namespace HitGroup {
        static const UINT Offset[RayType::Count] =
        {
            0, // Radiance ray
            1  // Shadow ray
        };
        static const UINT GeometryStride = RayType::Count;
    }
    namespace MissShader {
        static const UINT Offset[RayType::Count] =
        {
            0, // Radiance ray
            1  // Shadow ray
        };
    }
}

// From: http://blog.selfshadow.com/publications/s2015-shading-course/hoffman/s2015_pbs_physics_math_slides.pdf
static const float4 ChromiumReflectance = float4(0.549f, 0.556f, 0.554f, 1.0f);

static const float4 BackgroundColor = float4(0.8f, 0.9f, 1.0f, 1.0f);
static const float InShadowRadiance = 0.35f;

namespace AnalyticPrimitive {
    enum Enum {
        AABB = 0,
        Spheres,
        Count
    };
}

namespace VolumetricPrimitive {
    enum Enum {
        Metaballs = 0,
        Count
    };
}

namespace SignedDistancePrimitive {
    enum Enum {
        MiniSpheres = 0,
        IntersectedRoundCube,
        SquareTorus,
        TwistedTorus,
        Cog,
        Cylinder,
        FractalPyramid,
        Count
    };
}

#endif // RAYTRACINGHLSLCOMPAT_H

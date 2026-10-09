//--------------------------------------------------------------------------------------
// RaytracingAO: what the shaders share
//
// Advanced Technology Group (ATG)
// Copyright (C) Microsoft Corporation. All rights reserved.
//--------------------------------------------------------------------------------------

// The Xbox ATG RaytracingAO_PC12 sample's GlobalSharedHlslCompat.h, AORaytracingHlslCompat.h,
// SSAOHlslCompat.h and GeneralH.hlsli, for HLSL only.

#ifndef RAYTRACING_AO_HLSLI
#define RAYTRACING_AO_HLSLI

// --- GlobalSharedHlslCompat.h ---------------------------------------------------------------

#define NEAR_PLANE 1.f
#define FAR_PLANE 200.0f
#define ZSCALE (float(FAR_PLANE - NEAR_PLANE) / float(NEAR_PLANE))
#define BACKGROUND float4(0.0f, 0.2f, 0.4f, 1.0f)

// The matrices are stored transposed (as the sample's XMMatrixTranspose), for these column-major
// declarations.
struct SceneConstantBuffer
{
    float4x4 worldView;

    float4x4 worldViewProjection;
    float4x4 projectionToWorld;

    // Eye position.
    float4 cameraPosition;
    float4 frustumPoint;
    float4 frustumHDelta;
    float4 frustumVDelta;

    // Specifies the number of times noise texture is tiled.
    float4 noiseTile;
};

struct MaterialConstantBuffer
{
    float3 ambient;
    int isDiffuseTexture;
    float3 diffuse;
    int isSpecularTexture;
    float3 specular;
    int isNormalTexture;
};

// The vertices (44 bytes: position, normal, texture coordinates, tangent). Port: read from a
// ByteAddressBuffer (the sample's StructuredBuffer<Vertex> has a 64-byte stride in SPIR-V's layout).
#define VERTEX_STRIDE 44
#define VERTEX_NORMAL 12
#define VERTEX_TEXCOORD 24
#define VERTEX_TANGENT 32

// --- AORaytracingHlslCompat.h ---------------------------------------------------------------

#define EPSILON .0001

#define NOISE_W 100
#define MAX_SAMPLES 15
#define MAX_OCCLUSION_RAYS (MAX_SAMPLES * MAX_SAMPLES)

struct AOConstantBuffer
{
    // float4 is needed to prevent CPU from performing a full pack.
    float4 rays[MAX_OCCLUSION_RAYS];
};

struct AOOptionsConstantBuffer
{
    float m_distance;
    float m_falloff;
    uint m_numSamples;
    uint m_sampleType;
};

namespace TraceRayParameters
{
    static const uint InstanceMask = ~0U;   // Everything is visible.
    namespace HitGroup
    {
        enum Offset
        {
            Primary,
            Secondary, // No hit group needed for secondary rays.
            Count
        };

        static const uint GeometryStride = HitGroup::Count;
    }

    namespace MissShader
    {
        enum Offset
        {
            Primary,
            Secondary,
            Count
        };
    }
}

// --- SSAOHlslCompat.h -----------------------------------------------------------------------

#define NUM_BUFFERS 4

struct SSAORenderConstantBuffer
{
    float4 invThicknessTable[3];
    float4 sampleWeightTable[3];
    float2 invSliceDimension;
    float  normalMultiply;
};

struct BlurAndUpscaleConstantBuffer
{
    float2 invLowResolution;
    float2 invHighResolution;
    float noiseFilterStrength;
    float stepSize;
    float blurTolerance;
    float upsampleTolerance;
};

// --- GeneralH.hlsli -------------------------------------------------------------------------

static const float XM_PI = 3.14159265f;

// Pseudo-random hash.
// Code from http://www.reedbeta.com/blog/quick-and-easy-gpu-random-numbers-in-d3d11/.
uint WangHash(uint seed)
{
    seed = (seed ^ 61) ^ (seed >> 16);
    seed *= 9;
    seed = seed ^ (seed >> 4);
    seed *= 0x27d4eb2d;
    seed = seed ^ (seed >> 15);
    return seed;
}

// Xorshift algorithm from George Marsaglia's paper.
uint Random(uint state)
{
    state ^= (state << 13);
    state ^= (state >> 17);
    state ^= (state << 5);
    return state;
}

uint CreateSeed(uint2 dispatchID)
{
    return
        WangHash(
            WangHash(dispatchID.x)
            ^ Random(dispatchID.y)
        );
}

// Random float between [0, 1).
float RandFloat(inout uint seed)
{
    uint rand = seed = Random(seed);
    return rand * 2.3283064365387e-10;
}

#endif // RAYTRACING_AO_HLSLI

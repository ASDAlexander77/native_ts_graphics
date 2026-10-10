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

// Port of the D3D12RaytracingOpacityMicromaps sample's Raytracing.hlsl to Donut's bindings. The
// sample reads everything from the descriptor heap (ResourceDescriptorHeap, shader model 6.6);
// here each resource has its register, the scene constants and ray flags are two constant
// buffers (the sample's per-frame CBV and root constants), and the material textures it indexes by
// GeometryInfo are picked by an if-chain (its texture index is the same: 0 the leaves' alpha, 1-3
// the trunk's, branches' and leaves' colors). Matrices are row_major, as the sample's /Zpr.

static const float3 LIGHT_DIRECTION = normalize(float3(1, -1, 1));

static const uint EMPTY_FLAG = 0;
static const uint RAN_AHS_FLAG = 0x1;
static const uint MISSED_FLAG = 0x2;

// SharedCode.h's ConfigFlags.
static const uint SHOW_AHS = 0x1;

struct GeometryInfo
{
    uint primitiveOffset;
    uint diffuseTextureIndex;
    uint alphaTextureIndex;
};

RaytracingAccelerationStructure Scene : register(t0);
RWTexture2D<float4> RenderTarget : register(u0);

// SceneConstantBuffer.
cbuffer SceneConstants : register(b0)
{
    row_major float4x4 projectionToWorld;
    float4 cameraPosition;
};

// The sample's root constants (its frameIndex picked the scene's CBV).
cbuffer Params : register(b1)
{
    uint configFlags;
    uint extraPrimaryRayFlags;
    uint extraShadowRayFlags;
};

SamplerState bilinearSampler : register(s0);

Texture2D<float> leavesAlphaTexture : register(t1);
Texture2D<float4> trunkDiffuseTexture : register(t2);
Texture2D<float4> branchesDiffuseTexture : register(t3);
Texture2D<float4> leavesDiffuseTexture : register(t4);

ByteAddressBuffer positionBuffer : register(t5);
ByteAddressBuffer normalBuffer : register(t6);
ByteAddressBuffer texCoordBuffer : register(t7);
ByteAddressBuffer positionIndexBuffer : register(t8);
ByteAddressBuffer normalIndexBuffer : register(t9);
ByteAddressBuffer texCoordIndexBuffer : register(t10);
StructuredBuffer<GeometryInfo> geometryInfoBuffer : register(t11);

typedef BuiltInTriangleIntersectionAttributes MyAttributes;
struct RayPayload
{
    float3 colorRGB;
    uint flags;
};

// Generate a ray in world space for a camera pixel corresponding to an index from the dispatched 2D grid.
inline void GenerateCameraRay(uint2 index, out float3 origin, out float3 direction)
{
    float2 xy = index + 0.5f; // center in the middle of the pixel.
    float2 screenPos = xy / DispatchRaysDimensions().xy * 2.0 - 1.0;

    // Invert Y for DirectX-style coordinates.
    screenPos.y = -screenPos.y;

    // Unproject the pixel coordinate into a ray.
    float4 world = mul(float4(screenPos, 0, 1), projectionToWorld);

    world.xyz /= world.w;
    origin = cameraPosition.xyz;
    direction = normalize(world.xyz - origin);
}

[shader("raygeneration")]
void MyRaygenShader()
{
    float3 rayDir;
    float3 origin;

    // Generate a ray for a camera pixel corresponding to an index from the dispatched 2D grid.
    GenerateCameraRay(DispatchRaysIndex().xy, origin, rayDir);

    // Trace the ray.
    RayDesc ray;
    ray.Origin = origin;
    ray.Direction = rayDir;
    ray.TMin = 0.001;
    ray.TMax = 10000.0;

    uint rayFlags = extraPrimaryRayFlags;

    RayPayload payload = { float3(0, 0, 0), EMPTY_FLAG };
    TraceRay(Scene, rayFlags, ~0, 0, 0, 0, ray, payload);

    // Write the raytraced color to the output texture.
    RenderTarget[DispatchRaysIndex().xy] = float4(payload.colorRGB, 1);
}

// Retrieve attribute at a hit position interpolated from vertex attributes using the hit's barycentrics.
template<typename T>
T InterpolateAttribute(T vertexAttribute[3], float2 barycentrics)
{
    return vertexAttribute[0] +
        barycentrics.x * (vertexAttribute[1] - vertexAttribute[0]) +
        barycentrics.y * (vertexAttribute[2] - vertexAttribute[0]);
}

float3 RayPlaneIntersection(float3 planeOrigin, float3 planeNormal, float3 rayOrigin, float3 rayDirection)
{
    float t = dot(-planeNormal, rayOrigin - planeOrigin) / dot(planeNormal, rayDirection);
    return rayOrigin + rayDirection * t;
}

/*
    REF: https://gamedev.stackexchange.com/questions/23743/whats-the-most-efficient-way-to-find-barycentric-coordinates
    From "Real-Time Collision Detection" by Christer Ericson
*/
float3 BarycentricCoordinates(float3 pt, float3 v0, float3 v1, float3 v2)
{
    float3 e0 = v1 - v0;
    float3 e1 = v2 - v0;
    float3 e2 = pt - v0;
    float d00 = dot(e0, e0);
    float d01 = dot(e0, e1);
    float d11 = dot(e1, e1);
    float d20 = dot(e2, e0);
    float d21 = dot(e2, e1);
    float denom = 1.0 / (d00 * d11 - d01 * d01);
    float v = (d11 * d20 - d01 * d21) * denom;
    float w = (d00 * d21 - d01 * d20) * denom;
    float u = 1.0 - v - w;
    return float3(u, v, w);
}

void GetVertexPositions(uint primitiveIndex, uint geometryIndex, out float3 p0, out float3 p1, out float3 p2)
{
    GeometryInfo geomInfo = geometryInfoBuffer[geometryIndex];

    primitiveIndex += geomInfo.primitiveOffset;

    uint3 positionIndices = positionIndexBuffer.Load<uint3>(primitiveIndex * 12);

    p0 = positionBuffer.Load<float3>(positionIndices.x * 12);
    p1 = positionBuffer.Load<float3>(positionIndices.y * 12);
    p2 = positionBuffer.Load<float3>(positionIndices.z * 12);
}

float2 GetTextureCoordinates(float2 barycentrics, uint primitiveIndex, uint geometryIndex)
{
    GeometryInfo geomInfo = geometryInfoBuffer[geometryIndex];

    primitiveIndex += geomInfo.primitiveOffset;

    uint3 texCoordIndices = texCoordIndexBuffer.Load<uint3>(primitiveIndex * 12);

    float2 t0 = texCoordBuffer.Load<float2>(texCoordIndices.x * 8);
    float2 t1 = texCoordBuffer.Load<float2>(texCoordIndices.y * 8);
    float2 t2 = texCoordBuffer.Load<float2>(texCoordIndices.z * 8);

    float2 triTexCoords[3] = { t0, t1, t2 };
    return InterpolateAttribute(triTexCoords, barycentrics);
}

void FetchUVAndCalculateUVDerivatives(float2 barycentrics, uint primitiveIndex, uint geometryIndex, out float2 uv, out float2 ddxUV, out float2 ddyUV)
{
    float2 uvCenter = GetTextureCoordinates(barycentrics, primitiveIndex, geometryIndex);

    float3 p0, p1, p2;
    GetVertexPositions(primitiveIndex, geometryIndex, p0, p1, p2);

    float3 worldPosition = WorldRayOrigin() + WorldRayDirection() * RayTCurrent();

    //---------------------------------------------------------------------------------------------
    // Compute partial derivatives of UV coordinates:
    //
    //  1) Construct a plane from the hit triangle
    //  2) Intersect two helper rays with the plane:  one to the right and one down
    //  3) Compute barycentric coordinates of the two hit points
    //  4) Reconstruct the UV coordinates at the hit points
    //  5) Take the difference in UV coordinates as the partial derivatives X and Y

    // Normal for plane
    float3 triangleNormal = normalize(cross(p2 - p0, p1 - p0));

    // Helper rays
    uint2 threadID = DispatchRaysIndex().xy;
    float3 ddxOrigin, ddxDir, ddyOrigin, ddyDir;
    GenerateCameraRay(uint2(threadID.x + 1, threadID.y), ddxOrigin, ddxDir);
    GenerateCameraRay(uint2(threadID.x, threadID.y + 1), ddyOrigin, ddyDir);

    // Intersect helper rays
    float3 xOffsetPoint = RayPlaneIntersection(worldPosition, triangleNormal, ddxOrigin, ddxDir);
    float3 yOffsetPoint = RayPlaneIntersection(worldPosition, triangleNormal, ddyOrigin, ddyDir);

    // Compute barycentrics
    float3 baryX = BarycentricCoordinates(xOffsetPoint, p0, p1, p2);
    float3 baryY = BarycentricCoordinates(yOffsetPoint, p0, p1, p2);

    float2 uvRight = GetTextureCoordinates(baryX.yz, primitiveIndex, geometryIndex);
    float2 uvDown = GetTextureCoordinates(baryY.yz, primitiveIndex, geometryIndex);

    // Compute derivatives
    uv = uvCenter;
    ddxUV = uvRight.xy - uvCenter.xy;
    ddyUV = uvDown.xy - uvCenter.xy;
}

float3 GetNormal(float2 barycentrics, uint primitiveIndex, uint geometryIndex)
{
    GeometryInfo geomInfo = geometryInfoBuffer[geometryIndex];

    primitiveIndex += geomInfo.primitiveOffset;

    uint3 normalIndices = normalIndexBuffer.Load<uint3>(primitiveIndex * 12);

    float3 triNormals[3];
    triNormals[0] = normalBuffer.Load<float3>(normalIndices.x * 12);
    triNormals[1] = normalBuffer.Load<float3>(normalIndices.y * 12);
    triNormals[2] = normalBuffer.Load<float3>(normalIndices.z * 12);

    return normalize(InterpolateAttribute(triNormals, barycentrics));
}

// ResourceDescriptorHeap[MODEL_TEXTURES_START + geomInfo.diffuseTextureIndex].SampleGrad.
float3 SampleDiffuseTexture(uint textureIndex, float2 uv, float2 ddxUV, float2 ddyUV)
{
    float3 diffuse = float3(0, 0, 0);
    if (textureIndex == 1)
        diffuse = trunkDiffuseTexture.SampleGrad(bilinearSampler, uv, ddxUV, ddyUV).rgb;
    else if (textureIndex == 2)
        diffuse = branchesDiffuseTexture.SampleGrad(bilinearSampler, uv, ddxUV, ddyUV).rgb;
    else if (textureIndex == 3)
        diffuse = leavesDiffuseTexture.SampleGrad(bilinearSampler, uv, ddxUV, ddyUV).rgb;
    return diffuse;
}

[shader("closesthit")]
void MyClosestHitShader(inout RayPayload payload, in MyAttributes attr)
{
    GeometryInfo geomInfo = geometryInfoBuffer[GeometryIndex()];

    float2 uv, ddxUV, ddyUV;
    FetchUVAndCalculateUVDerivatives(attr.barycentrics, PrimitiveIndex(), GeometryIndex(), uv, ddxUV, ddyUV);

    float3 normal = GetNormal(attr.barycentrics, PrimitiveIndex(), GeometryIndex());

    float ndotl = max(0, dot(normal, -LIGHT_DIRECTION));

    float3 diffuse = SampleDiffuseTexture(geomInfo.diffuseTextureIndex, uv, ddxUV, ddyUV);

    if ((configFlags & SHOW_AHS) && (payload.flags & RAN_AHS_FLAG))
    {
        diffuse *= float3(1,0,1);
    }

    // Spawn a shadow ray
    RayDesc shadowRay;
    shadowRay.Origin = WorldRayOrigin() + WorldRayDirection() * RayTCurrent();
    shadowRay.Direction = -LIGHT_DIRECTION;
    shadowRay.TMin = 0.001;
    shadowRay.TMax = 10000.0;

    uint shadowRayFlags = RAY_FLAG_SKIP_CLOSEST_HIT_SHADER | RAY_FLAG_ACCEPT_FIRST_HIT_AND_END_SEARCH | extraShadowRayFlags;

    RayPayload shadowPayload = { float3(0,0,0), EMPTY_FLAG };
    TraceRay(Scene, shadowRayFlags, ~0, 0, 0, 0, shadowRay, shadowPayload);

    float shadowTerm = (shadowPayload.flags & MISSED_FLAG) ? 1 : 0;
    float lightAmount = (ndotl * 0.8f * shadowTerm) + 0.2f;

    payload.colorRGB = lightAmount.xxx * diffuse;
}


[shader("anyhit")]
void MyAnyHitShader(inout RayPayload payload, in MyAttributes attr)
{
    payload.flags |= RAN_AHS_FLAG;

    // Only the leaves geometry has an alpha texture (alphaTextureIndex 0).
    float2 uv = GetTextureCoordinates(attr.barycentrics, PrimitiveIndex(), GeometryIndex());

    float alpha = leavesAlphaTexture.SampleLevel(bilinearSampler, uv, 0).r;

    if (alpha < 0.5f)
        IgnoreHit();
}

[shader("miss")]
void MyMissShader(inout RayPayload payload)
{
    if((payload.flags & RAN_AHS_FLAG) && (configFlags & SHOW_AHS))
    {
        payload.colorRGB = float3(1,0,1);
    }
    else
    {
        float3 background = float3(0.0f, 0.2f, 0.4f);
        payload.colorRGB = background;
    }

    payload.flags |= MISSED_FLAG;
}

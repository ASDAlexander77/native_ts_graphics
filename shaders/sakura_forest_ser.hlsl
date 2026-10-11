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

// DirectX-Graphics-Samples' D3D12RaytracingSakuraForestSER Raytracing.hlsl, for
// examples/sakura_forest_ser.ts: a ray generation shader tracing primary rays through hit objects
// (HitObject::TraceRay, MaybeReorderThread by the hit, by a reflection hint, or by both, then
// HitObject::Invoke), closest hit shaders per material, and a fractal sky (Star Nest) in the miss
// shader. Shader model 6.9; column-major matrices, as the sample compiles it at run time.
//
// Changes: RaytracingHlslCompat.h's (and HlslCompat.h's) definitions inline, Star.hlsli renamed;
// and the state object's subobjects, which the sample creates in C++ (CreateRootSignatures,
// CreateLocalRootSignatureSubobjects, CreateRaytracingPipelineStateObject), defined here as DXIL
// library subobjects with the same contents, for Donut_CreateD3D12LibraryRtPipeline.

#ifndef RAYTRACING_HLSL
#define RAYTRACING_HLSL
#define HLSL

// RaytracingHlslCompat.h.
#define MAX_RECURSION_DEPTH 2

enum SortMode
{
    SORTMODE_OFF = 0,
    SORTMODE_BY_HIT = 1,
    SORTMODE_BY_MATERIAL = 2,
    SORTMODE_BY_BOTH = 3
};

struct SceneConstantBuffer
{
    float4x4 projectionToWorld;
    float4 cameraPosition;
    float4 lightPosition;
    float4 lightAmbientColor;
    float4 lightDiffuseColor;
    uint sortMode;
};

struct Vertex
{
    float3 position;
    float3 normal;
    float3 uv;
};

struct ObjectConstantBuffer
{
    float4 albedo;
    uint materialID;
};

#include "sakura_forest_ser_star.hlsli"

// The sample's C++ subobjects. CreateRootSignatures' global root signature: the output (u0), the
// TLAS (t0), the scene constants (b0), the index and vertex buffers and the textures (t1 to t10),
// and two static linear wrapping samplers (s0, s1).
GlobalRootSignature MyGlobalRootSignature =
{
    "DescriptorTable( UAV( u0 ) ),"
    "SRV( t0 ),"
    "CBV( b0 ),"
    "DescriptorTable( SRV( t1, numDescriptors = 10 ) ),"
    "StaticSampler( s0, filter = FILTER_MIN_MAG_MIP_LINEAR, addressU = TEXTURE_ADDRESS_WRAP, addressV = TEXTURE_ADDRESS_WRAP,"
    " addressW = TEXTURE_ADDRESS_WRAP, mipLODBias = 0, maxAnisotropy = 0, comparisonFunc = COMPARISON_NEVER,"
    " borderColor = STATIC_BORDER_COLOR_TRANSPARENT_BLACK, minLOD = 0, maxLOD = 3.402823466e+38, visibility = SHADER_VISIBILITY_ALL ),"
    "StaticSampler( s1, filter = FILTER_MIN_MAG_MIP_LINEAR, addressU = TEXTURE_ADDRESS_WRAP, addressV = TEXTURE_ADDRESS_WRAP,"
    " addressW = TEXTURE_ADDRESS_WRAP, mipLODBias = 0, maxAnisotropy = 0, comparisonFunc = COMPARISON_NEVER,"
    " borderColor = STATIC_BORDER_COLOR_TRANSPARENT_BLACK, minLOD = 0, maxLOD = 3.402823466e+38, visibility = SHADER_VISIBILITY_ALL )"
};

// The local root signature: an ObjectConstantBuffer (albedo, materialID) as root constants, for the
// hit groups and the ray generation shader (CreateLocalRootSignatureSubobjects' association).
LocalRootSignature MyLocalRootSignature =
{
    "RootConstants( num32BitConstants = 5, b1 )"
};

SubobjectToExportsAssociation MyLocalRootSignatureAssociation =
{
    "MyLocalRootSignature",
    "MyHitGroup;TrunkHitGroup;LeavesHitGroup;BushHitGroup;TCubeHitGroup;MyRaygenShader"
};

// The hit groups: a closest hit shader each.
TriangleHitGroup MyHitGroup = { "", "FloorClosestHitShader" };
TriangleHitGroup TrunkHitGroup = { "", "TrunkClosestHitShader" };
TriangleHitGroup LeavesHitGroup = { "", "LeavesClosestHitShader" };
TriangleHitGroup BushHitGroup = { "", "BushClosestHitShader" };
TriangleHitGroup TCubeHitGroup = { "", "TCubeClosestHitShader" };

// The payload (float4 color, uint recursionDepth, uint reflectHint) and the barycentrics.
RaytracingShaderConfig MyShaderConfig =
{
    24,
    8
};

RaytracingPipelineConfig MyPipelineConfig =
{
    MAX_RECURSION_DEPTH
};

using namespace dx;
RaytracingAccelerationStructure Scene : register(t0, space0);
RWTexture2D<float4> RenderTarget : register(u0);
    
ByteAddressBuffer IndicesCube : register(t1, space0);
StructuredBuffer<Vertex> VerticesCube : register(t2, space0);
    
ByteAddressBuffer IndicesTrunk : register(t3, space0);
StructuredBuffer<Vertex> VerticesTrunk : register(t4, space0);
    
ByteAddressBuffer IndicesLeaves : register(t5, space0);
StructuredBuffer<Vertex> VerticesLeaves : register(t6, space0);
    
ByteAddressBuffer IndicesBush : register(t7, space0);
StructuredBuffer<Vertex> VerticesBush : register(t8, space0);

ConstantBuffer<SceneConstantBuffer> g_sceneCB : register(b0);
ConstantBuffer<ObjectConstantBuffer> g_cubeCB : register(b1);
    
Texture2D<float4> TrunkTexture : register(t9, space0);
SamplerState TrunkSampler : register(s0);
    
Texture2D<float4> BushTexture : register(t10, space0);
SamplerState BushSampler : register(s1);

typedef BuiltInTriangleIntersectionAttributes MyAttributes;
  
    
// Struct defines the payload used during ray tracing 
struct [raypayload] RayPayload
{
    float4 color : write(caller, closesthit, miss) : read(caller);
    uint recursionDepth : write(caller) : read(closesthit);
    uint reflectHint : write(caller) : read(closesthit, caller);
};
    

// Retrieve hit world position.
float3 HitWorldPosition()
{
    return WorldRayOrigin() + RayTCurrent() * WorldRayDirection();
}

    
// Retrieve attribute at a hit position interpolated from vertex attributes using the hit's barycentrics.
float3 HitAttribute(float3 vertexAttribute[3], BuiltInTriangleIntersectionAttributes attr)
{
    return vertexAttribute[0] +
    attr.barycentrics.x * (vertexAttribute[1] - vertexAttribute[0]) +
    attr.barycentrics.y * (vertexAttribute[2] - vertexAttribute[0]);
}

    
// Retrieve attribute at a hit position interpolated from vertex attributes using the hit's barycentrics (float2 version).
float2 HitAttribute(float2 vertexAttribute[3], BuiltInTriangleIntersectionAttributes attr)
{
    return vertexAttribute[0] +
    attr.barycentrics.x * (vertexAttribute[1] - vertexAttribute[0]) +
    attr.barycentrics.y * (vertexAttribute[2] - vertexAttribute[0]);
}

    
// Generate a ray in world space for a camera pixel corresponding to an index from the dispatched 2D grid.
inline void GenerateCameraRay(uint2 index, out float3 origin, out float3 direction)
{
    float2 xy = index + 0.5f; // center in the middle of the pixel.
    float2 screenPos = xy / DispatchRaysDimensions().xy * 2.0 - 1.0;

    // Invert Y for DirectX-style coordinates.
    screenPos.y = -screenPos.y;

    // Unproject the pixel coordinate into a ray.
    float4 world = mul(g_sceneCB.projectionToWorld, float4(screenPos, 0, 1));

    world.xyz /= world.w;
    origin = g_sceneCB.cameraPosition.xyz;
    direction = normalize(world.xyz - origin);
}
    
    
// Configure reflection hints based on material properties
void ConfigureReflectionHints(in HitObject hit, in float3 origin, in float3 rayDir, inout RayPayload payload)
{
    // Only process hints for material-based sorting modes
    if (g_sceneCB.sortMode != SORTMODE_BY_MATERIAL && g_sceneCB.sortMode != SORTMODE_BY_BOTH)
        return;
    
    uint materialID = hit.LoadLocalRootTableConstant(16);
    
    // Check for reflective floor material
    if (materialID == 0) // Floor
    {
        // Calculate floor intersection point
        float t = -origin.y / rayDir.y;
        float3 estimatedHit = origin + t * rayDir;
        float2 uv = frac(estimatedHit.xz);
        
        // Sample texture to determine if area is reflective (dark areas)
        float4 texColor = TrunkTexture.SampleLevel(TrunkSampler, uv, 0);
        if (all(texColor.rgb < 0.1))
        {
            payload.reflectHint = 1;
        }
    }
    // Check for reflective cube
    else if (materialID == 1) // Reflective cube
    {
        payload.reflectHint = 1;
    }
}
    

// Apply thread reordering based on sort mode
void ApplyThreadReordering(in HitObject hit, in RayPayload payload)
{
    const uint numHintBits = 1;
    switch (g_sceneCB.sortMode)
    {
        case SORTMODE_BY_HIT:
            dx::MaybeReorderThread(hit);
            break;
            
        case SORTMODE_BY_MATERIAL:
            dx::MaybeReorderThread(payload.reflectHint, numHintBits);
            break;
            
        case SORTMODE_BY_BOTH:
            dx::MaybeReorderThread(hit, payload.reflectHint, numHintBits);
            break;
    }
}
    

[shader("raygeneration")]
void MyRaygenShader()
{
    // Generate primary ray from camera
    float3 rayDir;
    float3 origin;
    GenerateCameraRay(DispatchRaysIndex().xy, origin, rayDir);

    // Initialize ray descriptor
    RayDesc ray;
    ray.Origin = origin;
    ray.Direction = rayDir;
    ray.TMin = 0.001;
    ray.TMax = 10000.0;

    // Initialize payload
    RayPayload payload = { float4(0, 0, 0, 0), 1, 0 };

    if (g_sceneCB.sortMode == SORTMODE_OFF)
    {
        // SER is off
        TraceRay(Scene, 0, ~0, 0, 1, 0, ray, payload);
    }
    else
    {
        // SER is on
        HitObject hit = HitObject::TraceRay(Scene, 0, ~0, 0, 1, 0, ray, payload);
        
        // Configure reflection hints for material-based sorting
        ConfigureReflectionHints(hit, origin, rayDir, payload);
        
        // Apply thread reordering based on sort mode
        ApplyThreadReordering(hit, payload);
        
        // Execute the hit shader
        HitObject::Invoke(hit, payload);
    }
    RenderTarget[DispatchRaysIndex().xy] = payload.color;
}

    
// Fresnel reflectance - schlick approximation.
float3 FresnelReflectanceSchlick(in float3 I, in float3 N, in float3 f0)
{
    float cosi = saturate(dot(-I, N));
    return f0 + (1 - f0) * pow(1 - cosi, 5);
}
    
    
struct Ray
{
    float3 Origin;
    float3 Direction;
};
    
    
// Trace a radiance ray into the scene and returns a shaded color. 
float4 TraceRadianceRay(in Ray ray, in int currentRayRecursionDepth)
{
    // Stop tracing if maximum depth is reached.
    if (currentRayRecursionDepth >= MAX_RECURSION_DEPTH)
    {
        return float4(0, 0, 0, 0);
    }

    // Set the ray's extents.
    RayDesc rayDesc;
    rayDesc.Origin = ray.Origin;
    rayDesc.Direction = ray.Direction;
    // Set TMin to a non-zero small value to avoid aliasing issues due to floating - point errors.
    rayDesc.TMin = 0.001;
    rayDesc.TMax = 10000;
    RayPayload rayPayload = { float4(0, 0, 0, 0), currentRayRecursionDepth + 1, 0 };
    TraceRay(Scene, 0, ~0, 0, 1, 0, rayDesc, rayPayload);

    return rayPayload.color;
}

    
[shader("closesthit")]
void FloorClosestHitShader(inout RayPayload payload, in MyAttributes attr)
{
    float3 hitPosition = HitWorldPosition();
    uint baseIndex = PrimitiveIndex() * 3;
    uint offset = baseIndex * 4;
    uint3 indices = IndicesCube.Load3(offset);

    float3 albedo = g_cubeCB.albedo.rgb;
    float4 sampled = float4(1.0, 1.0, 1.0, 1.0);
    float3 triangleNormal;

    // Procedural UVs
    float2 baseUV = frac(hitPosition.xz * 1.0);
    sampled.rgb = TrunkTexture.SampleLevel(TrunkSampler, baseUV, 0).rgb;
    
    float3 vertexNormals[3] =
    {
        VerticesCube[indices.x].normal,
        VerticesCube[indices.y].normal,
        VerticesCube[indices.z].normal
    };
        
    triangleNormal = HitAttribute(vertexNormals, attr);
    float3 baseColor = albedo * sampled.rgb;
    float3 finalColor;

    // Trace reflection ray if surface is dark
    if (all(sampled.rgb < 0.1) && payload.recursionDepth < MAX_RECURSION_DEPTH)
    {
        Ray reflectionRay;
        reflectionRay.Origin = hitPosition + triangleNormal * 0.001f;
        reflectionRay.Direction = reflect(WorldRayDirection(), triangleNormal);

        float4 reflectionColor = TraceRadianceRay(reflectionRay, payload.recursionDepth);
        float3 fresnel = FresnelReflectanceSchlick(WorldRayDirection(), triangleNormal, baseColor);
        float3 refColor = lerp(baseColor, reflectionColor.rgb, fresnel) * 1.7f;
        finalColor = refColor;
    }
    else
    {
        finalColor = baseColor * 1.0f;
    }
    payload.color = float4(finalColor, g_cubeCB.albedo.w);
}
    
    
[shader("closesthit")]
void TrunkClosestHitShader(inout RayPayload payload, in MyAttributes attr)
{
    float3 hitPosition = HitWorldPosition();
    uint baseIndex = PrimitiveIndex() * 3;
    uint offset = baseIndex * 4;
    uint3 indices = IndicesLeaves.Load3(offset);

    // Albedo is defined per shape or material
    float3 albedo = g_cubeCB.albedo.rgb;
    float4 sampled = float4(1.0, 1.0, 1.0, 1.0);
    float3 triangleNormal;
        
    // Retrieve corresponding vertex normals for the triangle vertices.
    float3 vertexNormals[3];
    vertexNormals[0] = VerticesTrunk[indices.x].normal;
    vertexNormals[1] = VerticesTrunk[indices.y].normal;
    vertexNormals[2] = VerticesTrunk[indices.z].normal;
    triangleNormal = HitAttribute(vertexNormals, attr);
            
    // Sample texture from 3 planes (triplanar mapping)
    float2 uvX = hitPosition.yz * 0.5;
    float2 uvY = hitPosition.xz * 0.5;
    float2 uvZ = hitPosition.xy * 0.5;
    
    float3 texX = TrunkTexture.SampleLevel(TrunkSampler, uvX, 0).rgb;
    float3 texY = TrunkTexture.SampleLevel(TrunkSampler, uvY, 0).rgb;
    float3 texZ = TrunkTexture.SampleLevel(TrunkSampler, uvZ, 0).rgb;
    
    // Blend based on normal
    float3 blendWeights = abs(triangleNormal);
    blendWeights = normalize(max(blendWeights, 0.00001));
    sampled.rgb = texX * blendWeights.x + texY * blendWeights.y + texZ * blendWeights.z;

    float3 finalColor = albedo * sampled.rgb * 0.5f;
    payload.color = float4(finalColor, g_cubeCB.albedo.w);
}
    
    
[shader("closesthit")]
void LeavesClosestHitShader(inout RayPayload payload, in MyAttributes attr)
{
    float3 hitPosition = HitWorldPosition();
    uint baseIndex = PrimitiveIndex() * 3;
    uint offset = baseIndex * 4;
    uint3 indices = IndicesLeaves.Load3(offset);

    float3 albedo = g_cubeCB.albedo.rgb;
    float3 pastelPurple = float3(0.8, 0.7, 0.9); 
    float3 pastelPink = float3(1.0, 0.8, 0.9);
    float3 darkPink = float3(0.85, 0.4, 0.6); 

    // Simple hash to pick one of the three colors for sakura petals.
    uint hash = PrimitiveIndex() % 3;
    float3 sampled = (hash == 0) ? pastelPurple : (hash == 1) ? pastelPink :darkPink;
    float3 triangleNormal;
    float3 vertexNormals[3];
        
    vertexNormals[0] = VerticesLeaves[indices.x].normal;
    vertexNormals[1] = VerticesLeaves[indices.y].normal;
    vertexNormals[2] = VerticesLeaves[indices.z].normal;
   
    triangleNormal = HitAttribute(vertexNormals, attr);

    float3 finalColor;
    float3 lightDir = normalize(g_sceneCB.lightPosition.xyz - hitPosition);
    float NdotL = saturate(dot(triangleNormal, lightDir));

    finalColor = albedo * sampled.rgb * g_sceneCB.lightDiffuseColor.rgb * NdotL;
    payload.color = float4(finalColor, g_cubeCB.albedo.w);
}

    
[shader("closesthit")]
void BushClosestHitShader(inout RayPayload payload, in MyAttributes attr)
    {
    float3 hitPosition = HitWorldPosition();
    uint baseIndex = PrimitiveIndex() * 3;
    uint offset = baseIndex * 4;
    uint3 indices = IndicesBush.Load3(offset);

    // Albedo is defined per shape or material
    float3 albedo = g_cubeCB.albedo.rgb;
    float4 sampled = float4(1.0, 1.0, 1.0, 1.0);
    float3 triangleNormal;

    // Retrieve corresponding vertex normals for the triangle vertices.
    float3 vertexNormals[3];
        
    vertexNormals[0] = VerticesBush[indices.x].normal;
    vertexNormals[1] = VerticesBush[indices.y].normal;
    vertexNormals[2] = VerticesBush[indices.z].normal;
        
    triangleNormal = HitAttribute(vertexNormals, attr);

    float3 vertexTexCoords[3];
        
    vertexTexCoords[0] = VerticesBush[indices.x].uv;
    vertexTexCoords[1] = VerticesBush[indices.y].uv;
    vertexTexCoords[2] = VerticesBush[indices.z].uv;
        
    float2 interpolatedTexCoord = HitAttribute(vertexTexCoords, attr).xy;

    // Sample the texture with the modified coordinates
    sampled.rgb = BushTexture.SampleLevel(BushSampler, interpolatedTexCoord, 0).rgb;
        
    float3 baseColor = albedo * sampled.rgb;
    float3 lightDir = normalize(g_sceneCB.lightPosition.xyz - hitPosition);
    float NdotL = saturate(dot(triangleNormal, lightDir));
    float3 finalColor = baseColor * g_sceneCB.lightDiffuseColor.rgb * NdotL;
    payload.color = float4(finalColor, g_cubeCB.albedo.w);
}


[shader("closesthit")]
void TCubeClosestHitShader(inout RayPayload payload, in MyAttributes attr)
{
    float3 hitPosition = HitWorldPosition();
    uint baseIndex = PrimitiveIndex() * 3;
    uint offset = baseIndex * 4;
    uint3 indices = IndicesCube.Load3(offset);

    // Albedo is defined per shape or material
    float3 albedo = g_cubeCB.albedo.rgb;
    float4 sampled = float4(1.0, 1.0, 1.0, 1.0);
    float3 triangleNormal;

    // Retrieve corresponding vertex normals for the triangle vertices.
    float3 vertexNormals[3];
        
    vertexNormals[0] = VerticesTrunk[indices.x].normal;
    vertexNormals[1] = VerticesTrunk[indices.y].normal;
    vertexNormals[2] = VerticesTrunk[indices.z].normal;
        
    triangleNormal = HitAttribute(vertexNormals, attr);
        
    // Trace a reflection ray
    Ray reflectionRay = { hitPosition + triangleNormal * 0.5f, reflect(WorldRayDirection(), triangleNormal) };
    float4 reflectionColor = TraceRadianceRay(reflectionRay, payload.recursionDepth);
    float3 fresnelR = FresnelReflectanceSchlick(WorldRayDirection(), triangleNormal, g_cubeCB.albedo.xyz);
    float4 reflectedColor = 0.5 * float4(fresnelR, 1) * reflectionColor;
    payload.color = reflectedColor;
}
        

[shader("miss")]
void MyMissShader(inout RayPayload payload)
{
    float4 background = float4(0.05f, 0.02f, 0.08f, 1.0f);
    
    // Create sky position and ray direction
    float3 rayOrigin = WorldRayOrigin();
    float3 rayDir = normalize(WorldRayDirection());
    float3 skyPosition = rayDir * 10.0f;
    float fractalDensity = CalculateStarNest(skyPosition, rayDir);

    // Create soft purple light glow
    float3 blue = float3(0.4, 0.6, 1.0); // Soft blue
    float3 pink = float3(1.0, 0.6, 0.8); // Soft pink
    float3 glow = lerp(blue, pink, fractalDensity);

    float3 L = normalize(g_sceneCB.lightPosition.xyz - skyPosition);
    float lightD = saturate(dot(rayDir, L)); 
    glow *= lerp(0.8 + 0.2 * lightD, 4.0, fractalDensity);
    
    float3 finalColor = lerp(background.rgb, glow, fractalDensity * 1.3);
    payload.color = float4(finalColor, 1.0f);
}

#endif // RAYTRACING_HLSL
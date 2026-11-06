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

// DirectX-Graphics-Samples' D3D12RaytracingHelloShaderExecutionReordering Raytracing.hlsl, for
// examples/raytracing_hello_ser.ts. Changes: RaytracingHlslCompat.h's structures inline; the ray
// generation constants (the sample's local root constants) are a constant buffer; on Vulkan the hit
// object and reorder calls are SPV_NV_shader_invocation_reorder's instructions as inline SPIR-V
// (DXC's SPIR-V backend doesn't implement dx::HitObject; see ray_tracing_invocation_reorder.hlsl).
// The sample compiles this file at launch so its #defines can be tweaked between runs; here they are
// set when the shaders are built: raytracing_hello_ser.cfg builds the sample's defaults (REORDER=1)
// and the same without REQUEST_REORDER (REORDER=0, which -noreorder selects).

// RaytracingHlslCompat.h's structures, in HLSL.
struct Viewport
{
    float left;
    float top;
    float right;
    float bottom;
};

struct RayGenConstantBuffer
{
    Viewport viewport;
    Viewport stencil;
};

//--------------------------------------------------------------------------------------------------
// Shader Execution Reordering demo options. Experiment by tweaking these.
//--------------------------------------------------------------------------------------------------

// Comment out to compare against SER disabled (but still using HitObject).
#ifndef REORDER
#define REORDER 1
#endif
#if REORDER
#define REQUEST_REORDER
#endif

// Uncomment to use the original TraceRay (no HitObject, no SER).
//#define USE_ORIGINAL_TRACERAY_NO_SER

// Uncomment to do the shading in the raygen shader rather than invoking closesthit / miss
// (HitObject::Invoke).
//#define SKIP_INVOKE_INSTEAD_SHADE_IN_RAYGEN

// Comment out to give every ray the same amount of work.
#define USE_VARYING_ARTIFICIAL_WORK

// Number of loop iterations rays with heavy / light artificial work do.
#define WORK_LOOP_ITERATIONS_HEAVY 5000
#define WORK_LOOP_ITERATIONS_LIGHT 1000

// 1 / fraction of rays that do heavy work.
#define RAYS_WITH_HEAVY_WORK_FRACTION 4

// Uncomment to put all the heavy work on the left side of the screen (spatially coherent, so
// reordering has less to gain) instead of in vertical bands.
//#define SPATIALLY_SORTED

RaytracingAccelerationStructure Scene : register(t0, space0);
RWTexture2D<float4> RenderTarget : register(u0);
ConstantBuffer<RayGenConstantBuffer> g_rayGenCB : register(b0);

typedef BuiltInTriangleIntersectionAttributes MyAttributes;

struct [raypayload] RayPayload
{
    float4 color : write(caller, closesthit, miss) : read(caller);
    uint iterations : write(caller) : read(closesthit);
};

// --- Hit objects on Vulkan: SPV_NV_shader_invocation_reorder as inline SPIR-V --------------------

#if defined(SPIRV) && !defined(USE_ORIGINAL_TRACERAY_NO_SER)
using HitObjectNV = vk::SpirvOpaqueType</* OpTypeHitObjectNV */ 5281>;

#define SPV_STORAGE_CLASS_RAY_PAYLOAD 5338

[[vk::ext_extension("SPV_NV_shader_invocation_reorder")]]
[[vk::ext_capability(/* ShaderInvocationReorderNV */ 5383)]]
[[vk::ext_instruction(/* OpHitObjectTraceRayNV */ 5260)]]
void HitObjectTraceRayNV([[vk::ext_reference]] HitObjectNV hitObject, RaytracingAccelerationStructure as, uint rayFlags,
    uint cullMask, uint sbtRecordOffset, uint sbtRecordStride, uint missIndex, float3 origin, float tmin, float3 direction,
    float tmax, [[vk::ext_reference]] [[vk::ext_storage_class(SPV_STORAGE_CLASS_RAY_PAYLOAD)]] RayPayload payload);

// dx::MaybeReorderThread(coherenceHint, numCoherenceHintBitsFromLSB): no hit object.
[[vk::ext_instruction(/* OpReorderThreadWithHintNV */ 5280)]]
void ReorderThreadWithHintNV(uint hint, uint bits);

[[vk::ext_instruction(/* OpHitObjectExecuteShaderNV */ 5264)]]
void HitObjectExecuteShaderNV([[vk::ext_reference]] HitObjectNV hitObject,
    [[vk::ext_reference]] [[vk::ext_storage_class(SPV_STORAGE_CLASS_RAY_PAYLOAD)]] RayPayload payload);

[[vk::ext_instruction(/* OpHitObjectIsHitNV */ 5277)]]
bool HitObjectIsHitNV([[vk::ext_reference]] HitObjectNV hitObject);

[[vk::ext_instruction(/* OpHitObjectGetAttributesNV */ 5267)]]
void HitObjectGetAttributesNV([[vk::ext_reference]] HitObjectNV hitObject,
    [[vk::ext_reference]] [[vk::ext_storage_class(/* HitObjectAttributeNV */ 5385)]] MyAttributes attributes);

// The hit object instructions take the payload variable itself (Ray Payload storage class).
[[vk::ext_storage_class(SPV_STORAGE_CLASS_RAY_PAYLOAD)]] static RayPayload g_HitObjectPayload;
#endif

float4 ClosestHitWorker(MyAttributes attr, uint iterations)
{
    float3 barycentrics = float3(
        1 - attr.barycentrics.x - attr.barycentrics.y,
        attr.barycentrics.x,
        attr.barycentrics.y);

    #ifdef USE_VARYING_ARTIFICIAL_WORK
        for(uint i = 0; i < iterations; i++)
        {
            if(i%2) barycentrics += 1.175494e-38; // FLT_MIN
            else barycentrics -= 1.175494e-38; // FLT_MIN
        }
        if(iterations != WORK_LOOP_ITERATIONS_LIGHT) barycentrics += 1; // make artificial work pixels white
    #endif

    return float4(barycentrics, 1);
}

float4 MissWorker()
{
    return float4(0, 0, 0, 1);
}

RayDesc SetupRay(uint3 index, uint3 dimensions)
{
    float2 lerpValues = (float2)index / (float2)dimensions;

    // Orthographic projection since we're raytracing in screen space.
    float3 rayDir = float3(0, 0, 1);
    float3 origin = float3(
        lerp(g_rayGenCB.viewport.left, g_rayGenCB.viewport.right, lerpValues.x),
        lerp(g_rayGenCB.viewport.top, g_rayGenCB.viewport.bottom, lerpValues.y),
        0.0f);

    // Set the ray's extents.
    RayDesc ray;
    ray.Origin = origin;
    ray.Direction = rayDir;
    // Set TMin to a non-zero small value to avoid aliasing issues due to floating - point errors.
    // TMin should be kept small to prevent missing geometry at close contact areas.
    ray.TMin = 0.001;
    ray.TMax = 10000.0;
    return ray;
}

[shader("raygeneration")]
void MyRaygenShader()
{
    RayDesc ray =
        SetupRay(DispatchRaysIndex(), DispatchRaysDimensions());

    uint iterations = WORK_LOOP_ITERATIONS_LIGHT;

    #ifdef USE_VARYING_ARTIFICIAL_WORK

        #ifdef SPATIALLY_SORTED
            // Extra work is all on left side of screen
            if((ray.Origin.x + 1)/2.f <= 1.f/RAYS_WITH_HEAVY_WORK_FRACTION)
            {
                iterations = WORK_LOOP_ITERATIONS_HEAVY;
            }
        #else
            // Extra work distributed in vertical bands
            if( (DispatchRaysIndex().x) % RAYS_WITH_HEAVY_WORK_FRACTION == 0 )
            {
                iterations = WORK_LOOP_ITERATIONS_HEAVY;
            }
        #endif

    #endif

    RayPayload payload = { float4(0, 0, 0, 0), iterations };
    float4 color = float4(1,1,1,1);

    #ifdef USE_ORIGINAL_TRACERAY_NO_SER
        TraceRay(Scene, RAY_FLAG_NONE, ~0, 0, 1, 0, ray, payload);
        color = payload.color;
    #elif defined(SPIRV)
        // Trace without closest hit or miss
        g_HitObjectPayload = payload;
        HitObjectNV hit;
        HitObjectTraceRayNV(hit, Scene, RAY_FLAG_NONE, 0xff, 0, 1, 0, ray.Origin, ray.TMin, ray.Direction, ray.TMax,
            g_HitObjectPayload);

        #ifdef REQUEST_REORDER
            int sortKey = iterations != WORK_LOOP_ITERATIONS_LIGHT ? 1:0;
            ReorderThreadWithHintNV(sortKey, 1);
        #endif

        #ifdef SKIP_INVOKE_INSTEAD_SHADE_IN_RAYGEN
            if(HitObjectIsHitNV(hit))
            {
                [[vk::ext_storage_class(/* HitObjectAttributeNV */ 5385)]] static MyAttributes attr;
                HitObjectGetAttributesNV(hit, attr);
                color = ClosestHitWorker(attr,iterations);
            }
            else
            {
                color = MissWorker();
            }
        #else
            // Run closest hit / miss
            HitObjectExecuteShaderNV(hit, g_HitObjectPayload);
            color = g_HitObjectPayload.color;
        #endif
    #else

        // Trace without closest hit or miss
        dx::HitObject hit =
            dx::HitObject::TraceRay(Scene, RAY_FLAG_NONE, ~0, 0, 1, 0,
                                ray, payload);

        #ifdef REQUEST_REORDER
            int sortKey = iterations != WORK_LOOP_ITERATIONS_LIGHT ? 1:0;
            dx::MaybeReorderThread(sortKey, 1);
        #endif

        #ifdef SKIP_INVOKE_INSTEAD_SHADE_IN_RAYGEN
            if(hit.IsHit())
            {
                MyAttributes attr = hit.GetAttributes<MyAttributes>();
                color = ClosestHitWorker(attr,iterations);
            }
            else
            {
                color = MissWorker();
            }

        #else
            // Run closest hit / miss
            dx::HitObject::Invoke(hit, payload);
            color = payload.color;
        #endif

    #endif

    // Write the raytraced color to the output texture.
    RenderTarget[DispatchRaysIndex().xy] = color;
}

[shader("closesthit")]
void MyClosestHitShader(inout RayPayload payload, in MyAttributes attr)
{
    payload.color = ClosestHitWorker(attr,payload.iterations);
}

[shader("miss")]
void MyMissShader(inout RayPayload payload)
{
    payload.color = MissWorker();
}

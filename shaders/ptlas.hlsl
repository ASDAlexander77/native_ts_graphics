// The ptlas example's ray tracing: each pixel traces the partitioned TLAS and the reference TLAS
// built from the same instances (ptlas_animate.hlsl), shows the PTLAS's hit - or the reference's, with
// -reference - and paints the pixel magenta where the two disagree (the hit instance, primitive or
// distance). A PTLAS needs nothing new in shaders: it's traced as any RaytracingAccelerationStructure.

#include <donut/shaders/binding_helpers.hlsli>
#include "ptlas_scene.hlsli"

RaytracingAccelerationStructure gPtlas : register(t0);
RaytracingAccelerationStructure gReferenceTlas : register(t1);
// Written as the back buffer's format (BGRA8 on Donut's Vulkan swap chain).
VK_IMAGE_FORMAT_UNKNOWN RWTexture2D<float4> gOutput : register(u0);

cbuffer FrameConstants : register(b0)
{
    // x: the frame index; y: show the reference TLAS.
    float4 gFrame;
};

struct RayPayload
{
    float3 color;
    float hitT;
    // The hit instance and primitive, ~0 for a miss.
    uint instance;
    uint primitive;
};

static const float3 CameraPosition = float3(0, 16, -22);
static const float3 CameraTarget = float3(0, 0, -1);

float3 linearToSrgb(float3 c)
{
    // Based on http://chilliant.blogspot.com/2012/08/srgb-approximations-for-hlsl.html
    float3 sq1 = sqrt(c);
    float3 sq2 = sqrt(sq1);
    float3 sq3 = sqrt(sq2);
    return 0.662002687 * sq1 + 0.684122060 * sq2 - 0.323583601 * sq3 - 0.0225411470 * c;
}

RayPayload Trace(RaytracingAccelerationStructure scene, RayDesc ray)
{
    RayPayload payload;
    payload.color = 0;
    payload.hitT = 0;
    payload.instance = ~0u;
    payload.primitive = ~0u;
    TraceRay(scene, RAY_FLAG_FORCE_OPAQUE, 0xFF, 0, 1, 0, ray, payload);
    return payload;
}

[shader("raygeneration")]
void rayGen()
{
    uint2 launchIndex = DispatchRaysIndex().xy;
    float2 dims = float2(DispatchRaysDimensions().xy);
    float2 d = (float2(launchIndex) + 0.5) / dims * 2.0 - 1.0;

    float3 forward = normalize(CameraTarget - CameraPosition);
    float3 right = normalize(cross(float3(0, 1, 0), forward));
    float3 up = cross(forward, right);
    const float tanHalfFov = 0.6;

    RayDesc ray;
    ray.Origin = CameraPosition;
    ray.Direction = normalize(forward + right * (d.x * tanHalfFov * dims.x / dims.y) - up * (d.y * tanHalfFov));
    ray.TMin = 0;
    ray.TMax = 1000;

    RayPayload partitioned = Trace(gPtlas, ray);
    RayPayload reference = Trace(gReferenceTlas, ray);

    float3 color = gFrame.y != 0 ? reference.color : partitioned.color;
    bool agree = partitioned.instance == reference.instance && partitioned.primitive == reference.primitive
        && abs(partitioned.hitT - reference.hitT) <= 1e-4 * max(1.0, reference.hitT);
    gOutput[launchIndex] = agree ? float4(linearToSrgb(color), 1) : float4(1, 0, 1, 1);
}

[shader("miss")]
void miss(inout RayPayload payload)
{
    payload.color = float3(0.25, 0.35, 0.5);
}

// A color per instance slot.
float3 InstanceColor(uint instance)
{
    uint h = instance * 0x9E3779B9u;
    h ^= h >> 15;
    h *= 0x85EBCA6Bu;
    h ^= h >> 13;
    return float3(h & 0xFF, (h >> 8) & 0xFF, (h >> 16) & 0xFF) / 255.0 * 0.7 + 0.25;
}

[shader("closesthit")]
void closestHit(inout RayPayload payload, in BuiltInTriangleIntersectionAttributes attribs)
{
    payload.hitT = RayTCurrent();
    payload.instance = InstanceIndex();
    payload.primitive = PrimitiveIndex();

    if (InstanceID() == GroundInstance)
    {
        float3 position = WorldRayOrigin() + RayTCurrent() * WorldRayDirection();
        int2 cell = int2(floor(position.xz / CubeSpacing));
        payload.color = ((cell.x + cell.y) & 1) != 0 ? float3(0.55, 0.55, 0.5) : float3(0.4, 0.4, 0.38);
        return;
    }
    // A shade per face: the cube's two triangles of a face, the octahedron's single ones.
    float shade = 0.55 + 0.45 * frac(float(PrimitiveIndex() / 2) * 0.37 + 0.2);
    payload.color = InstanceColor(InstanceID()) * shade;
}

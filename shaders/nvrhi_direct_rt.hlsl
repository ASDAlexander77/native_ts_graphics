// examples/nvrhi_direct.ts's ray tracing test, a library of a ray generation, a miss, a closest hit
// and a callable shader: a ray from each pixel of a 4 x 4 texture (its center, from -1 to 1 in x
// and y) along +z, against a triangle covering the left half (x < 0). A hit is red, a miss blue; the
// callable shader, called for every pixel, adds half green.

#ifdef SPIRV
#define VK_IMAGE_FORMAT(format) [[vk::image_format(format)]]
#else
#define VK_IMAGE_FORMAT(format)
#endif

struct Payload
{
    float3 color;
};

struct CallData
{
    float green;
};

RaytracingAccelerationStructure t_Scene : register(t0);
VK_IMAGE_FORMAT("rgba8") RWTexture2D<float4> u_Output : register(u0);

[shader("raygeneration")]
void RayGen()
{
    const uint2 index = DispatchRaysIndex().xy;
    const float2 size = float2(DispatchRaysDimensions().xy);

    RayDesc ray;
    ray.Origin = float3((float2(index) + 0.5) / size * 2 - 1, 0);
    ray.Direction = float3(0, 0, 1);
    ray.TMin = 0;
    ray.TMax = 10;

    Payload payload;
    payload.color = float3(0, 0, 0);
    TraceRay(t_Scene, RAY_FLAG_NONE, 0xff, 0, 0, 0, ray, payload);

    CallData data;
    data.green = 0;
    CallShader(0, data);

    u_Output[index] = float4(payload.color.r, data.green, payload.color.b, 1);
}

[shader("miss")]
void Miss(inout Payload payload)
{
    payload.color = float3(0, 0, 1);
}

[shader("closesthit")]
void ClosestHit(inout Payload payload, in BuiltInTriangleIntersectionAttributes attributes)
{
    payload.color = float3(1, 0, 0);
}

[shader("callable")]
void Callable(inout CallData data)
{
    data.green = 0.5;
}

// A multisampled color attachment resolved by a shader, for the NRI examples: NRI has no render
// pass resolve, and its CmdResolveTexture averages sRGB textures' encoded values on Vulkan (NRI
// creates sRGB images as their UNORM format, to view them either way). Read through an sRGB view,
// the samples are linear: their average, written through an sRGB view, is the resolve Donut's
// examples get (a render pass resolve on Vulkan, ResolveSubresource on D3D).

Texture2DMS<float4> t_Source : register(t0);

// A full screen triangle.
float4 resolve_vs(uint vertexIndex : SV_VertexID) : SV_Position
{
    const float2 uv = float2((vertexIndex << 1) & 2, vertexIndex & 2);
    return float4(uv * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
}

// The average of the pixel's samples.
float4 resolve_ps(float4 position : SV_Position) : SV_Target
{
    uint width;
    uint height;
    uint sampleCount;
    t_Source.GetDimensions(width, height, sampleCount);
    float4 sum = float4(0.0, 0.0, 0.0, 0.0);
    for (uint i = 0; i < sampleCount; i++)
        sum += t_Source.Load(int2(position.xy), i);
    return sum / float(sampleCount);
}

// A multisampled depth buffer resolved by a shader into an R32_FLOAT color target, as Vulkan's render
// pass depth resolve modes do (msaa_nri's -depthresolve min|max|average; its sample 0, the default
// mode, is read from the multisampled depth itself): the smallest, the largest or the average of
// the pixel's samples. At t1: apart from t_Source.
Texture2DMS<float> t_Depth : register(t1);

float resolve_depth_min_ps(float4 position : SV_Position) : SV_Target
{
    uint width;
    uint height;
    uint sampleCount;
    t_Depth.GetDimensions(width, height, sampleCount);
    float depth = t_Depth.Load(int2(position.xy), 0);
    for (uint i = 1; i < sampleCount; i++)
        depth = min(depth, t_Depth.Load(int2(position.xy), i));
    return depth;
}

float resolve_depth_max_ps(float4 position : SV_Position) : SV_Target
{
    uint width;
    uint height;
    uint sampleCount;
    t_Depth.GetDimensions(width, height, sampleCount);
    float depth = t_Depth.Load(int2(position.xy), 0);
    for (uint i = 1; i < sampleCount; i++)
        depth = max(depth, t_Depth.Load(int2(position.xy), i));
    return depth;
}

float resolve_depth_average_ps(float4 position : SV_Position) : SV_Target
{
    uint width;
    uint height;
    uint sampleCount;
    t_Depth.GetDimensions(width, height, sampleCount);
    float sum = 0.0;
    for (uint i = 0; i < sampleCount; i++)
        sum += t_Depth.Load(int2(position.xy), i);
    return sum / float(sampleCount);
}

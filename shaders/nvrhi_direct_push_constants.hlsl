// examples/nvrhi_direct.ts's push constant test: the pixel shader of its draws (nvrhi_direct.hlsl's
// vertex shader covering the viewport), the color in push constants (D3D12 root constants, Vulkan
// push constants), set before each draw.

#ifdef SPIRV

struct Constants
{
    float4 color;
};

[[vk::push_constant]] ConstantBuffer<Constants> g_Constants;
#define COLOR g_Constants.color

#else

// a cbuffer, which FXC (the DXBC build) also takes
cbuffer Constants : register(b0)
{
    float4 g_Color;
};
#define COLOR g_Color

#endif

float4 main_ps() : SV_Target
{
    return COLOR;
}

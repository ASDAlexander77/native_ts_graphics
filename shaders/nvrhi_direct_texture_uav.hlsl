// examples/nvrhi_direct.ts's texture UAV test: a compute shader writing each pixel of a 4 x 4 RGBA8
// texture through a UAV, its color from its position, each channel a whole 8-bit value:
// (64 x, 64 y, 128, 255) / 255.

#ifdef SPIRV
#define VK_IMAGE_FORMAT(format) [[vk::image_format(format)]]
#else
#define VK_IMAGE_FORMAT(format)
#endif

VK_IMAGE_FORMAT("rgba8") RWTexture2D<float4> u_Output : register(u0);

[numthreads(4, 4, 1)]
void main_cs(uint2 pixel : SV_DispatchThreadID)
{
    u_Output[pixel] = float4(64 * pixel.x, 64 * pixel.y, 128, 255) / 255;
}

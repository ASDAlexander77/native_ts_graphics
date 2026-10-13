// examples/nvrhi_direct.ts's render target test: the pixel shader of its draw (nvrhi_direct.hlsl's
// vertex shader covering the viewport), a color for each of the framebuffer's two render targets.

struct PixelOutput
{
    float4 first : SV_Target0;
    float4 second : SV_Target1;
};

PixelOutput main_ps()
{
    PixelOutput output;
    output.first = float4(1, 0.5, 0, 1);
    output.second = float4(0, 0.25, 1, 1);
    return output;
}

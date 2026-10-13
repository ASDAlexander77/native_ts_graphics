// examples/nvrhi_direct.ts's blend test: the pixel shader of its draws (nvrhi_direct.hlsl's vertex
// shader covering the viewport), a color half transparent, so the blend state shows in the result.

float4 main_ps() : SV_Target
{
    return float4(0, 0.5, 0.5, 0.5);
}

// examples/nvrhi_direct.ts's multisample test: the vertex shader of its draw (nvrhi_direct.hlsl's
// pixel shader, green), a triangle over the bottom left half of the viewport, its edge the diagonal
// from the top left corner to the bottom right one, through the centers of the pixels on it: each
// of those has 2 of its 4 samples (the standard positions) covered.

static const float2 CORNERS[3] = { float2(-1, 1), float2(1, -1), float2(-1, -1) };

float4 main_vs(uint vertexId : SV_VertexID) : SV_Position
{
    return float4(CORNERS[vertexId], 0, 1);
}

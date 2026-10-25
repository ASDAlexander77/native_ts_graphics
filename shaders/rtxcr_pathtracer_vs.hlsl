// The full-screen strip the rtxcr_pathtracer example draws its tone mapping pixel shader (the
// sample's tonemapping.hlsl) over: four vertices, as Donut's full-screen vertex shader.

void main_vs(in uint vertexId : SV_VertexID, out float4 position : SV_Position, out float2 uv : UV)
{
    const uint u = vertexId & 1;
    const uint v = (vertexId >> 1) & 1;
    position = float4(float(u) * 2.0 - 1.0, 1.0 - float(v) * 2.0, 0.0, 1.0);
    uv = float2(u, v);
}

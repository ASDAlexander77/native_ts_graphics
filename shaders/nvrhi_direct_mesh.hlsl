// examples/nvrhi_direct.ts's mesh shader test: one group of one thread making the triangle
// nvrhi_direct.hlsl's vertex shader makes (it covers the viewport), drawn orange, so what it covers
// shows each dispatch's viewport.

struct Vertex
{
    float4 position : SV_Position;
};

[outputtopology("triangle")]
[numthreads(1, 1, 1)]
void main_ms(out vertices Vertex vertices[3], out indices uint3 triangles[1])
{
    SetMeshOutputCounts(3, 1);
    vertices[0].position = float4(-1, -1, 0, 1);
    vertices[1].position = float4(-1, 3, 0, 1);
    vertices[2].position = float4(3, -1, 0, 1);
    triangles[0] = uint3(0, 1, 2);
}

float4 main_ps() : SV_Target
{
    return float4(1, 0.5, 0, 1);
}

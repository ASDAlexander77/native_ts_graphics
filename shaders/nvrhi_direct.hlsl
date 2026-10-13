// examples/nvrhi_direct.ts's compute shader: each of the 64 threads writes its input value times 2
// plus 1, so a wrong binding, element or dispatch shows in the output.

Buffer<uint> t_Input : register(t0);
RWBuffer<uint> u_Output : register(u0);

[numthreads(64, 1, 1)]
void main(uint threadIdx : SV_GroupThreadID)
{
    u_Output[threadIdx] = t_Input[threadIdx] * 2 + 1;
}

// The graphics pipeline's shaders: a triangle covering the viewport (from SV_VertexID, no vertex
// buffer), drawn green, so what it covers shows the viewport.
float4 main_vs(uint vertexId : SV_VertexID) : SV_Position
{
    float2 uv = float2((vertexId << 1) & 2, vertexId & 2);
    return float4(uv * 2 - 1, 0, 1);
}

float4 main_ps() : SV_Target
{
    return float4(0, 1, 0, 1);
}

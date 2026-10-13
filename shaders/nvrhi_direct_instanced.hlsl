// examples/nvrhi_direct.ts's instancing test: each instance a quad over the left half of the
// viewport (from SV_VertexID, no vertex buffer), moved right by its instance's offset and drawn in
// its color: the instance attributes, from a vertex buffer read once an instance.

static const float2 QUAD[6] = {
    float2(-1, -1), float2(0, -1), float2(0, 1),
    float2(-1, -1), float2(0, 1), float2(-1, 1)
};

void main_vs(uint vertexId : SV_VertexID, float2 offset : OFFSET, float4 color : COLOR,
    out float4 o_position : SV_Position, out float4 o_color : COLOR)
{
    o_position = float4(QUAD[vertexId] + offset, 0, 1);
    o_color = color;
}

float4 main_ps(float4 position : SV_Position, float4 color : COLOR) : SV_Target
{
    return color;
}

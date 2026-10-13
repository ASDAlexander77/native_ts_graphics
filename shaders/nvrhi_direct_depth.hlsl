// examples/nvrhi_direct.ts's depth test, one draw (from SV_VertexID, no vertex buffer) whose
// triangles are drawn in order: vertices 0-5 a near quad (depth 0.25, red) over the left half of
// the viewport, then 6-8 a far triangle (depth 0.75, blue) covering all of it.

struct VertexOutput
{
    float4 position : SV_Position;
    float4 color : COLOR;
};

static const float2 NEAR_QUAD[6] = {
    float2(-1, -1), float2(0, -1), float2(0, 1),
    float2(-1, -1), float2(0, 1), float2(-1, 1)
};

VertexOutput main_vs(uint vertexId : SV_VertexID)
{
    VertexOutput output;
    if (vertexId < 6)
    {
        output.position = float4(NEAR_QUAD[vertexId], 0.25, 1);
        output.color = float4(1, 0, 0, 1);
    }
    else
    {
        uint corner = vertexId - 6;
        float2 uv = float2((corner << 1) & 2, corner & 2);
        output.position = float4(uv * 2 - 1, 0.75, 1);
        output.color = float4(0, 0, 1, 1);
    }
    return output;
}

float4 main_ps(VertexOutput input) : SV_Target
{
    return input.color;
}

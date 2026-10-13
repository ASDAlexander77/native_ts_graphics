// examples/nvrhi_direct.ts's textured draw: a quad from a vertex buffer (position, texture
// coordinates) and an index buffer, sampling a 2 x 2 texture with a point sampler, each texel
// scaled by a constant buffer's value. A wrong attribute, index, binding or orientation shows in
// which texel lands where.

cbuffer c_Constants : register(b0)
{
    float4 g_Scale;
};

Texture2D<float4> t_Texture : register(t0);
SamplerState s_Sampler : register(s0);

void main_vs(float2 position : POSITION, float2 uv : TEXCOORD, out float4 o_position : SV_Position, out float2 o_uv : TEXCOORD)
{
    o_position = float4(position, 0, 1);
    o_uv = uv;
}

float4 main_ps(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target
{
    return t_Texture.Sample(s_Sampler, uv) * g_Scale;
}

// examples/nvrhi_direct.ts's sampler feedback test (D3D12: shader model 6.5's FeedbackTexture2D):
// each pixel of a 64 x 64 target asks for the texel under it of a 64 x 64 texture, at mip level 0 in
// the left half and 1 in the right, and writes that into the texture's sampler feedback (its
// minimum mip level per region) instead of sampling it. Drawn black.

Texture2D t_Texture : register(t0);
SamplerState s_Sampler : register(s0);
FeedbackTexture2D<SAMPLER_FEEDBACK_MIN_MIP> u_Feedback : register(u0);

float4 main_ps(float4 position : SV_Position) : SV_Target
{
    const float2 uv = position.xy / 64;
    u_Feedback.WriteSamplerFeedbackLevel(t_Texture, s_Sampler, uv, uv.x < 0.5 ? 0 : 1);
    return float4(0, 0, 0, 1);
}

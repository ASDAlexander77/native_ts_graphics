// examples/nvrhi_direct.ts's shader specialization test: each of 4 threads stores c_Value * 10 plus
// its index into a raw buffer. On Vulkan c_Value is a specialization constant (constant_id 0), which
// IDevice::createShaderSpecialization sets; elsewhere, and unspecialized, it is 7.

#ifdef SPIRV
[[vk::constant_id(0)]] const uint c_Value = 7;
#else
static const uint c_Value = 7;
#endif

RWByteAddressBuffer u_Output : register(u0);

[numthreads(4, 1, 1)]
void main_cs(uint index : SV_DispatchThreadID)
{
    u_Output.Store(index * 4, c_Value * 10 + index);
}

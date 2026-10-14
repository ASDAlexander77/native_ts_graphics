// examples/nvrhi_direct.ts's bindless test: each of 4 threads loads the first uint of a raw buffer of
// an unbounded array (a descriptor table, register space 1; on Vulkan binding 0 of set 1, the table
// being the compute state's second binding set), thread i from buffer 3 - i, and stores it into a raw
// buffer of the first binding set.

#ifdef SPIRV
#define VK_BINDING(index, set) [[vk::binding(index, set)]]
#else
#define VK_BINDING(index, set)
#endif

RWByteAddressBuffer u_Output : register(u0);
VK_BINDING(0, 1) ByteAddressBuffer t_Buffers[] : register(t0, space1);

[numthreads(4, 1, 1)]
void main_cs(uint index : SV_DispatchThreadID)
{
    u_Output.Store(index * 4, t_Buffers[NonUniformResourceIndex(3 - index)].Load(0));
}

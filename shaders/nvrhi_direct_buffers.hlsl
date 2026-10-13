// examples/nvrhi_direct.ts's structured and raw buffer test: each of 16 threads reads an item of a
// structured buffer and stores a * 100 + b into a raw (byte address) buffer, at its index times 4.

struct Item
{
    uint a;
    uint b;
};

StructuredBuffer<Item> t_Items : register(t0);
RWByteAddressBuffer u_Output : register(u0);

[numthreads(16, 1, 1)]
void main_cs(uint index : SV_DispatchThreadID)
{
    Item item = t_Items[index];
    u_Output.Store(index * 4, item.a * 100 + item.b);
}

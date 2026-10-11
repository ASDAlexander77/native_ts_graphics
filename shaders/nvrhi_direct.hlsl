// examples/nvrhi_direct.ts's compute shader: each of the 64 threads writes its input value times 2
// plus 1, so a wrong binding, element or dispatch shows in the output.

Buffer<uint> t_Input : register(t0);
RWBuffer<uint> u_Output : register(u0);

[numthreads(64, 1, 1)]
void main(uint threadIdx : SV_GroupThreadID)
{
    u_Output[threadIdx] = t_Input[threadIdx] * 2 + 1;
}

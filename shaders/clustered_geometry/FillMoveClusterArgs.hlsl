//*********************************************************
//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT License (MIT).
//
//*********************************************************
//
// FillMoveClusterArgs.hlsl
//
// GPU-side generator for the per-cluster
// D3D12_RTAS_OPERATION_MOVE_CLUSTER_OBJECTS_ARGS array used during the
// CLAS compact-move pass.  The struct is a single u64
// (SourceAccelerationStructure) per element -- in this sample the source
// addresses are exactly the per-cluster GVAs that the phase-1
// (worst-case) BUILD_CLAS_FROM_TRIANGLES op wrote into
// phase1AddressArray.  Previously the CPU did a readback + re-upload
// dance to plumb those addresses into the move args buffer; this CS
// copies them GPU-to-GPU.
//
// Layout: 8 bytes per element (one GVA).
//
//---------------------------------------------------------------------------

struct ConstantsData
{
    uint g_clusterCount;
};

// Root constants on D3D12, push constants on Vulkan.
#ifdef SPIRV
[[vk::push_constant]]
#endif
ConstantBuffer<ConstantsData> c_Constants : register(b0);

// Input: per-cluster CLAS GVAs (8 bytes each).  Bound as
// RWByteAddressBuffer so we can reuse it without a state transition
// after the phase-1 BUILD_CLAS pass leaves it in UNORDERED_ACCESS.
RWByteAddressBuffer g_srcAddrs : register(u1);

// Output: D3D12_RTAS_OPERATION_MOVE_CLUSTER_OBJECTS_ARGS array (8 B/elem).
RWByteAddressBuffer g_argsOut  : register(u0);

[numthreads(64, 1, 1)]
void main(uint3 tid : SV_DispatchThreadID)
{
    const uint idx = tid.x;
    if (idx >= c_Constants.g_clusterCount) return;

    const uint2 gva = g_srcAddrs.Load2(idx * 8u);
    g_argsOut.Store2(idx * 8u, gva);
}

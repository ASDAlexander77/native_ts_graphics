//*********************************************************
//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT License (MIT).
//
//*********************************************************
//
// FillInstantiateArgs.hlsl
//
// GPU-side generator for the per-cluster
// D3D12_RTAS_OPERATION_INSTANTIATE_CLUSTER_TEMPLATES_ARGS array that
// drives the animated ball's per-frame INSTANTIATE pass.
//
// One thread writes each argument directly from GPU template addresses and
// vertex offsets, avoiding a CPU address readback. A GPU-driven renderer can
// combine this with its culling/LOD selection pass.
//
// Layout of D3D12_RTAS_OPERATION_INSTANTIATE_CLUSTER_TEMPLATES_ARGS
// (32 bytes per element, see d3d12.h):
//
//   offset  0 (4 B)   INT       GeometryIndexOffset       = 0
//   offset  4 (4 B)   UINT      ClusterIdOffset           = g_clusterIdOffset
//   offset  8 (8 B)   u64 GVA   ClusterTemplate           = g_templateGvas[idx]
//   offset 16 (8 B)   u64 GVA   VertexBuffer.StartAddress = g_pfVbGva + g_vertexOffsets[idx]
//   offset 24 (8 B)   u64       VertexBuffer.StrideInBytes = g_vertexStride
//
// Buffers are bound via root descriptors (no descriptor heap involvement)
// so this pass is self-contained -- caller does NOT need to bind a
// descriptor heap before Dispatch.
//
//---------------------------------------------------------------------------

struct ConstantsData
{
    uint g_pfVbGvaLo; // low 32 bits of per-frame vertex buffer GPU VA
    uint g_pfVbGvaHi; // high 32 bits
    uint g_clusterCount; // total number of args to emit
    int g_clusterIdOffset; // animated IDs begin after the static/clone range
    uint g_vertexStride; // sizeof(float3) = 12
};

// Root constants on D3D12, push constants on Vulkan.
#ifdef SPIRV
[[vk::push_constant]]
#endif
ConstantBuffer<ConstantsData> c_Constants : register(b0);

// Input: per-cluster template GVAs (8 bytes each).  Produced by
// ExecuteIndirectRTASOperations(BUILD_CLUSTER_TEMPLATES) into obj.templateAddressArray.
// Bound as RWByteAddressBuffer (we only read) so we can reuse it without a
// state transition -- the producer leaves it in UNORDERED_ACCESS, a UAV
// barrier separates the two passes.
RWByteAddressBuffer g_templateGvas : register(u1);

// Input: per-cluster byte offsets into the per-frame vertex buffer
// (4 bytes each, cumulative prefix sum of per-cluster vertex sizes,
// pre-computed CPU-side at setup time).
ByteAddressBuffer g_vertexOffsets : register(t0);

// Output: D3D12_RTAS_OPERATION_INSTANTIATE_CLUSTER_TEMPLATES_ARGS array.
RWByteAddressBuffer g_argsOut : register(u0);

[numthreads(64, 1, 1)] void main(uint3 tid : SV_DispatchThreadID)
{
    const uint idx = tid.x;
    if (idx >= c_Constants.g_clusterCount)
        return;

    // Per-cluster template GVA (u64, 8 B at idx*8).
    const uint2 tmplLoHi = g_templateGvas.Load2(idx * 8u);

    // Per-cluster vertex-buffer byte offset (u32, 4 B at idx*4).
    const uint vbOffset = g_vertexOffsets.Load(idx * 4u);

    // Add the vertex offset to the GPU VA using the paired 32-bit layout.
    const uint addLo = c_Constants.g_pfVbGvaLo + vbOffset;
    const uint carry = (addLo < c_Constants.g_pfVbGvaLo) ? 1u : 0u;
    const uint vbStartLo = addLo;
    const uint vbStartHi = c_Constants.g_pfVbGvaHi + carry;

    const uint baseByte = idx * 32u;
#if defined(__spirv__)
    // Vulkan's VkClusterAccelerationStructureInstantiateClusterInfoNV: the cluster ID offset first.
    g_argsOut.Store(baseByte + 0, asuint(c_Constants.g_clusterIdOffset)); // clusterIdOffset
    g_argsOut.Store(baseByte + 4, 0u); // geometryIndexOffset = 0
#else
    g_argsOut.Store(baseByte + 0, 0u); // GeometryIndexOffset = 0
    g_argsOut.Store(baseByte + 4, asuint(c_Constants.g_clusterIdOffset)); // ClusterIdOffset
#endif
    g_argsOut.Store2(baseByte + 8, tmplLoHi); // ClusterTemplate (u64)
    g_argsOut.Store2(baseByte + 16, uint2(vbStartLo, vbStartHi)); // VertexBuffer.StartAddress (u64)
    g_argsOut.Store2(baseByte + 24, uint2(c_Constants.g_vertexStride, 0u)); // VertexBuffer.StrideInBytes (u64)
}

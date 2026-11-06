// The ptlas example's animation: one thread per instance slot writes the frame's PTLAS operation
// arguments - instance writes for the slots that change (all of them on frame 0, then the orbiters, the
// spinning tile's cubes and, at a second's first frame, the last tile's cubes returning from the
// global partition), instance updates for the cubes that swap BLAS, and every partition's
// translation - and the reference TLAS's instance, from the same values.

#include "ptlas_scene.hlsli"

cbuffer FrameConstants : register(b0)
{
    // x: the frame index; y: show the reference TLAS (ptlas.hlsl).
    float4 gFrame;
};

cbuffer BlasAddresses : register(b1)
{
    // The cube's, the octahedron's and the ground's addresses as instances reference them (low, high).
    uint4 gBlasAddresses[2];
};

RWByteAddressBuffer gWriteInstanceArgs : register(u0);
RWByteAddressBuffer gUpdateInstanceArgs : register(u1);
RWByteAddressBuffer gTranslatePartitionArgs : register(u2);
RWByteAddressBuffer gReferenceInstances : register(u3);

static const uint WriteInstanceStride = 104;
static const uint UpdateInstanceStride = 16;
static const uint TranslatePartitionStride = 16;
static const uint TlasInstanceStride = 64;

uint2 BlasAddress(uint blas)
{
    return blas == 0 ? gBlasAddresses[0].xy : blas == 1 ? gBlasAddresses[0].zw : gBlasAddresses[1].xy;
}

void StoreTransform(RWByteAddressBuffer buffer, uint offset, float4 rows[3], float3 translation)
{
    buffer.Store4(offset, asuint(rows[0] + float4(0, 0, 0, translation.x)));
    buffer.Store4(offset + 16, asuint(rows[1] + float4(0, 0, 0, translation.y)));
    buffer.Store4(offset + 32, asuint(rows[2] + float4(0, 0, 0, translation.z)));
}

// An instance write's arguments: VkPartitionedAccelerationStructureWriteInstanceDataNV and
// D3D12_RTAS_PARTITIONED_TLAS_OPERATION_WRITE_INSTANCE_ARGS have the same fields in different orders.
// Instance ID = slot, mask 0xFF, hit group 0, no flags, no explicit bounds.
void StoreWriteInstance(uint index, uint instance, InstanceState state)
{
    uint offset = index * WriteInstanceStride;
    // The transform, relative to the partition (the build adds its translation).
    StoreTransform(gWriteInstanceArgs, offset, state.rows, float3(0, 0, 0));
    uint2 address = BlasAddress(state.blas);
#ifdef SPIRV
    // transform[12], explicitAABB[6], instanceID, instanceMask, instanceContributionToHitGroupIndex,
    // instanceFlags, instanceIndex, partitionIndex, accelerationStructure.
    gWriteInstanceArgs.Store3(offset + 48, uint3(0, 0, 0));
    gWriteInstanceArgs.Store3(offset + 60, uint3(0, 0, 0));
    gWriteInstanceArgs.Store4(offset + 72, uint4(instance, 0xFF, 0, 0));
    gWriteInstanceArgs.Store2(offset + 88, uint2(instance, state.partition));
    gWriteInstanceArgs.Store2(offset + 96, address);
#else
    // Transform[3][4], InstanceID, InstanceMask, InstanceContributionToHitGroupIndex, InstanceFlags,
    // AccelerationStructure, InstanceIndex, PartitionIndex, ExplicitAABB.
    gWriteInstanceArgs.Store4(offset + 48, uint4(instance, 0xFF, 0, 0));
    gWriteInstanceArgs.Store2(offset + 64, address);
    gWriteInstanceArgs.Store2(offset + 72, uint2(instance, state.partition));
    gWriteInstanceArgs.Store3(offset + 80, uint3(0, 0, 0));
    gWriteInstanceArgs.Store3(offset + 92, uint3(0, 0, 0));
#endif
}

[numthreads(64, 1, 1)]
void animate_cs(uint instance : SV_DispatchThreadID)
{
    const uint frame = uint(gFrame.x);

    if (instance < PartitionCount)
    {
        // Every partition's translation, every frame: partitionIndex, partitionTranslation[3] (both APIs).
        uint offset = instance * TranslatePartitionStride;
        gTranslatePartitionArgs.Store(offset, instance);
        gTranslatePartitionArgs.Store3(offset + 4, asuint(PartitionTranslation(instance, frame)));
    }

    if (instance >= InstanceCount)
        return;

    InstanceState state = GetInstanceState(instance, frame);

    // The reference TLAS's instance (D3D12_RAYTRACING_INSTANCE_DESC, VkAccelerationStructureInstanceKHR):
    // the transform with the partition's translation, ID | mask << 24, hit group | flags << 24, BLAS.
    float3 translation = state.partition == GlobalPartition ? float3(0, 0, 0) : PartitionTranslation(state.partition, frame);
    uint referenceOffset = instance * TlasInstanceStride;
    StoreTransform(gReferenceInstances, referenceOffset, state.rows, translation);
    gReferenceInstances.Store2(referenceOffset + 48, uint2(instance | (0xFFu << 24), 0));
    gReferenceInstances.Store2(referenceOffset + 56, BlasAddress(state.blas));

    // The PTLAS's instance writes: every slot on frame 0 (a build from nothing), then the orbiters,
    // the spinning tile and, at a phase's first frame, the last tile's migrated half back into its
    // partition (in that order; Donut_BuildPtlas's writeCount is 24, or 32 then).
    uint phase = frame / FramesPerPhase;
    bool phaseStart = frame > 0 && frame % FramesPerPhase == 0;
    uint home = instance < GridInstanceCount ? PartitionOf(instance) : GlobalPartition;
    uint j = IndexInPartition(instance);
    if (frame == 0)
    {
        StoreWriteInstance(instance, instance, state);
    }
    else if (instance >= FirstOrbiter)
    {
        StoreWriteInstance(instance - FirstOrbiter, instance, state);
    }
    else if (instance < GridInstanceCount && home == SpinningPartition(frame))
    {
        StoreWriteInstance(OrbiterCount + j, instance, state);
    }
    else if (phaseStart && instance < GridInstanceCount && home == SpinningPartition(frame - 1) && Migrates(j))
    {
        StoreWriteInstance(OrbiterCount + InstancesPerPartition + IndexInHalf(j), instance, state);
    }

    // The swapping tile's checkerboard at the first frame of a phase: instanceIndex,
    // instanceContributionToHitGroupIndex, accelerationStructure (both APIs; updateCount 8).
    if (phaseStart && instance < GridInstanceCount && home == SwappingPartition(phase) && Swaps(j))
    {
        uint offset = IndexInHalf(j) * UpdateInstanceStride;
        gUpdateInstanceArgs.Store2(offset, uint2(instance, 0));
        gUpdateInstanceArgs.Store2(offset + 8, BlasAddress(state.blas));
    }
}

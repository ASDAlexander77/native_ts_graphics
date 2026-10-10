// DirectX-Graphics-Samples' D3D12MeshShaders DynamicLOD shaders (MeshletAS.hlsl, MeshletMS.hlsl,
// MeshletPS.hlsl, Common.hlsli, Shared.h): an amplification shader thread per instance culls it
// against the view frustum and picks its level of detail from its size on screen; the wave's
// instances are sorted by LOD into the payload, with each LOD's mesh shader group offsets; a mesh
// shader group per meshlet and instance (the last meshlet of each LOD packing several instances)
// reads the LOD's meshlets from arrays of buffers indexed by LOD. Flat, meshlet or LOD colors.
//
// Here the sample's root constants (b1) are push constants; the vertices are ByteAddressBuffers of
// the files' 24-byte records (Vulkan's structured buffers would lay two float3s out 32 bytes apart);
// and the amplification shader's per-thread index into the MeshInfo array is marked non-uniform, as
// Vulkan requires (the sample leaves it unmarked; D3D12 drivers get away with it).
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).

#include <donut/shaders/binding_helpers.hlsli>

#define MAX(x, y) (x > y ? x : y)
#define ROUNDUP(x, y) ((x + y - 1) & ~(y - 1))

#define MAX_VERTS 64
#define MAX_PRIMS 126
#define MAX_LOD_LEVELS 8

#define THREADS_PER_WAVE 32 // Assumes availability of wave size of 32 threads

#define AS_GROUP_SIZE THREADS_PER_WAVE
#define MS_GROUP_SIZE ROUNDUP(MAX(MAX_VERTS, MAX_PRIMS), THREADS_PER_WAVE)

struct Constants
{
    float4x4 View;
    float4x4 ViewProj;
    float4 Planes[6];

    float3 ViewPosition;
    float RecipTanHalfFovy;

    uint RenderMode;
    uint LODCount;
};

struct DrawParams
{
    uint InstanceOffset;
    uint InstanceCount;
};

struct Instance
{
    float4x4 World;
    float4x4 WorldInvTranspose;
    float4   BoundingSphere;
};

struct VertexOut
{
    float4 PositionHS   : SV_Position;
    float3 PositionVS   : POSITION0;
    uint   MeshletIndex : COLOR0;
    float4 Color        : COLOR2;
    float3 Normal       : NORMAL0;
};

struct Payload
{
    uint InstanceCounts[MAX_LOD_LEVELS];   // The instance count for each LOD level.
    uint GroupOffsets[MAX_LOD_LEVELS + 1]; // The offset in threadgroups for each LOD level.

    // The list of instance indices after culling. Ordered as:
    // (list of LOD 0 instance indices), (list of LOD 1 instance indices), ... (list of LOD MAX_LOD_LEVELS-1 instance indices)
    uint InstanceList[AS_GROUP_SIZE];
    uint InstanceOffsets[MAX_LOD_LEVELS + 1]; // The offset into the Instance List at which each LOD level begins.
};

struct MeshInfo
{
    uint IndexBytes;
    uint MeshletCount;

    uint LastMeshletVertCount;
    uint LastMeshletPrimCount;
};

struct Vertex
{
    float3 Position;
    float3 Normal;
};

struct Meshlet
{
    uint VertCount;
    uint VertOffset;
    uint PrimCount;
    uint PrimOffset;
};

ConstantBuffer<Constants>  Constants : register(b0);
DECLARE_PUSH_CONSTANTS(DrawParams, g_DrawParams, 1, 0);
ConstantBuffer<MeshInfo>   MeshInfo[MAX_LOD_LEVELS] : register(b2);

ByteAddressBuffer          Vertices[MAX_LOD_LEVELS] : register(t0);
StructuredBuffer<Meshlet>  Meshlets[MAX_LOD_LEVELS] : register(t8);
ByteAddressBuffer          UniqueVertexIndices[MAX_LOD_LEVELS] : register(t16);
StructuredBuffer<uint>     PrimitiveIndices[MAX_LOD_LEVELS] : register(t24);
StructuredBuffer<Instance> Instances : register(t32);

#define DrawParams g_DrawParams

bool IsVisible(float4 boundingSphere)
{
    float4 center = float4(boundingSphere.xyz, 1.0);
    float radius = boundingSphere.w;

    for (int i = 0; i < 6; ++i)
    {
        if (dot(center, Constants.Planes[i]) < -radius)
        {
            return false;
        }
    }

    return true;
}

uint ComputeLOD(float4 boundingSphere)
{
    float3 v = boundingSphere.xyz - Constants.ViewPosition;
    float r = boundingSphere.w;

    // Sphere radius in screen space
    float size = Constants.RecipTanHalfFovy * r / sqrt(dot(v, v) - r * r);
    size = min(size, 1.0);

    return (1.0 - size) * (Constants.LODCount - 1);
}

uint DivRoundUp(uint num, uint denom)
{
    return (num + denom - 1) / denom;
}


/////
// Amplification shader

groupshared Payload s_Payload;

groupshared uint s_InstanceCounts[MAX_LOD_LEVELS];
groupshared uint s_GroupOffsets[MAX_LOD_LEVELS + 1];
groupshared uint s_InstanceList[AS_GROUP_SIZE];
groupshared uint s_InstanceOffsets[MAX_LOD_LEVELS + 1];

[NumThreads(AS_GROUP_SIZE, 1, 1)]
void main_as(uint dtid : SV_DispatchThreadID, uint gtid : SV_GroupThreadID, uint gid : SV_GroupID)
{
    // Zero out groupshared memory which requires it.
    s_InstanceList[gtid] = 0;

    if (gtid == 0)
    {
        s_InstanceOffsets[0] = 0;
        s_GroupOffsets[0] = 0;
    }

    if (gtid < MAX_LOD_LEVELS)
    {
        s_InstanceCounts[gtid] = 0;
    }

    // Cull & compact the instances
    uint lodLevel = MAX_LOD_LEVELS; // LOD level of this thread's instance
    uint lodOffset = 0;             // Offset into its LOD-level instance list

    uint instanceIndex = DrawParams.InstanceOffset + dtid;

    if (instanceIndex < DrawParams.InstanceCount)
    {
        Instance instance = Instances[instanceIndex];

        if (IsVisible(instance.BoundingSphere))
        {
            lodLevel = ComputeLOD(instance.BoundingSphere);
        }
    }

    // Determine counts for each LOD and each thread's offset into its LOD instance list
    [unroll]
    for (uint i = 0; i < MAX_LOD_LEVELS; ++i)
    {
        bool lodMatch = lodLevel == i; // Whether this thread's calculated LOD matches the current one.

        if (lodMatch)
        {
            lodOffset = WavePrefixCountBits(lodMatch);
        }

        s_InstanceCounts[i] = WaveActiveCountBits(lodMatch);
    }

    // Compute instance and Level-of-detail
    if (gtid < MAX_LOD_LEVELS)
    {
        uint lodInstanceCount = s_InstanceCounts[gtid];
        s_InstanceOffsets[gtid + 1] = lodInstanceCount;

        struct MeshInfo meshInfo = MeshInfo[NonUniformResourceIndex(gtid)];
        uint unpackedGroupCount = (meshInfo.MeshletCount - 1) * lodInstanceCount;
        uint packCount = min(MAX_VERTS / meshInfo.LastMeshletVertCount, MAX_PRIMS / meshInfo.LastMeshletPrimCount);
        uint packedGroupCount = DivRoundUp(lodInstanceCount, packCount);

        s_GroupOffsets[gtid + 1] = unpackedGroupCount + packedGroupCount;
    }

    // Accumulate LOD & instance counts to create offset lookup tables for mesh shader threadgroups
    if (gtid <= MAX_LOD_LEVELS)
    {
        uint instanceCount = s_InstanceOffsets[gtid];
        s_InstanceOffsets[gtid] = instanceCount + WavePrefixSum(instanceCount);

        uint lodCount = s_GroupOffsets[gtid];
        s_GroupOffsets[gtid] = lodCount + WavePrefixSum(lodCount);
    }

    // Place this thread's instance index at its assigned slot from compaction.
    if (lodLevel != MAX_LOD_LEVELS)
    {
        uint lodStart = s_InstanceOffsets[lodLevel];
        s_InstanceList[lodStart + lodOffset] = instanceIndex;
    }

    // Copy groupshared memory to payload
    s_Payload.InstanceList[gtid] = s_InstanceList[gtid];

    if (gtid < MAX_LOD_LEVELS)
    {
        s_Payload.InstanceCounts[gtid] = s_InstanceCounts[gtid];
    }

    if (gtid <= MAX_LOD_LEVELS)
    {
        s_Payload.GroupOffsets[gtid] = s_GroupOffsets[gtid];
        s_Payload.InstanceOffsets[gtid] = s_InstanceOffsets[gtid];
    }

    // NOTE: Be aware that the maximum threadgroup count of a single dimension is 65536.
    //       This method is limited to an LOD 0 size of (65536 / AS_GROUP_SIZE) meshlets.
    DispatchMesh(s_GroupOffsets[Constants.LODCount], 1, 1, s_Payload);
}


/////
// Mesh shader

float4 LODColor(float4 boundingSphere)
{
    uint lodLevel = ComputeLOD(boundingSphere);
    float alpha = float(lodLevel) / (Constants.LODCount - 1);

    return lerp(float4(1, 0, 0, 1), float4(0, 1, 0, 1), alpha);
}

uint3 UnpackPrimitive(uint primitive)
{
    // Unpacks a 10 bits per index triangle from a 32-bit uint.
    return uint3(primitive & 0x3FF, (primitive >> 10) & 0x3FF, (primitive >> 20) & 0x3FF);
}

uint3 GetPrimitive(uint lodIndex, Meshlet m, uint index)
{
    return UnpackPrimitive(PrimitiveIndices[lodIndex][m.PrimOffset + index]);
}

uint GetVertexIndex(uint lodIndex, Meshlet m, uint localIndex)
{
    localIndex = m.VertOffset + localIndex;

    if (MeshInfo[lodIndex].IndexBytes == 4) // 32-bit Vertex Indices
    {
        return UniqueVertexIndices[lodIndex].Load(localIndex * 4);
    }
    else // 16-bit Vertex Indices
    {
        // Byte address must be 4-byte aligned.
        uint wordOffset = (localIndex & 0x1);
        uint byteOffset = (localIndex / 2) * 4;

        // Grab the pair of 16-bit indices, shift & mask off proper 16-bits.
        uint indexPair = UniqueVertexIndices[lodIndex].Load(byteOffset);
        uint index = (indexPair >> (wordOffset * 16)) & 0xffff;

        return index;
    }
}

VertexOut GetVertexAttributes(uint lodIndex, uint meshletIndex, uint vertexIndex, uint instanceIndex)
{
    Instance n = Instances[DrawParams.InstanceOffset + instanceIndex];

    Vertex v;
    v.Position = asfloat(Vertices[lodIndex].Load3(vertexIndex * 24));
    v.Normal = asfloat(Vertices[lodIndex].Load3(vertexIndex * 24 + 12));

    float4 positionWS = mul(float4(v.Position, 1), n.World);

    VertexOut vout;
    vout.PositionVS   = mul(positionWS, Constants.View).xyz;
    vout.PositionHS   = mul(positionWS, Constants.ViewProj);
    vout.Normal       = mul(float4(v.Normal, 0), n.WorldInvTranspose).xyz;
    vout.Color        = LODColor(n.BoundingSphere);
    vout.MeshletIndex = meshletIndex;

    return vout;
}

[NumThreads(MS_GROUP_SIZE, 1, 1)]
[OutputTopology("triangle")]
void main_ms(
    uint gtid : SV_GroupIndex,
    uint gid : SV_GroupID,
    in payload Payload payload,
    out vertices VertexOut verts[MAX_VERTS],
    out indices uint3 tris[MAX_PRIMS])
{
    // Find the LOD to which this threadgroup is assigned.
    // Each wave does this independently to avoid groupshared memory & sync.
    uint offsetCheck = 0;
    uint laneIndex = gtid % WaveGetLaneCount();
    if (laneIndex <= MAX_LOD_LEVELS)
    {
        offsetCheck = WaveActiveCountBits(gid >= payload.GroupOffsets[laneIndex]) - 1;
    }
    uint lodIndex = WaveReadLaneFirst(offsetCheck);

    // Load our LOD meshlet offset & LOD instance count
    uint lodOffset = payload.GroupOffsets[lodIndex];
    uint lodCount = payload.InstanceCounts[lodIndex];

    // Calculate and load our meshlet.
    uint meshletIndex = (gid - lodOffset) / lodCount;
    Meshlet m = Meshlets[lodIndex][meshletIndex];

    // Determine instance count - only 1 instance per threadgroup in the general case
    uint instanceCount = 1;

    // Last meshlet in mesh may be be packed - multiple instances rendered from a single threadgroup.
    if (meshletIndex == MeshInfo[lodIndex].MeshletCount - 1)
    {
        // Determine how many packed instances there are in this group
        uint unpackedGroupCount = (MeshInfo[lodIndex].MeshletCount - 1) * lodCount;
        uint packedIndex = gid - (unpackedGroupCount + lodOffset);

        uint instancesPerGroup = min(MAX_VERTS / m.VertCount, MAX_PRIMS / m.PrimCount);
        uint startInstance = packedIndex * instancesPerGroup;

        instanceCount = min(lodCount - startInstance, instancesPerGroup);
    }

    // Compute our total vertex & primitive counts
    uint totalVertCount = m.VertCount * instanceCount;
    uint totalPrimCount = m.PrimCount * instanceCount;

    SetMeshOutputCounts(totalVertCount, totalPrimCount);

    //--------------------------------------------------------------------
    // Export Primitive & Vertex Data

    if (gtid < totalVertCount)
    {
        uint readIndex = gtid % m.VertCount;  // Wrap our reads for packed instancing.
        uint vertexIndex = GetVertexIndex(lodIndex, m, readIndex);

        // Determine our instance index
        uint instanceId = gtid / m.VertCount; // Instance index into this threadgroup's instances (only non-zero for packed threadgroups.)
        uint lodInstance = (gid - lodOffset) % lodCount + instanceId;           // Instance index into this LOD level's instances
        uint instanceOffset = payload.InstanceOffsets[lodIndex] + lodInstance;  // Instance index into the payload instance list
        uint instanceIndex = payload.InstanceList[instanceOffset]; // The final instance index of this vertex.

        verts[gtid] = GetVertexAttributes(lodIndex, meshletIndex, vertexIndex, instanceIndex);
    }

    if (gtid < totalPrimCount)
    {
        uint readIndex = gtid % m.PrimCount;  // Wrap our reads for packed instancing.
        uint instanceId = gtid / m.PrimCount; // Instance index within this threadgroup (only non-zero in last meshlet threadgroups.)

        // Must offset the vertex indices to this thread's instanced verts
        tris[gtid] = GetPrimitive(lodIndex, m, readIndex) + (m.VertCount * instanceId);
    }
}


/////
// Pixel shader

float4 main_ps(VertexOut pin) : SV_TARGET
{
    const float ambientIntensity = 0.1;
    const float3 lightColor = float3(1, 1, 1);
    const float3 lightDir = -normalize(float3(1, -1, 1));

    float3 diffuseColor;
    float shininess;
    if (Constants.RenderMode == 0)
    {
        diffuseColor = 0.5;
        shininess = 4.0;
    }
    else if (Constants.RenderMode == 1)
    {
        uint meshletIndex = pin.MeshletIndex;
        diffuseColor = float3(
            float(meshletIndex & 1),
            float(meshletIndex & 3) / 4,
            float(meshletIndex & 7) / 8);
        shininess = 16.0;
    }
    else // Dynamic LOD spectrum (LOD 0 - red, LOD n - green)
    {
        diffuseColor = pin.Color.rgb;
        shininess = 8.0;
    }

    float3 normal = normalize(pin.Normal);

    // Do some fancy Blinn-Phong shading!
    float cosAngle = saturate(dot(normal, lightDir));
    float3 viewDir = -normalize(pin.PositionVS);
    float3 halfAngle = normalize(lightDir + viewDir);

    float blinnTerm = saturate(dot(normal, halfAngle));
    blinnTerm = cosAngle != 0.0 ? blinnTerm : 0.0;
    blinnTerm = pow(blinnTerm, shininess);

    float3 finalColor = (cosAngle + blinnTerm + ambientIntensity) * diffuseColor;

    return float4(finalColor, 1);
}

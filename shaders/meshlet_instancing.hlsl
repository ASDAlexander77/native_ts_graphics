// DirectX-Graphics-Samples' D3D12MeshShaders MeshletInstancing shaders (MeshletMS.hlsl, MeshletPS.hlsl,
// Shared.h): a mesh shader group per meshlet and instance, but the last meshlet of the mesh packed,
// several instances of it in one group; shaded in the meshlet's color. The sample's two sets of root
// constants (b1: DrawParams, b2: MeshInfo) are one block of push constants here (a pipeline has one);
// the vertices are a ByteAddressBuffer of the file's 24-byte records (Vulkan's structured buffers
// would lay two float3s out 32 bytes apart).
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).

#include <donut/shaders/binding_helpers.hlsli>

#define MAX_VERTS 64
#define MAX_PRIMS 126

struct Constants
{
    float4x4 View;
    float4x4 ViewProj;
    uint     DrawMeshlets;
};

// DrawParams (InstanceCount, InstanceOffset), then MeshInfo (IndexBytes, MeshletCount,
// MeshletOffset).
struct DrawParamsAndMeshInfo
{
    uint InstanceCount;
    uint InstanceOffset;
    uint IndexBytes;
    uint MeshletCount;
    uint MeshletOffset;
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

struct Instance
{
    float4x4 World;
    float4x4 WorldInvTranspose;
};

struct VertexOut
{
    float4 PositionHS   : SV_Position;
    float3 PositionVS   : POSITION0;
    float3 Normal       : NORMAL0;
    uint   MeshletIndex : COLOR0;
};

ConstantBuffer<Constants>  Globals             : register(b0);
DECLARE_PUSH_CONSTANTS(DrawParamsAndMeshInfo, g_Params, 1, 0);

ByteAddressBuffer          Vertices            : register(t0);
StructuredBuffer<Meshlet>  Meshlets            : register(t1);
ByteAddressBuffer          UniqueVertexIndices : register(t2);
StructuredBuffer<uint>     PrimitiveIndices    : register(t3);
StructuredBuffer<Instance> Instances           : register(t4);

#define DrawParams g_Params
#define MeshInfo g_Params


/////
// Data Loaders

uint3 UnpackPrimitive(uint primitive)
{
    // Unpacks a 10 bits per index triangle from a 32-bit uint.
    return uint3(primitive & 0x3FF, (primitive >> 10) & 0x3FF, (primitive >> 20) & 0x3FF);
}

uint3 GetPrimitive(Meshlet m, uint index)
{
    return UnpackPrimitive(PrimitiveIndices[m.PrimOffset + index]);
}

uint GetVertexIndex(Meshlet m, uint localIndex)
{
    localIndex = m.VertOffset + localIndex;

    if (MeshInfo.IndexBytes == 4) // 32-bit Vertex Indices
    {
        return UniqueVertexIndices.Load(localIndex * 4);
    }
    else // 16-bit Vertex Indices
    {
        // Byte address must be 4-byte aligned.
        uint wordOffset = (localIndex & 0x1);
        uint byteOffset = (localIndex / 2) * 4;

        // Grab the pair of 16-bit indices, shift & mask off proper 16-bits.
        uint indexPair = UniqueVertexIndices.Load(byteOffset);
        uint index = (indexPair >> (wordOffset * 16)) & 0xffff;

        return index;
    }
}

VertexOut GetVertexAttributes(uint meshletIndex, uint vertexIndex, uint instanceIndex)
{
    Instance n = Instances[DrawParams.InstanceOffset + instanceIndex];

    Vertex v;
    v.Position = asfloat(Vertices.Load3(vertexIndex * 24));
    v.Normal = asfloat(Vertices.Load3(vertexIndex * 24 + 12));

    float4 positionWS = mul(float4(v.Position, 1), n.World);

    VertexOut vout;
    vout.PositionVS = mul(positionWS, Globals.View).xyz;
    vout.PositionHS = mul(positionWS, Globals.ViewProj);
    vout.Normal = mul(float4(v.Normal, 0), n.WorldInvTranspose).xyz;
    vout.MeshletIndex = meshletIndex;

    return vout;
}

[NumThreads(128, 1, 1)]
[OutputTopology("triangle")]
void main_ms(
    uint gtid : SV_GroupIndex,
    uint gid : SV_GroupID,
    out vertices VertexOut verts[MAX_VERTS],
    out indices uint3 tris[MAX_PRIMS]
)
{
    uint meshletIndex = gid / DrawParams.InstanceCount;
    Meshlet m = Meshlets[meshletIndex];

    // Determine instance count - only 1 instance per threadgroup in the general case
    uint startInstance = gid % DrawParams.InstanceCount;
    uint instanceCount = 1;

    // Last meshlet in mesh may be be packed - multiple instances submitted by a single threadgroup.
    if (meshletIndex == MeshInfo.MeshletCount - 1)
    {
        const uint instancesPerGroup = min(MAX_VERTS / m.VertCount, MAX_PRIMS / m.PrimCount);

        // Determine how many packed instances there are in this group
        uint unpackedGroupCount = (MeshInfo.MeshletCount - 1) * DrawParams.InstanceCount;
        uint packedIndex = gid - unpackedGroupCount;

        startInstance = packedIndex * instancesPerGroup;
        instanceCount = min(DrawParams.InstanceCount - startInstance, instancesPerGroup);
    }

    // Compute our total vertex & primitive counts
    uint vertCount = m.VertCount * instanceCount;
    uint primCount = m.PrimCount * instanceCount;

    SetMeshOutputCounts(vertCount, primCount);

    //--------------------------------------------------------------------
    // Export Primitive & Vertex Data

    if (gtid < vertCount)
    {
        uint readIndex = gtid % m.VertCount;  // Wrap our reads for packed instancing.
        uint instanceId = gtid / m.VertCount; // Instance index into this threadgroup's instances (only non-zero for packed threadgroups.)

        uint vertexIndex = GetVertexIndex(m, readIndex);
        uint instanceIndex = startInstance + instanceId;

        verts[gtid] = GetVertexAttributes(meshletIndex, vertexIndex, instanceIndex);
    }

    if (gtid < primCount)
    {
        uint readIndex = gtid % m.PrimCount;  // Wrap our reads for packed instancing.
        uint instanceId = gtid / m.PrimCount; // Instance index within this threadgroup (only non-zero in last meshlet threadgroups.)

        // Must offset the vertex indices to this thread's instanced verts
        tris[gtid] = GetPrimitive(m, readIndex) + (m.VertCount * instanceId);
    }
}

float4 main_ps(VertexOut input) : SV_TARGET
{
    float ambientIntensity = 0.1;
    float3 lightColor = float3(1, 1, 1);
    float3 lightDir = -normalize(float3(1, -1, 1));

    float3 diffuseColor;
    float shininess;
    if (Globals.DrawMeshlets)
    {
        uint meshletIndex = input.MeshletIndex;
        diffuseColor = float3(
            float(meshletIndex & 1),
            float(meshletIndex & 3) / 4,
            float(meshletIndex & 7) / 8);
        shininess = 16.0;
    }
    else
    {
        diffuseColor = 0.8;
        shininess = 64.0;
    }

    float3 normal = normalize(input.Normal);

    // Do some fancy Blinn-Phong shading!
    float cosAngle = saturate(dot(normal, lightDir));
    float3 viewDir = -normalize(input.PositionVS);
    float3 halfAngle = normalize(lightDir + viewDir);

    float blinnTerm = saturate(dot(normal, halfAngle));
    blinnTerm = cosAngle != 0.0 ? blinnTerm : 0.0;
    blinnTerm = pow(blinnTerm, shininess);

    float3 finalColor = (cosAngle + blinnTerm + ambientIntensity) * diffuseColor;

    return float4(finalColor, 1);
}

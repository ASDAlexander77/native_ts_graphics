// DirectX-Graphics-Samples' D3D12MeshShaders MeshletRender shaders (MeshletMS.hlsl, MeshletPS.hlsl):
// a mesh shader group per meshlet, outputting its vertices and triangles, shaded Blinn-Phong in the
// meshlet's color. The sample's root signature is the binding layout here; its root constants
// (b1) are push constants. The vertices are a ByteAddressBuffer of 24-byte records: Vulkan's
// structured buffers would lay a struct of two float3s out 32 bytes apart (std430).
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).

#include <donut/shaders/binding_helpers.hlsli>

struct Constants
{
    float4x4 World;
    float4x4 WorldView;
    float4x4 WorldViewProj;
    uint     DrawMeshlets;
};

struct MeshInfo
{
    uint IndexBytes;
    uint MeshletOffset;
};

struct Vertex
{
    float3 Position;
    float3 Normal;
};

struct VertexOut
{
    float4 PositionHS   : SV_Position;
    float3 PositionVS   : POSITION0;
    float3 Normal       : NORMAL0;
    uint   MeshletIndex : COLOR0;
};

struct Meshlet
{
    uint VertCount;
    uint VertOffset;
    uint PrimCount;
    uint PrimOffset;
};

ConstantBuffer<Constants> Globals : register(b0);
DECLARE_PUSH_CONSTANTS(MeshInfo, g_MeshInfo, 1, 0);

ByteAddressBuffer         Vertices            : register(t0);
StructuredBuffer<Meshlet> Meshlets            : register(t1);
ByteAddressBuffer         UniqueVertexIndices : register(t2);
StructuredBuffer<uint>    PrimitiveIndices    : register(t3);


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

    if (g_MeshInfo.IndexBytes == 4) // 32-bit Vertex Indices
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

VertexOut GetVertexAttributes(uint meshletIndex, uint vertexIndex)
{
    Vertex v;
    v.Position = asfloat(Vertices.Load3(vertexIndex * 24));
    v.Normal = asfloat(Vertices.Load3(vertexIndex * 24 + 12));

    VertexOut vout;
    vout.PositionVS = mul(float4(v.Position, 1), Globals.WorldView).xyz;
    vout.PositionHS = mul(float4(v.Position, 1), Globals.WorldViewProj);
    vout.Normal = mul(float4(v.Normal, 0), Globals.World).xyz;
    vout.MeshletIndex = meshletIndex;

    return vout;
}


[NumThreads(128, 1, 1)]
[OutputTopology("triangle")]
void main_ms(
    uint gtid : SV_GroupThreadID,
    uint gid : SV_GroupID,
    out indices uint3 tris[126],
    out vertices VertexOut verts[64]
)
{
    Meshlet m = Meshlets[g_MeshInfo.MeshletOffset + gid];

    SetMeshOutputCounts(m.VertCount, m.PrimCount);

    if (gtid < m.PrimCount)
    {
        tris[gtid] = GetPrimitive(m, gtid);
    }

    if (gtid < m.VertCount)
    {
        uint vertexIndex = GetVertexIndex(m, gtid);
        verts[gtid] = GetVertexAttributes(gid, vertexIndex);
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

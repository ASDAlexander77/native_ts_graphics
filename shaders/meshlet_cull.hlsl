// DirectX-Graphics-Samples' D3D12MeshShaders MeshletCull shaders (MeshletAS.hlsl, MeshletMS.hlsl,
// MeshletPS.hlsl, MeshletCommon.hlsli, MeshletUtils.hlsli, Shared.h): an amplification shader culls
// a wave of meshlets against the culling camera's frustum and by their normal cones, and launches
// mesh shader groups for those kept; the pixel shader shades them in their meshlet's color,
// desaturated but for the highlighted and selected ones. The sample's root signature is the
// binding layout here. The vertices and the culling data are ByteAddressBuffers of the sample's
// records: Vulkan's structured buffers would lay them out with 16-byte aligned float3s and float4s
// (std430), not as the files pack them.
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).

#define THREADS_PER_WAVE 32 // Assumes availability of wave size of 32 threads
#define AS_GROUP_SIZE THREADS_PER_WAVE

#define CULL_FLAG 0x1
#define MESHLET_FLAG 0x2

struct Instance
{
    float4x4 World;
    float4x4 WorldInvTrans;
    float    Scale;
    uint     Flags;
};

struct Constants
{
    float4x4    View;
    float4x4    ViewProj;
    float4      Planes[6];
    float3      ViewPosition;
    uint        HighlightedIndex;
    float3      CullViewPosition;
    uint        SelectedIndex;
    uint        DrawMeshlets;
};

struct MeshInfo
{
    uint IndexSize;
    uint MeshletCount;

    uint LastMeshletVertCount;
    uint LastMeshletPrimCount;
};

struct Meshlet
{
    uint VertCount;
    uint VertOffset;
    uint PrimCount;
    uint PrimOffset;
};

struct CullData
{
    float4 BoundingSphere; // xyz = center, w = radius
    uint   NormalCone;     // xyz = axis, w = -cos(a + 90)
    float  ApexOffset;     // apex = center - axis * offset
};

bool IsConeDegenerate(CullData c)
{
    return (c.NormalCone >> 24) == 0xff;
}

float4 UnpackCone(uint packed)
{
    float4 v;
    v.x = float((packed >> 0) & 0xFF);
    v.y = float((packed >> 8) & 0xFF);
    v.z = float((packed >> 16) & 0xFF);
    v.w = float((packed >> 24) & 0xFF);

    v = v / 255.0;
    v.xyz = v.xyz * 2.0 - 1.0;

    return v;
}

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

struct Payload
{
    uint MeshletIndices[AS_GROUP_SIZE];
};

ConstantBuffer<Constants>   Constants           : register(b0);
ConstantBuffer<MeshInfo>    MeshInfo            : register(b1);
ConstantBuffer<Instance>    Instance            : register(b2);

ByteAddressBuffer           Vertices            : register(t0);
StructuredBuffer<Meshlet>   Meshlets            : register(t1);
ByteAddressBuffer           UniqueVertexIndices : register(t2);
StructuredBuffer<uint>      PrimitiveIndices    : register(t3);
ByteAddressBuffer           MeshletCullData     : register(t4);

// The file's 24-byte CullData records.
CullData LoadCullData(uint index)
{
    CullData c;
    c.BoundingSphere = asfloat(MeshletCullData.Load4(index * 24));
    c.NormalCone = MeshletCullData.Load(index * 24 + 16);
    c.ApexOffset = asfloat(MeshletCullData.Load(index * 24 + 20));
    return c;
}


/////
// Amplification shader

groupshared Payload s_Payload;

bool IsVisible(CullData c, float4x4 world, float scale, float3 viewPos)
{
    if ((Instance.Flags & CULL_FLAG) == 0)
        return true;

    // Do a cull test of the bounding sphere against the view frustum planes.
    float4 center = mul(float4(c.BoundingSphere.xyz, 1), world);
    float radius = c.BoundingSphere.w * scale;

    for (int i = 0; i < 6; ++i)
    {
        if (dot(center, Constants.Planes[i]) < -radius)
        {
            return false;
        }
    }

    // Do normal cone culling
    if (IsConeDegenerate(c))
        return true; // Cone is degenerate - spread is wider than a hemisphere.

    // Unpack the normal cone from its 8-bit uint compression
    float4 normalCone = UnpackCone(c.NormalCone);

    // Transform axis to world space
    float3 axis = normalize(mul(float4(normalCone.xyz, 0), world)).xyz;

    // Offset the normal cone axis from the meshlet center-point - make sure to account for world scaling
    float3 apex = center.xyz - axis * c.ApexOffset * scale;
    float3 view = normalize(viewPos - apex);

    // The normal cone w-component stores -cos(angle + 90 deg)
    // This is the min dot product along the inverted axis from which all the meshlet's triangles are backface
    if (dot(view, -axis) > normalCone.w)
    {
        return false;
    }

    // All tests passed - it will merit pixels
    return true;
}

[NumThreads(AS_GROUP_SIZE, 1, 1)]
void main_as(uint gtid : SV_GroupThreadID, uint dtid : SV_DispatchThreadID, uint gid : SV_GroupID)
{
    bool visible = false;

    // Check bounds of meshlet cull data resource
    if (dtid < MeshInfo.MeshletCount)
    {
        // Do visibility testing for this thread
        visible = IsVisible(LoadCullData(dtid), Instance.World, Instance.Scale, Constants.CullViewPosition);
    }

    // Compact visible meshlets into the export payload array
    if (visible)
    {
        uint index = WavePrefixCountBits(visible);
        s_Payload.MeshletIndices[index] = dtid;
    }

    // Dispatch the required number of MS threadgroups to render the visible meshlets
    uint visibleCount = WaveActiveCountBits(visible);
    DispatchMesh(visibleCount, 1, 1, s_Payload);
}


/////
// Mesh shader

uint3 UnpackPrimitive(uint primitive)
{
    // Unpacks a 10 bits per index triangle from a 32-bit uint.
    return uint3(primitive & 0x3FF, (primitive >> 10) & 0x3FF, (primitive >> 20) & 0x3FF);
}

uint GetVertexIndex(Meshlet m, uint localIndex)
{
    localIndex = m.VertOffset + localIndex;

    if (MeshInfo.IndexSize == 4)
    {
        return UniqueVertexIndices.Load(localIndex * 4);
    }
    else // Global vertex index width is 16-bit
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

uint3 GetPrimitive(Meshlet m, uint index)
{
    return UnpackPrimitive(PrimitiveIndices[m.PrimOffset + index]);
}

VertexOut GetVertexAttributes(uint meshletIndex, uint vertexIndex)
{
    Vertex v;
    v.Position = asfloat(Vertices.Load3(vertexIndex * 24));
    v.Normal = asfloat(Vertices.Load3(vertexIndex * 24 + 12));

    float4 positionWS = mul(float4(v.Position, 1), Instance.World);

    VertexOut vout;
    vout.PositionVS   = mul(positionWS, Constants.View).xyz;
    vout.PositionHS   = mul(positionWS, Constants.ViewProj);
    vout.Normal       = mul(float4(v.Normal, 0), Instance.WorldInvTrans).xyz;
    vout.MeshletIndex = meshletIndex;

    return vout;
}

[NumThreads(128, 1, 1)]
[OutputTopology("triangle")]
void main_ms(
    uint dtid : SV_DispatchThreadID,
    uint gtid : SV_GroupThreadID,
    uint gid : SV_GroupID,
    in payload Payload payload,
    out vertices VertexOut verts[64],
    out indices uint3 tris[126]
)
{
    // Load the meshlet from the AS payload data
    uint meshletIndex = payload.MeshletIndices[gid];

    // Catch any out-of-range indices (in case too many MS threadgroups were dispatched from AS)
    if (meshletIndex >= MeshInfo.MeshletCount)
        return;

    // Load the meshlet
    Meshlet m = Meshlets[meshletIndex];

    // Our vertex and primitive counts come directly from the meshlet
    SetMeshOutputCounts(m.VertCount, m.PrimCount);

    //--------------------------------------------------------------------
    // Export Primitive & Vertex Data

    if (gtid < m.VertCount)
    {
        uint vertexIndex = GetVertexIndex(m, gtid);
        verts[gtid] = GetVertexAttributes(meshletIndex, vertexIndex);
    }

    if (gtid < m.PrimCount)
    {
        tris[gtid] = GetPrimitive(m, gtid);
    }
}


/////
// Pixel shader

float3 Luminosity(float3 color)
{
    return dot(color, float3(0.2126, 0.7152, 0.0722)).xxx;
}

float4 main_ps(VertexOut pin) : SV_TARGET
{
    float ambientIntensity = 0.1;
    float3 lightColor = float3(1, 1, 1);
    float3 lightDir = -normalize(float3(1, -1, 1));

    float3 color = 0.8;
    float shininess = 16;

    // Per-meshlet color shading
    if (Constants.DrawMeshlets && (Instance.Flags & MESHLET_FLAG) != 0)
    {
        color = float3(
            float(pin.MeshletIndex & 1),
            float(pin.MeshletIndex & 3) / 4,
            float(pin.MeshletIndex & 7) / 8
        );

        // When the user has cursored over a meshlet or has selected one, desaturate every other meshlet.
        if (Constants.HighlightedIndex != -1 ||
            Constants.SelectedIndex != -1)
        {
            // A meshlet is highlighted or selected
            if (pin.MeshletIndex != Constants.SelectedIndex &&
                pin.MeshletIndex != Constants.HighlightedIndex)
            {
                // This meshlet is not highlighted - desaturate its color.
                color = lerp(color, Luminosity(color) + 0.2, 0.8);
            }
        }
    }

    float3 normal = normalize(pin.Normal);

    // Do some fancy Blinn-Phong shading!
    float cosAngle   = saturate(dot(normal, lightDir));
    float3 viewDir   = -normalize(pin.PositionVS);
    float3 halfAngle = normalize(lightDir + viewDir);

    float blinnTerm = saturate(dot(normal, halfAngle));
    blinnTerm = cosAngle != 0.0 ? blinnTerm : 0.0;
    blinnTerm = pow(blinnTerm, shininess);

    float3 finalColor = (cosAngle + blinnTerm + ambientIntensity) * color;

    return float4(finalColor, 1);
}

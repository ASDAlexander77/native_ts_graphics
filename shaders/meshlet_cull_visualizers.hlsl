// DirectX-Graphics-Samples' D3D12MeshShaders MeshletCull visualizers (FrustumMS.hlsl,
// BoundingSphereMS.hlsl, NormalConeMS.hlsl, DebugDrawPS.hlsl, VisualizerCommon.hlsli): the culling
// camera's frustum as lines from its planes' intersections, and a meshlet's bounding sphere (a disc
// facing the camera) and normal cone (a UV hemisphere of lines), all made by mesh shaders. The
// culling data is a ByteAddressBuffer of the file's records, as in meshlet_cull.hlsl; the
// visualizers' root constants (b1) are push constants.
//
// Copyright (c) Microsoft. All rights reserved.
// This code is licensed under the MIT License (MIT).

#include <donut/shaders/binding_helpers.hlsli>

struct DebugVertex
{
    float4 Color    : COLOR0;
    float4 Position : SV_POSITION;
};

float3 RotateVector(float3 v0, float3 axis, float angle)
{
    float cs = cos(angle);
    return cs * v0 + sin(angle) * cross(axis, v0) + (1 - cs) * dot(axis, v0) * axis;
}


/////
// Frustum

#define PLANE_LEFT 0
#define PLANE_RIGHT 1
#define PLANE_BOTTOM 2
#define PLANE_TOP 3
#define PLANE_NEAR 4
#define PLANE_FAR 5

static const uint3 IntersectionIndices[8] =
{
    uint3(PLANE_LEFT, PLANE_FAR, PLANE_BOTTOM),
    uint3(PLANE_RIGHT, PLANE_FAR, PLANE_BOTTOM),
    uint3(PLANE_RIGHT, PLANE_NEAR, PLANE_BOTTOM),
    uint3(PLANE_LEFT, PLANE_NEAR, PLANE_BOTTOM),

    uint3(PLANE_LEFT, PLANE_FAR, PLANE_TOP),
    uint3(PLANE_RIGHT, PLANE_FAR, PLANE_TOP),
    uint3(PLANE_RIGHT, PLANE_NEAR, PLANE_TOP),
    uint3(PLANE_LEFT, PLANE_NEAR, PLANE_TOP),
};

static const uint2 FrustumLineIndices[12] =
{
    uint2(0, 1), uint2(1, 2), uint2(2, 3), uint2(3, 0),
    uint2(4, 5), uint2(5, 6), uint2(6, 7), uint2(7, 4),
    uint2(0, 4), uint2(1, 5), uint2(2, 6), uint2(3, 7),
};

float3 IntersectPlanes(float4 p0, float4 p1, float4 p2)
{
    float3 n12 = cross(p1.xyz, p2.xyz);
    float3 n20 = cross(p2.xyz, p0.xyz);
    float3 n01 = cross(p0.xyz, p1.xyz);

    float3 r = -p0.w * n12 - p1.w * n20 - p2.w * n01;
    return r * (1 / dot(p0.xyz, n12));
}

struct FrustumConstants
{
    float4x4 ViewProj;
    float4   Planes[6];
    float4   LineColor;
};

ConstantBuffer<FrustumConstants> FrustumGlobals : register(b0);

[NumThreads(32, 1, 1)]
[OutputTopology("line")]
void frustum_ms(
    uint gtid : SV_GroupThreadID,
    out vertices DebugVertex verts[8],
    out indices uint2 prims[12]
)
{
    SetMeshOutputCounts(8, 12);

    if (gtid < 8)
    {
        uint3 p = IntersectionIndices[gtid];
        float3 position = IntersectPlanes(FrustumGlobals.Planes[p.x], FrustumGlobals.Planes[p.y], FrustumGlobals.Planes[p.z]);

        DebugVertex v = (DebugVertex)0;
        v.Position = mul(float4(position, 1), FrustumGlobals.ViewProj);
        v.Color = FrustumGlobals.LineColor;

        verts[gtid] = v;
    }

    if (gtid < 12)
    {
        prims[gtid] = FrustumLineIndices[gtid];
    }
}


/////
// Culling data: bounding spheres and normal cones

struct CullData
{
    float4 BoundingSphere;
    uint   NormalCone;
    float  ApexOffset;
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

struct CullDataConstants
{
    float4x4 World;
    float4x4 ViewProj;
    float4   Color;
    float3   ViewUp;
    float3   ViewForward;
    float    Scale;
};

struct Options
{
    uint MeshletOffset;
    uint MeshletCount;
};

ConstantBuffer<CullDataConstants> CullGlobals : register(b0);
DECLARE_PUSH_CONSTANTS(Options, g_Options, 1, 0);
ByteAddressBuffer MeshletCullData : register(t0);

CullData LoadCullData(uint index)
{
    CullData c;
    c.BoundingSphere = asfloat(MeshletCullData.Load4(index * 24));
    c.NormalCone = MeshletCullData.Load(index * 24 + 16);
    c.ApexOffset = asfloat(MeshletCullData.Load(index * 24 + 20));
    return c;
}

#define GROUP_SIZE 128
#define BASE_COUNT GROUP_SIZE - 1

[NumThreads(GROUP_SIZE, 1, 1)]
[OutputTopology("triangle")]
void sphere_ms(
    uint gtid : SV_GroupThreadID,
    uint gid : SV_GroupID,
    out vertices DebugVertex verts[GROUP_SIZE],
    out indices uint3 prims[GROUP_SIZE]
)
{
    // Ensure not too many threadgroups were dispatched.
    if (gid >= g_Options.MeshletCount)
        return;

    CullData c = LoadCullData(g_Options.MeshletOffset + gid);

    uint vertCount = BASE_COUNT;
    uint primCount = BASE_COUNT - 1;

    SetMeshOutputCounts(vertCount, primCount);

    //--------------------------------------------------------------------
    // Export Primitive & Vertex Data

    // Vertex positions are procedurally generated
    if (gtid < vertCount)
    {
        float4 position = mul(float4(c.BoundingSphere.xyz, 1), CullGlobals.World);

        if (gtid != 0)
        {
            uint index = gtid - 1;

            // Rotate scaled vector about camera forward vector by some angle
            float angle = (float(index) / primCount) * 2.0 * 3.1415926;
            float3 offset = RotateVector(CullGlobals.ViewUp, -CullGlobals.ViewForward, angle) * c.BoundingSphere.w * CullGlobals.Scale;

            // Offset centerpoint by the rotated vector.
            position += float4(offset, 0);
        }

        DebugVertex v = (DebugVertex)0;
        v.Position = mul(position, CullGlobals.ViewProj);
        v.Color = CullGlobals.Color;

        verts[gtid] = v;
    }

    // Primitive indices are determined by geometric definition
    if (gtid < primCount)
    {
        uint i0 = 0;
        uint i1 = gtid % primCount + 1;
        uint i2 = (gtid + 1) % primCount + 1;

        prims[gtid] = uint3(i0, i1, i2);
    }
}

[NumThreads(GROUP_SIZE, 1, 1)]
[OutputTopology("line")]
void cone_ms(
    uint gtid : SV_GroupThreadID,
    uint gid : SV_GroupID,
    out vertices DebugVertex verts[GROUP_SIZE],
    out indices uint2 prims[GROUP_SIZE]
)
{
    // Ensure not too many threadgroups were dispatched.
    if (gid >= g_Options.MeshletCount)
        return;

    CullData c = LoadCullData(g_Options.MeshletOffset + gid);

    // Creating half a UV sphere - a UV hemisphere, if you will.
    const uint n = 14;
    const uint m = 8;

    uint vertCount = n * m + 2;
    uint primCount = n * (m + 1);

    if (IsConeDegenerate(c)) // Degenerate cone
    {
        vertCount = 0;
        primCount = 0;
    }

    SetMeshOutputCounts(vertCount, primCount);

    // Procedurally generate some vertices in the shape of a cone or hemisphere (degenerate cone).
    if (gtid < vertCount)
    {
        float3 center = mul(float4(c.BoundingSphere.xyz, 1), CullGlobals.World).xyz; // Center point of cone
        float3 axis;                                                                 // Central orientational axis
        float angle;                                                                 // Half pi for sphere; angular spread of normal cone.
        float radius = c.BoundingSphere.w * CullGlobals.Scale;                       // Radius of bounding sphere

        float4 normalCone = UnpackCone(c.NormalCone);
        float apexOffset = c.ApexOffset * CullGlobals.Scale;

        axis = normalize(mul(float4(normalCone.xyz, 0), CullGlobals.World)).xyz;
        angle = acos(-normalCone.w) - (3.1415926 / 2); // Angle is stored as -cos(a + 90) to optimize for cull-tests.

        radius += apexOffset;

        float3 pointWS; // Final output position in world-space.

        if (gtid < n * m) // The rings of vertices which compose the UV squares around the hemisphere.
        {
            uint i = gtid % n;
            uint j = gtid / n;

            float3 up = float3(0, 1, 0); // Arbitrary reference vector
            float3 u = normalize(up - dot(axis, up) * axis); // Calculate some orthogonal unit vector

            u = RotateVector(u, axis, i * (3.1415926 * 2) / n);       // Rotate vector about axis by proper theta
            float3 w = RotateVector(axis, u, (m - j) * angle / m); // Rotate axis about vector to get proper phi (angle away from axis.)

            pointWS = center + w;
        }
        else if (gtid < n * m + 1) // Top center point
        {
            pointWS = center + axis;
        }
        else // Bottom center point
        {
            pointWS = center;
        }

        DebugVertex v;
        v.Position = mul(float4(pointWS, 1), CullGlobals.ViewProj);
        v.Color = CullGlobals.Color;

        verts[gtid] = v;
    }

    // Procedurally generate primitives from the submitted vertices.
    if (gtid < primCount)
    {
        uint2 indices = uint2(0, 0);

        if (gtid < n)
        {
            uint i = gtid % n;
            indices = uint2(i, (i + 1) % n);
        }
        else if (gtid < n * (m - 1))
        {
            uint i = gtid % n;
            uint j = gtid / n - 1;
            indices = uint2(j * n + i, n * (j + 1) + i);
        }
        else if (gtid < n * m)
        {
            uint i = gtid % n;
            uint j = gtid / n - 1;
            indices = uint2(j * n + i, vertCount - 2);
        }
        else
        {
            uint i = gtid % n;
            indices = uint2(i, vertCount - 1);
        }

        prims[gtid] = indices;
    }
}

float4 debug_ps(DebugVertex vin) : SV_TARGET
{
    return vin.Color;
}

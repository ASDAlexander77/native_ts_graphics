// DirectXMath's collision types for TypeScript (the examples that list it link it; see
// CMakeLists.txt): BoundingSphere, BoundingBox, BoundingOrientedBox, BoundingFrustum and
// TriangleTests, as the Xbox ATG Collision sample uses them. Shapes are passed as floats (see
// CollisionShape in donut_interop.d.ts). Also the DirectXMath rotations the sample animates them
// with, so the TypeScript side computes what the sample does. Functions of no Donut object, so
// donut.ts doesn't wrap them and other examples don't link them.

#include <DirectXCollision.h>
#include <DirectXMath.h>

using namespace DirectX;

namespace
{
    // CollisionShape (donut_interop.d.ts).
    enum Shape
    {
        Shape_Sphere = 0,        // center (3), radius
        Shape_Box = 1,           // center (3), extents (3)
        Shape_OrientedBox = 2,   // center (3), extents (3), orientation (quaternion x, y, z, w)
        Shape_Frustum = 3,       // origin (3), orientation (4), right, left, top, bottom slopes, near, far
        Shape_Triangle = 4,      // three points (3 each)
    };

    BoundingSphere ToSphere(const float* f)
    {
        return BoundingSphere(XMFLOAT3(f[0], f[1], f[2]), f[3]);
    }

    BoundingBox ToBox(const float* f)
    {
        return BoundingBox(XMFLOAT3(f[0], f[1], f[2]), XMFLOAT3(f[3], f[4], f[5]));
    }

    BoundingOrientedBox ToOrientedBox(const float* f)
    {
        return BoundingOrientedBox(XMFLOAT3(f[0], f[1], f[2]), XMFLOAT3(f[3], f[4], f[5]), XMFLOAT4(f[6], f[7], f[8], f[9]));
    }

    BoundingFrustum ToFrustum(const float* f)
    {
        return BoundingFrustum(XMFLOAT3(f[0], f[1], f[2]), XMFLOAT4(f[3], f[4], f[5], f[6]), f[7], f[8], f[9], f[10], f[11], f[12]);
    }

    XMVECTOR Point(const float* f, int index)
    {
        return XMVectorSet(f[index * 3], f[index * 3 + 1], f[index * 3 + 2], 0.f);
    }

    // container.Contains(shape) for each container type.
    template<typename Container>
    int Contains(const Container& container, int shape, const float* s)
    {
        switch (shape)
        {
        case Shape_Sphere: return container.Contains(ToSphere(s));
        case Shape_Box: return container.Contains(ToBox(s));
        case Shape_OrientedBox: return container.Contains(ToOrientedBox(s));
        case Shape_Frustum: return container.Contains(ToFrustum(s));
        case Shape_Triangle: return container.Contains(Point(s, 0), Point(s, 1), Point(s, 2));
        default: return DISJOINT;
        }
    }
}

extern "C"
{
    // container.Contains(shape): a ContainmentType (0 disjoint, 1 intersects, 2 contains).
    // Containers are spheres, boxes, oriented boxes and frustums.
    int Donut_CollisionContains(int containerShape, const float* container, int shape, const float* s)
    {
        switch (containerShape)
        {
        case Shape_Sphere: return Contains(ToSphere(container), shape, s);
        case Shape_Box: return Contains(ToBox(container), shape, s);
        case Shape_OrientedBox: return Contains(ToOrientedBox(container), shape, s);
        case Shape_Frustum: return Contains(ToFrustum(container), shape, s);
        default: return DISJOINT;
        }
    }

    // shape.Intersects(origin, direction, distance) (TriangleTests::Intersects for triangles):
    // non-zero on a hit, with the distance along the (normalized) direction.
    int Donut_CollisionIntersectsRay(int shape, const float* s, const float* rayOrigin, const float* rayDirection, float* distance)
    {
        const XMVECTOR origin = XMVectorSet(rayOrigin[0], rayOrigin[1], rayOrigin[2], 0.f);
        const XMVECTOR direction = XMVectorSet(rayDirection[0], rayDirection[1], rayDirection[2], 0.f);
        float dist = 0.f;
        bool hit = false;
        switch (shape)
        {
        case Shape_Sphere: hit = ToSphere(s).Intersects(origin, direction, dist); break;
        case Shape_Box: hit = ToBox(s).Intersects(origin, direction, dist); break;
        case Shape_OrientedBox: hit = ToOrientedBox(s).Intersects(origin, direction, dist); break;
        case Shape_Frustum: hit = ToFrustum(s).Intersects(origin, direction, dist); break;
        case Shape_Triangle: hit = TriangleTests::Intersects(origin, direction, Point(s, 0), Point(s, 1), Point(s, 2), dist); break;
        default: break;
        }
        *distance = dist;
        return hit ? 1 : 0;
    }

    // BoundingFrustum::CreateFromMatrix of a projection matrix (16 floats, DirectXMath's row-major
    // layout) into frustum (13 floats).
    void Donut_CollisionFrustumFromMatrix(const float* projection, float* frustum)
    {
        BoundingFrustum result;
        BoundingFrustum::CreateFromMatrix(result, XMMATRIX(projection));
        const float values[13] = { result.Origin.x, result.Origin.y, result.Origin.z,
            result.Orientation.x, result.Orientation.y, result.Orientation.z, result.Orientation.w,
            result.RightSlope, result.LeftSlope, result.TopSlope, result.BottomSlope, result.Near, result.Far };
        for (int i = 0; i < 13; ++i)
            frustum[i] = values[i];
    }

    // BoundingFrustum::GetCorners: 8 points (24 floats), the near plane's then the far plane's.
    void Donut_CollisionFrustumCorners(const float* frustum, float* corners)
    {
        ToFrustum(frustum).GetCorners(reinterpret_cast<XMFLOAT3*>(corners));
    }

    // XMQuaternionRotationRollPitchYaw (x, y, z, w). TypeScript numbers come as doubles; the angles
    // are the sample's floats.
    void Donut_QuaternionRotationRollPitchYaw(double pitch, double yaw, double roll, float* quaternion)
    {
        XMStoreFloat4(reinterpret_cast<XMFLOAT4*>(quaternion), XMQuaternionRotationRollPitchYaw(float(pitch), float(yaw), float(roll)));
    }

    // XMMatrixRotationRollPitchYaw (16 floats, row-major).
    void Donut_MatrixRotationRollPitchYaw(double pitch, double yaw, double roll, float* matrix)
    {
        XMStoreFloat4x4(reinterpret_cast<XMFLOAT4X4*>(matrix), XMMatrixRotationRollPitchYaw(float(pitch), float(yaw), float(roll)));
    }
}

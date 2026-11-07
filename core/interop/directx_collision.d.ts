/// <reference path="../donut_handles.d.ts" />
// DirectXMath's collision types (core/directx_collision.cpp, linked only into the examples that
// use it)

// DirectXMath's collision types (core/directx_collision.cpp, linked only into the examples that
// list it), shapes passed as floats: CollisionShape says which, and how many.
enum CollisionShape {
    // Center (3), radius.
    Sphere = 0,
    // Axis-aligned: center (3), extents (3).
    Box = 1,
    // Center (3), extents (3), orientation (quaternion x, y, z, w).
    OrientedBox = 2,
    // Origin (3), orientation (4), right, left, top and bottom slopes, near and far distances.
    Frustum = 3,
    // Three points (3 floats each).
    Triangle = 4
}

// ContainmentType values.
enum Containment {
    Disjoint = 0,
    Intersects = 1,
    Contains = 2
}

// container.Contains(shape), a Containment; containers are spheres, boxes, oriented boxes and
// frustums.
@nodrops declare function Donut_CollisionContains(containerShape: CollisionShape, container: Ref<f32>, shape: CollisionShape, s: Ref<f32>): Containment;
// shape.Intersects(rayOrigin, rayDirection, distance) (TriangleTests::Intersects for triangles):
// non-zero on a hit, with the distance along the (normalized) direction written to distance.
@nodrops declare function Donut_CollisionIntersectsRay(shape: CollisionShape, s: Ref<f32>, rayOrigin: Ref<f32>, rayDirection: Ref<f32>, distance: Ref<f32>): int;
// BoundingFrustum::CreateFromMatrix of a projection matrix (16 floats, DirectXMath's row-major
// layout) into frustum (13 floats).
@nodrops declare function Donut_CollisionFrustumFromMatrix(projection: Ref<f32>, frustum: Ref<f32>): void;
// BoundingFrustum::GetCorners: 8 points (24 floats), the near plane's then the far plane's.
@nodrops declare function Donut_CollisionFrustumCorners(frustum: Ref<f32>, corners: Ref<f32>): void;
// XMQuaternionRotationRollPitchYaw into quaternion (x, y, z, w).
@nodrops declare function Donut_QuaternionRotationRollPitchYaw(pitch: number, yaw: number, roll: number, quaternion: Ref<f32>): void;
// XMMatrixRotationRollPitchYaw into matrix (16 floats, row-major).
@nodrops declare function Donut_MatrixRotationRollPitchYaw(pitch: number, yaw: number, roll: number, matrix: Ref<f32>): void;

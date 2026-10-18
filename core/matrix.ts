// The 4 x 4 matrix and 3-vector helpers the examples share. A matrix is number[16] in glm's layout,
// by columns (element [column * 4 + row]), for column vectors; the ones named after Donut's
// (perspProj*) and DirectXMath's (inverse, rotationY) functions take them row-major for row
// vectors as those do, which is the same 16 numbers. The glm ones compute in doubles as glm does;
// the Donut and DirectXMath ones round to float32 where those do, so their results match the
// originals bit for bit.
//
// Imported with `import { multiply, ... } from "../core/matrix";` (from examples/), and listed in the
// example's add_tslang_example sources.

// The identity matrix.
export function identity() {
    return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
}

// a * b.
export function multiply(a: number[], b: number[]) {
    const result: number[] = [];
    for (let column = 0; column < 4; column++) {
        for (let row = 0; row < 4; row++) {
            let sum = 0.0;
            for (let k = 0; k < 4; k++) {
                sum += a[k * 4 + row] * b[column * 4 + k];
            }
            result.push(sum);
        }
    }
    return result;
}

// glm::rotate(m, angle, axis) for a unit axis.
export function rotate(m: number[], angle: number, x: number, y: number, z: number) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1.0 - c;
    const r = [
        c + t * x * x,     t * x * y + s * z, t * x * z - s * y, 0.0,
        t * x * y - s * z, c + t * y * y,     t * y * z + s * x, 0.0,
        t * x * z + s * y, t * y * z - s * x, c + t * z * z,     0.0,
        0.0,               0.0,               0.0,               1.0,
    ];
    return multiply(m, r);
}

// glm::rotate(mat4(1), angle, axis) about a unit axis.
export function rotation(angle: number, x: number, y: number, z: number) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1.0 - c;
    return [
        c + t * x * x,     t * x * y + s * z, t * x * z - s * y, 0.0,
        t * x * y - s * z, c + t * y * y,     t * y * z + s * x, 0.0,
        t * x * z + s * y, t * y * z - s * x, c + t * z * z,     0.0,
        0.0,               0.0,               0.0,               1.0,
    ];
}

// XMMatrixRotationY.
export function rotationY(angle: number) {
    const s = Math.fround(Math.sin(angle));
    const c = Math.fround(Math.cos(angle));
    return [c, 0.0, -s, 0.0, 0.0, 1.0, 0.0, 0.0, s, 0.0, c, 0.0, 0.0, 0.0, 0.0, 1.0];
}

// glm::translate(mat4(1), (x, y, z)).
export function translation(x: number, y: number, z: number) {
    return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, y, z, 1.0];
}

// glm::scale(mat4(1), (x, y, z)).
export function scale(x: number, y: number, z: number) {
    return [x, 0.0, 0.0, 0.0, 0.0, y, 0.0, 0.0, 0.0, 0.0, z, 0.0, 0.0, 0.0, 0.0, 1.0];
}

// glm::transpose.
export function transpose(a: number[]) {
    const m: number[] = [];
    for (let row = 0; row < 4; row++) {
        for (let column = 0; column < 4; column++) {
            m.push(a[column * 4 + row]);
        }
    }
    return m;
}

// XMMatrixInverse (by cofactors, in doubles, the result rounded to float32).
export function inverse(m: number[]) {
    const a00 = m[0]; const a01 = m[1]; const a02 = m[2]; const a03 = m[3];
    const a10 = m[4]; const a11 = m[5]; const a12 = m[6]; const a13 = m[7];
    const a20 = m[8]; const a21 = m[9]; const a22 = m[10]; const a23 = m[11];
    const a30 = m[12]; const a31 = m[13]; const a32 = m[14]; const a33 = m[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    const invDet = 1.0 / det;
    return [
        Math.fround((a11 * b11 - a12 * b10 + a13 * b09) * invDet),
        Math.fround((a02 * b10 - a01 * b11 - a03 * b09) * invDet),
        Math.fround((a31 * b05 - a32 * b04 + a33 * b03) * invDet),
        Math.fround((a22 * b04 - a21 * b05 - a23 * b03) * invDet),
        Math.fround((a12 * b08 - a10 * b11 - a13 * b07) * invDet),
        Math.fround((a00 * b11 - a02 * b08 + a03 * b07) * invDet),
        Math.fround((a32 * b02 - a30 * b05 - a33 * b01) * invDet),
        Math.fround((a20 * b05 - a22 * b02 + a23 * b01) * invDet),
        Math.fround((a10 * b10 - a11 * b08 + a13 * b06) * invDet),
        Math.fround((a01 * b08 - a00 * b10 - a03 * b06) * invDet),
        Math.fround((a30 * b04 - a31 * b02 + a33 * b00) * invDet),
        Math.fround((a21 * b02 - a20 * b04 - a23 * b00) * invDet),
        Math.fround((a11 * b07 - a10 * b09 - a12 * b06) * invDet),
        Math.fround((a00 * b09 - a01 * b07 + a02 * b06) * invDet),
        Math.fround((a31 * b01 - a30 * b03 - a32 * b00) * invDet),
        Math.fround((a20 * b03 - a21 * b01 + a22 * b00) * invDet),
    ];
}

// The inverse of a rotation and translation [R t]: [R^T -R^T t].
export function inverseRigid(m: number[]) {
    const result = identity();
    for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 3; column++) {
            result[column * 4 + row] = m[row * 4 + column];
        }
    }
    for (let row = 0; row < 3; row++) {
        let t = 0.0;
        for (let k = 0; k < 3; k++) {
            t -= m[row * 4 + k] * m[12 + k];
        }
        result[12 + row] = t;
    }
    return result;
}

// glm::radians(float) (and Donut's math::radians): in float32, as the samples that use it compute
// every angle.
export function radiansF32(degrees: number) {
    return Math.fround(Math.fround(degrees) * Math.fround(Math.PI / 180.0));
}

// a * b for row-major matrices (row vectors, as DirectXMath and Donut take them), each element
// rounded to float32.
export function multiplyF32(a: number[], b: number[]) {
    const m: number[] = [];
    for (let row = 0; row < 4; row++) {
        for (let column = 0; column < 4; column++) {
            let sum = 0.0;
            for (let k = 0; k < 4; k++) {
                sum += a[row * 4 + k] * b[k * 4 + column];
            }
            m.push(Math.fround(sum));
        }
    }
    return m;
}

// The inverse of m, by Gauss-Jordan elimination with partial pivoting (in doubles).
export function inverseGaussJordan(m: number[]) {
    // Rows of [m | I].
    const a: number[] = [];
    for (let row = 0; row < 4; row++) {
        for (let column = 0; column < 4; column++) {
            a.push(m[column * 4 + row]);
        }
        for (let column = 0; column < 4; column++) {
            a.push(row == column ? 1.0 : 0.0);
        }
    }
    for (let column = 0; column < 4; column++) {
        let pivot = column;
        for (let row = column + 1; row < 4; row++) {
            if (Math.abs(a[row * 8 + column]) > Math.abs(a[pivot * 8 + column])) {
                pivot = row;
            }
        }
        for (let k = 0; k < 8; k++) {
            const t = a[column * 8 + k];
            a[column * 8 + k] = a[pivot * 8 + k];
            a[pivot * 8 + k] = t;
        }
        const p = a[column * 8 + column];
        for (let k = 0; k < 8; k++) {
            a[column * 8 + k] /= p;
        }
        for (let row = 0; row < 4; row++) {
            if (row != column) {
                const f = a[row * 8 + column];
                for (let k = 0; k < 8; k++) {
                    a[row * 8 + k] -= f * a[column * 8 + k];
                }
            }
        }
    }
    const result: number[] = [];
    for (let column = 0; column < 4; column++) {
        for (let row = 0; row < 4; row++) {
            result.push(a[row * 8 + 4 + column]);
        }
    }
    return result;
}

// glm::radians.
export function radians(degrees: number) {
    return degrees * Math.PI / 180.0;
}

// glm::perspective(fov, aspect, near, far) (right-handed, depth from 0 to 1).
export function perspective(fov: number, aspect: number, zNear: number, zFar: number) {
    const tanHalfFovy = Math.tan(0.5 * fov);
    return [
        1.0 / (aspect * tanHalfFovy), 0.0,               0.0,                              0.0,
        0.0,                          1.0 / tanHalfFovy, 0.0,                              0.0,
        0.0,                          0.0,               zFar / (zNear - zFar),            -1.0,
        0.0,                          0.0,               -(zFar * zNear) / (zFar - zNear), 0.0,
    ];
}

// glm::perspective(fov, aspect, near, far) (right-handed, depth from 0 to 1), with clip y
// negated: from Vulkan-Samples' clip space (y down on the screen) into Donut's (y up).
export function samplePerspective(fov: number, aspect: number, zNear: number, zFar: number) {
    const tanHalfFovy = Math.tan(0.5 * fov);
    return [
        1.0 / (aspect * tanHalfFovy), 0.0,                0.0,                              0.0,
        0.0,                          -1.0 / tanHalfFovy, 0.0,                              0.0,
        0.0,                          0.0,                zFar / (zNear - zFar),            -1.0,
        0.0,                          0.0,                -(zFar * zNear) / (zFar - zNear), 0.0,
    ];
}

// Vulkan-Samples' PerspectiveCamera::get_projection, glm::perspective(fov, aspect, far, near)
// (near and far swapped for reversed depth; right-handed, depth from 0 to 1).
export function reversedPerspective(fov: number, aspect: number, zNear: number, zFar: number) {
    const tanHalfFovy = Math.tan(0.5 * fov);
    const n = zFar;
    const f = zNear;
    return [
        1.0 / (aspect * tanHalfFovy), 0.0,               0.0,                0.0,
        0.0,                          1.0 / tanHalfFovy, 0.0,                0.0,
        0.0,                          0.0,               f / (n - f),        -1.0,
        0.0,                          0.0,               -(f * n) / (f - n), 0.0,
    ];
}

// Vulkan-Samples' vulkan_style_projection: [1][1] negated (only that element), for Vulkan's
// clip space, y down on the screen.
export function vulkanStyleProjection(m: number[]) {
    const result: number[] = [];
    for (let i = 0; i < 16; i++) {
        result.push(i == 5 ? -m[i] : m[i]);
    }
    return result;
}

// A matrix into Vulkan's clip space (y down on the screen), into Donut's (y up): clip y negated,
// so the pictures (and shadow map texels) land where a Vulkan sample's do.
export function toDonutClip(m: number[]) {
    let result: number[] = [];
    for (let i = 0; i < 16; i++) {
        result.push(i % 4 == 1 ? -m[i] : m[i]);
    }
    return result;
}

// math::perspProjD3DStyle(verticalFOV, aspect, zNear, zFar).
// In float32 as Donut's (computed in double, the terms differ in the last bit, which moves
// edges by a pixel here and there).
export function perspProjD3DStyle(verticalFOV: number, aspect: number, zNear: number, zFar: number) {
    const near = Math.fround(zNear);
    const far = Math.fround(zFar);
    const yScale = Math.fround(1.0 / Math.fround(Math.tan(Math.fround(0.5 * Math.fround(verticalFOV)))));
    const xScale = Math.fround(yScale / Math.fround(aspect));
    const zScale = Math.fround(1.0 / Math.fround(far - near));
    return [
        xScale, 0.0,    0.0,                                         0.0,
        0.0,    yScale, 0.0,                                         0.0,
        0.0,    0.0,    Math.fround(far * zScale),                   1.0,
        0.0,    0.0,    Math.fround(Math.fround(-near * far) * zScale), 0.0,
    ];
}

// math::perspProjD3DStyleReverse(verticalFOV, aspect, zNear): reverse Z, infinite far plane.
// In float32 as Donut's (computed in double, the scales differ in the last bit, which moves
// edges by a pixel here and there).
export function perspProjD3DStyleReverse(verticalFOV: number, aspect: number, zNear: number) {
    const yScale = Math.fround(1.0 / Math.fround(Math.tan(Math.fround(0.5 * Math.fround(verticalFOV)))));
    const xScale = Math.fround(yScale / Math.fround(aspect));
    return [
        xScale, 0.0,    0.0,   0.0,
        0.0,    yScale, 0.0,   0.0,
        0.0,    0.0,    0.0,   1.0,
        0.0,    0.0,    zNear, 0.0,
    ];
}

// A reversed-depth perspective (near at depth 1, far at 0) in Donut's conventions (view space z
// forward), for Donut's camera. In float32, in glm's order of operations.
export function perspProjReverse(verticalFOV: number, aspect: number, zNear: number, zFar: number) {
    const near = Math.fround(zNear);
    const far = Math.fround(zFar);
    const tanHalfFovy = Math.fround(Math.tan(Math.fround(Math.fround(verticalFOV) / 2.0)));
    const xScale = Math.fround(1.0 / Math.fround(Math.fround(aspect) * tanHalfFovy));
    const yScale = Math.fround(1.0 / tanHalfFovy);
    const depthRange = Math.fround(far - near);
    return [
        xScale, 0.0,    0.0,                                            0.0,
        0.0,    yScale, 0.0,                                            0.0,
        0.0,    0.0,    -Math.fround(near / depthRange),                1.0,
        0.0,    0.0,    Math.fround(Math.fround(far * near) / depthRange), 0.0,
    ];
}

// The cross product of two 3-vectors.
export function cross3(a: number[], b: number[]) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// The dot product of two 3-vectors.
export function dot3(a: number[], b: number[]) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// v / |v| for a 3-vector.
export function normalize3(v: number[]) {
    const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return [v[0] / length, v[1] / length, v[2] / length];
}

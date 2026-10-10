// DirectXMath's math as its SSE2 code computes it (Windows SDK 10.0.28000), in float after every
// operation, for ports of samples whose results depend on it to the last bit: samples whose rays
// start from the camera and aim at a near plane close to it (DirectX-Graphics-Samples' ray
// tracing ones) turn the tiniest difference in their projectionToWorld into moved checker lines
// and shadows. Checked bit for bit against D3D12RaytracingProceduralGeometry's constants.
//
// Vectors are 4 numbers; matrices 16, row-major for row vectors (XMMATRIX: v' = v * M).
//
// Imported with `import { ... } from "../core/directx_math";` (from examples/), its object listed
// in the example's add_tslang_example sources. It references nothing else.

export function vmul(a: number[], b: number[]): number[] {
    return [Math.fround(a[0] * b[0]), Math.fround(a[1] * b[1]), Math.fround(a[2] * b[2]), Math.fround(a[3] * b[3])];
}

export function vadd(a: number[], b: number[]): number[] {
    return [Math.fround(a[0] + b[0]), Math.fround(a[1] + b[1]), Math.fround(a[2] + b[2]), Math.fround(a[3] + b[3])];
}

export function vsub(a: number[], b: number[]): number[] {
    return [Math.fround(a[0] - b[0]), Math.fround(a[1] - b[1]), Math.fround(a[2] - b[2]), Math.fround(a[3] - b[3])];
}

export function vdiv(a: number[], b: number[]): number[] {
    return [Math.fround(a[0] / b[0]), Math.fround(a[1] / b[1]), Math.fround(a[2] / b[2]), Math.fround(a[3] / b[3])];
}

// XM_FNMADD_PS without FMA: c - a * b.
export function vfnmadd(a: number[], b: number[], c: number[]): number[] {
    return vsub(c, vmul(a, b));
}

// _mm_shuffle_ps(a, b, _MM_SHUFFLE(d, c, bb, aa)).
export function shuffle(a: number[], b: number[], d: int, c: int, bb: int, aa: int): number[] {
    return [a[aa], a[bb], b[c], b[d]];
}

// XM_PERMUTE_PS(a, _MM_SHUFFLE(d, c, bb, aa)).
export function permute(a: number[], d: int, c: int, bb: int, aa: int): number[] {
    return [a[aa], a[bb], a[c], a[d]];
}

export function splat(a: number[], i: int): number[] {
    return [a[i], a[i], a[i], a[i]];
}

export function row(m: number[], r: int): number[] {
    return [m[r * 4], m[r * 4 + 1], m[r * 4 + 2], m[r * 4 + 3]];
}

export function fromRows(r0: number[], r1: number[], r2: number[], r3: number[]): number[] {
    return [r0[0], r0[1], r0[2], r0[3], r1[0], r1[1], r1[2], r1[3], r2[0], r2[1], r2[2], r2[3], r3[0], r3[1], r3[2], r3[3]];
}

// XMVector3Dot's x.
export function dot3(a: number[], b: number[]): number {
    const d = vmul(a, b);
    return Math.fround(Math.fround(d[0] + d[1]) + d[2]);
}

// XMVector4Dot's x.
export function dot4(a: number[], b: number[]): number {
    let t = vmul(a, b);
    let t2 = shuffle(b, t, 1, 0, 0, 0);
    t2 = vadd(t2, t);
    t = shuffle(t, t2, 0, 3, 0, 0);
    t = vadd(t, t2);
    return t[2];
}

// XMVector3Cross.
export function cross3(a: number[], b: number[]): number[] {
    let t1 = permute(a, 3, 0, 2, 1);
    let t2 = permute(b, 3, 1, 0, 2);
    let r = vmul(t1, t2);
    t1 = permute(t1, 3, 0, 2, 1);
    t2 = permute(t2, 3, 1, 0, 2);
    r = vfnmadd(t1, t2, r);
    return [r[0], r[1], r[2], 0.0];
}

// XMVector3Normalize (every component divided by the xyz length).
export function normalize3(a: number[]): number[] {
    const l = vmul(a, a);
    const length = Math.fround(Math.sqrt(Math.fround(Math.fround(l[0] + l[1]) + l[2])));
    return vdiv(a, [length, length, length, length]);
}

// XMVector4Normalize.
export function normalize4(a: number[]): number[] {
    const l = vmul(a, a);
    const length = Math.fround(Math.sqrt(Math.fround(Math.fround(l[0] + l[2]) + Math.fround(l[1] + l[3]))));
    return vdiv(a, [length, length, length, length]);
}

// XMVector3Transform: (x, y, z, 1) * M.
export function transform3(a: number[], m: number[]): number[] {
    let r = vadd(vmul(splat(a, 2), row(m, 2)), row(m, 3));
    r = vadd(vmul(splat(a, 1), row(m, 1)), r);
    return vadd(vmul(splat(a, 0), row(m, 0)), r);
}

export function matrixMultiply(a: number[], b: number[]): number[] {
    let rows: number[][] = [];
    for (let i = 0; i < 4; i++) {
        const w = row(a, i);
        const x = vmul(splat(w, 0), row(b, 0));
        const y = vmul(splat(w, 1), row(b, 1));
        const z = vmul(splat(w, 2), row(b, 2));
        const ww = vmul(splat(w, 3), row(b, 3));
        rows.push(vadd(vadd(x, z), vadd(y, ww)));
    }
    return fromRows(rows[0], rows[1], rows[2], rows[3]);
}

export function matrixTranspose(m: number[]): number[] {
    let t: number[] = [];
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            t.push(m[c * 4 + r]);
        }
    }
    return t;
}

// XMMatrixInverse's SSE2 code, shuffle for shuffle.
export function matrixInverse(m: number[]): number[] {
    const t = matrixTranspose(m);
    const mt0 = row(t, 0);
    const mt1 = row(t, 1);
    const mt2 = row(t, 2);
    const mt3 = row(t, 3);

    let v00 = permute(mt2, 1, 1, 0, 0);
    let v10 = permute(mt3, 3, 2, 3, 2);
    let v01 = permute(mt0, 1, 1, 0, 0);
    let v11 = permute(mt1, 3, 2, 3, 2);
    let v02 = shuffle(mt2, mt0, 2, 0, 2, 0);
    let v12 = shuffle(mt3, mt1, 3, 1, 3, 1);
    let d0 = vmul(v00, v10);
    let d1 = vmul(v01, v11);
    let d2 = vmul(v02, v12);

    v00 = permute(mt2, 3, 2, 3, 2);
    v10 = permute(mt3, 1, 1, 0, 0);
    v01 = permute(mt0, 3, 2, 3, 2);
    v11 = permute(mt1, 1, 1, 0, 0);
    v02 = shuffle(mt2, mt0, 3, 1, 3, 1);
    v12 = shuffle(mt3, mt1, 2, 0, 2, 0);
    d0 = vfnmadd(v00, v10, d0);
    d1 = vfnmadd(v01, v11, d1);
    d2 = vfnmadd(v02, v12, d2);

    v11 = shuffle(d0, d2, 1, 1, 3, 1);
    v00 = permute(mt1, 1, 0, 2, 1);
    v10 = shuffle(v11, d0, 0, 3, 0, 2);
    v01 = permute(mt0, 0, 1, 0, 2);
    v11 = shuffle(v11, d0, 2, 1, 2, 1);
    let v13 = shuffle(d1, d2, 3, 3, 3, 1);
    v02 = permute(mt3, 1, 0, 2, 1);
    v12 = shuffle(v13, d1, 0, 3, 0, 2);
    let v03 = permute(mt2, 0, 1, 0, 2);
    v13 = shuffle(v13, d1, 2, 1, 2, 1);
    let c0 = vmul(v00, v10);
    let c2 = vmul(v01, v11);
    let c4 = vmul(v02, v12);
    let c6 = vmul(v03, v13);

    v11 = shuffle(d0, d2, 0, 0, 1, 0);
    v00 = permute(mt1, 2, 1, 3, 2);
    v10 = shuffle(d0, v11, 2, 1, 0, 3);
    v01 = permute(mt0, 1, 3, 2, 3);
    v11 = shuffle(d0, v11, 0, 2, 1, 2);
    v13 = shuffle(d1, d2, 2, 2, 1, 0);
    v02 = permute(mt3, 2, 1, 3, 2);
    v12 = shuffle(d1, v13, 2, 1, 0, 3);
    v03 = permute(mt2, 1, 3, 2, 3);
    v13 = shuffle(d1, v13, 0, 2, 1, 2);
    c0 = vfnmadd(v00, v10, c0);
    c2 = vfnmadd(v01, v11, c2);
    c4 = vfnmadd(v02, v12, c4);
    c6 = vfnmadd(v03, v13, c6);

    v00 = permute(mt1, 0, 3, 0, 3);
    v10 = permute(shuffle(d0, d2, 1, 0, 2, 2), 0, 2, 3, 0);
    v01 = permute(mt0, 2, 0, 3, 1);
    v11 = permute(shuffle(d0, d2, 1, 0, 3, 0), 2, 1, 0, 3);
    v02 = permute(mt3, 0, 3, 0, 3);
    v12 = permute(shuffle(d1, d2, 3, 2, 2, 2), 0, 2, 3, 0);
    v03 = permute(mt2, 2, 0, 3, 1);
    v13 = permute(shuffle(d1, d2, 3, 2, 3, 0), 2, 1, 0, 3);

    v00 = vmul(v00, v10);
    v01 = vmul(v01, v11);
    v02 = vmul(v02, v12);
    v03 = vmul(v03, v13);
    const c1 = vsub(c0, v00);
    c0 = vadd(c0, v00);
    const c3 = vadd(c2, v01);
    c2 = vsub(c2, v01);
    const c5 = vsub(c4, v02);
    c4 = vadd(c4, v02);
    const c7 = vadd(c6, v03);
    c6 = vsub(c6, v03);

    c0 = permute(shuffle(c0, c1, 3, 1, 2, 0), 3, 1, 2, 0);
    c2 = permute(shuffle(c2, c3, 3, 1, 2, 0), 3, 1, 2, 0);
    c4 = permute(shuffle(c4, c5, 3, 1, 2, 0), 3, 1, 2, 0);
    c6 = permute(shuffle(c6, c7, 3, 1, 2, 0), 3, 1, 2, 0);
    const r = Math.fround(1.0 / dot4(c0, mt0));
    const rcp = [r, r, r, r];
    return fromRows(vmul(c0, rcp), vmul(c2, rcp), vmul(c4, rcp), vmul(c6, rcp));
}

// XMScalarSinCos: [sin, cos] by its minimax polynomials.
export const XM_PI = Math.fround(3.141592654);
export const XM_2PI = Math.fround(6.283185307);
export const XM_1DIV2PI = Math.fround(0.159154943);
export const XM_PIDIV2 = Math.fround(1.570796327);

export function scalarSinCos(value: number): number[] {
    // Map value to y in [-pi, pi], value = 2 pi quotient + remainder.
    let quotient = Math.fround(XM_1DIV2PI * value);
    if (value >= 0.0) {
        quotient = Math.floor(Math.fround(quotient + 0.5));
    } else {
        quotient = Math.ceil(Math.fround(quotient - 0.5));
    }
    let y = Math.fround(value - Math.fround(XM_2PI * quotient));
    // Map y to [-pi/2, pi/2] with sin(y) = sin(value).
    let sign = 1.0;
    if (y > XM_PIDIV2) {
        y = Math.fround(XM_PI - y);
        sign = -1.0;
    } else if (y < -XM_PIDIV2) {
        y = Math.fround(-XM_PI - y);
        sign = -1.0;
    }
    const y2 = Math.fround(y * y);
    let s = Math.fround(Math.fround(-2.3889859e-08) * y2);
    s = Math.fround(Math.fround(s + Math.fround(2.7525562e-06)) * y2);
    s = Math.fround(Math.fround(s - Math.fround(0.00019840874)) * y2);
    s = Math.fround(Math.fround(s + Math.fround(0.0083333310)) * y2);
    s = Math.fround(Math.fround(s - Math.fround(0.16666667)) * y2);
    s = Math.fround(Math.fround(s + 1.0) * y);
    let p = Math.fround(Math.fround(-2.6051615e-07) * y2);
    p = Math.fround(Math.fround(p + Math.fround(2.4760495e-05)) * y2);
    p = Math.fround(Math.fround(p - Math.fround(0.0013888378)) * y2);
    p = Math.fround(Math.fround(p + Math.fround(0.041666638)) * y2);
    p = Math.fround(Math.fround(p - 0.5) * y2);
    p = Math.fround(p + 1.0);
    return [s, Math.fround(sign * p)];
}

// XMConvertToRadians.
export function radians(degrees: number): number {
    return Math.fround(Math.fround(degrees) * Math.fround(XM_PI / 180.0));
}

export function matrixIdentity(): number[] {
    return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
}

export function matrixScaling(x: number, y: number, z: number): number[] {
    return [x, 0.0, 0.0, 0.0, 0.0, y, 0.0, 0.0, 0.0, 0.0, z, 0.0, 0.0, 0.0, 0.0, 1.0];
}

export function matrixTranslation(x: number, y: number, z: number): number[] {
    return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, y, z, 1.0];
}

// XMMatrixRotationY.
export function matrixRotationY(angle: number): number[] {
    const sinCos = scalarSinCos(angle);
    const s = sinCos[0];
    const c = sinCos[1];
    return [c, 0.0, -s, 0.0, 0.0, 1.0, 0.0, 0.0, s, 0.0, c, 0.0, 0.0, 0.0, 0.0, 1.0];
}

// XMMatrixLookAtLH.
export function matrixLookAtLH(eye: number[], at: number[], up: number[]): number[] {
    const r2 = normalize3(vsub(at, eye));
    const r0 = normalize3(cross3(up, r2));
    const r1 = cross3(r2, r0);
    const negEye = [-eye[0], -eye[1], -eye[2], -eye[3]];
    return matrixTranspose([
        r0[0], r0[1], r0[2], dot3(r0, negEye),
        r1[0], r1[1], r1[2], dot3(r1, negEye),
        r2[0], r2[1], r2[2], dot3(r2, negEye),
        0.0, 0.0, 0.0, 1.0,
    ]);
}

// XMMatrixPerspectiveFovLH.
export function matrixPerspectiveFovLH(fovAngleY: number, aspectRatio: number, nearZ: number, farZ: number): number[] {
    const sinCos = scalarSinCos(Math.fround(0.5 * fovAngleY));
    const near = Math.fround(nearZ);
    const far = Math.fround(farZ);
    const range = Math.fround(far / Math.fround(far - near));
    const height = Math.fround(sinCos[1] / sinCos[0]);
    return [
        Math.fround(height / aspectRatio), 0.0, 0.0, 0.0,
        0.0, height, 0.0, 0.0,
        0.0, 0.0, range, 1.0,
        0.0, 0.0, Math.fround(-range * near), 0.0,
    ];
}

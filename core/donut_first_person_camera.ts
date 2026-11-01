// Donut's FirstPersonCamera (donut/app/Camera.cpp), in float32 as dm (donut/core/math) computes it,
// on NRIFramework's input: for the NRI ports of Donut examples that use it, so their frames match
// the Donut example's.
//
// Imported with `import { DonutFirstPersonCamera } from "../../core/donut_first_person_camera";`
// (from examples/nri/), and listed in the example's add_tslang_nri_example sources.

/// <reference path="nri/nri_interop.d.ts" />

// GLFW's key codes: Donut's camera keys.
const KEY_Q = 81;
const KEY_E = 69;
const KEY_A = 65;
const KEY_D = 68;
const KEY_W = 87;
const KEY_S = 83;
const KEY_LEFT_SHIFT = 340;
const KEY_LEFT_CONTROL = 341;

function f(x: number) {
    return Math.fround(x);
}

function dot(a: number[], b: number[]) {
    return f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
}

function cross(a: number[], b: number[]) {
    return [f(f(a[1] * b[2]) - f(a[2] * b[1])), f(f(a[2] * b[0]) - f(a[0] * b[2])), f(f(a[0] * b[1]) - f(a[1] * b[0]))];
}

function normalize(v: number[]) {
    const length = f(Math.sqrt(dot(v, v)));
    return [f(v[0] / length), f(v[1] / length), f(v[2] / length)];
}

// v rotated by angle radians around the (normalized) axis: dm::rotation's Rodrigues formula.
function rotateAround(v: number[], axis: number[], angle: number) {
    const s = f(Math.sin(angle));
    const c = f(Math.cos(angle));
    const axisCrossV = cross(axis, v);
    const k = f(dot(axis, v) * f(1.0 - c));
    return [f(f(f(v[0] * c) + f(axisCrossV[0] * s)) + f(axis[0] * k)),
        f(f(f(v[1] * c) + f(axisCrossV[1] * s)) + f(axis[1] * k)),
        f(f(f(v[2] * c) + f(axisCrossV[2] * s)) + f(axis[2] * k))];
}

@final
export class DonutFirstPersonCamera {
    position: number[];
    dir: number[];
    up: number[];
    right: number[];
    // Units per second (BaseCamera::SetMoveSpeed), radians per pixel dragged (SetRotateSpeed).
    private moveSpeed: number;
    private rotateSpeed: number;
    // The left button's drag (Animate's m_IsDragging).
    private dragging: boolean;

    constructor(moveSpeed: number, rotateSpeed: number) {
        this.position = [0.0, 0.0, 0.0];
        this.dir = [0.0, 0.0, 1.0];
        this.up = [0.0, 1.0, 0.0];
        this.right = [1.0, 0.0, 0.0];
        this.moveSpeed = f(moveSpeed);
        this.rotateSpeed = f(rotateSpeed);
        this.dragging = false;
    }

    // BaseCamera::BaseLookAt (each coordinate as a float).
    lookAt(px: number, py: number, pz: number, tx: number, ty: number, tz: number) {
        this.position = [f(px), f(py), f(pz)];
        const target = [f(tx), f(ty), f(tz)];
        this.dir = normalize([f(target[0] - this.position[0]), f(target[1] - this.position[1]), f(target[2] - this.position[2])]);
        this.up = normalize([0.0, 1.0, 0.0]);
        this.right = normalize(cross(this.dir, this.up));
        this.up = normalize(cross(this.right, this.dir));
    }

    // BaseCamera::UpdateWorldToView as dm::affineToHomogeneous makes it a float4x4 (row vectors):
    // translation(-position) * the basis (right, up, dir) as columns.
    worldToView(): number[] {
        const r = this.right;
        const u = this.up;
        const d = this.dir;
        const p = [-this.position[0], -this.position[1], -this.position[2]];
        return [
            r[0], u[0], d[0], 0.0,
            r[1], u[1], d[1], 0.0,
            r[2], u[2], d[2], 0.0,
            dot(p, r), dot(p, u), dot(p, d), 1.0,
        ];
    }

    // FirstPersonCamera::Animate: the left button's drag turns the camera (yaw around the world's
    // up, pitch around its right), the keys move it (Shift: 3 times faster, Control: a tenth).
    // mouseFree: the overlay doesn't have the mouse.
    animate(sample: NriSampleHandle, elapsedSeconds: number, mouseFree: boolean) {
        let changed = false;
        const dragging = mouseFree && Nri_IsButtonPressed(sample, 0) != 0;
        let dir = this.dir;
        let up = this.up;
        if (dragging && this.dragging) {
            const yaw = f(this.rotateSpeed * Nri_GetMouseDeltaX(sample));
            const pitch = f(this.rotateSpeed * Nri_GetMouseDeltaY(sample));
            if (yaw != 0.0 || pitch != 0.0) {
                // rotation(right, -pitch) * rotation(up, -yaw): pitch first.
                const worldUp = [0.0, 1.0, 0.0];
                dir = rotateAround(rotateAround(dir, this.right, -pitch), worldUp, -yaw);
                up = rotateAround(rotateAround(up, this.right, -pitch), worldUp, -yaw);
                changed = true;
            }
        }
        this.dragging = dragging;

        let step = f(elapsedSeconds * this.moveSpeed);
        if (Nri_IsKeyPressed(sample, KEY_LEFT_SHIFT) != 0) {
            step = f(step * 3.0);
        }
        if (Nri_IsKeyPressed(sample, KEY_LEFT_CONTROL) != 0) {
            step = f(step * 0.1);
        }
        const move = [0.0, 0.0, 0.0];
        const keys = [KEY_W, KEY_S, KEY_A, KEY_D, KEY_E, KEY_Q];
        const directions = [this.dir, this.dir, this.right, this.right, this.up, this.up];
        const signs = [1.0, -1.0, -1.0, 1.0, 1.0, -1.0];
        for (let k = 0; k < keys.length; k++) {
            if (Nri_IsKeyPressed(sample, keys[k]) != 0) {
                for (let i = 0; i < 3; i++) {
                    move[i] = f(move[i] + f(signs[k] * f(directions[k][i] * step)));
                }
                changed = true;
            }
        }

        // FirstPersonCamera::UpdateCamera
        if (changed) {
            for (let i = 0; i < 3; i++) {
                this.position[i] = f(this.position[i] + move[i]);
            }
            this.dir = normalize(dir);
            this.up = normalize(up);
            this.right = normalize(cross(this.dir, this.up));
        }
    }
}

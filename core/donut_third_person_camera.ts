// Donut's ThirdPersonCamera (donut/app/Camera.cpp), in float32 as dm (donut/core/math) computes it,
// on NRIFramework's input: for the NRI ports of Donut examples that orbit a target with it, so their
// frames match the Donut example's. The left mouse button's drag orbits, the wheel zooms; the middle
// button's panning (AnimateTranslation) isn't ported.
//
// Imported with `import { DonutThirdPersonCamera } from "../../core/donut_third_person_camera";`
// (from examples/nri/), and listed in the example's add_tslang_nri_example sources.

/// <reference path="nri/nri_interop.d.ts" />
import { NriSample } from "./nri";

function f(x: number) {
    return Math.fround(x);
}

// Quaternion product a * b, (w, x, y, z), in float32 as donut::math's.
function quatMultiply(a: number[], b: number[]) {
    return [
        f(f(f(f(a[0] * b[0]) - f(a[1] * b[1])) - f(a[2] * b[2])) - f(a[3] * b[3])),
        f(f(f(f(a[0] * b[1]) + f(a[1] * b[0])) + f(a[2] * b[3])) - f(a[3] * b[2])),
        f(f(f(f(a[0] * b[2]) + f(a[2] * b[0])) + f(a[3] * b[1])) - f(a[1] * b[3])),
        f(f(f(f(a[0] * b[3]) + f(a[3] * b[0])) + f(a[1] * b[2])) - f(a[2] * b[1])),
    ];
}

@final
export class DonutThirdPersonCamera {
    target: number[];
    distance: number;
    yaw: number;
    pitch: number;
    // Radians per pixel dragged (BaseCamera's m_RotateSpeed).
    private rotateSpeed: number;
    // Whether the left button's drag was on last frame (MouseState::Orbiting).
    private orbiting: boolean;
    // Row-major, for row vectors (Donut's affineToHomogeneous(m_MatWorldToView)): Animate's.
    worldToView: number[];

    constructor() {
        this.target = [0.0, 0.0, 0.0];
        this.distance = f(30.0);
        this.yaw = 0.0;
        this.pitch = 0.0;
        this.rotateSpeed = f(0.005);
        this.orbiting = false;
        this.worldToView = [];
        for (let i = 0; i < 16; i++) {
            this.worldToView.push(i % 5 == 0 ? 1.0 : 0.0);
        }
    }

    // SetTargetPosition (each coordinate as a float).
    setTarget(x: number, y: number, z: number) {
        this.target = [f(x), f(y), f(z)];
    }

    setDistance(distance: number) {
        this.distance = f(distance);
    }

    // SetRotation (yaw, then pitch, radians as floats).
    setRotation(yaw: number, pitch: number) {
        this.yaw = f(yaw);
        this.pitch = f(pitch);
    }

    // The mouse's part of this frame: AnimateOrbit with the left button's drag (the motion since the
    // last frame, once the button was down then too), MouseScrollUpdate with the wheel. mouseFree:
    // the overlay doesn't have the mouse. True if there was any input (a drag or a turn of the wheel:
    // the examples' idle orbit starts again from it).
    mouse(sample: NriSample, mouseFree: boolean): boolean {
        const pressed = mouseFree && sample.isButtonPressed(0) != 0;
        let input = pressed;
        if (pressed && this.orbiting) {
            this.yaw = f(this.yaw - f(this.rotateSpeed * f(sample.getMouseDeltaX())));
            this.pitch = f(this.pitch + f(this.rotateSpeed * f(sample.getMouseDeltaY())));
            // clamp(m_Pitch, PI_f * -0.5f, PI_f * 0.5f) (explicit: tslang's Math.max gets negative
            // numbers wrong).
            if (this.pitch < f(-0.5 * Math.PI)) {
                this.pitch = f(-0.5 * Math.PI);
            }
            if (this.pitch > f(0.5 * Math.PI)) {
                this.pitch = f(0.5 * Math.PI);
            }
        }
        this.orbiting = pressed;
        const wheel = mouseFree ? sample.getMouseWheel() : 0.0;
        if (wheel != 0.0) {
            const scrollFactor = f(1.15);
            this.distance = f(wheel < 0.0 ? this.distance * scrollFactor : this.distance * f(1.0 / scrollFactor));
            input = true;
        }
        return input;
    }

    // Animate's world-to-view matrix: the camera distance back from the target along the orbit's
    // forward direction (rotationQuat(float3(pitch, yaw, 0))), right = -row0, up = row1, forward =
    // row2.
    animate() {
        const halfX = f(0.5 * this.pitch);
        const halfY = f(0.5 * this.yaw);
        const quatX = [f(Math.cos(halfX)), f(Math.sin(halfX)), 0.0, 0.0];
        const quatY = [f(Math.cos(halfY)), 0.0, f(Math.sin(halfY)), 0.0];
        const quatZ = [1.0, 0.0, 0.0, 0.0];
        const q = quatMultiply(quatMultiply(quatZ, quatY), quatX);
        const w = q[0];
        const x = q[1];
        const y = q[2];
        const z = q[3];
        const row0 = [f(1.0 - f(2.0 * f(f(y * y) + f(z * z)))), f(2.0 * f(f(x * y) + f(z * w))), f(2.0 * f(f(x * z) - f(y * w)))];
        const row1 = [f(2.0 * f(f(x * y) - f(z * w))), f(1.0 - f(2.0 * f(f(x * x) + f(z * z)))), f(2.0 * f(f(y * z) + f(x * w)))];
        const row2 = [f(2.0 * f(f(x * z) + f(y * w))), f(2.0 * f(f(y * z) - f(x * w))), f(1.0 - f(2.0 * f(f(x * x) + f(y * y))))];

        const camPos = [0.0, 0.0, 0.0];
        const right = [0.0, 0.0, 0.0];
        for (let i = 0; i < 3; i++) {
            camPos[i] = f(this.target[i] + f(f(-this.distance) * row2[i]));
            right[i] = -row0[i];
        }

        // translation(-camPos) * affine3::from_cols(right, up, forward, 0)
        const columns = [right, row1, row2];
        const m: number[] = [];
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
                m.push(columns[c][r]);
            }
            m.push(0.0);
        }
        for (let c = 0; c < 3; c++) {
            const column = columns[c];
            m.push(f(f(f(f(-camPos[0]) * column[0]) + f(f(-camPos[1]) * column[1])) + f(f(-camPos[2]) * column[2])));
        }
        m.push(1.0);
        this.worldToView = m;
    }
}

// DirectX-Graphics-Samples' SimpleCamera (D3D12DynamicIndexing, D3D12Bundles, ...), its math in
// float as DirectXMath computes it.
//
// Imported with `import { SimpleCamera } from "../core/simple_camera";` (from examples/), its object
// and core/directx_math.ts's listed in the example's add_tslang_example sources.

import { matrixLookToRH, XM_PI } from "./directx_math";

// GLFW values, as passed to the keyboard callback.
const KEY_A = 65;
const KEY_D = 68;
const KEY_S = 83;
const KEY_W = 87;
const KEY_RIGHT = 262;
const KEY_LEFT = 263;
const KEY_DOWN = 264;
const KEY_UP = 265;

// DirectX-Graphics-Samples' SimpleCamera: WASD move it, the arrow keys turn it (pitch within 45
// degrees up and down), at its move and turn speeds per second. Escape closes the window, as in
// the other examples, rather than putting the camera back.
export class SimpleCamera {
    private initialPosition: number[];
    position: number[];
    private yaw: number;
    private pitch: number;
    lookDirection: number[];
    private moveSpeed: number;
    private turnSpeed: number;
    private keys: int[];

    constructor() {
        this.initialPosition = [0.0, 0.0, 0.0, 0.0];
        this.position = [0.0, 0.0, 0.0, 0.0];
        this.yaw = XM_PI;
        this.pitch = 0.0;
        this.lookDirection = [0.0, 0.0, -1.0, 0.0];
        this.moveSpeed = 20.0;
        this.turnSpeed = Math.fround(XM_PI / 2.0);
        // w, a, s, d, left, right, up, down.
        this.keys = [0, 0, 0, 0, 0, 0, 0, 0];
    }

    init(x: number, y: number, z: number): void {
        this.initialPosition = [Math.fround(x), Math.fround(y), Math.fround(z), 0.0];
        this.reset();
    }

    setMoveSpeed(unitsPerSecond: number): void {
        this.moveSpeed = Math.fround(unitsPerSecond);
    }

    reset(): void {
        this.position = [this.initialPosition[0], this.initialPosition[1], this.initialPosition[2], 0.0];
        this.yaw = XM_PI;
        this.pitch = 0.0;
        this.lookDirection = [0.0, 0.0, -1.0, 0.0];
    }

    // True if it took the key.
    onKey(key: int, down: boolean): boolean {
        let index = -1;
        if (key == KEY_W) {
            index = 0;
        } else if (key == KEY_A) {
            index = 1;
        } else if (key == KEY_S) {
            index = 2;
        } else if (key == KEY_D) {
            index = 3;
        } else if (key == KEY_LEFT) {
            index = 4;
        } else if (key == KEY_RIGHT) {
            index = 5;
        } else if (key == KEY_UP) {
            index = 6;
        } else if (key == KEY_DOWN) {
            index = 7;
        }
        if (index < 0) {
            return false;
        }
        this.keys[index] = down ? 1 : 0;
        return true;
    }

    update(elapsedSeconds: number): void {
        const k = this.keys;
        // The move vector in camera space.
        let moveX = 0.0;
        let moveZ = 0.0;
        if (k[1] != 0) {
            moveX -= 1.0;
        }
        if (k[3] != 0) {
            moveX += 1.0;
        }
        if (k[0] != 0) {
            moveZ -= 1.0;
        }
        if (k[2] != 0) {
            moveZ += 1.0;
        }
        if (Math.abs(moveX) > 0.1 && Math.abs(moveZ) > 0.1) {
            const length = Math.fround(Math.sqrt(moveX * moveX + moveZ * moveZ));
            moveX = Math.fround(moveX / length);
            moveZ = Math.fround(moveZ / length);
        }

        const moveInterval = Math.fround(this.moveSpeed * elapsedSeconds);
        const rotateInterval = Math.fround(this.turnSpeed * elapsedSeconds);
        if (k[4] != 0) {
            this.yaw = Math.fround(this.yaw + rotateInterval);
        }
        if (k[5] != 0) {
            this.yaw = Math.fround(this.yaw - rotateInterval);
        }
        if (k[6] != 0) {
            this.pitch = Math.fround(this.pitch + rotateInterval);
        }
        if (k[7] != 0) {
            this.pitch = Math.fround(this.pitch - rotateInterval);
        }
        // Prevent looking too far up or down.
        const quarterPi = Math.fround(XM_PI / 4.0);
        // Not Math.max: tslang's starts from Number.MIN_VALUE, above any negative number.
        if (this.pitch > quarterPi) {
            this.pitch = quarterPi;
        }
        if (this.pitch < -quarterPi) {
            this.pitch = -quarterPi;
        }

        // Move the camera in model space.
        const cosYaw = Math.fround(Math.cos(this.yaw));
        const sinYaw = Math.fround(Math.sin(this.yaw));
        const x = Math.fround(Math.fround(moveX * -cosYaw) - Math.fround(moveZ * sinYaw));
        const z = Math.fround(Math.fround(moveX * sinYaw) - Math.fround(moveZ * cosYaw));
        this.position[0] = Math.fround(this.position[0] + Math.fround(x * moveInterval));
        this.position[2] = Math.fround(this.position[2] + Math.fround(z * moveInterval));

        // The look direction.
        const r = Math.fround(Math.cos(this.pitch));
        this.lookDirection = [Math.fround(r * sinYaw), Math.fround(Math.sin(this.pitch)), Math.fround(r * cosYaw), 0.0];
    }

    viewMatrix(): number[] {
        return matrixLookToRH(this.position, this.lookDirection, [0.0, 1.0, 0.0, 0.0]);
    }
}

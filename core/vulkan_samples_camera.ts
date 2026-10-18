// Vulkan-Samples' cameras and view, as the ports of its samples use them: the framework's
// vkb::Camera (look-at and first person types) with ApiVulkanSample's controls, and
// ApiVulkanSample's own view (zoom, rotation, camera_pos) of the samples that don't use a camera.
// Matrices in glm's layout (core/matrix.ts).
//
// Imported with `import { LookAtCamera, ... } from "../core/vulkan_samples_camera";` (from
// examples/), and listed with core/matrix.ts in the example's add_tslang_example sources.

import { identity, multiply, rotate, translation, radians } from "./matrix";
import { KEY_A, KEY_D, KEY_S, KEY_W, ACTION_RELEASE } from "./glfw_input";

// vkb::Camera, look-at type, with ApiVulkanSample's mouse controls: the left button turns it, the
// right one (or the wheel) zooms, the middle one pans. Starts at position (a translation) and
// rotation (degrees around x, y, z).
export class LookAtCamera {
    rotation: number[];
    position: number[];
    private mouseX: number;
    private mouseY: number;
    private buttons: boolean[];

    constructor(position: number[], rotation: number[]) {
        this.rotation = [rotation[0], rotation[1], rotation[2]];
        this.position = [position[0], position[1], position[2]];
        this.mouseX = 0.0;
        this.mouseY = 0.0;
        this.buttons = [false, false, false];
    }

    // vkb::Camera::update_view_matrix: translate(position) * rotations around x, y, z.
    view() {
        let r = identity();
        r = rotate(r, radians(this.rotation[0]), 1.0, 0.0, 0.0);
        r = rotate(r, radians(this.rotation[1]), 0.0, 1.0, 0.0);
        r = rotate(r, radians(this.rotation[2]), 0.0, 0.0, 1.0);
        return multiply(translation(this.position[0], this.position[1], this.position[2]), r);
    }

    // GLFW buttons: 0 left, 1 right, 2 middle; action 1 press, 0 release.
    mouseButton(button: int, action: int) {
        if (button >= 0 && button < 3) {
            this.buttons[button] = action == 1;
        }
    }

    // ApiVulkanSample::handle_mouse_move, with its speeds (1).
    mouseMove(x: number, y: number) {
        const dx = Math.floor(this.mouseX) - Math.floor(x);
        const dy = Math.floor(this.mouseY) - Math.floor(y);
        if (this.buttons[0]) {
            this.rotation[0] += dy;
            this.rotation[1] -= dx;
        }
        if (this.buttons[1]) {
            this.position[2] += dy * 0.005;
        }
        if (this.buttons[2]) {
            this.position[0] -= dx * 0.01;
            this.position[1] -= dy * 0.01;
        }
        this.mouseX = x;
        this.mouseY = y;
    }

    // ApiVulkanSample's mouse wheel: zoom.
    mouseScroll(yoffset: number) {
        this.position[2] += yoffset * 0.005;
    }
}

// vkb::Camera, first person type, with ApiVulkanSample's controls: W, S, A, D move it (1 unit per
// second), the left mouse button turns it, the right one moves it along its view, the middle one
// pans. Starts at position and rotation (degrees around x, y, z).
export class FirstPersonCamera {
    rotation: number[];
    position: number[];
    private mouseX: number;
    private mouseY: number;
    private buttons: boolean[];
    // W, S, A, D held.
    private keys: boolean[];

    constructor(position: number[], rotation: number[]) {
        this.rotation = [rotation[0], rotation[1], rotation[2]];
        this.position = [position[0], position[1], position[2]];
        this.mouseX = 0.0;
        this.mouseY = 0.0;
        this.buttons = [false, false, false];
        this.keys = [false, false, false, false];
    }

    // vkb::Camera::update_view_matrix: rotations around x, y, z, then translate(position).
    view() {
        let r = identity();
        r = rotate(r, radians(this.rotation[0]), 1.0, 0.0, 0.0);
        r = rotate(r, radians(this.rotation[1]), 0.0, 1.0, 0.0);
        r = rotate(r, radians(this.rotation[2]), 0.0, 0.0, 1.0);
        return multiply(r, translation(this.position[0], this.position[1], this.position[2]));
    }

    key(key: int, action: int) {
        const down = action != ACTION_RELEASE;
        if (key == KEY_W) {
            this.keys[0] = down;
        } else if (key == KEY_S) {
            this.keys[1] = down;
        } else if (key == KEY_A) {
            this.keys[2] = down;
        } else if (key == KEY_D) {
            this.keys[3] = down;
        }
    }

    // vkb::Camera::update: first person movement, 1 unit per second.
    update(deltaTime: number) {
        const rx = radians(this.rotation[0]);
        const ry = radians(this.rotation[1]);
        const front = [-Math.cos(rx) * Math.sin(ry), Math.sin(rx), Math.cos(rx) * Math.cos(ry)];
        const length = Math.sqrt(front[0] * front[0] + front[1] * front[1] + front[2] * front[2]);
        for (let i = 0; i < 3; i++) {
            front[i] /= length;
        }
        // normalize(cross(front, (0, 1, 0))).
        const right = [-front[2], 0.0, front[0]];
        const rightLength = Math.sqrt(right[0] * right[0] + right[2] * right[2]);
        for (let i = 0; i < 3; i++) {
            right[i] /= rightLength;
        }
        for (let i = 0; i < 3; i++) {
            if (this.keys[0]) {
                this.position[i] += front[i] * deltaTime;
            }
            if (this.keys[1]) {
                this.position[i] -= front[i] * deltaTime;
            }
            if (this.keys[2]) {
                this.position[i] -= right[i] * deltaTime;
            }
            if (this.keys[3]) {
                this.position[i] += right[i] * deltaTime;
            }
        }
    }

    // GLFW buttons: 0 left, 1 right, 2 middle; action 1 press, 0 release.
    mouseButton(button: int, action: int) {
        if (button >= 0 && button < 3) {
            this.buttons[button] = action == 1;
        }
    }

    // ApiVulkanSample::handle_mouse_move, with its speeds (1).
    mouseMove(x: number, y: number) {
        const dx = Math.floor(this.mouseX) - Math.floor(x);
        const dy = Math.floor(this.mouseY) - Math.floor(y);
        if (this.buttons[0]) {
            this.rotation[0] += dy;
            this.rotation[1] -= dx;
        }
        if (this.buttons[1]) {
            this.position[2] += dy * 0.005;
        }
        if (this.buttons[2]) {
            this.position[0] -= dx * 0.01;
            this.position[1] -= dy * 0.01;
        }
        this.mouseX = x;
        this.mouseY = y;
    }
}

// ApiVulkanSample's own view (not its camera): zoom, rotation and camera_pos, with its mouse
// controls: the left button turns (1.25 degrees per pixel), the right one zooms, the middle one
// pans.
export class SampleView {
    zoom: number;
    rotation: number[];
    position: number[];
    private mouseX: number;
    private mouseY: number;
    private buttons: boolean[];

    constructor(zoom: number, rotation: number[]) {
        this.zoom = zoom;
        this.rotation = [rotation[0], rotation[1], rotation[2]];
        this.position = [0.0, 0.0, 0.0];
        this.mouseX = 0.0;
        this.mouseY = 0.0;
        this.buttons = [false, false, false];
    }

    // The samples' update_uniform_buffers: translate(0, 0, zoom) * translate(camera_pos) *
    // rotations around x, y, z.
    model() {
        let m = identity();
        m[12] = this.position[0];
        m[13] = this.position[1];
        m[14] = this.zoom + this.position[2];
        m = rotate(m, radians(this.rotation[0]), 1.0, 0.0, 0.0);
        m = rotate(m, radians(this.rotation[1]), 0.0, 1.0, 0.0);
        m = rotate(m, radians(this.rotation[2]), 0.0, 0.0, 1.0);
        return m;
    }

    // GLFW buttons: 0 left, 1 right, 2 middle; action 1 press, 0 release.
    mouseButton(button: int, action: int) {
        if (button >= 0 && button < 3) {
            this.buttons[button] = action == 1;
        }
    }

    // ApiVulkanSample::handle_mouse_move, with its speeds (1).
    mouseMove(x: number, y: number) {
        const dx = Math.floor(this.mouseX) - Math.floor(x);
        const dy = Math.floor(this.mouseY) - Math.floor(y);
        if (this.buttons[0]) {
            this.rotation[0] += dy * 1.25;
            this.rotation[1] -= dx * 1.25;
        }
        if (this.buttons[1]) {
            this.zoom += dy * 0.005;
        }
        if (this.buttons[2]) {
            this.position[0] -= dx * 0.01;
            this.position[1] -= dy * 0.01;
        }
        this.mouseX = x;
        this.mouseY = y;
    }
}

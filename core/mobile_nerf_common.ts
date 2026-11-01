// What the two MobileNeRF ports (mobile_nerf, mobile_nerf_rayquery) share: the reader of the
// sample's mlp.json and the sample's camera.
//
// Imported with `import { MlpReader, MobileNerfCamera } from "../core/mobile_nerf_common";` (from
// examples/), and listed with core/matrix.ts in the example's add_tslang_example sources. It doesn't
// depend on Donut (the NRI port, examples/nri/mobile_nerf_nri.ts, imports it too): the mouse's types
// are declarations only.

/// <reference path="donut_interop.d.ts" />
import { cross3, dot3, identity, multiply, radians, rotate } from "./matrix";

// Character codes for the JSON reader.
const CHAR_QUOTE = 34;
const CHAR_PLUS = 43;
const CHAR_MINUS = 45;
const CHAR_DOT = 46;
const CHAR_0 = 48;
const CHAR_9 = 57;
const CHAR_COLON = 58;
const CHAR_E = 69;
const CHAR_OPEN = 91;
const CHAR_CLOSE = 93;
const CHAR_LOWER_E = 101;

// Reads the numbers of mlp.json's arrays: { "obj_num": 1, "0_weights": [[...], ...], "0_bias":
// [...], ... }.
@final
export class MlpReader {
    // The file's bytes, one per int: resize makes room, the caller copies them in from bytes[0].
    bytes: int[];
    private pos: int;

    constructor() {
        this.bytes = [];
        this.pos = 0;
    }

    // Room for a file of size bytes; false if it's empty.
    resize(size: int) {
        for (let i = 0; i < size; i++) {
            this.bytes.push(0);
        }
        return size > 0;
    }

    // Moves past "key": ; false if the key isn't there.
    findKey(key: string) {
        const n = key.length;
        for (let i = 0; i + n + 1 < this.bytes.length; i++) {
            if (this.bytes[i] != CHAR_QUOTE || this.bytes[i + n + 1] != CHAR_QUOTE) {
                continue;
            }
            let match = true;
            for (let k = 0; k < n && match; k++) {
                match = this.bytes[i + 1 + k] == key.charCodeAt(k);
            }
            if (!match) {
                continue;
            }
            this.pos = i + n + 2;
            while (this.pos < this.bytes.length && this.bytes[this.pos] != CHAR_COLON) {
                this.pos++;
            }
            this.pos++;
            return true;
        }
        return false;
    }

    isNumberStart(c: int) {
        return (c >= CHAR_0 && c <= CHAR_9) || c == CHAR_MINUS || c == CHAR_PLUS || c == CHAR_DOT;
    }

    // A JSON number at the position.
    readNumber() {
        let sign = 1.0;
        if (this.bytes[this.pos] == CHAR_MINUS) {
            sign = -1.0;
            this.pos++;
        } else if (this.bytes[this.pos] == CHAR_PLUS) {
            this.pos++;
        }
        // The digits as an integer, and the power of ten they're scaled by.
        let mantissa = 0.0;
        let exponent = 0;
        while (this.pos < this.bytes.length && this.bytes[this.pos] >= CHAR_0 && this.bytes[this.pos] <= CHAR_9) {
            mantissa = mantissa * 10.0 + (this.bytes[this.pos] - CHAR_0);
            this.pos++;
        }
        if (this.pos < this.bytes.length && this.bytes[this.pos] == CHAR_DOT) {
            this.pos++;
            while (this.pos < this.bytes.length && this.bytes[this.pos] >= CHAR_0 && this.bytes[this.pos] <= CHAR_9) {
                mantissa = mantissa * 10.0 + (this.bytes[this.pos] - CHAR_0);
                exponent--;
                this.pos++;
            }
        }
        if (this.pos < this.bytes.length && (this.bytes[this.pos] == CHAR_E || this.bytes[this.pos] == CHAR_LOWER_E)) {
            this.pos++;
            let expSign = 1;
            if (this.bytes[this.pos] == CHAR_MINUS) {
                expSign = -1;
                this.pos++;
            } else if (this.bytes[this.pos] == CHAR_PLUS) {
                this.pos++;
            }
            let e = 0;
            while (this.pos < this.bytes.length && this.bytes[this.pos] >= CHAR_0 && this.bytes[this.pos] <= CHAR_9) {
                e = e * 10 + (this.bytes[this.pos] - CHAR_0);
                this.pos++;
            }
            exponent += expSign * e;
        }
        return sign * (exponent < 0 ? mantissa / Math.pow(10.0, -exponent) : mantissa * Math.pow(10.0, exponent));
    }

    // The numbers of the (nested) array at the position, in order.
    readArray() {
        const values: number[] = [];
        while (this.pos < this.bytes.length && this.bytes[this.pos] != CHAR_OPEN) {
            this.pos++;
        }
        let depth = 0;
        while (this.pos < this.bytes.length) {
            const c = this.bytes[this.pos];
            if (c == CHAR_OPEN) {
                depth++;
                this.pos++;
            } else if (c == CHAR_CLOSE) {
                depth--;
                this.pos++;
                if (depth == 0) {
                    break;
                }
            } else if (this.isNumberStart(c)) {
                values.push(this.readNumber());
            } else {
                this.pos++;
            }
        }
        return values;
    }

    array(key: string): number[] {
        if (!this.findKey(key)) {
            return [];
        }
        return this.readArray();
    }
}

function normalize(v: number[]) {
    const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return [v[0] / length, v[1] / length, v[2] / length];
}

// The sample's camera (the framework's vkb::Camera, look-at type), with ApiVulkanSample's mouse
// controls: the left button turns it, the right one zooms, the middle one pans.
@final
export class MobileNerfCamera {
    rotation: number[];
    position: number[];
    private mouseX: number;
    private mouseY: number;
    private buttons: boolean[];

    constructor() {
        this.rotation = [0.0, 0.0, 0.0];
        this.position = [0.0, 0.0, 0.0];
        this.mouseX = 0.0;
        this.mouseY = 0.0;
        this.buttons = [false, false, false];
    }

    // The sample's camera_set_look_at: glm::lookAt(eye, look, up), decomposed (glm::decompose:
    // the translation, and the rotation as a quaternion), its Euler angles (glm::eulerAngles,
    // in radians) multiplied by pi / 180 taken as the rotation in degrees, so barely any.
    setLookAt(eye: number[], look: number[], up: number[]) {
        const f = normalize([look[0] - eye[0], look[1] - eye[1], look[2] - eye[2]]);
        const s = normalize(cross3(f, up));
        const u = cross3(s, f);
        // The view's rotation by columns (Row[i] in glm::decompose is the matrix's column i).
        const row0 = [s[0], u[0], -f[0]];
        const row1 = [s[1], u[1], -f[1]];
        const row2 = [s[2], u[2], -f[2]];
        const translation = [-dot3(s, eye), -dot3(u, eye), dot3(f, eye)];

        let qx = 0.0;
        let qy = 0.0;
        let qz = 0.0;
        let qw = 0.0;
        const trace = row0[0] + row1[1] + row2[2];
        if (trace > 0.0) {
            let root = Math.sqrt(trace + 1.0);
            qw = 0.5 * root;
            root = 0.5 / root;
            qx = root * (row1[2] - row2[1]);
            qy = root * (row2[0] - row0[2]);
            qz = root * (row0[1] - row1[0]);
        } else {
            // the rows are the array's now: read through it (-mm=own moves them in)
            const rows = [row0, row1, row2];
            let i = 0;
            if (rows[1][1] > rows[0][0]) {
                i = 1;
            }
            if (rows[2][2] > rows[i][i]) {
                i = 2;
            }
            const j = (i + 1) % 3;
            const k = (j + 1) % 3;
            let root = Math.sqrt(rows[i][i] - rows[j][j] - rows[k][k] + 1.0);
            const q = [0.0, 0.0, 0.0];
            q[i] = 0.5 * root;
            root = 0.5 / root;
            q[j] = root * (rows[i][j] + rows[j][i]);
            q[k] = root * (rows[i][k] + rows[k][i]);
            qw = root * (rows[j][k] - rows[k][j]);
            qx = q[0];
            qy = q[1];
            qz = q[2];
        }

        // glm::pitch, yaw, roll.
        const py = 2.0 * (qy * qz + qw * qx);
        const px = qw * qw - qx * qx - qy * qy + qz * qz;
        const pitch = Math.abs(px) < 1.0e-7 && Math.abs(py) < 1.0e-7 ? 2.0 * Math.atan2(qx, qw) : Math.atan2(py, px);
        const yaw = Math.asin(Math.min(1.0, Math.max(-1.0, -2.0 * (qx * qz - qw * qy))));
        const roll = Math.atan2(2.0 * (qx * qy + qw * qz), qw * qw + qx * qx - qy * qy - qz * qz);
        this.rotation = [pitch * Math.PI / 180.0, yaw * Math.PI / 180.0, roll * Math.PI / 180.0];
        this.position = translation;
    }

    // vkb::Camera::update_view_matrix: translate(position) * rotations around x, y, z.
    view() {
        let r = identity();
        r = rotate(r, radians(this.rotation[0]), 1.0, 0.0, 0.0);
        r = rotate(r, radians(this.rotation[1]), 0.0, 1.0, 0.0);
        r = rotate(r, radians(this.rotation[2]), 0.0, 0.0, 1.0);
        let t = identity();
        t[12] = this.position[0];
        t[13] = this.position[1];
        t[14] = this.position[2];
        return multiply(t, r);
    }

    // GLFW buttons: 0 left, 1 right, 2 middle; action 1 press, 0 release.
    mouseButton(button: MouseButton, action: Action) {
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

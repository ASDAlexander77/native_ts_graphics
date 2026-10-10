// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace MobileNerf {
    const WINDOW_TITLE = "Donut Example: Mobile NeRF";

    // The sample's default scene, lego_combo: four of Morpheus team's Lego NeRFs (Vulkan-Samples'
    // assets, copied at build time; see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt), each a mesh,
    // two feature textures and an MLP.
    const MEDIA_DIR = "media/mobile_nerf/";
    const MODELS = ["lego_ball_phone", "lego_boba_fett_phone", "lego_monster_truck_phone", "lego_tractor_phone"];
    // lego_combo's hard-coded model transforms: translations.
    const COMBO_TRANSLATIONS = [
        0.5, 0.75, 0.0,
        0.5, 0.25, 0.0,
        0.0, -0.25, 0.5,
        0.0, -0.75, -0.5,
    ];
    // Its instancing: 2 x 2 x 2 copies of each model, 1.5 apart.
    const INSTANCE_DIM = [2, 2, 2];
    const INSTANCE_INTERVAL = [1.5, 1.5, 1.5];
    // Its camera position (y flipped by the sample), looking at the origin.
    const CAMERA_POSITION = [-0.0381453, 1.84186, -1.51744];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 0.01;
    const Z_FAR = 256.0;

    // Donut_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // struct GlobalUniform { float4x4 model, view, proj; float3 camera_position, camera_side,
    // camera_up, camera_lookat (each in 16 bytes); float2 img_dim; float tan_half_fov; }, padded.
    const UBO_MODEL = 0;
    const UBO_VIEW = 16;
    const UBO_PROJ = 32;
    const UBO_CAMERA_POSITION = 48;
    const UBO_CAMERA_SIDE = 52;
    const UBO_CAMERA_UP = 56;
    const UBO_CAMERA_LOOKAT = 60;
    const UBO_IMG_DIM = 64;
    const UBO_TAN_HALF_FOV = 66;
    const UBO_FLOATS = 68;

    // The MLP: three layers' weights (the third's padded from 48 to 64, a zero after every 3), then
    // their biases (the third's padded from 3 to 4).
    const WEIGHTS_0_COUNT = 176;
    const WEIGHTS_1_COUNT = 256;
    const WEIGHTS_2_COUNT = 64;
    const BIAS_0_COUNT = 16;
    const BIAS_1_COUNT = 16;
    const BIAS_2_COUNT = 4;
    const MLP_FLOATS = WEIGHTS_0_COUNT + WEIGHTS_1_COUNT + WEIGHTS_2_COUNT + BIAS_0_COUNT + BIAS_1_COUNT + BIAS_2_COUNT;

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

    // --- mlp.json -----------------------------------------------------------------------------

    // Reads the numbers of mlp.json's arrays: { "obj_num": 1, "0_weights": [[...], ...], "0_bias":
    // [...], ... }.
    class MlpReader {
        private bytes: int[];
        private pos: int;

        constructor() {
            this.bytes = [];
            this.pos = 0;
        }

        read(file: BinaryFile): boolean {
            const size = file.getSize();
            for (let i = 0; i < size; i++) {
                this.bytes.push(0);
            }
            if (size == 0) {
                return false;
            }
            file.copyBytes(0, size, Ref(this.bytes[0]));
            return true;
        }

        // Moves past "key": ; false if the key isn't there.
        findKey(key: string): boolean {
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

        isNumberStart(c: int): boolean {
            return (c >= CHAR_0 && c <= CHAR_9) || c == CHAR_MINUS || c == CHAR_PLUS || c == CHAR_DOT;
        }

        // A JSON number at the position.
        readNumber(): number {
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
        readArray(): number[] {
            let values: number[] = [];
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

    // The sample's initialize_mlp_uniform_buffers: the layers' weights and biases, padded.
    function loadMlp(app: App, path: string, dst: f32[]): boolean {
        const file = app.loadBinaryFile(path);
        const reader = new MlpReader();
        if (file.isNull() || !reader.read(file)) {
            return false;
        }
        app.releaseObject(file.handle);
        const weights0 = reader.array("0_weights");
        const weights1 = reader.array("1_weights");
        const weights2 = reader.array("2_weights");
        const bias0 = reader.array("0_bias");
        const bias1 = reader.array("1_bias");
        const bias2 = reader.array("2_bias");
        if (weights0.length != WEIGHTS_0_COUNT || weights1.length != WEIGHTS_1_COUNT || weights2.length != WEIGHTS_2_COUNT - 16
            || bias0.length != BIAS_0_COUNT || bias1.length != BIAS_1_COUNT || bias2.length != BIAS_2_COUNT - 1) {
            console.log(`Unexpected MLP data in ${path}`);
            return false;
        }
        for (let i = 0; i < MLP_FLOATS; i++) {
            dst.push(0.0);
        }
        let o = 0;
        for (let i = 0; i < WEIGHTS_0_COUNT; i++) {
            dst[o + i] = weights0[i];
        }
        o += WEIGHTS_0_COUNT;
        for (let i = 0; i < WEIGHTS_1_COUNT; i++) {
            dst[o + i] = weights1[i];
        }
        o += WEIGHTS_1_COUNT;
        let raw = 0;
        for (let i = 0; i < WEIGHTS_2_COUNT; i++) {
            dst[o + i] = (i + 1) % 4 == 0 ? 0.0 : weights2[raw++];
        }
        o += WEIGHTS_2_COUNT;
        for (let i = 0; i < BIAS_0_COUNT; i++) {
            dst[o + i] = bias0[i];
        }
        o += BIAS_0_COUNT;
        for (let i = 0; i < BIAS_1_COUNT; i++) {
            dst[o + i] = bias1[i];
        }
        o += BIAS_1_COUNT;
        for (let i = 0; i < BIAS_2_COUNT; i++) {
            dst[o + i] = (i + 1) % 4 == 0 ? 0.0 : bias2[i];
        }
        return true;
    }

    // --- Math (glm's layout: 4 x 4 matrices by columns) ---------------------------------------

    function identity(): number[] {
        return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    }

    // a * b.
    function multiply(a: number[], b: number[]): number[] {
        let result: number[] = [];
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
    function rotate(m: number[], angle: number, x: number, y: number, z: number): number[] {
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

    function radians(degrees: number): number {
        return degrees * Math.PI / 180.0;
    }

    // glm::perspective (right-handed, depth from 0 to 1).
    function perspective(fov: number, aspect: number, zNear: number, zFar: number): number[] {
        const tanHalfFovy = Math.tan(0.5 * fov);
        return [
            1.0 / (aspect * tanHalfFovy), 0.0,               0.0,                              0.0,
            0.0,                          1.0 / tanHalfFovy, 0.0,                              0.0,
            0.0,                          0.0,               zFar / (zNear - zFar),            -1.0,
            0.0,                          0.0,               -(zFar * zNear) / (zFar - zNear), 0.0,
        ];
    }

    function normalize(v: number[]): number[] {
        const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        return [v[0] / length, v[1] / length, v[2] / length];
    }

    function cross(a: number[], b: number[]): number[] {
        return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    }

    function dot(a: number[], b: number[]): number {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }

    // The sample's camera (the framework's vkb::Camera, look-at type), with ApiVulkanSample's mouse
    // controls: the left button turns it, the right one zooms, the middle one pans.
    class SampleCamera {
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
        setLookAt(eye: number[], look: number[], up: number[]): void {
            const f = normalize([look[0] - eye[0], look[1] - eye[1], look[2] - eye[2]]);
            const s = normalize(cross(f, up));
            const u = cross(s, f);
            // The view's rotation by columns (Row[i] in glm::decompose is the matrix's column i).
            const row0 = [s[0], u[0], -f[0]];
            const row1 = [s[1], u[1], -f[1]];
            const row2 = [s[2], u[2], -f[2]];
            const translation = [-dot(s, eye), -dot(u, eye), dot(f, eye)];

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
                const rows = [row0, row1, row2];
                let i = 0;
                if (row1[1] > row0[0]) {
                    i = 1;
                }
                if (row2[2] > rows[i][i]) {
                    i = 2;
                }
                const j = (i + 1) % 3;
                const k = (j + 1) % 3;
                let root = Math.sqrt(rows[i][i] - rows[j][j] - rows[k][k] + 1.0);
                let q = [0.0, 0.0, 0.0];
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
        view(): number[] {
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
        mouseButton(button: int, action: int): void {
            if (button >= 0 && button < 3) {
                this.buttons[button] = action == 1;
            }
        }

        // ApiVulkanSample::handle_mouse_move, with its speeds (1).
        mouseMove(x: number, y: number): void {
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

    // --- Pass -------------------------------------------------------------------------------

    // One NeRF: its mesh (Donut_LoadGltfMesh: the framework's loader also ignores the nodes), its
    // feature textures and MLP, and the binding set for them.
    class NerfModel {
        mesh: GltfMesh;
        weights: f32[];
        weightsBuffer: Opaque;
        bindingSet: BindingSet;

        constructor(mesh: GltfMesh, weights: f32[]) {
            this.mesh = mesh;
            this.weights = weights;
        }
    }

    // Port of Vulkan-Samples' mobile_nerf (after Google's MobileNeRF): neural radiance fields baked
    // into textured meshes. Each mesh is rasterized with two feature textures (8 channels per
    // pixel); its pixel shader runs them and the view direction through the model's small MLP
    // (11 inputs, two hidden layers of 16) for the color. As the sample by default: forward
    // rendering (the MLP in the mesh's own pass), four Lego models side by side, each instanced 2 x
    // 2 x 2 times.
    class MobileNerfPass {
        private app: App;
        private camera: SampleCamera;

        private vs: Opaque;
        private ps: Opaque;
        private inputLayout: Opaque;
        private bindingLayout: Opaque;
        private globalBuffer: Opaque;
        private instanceBuffer: Opaque;
        private instanceCount: int;
        private models: NerfModel[];

        // The depth buffer and a framebuffer per back buffer, for the back buffers' size, and the
        // pipeline made for them.
        private depth: Opaque;
        private framebuffers: Opaque[];
        private targetWidth: int;
        private targetHeight: int;
        private pipeline: Opaque;
        private pipelineCreated: boolean;

        // Upload buffer.
        private ubo: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
            this.camera.setLookAt([CAMERA_POSITION[0], -CAMERA_POSITION[1], CAMERA_POSITION[2]], [0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0]);
            this.models = [];
            this.instanceCount = 0;
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.pipelineCreated = false;
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
        }

        onMousePos(x: number, y: number): int {
            this.camera.mouseMove(x, y);
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            this.camera.mouseButton(button, action);
            return 1;
        }

        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        // The framebuffers of the back buffers go before the back buffers do.
        onBackBufferResizing(): void {
            this.releaseTargets();
        }

        releaseTargets(): void {
            for (let i = 0; i < this.framebuffers.length; i++) {
                this.app.releaseResource(this.framebuffers[i]);
            }
            if (this.framebuffers.length > 0) {
                this.app.releaseResource(this.depth);
            }
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
        }

        createTargets(width: int, height: int): void {
            this.releaseTargets();
            this.depth = this.app.createDepthTexture(width, height, Format.D32, 1.0, "Depth");
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), this.depth));
            }
            // The sample's pipeline: depth tested (less) and written, no culling, no blending.
            if (!this.pipelineCreated) {
                const desc = GraphicsPipelineDesc.create(this.vs, this.ps);
                desc.setInputLayout(this.inputLayout);
                desc.addBindingLayout(this.bindingLayout);
                desc.setDepthState(1, 1, ComparisonFunc.Less);
                desc.setRasterState(CullMode.None, FillMode.Solid, 1);
                this.pipeline = this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]);
                this.pipelineCreated = true;
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            // The sample's update_uniform_buffers: its projection (clip y negated for Donut), view,
            // camera position (the view's translation, as the framework keeps it) and axes.
            const projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            const u = this.ubo;
            for (let i = 0; i < 16; i++) {
                u[UBO_VIEW + i] = view[i];
                u[UBO_PROJ + i] = i % 4 == 1 ? -projection[i] : projection[i];
            }
            for (let i = 0; i < 3; i++) {
                u[UBO_CAMERA_POSITION + i] = this.camera.position[i];
                u[UBO_CAMERA_SIDE + i] = view[i * 4];
                u[UBO_CAMERA_UP + i] = view[i * 4 + 1];
                u[UBO_CAMERA_LOOKAT + i] = -view[i * 4 + 2];
            }
            u[UBO_IMG_DIM] = width;
            u[UBO_IMG_DIM + 1] = height;
            u[UBO_TAN_HALF_FOV] = Math.tan(0.5 * radians(CAMERA_FOV));

            // The render pass: color cleared to black, depth to 1.
            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), 0.0, 0.0, 0.0, 1.0);
            commandList.clearDepth(this.depth, 1.0);
            const framebuffer = this.framebuffers[index];

            // Each model, with its transform and MLP, instanced.
            for (let m = 0; m < this.models.length; m++) {
                const model = this.models[m];
                const transform = identity();
                transform[12] = COMBO_TRANSLATIONS[m * 3];
                transform[13] = COMBO_TRANSLATIONS[m * 3 + 1];
                transform[14] = COMBO_TRANSLATIONS[m * 3 + 2];
                for (let i = 0; i < 16; i++) {
                    u[UBO_MODEL + i] = transform[i];
                }
                commandList.writeBuffer(this.globalBuffer, Ref(u[0]), UBO_FLOATS * 4);
                commandList.writeBuffer(model.weightsBuffer, Ref(model.weights[0]), MLP_FLOATS * 4);

                frame.beginDrawToFramebuffer(this.pipeline, framebuffer);
                frame.drawAddBindingSet(model.bindingSet);
                frame.drawSetIndexBuffer(model.mesh.getIndexBuffer());
                frame.drawAddVertexBuffer(model.mesh.getVertexBuffer(), 0, 0);
                frame.drawAddVertexBuffer(this.instanceBuffer, 1, 0);
                frame.drawIndexedInstanced(model.mesh.getIndexCount(), this.instanceCount);
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "mobile_nerf.hlsl";
            this.vs = this.app.createShader(shader, "raster_vs", ShaderType.Vertex);
            this.ps = this.app.createShader(shader, "merged_ps", ShaderType.Pixel);
            if (!this.vs || !this.ps) {
                return false;
            }

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_SIZE);
            layoutDesc.addInstanceVertexAttribute("INSTANCE_OFFSET", Format.RGB32_FLOAT, 0, 1, 12);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vs);

            // The sample's prepare_instance_data: a grid of offsets around the origin.
            let offsets: f32[] = [];
            for (let x = 0; x < INSTANCE_DIM[0]; x++) {
                for (let y = 0; y < INSTANCE_DIM[1]; y++) {
                    for (let z = 0; z < INSTANCE_DIM[2]; z++) {
                        const index = [x, y, z];
                        for (let i = 0; i < 3; i++) {
                            offsets.push(-INSTANCE_INTERVAL[i] * 0.5 * (INSTANCE_DIM[i] - 1) + INSTANCE_INTERVAL[i] * index[i]);
                        }
                    }
                }
            }
            this.instanceCount = offsets.length / 3;

            // Feature textures: linear (UNORM), filtered bilinearly at their first level only (the
            // framework uploads PNGs without mip maps), clamped.
            const sampler = this.app.createSamplerWithDesc(1, 1, 0, SamplerAddressMode.Clamp, 0.0, 0.0, 0.0, 1.0);
            this.globalBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "GlobalUniform");
            const layout = BindingLayoutDesc.create();
            layout.layoutVolatileConstantBuffer(0);
            layout.layoutVolatileConstantBuffer(1);
            layout.layoutTextureSRV(0);
            layout.layoutTextureSRV(1);
            layout.layoutSampler(0);
            this.bindingLayout = this.app.createBindingLayout(layout, ShaderType.All);

            const commandList = this.app.createCommandList();
            commandList.open();
            this.instanceBuffer = this.app.createStaticVertexBuffer(commandList, Ref(offsets[0]), offsets.length * 4, "Instances");
            let loaded = true;
            for (let m = 0; m < MODELS.length && loaded; m++) {
                const dir = MEDIA_DIR + MODELS[m] + "/";
                let weights: f32[] = [];
                const mesh = this.app.loadGltfMesh(commandList, dir + "shape0.gltf");
                const feature0 = this.app.loadTexture(commandList, dir + "shape0.pngfeat0.png", 0);
                const feature1 = this.app.loadTexture(commandList, dir + "shape0.pngfeat1.png", 0);
                if (mesh.isNull() || !feature0 || !feature1 || !loadMlp(this.app, dir + "mlp.json", weights)) {
                    loaded = false;
                    break;
                }
                const model = new NerfModel(mesh, weights);
                model.weightsBuffer = this.app.createVolatileConstantBuffer(MLP_FLOATS * 4, `MLP ${m}`);
                const setDesc = BindingSetDesc.create();
                setDesc.bindEntireConstantBuffer(0, this.globalBuffer);
                setDesc.bindEntireConstantBuffer(1, model.weightsBuffer);
                setDesc.bindTextureSRV(0, feature0);
                setDesc.bindTextureSRV(1, feature1);
                setDesc.bindSampler(0, sampler);
                model.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);
                this.models.push(model);
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded) {
                console.log("Cannot load the NeRF models: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            const pass = this.app.addPass();
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("mobile_nerf");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        let options = AppOptions.None;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new MobileNerfPass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return MobileNerf.main(argc, argv);
}

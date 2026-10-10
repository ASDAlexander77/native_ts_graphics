// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace MobileNerfRayQuery {
    const WINDOW_TITLE = "Donut Example: Mobile NeRF Ray Query";

    // The sample's default scene, lego_combo: four of Morpheus team's Lego NeRFs (Vulkan-Samples'
    // assets, mobile_nerf's copy; see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt), each a mesh, two
    // feature textures and an MLP.
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
    const Z_FAR = 200.0;
    // ApiVulkanSample's default_clear_color.
    const CLEAR_COLOR = 0.002;

    // Donut_LoadGltfModel's vertices: float3 position, float3 normal, float2 texture coordinates.
    const GLTF_VERTEX_FLOATS = 8;
    // The sample's Vertex: float3 position, float2 texture coordinates.
    const VERTEX_FLOATS = 5;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;

    // struct GlobalUniform { float4x4 view_inverse, proj_inverse; float2 img_dim; float
    // tan_half_fov; } padded, then float4 model_offsets[4] (first vertex, first index: exact as floats).
    const UBO_VIEW_INVERSE = 0;
    const UBO_PROJ_INVERSE = 16;
    const UBO_IMG_DIM = 32;
    const UBO_TAN_HALF_FOV = 34;
    const UBO_MODEL_OFFSETS = 36;
    const UBO_FLOATS = 52;

    // The MLP: three layers' weights (the third's padded from 48 to 64, a zero after every 3), then
    // their biases (the third's padded from 3 to 4).
    const WEIGHTS_0_COUNT = 176;
    const WEIGHTS_1_COUNT = 256;
    const WEIGHTS_2_COUNT = 64;
    const BIAS_0_COUNT = 16;
    const BIAS_1_COUNT = 16;
    const BIAS_2_COUNT = 4;
    const MLP_FLOATS = WEIGHTS_0_COUNT + WEIGHTS_1_COUNT + WEIGHTS_2_COUNT + BIAS_0_COUNT + BIAS_1_COUNT + BIAS_2_COUNT;

    // nvrhi::rt::InstanceFlags::TriangleCullDisable.
    const INSTANCE_FLAGS_CULL_DISABLE = 1;

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

    // The sample's initialize_mlp_uniform_buffers: the layers' weights and biases, padded, appended
    // to dst.
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
        for (let i = 0; i < WEIGHTS_0_COUNT; i++) {
            dst.push(weights0[i]);
        }
        for (let i = 0; i < WEIGHTS_1_COUNT; i++) {
            dst.push(weights1[i]);
        }
        let raw = 0;
        for (let i = 0; i < WEIGHTS_2_COUNT; i++) {
            dst.push((i + 1) % 4 == 0 ? 0.0 : weights2[raw++]);
        }
        for (let i = 0; i < BIAS_0_COUNT; i++) {
            dst.push(bias0[i]);
        }
        for (let i = 0; i < BIAS_1_COUNT; i++) {
            dst.push(bias1[i]);
        }
        for (let i = 0; i < BIAS_2_COUNT; i++) {
            dst.push((i + 1) % 4 == 0 ? 0.0 : bias2[i]);
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

    // The inverse of m, by Gauss-Jordan elimination with partial pivoting.
    function inverse(m: number[]): number[] {
        // Rows of [m | I].
        let a: number[] = [];
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
        let result: number[] = [];
        for (let column = 0; column < 4; column++) {
            for (let row = 0; row < 4; row++) {
                result.push(a[row * 8 + 4 + column]);
            }
        }
        return result;
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

    // Port of Vulkan-Samples' mobile_nerf_rayquery (after Google's MobileNeRF): mobile_nerf's
    // neural radiance fields (see mobile_nerf.ts), found by ray queries instead of rasterization.
    // A triangle over the screen; each pixel traces its ray inline through a TLAS of the NeRF
    // meshes (one BLAS per model, 2 x 2 x 2 instances of each, the instance's custom index the
    // model's), reads the hit's texture coordinates from the model's vertices and runs its feature
    // textures through the model's MLP. Missed pixels keep the clear color.
    class MobileNerfRayQueryPass {
        private app: App;
        private camera: SampleCamera;

        private vs: ShaderHandle;
        private ps: ShaderHandle;
        private bindingLayout: BindingLayoutHandle;
        private bindingSet: BindingSet;
        private globalBuffer: BufferHandle;
        private weightsBuffer: BufferHandle;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        private blases: TriangleBlas[];
        private topLevelAS: SceneAccelStructs;
        private topLevelASBuilt: boolean;
        // The models' MLPs, one after the other, and their first vertex and index.
        private weights: f32[];
        private modelOffsets: int[];

        // A framebuffer per back buffer, for the back buffers' size, and the pipeline made for them.
        private framebuffers: FramebufferHandle[];
        private targetWidth: int;
        private targetHeight: int;
        private pipeline: GraphicsPipelineHandle;
        private pipelineCreated: boolean;

        // Upload buffers.
        private ubo: f32[];
        private transform: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
            this.camera.setLookAt([CAMERA_POSITION[0], -CAMERA_POSITION[1], CAMERA_POSITION[2]], [0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0]);
            this.blases = [];
            this.topLevelASBuilt = false;
            this.weights = [];
            this.modelOffsets = [];
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.pipelineCreated = false;
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
            this.transform = [];
            for (let i = 0; i < 12; i++) {
                this.transform.push(0.0);
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
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
        }

        createTargets(width: int, height: int): void {
            this.releaseTargets();
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), null));
            }
            // The sample's pipeline draws a triangle over the screen: no culling, nothing blended
            // (its depth test passes everywhere, the triangle's depth being 0).
            if (!this.pipelineCreated) {
                const desc = GraphicsPipelineDesc.create(this.vs, this.ps);
                desc.addBindingLayout(this.bindingLayout);
                desc.setDepthState(0, 0, ComparisonFunc.Always);
                desc.setRasterState(CullMode.None, FillMode.Solid, 1);
                this.pipeline = this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]);
                this.pipelineCreated = true;
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        // The sample's create_top_level_acceleration_structure: each model in each place of the
        // instancing grid, its custom index the model's (for its buffers, textures and weights).
        buildTopLevelAS(frame: Frame): void {
            const tlas = this.topLevelAS;
            let offset = [0.0, 0.0, 0.0];
            for (let x = 0; x < INSTANCE_DIM[0]; x++) {
                offset[0] = -INSTANCE_INTERVAL[0] * 0.5 * (INSTANCE_DIM[0] - 1) + INSTANCE_INTERVAL[0] * x;
                for (let y = 0; y < INSTANCE_DIM[1]; y++) {
                    offset[1] = -INSTANCE_INTERVAL[1] * 0.5 * (INSTANCE_DIM[1] - 1) + INSTANCE_INTERVAL[1] * y;
                    for (let z = 0; z < INSTANCE_DIM[2]; z++) {
                        offset[2] = -INSTANCE_INTERVAL[2] * 0.5 * (INSTANCE_DIM[2] - 1) + INSTANCE_INTERVAL[2] * z;
                        // Rows of a 3 x 4 matrix: identity, translated.
                        for (let i = 0; i < 12; i++) {
                            this.transform[i] = i % 5 == 0 ? 1.0 : 0.0;
                        }
                        this.transform[3] = offset[0];
                        this.transform[7] = offset[1];
                        this.transform[11] = offset[2];
                        for (let m = 0; m < this.blases.length; m++) {
                            tlas.addInstanceWithTransform(this.blases[m].getAccelStruct(), 0xFF, m, INSTANCE_FLAGS_CULL_DISABLE,
                                Ref(this.transform[0]));
                        }
                    }
                }
            }
            frame.buildTopLevelAS(tlas);
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            if (!this.topLevelASBuilt) {
                this.buildTopLevelAS(frame);
                this.topLevelASBuilt = true;
            }

            // The sample's update_uniform_buffer: the inverses of its view and projection (glm's,
            // no y flip: the shader takes SV_Position's y as the sample's gl_FragCoord's).
            const viewInverse = inverse(this.camera.view());
            const projInverse = inverse(perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR));
            const u = this.ubo;
            for (let i = 0; i < 16; i++) {
                u[UBO_VIEW_INVERSE + i] = viewInverse[i];
                u[UBO_PROJ_INVERSE + i] = projInverse[i];
            }
            u[UBO_IMG_DIM] = width;
            u[UBO_IMG_DIM + 1] = height;
            u[UBO_TAN_HALF_FOV] = Math.tan(0.5 * radians(CAMERA_FOV));
            commandList.writeBuffer(this.globalBuffer, Ref(u[0]), UBO_FLOATS * 4);
            commandList.writeBuffer(this.weightsBuffer, Ref(this.weights[0]), this.weights.length * 4);

            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
            frame.beginDrawToFramebuffer(this.pipeline, this.framebuffers[index]);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawVertices(3);
        }

        // The sample's load_scene, create_static_object_buffers and
        // create_bottom_level_acceleration_structure for every model: its meshes' vertices (y
        // flipped, v flipped) and triangles, appended to one vertex and one index buffer, and a BLAS
        // of them with the model's combo transform (y negated, as the sample's vertices are).
        loadModels(commandList: CommandList): boolean {
            let vertices: f32[] = [];
            let indices: int[] = [];
            let firstVertices: int[] = [];
            let firstIndices: int[] = [];
            let counts: int[] = [];
            for (let m = 0; m < MODELS.length; m++) {
                const path = MEDIA_DIR + MODELS[m] + "/shape0.gltf";
                const scene = this.app.loadGltfModel(path);
                if (scene.isNull()) {
                    return false;
                }
                const firstVertex = vertices.length / VERTEX_FLOATS;
                const firstIndex = indices.length;
                for (let p = 0; p < scene.getPrimitiveCount(); p++) {
                    const vertexStart = vertices.length / VERTEX_FLOATS - firstVertex;
                    const vertexCount = scene.getVertexCount(p);
                    const indexCount = scene.getIndexCount(p);
                    let gltfVertices: f32[] = [];
                    for (let i = 0; i < vertexCount * GLTF_VERTEX_FLOATS; i++) {
                        gltfVertices.push(0.0);
                    }
                    let gltfIndices: int[] = [];
                    for (let i = 0; i < indexCount; i++) {
                        gltfIndices.push(0);
                    }
                    scene.copyVertices(p, Ref(gltfVertices[0]));
                    scene.copyIndices(p, Ref(gltfIndices[0]));
                    for (let v = 0; v < vertexCount; v++) {
                        const g = v * GLTF_VERTEX_FLOATS;
                        vertices.push(gltfVertices[g]);
                        vertices.push(-gltfVertices[g + 1]);
                        vertices.push(gltfVertices[g + 2]);
                        vertices.push(gltfVertices[g + 6]);
                        vertices.push(1.0 - gltfVertices[g + 7]);
                    }
                    for (let i = 0; i < indexCount; i++) {
                        indices.push(vertexStart + gltfIndices[i]);
                    }
                }
                this.app.releaseResource(scene.handle);
                firstVertices.push(firstVertex);
                firstIndices.push(firstIndex);
                counts.push(vertices.length / VERTEX_FLOATS - firstVertex);
                counts.push(indices.length - firstIndex);
                this.modelOffsets.push(firstVertex);
                this.modelOffsets.push(firstIndex);
            }

            const vertexCount = vertices.length / VERTEX_FLOATS;
            this.vertexBuffer = this.app.createAccelStructInputStructuredBuffer(4, vertexCount * VERTEX_FLOATS, "Vertices");
            this.indexBuffer = this.app.createAccelStructInputStructuredBuffer(4, indices.length, "Indices");
            commandList.writeBuffer(this.vertexBuffer, Ref(vertices[0]), vertexCount * VERTEX_SIZE);
            commandList.writeBuffer(this.indexBuffer, Ref(indices[0]), indices.length * 4);

            let geometryTransform: f32[] = [];
            for (let i = 0; i < 12; i++) {
                geometryTransform.push(i % 5 == 0 ? 1.0 : 0.0);
            }
            for (let m = 0; m < MODELS.length; m++) {
                geometryTransform[3] = COMBO_TRANSLATIONS[m * 3];
                geometryTransform[7] = -COMBO_TRANSLATIONS[m * 3 + 1];
                geometryTransform[11] = COMBO_TRANSLATIONS[m * 3 + 2];
                const blas = this.app.createEmptyTriangleBlas(`Model #${m} BLAS`);
                blas.addGeometry(this.indexBuffer, firstIndices[m] * 4, counts[m * 2 + 1], this.vertexBuffer,
                    firstVertices[m] * VERTEX_SIZE, counts[m * 2], VERTEX_SIZE, Ref(geometryTransform[0]));
                if (blas.build(this.app, commandList, AccelStructBuildFlags.PreferFastTrace) == 0) {
                    return false;
                }
                this.blases.push(blas);
            }
            return true;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "mobile_nerf_rayquery.hlsl";
            this.vs = this.app.createShader(shader, "quad_vs", ShaderType.Vertex);
            this.ps = this.app.createShader(shader, "rayquery_ps", ShaderType.Pixel);
            if (!this.vs || !this.ps) {
                return false;
            }

            for (let m = 0; m < MODELS.length; m++) {
                if (!loadMlp(this.app, MEDIA_DIR + MODELS[m] + "/mlp.json", this.weights)) {
                    console.log("Cannot load the NeRF models: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                    return false;
                }
            }

            const commandList = this.app.createCommandList();
            commandList.open();
            let loaded = this.loadModels(commandList);
            let features0: TextureHandle[] = [];
            let features1: TextureHandle[] = [];
            for (let m = 0; m < MODELS.length && loaded; m++) {
                const dir = MEDIA_DIR + MODELS[m] + "/";
                const feature0 = this.app.loadTexture(commandList, dir + "shape0.pngfeat0.png", 0);
                const feature1 = this.app.loadTexture(commandList, dir + "shape0.pngfeat1.png", 0);
                if (!feature0 || !feature1) {
                    loaded = false;
                    break;
                }
                features0.push(feature0);
                features1.push(feature1);
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded) {
                console.log("Cannot load the NeRF models: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            this.topLevelAS = this.app.createTopLevelAS(MODELS.length * INSTANCE_DIM[0] * INSTANCE_DIM[1] * INSTANCE_DIM[2]);

            for (let m = 0; m < MODELS.length; m++) {
                const k = UBO_MODEL_OFFSETS + m * 4;
                this.ubo[k] = this.modelOffsets[m * 2];
                this.ubo[k + 1] = this.modelOffsets[m * 2 + 1];
            }

            // Feature textures: linear (UNORM), filtered bilinearly at their first level only (the
            // framework uploads PNGs without mip maps), clamped.
            const sampler = this.app.createSamplerWithDesc(1, 1, 0, SamplerAddressMode.Clamp, 0.0, 0.0, 0.0, 1.0);
            this.globalBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "GlobalUniform");
            this.weightsBuffer = this.app.createVolatileConstantBuffer(this.weights.length * 4, "MLP weights");
            const layout = BindingLayoutDesc.create();
            layout.layoutVolatileConstantBuffer(0);
            layout.layoutVolatileConstantBuffer(1);
            layout.layoutAccelStruct(0);
            layout.layoutStructuredBufferSRV(1);
            layout.layoutStructuredBufferSRV(2);
            layout.layoutTextureSRVArray(3, MODELS.length);
            layout.layoutTextureSRVArray(7, MODELS.length);
            layout.layoutSampler(0);
            this.bindingLayout = this.app.createBindingLayout(layout, ShaderType.All);

            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.globalBuffer);
            setDesc.bindEntireConstantBuffer(1, this.weightsBuffer);
            setDesc.bindAccelStruct(0, this.topLevelAS.getTopLevelAS());
            setDesc.bindStructuredBufferSRV(1, this.vertexBuffer);
            setDesc.bindStructuredBufferSRV(2, this.indexBuffer);
            for (let m = 0; m < MODELS.length; m++) {
                setDesc.bindTextureSRVArrayElement(3, m, features0[m]);
                setDesc.bindTextureSRVArrayElement(7, m, features1[m]);
            }
            setDesc.bindSampler(0, sampler);
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);

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
        Donut_SetAppName("mobile_nerf_rayquery");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        let options = AppOptions.RayTracing;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.RayQuery)) {
            console.log("The graphics device does not support Ray Queries");
            app.destroy();
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new MobileNerfRayQueryPass(app);
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
    return MobileNerfRayQuery.main(argc, argv);
}

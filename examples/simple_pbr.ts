// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace SimplePbr {
    const WINDOW_TITLE = "Donut Example: Simple PBR";
    const MEDIA_DIR = "media/simple_pbr/";
    const FONT_PATH = "media/fonts/OpenSans/OpenSans-Regular.ttf";
    // The sample's SegoeUI_18 sprite font (the one it takes up to 1200 lines),
    // its lines 32 pixels apart.
    // ImGui sizes a font by its ascent + descent (1.3618 OpenSans ems), so the 23 pixel em that gives
    // its strings' widths is 31.5.
    const FONT_SIZE = 31.5;
    const LINE_SPACING = 31.921875;

    // ATG::ColorsHDR::LightGrey: the text, in the HDR scene before tone mapping.
    const LIGHT_GREY_HDR = 0.389235616;

    // SharedSimplePBR.cpp: the models (each with <name>_BaseColor, _Normal and _RMA textures).
    const MODEL_NAMES = ["Floor", "ToyRobot", "WoodBlocks"];
    // The models' vertices: position, normal, texture coordinates, tangent (and a binormal).
    const VERTEX_TANGENT = 32;

    // PBR_Constants of simple_pbr.hlsl, in floats: EyePosition, World, WorldInverseTranspose,
    // WorldViewProj, PrevWorldViewProj, LightDirection[3], LightColor[3], ConstantAlbedo,
    // ConstantMetallic, ConstantRoughness, NumRadianceMipLevels, TargetWidth, TargetHeight.
    const PBR_FLOATS = 128;
    const PBR_WORLD = 4;
    const PBR_WORLD_INVERSE_TRANSPOSE = 20;
    const PBR_WORLD_VIEW_PROJ = 32;
    const PBR_PREV_WORLD_VIEW_PROJ = 48;
    const PBR_LIGHT_DIRECTION = 64;
    const PBR_CONSTANT_ALBEDO = 88;
    const PBR_CONSTANT_METALLIC = 92;
    const PBR_NUM_RADIANCE_MIPS = 94;

    // DirectXTK's ToneMapPostProcess: linear exposure 1, paper white 200 nits, Rec.709 to Rec.2020.
    const TONE_MAP_CONSTANTS = [
        1.0, 200.0, 0.0, 0.0,
        0.6274040, 0.3292820, 0.0433136, 0.0,
        0.0690970, 0.9195400, 0.0113612, 0.0,
        0.0163916, 0.0880132, 0.8955950, 0.0,
    ];

    // GLFW keys and mouse buttons.
    const KEY_A = 65;
    const KEY_D = 68;
    const KEY_S = 83;
    const KEY_W = 87;
    const KEY_RIGHT = 262;
    const KEY_LEFT = 263;
    const KEY_DOWN = 264;
    const KEY_UP = 265;
    const KEY_PAGE_UP = 266;
    const KEY_PAGE_DOWN = 267;
    const KEY_HOME = 268;
    const KEY_END = 269;
    const KEY_LEFT_SHIFT = 340;
    const KEY_RIGHT_SHIFT = 344;
    const MOUSE_LEFT = 0;
    const MOUSE_RIGHT = 1;
    const ACTION_RELEASE = 0;

    // --- DirectXMath ----------------------------------------------------------------------------

    function multiply(a: number[], b: number[]): number[] {
        let m: number[] = [];
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

    function transpose(a: number[]): number[] {
        let m: number[] = [];
        for (let row = 0; row < 4; row++) {
            for (let column = 0; column < 4; column++) {
                m.push(a[column * 4 + row]);
            }
        }
        return m;
    }

    // XMMatrixInverse (by cofactors, in doubles).
    function inverse(m: number[]): number[] {
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

    // XMMatrixRotationY.
    function rotationY(angle: number): number[] {
        const s = Math.fround(Math.sin(angle));
        const c = Math.fround(Math.cos(angle));
        return [c, 0.0, -s, 0.0, 0.0, 1.0, 0.0, 0.0, s, 0.0, c, 0.0, 0.0, 0.0, 0.0, 1.0];
    }

    function normalize3(v: number[]): number[] {
        const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        return [Math.fround(v[0] / length), Math.fround(v[1] / length), Math.fround(v[2] / length)];
    }

    function cross3(a: number[], b: number[]): number[] {
        return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    }

    function dot3(a: number[], b: number[]): number {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }

    // XMMatrixLookAtRH: XMMatrixLookToLH away from the focus.
    function lookAtRH(eye: number[], focus: number[], up: number[]): number[] {
        const r2 = normalize3([eye[0] - focus[0], eye[1] - focus[1], eye[2] - focus[2]]);
        const r0 = normalize3(cross3(up, r2));
        const r1 = cross3(r2, r0);
        const negEye = [-eye[0], -eye[1], -eye[2]];
        return [
            r0[0], r1[0], r2[0], 0.0,
            r0[1], r1[1], r2[1], 0.0,
            r0[2], r1[2], r2[2], 0.0,
            Math.fround(dot3(r0, negEye)), Math.fround(dot3(r1, negEye)), Math.fround(dot3(r2, negEye)), 1.0,
        ];
    }

    // XMMatrixPerspectiveFovRH.
    function perspectiveFovRH(fovY: number, aspect: number, nearZ: number, farZ: number): number[] {
        const height = Math.fround(Math.cos(0.5 * fovY) / Math.sin(0.5 * fovY));
        const width = Math.fround(height / aspect);
        const range = Math.fround(farZ / (nearZ - farZ));
        return [width, 0.0, 0.0, 0.0, 0.0, height, 0.0, 0.0, 0.0, 0.0, range, -1.0, 0.0, 0.0, Math.fround(range * nearZ), 0.0];
    }

    // Quaternions (x, y, z, w). XMQuaternionMultiply(q1, q2): q1's rotation, then q2's.
    function quatMultiply(q1: number[], q2: number[]): number[] {
        return [
            Math.fround(q2[3] * q1[0] + q2[0] * q1[3] + q2[1] * q1[2] - q2[2] * q1[1]),
            Math.fround(q2[3] * q1[1] - q2[0] * q1[2] + q2[1] * q1[3] + q2[2] * q1[0]),
            Math.fround(q2[3] * q1[2] + q2[0] * q1[1] - q2[1] * q1[0] + q2[2] * q1[3]),
            Math.fround(q2[3] * q1[3] - q2[0] * q1[0] - q2[1] * q1[1] - q2[2] * q1[2]),
        ];
    }

    function quatNormalize(q: number[]): number[] {
        const length = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
        return [Math.fround(q[0] / length), Math.fround(q[1] / length), Math.fround(q[2] / length), Math.fround(q[3] / length)];
    }

    // XMQuaternionInverse.
    function quatInverse(q: number[]): number[] {
        const lengthSq = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
        return [Math.fround(-q[0] / lengthSq), Math.fround(-q[1] / lengthSq), Math.fround(-q[2] / lengthSq), Math.fround(q[3] / lengthSq)];
    }

    // XMVector3Rotate: conjugate(q) * v, then * q.
    function rotate3(v: number[], q: number[]): number[] {
        const conjugate = [-q[0], -q[1], -q[2], q[3]];
        const r = quatMultiply(quatMultiply(conjugate, [v[0], v[1], v[2], 0.0]), q);
        return [r[0], r[1], r[2]];
    }

    // --- Geometry -------------------------------------------------------------------------------

    // DirectXTK's ComputeGeoSphere positions (its texture coordinate seams and pole copies only
    // duplicate positions), right-handed: an octahedron subdivided `tessellation` times, pushed onto
    // the sphere.
    function geoSphere(diameter: number, tessellation: int, positions: f32[], indices: int[]): void {
        let vertices: number[] = [0.0, 1.0, 0.0, 0.0, 0.0, -1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, -1.0, 0.0, 0.0, 0.0, -1.0, 0.0];
        let current: int[] = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 5, 1, 4, 5, 4, 3, 5, 3, 2, 5, 2, 1];
        for (let subdivision = 0; subdivision < tessellation; subdivision++) {
            // The edges divided so far (larger index first) and their midpoints.
            let edgeA: int[] = [];
            let edgeB: int[] = [];
            let edgeMid: int[] = [];
            let next: int[] = [];
            const triangleCount = current.length / 3;
            for (let t = 0; t < triangleCount; t++) {
                const iv0 = current[t * 3];
                const iv1 = current[t * 3 + 1];
                const iv2 = current[t * 3 + 2];
                let mids: int[] = [];
                const pairs = [iv0, iv1, iv1, iv2, iv0, iv2];
                for (let e = 0; e < 3; e++) {
                    const i0 = pairs[e * 2];
                    const i1 = pairs[e * 2 + 1];
                    const a = Math.max(i0, i1);
                    const b = Math.min(i0, i1);
                    let found = -1;
                    for (let k = 0; k < edgeA.length; k++) {
                        if (edgeA[k] == a && edgeB[k] == b) {
                            found = edgeMid[k];
                        }
                    }
                    if (found < 0) {
                        found = vertices.length / 3;
                        for (let c = 0; c < 3; c++) {
                            vertices.push(Math.fround(Math.fround(vertices[i0 * 3 + c] + vertices[i1 * 3 + c]) * 0.5));
                        }
                        edgeA.push(a);
                        edgeB.push(b);
                        edgeMid.push(found);
                    }
                    mids.push(found);
                }
                const iv01 = mids[0];
                const iv12 = mids[1];
                const iv20 = mids[2];
                const added = [iv0, iv01, iv20, iv20, iv12, iv2, iv20, iv01, iv12, iv01, iv1, iv12];
                for (let k = 0; k < added.length; k++) {
                    next.push(added[k]);
                }
            }
            current = next;
        }
        const radius = diameter / 2.0;
        for (let i = 0; i < vertices.length / 3; i++) {
            const n = normalize3([vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]]);
            positions.push(Math.fround(n[0] * radius));
            positions.push(Math.fround(n[1] * radius));
            positions.push(Math.fround(n[2] * radius));
        }
        for (let i = 0; i < current.length; i++) {
            indices.push(current[i]);
        }
    }

    // A PBR model as ATG::PBRModel loads it: the SDKMESH file's buffers and mesh parts (DirectXTK's
    // Model, drawn with one effect, the frames' transforms not applied) and the textures named after
    // it: albedo (forced to sRGB), normal and roughness / metallic / ambient occlusion.
    class Model {
        vertexBuffers: BufferHandle[];
        indexBuffers: BufferHandle[];
        index32: boolean[];
        partVertexBuffers: int[];
        partIndexBuffers: int[];
        partIndexCounts: int[];
        partStartIndices: int[];
        partVertexOffsets: int[];
        vertexStride: int;
        albedo: TextureHandle;
        normal: TextureHandle;
        rma: TextureHandle;

        constructor() {
            this.vertexBuffers = [];
            this.indexBuffers = [];
            this.index32 = [];
            this.partVertexBuffers = [];
            this.partIndexBuffers = [];
            this.partIndexCounts = [];
            this.partStartIndices = [];
            this.partVertexOffsets = [];
            this.vertexStride = 0;
        }

        // False (after printing why) on failure.
        load(app: App, commandList: CommandList, name: string): boolean {
            const binaryFile = app.loadBinaryFile(MEDIA_DIR + name + ".sdkmesh");
            if (binaryFile.isNull()) {
                return false;
            }
            const loaded = Donut_LoadSdkMesh(binaryFile.getData(), binaryFile.getSize());
            if (!loaded) {
                app.releaseObject(binaryFile.handle);
                return false;
            }
            const mesh = loaded as Opaque;
            let ok = true;
            this.vertexStride = Donut_GetSdkMeshVertexBufferStride(mesh, 0);
            for (let i = 0; i < Donut_GetSdkMeshVertexBufferCount(mesh); i++) {
                // ATG::VertexPositionNormalTextureTangent's input layout over the file's vertices.
                if (Donut_GetSdkMeshVertexElementOffset(mesh, i, 6, 0) != VERTEX_TANGENT
                    || Donut_GetSdkMeshVertexBufferStride(mesh, i) != this.vertexStride) {
                    console.log(`${name}: unexpected vertex layout`);
                    ok = false;
                }
                this.vertexBuffers.push(app.createStaticVertexBuffer(commandList, Donut_GetSdkMeshVertexBufferData(mesh, i),
                    Donut_GetSdkMeshVertexBufferSize(mesh, i), name));
            }
            for (let i = 0; i < Donut_GetSdkMeshIndexBufferCount(mesh); i++) {
                this.indexBuffers.push(app.createStaticIndexBuffer(commandList, Donut_GetSdkMeshIndexBufferData(mesh, i),
                    Donut_GetSdkMeshIndexBufferSize(mesh, i), name));
                this.index32.push(Donut_IsSdkMeshIndexBuffer32Bit(mesh, i) != 0);
            }
            for (let m = 0; m < Donut_GetSdkMeshMeshCount(mesh); m++) {
                for (let j = 0; j < Donut_GetSdkMeshMeshSubsetCount(mesh, m); j++) {
                    const subset = Donut_GetSdkMeshMeshSubset(mesh, m, j);
                    if (Donut_GetSdkMeshSubsetPrimitiveType(mesh, subset) != 0) {
                        console.log(`${name}: only triangle lists are supported`);
                        ok = false;
                    }
                    this.partVertexBuffers.push(Donut_GetSdkMeshMeshVertexBuffer(mesh, m));
                    this.partIndexBuffers.push(Donut_GetSdkMeshMeshIndexBuffer(mesh, m));
                    this.partIndexCounts.push(Donut_GetSdkMeshSubsetIndexCount(mesh, subset));
                    this.partStartIndices.push(Donut_GetSdkMeshSubsetIndexStart(mesh, subset));
                    this.partVertexOffsets.push(Donut_GetSdkMeshSubsetVertexStart(mesh, subset));
                }
            }
            Donut_DestroySdkMesh(mesh);
            app.releaseObject(binaryFile.handle);

            const albedo = app.loadTexture(commandList, MEDIA_DIR + name + "_BaseColor.dds", 1);
            const normal = app.loadTexture(commandList, MEDIA_DIR + name + "_Normal.dds", 0);
            const rma = app.loadTexture(commandList, MEDIA_DIR + name + "_RMA.dds", 0);
            if (!albedo || !normal || !rma) {
                return false;
            }
            this.albedo = albedo as TextureHandle;
            this.normal = normal as TextureHandle;
            this.rma = rma as TextureHandle;
            return ok;
        }
    }

    // The mouse and keys as DirectXTK's Mouse and Keyboard report them: held keys and buttons, the
    // cursor position, the wheel's total (120 a notch), and in relative mode (the right button
    // held) the cursor's movement since the last update.
    class InputState {
        held: boolean[];
        leftButton: boolean;
        rightButton: boolean;
        x: number;
        y: number;
        deltaX: number;
        deltaY: number;
        scrollWheel: number;
        relative: boolean;

        constructor() {
            this.held = [];
            for (let i = 0; i < 512; i++) {
                this.held.push(false);
            }
            this.leftButton = false;
            this.rightButton = false;
            this.x = 0.0;
            this.y = 0.0;
            this.deltaX = 0.0;
            this.deltaY = 0.0;
            this.scrollWheel = 0.0;
            this.relative = false;
        }
    }

    // --- The camera -----------------------------------------------------------------------------

    // ATGTK's OrbitCamera with the sample's settings, right-handed, driven by the mouse and keys as
    // its Update(Mouse, Keyboard): the left button turns it (an ArcBall), the right button moves its
    // focus, the wheel sets its radius; W A S D / arrows / Page Up / Page Down move the focus
    // (Shift: slower), Home resets it, End resets the focus and radius.
    class OrbitCamera {
        focus: number[];
        homeFocus: number[];
        rotation: number[];
        homeRotation: number[];
        radius: number;
        defaultRadius: number;
        minRadius: number;
        radiusRate: number;
        sensitivity: number;
        fov: number;
        nearDistance: number;
        farDistance: number;
        width: int;
        height: int;
        cameraPosition: number[];

        // ArcBall
        private dragging: boolean;
        private qdown: number[];
        private qnow: number[];
        private downPoint: number[];

        constructor() {
            this.focus = [0.0, 0.0, 0.0];
            this.homeFocus = [0.0, 0.0, 0.0];
            this.rotation = [0.0, 0.0, 0.0, 1.0];
            this.homeRotation = [0.0, 0.0, 0.0, 1.0];
            this.radius = 5.0;
            this.defaultRadius = 5.0;
            this.minRadius = 1.0;
            this.radiusRate = 1.0;
            this.sensitivity = 1.0;
            this.fov = Math.fround(Math.PI / 4.0);
            this.nearDistance = 0.1;
            this.farDistance = 10000.0;
            this.width = 1280;
            this.height = 720;
            this.cameraPosition = [0.0, 0.0, 0.0];
            this.dragging = false;
            this.qdown = [0.0, 0.0, 0.0, 1.0];
            this.qnow = [0.0, 0.0, 0.0, 1.0];
            this.downPoint = [0.0, 0.0, 0.0];
        }

        reset(): void {
            this.focus = [this.homeFocus[0], this.homeFocus[1], this.homeFocus[2]];
            this.radius = this.defaultRadius;
            this.rotation = [this.homeRotation[0], this.homeRotation[1], this.homeRotation[2], this.homeRotation[3]];
            this.sensitivity = 1.0;
            this.qdown = [0.0, 0.0, 0.0, 1.0];
            this.qnow = [0.0, 0.0, 0.0, 1.0];
            this.dragging = false;
        }

        // GetView: the camera radius away from the focus along the rotated +z, LookAtRH.
        getView(): number[] {
            const dir = rotate3([0.0, 0.0, 1.0], this.rotation);
            const up = rotate3([0.0, 1.0, 0.0], this.rotation);
            for (let i = 0; i < 3; i++) {
                this.cameraPosition[i] = Math.fround(this.focus[i] + Math.fround(dir[i] * this.radius));
            }
            return lookAtRH(this.cameraPosition, this.focus, up);
        }

        getProjection(): number[] {
            let aspectRatio = 1.0;
            if (this.height > 0) {
                aspectRatio = Math.fround(this.width / this.height);
            }
            return perspectiveFovRH(this.fov, aspectRatio, this.nearDistance, this.farDistance);
        }

        // ArcBall::ScreenToVector (radius 1).
        screenToVector(screenX: number, screenY: number): number[] {
            let x = Math.fround(-Math.fround(screenX - Math.fround(this.width / 2.0)) / Math.fround(this.width / 2.0));
            let y = Math.fround(Math.fround(screenY - Math.fround(this.height / 2.0)) / Math.fround(this.height / 2.0));
            let z = 0.0;
            const mag = Math.fround(Math.fround(x * x) + Math.fround(y * y));
            if (mag > 1.0) {
                const scale = Math.fround(1.0 / Math.fround(Math.sqrt(mag)));
                x = Math.fround(x * scale);
                y = Math.fround(y * scale);
            } else {
                z = Math.fround(Math.sqrt(Math.fround(1.0 - mag)));
            }
            return [x, y, z];
        }

        // Update(elapsedTime, Mouse, Keyboard).
        update(elapsedTime: number, input: InputState): void {
            const handed: number = -1.0;
            const im = inverse(this.getView());

            if (!input.relative && !this.dragging) {
                // Arrow keys & WASD control translation of camera focus
                let move = [0.0, 0.0, 0.0];
                let scale = this.radius;
                if (input.held[KEY_LEFT_SHIFT] || input.held[KEY_RIGHT_SHIFT]) {
                    scale = Math.fround(scale * 0.5);
                }
                if (input.held[KEY_UP] || input.held[KEY_W]) {
                    move[1] += scale;
                }
                if (input.held[KEY_DOWN] || input.held[KEY_S]) {
                    move[1] -= scale;
                }
                if (input.held[KEY_PAGE_UP]) {
                    move[2] += scale * handed;
                }
                if (input.held[KEY_PAGE_DOWN]) {
                    move[2] -= scale * handed;
                }
                if (input.held[KEY_RIGHT] || input.held[KEY_D]) {
                    move[0] += scale;
                }
                if (input.held[KEY_LEFT] || input.held[KEY_A]) {
                    move[0] -= scale;
                }
                if (move[0] != 0.0 || move[1] != 0.0 || move[2] != 0.0) {
                    // Vector3::TransformNormal
                    for (let i = 0; i < 3; i++) {
                        const moved = move[0] * im[i] + move[1] * im[4 + i] + move[2] * im[8 + i];
                        this.focus[i] = Math.fround(this.focus[i] + Math.fround(moved * elapsedTime));
                    }
                }
                if (input.held[KEY_HOME]) {
                    this.reset();
                } else if (input.held[KEY_END]) {
                    this.radius = this.defaultRadius;
                    this.focus = [this.homeFocus[0], this.homeFocus[1], this.homeFocus[2]];
                }
            }

            // Mouse controls
            if (input.relative) {
                // Translate camera
                let delta = [0.0, 0.0, 0.0];
                if (input.held[KEY_LEFT_SHIFT] || input.held[KEY_RIGHT_SHIFT]) {
                    delta = [0.0, 0.0, -input.deltaY * handed * this.radius * elapsedTime];
                } else {
                    delta = [-input.deltaX * this.radius * elapsedTime, input.deltaY * this.radius * elapsedTime, 0.0];
                }
                for (let i = 0; i < 3; i++) {
                    const moved = delta[0] * im[i] + delta[1] * im[4 + i] + delta[2] * im[8 + i];
                    this.focus[i] = Math.fround(this.focus[i] + Math.fround(moved * elapsedTime * this.sensitivity));
                }
            } else if (this.dragging) {
                // Rotate camera (ArcBall::OnMove)
                const curr = this.screenToVector(input.x, input.y);
                const from = this.downPoint;
                const dot = Math.fround(dot3(from, curr));
                const part = cross3(from, curr);
                this.qnow = quatNormalize(quatMultiply(this.qdown, [part[0], part[1], part[2], dot]));
                this.rotation = quatInverse(this.qnow);
            } else {
                // Radius with scroll wheel
                this.radius = Math.max(this.minRadius, Math.fround(this.defaultRadius - Math.fround(Math.fround(input.scrollWheel / 120.0)
                    * this.radiusRate)));
            }

            if (!this.dragging) {
                if (input.rightButton && !input.relative) {
                    input.relative = true;
                } else if (!input.rightButton && input.relative) {
                    input.relative = false;
                }
                if (input.leftButton) {
                    // ArcBall::OnBegin
                    this.dragging = true;
                    this.qdown = quatInverse(this.rotation);
                    this.downPoint = this.screenToVector(input.x, input.y);
                }
            } else if (!input.leftButton) {
                this.dragging = false;
            }
            input.deltaX = 0.0;
            input.deltaY = 0.0;
        }
    }

    // --- The sample -----------------------------------------------------------------------------

    // Port of the Xbox ATG SimplePBR12_UWP sample (UWPSamples/Graphics/SimplePBR12_UWP): a toy robot,
    // wooden blocks and a floor shaded by ATGTK's PBREffect (Disney-style diffuse and GGX specular;
    // the directional lights are off, so all the light is image based: the irradiance cube map for
    // diffuse, the radiance cube map's levels by roughness for specular), with albedo, normal and
    // roughness / metallic / ambient occlusion textures; a sky box of the radiance map; into an
    // R11G11B10 HDR scene with the HUD's text, then tone mapped (DirectXTK's ACES filmic and the
    // estimated sRGB curve) into R10G10B10A2 back buffers, or sent as HDR10 (Rec.2020, ST.2084, paper
    // white at 200 nits) when the display is in HDR mode. The sample's TEST_SCENE (metal spheres,
    // compiled out) isn't ported.
    class SimplePbrSample {
        private app: App;
        private models: Model[];
        private radianceTexture: TextureHandle;
        private irradianceTexture: TextureHandle;
        private numRadianceMips: int;
        private surfaceSampler: SamplerHandle;
        private linearWrapSampler: SamplerHandle;
        private pointClampSampler: SamplerHandle;
        private pbrBuffer: BufferHandle;
        private skyBuffer: BufferHandle;
        private toneMapBuffer: BufferHandle;
        private pbrConstants: f32[];
        private skyConstants: f32[];
        private toneMapConstants: f32[];
        private pbrLayout: Opaque;
        private skyLayout: Opaque;
        private toneMapLayout: Opaque;
        private pbrInputLayout: Opaque;
        private skyInputLayout: Opaque;
        private pbrVS: Opaque;
        private pbrPS: Opaque;
        private skyVS: Opaque;
        private skyPS: Opaque;
        private quadVS: Opaque;
        private acesPS: Opaque;
        private hdr10PS: Opaque;
        private modelBindingSets: BindingSet[];
        private skyBindingSet: BindingSet;
        private skyVertices: BufferHandle;
        private skyIndices: BufferHandle;
        private skyIndexCount: int;
        // Frame-sized, made on the first frame and after each resize.
        private hdrScene: TextureHandle | null;
        private depth: TextureHandle | null;
        private sceneFramebuffer: Opaque | null;
        private toneMapBindingSet: BindingSet;
        private pbrPipeline: Opaque | null;
        private skyPipeline: Opaque | null;
        private acesPipeline: Opaque | null;
        private hdr10Pipeline: Opaque | null;
        private colorSpaceCheck: number;
        private hasPrevious: boolean;

        imguiPass: ImGuiPass;
        camera: OrbitCamera;
        input: InputState;
        frameWidth: int;
        frameHeight: int;
        // -sdr: the tone mapped SDR signal even on an HDR display.
        forceSdr: boolean;

        constructor(app: App) {
            this.app = app;
            this.models = [];
            this.numRadianceMips = 1;
            this.pbrConstants = [];
            for (let i = 0; i < PBR_FLOATS; i++) {
                this.pbrConstants.push(0.0);
            }
            // Whole 256-byte constant buffers (D3D11 updates constant buffers only whole).
            this.skyConstants = [];
            for (let i = 0; i < 64; i++) {
                this.skyConstants.push(0.0);
            }
            this.toneMapConstants = [];
            for (let i = 0; i < 64; i++) {
                let value = 0.0;
                if (i < TONE_MAP_CONSTANTS.length) {
                    value = TONE_MAP_CONSTANTS[i];
                }
                this.toneMapConstants.push(value);
            }
            this.modelBindingSets = [];
            this.skyBindingSet = new BindingSet(null);
            this.skyIndexCount = 0;
            this.hdrScene = null;
            this.depth = null;
            this.sceneFramebuffer = null;
            this.toneMapBindingSet = new BindingSet(null);
            this.pbrPipeline = null;
            this.skyPipeline = null;
            this.acesPipeline = null;
            this.hdr10Pipeline = null;
            this.colorSpaceCheck = 0.0;
            this.hasPrevious = false;
            this.input = new InputState();
            this.frameWidth = 1280;
            this.frameHeight = 720;
            this.forceSdr = false;

            // SharedSimplePBR::CreateWindowSizeDependentResources' camera: 70 degrees, 0.1 to 1000,
            // right-handed, radius 25 (5 a wheel notch), focus (0, 4, -5), and the rotation it sets:
            // Vector3(0, XM_PI, XM_PI / 10) as a quaternion, normalized.
            this.camera = new OrbitCamera();
            this.camera.fov = Math.fround(Math.fround(70.0 * Math.fround(Math.PI)) / 180.0);
            this.camera.nearDistance = 0.1;
            this.camera.farDistance = 1000.0;
            this.camera.radius = 25.0;
            this.camera.defaultRadius = 25.0;
            this.camera.radiusRate = 5.0;
            this.camera.focus = [0.0, 4.0, -5.0];
            this.camera.homeFocus = [0.0, 4.0, -5.0];
            const rotation = quatNormalize([0.0, Math.fround(Math.PI), Math.fround(Math.fround(Math.PI) / 10.0), 0.0]);
            this.camera.rotation = rotation;
            this.camera.homeRotation = [rotation[0], rotation[1], rotation[2], rotation[3]];
        }

        // DeviceResources::UpdateColorSpace: HDR10 when the window's display is in HDR mode.
        updateColorSpace(): void {
            const wanted = this.app.isDisplayHdr() != 0 && !this.forceSdr ? SwapChainColorSpace.HDR10 : SwapChainColorSpace.SRGB;
            if (wanted != this.app.getSwapChainColorSpace()) {
                this.app.setSwapChainColorSpace(wanted);
            }
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (key >= 0 && key < 512) {
                this.input.held[key] = action != ACTION_RELEASE;
            }
            return 0;
        }

        onMousePos(x: number, y: number): int {
            if (this.input.relative) {
                this.input.deltaX += x - this.input.x;
                this.input.deltaY += y - this.input.y;
            }
            this.input.x = x;
            this.input.y = y;
            return 0;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            if (button == MOUSE_LEFT) {
                this.input.leftButton = action != ACTION_RELEASE;
            } else if (button == MOUSE_RIGHT) {
                this.input.rightButton = action != ACTION_RELEASE;
            }
            return 0;
        }

        onMouseScroll(xOffset: number, yOffset: number): int {
            this.input.scrollWheel += yOffset * 120.0;
            return 0;
        }

        // SharedSimplePBR::Update: the camera, then every model's matrices (world: a half turn about
        // y) and the sky box's.
        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            this.camera.width = this.frameWidth;
            this.camera.height = this.frameHeight;
            this.camera.update(Math.fround(elapsedSeconds), this.input);

            this.colorSpaceCheck -= elapsedSeconds;
            if (this.colorSpaceCheck <= 0.0) {
                this.updateColorSpace();
                this.colorSpaceCheck = 1.0;
            }
        }

        // PBREffect::Apply's constants (and SkyboxEffect's), for this frame's camera.
        updateConstants(): void {
            const view = this.camera.getView();
            const proj = this.camera.getProjection();
            const world = rotationY(Math.fround(Math.PI));
            const worldViewProj = multiply(multiply(world, view), proj);
            const c = this.pbrConstants;
            // PrevWorldViewProj: last frame's (unused by the textured shaders).
            for (let i = 0; i < 16; i++) {
                if (this.hasPrevious) {
                    c[PBR_PREV_WORLD_VIEW_PROJ + i] = c[PBR_WORLD_VIEW_PROJ + i];
                }
            }
            this.hasPrevious = true;
            const viewInverse = inverse(view);
            c[0] = viewInverse[12];
            c[1] = viewInverse[13];
            c[2] = viewInverse[14];
            const worldT = transpose(world);
            const worldViewProjT = transpose(worldViewProj);
            for (let i = 0; i < 16; i++) {
                c[PBR_WORLD + i] = worldT[i];
                c[PBR_WORLD_VIEW_PROJ + i] = worldViewProjT[i];
            }
            // The world inverse's first three rows (a column-major float3x3: the inverse transpose).
            const worldInverse = inverse(world);
            for (let i = 0; i < 12; i++) {
                c[PBR_WORLD_INVERSE_TRANSPOSE + i] = worldInverse[i];
            }
            // The constructor's lights: pointing down, black (EnableDefaultLighting isn't called).
            for (let i = 0; i < 3; i++) {
                c[PBR_LIGHT_DIRECTION + i * 4] = 0.0;
                c[PBR_LIGHT_DIRECTION + i * 4 + 1] = -1.0;
                c[PBR_LIGHT_DIRECTION + i * 4 + 2] = 0.0;
            }
            c[PBR_CONSTANT_ALBEDO] = 1.0;
            c[PBR_CONSTANT_ALBEDO + 1] = 1.0;
            c[PBR_CONSTANT_ALBEDO + 2] = 1.0;
            c[PBR_CONSTANT_METALLIC] = 0.5;
            c[PBR_CONSTANT_METALLIC + 1] = 0.2;
            Donut_StoreInt32(Ref(c[PBR_NUM_RADIANCE_MIPS]), this.numRadianceMips);

            // SkyboxEffect::SetMatrices: the view without its translation, no world.
            let skyView = [view[0], view[1], view[2], view[3], view[4], view[5], view[6], view[7], view[8], view[9], view[10], view[11],
                0.0, 0.0, 0.0, 1.0];
            const skyWorldViewProjT = transpose(multiply(skyView, proj));
            for (let i = 0; i < 16; i++) {
                this.skyConstants[i] = skyWorldViewProjT[i];
            }
        }

        releaseFrameResources(): void {
            if (!this.toneMapBindingSet.isNull()) {
                this.app.releaseResource(this.toneMapBindingSet.handle);
                this.toneMapBindingSet = new BindingSet(null);
            }
            const framebuffer = this.sceneFramebuffer;
            if (framebuffer) {
                this.imguiPass.setFramebuffer(null);
                this.app.releaseResource(framebuffer);
                this.sceneFramebuffer = null;
            }
            const hdrScene = this.hdrScene;
            if (hdrScene) {
                this.app.releaseResource(hdrScene);
                this.hdrScene = null;
            }
            const depth = this.depth;
            if (depth) {
                this.app.releaseResource(depth);
                this.depth = null;
            }
        }

        onBackBufferResizing(): void {
            this.releaseFrameResources();
        }

        createPipelines(frame: Frame): void {
            // PBRModel::Create: Opaque, DepthDefault (less or equal), CullClockwise (counter-clockwise
            // triangles are front faces).
            const pbrDesc = GraphicsPipelineDesc.create(this.pbrVS, this.pbrPS);
            pbrDesc.addBindingLayout(this.pbrLayout);
            pbrDesc.setInputLayout(this.pbrInputLayout);
            pbrDesc.setDepthState(1, 1, ComparisonFunc.LessOrEqual);
            pbrDesc.setRasterState(CullMode.Back, FillMode.Solid, 1);
            this.pbrPipeline = this.app.createGraphicsPipelineFromDesc(pbrDesc, this.sceneFramebuffer as Opaque);

            // DX::Skybox: DepthRead (less or equal, no writes), CullClockwise.
            const skyDesc = GraphicsPipelineDesc.create(this.skyVS, this.skyPS);
            skyDesc.addBindingLayout(this.skyLayout);
            skyDesc.setInputLayout(this.skyInputLayout);
            skyDesc.setDepthState(1, 0, ComparisonFunc.LessOrEqual);
            skyDesc.setRasterState(CullMode.Back, FillMode.Solid, 1);
            this.skyPipeline = this.app.createGraphicsPipelineFromDesc(skyDesc, this.sceneFramebuffer as Opaque);

            for (let i = 0; i < 2; i++) {
                const desc = GraphicsPipelineDesc.create(this.quadVS, i == 0 ? this.acesPS : this.hdr10PS);
                desc.addBindingLayout(this.toneMapLayout);
                desc.setDepthState(0, 0, ComparisonFunc.Always);
                desc.setRasterState(CullMode.None, FillMode.Solid, 0);
                const pipeline = this.app.createGraphicsPipelineFromDescForFrame(desc, frame);
                if (i == 0) {
                    this.acesPipeline = pipeline;
                } else {
                    this.hdr10Pipeline = pipeline;
                }
            }
        }

        // SharedSimplePBR::Render, the HDR scene: the models, then the sky box (the HUD is the ImGui
        // pass's, drawn into the scene after this).
        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();
            if (width != this.frameWidth || height != this.frameHeight) {
                this.releaseFrameResources();
            }
            this.frameWidth = width;
            this.frameHeight = height;
            let hdrScene = this.hdrScene;
            if (!hdrScene) {
                hdrScene = this.app.createRenderTargetTexture(width, height, Format.R11G11B10_FLOAT, "HDRScene");
                this.hdrScene = hdrScene;
                this.depth = this.app.createDepthTexture(width, height, Format.D32, 1.0, "Depth");
                this.sceneFramebuffer = this.app.createFramebuffer(hdrScene, this.depth);
                const toneMapDesc = BindingSetDesc.create();
                toneMapDesc.bindEntireConstantBuffer(0, this.toneMapBuffer);
                toneMapDesc.bindTextureSRV(0, hdrScene);
                toneMapDesc.bindSampler(0, this.pointClampSampler);
                this.toneMapBindingSet = this.app.createBindingSetForLayout(toneMapDesc, this.toneMapLayout);
            }
            if (!this.pbrPipeline) {
                this.createPipelines(frame);
            }
            // The text goes into the HDR scene.
            this.imguiPass.setFramebuffer(this.sceneFramebuffer);

            this.updateConstants();
            commandList.writeBuffer(this.pbrBuffer, Ref(this.pbrConstants[0]), PBR_FLOATS * 4);
            commandList.writeBuffer(this.skyBuffer, Ref(this.skyConstants[0]), 256);

            // Sample::Clear clears the depth (the sky box covers the scene's background).
            commandList.clearDepth(this.depth as TextureHandle, 1.0);

            // Model Draw
            for (let m = 0; m < this.models.length; m++) {
                const model = this.models[m];
                for (let p = 0; p < model.partIndexCounts.length; p++) {
                    frame.beginDrawToFramebuffer(this.pbrPipeline as Opaque, this.sceneFramebuffer as Opaque);
                    frame.drawAddBindingSet(this.modelBindingSets[m]);
                    frame.drawAddVertexBuffer(model.vertexBuffers[model.partVertexBuffers[p]], 0, 0);
                    const ib = model.partIndexBuffers[p];
                    if (model.index32[ib]) {
                        frame.drawSetIndexBuffer(model.indexBuffers[ib]);
                    } else {
                        frame.drawSetIndexBuffer16(model.indexBuffers[ib]);
                    }
                    frame.drawIndexedRange(model.partIndexCounts[p], model.partStartIndices[p], model.partVertexOffsets[p]);
                }
            }

            // Sky box
            frame.beginDrawToFramebuffer(this.skyPipeline as Opaque, this.sceneFramebuffer as Opaque);
            frame.drawAddBindingSet(this.skyBindingSet);
            frame.drawAddVertexBuffer(this.skyVertices, 0, 0);
            frame.drawSetIndexBuffer(this.skyIndices);
            frame.drawIndexed(this.skyIndexCount);
        }

        // The tone mapping into the back buffer (a pass after the ImGui one): HDR10 or SDR by the
        // swap chain's color space.
        onRenderToneMap(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const hdr10 = this.app.getSwapChainColorSpace() == SwapChainColorSpace.HDR10;
            const pipeline = hdr10 ? this.hdr10Pipeline : this.acesPipeline;
            if (!pipeline || this.toneMapBindingSet.isNull()) {
                return;
            }
            frame.getCommandList().writeBuffer(this.toneMapBuffer, Ref(this.toneMapConstants[0]), 256);
            frame.beginDraw(pipeline as Opaque);
            frame.drawAddBindingSet(this.toneMapBindingSet);
            frame.drawVertices(3);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        // SharedSimplePBR::CreateDeviceDependentResources.
        init(): boolean {
            // CommonRenderPasses (behind the common samplers) opens its own command list: before ours.
            this.pointClampSampler = this.app.getCommonSampler(CommonSampler.PointClamp);
            // CommonStates::AnisotropicClamp (16 samples) and LinearWrap.
            this.surfaceSampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Clamp, 0.0, 0.0, 1000.0,
                Math.min(16.0, this.app.getMaxSamplerAnisotropy()));
            this.linearWrapSampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Wrap, 0.0, 0.0, 1000.0, 1.0);

            this.pbrVS = this.app.createShader("simple_pbr.hlsl", "pbr_vs", ShaderType.Vertex);
            this.pbrPS = this.app.createShader("simple_pbr.hlsl", "pbr_ps", ShaderType.Pixel);
            this.skyVS = this.app.createShader("simple_pbr_sky.hlsl", "sky_vs", ShaderType.Vertex);
            this.skyPS = this.app.createShader("simple_pbr_sky.hlsl", "sky_ps", ShaderType.Pixel);
            this.quadVS = this.app.createShader("simple_pbr_tonemap.hlsl", "quad_vs", ShaderType.Vertex);
            this.acesPS = this.app.createShader("simple_pbr_tonemap.hlsl", "aces_filmic_srgb_ps", ShaderType.Pixel);
            this.hdr10PS = this.app.createShader("simple_pbr_tonemap.hlsl", "hdr10_ps", ShaderType.Pixel);
            if (!this.pbrVS || !this.pbrPS || !this.skyVS || !this.skyPS || !this.quadVS || !this.acesPS || !this.hdr10PS) {
                return false;
            }

            const pbrLayoutDesc = BindingLayoutDesc.create();
            for (let i = 0; i < 5; i++) {
                pbrLayoutDesc.layoutTextureSRV(i);
            }
            pbrLayoutDesc.layoutSampler(0);
            pbrLayoutDesc.layoutSampler(1);
            pbrLayoutDesc.layoutConstantBuffer(0);
            this.pbrLayout = this.app.createBindingLayout(pbrLayoutDesc, ShaderType.All);
            const skyLayoutDesc = BindingLayoutDesc.create();
            skyLayoutDesc.layoutTextureSRV(0);
            skyLayoutDesc.layoutSampler(0);
            skyLayoutDesc.layoutConstantBuffer(0);
            this.skyLayout = this.app.createBindingLayout(skyLayoutDesc, ShaderType.All);
            const toneMapLayoutDesc = BindingLayoutDesc.create();
            toneMapLayoutDesc.layoutTextureSRV(0);
            toneMapLayoutDesc.layoutSampler(0);
            toneMapLayoutDesc.layoutConstantBuffer(0);
            this.toneMapLayout = this.app.createBindingLayout(toneMapLayoutDesc, ShaderType.All);

            this.pbrBuffer = this.app.createConstantBuffer(PBR_FLOATS * 4, "PBR_Constants");
            this.skyBuffer = this.app.createConstantBuffer(256, "Skybox_Constants");
            this.toneMapBuffer = this.app.createConstantBuffer(256, "ToneMapParameters");

            // The radiance map's levels: the sample uses three fewer ("The current map has too much
            // detail removed at last mips, scale back down to match reference."); the count is in the
            // DDS header.
            const radianceFile = this.app.loadBinaryFile(MEDIA_DIR + "Stonewall_Ref_radiance.dds");
            if (!radianceFile.isNull()) {
                let header: int[] = [0, 0, 0, 0];
                radianceFile.copyBytes(28, 4, Ref(header[0]));
                const mips = header[0] + header[1] * 256 + header[2] * 65536 + header[3] * 16777216;
                this.numRadianceMips = Math.max(mips, 1) - 3;
                this.app.releaseObject(radianceFile.handle);
            }

            const commandList = this.app.createCommandList();
            commandList.open();
            let loaded = true;
            for (let i = 0; i < MODEL_NAMES.length; i++) {
                const model = new Model();
                if (!model.load(this.app, commandList, MODEL_NAMES[i])) {
                    loaded = false;
                }
                this.models.push(model);
            }
            const radiance = this.app.loadTexture(commandList, MEDIA_DIR + "Stonewall_Ref_radiance.dds", 0);
            const irradiance = this.app.loadTexture(commandList, MEDIA_DIR + "Stonewall_Ref_irradiance.dds", 0);

            // The sky box's geosphere (GeometricPrimitive::CreateGeoSphere(2.f): tessellation 3).
            let skyPositions: f32[] = [];
            let skyIndices: int[] = [];
            geoSphere(2.0, 3, skyPositions, skyIndices);
            this.skyVertices = this.app.createStaticVertexBuffer(commandList, Ref(skyPositions[0]), skyPositions.length * 4, "Sky");
            this.skyIndices = this.app.createStaticIndexBuffer(commandList, Ref(skyIndices[0]), skyIndices.length * 4, "Sky");
            this.skyIndexCount = skyIndices.length;

            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded || !radiance || !irradiance) {
                console.log("Cannot load the sample's models and textures: set XBOX_ATG_SAMPLES_DIR when configuring");
                return false;
            }
            this.radianceTexture = radiance as TextureHandle;
            this.irradianceTexture = irradiance as TextureHandle;

            // ATG::VertexPositionNormalTextureTangent's input layout; the sky box's positions.
            const stride = this.models[0].vertexStride;
            const pbrInput = InputLayoutDesc.create();
            pbrInput.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, stride);
            pbrInput.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, stride);
            pbrInput.addVertexAttribute("TANGENT", Format.RGB32_FLOAT, VERTEX_TANGENT, 0, stride);
            pbrInput.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, stride);
            this.pbrInputLayout = this.app.createInputLayout(pbrInput, this.pbrVS);
            const skyInput = InputLayoutDesc.create();
            skyInput.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, 12);
            this.skyInputLayout = this.app.createInputLayout(skyInput, this.skyVS);

            for (let m = 0; m < this.models.length; m++) {
                const model = this.models[m];
                const desc = BindingSetDesc.create();
                desc.bindTextureSRV(0, model.albedo);
                desc.bindTextureSRV(1, model.normal);
                desc.bindTextureSRV(2, model.rma);
                desc.bindTextureSRV(3, this.radianceTexture);
                desc.bindTextureSRV(4, this.irradianceTexture);
                desc.bindSampler(0, this.surfaceSampler);
                desc.bindSampler(1, this.linearWrapSampler);
                desc.bindEntireConstantBuffer(0, this.pbrBuffer);
                this.modelBindingSets.push(this.app.createBindingSetForLayout(desc, this.pbrLayout));
            }
            const skyDesc = BindingSetDesc.create();
            skyDesc.bindTextureSRV(0, this.radianceTexture);
            skyDesc.bindSampler(0, this.linearWrapSampler);
            skyDesc.bindEntireConstantBuffer(0, this.skyBuffer);
            this.skyBindingSet = this.app.createBindingSetForLayout(skyDesc, this.skyLayout);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setMouseScrollCallback(this.onMouseScroll);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        // The second pass, after the ImGui one.
        initToneMap(): void {
            const pass = this.app.addPass();
            pass.setRenderCallback(this.onRenderToneMap);
        }
    }

    // The sample's HUD (SpriteFont text in the title-safe area, in the HDR scene): its name at the
    // top, the keyboard and mouse legend at the bottom.
    class UserInterface {
        private sample: SimplePbrSample;

        font: ImGuiFont;

        constructor(sample: SimplePbrSample) {
            this.sample = sample;
        }

        buildUI(): void {
            const sample = this.sample;
            // SimpleMath::Viewport::ComputeTitleSafeArea
            const safeW = Math.fround((sample.frameWidth + 19.0) / 20.0);
            const safeH = Math.fround((sample.frameHeight + 19.0) / 20.0);
            const left: int = Math.floor(safeW);
            const top: int = Math.floor(safeH);
            const bottom: int = Math.floor(sample.frameHeight - safeH + 0.5);
            this.font.push();
            Donut_ImGuiDrawText(left, top, "SimplePBR Sample", LIGHT_GREY_HDR, LIGHT_GREY_HDR, LIGHT_GREY_HDR, 1.0, 0);
            Donut_ImGuiDrawText(left, bottom - LINE_SPACING, "Mouse, W,A,S,D: Move Camera   Esc: Exit ", LIGHT_GREY_HDR, LIGHT_GREY_HDR,
                LIGHT_GREY_HDR, 1.0, 0);
            Donut_ImGuiPopFont();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            const imguiPass = app.addImGuiPass(this.buildUI);
            if (imguiPass.isNull()) {
                return false;
            }
            this.sample.imguiPass = imguiPass;
            this.font = imguiPass.createFont(FONT_PATH, FONT_SIZE);
            if (this.font.isNull()) {
                console.log("Cannot load the font: set DONUT_SAMPLES_MEDIA_DIR when configuring");
                return false;
            }
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("simple_pbr");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -sdr: the tone mapped SDR signal even on an HDR display.
        let options = AppOptions.HdrBackBuffer;
        let sdr = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-sdr") {
                sdr = true;
            }
        }

        // The sample's R10G10B10A2_UNORM back buffers (HDR10 when the display is in HDR mode), at
        // its default 1280 x 720.
        const width = 1280;
        const height = 720;
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, width, height, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        // The scene, its text, then the tone mapping.
        const sample = new SimplePbrSample(app);
        if (!sample.init()) {
            app.destroy();
            return 1;
        }
        const ui = new UserInterface(sample);
        if (!ui.init(app)) {
            app.destroy();
            return 1;
        }
        sample.initToneMap();
        sample.forceSdr = sdr;
        sample.updateColorSpace();

        const input = new InputPass(app.handle);

        app.run();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return SimplePbr.main(argc, argv);
}

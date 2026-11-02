/// <reference path="../../core/nri/nri_interop.d.ts" />
import { SdkMesh } from "../../core/sdk_mesh";
import { rotationY, transpose, inverse, cross3, dot3, multiplyF32 } from "../../core/matrix";

namespace SimplePbrNri {
    // simple_pbr, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut
    // and NVRHI: the same shaders (simple_pbr.hlsl's, simple_pbr_sky.hlsl's, simple_pbr_tonemap.hlsl's),
    // the same SDKMESH reader (core/sdkmesh.cpp, in nri_interop), through the NRI calls
    // core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui drawing the HUD's text into the HDR
    // scene as Donut's does. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Simple PBR";
    const MEDIA_DIR = "media/simple_pbr/";
    const FONT_PATH = "media/fonts/OpenSans/OpenSans-Regular.ttf";
    // The sample's SegoeUI_18 sprite font, its lines 32 pixels apart, as the Donut example sizes it
    // (ImGui sizes a font by its ascent + descent).
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

    // A queued frame's constants in the host constant buffer, 1024 bytes apart: PBR_Constants (512
    // bytes), Skybox_Constants (256), ToneMapParameters (256); constant buffer views 256-aligned.
    const FRAME_CONSTANTS_STRIDE = 1024;
    const PBR_OFFSET = 0;
    const SKY_OFFSET = 512;
    const TONE_MAP_OFFSET = 768;

    // DirectXTK's ToneMapPostProcess: linear exposure 1, paper white 200 nits, Rec.709 to Rec.2020.
    const TONE_MAP_CONSTANTS = [
        1.0, 200.0, 0.0, 0.0,
        0.6274040, 0.3292820, 0.0433136, 0.0,
        0.0690970, 0.9195400, 0.0113612, 0.0,
        0.0163916, 0.0880132, 0.8955950, 0.0,
    ];

    // GLFW's key codes (Donut's Key) of the camera's controls.
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

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // --- DirectXMath ----------------------------------------------------------------------------

    function normalize3(v: number[]) {
        const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        return [Math.fround(v[0] / length), Math.fround(v[1] / length), Math.fround(v[2] / length)];
    }

    // XMMatrixLookAtRH: XMMatrixLookToLH away from the focus.
    function lookAtRH(eye: number[], focus: number[], up: number[]) {
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
    function perspectiveFovRH(fovY: number, aspect: number, nearZ: number, farZ: number) {
        const height = Math.fround(Math.cos(0.5 * fovY) / Math.sin(0.5 * fovY));
        const width = Math.fround(height / aspect);
        const range = Math.fround(farZ / (nearZ - farZ));
        return [width, 0.0, 0.0, 0.0, 0.0, height, 0.0, 0.0, 0.0, 0.0, range, -1.0, 0.0, 0.0, Math.fround(range * nearZ), 0.0];
    }

    // Quaternions (x, y, z, w). XMQuaternionMultiply(q1, q2): q1's rotation, then q2's.
    function quatMultiply(q1: number[], q2: number[]) {
        return [
            Math.fround(q2[3] * q1[0] + q2[0] * q1[3] + q2[1] * q1[2] - q2[2] * q1[1]),
            Math.fround(q2[3] * q1[1] - q2[0] * q1[2] + q2[1] * q1[3] + q2[2] * q1[0]),
            Math.fround(q2[3] * q1[2] + q2[0] * q1[1] - q2[1] * q1[0] + q2[2] * q1[3]),
            Math.fround(q2[3] * q1[3] - q2[0] * q1[0] - q2[1] * q1[1] - q2[2] * q1[2]),
        ];
    }

    function quatNormalize(q: number[]) {
        const length = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
        return [Math.fround(q[0] / length), Math.fround(q[1] / length), Math.fround(q[2] / length), Math.fround(q[3] / length)];
    }

    // XMQuaternionInverse.
    function quatInverse(q: number[]) {
        const lengthSq = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
        return [Math.fround(-q[0] / lengthSq), Math.fround(-q[1] / lengthSq), Math.fround(-q[2] / lengthSq), Math.fround(q[3] / lengthSq)];
    }

    // XMVector3Rotate: conjugate(q) * v, then * q.
    function rotate3(v: number[], q: number[]) {
        const conjugate = [-q[0], -q[1], -q[2], q[3]];
        const r = quatMultiply(quatMultiply(conjugate, [v[0], v[1], v[2], 0.0]), q);
        return [r[0], r[1], r[2]];
    }

    // --- Geometry -------------------------------------------------------------------------------

    // DirectXTK's ComputeGeoSphere positions (its texture coordinate seams and pole copies only
    // duplicate positions), right-handed: an octahedron subdivided `tessellation` times, pushed onto
    // the sphere.
    function geoSphere(diameter: number, tessellation: int, positions: f32[], indices: int[]) {
        const vertices: number[] = [0.0, 1.0, 0.0, 0.0, 0.0, -1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, -1.0, 0.0, 0.0, 0.0, -1.0, 0.0];
        let current: int[] = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 5, 1, 4, 5, 4, 3, 5, 3, 2, 5, 2, 1];
        for (let subdivision = 0; subdivision < tessellation; subdivision++) {
            // The edges divided so far (larger index first) and their midpoints.
            const edgeA: int[] = [];
            const edgeB: int[] = [];
            const edgeMid: int[] = [];
            const next: int[] = [];
            const triangleCount = current.length / 3;
            for (let t = 0; t < triangleCount; t++) {
                const iv0 = current[t * 3];
                const iv1 = current[t * 3 + 1];
                const iv2 = current[t * 3 + 2];
                const mids: int[] = [];
                const pairs = [iv0, iv1, iv1, iv2, iv0, iv2];
                for (let e = 0; e < 3; e++) {
                    const i0 = pairs[e * 2];
                    const i1 = pairs[e * 2 + 1];
                    const a = Math.max(i0, i1);
                    const b = Math.min(i0, i1);
                    let found: int = -1;
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
                for (const vertexIndex of added) {
                    next.push(vertexIndex);
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
        for (const index of current) {
            indices.push(index);
        }
    }

    // A PBR model as ATG::PBRModel loads it: the SDKMESH file's buffers and mesh parts (DirectXTK's
    // Model, drawn with one effect, the frames' transforms not applied) and the textures named after
    // it: albedo (forced to sRGB), normal and roughness / metallic / ambient occlusion.
    class Model {
        vertexBuffers: NriBufferHandle[] = [];
        indexBuffers: NriBufferHandle[] = [];
        // 1 for 32-bit indices, 0 for 16-bit (an int array: tslang reads bool arrays wrong).
        index32: int[] = [];
        partVertexBuffers: int[] = [];
        partIndexBuffers: int[] = [];
        partIndexCounts: int[] = [];
        partStartIndices: int[] = [];
        partVertexOffsets: int[] = [];
        vertexStride: int = 0;
        albedo: NriTextureHandle | null = null;
        normal: NriTextureHandle | null = null;
        rma: NriTextureHandle | null = null;
        albedoView: NriDescriptorHandle | null = null;
        normalView: NriDescriptorHandle | null = null;
        rmaView: NriDescriptorHandle | null = null;

        // False (after printing why) on failure.
        load(device: NriDeviceHandle, queue: NriQueueHandle, name: string) {
            const file = Nri_LoadFile(MEDIA_DIR + name + ".sdkmesh");
            if (!file) {
                return false;
            }
            const mesh = SdkMesh.load(Nri_GetFileData(file), Nri_GetFileSize(file));
            if (mesh.isNull()) {
                Nri_DestroyFile(file);
                return false;
            }
            let ok = true;
            this.vertexStride = mesh.getVertexBufferStride(0);
            for (let i = 0; i < mesh.getVertexBufferCount(); i++) {
                // ATG::VertexPositionNormalTextureTangent's input layout over the file's vertices.
                if (mesh.getVertexElementOffset(i, 6, 0) != VERTEX_TANGENT
                    || mesh.getVertexBufferStride(i) != this.vertexStride) {
                    console.log(`${name}: unexpected vertex layout`);
                    ok = false;
                }
                const buffer = Nri_CreateUploadedBufferFromPointer(device, queue, mesh.getVertexBufferData(i), mesh.getVertexBufferSize(i),
                    NriBufferUsage.VertexBuffer);
                if (!buffer) {
                    ok = false;
                } else {
                    this.vertexBuffers.push(buffer);
                }
            }
            for (let i = 0; i < mesh.getIndexBufferCount(); i++) {
                const buffer = Nri_CreateUploadedBufferFromPointer(device, queue, mesh.getIndexBufferData(i), mesh.getIndexBufferSize(i),
                    NriBufferUsage.IndexBuffer);
                if (!buffer) {
                    ok = false;
                } else {
                    this.indexBuffers.push(buffer);
                }
                this.index32.push(mesh.isIndexBuffer32Bit(i) ? 1 : 0);
            }
            for (let m = 0; m < mesh.getMeshCount(); m++) {
                for (let j = 0; j < mesh.getMeshSubsetCount(m); j++) {
                    const subset = mesh.getMeshSubset(m, j);
                    if (mesh.getSubsetPrimitiveType(subset) != 0) {
                        console.log(`${name}: only triangle lists are supported`);
                        ok = false;
                    }
                    this.partVertexBuffers.push(mesh.getMeshVertexBuffer(m));
                    this.partIndexBuffers.push(mesh.getMeshIndexBuffer(m));
                    this.partIndexCounts.push(mesh.getSubsetIndexCount(subset));
                    this.partStartIndices.push(mesh.getSubsetIndexStart(subset));
                    this.partVertexOffsets.push(mesh.getSubsetVertexStart(subset));
                }
            }
            mesh.destroy();
            Nri_DestroyFile(file);

            // DDS files: the albedo (BC1) as sRGB, as Donut's loadTexture(..., sRGB) loads it; the
            // normals (BC5) and RMA (BC7) as they are; all their mips.
            const albedo = Nri_LoadDdsTexture(device, queue, MEDIA_DIR + name + "_BaseColor.dds", 1);
            const normal = Nri_LoadDdsTexture(device, queue, MEDIA_DIR + name + "_Normal.dds", 0);
            const rma = Nri_LoadDdsTexture(device, queue, MEDIA_DIR + name + "_RMA.dds", 0);
            this.albedo = albedo;
            this.normal = normal;
            this.rma = rma;
            if (!albedo || !normal || !rma) {
                return false;
            }
            this.albedoView = Nri_CreateTextureView(albedo, Nri_GetTextureFormat(albedo));
            this.normalView = Nri_CreateTextureView(normal, Nri_GetTextureFormat(normal));
            this.rmaView = Nri_CreateTextureView(rma, Nri_GetTextureFormat(rma));
            return ok;
        }

        destroy() {
            for (const buffer of this.vertexBuffers) {
                Nri_DestroyBuffer(buffer);
            }
            for (const buffer of this.indexBuffers) {
                Nri_DestroyBuffer(buffer);
            }
            destroyDescriptor(this.albedoView);
            destroyDescriptor(this.normalView);
            destroyDescriptor(this.rmaView);
            destroyTexture(this.albedo);
            destroyTexture(this.normal);
            destroyTexture(this.rma);
        }
    }

    function destroyDescriptor(descriptor: NriDescriptorHandle | null) {
        if (descriptor) {
            Nri_DestroyDescriptor(descriptor);
        }
    }

    function destroyTexture(texture: NriTextureHandle | null) {
        if (texture) {
            Nri_DestroyTexture(texture);
        }
    }

    function destroyBuffer(buffer: NriBufferHandle | null) {
        if (buffer) {
            Nri_DestroyBuffer(buffer);
        }
    }

    function destroyPipeline(pipeline: NriPipelineHandle | null) {
        if (pipeline) {
            Nri_DestroyPipeline(pipeline);
        }
    }

    function destroyLayout(layout: NriPipelineLayoutHandle | null) {
        if (layout) {
            Nri_DestroyPipelineLayout(layout);
        }
    }

    // The mouse and keys as DirectXTK's Mouse and Keyboard report them: held keys and buttons, the
    // cursor position, the wheel's total (120 a notch), and in relative mode (the right button
    // held) the cursor's movement since the last update.
    class InputState {
        // 1 while held (an int array: tslang reads bool arrays wrong).
        held: int[] = [];
        leftButton: boolean = false;
        rightButton: boolean = false;
        x: number = 0.0;
        y: number = 0.0;
        deltaX: number = 0.0;
        deltaY: number = 0.0;
        scrollWheel: number = 0.0;
        relative: boolean = false;

        constructor() {
            for (let i = 0; i < 512; i++) {
                this.held.push(0);
            }
        }

        isHeld(key: int) {
            return this.held[key] != 0;
        }
    }

    // --- The camera -----------------------------------------------------------------------------

    // ATGTK's OrbitCamera with the sample's settings, right-handed, driven by the mouse and keys as
    // its Update(Mouse, Keyboard): the left button turns it (an ArcBall), the right button moves its
    // focus, the wheel sets its radius; W A S D / arrows / Page Up / Page Down move the focus
    // (Shift: slower), Home resets it, End resets the focus and radius.
    class OrbitCamera {
        focus: number[] = [0.0, 0.0, 0.0];
        homeFocus: number[] = [0.0, 0.0, 0.0];
        rotation: number[] = [0.0, 0.0, 0.0, 1.0];
        homeRotation: number[] = [0.0, 0.0, 0.0, 1.0];
        radius: number = 5.0;
        defaultRadius: number = 5.0;
        minRadius: number = 1.0;
        radiusRate: number = 1.0;
        sensitivity: number = 1.0;
        fov: number = Math.fround(Math.PI / 4.0);
        nearDistance: number = 0.1;
        farDistance: number = 10000.0;
        width: int = 1280;
        height: int = 720;
        cameraPosition: number[] = [0.0, 0.0, 0.0];

        // ArcBall
        private dragging: boolean = false;
        private qdown: number[] = [0.0, 0.0, 0.0, 1.0];
        private qnow: number[] = [0.0, 0.0, 0.0, 1.0];
        private downPoint: number[] = [0.0, 0.0, 0.0];

        reset() {
            this.focus = [this.homeFocus[0], this.homeFocus[1], this.homeFocus[2]];
            this.radius = this.defaultRadius;
            this.rotation = [this.homeRotation[0], this.homeRotation[1], this.homeRotation[2], this.homeRotation[3]];
            this.sensitivity = 1.0;
            this.qdown = [0.0, 0.0, 0.0, 1.0];
            this.qnow = [0.0, 0.0, 0.0, 1.0];
            this.dragging = false;
        }

        // GetView: the camera radius away from the focus along the rotated +z, LookAtRH.
        getView() {
            const dir = rotate3([0.0, 0.0, 1.0], this.rotation);
            const up = rotate3([0.0, 1.0, 0.0], this.rotation);
            for (let i = 0; i < 3; i++) {
                this.cameraPosition[i] = Math.fround(this.focus[i] + Math.fround(dir[i] * this.radius));
            }
            return lookAtRH(this.cameraPosition, this.focus, up);
        }

        getProjection() {
            let aspectRatio = 1.0;
            if (this.height > 0) {
                aspectRatio = Math.fround(this.width / this.height);
            }
            return perspectiveFovRH(this.fov, aspectRatio, this.nearDistance, this.farDistance);
        }

        // ArcBall::ScreenToVector (radius 1).
        screenToVector(screenX: number, screenY: number) {
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
        update(elapsedTime: number, input: InputState) {
            const handed = -1.0;
            const im = inverse(this.getView());

            if (!input.relative && !this.dragging) {
                // Arrow keys & WASD control translation of camera focus
                const move = [0.0, 0.0, 0.0];
                let scale = this.radius;
                if (input.isHeld(KEY_LEFT_SHIFT) || input.isHeld(KEY_RIGHT_SHIFT)) {
                    scale = Math.fround(scale * 0.5);
                }
                if (input.isHeld(KEY_UP) || input.isHeld(KEY_W)) {
                    move[1] += scale;
                }
                if (input.isHeld(KEY_DOWN) || input.isHeld(KEY_S)) {
                    move[1] -= scale;
                }
                if (input.isHeld(KEY_PAGE_UP)) {
                    move[2] += scale * handed;
                }
                if (input.isHeld(KEY_PAGE_DOWN)) {
                    move[2] -= scale * handed;
                }
                if (input.isHeld(KEY_RIGHT) || input.isHeld(KEY_D)) {
                    move[0] += scale;
                }
                if (input.isHeld(KEY_LEFT) || input.isHeld(KEY_A)) {
                    move[0] -= scale;
                }
                if (move[0] != 0.0 || move[1] != 0.0 || move[2] != 0.0) {
                    // Vector3::TransformNormal
                    for (let i = 0; i < 3; i++) {
                        const moved = move[0] * im[i] + move[1] * im[4 + i] + move[2] * im[8 + i];
                        this.focus[i] = Math.fround(this.focus[i] + Math.fround(moved * elapsedTime));
                    }
                }
                if (input.isHeld(KEY_HOME)) {
                    this.reset();
                } else if (input.isHeld(KEY_END)) {
                    this.radius = this.defaultRadius;
                    this.focus = [this.homeFocus[0], this.homeFocus[1], this.homeFocus[2]];
                }
            }

            // Mouse controls
            if (input.relative) {
                // Translate camera
                let delta = [0.0, 0.0, 0.0];
                if (input.isHeld(KEY_LEFT_SHIFT) || input.isHeld(KEY_RIGHT_SHIFT)) {
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
                const downPoint = this.downPoint;
                const dot = Math.fround(dot3(downPoint, curr));
                const part = cross3(downPoint, curr);
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

    // What a frame in flight records into, and its descriptor sets (over its constants): one per
    // model, the sky box's and the tone mapping's.
    class QueuedFrame {
        modelSets: NriDescriptorSetHandle[] = [];
        skySet: NriDescriptorSetHandle | null = null;
        toneMapSet: NriDescriptorSetHandle | null = null;
        pbrView: NriDescriptorHandle | null = null;
        skyView: NriDescriptorHandle | null = null;
        toneMapView: NriDescriptorHandle | null = null;

        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // -test: checks the last frame, read back (R10G10B10A2 back buffers, SDR; the channels' top 8
    // bits), as the Donut example does: the PBR models over the blurred garden, about 41% of the frame
    // colored, 4% white.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        let colored = 0;
        let white = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            const high = Math.max(r, Math.max(g, b));
            const low = Math.min(r, Math.min(g, b));
            if (high - low >= 61) {
                colored++;
            }
            if (r >= 221 && g >= 221 && b >= 221) {
                white++;
            }
        }
        const coloredPercent = 100.0 * colored / total;
        console.log(`Colored: ${coloredPercent}% (${colored} of ${total} pixels)`);
        if (coloredPercent < 30.0 || coloredPercent > 50.0) {
            return `Colored: ${coloredPercent}% of the pixels, not 30% to 50%`;
        }
        const whitePercent = 100.0 * white / total;
        console.log(`White: ${whitePercent}% (${white} of ${total} pixels)`);
        if (whitePercent < 2.5 || whitePercent > 7.0) {
            return `White: ${whitePercent}% of the pixels, not 2.5% to 7%`;
        }
        return "";
    }

    // Port of the Xbox ATG SimplePBR12_UWP sample (as examples/simple_pbr.ts ports it) to NRI: a toy
    // robot, wooden blocks and a floor shaded by ATGTK's PBREffect (image based lighting only: the
    // irradiance cube map for diffuse, the radiance cube map's levels by roughness for specular), with
    // albedo, normal and roughness / metallic / ambient occlusion textures; a sky box of the radiance
    // map; into an R11G11B10 HDR scene with the HUD's text, then tone mapped (DirectXTK's ACES filmic
    // and the estimated sRGB curve) into a 10-bit swap chain, or sent as HDR10 (Rec.2020, ST.2084,
    // paper white at 200 nits) when the display is in HDR mode.
    class SimplePbr {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle | null = null;
        private swapChainTextures: SwapChainTexture[] = [];
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private hdr10: boolean = false;
        private queuedFrames: QueuedFrame[] = [];
        private models: Model[] = [];
        private radianceTexture: NriTextureHandle | null = null;
        private irradianceTexture: NriTextureHandle | null = null;
        private radianceView: NriDescriptorHandle | null = null;
        private irradianceView: NriDescriptorHandle | null = null;
        private numRadianceMips: int = 1;
        private surfaceSampler: NriDescriptorHandle | null = null;
        private linearWrapSampler: NriDescriptorHandle | null = null;
        private pointClampSampler: NriDescriptorHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private pbrLayout: NriPipelineLayoutHandle | null = null;
        private skyLayout: NriPipelineLayoutHandle | null = null;
        private toneMapLayout: NriPipelineLayoutHandle | null = null;
        private pbrPipeline: NriPipelineHandle | null = null;
        private skyPipeline: NriPipelineHandle | null = null;
        private acesPipeline: NriPipelineHandle | null = null;
        private hdr10Pipeline: NriPipelineHandle | null = null;
        private skyVertices: NriBufferHandle | null = null;
        private skyIndices: NriBufferHandle | null = null;
        private skyIndexCount: int = 0;
        private hdrScene: NriTextureHandle | null = null;
        private hdrSceneAttachment: NriDescriptorHandle | null = null;
        private hdrSceneView: NriDescriptorHandle | null = null;
        private depth: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private imgui: boolean = false;
        private font: NriImguiFontHandle | null = null;
        private width: int = 0;
        private height: int = 0;
        private colorSpaceCheck: number = 0.0;
        private hasPrevious: boolean = false;

        // Upload buffers.
        private pbrConstants: f32[] = [];
        private skyConstants: f32[] = [];
        private toneMapConstants: f32[] = [];

        camera: OrbitCamera = new OrbitCamera();
        input: InputState = new InputState();
        // -sdr: the tone mapped SDR signal even on an HDR display.
        forceSdr: boolean = false;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < PBR_FLOATS; i++) {
                this.pbrConstants.push(0.0);
            }
            for (let i = 0; i < 64; i++) {
                this.skyConstants.push(0.0);
            }
            for (let i = 0; i < 64; i++) {
                let value = 0.0;
                if (i < TONE_MAP_CONSTANTS.length) {
                    value = TONE_MAP_CONSTANTS[i];
                }
                this.toneMapConstants.push(value);
            }

            // SharedSimplePBR::CreateWindowSizeDependentResources' camera: 70 degrees, 0.1 to 1000,
            // right-handed, radius 25 (5 a wheel notch), focus (0, 4, -5), and the rotation it sets:
            // Vector3(0, XM_PI, XM_PI / 10) as a quaternion, normalized.
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

        // Renders until the window is closed (in test mode, the test's frames); the exit code.
        run(argc: int, argv: Ref<string>): int {
            const initialize: NriInitializeCallback = this.initialize;
            const latencySleep: NriFrameCallback = this.latencySleep;
            const renderFrame: NriFrameCallback = this.renderFrame;
            retainedInitializeCallbacks.push(initialize);
            retainedFrameCallbacks.push(latencySleep);
            retainedFrameCallbacks.push(renderFrame);
            Nri_SetInitializeCallback(this.sample, initialize);
            Nri_SetLatencySleepCallback(this.sample, latencySleep);
            Nri_SetRenderFrameCallback(this.sample, renderFrame);

            let result = Nri_RunSample(this.sample, argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (result == 0 && this.test) {
                const failure = checkFrame(this.readBack(), this.width, this.height);
                console.log(failure == "" ? "Test PASSED" : `Test FAILED: ${failure}`);
                result = failure == "" ? 0 : 1;
            }
            this.destroy();
            return result;
        }

        // SharedSimplePBR::CreateDeviceDependentResources and CreateWindowSizeDependentResources.
        initialize(graphicsAPI: NriGraphicsAPI): int {
            const device = Nri_CreateDevice(this.sample, graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri_GetGraphicsAPIString(graphicsAPI)} (${Nri_GetAdapterName(device)})`);

            this.queue = Nri_GetGraphicsQueue(device);
            this.frameFence = Nri_CreateFence(device, 0);
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.test = Nri_IsTest(this.sample) != 0;
            // Donut's -test runs without a window, so its display is never in HDR mode: SDR, as there.
            if (this.test) {
                this.forceSdr = true;
            }

            // The sample's R10G10B10A2_UNORM swap chain: sRGB's color space, or HDR10 when the
            // display is in HDR mode.
            this.createSwapChain(NriSwapChainFormat.BT709_G22_10BIT);
            const swapChain = this.swapChain;
            if (!swapChain) {
                console.log("Cannot create the swap chain");
                return 0;
            }
            if (Nri_IsDisplayHdr(swapChain) != 0 && !this.forceSdr) {
                this.destroySwapChain();
                this.createSwapChain(NriSwapChainFormat.BT2020_G2084_10BIT);
            }

            // CommonStates::AnisotropicClamp (16 samples), LinearWrap, and Donut's point clamp sampler.
            this.surfaceSampler = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.ClampToEdge,
                Math.min(16, Nri_GetMaxSamplerAnisotropy(device)));
            this.linearWrapSampler = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.Repeat, 1);
            this.pointClampSampler = Nri_CreateSampler(device, NriFilter.Nearest, NriAddressMode.ClampToEdge, 1);

            // The radiance map's levels: the sample uses three fewer ("The current map has too much
            // detail removed at last mips, scale back down to match reference."); the count is in the
            // DDS header.
            const radianceFile = Nri_LoadFile(MEDIA_DIR + "Stonewall_Ref_radiance.dds");
            if (radianceFile) {
                const header: int[] = [0, 0, 0, 0];
                Nri_CopyFileBytes(radianceFile, 28, 4, Ref(header[0]));
                const mips = header[0] + header[1] * 256 + header[2] * 65536 + header[3] * 16777216;
                this.numRadianceMips = Math.max(mips, 1) - 3;
                Nri_DestroyFile(radianceFile);
            }

            let loaded = true;
            for (const modelName of MODEL_NAMES) {
                const model = new Model();
                if (!model.load(device, this.queue, modelName)) {
                    loaded = false;
                }
                this.models.push(model);
            }
            const radiance = Nri_LoadDdsTexture(device, this.queue, MEDIA_DIR + "Stonewall_Ref_radiance.dds", 0);
            const irradiance = Nri_LoadDdsTexture(device, this.queue, MEDIA_DIR + "Stonewall_Ref_irradiance.dds", 0);
            this.radianceTexture = radiance;
            this.irradianceTexture = irradiance;
            if (!loaded || !radiance || !irradiance) {
                console.log("Cannot load the sample's models and textures: set XBOX_ATG_SAMPLES_DIR when configuring");
                return 0;
            }
            this.radianceView = Nri_CreateTextureCubeView(radiance, Nri_GetTextureFormat(radiance));
            this.irradianceView = Nri_CreateTextureCubeView(irradiance, Nri_GetTextureFormat(irradiance));

            // The sky box's geosphere (GeometricPrimitive::CreateGeoSphere(2.f): tessellation 3).
            const skyPositions: f32[] = [];
            const skyIndices: int[] = [];
            geoSphere(2.0, 3, skyPositions, skyIndices);
            this.skyVertices = Nri_CreateUploadedBuffer(device, this.queue, Ref(skyPositions[0]), skyPositions.length * 4, NriBufferUsage.VertexBuffer);
            this.skyIndices = Nri_CreateUploadedBufferFromInts(device, this.queue, Ref(skyIndices[0]), skyIndices.length * 4, NriBufferUsage.IndexBuffer);
            this.skyIndexCount = skyIndices.length;

            if (!this.createSizedTargets(device)) {
                console.log("Cannot create the HDR scene");
                return 0;
            }

            // The layouts (set 0 each): PBR_Constants (b0), the five textures (t0 to t4), the surface
            // and IBL samplers (s0, s1); the sky box's constants, cube map and sampler; the tone
            // mapping's constants, HDR scene and sampler.
            const pbrLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(pbrLayoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(pbrLayoutDesc, 0, 0, 5, NriDescriptorType.Texture, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(pbrLayoutDesc, 0, 0, 2, NriDescriptorType.Sampler, NriStage.VertexPixel, NriRangeFlags.None);
            this.pbrLayout = Nri_CreatePipelineLayoutFromDesc(device, pbrLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(pbrLayoutDesc);
            this.skyLayout = this.createSimpleLayout();
            this.toneMapLayout = this.createSimpleLayout();
            const pbrLayout = this.pbrLayout;
            const skyLayout = this.skyLayout;
            const toneMapLayout = this.toneMapLayout;
            if (!pbrLayout || !skyLayout || !toneMapLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: the shaders as compiled for the Donut example.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/simple_pbr/${folder}/`;
            // PBRModel::Create: Opaque, DepthDefault (less or equal), CullClockwise (counter-clockwise
            // triangles are front faces); ATG::VertexPositionNormalTextureTangent's input layout.
            const stride = this.models[0].vertexStride;
            const pbrDesc = Nri_CreatePipelineDesc();
            let pbrLoaded = Nri_PipelineDescAddShader(pbrDesc, NriShaderStage.Vertex, `${shaders}simple_pbr_pbr_vs.bin`, "pbr_vs") != 0;
            if (pbrLoaded) {
                pbrLoaded = Nri_PipelineDescAddShader(pbrDesc, NriShaderStage.Pixel, `${shaders}simple_pbr_pbr_ps.bin`, "pbr_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(pbrDesc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(pbrDesc, "NORMAL", NriFormat.RGB32_SFLOAT, 12);
            Nri_PipelineDescAddVertexAttribute(pbrDesc, "TANGENT", NriFormat.RGB32_SFLOAT, VERTEX_TANGENT);
            Nri_PipelineDescAddVertexAttribute(pbrDesc, "TEXCOORD", NriFormat.RG32_SFLOAT, 24);
            Nri_PipelineDescSetCullMode(pbrDesc, NriCullMode.Back);
            Nri_PipelineDescSetFrontCounterClockwise(pbrDesc, 1);
            Nri_PipelineDescSetDepthClip(pbrDesc, 0);
            Nri_PipelineDescSetColor(pbrDesc, NriFormat.R11_G11_B10_UFLOAT, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(pbrDesc, NriFormat.D32_SFLOAT, NriCompareOp.LessEqual, 1, 0);
            if (pbrLoaded) {
                this.pbrPipeline = Nri_CreatePipelineFromDesc(device, pbrLayout, pbrDesc);
            }
            Nri_DestroyPipelineDesc(pbrDesc);

            // DX::Skybox: DepthRead (less or equal, no writes), CullClockwise; positions only.
            const skyDesc = Nri_CreatePipelineDesc();
            let skyLoaded = Nri_PipelineDescAddShader(skyDesc, NriShaderStage.Vertex, `${shaders}simple_pbr_sky_sky_vs.bin`, "sky_vs") != 0;
            if (skyLoaded) {
                skyLoaded = Nri_PipelineDescAddShader(skyDesc, NriShaderStage.Pixel, `${shaders}simple_pbr_sky_sky_ps.bin`, "sky_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(skyDesc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescSetCullMode(skyDesc, NriCullMode.Back);
            Nri_PipelineDescSetFrontCounterClockwise(skyDesc, 1);
            Nri_PipelineDescSetDepthClip(skyDesc, 0);
            Nri_PipelineDescSetColor(skyDesc, NriFormat.R11_G11_B10_UFLOAT, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(skyDesc, NriFormat.D32_SFLOAT, NriCompareOp.LessEqual, 0, 0);
            if (skyLoaded) {
                this.skyPipeline = Nri_CreatePipelineFromDesc(device, skyLayout, skyDesc);
            }
            Nri_DestroyPipelineDesc(skyDesc);

            // The tone mapping into the swap chain texture: a triangle over it, no depth.
            this.acesPipeline = this.createToneMapPipeline(toneMapLayout, `${shaders}simple_pbr_tonemap`, "aces_filmic_srgb_ps");
            this.hdr10Pipeline = this.createToneMapPipeline(toneMapLayout, `${shaders}simple_pbr_tonemap`, "hdr10_ps");
            if (!this.pbrPipeline || !this.skyPipeline || !this.acesPipeline || !this.hdr10Pipeline) {
                console.log("Cannot load the simple PBR shaders");
                return 0;
            }

            // A queued frame's constants (the host constant buffer's part of it) and its sets: one per
            // model, the sky box's, the tone mapping's.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            const setsPerFrame = this.models.length + 2;
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * FRAME_CONSTANTS_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = Nri_CreateDescriptorPool(device, queuedFrameNum * setsPerFrame,
                queuedFrameNum * (this.models.length * 2 + 2), queuedFrameNum * setsPerFrame,
                queuedFrameNum * (this.models.length * 5 + 2), 0, 0);
            this.descriptorPool = descriptorPool;
            const radianceView = this.radianceView;
            const irradianceView = this.irradianceView;
            const hdrSceneView = this.hdrSceneView;
            const surfaceSampler = this.surfaceSampler;
            const linearWrapSampler = this.linearWrapSampler;
            const pointClampSampler = this.pointClampSampler;
            if (!constantBuffer || !descriptorPool || !radianceView || !irradianceView || !hdrSceneView || !surfaceSampler
                || !linearWrapSampler || !pointClampSampler) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const queuedFrame = new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator));
                this.queuedFrames.push(queuedFrame);
                const base = i * FRAME_CONSTANTS_STRIDE;
                const pbrView = Nri_CreateConstantBufferView(constantBuffer, base + PBR_OFFSET, PBR_FLOATS * 4);
                const skyView = Nri_CreateConstantBufferView(constantBuffer, base + SKY_OFFSET, 256);
                const toneMapView = Nri_CreateConstantBufferView(constantBuffer, base + TONE_MAP_OFFSET, 256);
                queuedFrame.pbrView = pbrView;
                queuedFrame.skyView = skyView;
                queuedFrame.toneMapView = toneMapView;
                if (!pbrView || !skyView || !toneMapView) {
                    console.log("Cannot create the descriptors");
                    return 0;
                }
                for (const model of this.models) {
                    const set = Nri_AllocateDescriptorSet(descriptorPool, pbrLayout, 0, 0);
                    const albedoView = model.albedoView;
                    const normalView = model.normalView;
                    const rmaView = model.rmaView;
                    if (!set || !albedoView || !normalView || !rmaView) {
                        console.log("Cannot create the descriptor sets");
                        return 0;
                    }
                    Nri_UpdateDescriptor(set, 0, 0, pbrView);
                    Nri_UpdateDescriptor(set, 1, 0, albedoView);
                    Nri_UpdateDescriptor(set, 1, 1, normalView);
                    Nri_UpdateDescriptor(set, 1, 2, rmaView);
                    Nri_UpdateDescriptor(set, 1, 3, radianceView);
                    Nri_UpdateDescriptor(set, 1, 4, irradianceView);
                    Nri_UpdateDescriptor(set, 2, 0, surfaceSampler);
                    Nri_UpdateDescriptor(set, 2, 1, linearWrapSampler);
                    queuedFrame.modelSets.push(set);
                }
                const skySet = Nri_AllocateDescriptorSet(descriptorPool, skyLayout, 0, 0);
                const toneMapSet = Nri_AllocateDescriptorSet(descriptorPool, toneMapLayout, 0, 0);
                queuedFrame.skySet = skySet;
                queuedFrame.toneMapSet = toneMapSet;
                if (!skySet || !toneMapSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(skySet, 0, 0, skyView);
                Nri_UpdateDescriptor(skySet, 1, 0, radianceView);
                Nri_UpdateDescriptor(skySet, 2, 0, linearWrapSampler);
                Nri_UpdateDescriptor(toneMapSet, 0, 0, toneMapView);
                Nri_UpdateDescriptor(toneMapSet, 1, 0, hdrSceneView);
                Nri_UpdateDescriptor(toneMapSet, 2, 0, pointClampSampler);
            }

            // The HUD's text.
            if (Nri_InitImgui(this.sample, device) == 0) {
                console.log("Cannot initialize the user interface");
                return 0;
            }
            this.imgui = true;
            this.font = Nri_ImguiCreateFont(FONT_PATH, FONT_SIZE);
            if (!this.font) {
                console.log("Cannot load the font: set DONUT_SAMPLES_MEDIA_DIR when configuring");
                return 0;
            }

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
            }
            return 1;
        }

        // A layout of a constant buffer (b0), a texture (t0) and a sampler (s0) in set 0.
        createSimpleLayout(): NriPipelineLayoutHandle | null {
            const device = this.device;
            if (!device) {
                return null;
            }
            const desc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(desc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(desc, 0, 0, 1, NriDescriptorType.Texture, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(desc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.VertexPixel, NriRangeFlags.None);
            const layout = Nri_CreatePipelineLayoutFromDesc(device, desc);
            Nri_DestroyPipelineLayoutDesc(desc);
            return layout;
        }

        createToneMapPipeline(layout: NriPipelineLayoutHandle, shaders: string, psEntry: string): NriPipelineHandle | null {
            const device = this.device;
            if (!device) {
                return null;
            }
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_quad_vs.bin`, "quad_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_${psEntry}.bin`, psEntry) != 0;
            }
            Nri_PipelineDescSetColor(desc, this.swapChainFormat, NriColorWrite.RGBA);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // A swap chain of format (NriSwapChainFormat), its textures' views and semaphores.
        createSwapChain(format: NriSwapChainFormat) {
            const device = this.device;
            if (!device) {
                return;
            }
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            const swapChain = Nri_CreateSwapChainWithFormat(this.sample, device, this.queue, queuedFrameNum + 1, format);
            this.swapChain = swapChain;
            this.hdr10 = format == NriSwapChainFormat.BT2020_G2084_10BIT;
            this.swapChainFormat = Nri_GetTextureFormat(Nri_GetSwapChainTexture(swapChain, 0));
            const textureNum = Nri_GetSwapChainTextureNum(swapChain);
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, this.swapChainFormat),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }
        }

        destroySwapChain() {
            for (const swapChainTexture of this.swapChainTextures) {
                Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
            }
            this.swapChainTextures = [];
            const swapChain = this.swapChain;
            if (swapChain) {
                Nri_DestroySwapChain(swapChain);
            }
            this.swapChain = null;
        }

        // The frame-sized targets: the R11G11B10 HDR scene, the D32 depth buffer.
        createSizedTargets(device: NriDeviceHandle): boolean {
            const hdrScene = Nri_CreateRenderTargetTexture(device, this.queue, this.width, this.height, NriFormat.R11_G11_B10_UFLOAT);
            this.hdrScene = hdrScene;
            const depth = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depth = depth;
            if (!hdrScene || !depth) {
                return false;
            }
            this.hdrSceneAttachment = Nri_CreateColorAttachmentView(hdrScene, NriFormat.R11_G11_B10_UFLOAT);
            this.hdrSceneView = Nri_CreateTextureView(hdrScene, NriFormat.R11_G11_B10_UFLOAT);
            this.depthAttachment = Nri_CreateDepthAttachmentView(depth, NriFormat.D32_SFLOAT);
            return true;
        }

        destroySizedTargets() {
            destroyDescriptor(this.hdrSceneAttachment);
            destroyDescriptor(this.hdrSceneView);
            destroyDescriptor(this.depthAttachment);
            destroyTexture(this.hdrScene);
            destroyTexture(this.depth);
            this.hdrSceneAttachment = null;
            this.hdrSceneView = null;
            this.depthAttachment = null;
            this.hdrScene = null;
            this.depth = null;
        }

        // The window was resized (Nri_UseResizableWindow): once the GPU is done with them, the swap
        // chain (its color space as before) and the frame-sized targets made again at its size, and
        // the queued frames' tone mapping sets pointed at the new HDR scene. The camera, the HUD's
        // layout and the viewports read the size every frame.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (Nri_GetOutputWidth(this.sample) == this.width && Nri_GetOutputHeight(this.sample) == this.height) {
                return;
            }
            Nri_DeviceWaitIdle(device);
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.destroySwapChain();
            this.createSwapChain(this.hdr10 ? NriSwapChainFormat.BT2020_G2084_10BIT : NriSwapChainFormat.BT709_G22_10BIT);
            this.destroySizedTargets();
            if (!this.createSizedTargets(device)) {
                return;
            }
            const hdrSceneView = this.hdrSceneView;
            if (hdrSceneView) {
                for (const queuedFrame of this.queuedFrames) {
                    const toneMapSet = queuedFrame.toneMapSet;
                    if (toneMapSet) {
                        Nri_UpdateDescriptor(toneMapSet, 1, 0, hdrSceneView);
                    }
                }
            }
        }

        // DeviceResources::UpdateColorSpace: HDR10 when the window's display is in HDR mode (the
        // swap chain made again, as Donut's color space change resizes it).
        updateColorSpace() {
            const device = this.device;
            const swapChain = this.swapChain;
            if (!device || !swapChain) {
                return;
            }
            const wanted = Nri_IsDisplayHdr(swapChain) != 0 && !this.forceSdr;
            if (wanted != this.hdr10) {
                Nri_DeviceWaitIdle(device);
                this.destroySwapChain();
                this.createSwapChain(wanted ? NriSwapChainFormat.BT2020_G2084_10BIT : NriSwapChainFormat.BT709_G22_10BIT);
            }
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // DirectXTK's Mouse and Keyboard state from NRIFramework's: the keys the camera reads, the
        // buttons, the cursor (and its movement in relative mode), the wheel.
        readInput() {
            const input = this.input;
            const keys = [KEY_A, KEY_D, KEY_S, KEY_W, KEY_RIGHT, KEY_LEFT, KEY_DOWN, KEY_UP, KEY_PAGE_UP, KEY_PAGE_DOWN, KEY_HOME, KEY_END,
                KEY_LEFT_SHIFT, KEY_RIGHT_SHIFT];
            for (const key of keys) {
                input.held[key] = Nri_IsKeyPressed(this.sample, key);
            }
            input.leftButton = Nri_IsButtonPressed(this.sample, 0) != 0;
            input.rightButton = Nri_IsButtonPressed(this.sample, 1) != 0;
            const x = Nri_GetMouseX(this.sample);
            const y = Nri_GetMouseY(this.sample);
            if (input.relative) {
                input.deltaX += x - input.x;
                input.deltaY += y - input.y;
            }
            input.x = x;
            input.y = y;
            input.scrollWheel += Nri_GetMouseWheel(this.sample) * 120.0;
        }

        // SharedSimplePBR::Update: the camera; and the display's mode.
        update(elapsedSeconds: number) {
            this.readInput();
            this.camera.width = this.width;
            this.camera.height = this.height;
            this.camera.update(Math.fround(elapsedSeconds), this.input);

            this.colorSpaceCheck -= elapsedSeconds;
            if (this.colorSpaceCheck <= 0.0) {
                this.updateColorSpace();
                this.colorSpaceCheck = 1.0;
            }
        }

        // PBREffect::Apply's constants (and SkyboxEffect's), for this frame's camera, into the queued
        // frame's part of the constant buffer.
        writeConstants(queuedFrameIndex: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            const view = this.camera.getView();
            const proj = this.camera.getProjection();
            const world = rotationY(Math.fround(Math.PI));
            const worldViewProj = multiplyF32(multiplyF32(world, view), proj);
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
            Nri_StoreInt32(Ref(c[PBR_NUM_RADIANCE_MIPS]), this.numRadianceMips);

            // SkyboxEffect::SetMatrices: the view without its translation, no world.
            const skyView = [view[0], view[1], view[2], view[3], view[4], view[5], view[6], view[7], view[8], view[9], view[10], view[11],
                0.0, 0.0, 0.0, 1.0];
            const skyWorldViewProjT = transpose(multiplyF32(skyView, proj));
            for (let i = 0; i < 16; i++) {
                this.skyConstants[i] = skyWorldViewProjT[i];
            }

            const base = queuedFrameIndex * FRAME_CONSTANTS_STRIDE;
            Nri_WriteBuffer(constantBuffer, base + PBR_OFFSET, Ref(this.pbrConstants[0]), PBR_FLOATS * 4);
            Nri_WriteBuffer(constantBuffer, base + SKY_OFFSET, Ref(this.skyConstants[0]), 256);
            Nri_WriteBuffer(constantBuffer, base + TONE_MAP_OFFSET, Ref(this.toneMapConstants[0]), 256);
        }

        // The sample's HUD (SpriteFont text in the title-safe area, in the HDR scene): its name at the
        // top, the keyboard and mouse legend at the bottom.
        buildUI() {
            const font = this.font;
            Nri_ImguiNewFrame(this.sample);
            if (font) {
                // SimpleMath::Viewport::ComputeTitleSafeArea
                const safeW = Math.fround((this.width + 19.0) / 20.0);
                const safeH = Math.fround((this.height + 19.0) / 20.0);
                const left: int = Math.floor(safeW);
                const top: int = Math.floor(safeH);
                const bottom: int = Math.floor(this.height - safeH + 0.5);
                Nri_ImguiPushFont(font);
                Nri_ImguiDrawText(left, top, "SimplePBR Sample", LIGHT_GREY_HDR, LIGHT_GREY_HDR, LIGHT_GREY_HDR, 1.0, 0);
                Nri_ImguiDrawText(left, bottom - LINE_SPACING, "Mouse, W,A,S,D: Move Camera   Esc: Exit ", LIGHT_GREY_HDR, LIGHT_GREY_HDR,
                    LIGHT_GREY_HDR, 1.0, 0);
                Nri_ImguiPopFont();
            }
            Nri_ImguiRender(this.sample);
        }

        // SharedSimplePBR::Render, the HDR scene: the models, then the sky box, then the HUD's text.
        recordScene(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const hdrScene = this.hdrScene;
            const hdrSceneAttachment = this.hdrSceneAttachment;
            const depthAttachment = this.depthAttachment;
            const descriptorPool = this.descriptorPool;
            const pbrLayout = this.pbrLayout;
            const pbrPipeline = this.pbrPipeline;
            const skyLayout = this.skyLayout;
            const skyPipeline = this.skyPipeline;
            const skySet = queuedFrame.skySet;
            const skyVertices = this.skyVertices;
            const skyIndices = this.skyIndices;
            if (!hdrScene || !hdrSceneAttachment || !depthAttachment || !descriptorPool || !pbrLayout || !pbrPipeline || !skyLayout
                || !skyPipeline || !skySet || !skyVertices || !skyIndices) {
                return;
            }
            Nri_CmdTextureBarrier(commandBuffer, hdrScene, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            Nri_CmdBeginRenderingWithDepth(commandBuffer, hdrSceneAttachment, depthAttachment);
            // Sample::Clear clears the depth (the sky box covers the scene's background; the color is
            // cleared too, which it overdraws, for D3D12's never-written render targets).
            Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
            Nri_CmdClearDepth(commandBuffer, 1.0);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);

            // Model Draw
            Nri_CmdSetPipelineLayout(commandBuffer, pbrLayout);
            Nri_CmdSetPipeline(commandBuffer, pbrPipeline);
            for (let m = 0; m < this.models.length; m++) {
                const model = this.models[m];
                Nri_CmdSetDescriptorSet(commandBuffer, 0, queuedFrame.modelSets[m]);
                for (let p = 0; p < model.partIndexCounts.length; p++) {
                    Nri_CmdSetVertexBuffer(commandBuffer, 0, model.vertexBuffers[model.partVertexBuffers[p]], 0, model.vertexStride);
                    const ib = model.partIndexBuffers[p];
                    let indexType = NriIndexType.UInt16;
                    if (model.index32[ib] != 0) {
                        indexType = NriIndexType.UInt32;
                    }
                    Nri_CmdSetIndexBuffer(commandBuffer, model.indexBuffers[ib], 0, indexType);
                    Nri_CmdDrawIndexed(commandBuffer, model.partIndexCounts[p], 1, model.partStartIndices[p], model.partVertexOffsets[p], 0);
                }
            }

            // Sky box
            Nri_CmdSetPipelineLayout(commandBuffer, skyLayout);
            Nri_CmdSetPipeline(commandBuffer, skyPipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, skySet);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, skyVertices, 0, 12);
            Nri_CmdSetIndexBuffer(commandBuffer, skyIndices, 0, NriIndexType.UInt32);
            Nri_CmdDrawIndexed(commandBuffer, this.skyIndexCount, 1, 0, 0, 0);
            Nri_CmdEndRendering(commandBuffer);

            // The text (a pass of its own: the UI's pipeline has no depth attachment).
            if (this.imgui) {
                Nri_CmdBeginRendering(commandBuffer, hdrSceneAttachment);
                Nri_CmdDrawImguiUnconverted(this.sample, commandBuffer, NriFormat.R11_G11_B10_UFLOAT);
                Nri_CmdEndRendering(commandBuffer);
            }
            Nri_CmdTextureBarrier(commandBuffer, hdrScene, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
        }

        // The tone mapping into the swap chain texture: HDR10 or SDR by the swap chain's color space.
        recordToneMap(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame, colorAttachment: NriDescriptorHandle) {
            const descriptorPool = this.descriptorPool;
            const toneMapLayout = this.toneMapLayout;
            const toneMapSet = queuedFrame.toneMapSet;
            const pipeline = this.hdr10 ? this.hdr10Pipeline : this.acesPipeline;
            if (!descriptorPool || !toneMapLayout || !toneMapSet || !pipeline) {
                return;
            }
            Nri_CmdBeginRendering(commandBuffer, colorAttachment);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            // (ImGui's draw bound its own pool.)
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, toneMapLayout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, toneMapSet);
            Nri_CmdDraw(commandBuffer, 3, 1, 0, 0);
            Nri_CmdEndRendering(commandBuffer);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            // The Donut example's test mode steps 1/60 s (a float) a frame.
            const elapsedSeconds = this.test ? Math.fround(1.0 / 60.0) : Nri_GetFrameTime(this.sample);
            this.update(elapsedSeconds);
            if (this.imgui) {
                this.buildUI();
            }
            this.writeConstants(queuedFrameIndex);
            const swapChain = this.swapChain;
            if (!swapChain) {
                return;
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the HDR scene and its text, then the tone mapping into the swap chain texture.
                Nri_BeginCommandBuffer(commandBuffer);
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                this.recordScene(commandBuffer, queuedFrame);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                this.recordToneMap(commandBuffer, queuedFrame, swapChainTexture.colorAttachment);

                // The test's last frame: read back
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                        Nri_CmdReadbackTextureToBuffer(commandBuffer, readbackBuffer, this.rowPitch, swapChainTexture.texture, this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                    }
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, presentFrom, NriTextureState.Present);
                Nri_EndCommandBuffer(commandBuffer);

                // Submit and present
                Nri_QueueSubmit(this.queue, commandBuffer, acquireSemaphore, swapChainTexture.releaseSemaphore);
                if (this.imgui) {
                    Nri_ImguiEndFrame(this.sample);
                }
                Nri_QueuePresent(swapChain, swapChainTexture.releaseSemaphore);
            }

            // Signaled after the present, as NRISamples do
            Nri_QueueSignal(this.queue, this.frameFence, 1 + frameIndex);
        }

        // The last frame's pixels (0xAABBGGRR: the 10-bit channels' top 8 bits), empty if it can't
        // be read.
        readBack(): int[] {
            const device = this.device;
            const readbackBuffer = this.readbackBuffer;
            if (!device || !readbackBuffer) {
                return [];
            }
            Nri_DeviceWaitIdle(device);
            const pixels: int[] = [];
            for (let i = 0; i < this.width * this.height; i++) {
                pixels.push(0);
            }
            if (Nri_ReadBufferRGBA8(readbackBuffer, this.rowPitch, this.width, this.height, this.swapChainFormat,
                Ref(pixels[0]), pixels.length) == 0) {
                return [];
            }
            return pixels;
        }

        destroy() {
            const device = this.device;
            if (device) {
                Nri_DeviceWaitIdle(device);
                if (this.imgui) {
                    Nri_DestroyImgui(this.sample);
                }
                for (const queuedFrame of this.queuedFrames) {
                    Nri_DestroyCommandBuffer(queuedFrame.commandBuffer);
                    Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
                    destroyDescriptor(queuedFrame.pbrView);
                    destroyDescriptor(queuedFrame.skyView);
                    destroyDescriptor(queuedFrame.toneMapView);
                }
                this.destroySwapChain();
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                for (const model of this.models) {
                    model.destroy();
                }
                destroyDescriptor(this.radianceView);
                destroyDescriptor(this.irradianceView);
                destroyDescriptor(this.surfaceSampler);
                destroyDescriptor(this.linearWrapSampler);
                destroyDescriptor(this.pointClampSampler);
                this.destroySizedTargets();
                destroyTexture(this.radianceTexture);
                destroyTexture(this.irradianceTexture);
                destroyBuffer(this.skyVertices);
                destroyBuffer(this.skyIndices);
                destroyBuffer(this.constantBuffer);
                destroyBuffer(this.readbackBuffer);
                destroyPipeline(this.pbrPipeline);
                destroyPipeline(this.skyPipeline);
                destroyPipeline(this.acesPipeline);
                destroyPipeline(this.hdr10Pipeline);
                destroyLayout(this.pbrLayout);
                destroyLayout(this.skyLayout);
                destroyLayout(this.toneMapLayout);
                Nri_DestroyFence(this.frameFence);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        Nri_UseResizableWindow(sample);
        const simplePbr = new SimplePbr(sample);
        // -sdr: the tone mapped SDR signal even on an HDR display. -noUI: accepted (the HUD is the
        // scene's, drawn as the Donut example draws it with -noUI).
        Nri_AddExampleOption(sample, "-sdr");
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            if (Nri_GetArg(argc, argv, i) == "-sdr") {
                simplePbr.forceSdr = true;
            }
        }
        return simplePbr.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return SimplePbrNri.main(argc, argv);
}

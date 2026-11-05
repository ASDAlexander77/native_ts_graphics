/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { SdkMesh } from "../../core/sdk_mesh";
import { rotationY, transpose, inverse, cross3, dot3, multiplyF32 } from "../../core/matrix";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriFile, NriImgui, NriImguiFont, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

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
        vertexBuffers: NriBuffer[] = [];
        indexBuffers: NriBuffer[] = [];
        // 1 for 32-bit indices, 0 for 16-bit (an int array: tslang reads bool arrays wrong).
        index32: int[] = [];
        partVertexBuffers: int[] = [];
        partIndexBuffers: int[] = [];
        partIndexCounts: int[] = [];
        partStartIndices: int[] = [];
        partVertexOffsets: int[] = [];
        vertexStride: int = 0;
        albedo: NriTexture | null = null;
        normal: NriTexture | null = null;
        rma: NriTexture | null = null;
        albedoView: NriDescriptor | null = null;
        normalView: NriDescriptor | null = null;
        rmaView: NriDescriptor | null = null;

        // False (after printing why) on failure.
        load(device: NriDevice, queue: NriQueue, name: string) {
            const file = NriFile.load(MEDIA_DIR + name + ".sdkmesh");
            if (!file) {
                return false;
            }
            const mesh = SdkMesh.load(file.getData(), file.getSize());
            if (mesh.isNull()) {
                file.destroy();
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
                const buffer = device.createUploadedBufferFromPointer(queue, mesh.getVertexBufferData(i), mesh.getVertexBufferSize(i),
                    NriBufferUsage.VertexBuffer);
                if (!buffer) {
                    ok = false;
                } else {
                    this.vertexBuffers.push(buffer);
                }
            }
            for (let i = 0; i < mesh.getIndexBufferCount(); i++) {
                const buffer = device.createUploadedBufferFromPointer(queue, mesh.getIndexBufferData(i), mesh.getIndexBufferSize(i),
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
            file.destroy();

            // DDS files: the albedo (BC1) as sRGB, as Donut's loadTexture(..., sRGB) loads it; the
            // normals (BC5) and RMA (BC7) as they are; all their mips.
            const albedo = device.loadDdsTexture(queue, MEDIA_DIR + name + "_BaseColor.dds", 1);
            const normal = device.loadDdsTexture(queue, MEDIA_DIR + name + "_Normal.dds", 0);
            const rma = device.loadDdsTexture(queue, MEDIA_DIR + name + "_RMA.dds", 0);
            this.albedo = albedo;
            this.normal = normal;
            this.rma = rma;
            if (!albedo || !normal || !rma) {
                return false;
            }
            this.albedoView = albedo.createView(albedo.getFormat());
            this.normalView = normal.createView(normal.getFormat());
            this.rmaView = rma.createView(rma.getFormat());
            return ok;
        }

        destroy() {
            for (const buffer of this.vertexBuffers) {
                buffer.destroy();
            }
            for (const buffer of this.indexBuffers) {
                buffer.destroy();
            }
            destroyDescriptor(this.albedoView);
            destroyDescriptor(this.normalView);
            destroyDescriptor(this.rmaView);
            destroyTexture(this.albedo);
            destroyTexture(this.normal);
            destroyTexture(this.rma);
        }
    }

    function destroyDescriptor(descriptor: NriDescriptor | null) {
        if (descriptor) {
            descriptor.destroy();
        }
    }

    function destroyTexture(texture: NriTexture | null) {
        if (texture) {
            texture.destroy();
        }
    }

    function destroyBuffer(buffer: NriBuffer | null) {
        if (buffer) {
            buffer.destroy();
        }
    }

    function destroyPipeline(pipeline: NriPipeline | null) {
        if (pipeline) {
            pipeline.destroy();
        }
    }

    function destroyLayout(layout: NriPipelineLayout | null) {
        if (layout) {
            layout.destroy();
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

    // A frame in flight's own data: its descriptor sets (over its constants): one per
    // model, the sky box's and the tone mapping's.
    class QueuedFrame {
        modelSets: NriDescriptorSet[] = [];
        skySet: NriDescriptorSet | null = null;
        toneMapSet: NriDescriptorSet | null = null;
        pbrView: NriDescriptor | null = null;
        skyView: NriDescriptor | null = null;
        toneMapView: NriDescriptor | null = null;
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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private hdr10: boolean = false;
        private queuedFrames: QueuedFrame[] = [];
        private models: Model[] = [];
        private radianceTexture: NriTexture | null = null;
        private irradianceTexture: NriTexture | null = null;
        private radianceView: NriDescriptor | null = null;
        private irradianceView: NriDescriptor | null = null;
        private numRadianceMips: int = 1;
        private surfaceSampler: NriDescriptor | null = null;
        private linearWrapSampler: NriDescriptor | null = null;
        private pointClampSampler: NriDescriptor | null = null;
        private constantBuffer: NriBuffer | null = null;
        private pbrLayout: NriPipelineLayout | null = null;
        private skyLayout: NriPipelineLayout | null = null;
        private toneMapLayout: NriPipelineLayout | null = null;
        private pbrPipeline: NriPipeline | null = null;
        private skyPipeline: NriPipeline | null = null;
        private acesPipeline: NriPipeline | null = null;
        private hdr10Pipeline: NriPipeline | null = null;
        private skyVertices: NriBuffer | null = null;
        private skyIndices: NriBuffer | null = null;
        private skyIndexCount: int = 0;
        private hdrScene: NriTexture | null = null;
        private hdrSceneAttachment: NriDescriptor | null = null;
        private hdrSceneView: NriDescriptor | null = null;
        private depth: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private imgui: boolean = false;
        private font: NriImguiFont | null = null;
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
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;

        constructor(private sample: NriSample) {
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
            this.sample.setInitializeCallback(initialize);
            this.sample.setLatencySleepCallback(latencySleep);
            this.sample.setRenderFrameCallback(renderFrame);

            let result = this.sample.run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
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
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);

            this.queue = device.getGraphicsQueue();
            this.width = this.sample.getOutputWidth();
            this.height = this.sample.getOutputHeight();
            this.test = this.sample.isTest() != 0;
            // Donut's -test runs without a window, so its display is never in HDR mode: SDR, as there.
            if (this.test) {
                this.forceSdr = true;
            }

            // The sample's R10G10B10A2_UNORM swap chain: sRGB's color space, or HDR10 when the
            // display is in HDR mode.
            this.createSwapChain(NriSwapChainFormat.BT709_G22_10BIT);
            if (!this.swapChain.exists()) {
                console.log("Cannot create the swap chain");
                return 0;
            }
            if (this.swapChain.object().isDisplayHdr() != 0 && !this.forceSdr) {
                this.createSwapChain(NriSwapChainFormat.BT2020_G2084_10BIT);
            }

            // CommonStates::AnisotropicClamp (16 samples), LinearWrap, and Donut's point clamp sampler.
            this.surfaceSampler = device.createSampler(NriFilter.Linear, NriAddressMode.ClampToEdge,
                Math.min(16, device.getMaxSamplerAnisotropy()));
            this.linearWrapSampler = device.createSampler(NriFilter.Linear, NriAddressMode.Repeat, 1);
            this.pointClampSampler = device.createSampler(NriFilter.Nearest, NriAddressMode.ClampToEdge, 1);

            // The radiance map's levels: the sample uses three fewer ("The current map has too much
            // detail removed at last mips, scale back down to match reference."); the count is in the
            // DDS header.
            const radianceFile = NriFile.load(MEDIA_DIR + "Stonewall_Ref_radiance.dds");
            if (radianceFile) {
                const header: int[] = [0, 0, 0, 0];
                radianceFile.copyBytes(28, 4, Ref(header[0]));
                const mips = header[0] + header[1] * 256 + header[2] * 65536 + header[3] * 16777216;
                this.numRadianceMips = Math.max(mips, 1) - 3;
                radianceFile.destroy();
            }

            let loaded = true;
            for (const modelName of MODEL_NAMES) {
                const model = new Model();
                if (!model.load(device, this.queue, modelName)) {
                    loaded = false;
                }
                this.models.push(model);
            }
            const radiance = device.loadDdsTexture(this.queue, MEDIA_DIR + "Stonewall_Ref_radiance.dds", 0);
            const irradiance = device.loadDdsTexture(this.queue, MEDIA_DIR + "Stonewall_Ref_irradiance.dds", 0);
            this.radianceTexture = radiance;
            this.irradianceTexture = irradiance;
            if (!loaded || !radiance || !irradiance) {
                console.log("Cannot load the sample's models and textures: set XBOX_ATG_SAMPLES_DIR when configuring");
                return 0;
            }
            this.radianceView = radiance.createCubeView(radiance.getFormat());
            this.irradianceView = irradiance.createCubeView(irradiance.getFormat());

            // The sky box's geosphere (GeometricPrimitive::CreateGeoSphere(2.f): tessellation 3).
            const skyPositions: f32[] = [];
            const skyIndices: int[] = [];
            geoSphere(2.0, 3, skyPositions, skyIndices);
            this.skyVertices = device.createUploadedBuffer(this.queue, Ref(skyPositions[0]), skyPositions.length * 4, NriBufferUsage.VertexBuffer);
            this.skyIndices = device.createUploadedBufferFromInts(this.queue, Ref(skyIndices[0]), skyIndices.length * 4, NriBufferUsage.IndexBuffer);
            this.skyIndexCount = skyIndices.length;

            if (!this.createSizedTargets(device)) {
                console.log("Cannot create the HDR scene");
                return 0;
            }

            // The layouts (set 0 each): PBR_Constants (b0), the five textures (t0 to t4), the surface
            // and IBL samplers (s0, s1); the sky box's constants, cube map and sampler; the tone
            // mapping's constants, HDR scene and sampler.
            const pbrLayoutDesc = NriPipelineLayoutDesc.create();
            pbrLayoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            pbrLayoutDesc.addRange(0, 0, 5, NriDescriptorType.Texture, NriStage.VertexPixel, NriRangeFlags.None);
            pbrLayoutDesc.addRange(0, 0, 2, NriDescriptorType.Sampler, NriStage.VertexPixel, NriRangeFlags.None);
            this.pbrLayout = device.createPipelineLayoutFromDesc(pbrLayoutDesc);
            pbrLayoutDesc.destroy();
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
            const pbrDesc = NriPipelineDesc.create();
            let pbrLoaded = pbrDesc.addShader(NriShaderStage.Vertex, `${shaders}simple_pbr_pbr_vs.bin`, "pbr_vs") != 0;
            if (pbrLoaded) {
                pbrLoaded = pbrDesc.addShader(NriShaderStage.Pixel, `${shaders}simple_pbr_pbr_ps.bin`, "pbr_ps") != 0;
            }
            pbrDesc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            pbrDesc.addVertexAttribute("NORMAL", NriFormat.RGB32_SFLOAT, 12);
            pbrDesc.addVertexAttribute("TANGENT", NriFormat.RGB32_SFLOAT, VERTEX_TANGENT);
            pbrDesc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, 24);
            pbrDesc.setCullMode(NriCullMode.Back);
            pbrDesc.setFrontCounterClockwise(1);
            pbrDesc.setDepthClip(0);
            pbrDesc.setColor(NriFormat.R11_G11_B10_UFLOAT, NriColorWrite.RGBA);
            pbrDesc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.LessEqual, 1, 0);
            if (pbrLoaded) {
                this.pbrPipeline = device.createPipelineFromDesc(pbrLayout, pbrDesc);
            }
            pbrDesc.destroy();

            // DX::Skybox: DepthRead (less or equal, no writes), CullClockwise; positions only.
            const skyDesc = NriPipelineDesc.create();
            let skyLoaded = skyDesc.addShader(NriShaderStage.Vertex, `${shaders}simple_pbr_sky_sky_vs.bin`, "sky_vs") != 0;
            if (skyLoaded) {
                skyLoaded = skyDesc.addShader(NriShaderStage.Pixel, `${shaders}simple_pbr_sky_sky_ps.bin`, "sky_ps") != 0;
            }
            skyDesc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            skyDesc.setCullMode(NriCullMode.Back);
            skyDesc.setFrontCounterClockwise(1);
            skyDesc.setDepthClip(0);
            skyDesc.setColor(NriFormat.R11_G11_B10_UFLOAT, NriColorWrite.RGBA);
            skyDesc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.LessEqual, 0, 0);
            if (skyLoaded) {
                this.skyPipeline = device.createPipelineFromDesc(skyLayout, skyDesc);
            }
            skyDesc.destroy();

            // The tone mapping into the swap chain texture: a triangle over it, no depth.
            this.acesPipeline = this.createToneMapPipeline(toneMapLayout, `${shaders}simple_pbr_tonemap`, "aces_filmic_srgb_ps");
            this.hdr10Pipeline = this.createToneMapPipeline(toneMapLayout, `${shaders}simple_pbr_tonemap`, "hdr10_ps");
            if (!this.pbrPipeline || !this.skyPipeline || !this.acesPipeline || !this.hdr10Pipeline) {
                console.log("Cannot load the simple PBR shaders");
                return 0;
            }

            // A queued frame's constants (the host constant buffer's part of it) and its sets: one per
            // model, the sky box's, the tone mapping's.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            const setsPerFrame = this.models.length + 2;
            const constantBuffer = device.createHostBuffer(queuedFrameNum * FRAME_CONSTANTS_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = device.createDescriptorPool(queuedFrameNum * setsPerFrame,
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
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const queuedFrame = new QueuedFrame();
                this.queuedFrames.push(queuedFrame);
                const base = i * FRAME_CONSTANTS_STRIDE;
                const pbrView = constantBuffer.createConstantView(base + PBR_OFFSET, PBR_FLOATS * 4);
                const skyView = constantBuffer.createConstantView(base + SKY_OFFSET, 256);
                const toneMapView = constantBuffer.createConstantView(base + TONE_MAP_OFFSET, 256);
                queuedFrame.pbrView = pbrView;
                queuedFrame.skyView = skyView;
                queuedFrame.toneMapView = toneMapView;
                if (!pbrView || !skyView || !toneMapView) {
                    console.log("Cannot create the descriptors");
                    return 0;
                }
                for (const model of this.models) {
                    const set = descriptorPool.allocateDescriptorSet(pbrLayout, 0, 0);
                    const albedoView = model.albedoView;
                    const normalView = model.normalView;
                    const rmaView = model.rmaView;
                    if (!set || !albedoView || !normalView || !rmaView) {
                        console.log("Cannot create the descriptor sets");
                        return 0;
                    }
                    set.updateDescriptor(0, 0, pbrView);
                    set.updateDescriptor(1, 0, albedoView);
                    set.updateDescriptor(1, 1, normalView);
                    set.updateDescriptor(1, 2, rmaView);
                    set.updateDescriptor(1, 3, radianceView);
                    set.updateDescriptor(1, 4, irradianceView);
                    set.updateDescriptor(2, 0, surfaceSampler);
                    set.updateDescriptor(2, 1, linearWrapSampler);
                    queuedFrame.modelSets.push(set);
                }
                const skySet = descriptorPool.allocateDescriptorSet(skyLayout, 0, 0);
                const toneMapSet = descriptorPool.allocateDescriptorSet(toneMapLayout, 0, 0);
                queuedFrame.skySet = skySet;
                queuedFrame.toneMapSet = toneMapSet;
                if (!skySet || !toneMapSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                skySet.updateDescriptor(0, 0, skyView);
                skySet.updateDescriptor(1, 0, radianceView);
                skySet.updateDescriptor(2, 0, linearWrapSampler);
                toneMapSet.updateDescriptor(0, 0, toneMapView);
                toneMapSet.updateDescriptor(1, 0, hdrSceneView);
                toneMapSet.updateDescriptor(2, 0, pointClampSampler);
            }

            // The HUD's text.
            if (this.sample.initImgui(device) == 0) {
                console.log("Cannot initialize the user interface");
                return 0;
            }
            this.imgui = true;
            this.font = NriImgui.createFont(FONT_PATH, FONT_SIZE);
            if (!this.font) {
                console.log("Cannot load the font: set DONUT_SAMPLES_MEDIA_DIR when configuring");
                return 0;
            }

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
            }
            return 1;
        }

        // A layout of a constant buffer (b0), a texture (t0) and a sampler (s0) in set 0.
        createSimpleLayout(): NriPipelineLayout | null {
            const device = this.device;
            if (!device) {
                return null;
            }
            const desc = NriPipelineLayoutDesc.create();
            desc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            desc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.VertexPixel, NriRangeFlags.None);
            desc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.VertexPixel, NriRangeFlags.None);
            const layout = device.createPipelineLayoutFromDesc(desc);
            desc.destroy();
            return layout;
        }

        createToneMapPipeline(layout: NriPipelineLayout, shaders: string, psEntry: string): NriPipeline | null {
            const device = this.device;
            if (!device) {
                return null;
            }
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_quad_vs.bin`, "quad_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_${psEntry}.bin`, psEntry) != 0;
            }
            desc.setColor(this.swapChainFormat, NriColorWrite.RGBA);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // The swap chain made in format (NriSwapChainFormat), or made again in it once the GPU's
        // done with the old one.
        createSwapChain(format: NriSwapChainFormat) {
            const device = this.device;
            if (!device) {
                return;
            }
            if (this.swapChain.exists()) {
                this.swapChain.recreateWithFormat(format);
            } else {
                this.swapChain.initWithFormat(this.sample, device, this.queue, format);
            }
            this.hdr10 = format == NriSwapChainFormat.BT2020_G2084_10BIT;
            this.swapChainFormat = this.swapChain.format();
        }

        // The frame-sized targets: the R11G11B10 HDR scene, the D32 depth buffer.
        createSizedTargets(device: NriDevice): boolean {
            const hdrScene = device.createRenderTargetTexture(this.queue, this.width, this.height, NriFormat.R11_G11_B10_UFLOAT);
            this.hdrScene = hdrScene;
            const depth = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depth = depth;
            if (!hdrScene || !depth) {
                return false;
            }
            this.hdrSceneAttachment = hdrScene.createColorAttachmentView(NriFormat.R11_G11_B10_UFLOAT);
            this.hdrSceneView = hdrScene.createView(NriFormat.R11_G11_B10_UFLOAT);
            this.depthAttachment = depth.createDepthAttachmentView(NriFormat.D32_SFLOAT);
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

        // The window was resized (NriSample.useResizableWindow): once the GPU is done with them, the swap
        // chain (its color space as before) and the frame-sized targets made again at its size, and
        // the queued frames' tone mapping sets pointed at the new HDR scene. The camera, the HUD's
        // layout and the viewports read the size every frame.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (this.sample.getOutputWidth() == this.width && this.sample.getOutputHeight() == this.height) {
                return;
            }
            device.waitIdle();
            this.width = this.sample.getOutputWidth();
            this.height = this.sample.getOutputHeight();
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
                        toneMapSet.updateDescriptor(1, 0, hdrSceneView);
                    }
                }
            }
        }

        // DeviceResources::UpdateColorSpace: HDR10 when the window's display is in HDR mode (the
        // swap chain made again, as Donut's color space change resizes it).
        updateColorSpace() {
            const device = this.device;
            if (!device || !this.swapChain.exists()) {
                return;
            }
            const wanted = this.swapChain.object().isDisplayHdr() != 0 && !this.forceSdr;
            if (wanted != this.hdr10) {
                this.createSwapChain(wanted ? NriSwapChainFormat.BT2020_G2084_10BIT : NriSwapChainFormat.BT709_G22_10BIT);
            }
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // DirectXTK's Mouse and Keyboard state from NRIFramework's: the keys the camera reads, the
        // buttons, the cursor (and its movement in relative mode), the wheel.
        readInput() {
            const input = this.input;
            const keys = [KEY_A, KEY_D, KEY_S, KEY_W, KEY_RIGHT, KEY_LEFT, KEY_DOWN, KEY_UP, KEY_PAGE_UP, KEY_PAGE_DOWN, KEY_HOME, KEY_END,
                KEY_LEFT_SHIFT, KEY_RIGHT_SHIFT];
            for (const key of keys) {
                input.held[key] = this.sample.isKeyPressed(key);
            }
            input.leftButton = this.sample.isButtonPressed(0) != 0;
            input.rightButton = this.sample.isButtonPressed(1) != 0;
            const x = this.sample.getMouseX();
            const y = this.sample.getMouseY();
            if (input.relative) {
                input.deltaX += x - input.x;
                input.deltaY += y - input.y;
            }
            input.x = x;
            input.y = y;
            input.scrollWheel += this.sample.getMouseWheel() * 120.0;
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
            Nri.storeInt32(Ref(c[PBR_NUM_RADIANCE_MIPS]), this.numRadianceMips);

            // SkyboxEffect::SetMatrices: the view without its translation, no world.
            const skyView = [view[0], view[1], view[2], view[3], view[4], view[5], view[6], view[7], view[8], view[9], view[10], view[11],
                0.0, 0.0, 0.0, 1.0];
            const skyWorldViewProjT = transpose(multiplyF32(skyView, proj));
            for (let i = 0; i < 16; i++) {
                this.skyConstants[i] = skyWorldViewProjT[i];
            }

            const base = queuedFrameIndex * FRAME_CONSTANTS_STRIDE;
            constantBuffer.write(base + PBR_OFFSET, Ref(this.pbrConstants[0]), PBR_FLOATS * 4);
            constantBuffer.write(base + SKY_OFFSET, Ref(this.skyConstants[0]), 256);
            constantBuffer.write(base + TONE_MAP_OFFSET, Ref(this.toneMapConstants[0]), 256);
        }

        // The sample's HUD (SpriteFont text in the title-safe area, in the HDR scene): its name at the
        // top, the keyboard and mouse legend at the bottom.
        buildUI() {
            const font = this.font;
            this.sample.imguiNewFrame();
            if (font) {
                // SimpleMath::Viewport::ComputeTitleSafeArea
                const safeW = Math.fround((this.width + 19.0) / 20.0);
                const safeH = Math.fround((this.height + 19.0) / 20.0);
                const left: int = Math.floor(safeW);
                const top: int = Math.floor(safeH);
                const bottom: int = Math.floor(this.height - safeH + 0.5);
                font.pushFont();
                NriImgui.drawText(left, top, "SimplePBR Sample", LIGHT_GREY_HDR, LIGHT_GREY_HDR, LIGHT_GREY_HDR, 1.0, 0);
                NriImgui.drawText(left, bottom - LINE_SPACING, "Mouse, W,A,S,D: Move Camera   Esc: Exit ", LIGHT_GREY_HDR, LIGHT_GREY_HDR,
                    LIGHT_GREY_HDR, 1.0, 0);
                NriImgui.popFont();
            }
            this.sample.imguiRender();
        }

        // SharedSimplePBR::Render, the HDR scene: the models, then the sky box, then the HUD's text.
        recordScene(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
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
            commandBuffer.textureBarrier(hdrScene, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            commandBuffer.beginRenderingWithDepth(hdrSceneAttachment, depthAttachment);
            // Sample::Clear clears the depth (the sky box covers the scene's background; the color is
            // cleared too, which it overdraws, for D3D12's never-written render targets).
            commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
            commandBuffer.clearDepth(1.0);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);

            // Model Draw
            commandBuffer.setPipelineLayout(pbrLayout);
            commandBuffer.setPipeline(pbrPipeline);
            for (let m = 0; m < this.models.length; m++) {
                const model = this.models[m];
                commandBuffer.setDescriptorSet(0, queuedFrame.modelSets[m]);
                for (let p = 0; p < model.partIndexCounts.length; p++) {
                    commandBuffer.setVertexBuffer(0, model.vertexBuffers[model.partVertexBuffers[p]], 0, model.vertexStride);
                    const ib = model.partIndexBuffers[p];
                    let indexType = NriIndexType.UInt16;
                    if (model.index32[ib] != 0) {
                        indexType = NriIndexType.UInt32;
                    }
                    commandBuffer.setIndexBuffer(model.indexBuffers[ib], 0, indexType);
                    commandBuffer.drawIndexed(model.partIndexCounts[p], 1, model.partStartIndices[p], model.partVertexOffsets[p], 0);
                }
            }

            // Sky box
            commandBuffer.setPipelineLayout(skyLayout);
            commandBuffer.setPipeline(skyPipeline);
            commandBuffer.setDescriptorSet(0, skySet);
            commandBuffer.setVertexBuffer(0, skyVertices, 0, 12);
            commandBuffer.setIndexBuffer(skyIndices, 0, NriIndexType.UInt32);
            commandBuffer.drawIndexed(this.skyIndexCount, 1, 0, 0, 0);
            commandBuffer.endRendering();

            // The text (a pass of its own: the UI's pipeline has no depth attachment).
            if (this.imgui) {
                commandBuffer.beginRendering(hdrSceneAttachment);
                this.sample.drawImguiUnconverted(commandBuffer, NriFormat.R11_G11_B10_UFLOAT);
                commandBuffer.endRendering();
            }
            commandBuffer.textureBarrier(hdrScene, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
        }

        // The tone mapping into the swap chain texture: HDR10 or SDR by the swap chain's color space.
        recordToneMap(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame, colorAttachment: NriDescriptor) {
            const descriptorPool = this.descriptorPool;
            const toneMapLayout = this.toneMapLayout;
            const toneMapSet = queuedFrame.toneMapSet;
            const pipeline = this.hdr10 ? this.hdr10Pipeline : this.acesPipeline;
            if (!descriptorPool || !toneMapLayout || !toneMapSet || !pipeline) {
                return;
            }
            commandBuffer.beginRendering(colorAttachment);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            // (ImGui's draw bound its own pool.)
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(toneMapLayout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setDescriptorSet(0, toneMapSet);
            commandBuffer.draw(3, 1, 0, 0);
            commandBuffer.endRendering();
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            // The Donut example's test mode steps 1/60 s (a float) a frame.
            const elapsedSeconds = this.test ? Math.fround(1.0 / 60.0) : this.sample.getFrameTime();
            this.update(elapsedSeconds);
            if (this.imgui) {
                this.buildUI();
            }
            this.writeConstants(queuedFrameIndex);
            if (!this.swapChain.exists()) {
                return;
            }

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the HDR scene and its text, then the tone mapping into the swap chain texture.
                commandBuffer.begin();
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                this.recordScene(commandBuffer, queuedFrame);
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                this.recordToneMap(commandBuffer, queuedFrame, this.swapChain.colorAttachment(index));

                // The test's last frame: read back
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        commandBuffer.textureBarrier(texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                        commandBuffer.readbackTextureToBuffer(readbackBuffer, this.rowPitch, texture, this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                    }
                }
                commandBuffer.textureBarrier(texture, presentFrom, NriTextureState.Present);
                commandBuffer.end();

                // Submit and present
                this.swapChain.submit(commandBuffer, index);
                if (this.imgui) {
                    this.sample.imguiEndFrame();
                }
                this.swapChain.present(index);
            }

            // Signaled after the present, as NRISamples do
            this.frames.signal(frameIndex);
        }

        // The last frame's pixels (0xAABBGGRR: the 10-bit channels' top 8 bits), empty if it can't
        // be read.
        readBack(): int[] {
            const device = this.device;
            const readbackBuffer = this.readbackBuffer;
            if (!device || !readbackBuffer) {
                return [];
            }
            device.waitIdle();
            const pixels: int[] = [];
            for (let i = 0; i < this.width * this.height; i++) {
                pixels.push(0);
            }
            if (readbackBuffer.readRGBA8(this.rowPitch, this.width, this.height, this.swapChainFormat,
                Ref(pixels[0]), pixels.length) == 0) {
                return [];
            }
            return pixels;
        }

        destroy() {
            const device = this.device;
            if (device) {
                device.waitIdle();
                if (this.imgui) {
                    this.sample.destroyImgui();
                }
                for (const queuedFrame of this.queuedFrames) {
                    destroyDescriptor(queuedFrame.pbrView);
                    destroyDescriptor(queuedFrame.skyView);
                    destroyDescriptor(queuedFrame.toneMapView);
                }
                this.swapChain.destroy();
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
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
                this.frames.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const simplePbr = new SimplePbr(sample);
        // -sdr: the tone mapped SDR signal even on an HDR display. -noUI: accepted (the HUD is the
        // scene's, drawn as the Donut example draws it with -noUI).
        sample.addExampleOption("-sdr");
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            if (Nri.getArg(argc, argv, i) == "-sdr") {
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

/// <reference path="../../core/nri/nri_interop.d.ts" />
import { MeshletModel } from "../../core/meshlet_model";
import {
    dot3, matrixInverse, matrixLookToRH, matrixMultiply, matrixPerspectiveFovRH,
    matrixScaling, matrixTranspose, normalize3, planeNormalize, row, transform3, transformCoord3,
    transformNormal3, vadd, vsub, XM_PI,
} from "../../core/directx_math";

namespace MeshletCullNri {
    // meshlet_cull, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut
    // and NVRHI: the same shaders (meshlet_cull.hlsl's and meshlet_cull_visualizers.hlsl's) and models
    // (core/meshlet_model.cpp reads them), through the NRI calls core/nri/nri_interop.d.ts binds. This
    // example creates everything it runs, and does the rendering. The keys are Donut's Key values
    // (GLFW's key codes), which Nri_IsKeyPressed takes.

    const WINDOW_TITLE = "NRI Example: D3D12 Mesh Shader Culling";
    const MEDIA_DIR = "media/meshlet_cull/";

    // Shared.h.
    const AS_GROUP_SIZE = 32;
    const CULL_FLAG = 1;
    const MESHLET_FLAG = 2;

    // Constants: View, ViewProj, Planes[6], ViewPosition, HighlightedIndex (uint), CullViewPosition,
    // SelectedIndex (uint), DrawMeshlets (uint): 65 floats in a 512-byte constant buffer view.
    const CONSTANTS_SIZE = 512;
    const CONSTANT_FLOATS = 65;
    const HIGHLIGHTED_FLOAT = 59;
    const SELECTED_FLOAT = 63;
    const DRAW_MESHLETS_FLOAT = 64;
    // Instance: World, WorldInvTrans, Scale, Flags (uint).
    const INSTANCE_SIZE = 256;
    const INSTANCE_FLOATS = 34;
    const FLAGS_FLOAT = 33;
    // MeshInfo: IndexSize, MeshletCount, LastMeshletVertCount, LastMeshletPrimCount.
    const MESH_INFO_SIZE = 256;
    // FrustumVisualizer's Constants: ViewProj, Planes[6], LineColor.
    const FRUSTUM_CONSTANTS_SIZE = 256;
    const FRUSTUM_FLOATS = 44;
    // CullDataVisualizer's Constants: World, ViewProj, Color, ViewUp (float4), ViewForward, Scale.
    const CULL_DATA_CONSTANTS_SIZE = 256;
    const CULL_DATA_FLOATS = 48;
    // Its root constants: MeshletOffset, MeshletCount.
    const OPTIONS_SIZE = 8;
    // The files' records: vertices (position, normal), meshlets (4 uints), culling data (bounding
    // sphere, packed normal cone, apex offset).
    const VERTEX_STRIDE = 24;
    const MESHLET_STRIDE = 16;
    const CULL_DATA_STRIDE = 24;

    // A queued frame's constants, in one host buffer: the Constants, the frustum's, the culling
    // data's, then each object's Instance.
    const FRUSTUM_OFFSET = CONSTANTS_SIZE;
    const CULL_DATA_OFFSET = FRUSTUM_OFFSET + FRUSTUM_CONSTANTS_SIZE;
    const INSTANCES_OFFSET = CULL_DATA_OFFSET + CULL_DATA_CONSTANTS_SIZE;

    // The sample's clear color, (0, 0.2, 0.4).
    const CLEAR_R = 0.0;
    const CLEAR_G = 0.2;
    const CLEAR_B = 0.4;

    // DirectX::Colors::Purple and Yellow.
    const PURPLE = Math.fround(0.501960814);

    // Test mode: the frames rendered, each 1/60 s; the mouse at the window's center, and the
    // meshlet under it selected before the second frame (as Tab would).
    const TEST_FRAMES = 3;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no mesh shaders.
    const TEST_SKIPPED = 77;

    // The sample's c_sceneDefinition: the dragon (culled, in meshlet colors), and the culling
    // camera's model, whose transform follows that camera.
    const MODEL_FILES = ["Dragon_LOD0.bin", "Camera.bin"];
    const OBJECT_SCALES = [0.2, 1.0];
    const OBJECT_FLAGS = [CULL_FLAG | MESHLET_FLAG, 0];
    const VIEW_MODEL = 0;
    const DEBUG_CAMERA = 1;

    // The cameras' keys; Space and Tab, acted on when pressed.
    const CAMERA_KEYS = [Key.W, Key.A, Key.S, Key.D, Key.Left, Key.Right, Key.Up, Key.Down];

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // A buffer the shaders read and its view.
    class ShaderBuffer {
        constructor(public buffer: NriBufferHandle, public view: NriDescriptorHandle) {
        }
    }

    // DirectX-Graphics-Samples' SimpleCamera: WASD move it, the arrow keys turn it (pitch within 45
    // degrees up and down), at its move and turn speeds per second.
    class SimpleCamera {
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

        init(x: number, y: number, z: number) {
            this.initialPosition = [Math.fround(x), Math.fround(y), Math.fround(z), 0.0];
            this.reset();
        }

        setMoveSpeed(unitsPerSecond: number) {
            this.moveSpeed = Math.fround(unitsPerSecond);
        }

        reset() {
            this.position = [this.initialPosition[0], this.initialPosition[1], this.initialPosition[2], 0.0];
            this.yaw = XM_PI;
            this.pitch = 0.0;
            this.lookDirection = [0.0, 0.0, -1.0, 0.0];
        }

        onKey(key: Key, down: boolean) {
            let index = -1;
            if (key == Key.W) {
                index = 0;
            } else if (key == Key.A) {
                index = 1;
            } else if (key == Key.S) {
                index = 2;
            } else if (key == Key.D) {
                index = 3;
            } else if (key == Key.Left) {
                index = 4;
            } else if (key == Key.Right) {
                index = 5;
            } else if (key == Key.Up) {
                index = 6;
            } else if (key == Key.Down) {
                index = 7;
            }
            if (index >= 0) {
                this.keys[index] = down ? 1 : 0;
            }
        }

        update(elapsedSeconds: number) {
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

        viewMatrix() {
            return matrixLookToRH(this.position, this.lookDirection, [0.0, 1.0, 0.0, 0.0]);
        }

        // Near 1, far farZ.
        projectionMatrix(fovY: number, aspectRatio: number, farZ: number) {
            return matrixPerspectiveFovRH(fovY, aspectRatio, 1.0, farZ);
        }
    }

    // A mesh of a model: its GPU buffers (bound as root descriptors) and its meshlets, primitives,
    // unique vertex indices, positions and culling data on the CPU, for picking.
    class MeshletMesh {
        meshInfo: NriBufferHandle;
        meshInfoView: NriDescriptorHandle;
        vertices: ShaderBuffer;
        meshletBuffer: ShaderBuffer;
        uniqueVertexIndices: ShaderBuffer;
        primitiveBuffer: ShaderBuffer;
        cullData: ShaderBuffer;
        meshletCount: int;
        indexSize: int;
        meshlets: int[];
        primitives: int[];
        uniqueIndices: int[];
        positions: f32[];
        cullFloats: f32[];

        constructor(meshInfo: NriBufferHandle, meshInfoView: NriDescriptorHandle, vertices: ShaderBuffer, meshletBuffer: ShaderBuffer,
            uniqueVertexIndices: ShaderBuffer, primitiveBuffer: ShaderBuffer, cullData: ShaderBuffer, meshletCount: int, indexSize: int) {
            this.meshInfo = meshInfo;
            this.meshInfoView = meshInfoView;
            this.vertices = vertices;
            this.meshletBuffer = meshletBuffer;
            this.uniqueVertexIndices = uniqueVertexIndices;
            this.primitiveBuffer = primitiveBuffer;
            this.cullData = cullData;
            this.meshletCount = meshletCount;
            this.indexSize = indexSize;
            this.meshlets = [];
            this.primitives = [];
            this.uniqueIndices = [];
            this.positions = [];
            this.cullFloats = [];
        }

        // Mesh::GetVertexIndex: the index-th unique vertex index, 16- or 32-bit.
        vertexIndex(index: int): int {
            if (this.indexSize == 4) {
                return this.uniqueIndices[index];
            }
            const pair = this.uniqueIndices[index >> 1];
            return (index & 1) == 0 ? pair & 0xFFFF : (pair >> 16) & 0xFFFF;
        }
    }

    // A scene object: a model's meshes, its world transform (row vectors), its Instance constants
    // (with the flags) and their offset in a queued frame's constants.
    class SceneObject {
        meshes: MeshletMesh[];
        world: number[];
        instanceConstants: f32[];
        instanceOffset: int;

        constructor(instanceOffset: int, flags: int, scale: number) {
            this.meshes = [];
            this.world = matrixScaling(scale, scale, scale);
            this.instanceOffset = instanceOffset;
            this.instanceConstants = [];
            for (let i = 0; i < INSTANCE_FLOATS; i++) {
                this.instanceConstants.push(0.0);
            }
            Nri_StoreInt32(Ref(this.instanceConstants[FLAGS_FLOAT]), flags);
        }
    }

    // RayIntersectSphere: whether the ray (o, d) meets the sphere (center, radius in s).
    function rayIntersectSphere(o: number[], d: number[], s: number[]) {
        const l = vsub(o, s);
        const r = s[3];
        const a = dot3(d, d);
        const b = Math.fround(2.0 * dot3(l, d));
        const c = Math.fround(dot3(l, l) - Math.fround(r * r));
        const disc = Math.fround(Math.fround(b * b) - Math.fround(Math.fround(4.0 * a) * c));
        return !(disc < 0.0);
    }

    // RayIntersectTriangle (Moller-Trumbore): the ray's t at the triangle, -1 if it misses it.
    const EPSILON = 1.192092896e-7;
    function rayIntersectTriangle(o: number[], d: number[], p0: number[], p1: number[], p2: number[]) {
        const edge1 = vsub(p1, p0);
        const edge2 = vsub(p2, p0);
        const h = cross(d, edge2);
        const a = dot3(edge1, h);
        if (Math.abs(a) < EPSILON) {
            return -1.0;
        }
        const f = Math.fround(1.0 / a);
        const s = vsub(o, p0);
        const u = Math.fround(f * dot3(s, h));
        if (u < 0.0 || u > 1.0) {
            return -1.0;
        }
        const q = cross(s, edge1);
        const v = Math.fround(f * dot3(d, q));
        if (v < 0.0 || Math.fround(u + v) > 1.0) {
            return -1.0;
        }
        const t = Math.fround(f * dot3(edge2, q));
        if (t > EPSILON && t < 1.0 / EPSILON) {
            return t;
        }
        return -1.0;
    }

    function cross(a: number[], b: number[]) {
        return [
            Math.fround(Math.fround(a[1] * b[2]) - Math.fround(a[2] * b[1])),
            Math.fround(Math.fround(a[2] * b[0]) - Math.fround(a[0] * b[2])),
            Math.fround(Math.fround(a[0] * b[1]) - Math.fround(a[1] * b[0])),
            0.0,
        ];
    }

    // XMMatrixDecompose's scale x: the length of the first row.
    function scaleOf(m: number[]) {
        const r = row(m, 0);
        return Math.fround(Math.sqrt(dot3(r, r)));
    }

    // -test: checks the last frame, read back, as the Donut example does, with the meshlet under the
    // window's center selected. The background is the clear color at the corners; the selected
    // meshlet keeps its color and the others are desaturated (nearly gray); its bounding sphere is
    // blended yellow over the dragon; the culling camera's frustum is purple lines.
    function checkFrame(pixels: int[], width: int, height: int, selectedIndex: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        if (selectedIndex < 0) {
            return "no meshlet under the window's center was picked";
        }
        const background = 0 | (51 << 8) | (102 << 16);
        const corners = [0, width - 1, (height - 1) * width, height * width - 1];
        for (const cornerIndex of corners) {
            const p = pixels[cornerIndex] & 0xFFFFFF;
            if (p != background) {
                return `corner pixel ${cornerIndex} is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not the clear color`;
            }
        }

        // Saturated pixels (the selected meshlet's, the frustum's purple, the sphere's yellow) and
        // gray ones (the desaturated meshlets).
        let covered = 0;
        let gray = 0;
        let purple = 0;
        let yellow = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            if (p == background) {
                continue;
            }
            covered++;
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            let lo = r;
            let hi = r;
            if (g < lo) {
                lo = g;
            }
            if (b < lo) {
                lo = b;
            }
            if (g > hi) {
                hi = g;
            }
            if (b > hi) {
                hi = b;
            }
            if (hi - lo < hi / 4 + 4) {
                gray++;
            }
            if (r == 128 && g == 0 && b == 128) {
                purple++;
            }
            // Yellow at 30% over the dragon's dark grays.
            if (r > b + 40 && g > b + 40) {
                yellow++;
            }
        }
        console.log(`Covered ${covered}, gray ${gray}, frustum ${purple}, yellow ${yellow}, selected meshlet ${selectedIndex}`);
        if (covered < width * height / 20) {
            return `only ${covered} pixels covered`;
        }
        if (gray < covered / 2) {
            return `the other meshlets aren't desaturated: ${gray} gray pixels of ${covered}`;
        }
        if (purple < 200) {
            return `no frustum lines: ${purple} purple pixels`;
        }
        if (yellow < 200) {
            return `no bounding sphere: ${yellow} yellow pixels`;
        }
        return "";
    }

    // Port of DirectX-Graphics-Samples' D3D12MeshShaders MeshletCull (as examples/meshlet_cull.ts
    // ports it) to NRI: an amplification shader per wave of meshlets culls them against the culling
    // (debug) camera's frustum and by their normal cones, launching mesh shader groups for the
    // visible ones. The culling camera's frustum and model are drawn too; the meshlet under the mouse
    // is highlighted (a ray cast on the CPU against the meshlets' bounding spheres and triangles),
    // Tab selects it and draws its bounding sphere and normal cone. Shift moves the culling camera
    // instead of the main one; Space switches meshlet colors. Drawn into the UNORM swap chain texture
    // (the sample's R8G8B8A8_UNORM back buffer) with a D32_FLOAT depth buffer; the sample's root
    // signatures' CBVs and SRVs are root descriptors.
    class MeshletCull {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private meshLayout: NriPipelineLayoutHandle | null = null;
        private frustumLayout: NriPipelineLayoutHandle | null = null;
        private cullDataLayout: NriPipelineLayoutHandle | null = null;
        private meshPipeline: NriPipelineHandle | null = null;
        private frustumPipeline: NriPipelineHandle | null = null;
        private spherePipeline: NriPipelineHandle | null = null;
        private conePipeline: NriPipelineHandle | null = null;
        // A queued frame's constants each, frameConstantsSize bytes apart; views of 512 and 256
        // bytes, bound with their offsets.
        private constantBuffer: NriBufferHandle | null = null;
        private constantsView: NriDescriptorHandle | null = null;
        private constants256View: NriDescriptorHandle | null = null;
        private frameConstantsSize: int = 0;
        private objects: SceneObject[] = [];
        // What update wrote, for the frame's draws.
        private constants: f32[] = [];
        private frustumConstants: f32[] = [];
        private cullDataConstants: f32[] = [];
        private options: f32[] = [0.0, 0.0];
        private mainCam: SimpleCamera = new SimpleCamera();
        private debugCam: SimpleCamera = new SimpleCamera();
        private fovY: number = Math.fround(XM_PI / 3.0);
        private aspectRatio: number = Math.fround(1280.0 / 720.0);
        private width: int = 1280;
        private height: int = 720;
        private moveCam: boolean = false;
        // Space and Tab's state at the last frame, for their presses.
        private spaceDown: boolean = false;
        private tabDown: boolean = false;
        // The cursor moved over the window (picking starts then, as the sample's mouse events).
        private mouseMoved: boolean = false;
        drawMeshlets: boolean = true;
        highlightedIndex: int = -1;
        selectedIndex: int = -1;
        // The mouse position in the window, -1 before it's known.
        mouseX: number = -1.0;
        mouseY: number = -1.0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart; the
        // meshlet under the window's center selected before the second frame.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;
        private frameNumber: int = 0;
        private selectBeforeFrame: int = 0;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < CONSTANT_FLOATS; i++) {
                this.constants.push(0.0);
            }
            for (let i = 0; i < FRUSTUM_FLOATS; i++) {
                this.frustumConstants.push(0.0);
            }
            for (let i = 0; i < CULL_DATA_FLOATS; i++) {
                this.cullDataConstants.push(0.0);
            }
            Nri_StoreInt32(Ref(this.options[1]), 1);
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
            if (this.unsupportedReason != "") {
                const test = Nri_IsTest(this.sample) != 0;
                console.log(test ? `Test SKIPPED: ${this.unsupportedReason}` : this.unsupportedReason);
                result = test ? TEST_SKIPPED : 1;
            } else if (result == 0 && this.test) {
                const failure = checkFrame(this.readBack(), this.width, this.height, this.selectedIndex);
                console.log(failure == "" ? "Test PASSED" : `Test FAILED: ${failure}`);
                result = failure == "" ? 0 : 1;
            }
            this.destroy();
            return result;
        }

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
            if (this.test) {
                this.mouseX = 640.0;
                this.mouseY = 360.0;
                this.selectBeforeFrame = 2;
            }

            // Swap chain: rendered through UNORM views, as the sample's R8G8B8A8_UNORM back buffer.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, queuedFrameNum + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            this.viewFormat = format;
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(this.swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, format),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }

            // Queued frames
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator)));
            }

            if (Nri_IsFeatureSupported(device, NriFeature.MeshShader) == 0) {
                this.unsupportedReason = "The graphics device has no mesh shaders";
                return 0;
            }

            // The sample's depth buffer: D32, cleared to 1.
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return 0;
            }
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            // The sample's root signatures, as root descriptors: CBV(b0), CBV(b1), CBV(b2), SRV(t0)
            // .. SRV(t4); the frustum's CBV(b0); the culling data's CBV(b0), RootConstants(b1, 2),
            // SRV(t0).
            const meshLayoutDesc = Nri_CreatePipelineLayoutDesc();
            for (let b = 0; b < 3; b++) {
                Nri_PipelineLayoutDescAddRootDescriptor(meshLayoutDesc, b, NriDescriptorType.ConstantBuffer, NriStage.AllGraphics);
            }
            for (let t = 0; t < 5; t++) {
                Nri_PipelineLayoutDescAddRootDescriptor(meshLayoutDesc, t, NriDescriptorType.StructuredBuffer, NriStage.AllGraphics);
            }
            this.meshLayout = Nri_CreatePipelineLayoutFromDesc(device, meshLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(meshLayoutDesc);
            const frustumLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootDescriptor(frustumLayoutDesc, 0, NriDescriptorType.ConstantBuffer, NriStage.AllGraphics);
            this.frustumLayout = Nri_CreatePipelineLayoutFromDesc(device, frustumLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(frustumLayoutDesc);
            const cullDataLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(cullDataLayoutDesc, 1, OPTIONS_SIZE, NriStage.AllGraphics);
            Nri_PipelineLayoutDescAddRootDescriptor(cullDataLayoutDesc, 0, NriDescriptorType.ConstantBuffer, NriStage.AllGraphics);
            Nri_PipelineLayoutDescAddRootDescriptor(cullDataLayoutDesc, 0, NriDescriptorType.StructuredBuffer, NriStage.AllGraphics);
            this.cullDataLayout = Nri_CreatePipelineLayoutFromDesc(device, cullDataLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(cullDataLayoutDesc);
            const meshLayout = this.meshLayout;
            const frustumLayout = this.frustumLayout;
            const cullDataLayout = this.cullDataLayout;
            if (!meshLayout || !frustumLayout || !cullDataLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The sample's pipeline states (the shaders as compiled for the Donut example): the
            // meshlets with culling off (to see the backs of culled meshlets), the frustum's lines,
            // the bounding sphere blended over the scene and the normal cone's lines, those two
            // without depth testing.
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/meshlet_cull/${folder}/meshlet_cull`;
            const visualizers = `shaders/meshlet_cull/${folder}/meshlet_cull_visualizers`;
            this.meshPipeline = this.createPipeline(device, meshLayout, `${shaders}_main_as.bin`, "main_as", `${shaders}_main_ms.bin`, "main_ms",
                `${shaders}_main_ps.bin`, "main_ps", 0);
            this.frustumPipeline = this.createPipeline(device, frustumLayout, "", "", `${visualizers}_frustum_ms.bin`, "frustum_ms",
                `${visualizers}_debug_ps.bin`, "debug_ps", 1);
            this.spherePipeline = this.createPipeline(device, cullDataLayout, "", "", `${visualizers}_sphere_ms.bin`, "sphere_ms",
                `${visualizers}_debug_ps.bin`, "debug_ps", 2);
            this.conePipeline = this.createPipeline(device, cullDataLayout, "", "", `${visualizers}_cone_ms.bin`, "cone_ms",
                `${visualizers}_debug_ps.bin`, "debug_ps", 3);
            if (!this.meshPipeline || !this.frustumPipeline || !this.spherePipeline || !this.conePipeline) {
                console.log("Cannot load the meshlet culling shaders");
                return 0;
            }

            // The constants: a queued frame's each.
            this.frameConstantsSize = INSTANCES_OFFSET + MODEL_FILES.length * INSTANCE_SIZE;
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * this.frameConstantsSize, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            if (!constantBuffer) {
                console.log("Cannot create the constant buffer");
                return 0;
            }
            this.constantsView = Nri_CreateConstantBufferView(constantBuffer, 0, CONSTANTS_SIZE);
            this.constants256View = Nri_CreateConstantBufferView(constantBuffer, 0, 256);

            // The sample's cameras: the main one at (0, 15, 40), the culling one at (0, 10, 21).
            this.mainCam.init(0.0, 15.0, 40.0);
            this.mainCam.setMoveSpeed(25.0);
            this.debugCam.init(0.0, 10.0, 21.0);
            this.debugCam.setMoveSpeed(25.0);

            for (let i = 0; i < MODEL_FILES.length; i++) {
                if (!this.loadObject(device, i)) {
                    return 0;
                }
            }

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // A mesh pipeline (with a task shader if taskPath isn't ""): kind 0 the meshlets', 1 the
        // frustum's, 2 the bounding sphere's, 3 the normal cone's. Null on failure.
        createPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, taskPath: string, taskEntry: string, meshPath: string,
            meshEntry: string, pixelPath: string, pixelEntry: string, kind: int): NriPipelineHandle | null {
            const desc = Nri_CreatePipelineDesc();
            let loaded = true;
            if (taskPath != "") {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Task, taskPath, taskEntry) != 0;
            }
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Mesh, meshPath, meshEntry) != 0;
            }
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, pixelPath, pixelEntry) != 0;
            }
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            if (kind == 1 || kind == 3) {
                Nri_PipelineDescSetTopology(desc, NriTopology.LineList);
            }
            if (kind == 1) {
                Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            }
            if (kind <= 1) {
                Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Less, 1, 0);
            } else {
                Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.None, 0, 0);
            }
            if (kind == 2) {
                Nri_PipelineDescSetBlend(desc, NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha, NriBlendOp.Add,
                    NriBlendFactor.Zero, NriBlendFactor.One, NriBlendOp.Max);
            }
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // A buffer of byteSize bytes of data (ints), structures stride bytes each (4: raw, a
        // ByteAddressBuffer), and its view; null on failure.
        createShaderBuffer(device: NriDeviceHandle, data: int[], byteSize: int, stride: int): ShaderBuffer | null {
            const buffer = Nri_CreateUploadedStructuredBufferFromInts(device, this.queue, Ref(data[0]), byteSize, stride);
            if (!buffer) {
                return null;
            }
            const view = Nri_CreateStructuredBufferView(buffer, 0);
            if (!view) {
                Nri_DestroyBuffer(buffer);
                return null;
            }
            return new ShaderBuffer(buffer, view);
        }

        // Model::LoadFromFile and UploadGpuResources, for an object: each mesh's buffers for the
        // shaders, its MeshInfo, and its data for picking.
        loadObject(device: NriDeviceHandle, index: int): boolean {
            const path = MEDIA_DIR + MODEL_FILES[index];
            const file = Nri_LoadFile(path);
            if (!file) {
                console.log(`Cannot load ${path} (the sample's model: build with DIRECTX_GRAPHICS_SAMPLES_DIR set)`);
                return false;
            }
            const loaded = MeshletModel.load(Nri_GetFileData(file), Nri_GetFileSize(file));
            Nri_DestroyFile(file);
            if (loaded.isNull()) {
                return false;
            }
            const model = loaded;
            const obj = new SceneObject(INSTANCES_OFFSET + index * INSTANCE_SIZE, OBJECT_FLAGS[index], OBJECT_SCALES[index]);
            this.objects.push(obj);

            const meshCount = model.getMeshCount();
            for (let i = 0; i < meshCount; i++) {
                // The mesh shader reads the first vertex buffer as positions and normals.
                if (model.getVertexBufferStride(i, 0) != VERTEX_STRIDE) {
                    console.log(`${path}: vertices of another layout than the mesh shader's`);
                    model.destroy();
                    return false;
                }
                const mesh = this.loadMesh(device, model, i);
                if (!mesh) {
                    console.log(`${path}: cannot create its buffers`);
                    model.destroy();
                    return false;
                }
                obj.meshes.push(mesh);
            }
            model.destroy();
            return true;
        }

        // A mesh's buffers and MeshInfo; for the view model's first mesh, its data for picking too.
        loadMesh(device: NriDeviceHandle, model: MeshletModel, i: int): MeshletMesh | null {
            const vertexSize = model.getVertexBufferSize(i, 0);
            const meshletCount = model.getDataCount(i, MeshletModelData.Meshlets);
            const uniqueSize = model.getDataSize(i, MeshletModelData.UniqueVertexIndices);
            const primitiveCount = model.getDataCount(i, MeshletModelData.PrimitiveIndices);
            const indexSize = model.getIndexSize(i);

            const vertexInts: int[] = [];
            for (let j = 0; j < vertexSize / 4; j++) {
                vertexInts.push(0);
            }
            model.copyVertexBuffer(i, 0, Ref(vertexInts[0]));
            const meshletInts: int[] = [];
            for (let j = 0; j < meshletCount * 4; j++) {
                meshletInts.push(0);
            }
            model.copyData(i, MeshletModelData.Meshlets, Ref(meshletInts[0]));
            // The unique vertex indices rounded up to whole uints, as the sample's buffer.
            const uniqueInts = Math.floor((uniqueSize + 3) / 4);
            const unique: int[] = [];
            for (let j = 0; j < uniqueInts; j++) {
                unique.push(0);
            }
            model.copyData(i, MeshletModelData.UniqueVertexIndices, Ref(unique[0]));
            const prims: int[] = [];
            for (let j = 0; j < primitiveCount; j++) {
                prims.push(0);
            }
            model.copyData(i, MeshletModelData.PrimitiveIndices, Ref(prims[0]));
            const cullInts: int[] = [];
            for (let j = 0; j < meshletCount * 6; j++) {
                cullInts.push(0);
            }
            model.copyData(i, MeshletModelData.CullData, Ref(cullInts[0]));

            const vertices = this.createShaderBuffer(device, vertexInts, vertexSize, 4);
            const meshlets = this.createShaderBuffer(device, meshletInts, meshletCount * MESHLET_STRIDE, MESHLET_STRIDE);
            const uniqueVertexIndices = this.createShaderBuffer(device, unique, uniqueInts * 4, 4);
            const primitives = this.createShaderBuffer(device, prims, primitiveCount * 4, 4);
            const cullData = this.createShaderBuffer(device, cullInts, meshletCount * CULL_DATA_STRIDE, 4);

            // MeshInfo: index size, meshlet count, the last meshlet's vertex and primitive counts.
            const meshInfo = Nri_CreateHostBuffer(device, MESH_INFO_SIZE, NriBufferUsage.ConstantBuffer);
            if (!vertices || !meshlets || !uniqueVertexIndices || !primitives || !cullData || !meshInfo) {
                return null;
            }
            const meshInfoData: f32[] = [0.0, 0.0, 0.0, 0.0];
            Nri_StoreInt32(Ref(meshInfoData[0]), indexSize);
            Nri_StoreInt32(Ref(meshInfoData[1]), meshletCount);
            Nri_StoreInt32(Ref(meshInfoData[2]), meshletInts[(meshletCount - 1) * 4]);
            Nri_StoreInt32(Ref(meshInfoData[3]), meshletInts[(meshletCount - 1) * 4 + 2]);
            Nri_WriteBuffer(meshInfo, 0, Ref(meshInfoData[0]), 16);
            const meshInfoView = Nri_CreateConstantBufferView(meshInfo, 0, MESH_INFO_SIZE);
            if (!meshInfoView) {
                return null;
            }
            const mesh = new MeshletMesh(meshInfo, meshInfoView, vertices, meshlets, uniqueVertexIndices, primitives, cullData, meshletCount,
                indexSize);

            // What picking reads (positions: the vertices' bits as floats).
            if (this.objects.length - 1 == VIEW_MODEL && i == 0) {
                mesh.meshlets = meshletInts;
                mesh.uniqueIndices = unique;
                mesh.primitives = prims;
                const verts: f32[] = [];
                for (let j = 0; j < vertexSize / 4; j++) {
                    verts.push(0.0);
                }
                model.copyVertexBuffer(i, 0, Ref(verts[0]));
                mesh.positions = verts;
                const cull: f32[] = [];
                for (let j = 0; j < meshletCount * 6; j++) {
                    cull.push(0.0);
                }
                model.copyData(i, MeshletModelData.CullData, Ref(cull[0]));
                mesh.cullFloats = cull;
            }
            return mesh;
        }

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // OnKeyDown / OnKeyUp, polled: Space switches meshlet colors, Tab selects the highlighted
        // meshlet (when pressed); Shift held, the culling camera takes the movement keys, not the
        // main one. The mouse position, once it has moved over the window.
        handleInput() {
            const space = Nri_IsKeyPressed(this.sample, Key.Space) != 0;
            if (space && !this.spaceDown) {
                this.drawMeshlets = !this.drawMeshlets;
                this.selectedIndex = -1;
                this.highlightedIndex = -1;
            }
            this.spaceDown = space;
            const tab = Nri_IsKeyPressed(this.sample, Key.Tab) != 0;
            if (tab && !this.tabDown) {
                this.selectedIndex = this.highlightedIndex;
            }
            this.tabDown = tab;
            this.moveCam = Nri_IsKeyPressed(this.sample, Key.LeftShift) != 0 || Nri_IsKeyPressed(this.sample, Key.RightShift) != 0;
            for (const key of CAMERA_KEYS) {
                const down = Nri_IsKeyPressed(this.sample, key) != 0;
                this.mainCam.onKey(key, down && !this.moveCam);
                this.debugCam.onKey(key, down && this.moveCam);
            }
            if (Nri_GetMouseDeltaX(this.sample) != 0.0 || Nri_GetMouseDeltaY(this.sample) != 0.0) {
                this.mouseMoved = true;
            }
            if (this.mouseMoved) {
                this.mouseX = Nri_GetMouseX(this.sample);
                this.mouseY = Nri_GetMouseY(this.sample);
            }
        }

        // OnUpdate: the cameras (1/60 s a frame in test mode, as Donut's test mode); the constants
        // with the culling camera's frustum planes, the instances' constants; then the picking ray
        // cast. Written into the queued frame's constants at frameOffset.
        update(frameOffset: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            this.frameNumber++;
            if (this.frameNumber == this.selectBeforeFrame) {
                this.selectedIndex = this.highlightedIndex;
            }
            if (!this.test) {
                this.handleInput();
            }
            const elapsed = Math.fround(this.test ? 1.0 / 60.0 : Nri_GetFrameTime(this.sample));
            this.mainCam.update(elapsed);
            this.debugCam.update(elapsed);

            const view = this.mainCam.viewMatrix();
            const proj = this.mainCam.projectionMatrix(this.fovY, this.aspectRatio, 1000.0);
            const viewProj = matrixMultiply(view, proj);
            const viewInv = matrixInverse(view);
            const viewPosition = row(viewInv, 3);

            // The culling camera's properties, for its planes.
            const cullView = this.debugCam.viewMatrix();
            const cullWorld = matrixInverse(cullView);
            const cullProj = this.debugCam.projectionMatrix(this.fovY, this.aspectRatio, 300.0);
            const cullPos = row(cullWorld, 3);

            // The planes from the culling camera's view-projection matrix.
            const vp = matrixTranspose(matrixMultiply(cullView, cullProj));
            const r0 = row(vp, 0);
            const r1 = row(vp, 1);
            const r2 = row(vp, 2);
            const r3 = row(vp, 3);
            const planes = [
                planeNormalize(vadd(r3, r0)), // Left
                planeNormalize(vsub(r3, r0)), // Right
                planeNormalize(vadd(r3, r1)), // Bottom
                planeNormalize(vsub(r3, r1)), // Top
                planeNormalize(r2),           // Near
                planeNormalize(vsub(r3, r2)), // Far
            ];

            const c = this.constants;
            const viewT = matrixTranspose(view);
            const viewProjT = matrixTranspose(viewProj);
            for (let i = 0; i < 16; i++) {
                c[i] = viewT[i];
                c[16 + i] = viewProjT[i];
            }
            for (let p = 0; p < 6; p++) {
                for (let i = 0; i < 4; i++) {
                    c[32 + p * 4 + i] = planes[p][i];
                    this.frustumConstants[16 + p * 4 + i] = planes[p][i];
                }
            }
            for (let i = 0; i < 3; i++) {
                c[56 + i] = viewPosition[i];
                c[60 + i] = cullPos[i];
            }

            // FrustumVisualizer::Update.
            for (let i = 0; i < 16; i++) {
                this.frustumConstants[i] = viewProjT[i];
            }
            this.frustumConstants[40] = PURPLE;
            this.frustumConstants[41] = 0.0;
            this.frustumConstants[42] = PURPLE;
            this.frustumConstants[43] = 1.0;

            // The culling camera's model follows it.
            this.objects[DEBUG_CAMERA].world = cullWorld;

            // The instances' constants.
            for (const obj of this.objects) {
                const world = obj.world;
                const worldT = matrixTranspose(world);
                const worldInvTrans = matrixTranspose(matrixInverse(matrixTranspose(world)));
                const ic = obj.instanceConstants;
                for (let i = 0; i < 16; i++) {
                    ic[i] = worldT[i];
                    ic[16 + i] = worldInvTrans[i];
                }
                ic[32] = scaleOf(world);
                Nri_WriteBuffer(constantBuffer, frameOffset + obj.instanceOffset, Ref(ic[0]), INSTANCE_FLOATS * 4);
            }

            // CullDataVisualizer::SetConstants, for the view model.
            const world = this.objects[VIEW_MODEL].world;
            const viewToWorld = matrixTranspose(view);
            const camUp = transformNormal3([0.0, 1.0, 0.0, 0.0], viewToWorld);
            const camForward = transformNormal3([0.0, 0.0, -1.0, 0.0], viewToWorld);
            const worldT = matrixTranspose(world);
            const cd = this.cullDataConstants;
            for (let i = 0; i < 16; i++) {
                cd[i] = worldT[i];
                cd[16 + i] = viewProjT[i];
            }
            // Yellow, alpha 0.3.
            cd[32] = 1.0;
            cd[33] = 1.0;
            cd[34] = 0.0;
            cd[35] = Math.fround(0.3);
            for (let i = 0; i < 4; i++) {
                cd[36 + i] = camUp[i];
            }
            for (let i = 0; i < 3; i++) {
                cd[40 + i] = camForward[i];
            }
            cd[43] = scaleOf(world);

            // The constants as they are before this frame's pick (as the sample's: the render
            // callback writes what OnUpdate set before it picked).
            Nri_StoreInt32(Ref(c[HIGHLIGHTED_FLOAT]), this.highlightedIndex);
            Nri_StoreInt32(Ref(c[SELECTED_FLOAT]), this.selectedIndex);
            Nri_StoreInt32(Ref(c[DRAW_MESHLETS_FLOAT]), this.drawMeshlets ? 1 : 0);
            if (this.drawMeshlets) {
                this.pick(view, proj);
            }
            Nri_WriteBuffer(constantBuffer, frameOffset, Ref(c[0]), CONSTANT_FLOATS * 4);
            Nri_WriteBuffer(constantBuffer, frameOffset + FRUSTUM_OFFSET, Ref(this.frustumConstants[0]), FRUSTUM_FLOATS * 4);
            Nri_WriteBuffer(constantBuffer, frameOffset + CULL_DATA_OFFSET, Ref(cd[0]), CULL_DATA_FLOATS * 4);
        }

        // Pick: the meshlet of the view model's first mesh whose triangle the ray from the camera
        // through the mouse meets first.
        pick(view: number[], proj: number[]) {
            this.highlightedIndex = -1;
            if (this.mouseX < 0.0) {
                return;
            }
            const obj = this.objects[VIEW_MODEL];
            const mesh = obj.meshes[0];

            // XMVector3Unproject of (x, y, 1) through the viewport and view-projection matrix.
            const ndcX = Math.fround(Math.fround(this.mouseX / Math.fround(this.width * 0.5)) - 1.0);
            const ndcY = Math.fround(1.0 - Math.fround(this.mouseY / Math.fround(this.height * 0.5)));
            const inverseViewProj = matrixInverse(matrixMultiply(view, proj));
            const sampleWS = transformCoord3([ndcX, ndcY, 1.0, 1.0], inverseViewProj);
            const viewPosWS = transform3([0.0, 0.0, 0.0, 0.0], matrixInverse(view));
            const viewDirWS = normalize3(vsub(sampleWS, viewPosWS));

            // The ray in object space.
            const invWorld = matrixInverse(obj.world);
            const dir = normalize3(transformNormal3(viewDirWS, invWorld));
            const org = transformCoord3(viewPosWS, invWorld);

            let minT = 3.402823466e38;
            const v = mesh.positions;
            for (let i = 0; i < mesh.meshletCount; i++) {
                const cf = mesh.cullFloats;
                const sphere = [cf[i * 6], cf[i * 6 + 1], cf[i * 6 + 2], cf[i * 6 + 3]];
                if (!rayIntersectSphere(org, dir, sphere)) {
                    continue;
                }
                const vertOffset = mesh.meshlets[i * 4 + 1];
                const primCount = mesh.meshlets[i * 4 + 2];
                const primOffset = mesh.meshlets[i * 4 + 3];
                for (let j = 0; j < primCount; j++) {
                    const prim = mesh.primitives[primOffset + j];
                    const v0 = mesh.vertexIndex(vertOffset + (prim & 0x3FF)) * 6;
                    const v1 = mesh.vertexIndex(vertOffset + ((prim >> 10) & 0x3FF)) * 6;
                    const v2 = mesh.vertexIndex(vertOffset + ((prim >> 20) & 0x3FF)) * 6;
                    const t = rayIntersectTriangle(org, dir, [v[v0], v[v0 + 1], v[v0 + 2], 0.0],
                        [v[v1], v[v1 + 1], v[v1 + 2], 0.0], [v[v2], v[v2 + 1], v[v2 + 2], 0.0]);
                    if (t >= 0.0 && t < minT) {
                        minT = t;
                        this.highlightedIndex = i;
                    }
                }
            }
        }

        // PopulateCommandList's draws (between Nri_CmdBeginRenderingWithDepth and
        // Nri_CmdEndRendering), with the queued frame's constants at frameOffset.
        recordDraws(commandBuffer: NriCommandBufferHandle, frameOffset: int) {
            const meshLayout = this.meshLayout;
            const frustumLayout = this.frustumLayout;
            const cullDataLayout = this.cullDataLayout;
            const meshPipeline = this.meshPipeline;
            const frustumPipeline = this.frustumPipeline;
            const spherePipeline = this.spherePipeline;
            const conePipeline = this.conePipeline;
            const constantsView = this.constantsView;
            const constants256View = this.constants256View;
            if (!meshLayout || !frustumLayout || !cullDataLayout || !meshPipeline || !frustumPipeline || !spherePipeline || !conePipeline
                || !constantsView || !constants256View) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);

            // All scene objects with the same pipeline state, a thread per meshlet.
            Nri_CmdSetPipelineLayout(commandBuffer, meshLayout);
            Nri_CmdSetPipeline(commandBuffer, meshPipeline);
            for (const obj of this.objects) {
                for (const mesh of obj.meshes) {
                    Nri_CmdSetRootDescriptor(commandBuffer, 0, constantsView, frameOffset);
                    Nri_CmdSetRootDescriptor(commandBuffer, 1, mesh.meshInfoView, 0);
                    Nri_CmdSetRootDescriptor(commandBuffer, 2, constants256View, frameOffset + obj.instanceOffset);
                    Nri_CmdSetRootDescriptor(commandBuffer, 3, mesh.vertices.view, 0);
                    Nri_CmdSetRootDescriptor(commandBuffer, 4, mesh.meshletBuffer.view, 0);
                    Nri_CmdSetRootDescriptor(commandBuffer, 5, mesh.uniqueVertexIndices.view, 0);
                    Nri_CmdSetRootDescriptor(commandBuffer, 6, mesh.primitiveBuffer.view, 0);
                    Nri_CmdSetRootDescriptor(commandBuffer, 7, mesh.cullData.view, 0);
                    Nri_CmdDrawMeshTasks(commandBuffer, Math.floor((mesh.meshletCount + AS_GROUP_SIZE - 1) / AS_GROUP_SIZE), 1, 1);
                }
            }

            // The frustum bounds of the culling camera.
            Nri_CmdSetPipelineLayout(commandBuffer, frustumLayout);
            Nri_CmdSetPipeline(commandBuffer, frustumPipeline);
            Nri_CmdSetRootDescriptor(commandBuffer, 0, constants256View, frameOffset + FRUSTUM_OFFSET);
            Nri_CmdDrawMeshTasks(commandBuffer, 1, 1, 1);

            // The culling data of the selected meshlet, in meshlet viewing mode.
            if (this.drawMeshlets && this.selectedIndex != -1) {
                const mesh = this.objects[VIEW_MODEL].meshes[0];
                Nri_StoreInt32(Ref(this.options[0]), this.selectedIndex);
                Nri_CmdSetPipelineLayout(commandBuffer, cullDataLayout);
                Nri_CmdSetPipeline(commandBuffer, spherePipeline);
                Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.options[0]), OPTIONS_SIZE);
                Nri_CmdSetRootDescriptor(commandBuffer, 0, constants256View, frameOffset + CULL_DATA_OFFSET);
                Nri_CmdSetRootDescriptor(commandBuffer, 1, mesh.cullData.view, 0);
                Nri_CmdDrawMeshTasks(commandBuffer, 1, 1, 1);
                Nri_CmdSetPipeline(commandBuffer, conePipeline);
                Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.options[0]), OPTIONS_SIZE);
                Nri_CmdSetRootDescriptor(commandBuffer, 0, constants256View, frameOffset + CULL_DATA_OFFSET);
                Nri_CmdSetRootDescriptor(commandBuffer, 1, mesh.cullData.view, 0);
                Nri_CmdDrawMeshTasks(commandBuffer, 1, 1, 1);
            }
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            const frameOffset = queuedFrameIndex * this.frameConstantsSize;
            this.update(frameOffset);

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: cleared, the meshlets, the frustum, the selected meshlet's culling data.
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                    Nri_CmdClearColor(commandBuffer, CLEAR_R, CLEAR_G, CLEAR_B, 1.0);
                    Nri_CmdClearDepth(commandBuffer, 1.0);
                    this.recordDraws(commandBuffer, frameOffset);
                    Nri_CmdEndRendering(commandBuffer);
                }

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
                Nri_QueuePresent(this.swapChain, swapChainTexture.releaseSemaphore);
            }

            // Signaled after the present, as NRISamples do
            Nri_QueueSignal(this.queue, this.frameFence, 1 + frameIndex);
        }

        // The last frame's pixels (0xAABBGGRR), empty if it can't be read.
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
            if (Nri_ReadBufferRGBA8(readbackBuffer, this.rowPitch, this.width, this.height, this.readbackFormat,
                Ref(pixels[0]), pixels.length) == 0) {
                return [];
            }
            return pixels;
        }

        destroy() {
            const device = this.device;
            if (device) {
                Nri_DeviceWaitIdle(device);
                for (const queuedFrame of this.queuedFrames) {
                    Nri_DestroyCommandBuffer(queuedFrame.commandBuffer);
                    Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
                }
                for (const swapChainTexture of this.swapChainTextures) {
                    Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                    Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                    Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
                }
                for (const obj of this.objects) {
                    for (const mesh of obj.meshes) {
                        Nri_DestroyDescriptor(mesh.meshInfoView);
                        Nri_DestroyBuffer(mesh.meshInfo);
                        this.destroyShaderBuffer(mesh.vertices);
                        this.destroyShaderBuffer(mesh.meshletBuffer);
                        this.destroyShaderBuffer(mesh.uniqueVertexIndices);
                        this.destroyShaderBuffer(mesh.primitiveBuffer);
                        this.destroyShaderBuffer(mesh.cullData);
                    }
                }
                this.destroyDescriptor(this.constantsView);
                this.destroyDescriptor(this.constants256View);
                this.destroyDescriptor(this.depthAttachment);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                const depthTexture = this.depthTexture;
                if (depthTexture) {
                    Nri_DestroyTexture(depthTexture);
                }
                this.destroyPipeline(this.meshPipeline);
                this.destroyPipeline(this.frustumPipeline);
                this.destroyPipeline(this.spherePipeline);
                this.destroyPipeline(this.conePipeline);
                this.destroyLayout(this.meshLayout);
                this.destroyLayout(this.frustumLayout);
                this.destroyLayout(this.cullDataLayout);
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }

        destroyShaderBuffer(shaderBuffer: ShaderBuffer) {
            Nri_DestroyDescriptor(shaderBuffer.view);
            Nri_DestroyBuffer(shaderBuffer.buffer);
        }

        destroyDescriptor(descriptor: NriDescriptorHandle | null) {
            if (descriptor) {
                Nri_DestroyDescriptor(descriptor);
            }
        }

        destroyBuffer(buffer: NriBufferHandle | null) {
            if (buffer) {
                Nri_DestroyBuffer(buffer);
            }
        }

        destroyPipeline(pipeline: NriPipelineHandle | null) {
            if (pipeline) {
                Nri_DestroyPipeline(pipeline);
            }
        }

        destroyLayout(layout: NriPipelineLayoutHandle | null) {
            if (layout) {
                Nri_DestroyPipelineLayout(layout);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const meshletCull = new MeshletCull(sample);
        return meshletCull.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return MeshletCullNri.main(argc, argv);
}

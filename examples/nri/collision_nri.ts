/// <reference path="../../core/nri/nri_interop.d.ts" />
import { multiplyF32, inverse } from "../../core/matrix";
import { DirectXCollision, Rotation } from "../../core/directx_collision";

namespace CollisionNri {
    // collision, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut and
    // NVRHI: the same shaders (collision.hlsl's), through the NRI calls core/nri/nri_interop.d.ts
    // binds, with NRIFramework's ImGui for the sample's HUD. The collision tests are
    // core/directx_collision.cpp's (DirectXMath's own), linked into the executable; its Key,
    // CollisionShape and Containment come from donut_interop.d.ts (declarations only). This example
    // creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Collision";

    // The sample's SegoeUI_18 sprite font's lines, 32 pixels apart, and the help screen's SegoeUI_36
    // title's height (the text is in ImGui's default font here).
    const LINE_SPACING = 32.0;
    const TITLE_FONT_SIZE = 61.8;

    // The keys the orbit camera reads while held (OrbitCamera.update's held, by Key value).
    const CAMERA_KEYS = [Key.Up, Key.W, Key.Down, Key.S, Key.Right, Key.D, Key.Left, Key.A, Key.Home, Key.End];
    // The keys that act when pressed.
    const PRESS_KEYS = [Key.F1, Key.Escape, Key.Num1, Key.Num2, Key.Num3, Key.Num4];

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

    // -test: checks the last frame, read back, as the Donut example does. The corners are the gray
    // clear color; the grid, the frustum and the bounding volumes' lines cover 2% to 7% of the frame
    // (the Donut example's lines are wider on Vulkan: 1.4 pixels where the device has rectangular
    // lines; NRI has no line width, so 1 here).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const clear = 0x414141;
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != clear) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 65, 65, 65`;
            }
        }
        let lines = 0;
        for (let i = 0; i < width * height; i++) {
            if ((pixels[i] & 0xFFFFFF) != clear) {
                lines++;
            }
        }
        const total = width * height;
        const percent = 100.0 * lines / total;
        console.log(`Lines: ${percent}% (${lines} of ${total} pixels)`);
        if (percent < 2.0 || percent > 7.0) {
            return `Lines: ${percent}% of the pixels, not 2% to 7%`;
        }
        return "";
    }

    const PI = 3.14159274;
    const CAMERA_SPACING = 50.0;
    const GROUP_COUNT = 4;
    const GROUP_NAMES = ["Frustum", "Axis-aligned box", "Oriented box", "Ray"];

    // ATG::Colors.
    const BACKGROUND = 0.254901975;
    const GREEN = [0.062745102, 0.486274511, 0.062745102];
    const BLUE = [0.019607844, 0.372549027, 0.803921580];
    const ORANGE = [0.764705896, 0.176470593, 0.019607844];
    const LIGHT_GREY = [0.478431374, 0.478431374, 0.478431374];
    const OFF_WHITE = [0.635294139, 0.635294139, 0.635294139];
    const WHITE = [0.980392158, 0.980392158, 0.980392158];

    // VertexPositionColor: float3 position, float4 color.
    const VERTEX_FLOATS = 7;
    const MAX_VERTICES = 8192;

    // --- Math (DirectXMath's layout: 4 x 4 matrices by rows, for row vectors; float precision) -

    function f(x: number) {
        return Math.fround(x);
    }

    function normalize3(v: number[]) {
        const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        return [f(v[0] / length), f(v[1] / length), f(v[2] / length)];
    }

    function cross3(a: number[], b: number[]) {
        return [f(a[1] * b[2] - a[2] * b[1]), f(a[2] * b[0] - a[0] * b[2]), f(a[0] * b[1] - a[1] * b[0])];
    }

    function dot3(a: number[], b: number[]) {
        return f(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
    }

    // XMMatrixLookAtRH: XMMatrixLookToLH along eye - focus.
    function lookAtRH(eye: number[], focus: number[], up: number[]) {
        const r2 = normalize3([f(eye[0] - focus[0]), f(eye[1] - focus[1]), f(eye[2] - focus[2])]);
        const r0 = normalize3(cross3(up, r2));
        const r1 = cross3(r2, r0);
        const negEye = [-eye[0], -eye[1], -eye[2]];
        return [
            r0[0], r1[0], r2[0], 0.0,
            r0[1], r1[1], r2[1], 0.0,
            r0[2], r1[2], r2[2], 0.0,
            dot3(r0, negEye), dot3(r1, negEye), dot3(r2, negEye), 1.0,
        ];
    }

    // XMMatrixPerspectiveFovLH, XMMatrixPerspectiveFovRH.
    function perspectiveFov(fovY: number, aspect: number, nearZ: number, farZ: number, rightHanded: boolean) {
        const height = f(Math.cos(0.5 * fovY) / Math.sin(0.5 * fovY));
        const width = f(height / aspect);
        if (rightHanded) {
            const range = f(farZ / (nearZ - farZ));
            return [width, 0.0, 0.0, 0.0, 0.0, height, 0.0, 0.0, 0.0, 0.0, range, -1.0, 0.0, 0.0, f(range * nearZ), 0.0];
        }
        const range = f(farZ / (farZ - nearZ));
        return [width, 0.0, 0.0, 0.0, 0.0, height, 0.0, 0.0, 0.0, 0.0, range, 1.0, 0.0, 0.0, f(-range * nearZ), 0.0];
    }

    // v (a point) * m.
    function transformPoint(v: number[], m: number[]) {
        let result: number[] = [];
        for (let i = 0; i < 3; i++) {
            result.push(f(v[0] * m[i] + v[1] * m[4 + i] + v[2] * m[8 + i] + m[12 + i]));
        }
        return result;
    }

    // Quaternions (x, y, z, w). XMQuaternionMultiply(q1, q2): q1's rotation, then q2's.
    function quaternionMultiply(q1: number[], q2: number[]) {
        return [
            f(q2[3] * q1[0] + q2[0] * q1[3] + q2[1] * q1[2] - q2[2] * q1[1]),
            f(q2[3] * q1[1] - q2[0] * q1[2] + q2[1] * q1[3] + q2[2] * q1[0]),
            f(q2[3] * q1[2] + q2[0] * q1[1] - q2[1] * q1[0] + q2[2] * q1[3]),
            f(q2[3] * q1[3] - q2[0] * q1[0] - q2[1] * q1[1] - q2[2] * q1[2]),
        ];
    }

    function quaternionNormalize(q: number[]) {
        const length = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
        return [f(q[0] / length), f(q[1] / length), f(q[2] / length), f(q[3] / length)];
    }

    // XMQuaternionInverse.
    function quaternionInverse(q: number[]) {
        const lengthSq = f(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
        if (lengthSq <= 1.192092896e-7) {
            return [0.0, 0.0, 0.0, 0.0];
        }
        return [f(-q[0] / lengthSq), f(-q[1] / lengthSq), f(-q[2] / lengthSq), f(q[3] / lengthSq)];
    }

    // XMQuaternionRotationAxis.
    function quaternionRotationAxis(axis: number[], angle: number) {
        const n = normalize3(axis);
        const s = f(Math.sin(0.5 * angle));
        return [f(n[0] * s), f(n[1] * s), f(n[2] * s), f(Math.cos(0.5 * angle))];
    }

    // XMVector3Rotate.
    function rotate3(v: number[], q: number[]) {
        const conjugate = [-q[0], -q[1], -q[2], q[3]];
        const result = quaternionMultiply(quaternionMultiply(conjugate, [v[0], v[1], v[2], 0.0]), q);
        return [result[0], result[1], result[2]];
    }

    // XMMatrixRotationQuaternion.
    function matrixRotationQuaternion(q: number[]) {
        const x = q[0]; const y = q[1]; const z = q[2]; const w = q[3];
        return [
            f(1.0 - 2.0 * (y * y + z * z)), f(2.0 * (x * y + z * w)), f(2.0 * (x * z - y * w)), 0.0,
            f(2.0 * (x * y - z * w)), f(1.0 - 2.0 * (x * x + z * z)), f(2.0 * (y * z + x * w)), 0.0,
            f(2.0 * (x * z + y * w)), f(2.0 * (y * z - x * w)), f(1.0 - 2.0 * (x * x + y * y)), 0.0,
            0.0, 0.0, 0.0, 1.0,
        ];
    }

    // DirectXMath's (exact) XMQuaternionRotationRollPitchYaw and XMMatrixRotationRollPitchYaw.
    function quaternionRollPitchYaw(pitch: number, yaw: number, roll: number): number[] {
        const q: f32[] = [0.0, 0.0, 0.0, 1.0];
        Rotation.quaternionRollPitchYaw(pitch, yaw, roll, Ref(q[0]));
        return [q[0], q[1], q[2], q[3]];
    }

    function matrixRollPitchYaw(pitch: number, yaw: number, roll: number) {
        const m: f32[] = [];
        for (let i = 0; i < 16; i++) {
            m.push(0.0);
        }
        Rotation.matrixRollPitchYaw(pitch, yaw, roll, Ref(m[0]));
        let result: number[] = [];
        for (let i = 0; i < 16; i++) {
            result.push(m[i]);
        }
        return result;
    }

    // ArcBall::QuatFromBallPoints.
    function quatFromBallPoints(fromPoint: number[], toPoint: number[]) {
        const part = cross3(fromPoint, toPoint);
        return [part[0], part[1], part[2], dot3(fromPoint, toPoint)];
    }

    // --- ATGTK's OrbitCamera ------------------------------------------------------------------

    // Ken Shoemake, "Arcball Rotation Control", Graphics Gems IV, pg 176 - 192
    class ArcBall {
        width: number;
        height: number;
        radius: number;
        qdown: number[];
        qnow: number[];
        downPoint: number[];
        drag: boolean;

        constructor() {
            this.width = 800.0;
            this.height = 400.0;
            this.radius = 1.0;
            this.qdown = [0.0, 0.0, 0.0, 1.0];
            this.qnow = [0.0, 0.0, 0.0, 1.0];
            this.downPoint = [0.0, 0.0, 0.0];
            this.drag = false;
        }

        reset() {
            this.qdown = [0.0, 0.0, 0.0, 1.0];
            this.qnow = [0.0, 0.0, 0.0, 1.0];
        }

        onBegin(x: number, y: number, quat: number[]) {
            this.drag = true;
            this.qdown = quat;
            this.downPoint = this.screenToVector(x, y);
        }

        onMove(x: number, y: number) {
            if (this.drag) {
                const curr = this.screenToVector(x, y);
                this.qnow = quaternionNormalize(quaternionMultiply(this.qdown, quatFromBallPoints(this.downPoint, curr)));
            }
        }

        screenToVector(screenX: number, screenY: number) {
            let x = f(-(screenX - this.width / 2.0) / (this.radius * this.width / 2.0));
            let y = f((screenY - this.height / 2.0) / (this.radius * this.height / 2.0));
            let z = 0.0;
            const mag = f(x * x + y * y);
            if (mag > 1.0) {
                const scale = f(1.0 / Math.sqrt(mag));
                x = f(x * scale);
                y = f(y * scale);
            } else {
                z = f(Math.sqrt(1.0 - mag));
            }
            return [x, y, z];
        }

    }

    // OrbitCamera with the sample's settings: radius 25, translation, roll, radius and sensitivity
    // controls off, arrow keys (and W, A, S, D) orbiting; right-handed. The mouse's left button
    // drags an arcball; the right one switches the mouse to relative mode (hidden, captured) while
    // held, which here only stops the keys orbiting (translation is off). Home resets the view, End
    // the focus and radius.
    class OrbitCamera {
        focus: number[];
        homeFocus: number[];
        rotation: number[];
        homeRotation: number[];
        radius: number;
        defaultRadius: number;
        width: int;
        height: int;
        arcBall: ArcBall;
        relativeMouse: boolean;
        cameraPosition: number[];

        constructor() {
            this.focus = [0.0, 0.0, 0.0];
            this.homeFocus = [0.0, 0.0, 0.0];
            this.rotation = [0.0, 0.0, 0.0, 1.0];
            this.homeRotation = [0.0, 0.0, 0.0, 1.0];
            this.radius = 25.0;
            this.defaultRadius = 25.0;
            this.width = 1280;
            this.height = 720;
            this.arcBall = new ArcBall();
            this.relativeMouse = false;
            this.cameraPosition = [0.0, 0.0, 0.0];
        }

        reset() {
            this.focus = [this.homeFocus[0], this.homeFocus[1], this.homeFocus[2]];
            this.radius = this.defaultRadius;
            this.rotation = [this.homeRotation[0], this.homeRotation[1], this.homeRotation[2], this.homeRotation[3]];
            this.arcBall.reset();
            this.arcBall.drag = false;
        }

        setWindow(width: int, height: int) {
            this.width = width;
            this.height = height;
            this.arcBall.width = width;
            this.arcBall.height = height;
        }

        setFocus(focus: number[]) {
            this.focus = [focus[0], focus[1], focus[2]];
            this.homeFocus = [focus[0], focus[1], focus[2]];
        }

        setRotation(rotation: number[]) {
            const nr = quaternionNormalize(rotation);
            this.rotation = nr;
            this.homeRotation = [nr[0], nr[1], nr[2], nr[3]];
        }

        getView() {
            const dir = rotate3([0.0, 0.0, 1.0], this.rotation);
            const up = rotate3([0.0, 1.0, 0.0], this.rotation);
            this.cameraPosition = [f(this.focus[0] + dir[0] * this.radius), f(this.focus[1] + dir[1] * this.radius), f(this.focus[2] + dir[2] * this.radius)];
            return lookAtRH(this.cameraPosition, this.focus, up);
        }

        getProjection() {
            const aspect = this.height > 0 ? f(f(this.width) / f(this.height)) : 1.0;
            return perspectiveFov(f(PI / 4.0), aspect, 0.1, 1000.0, true);
        }

        // OrbitCamera::Update(elapsedTime, mouse, keyboard): the mouse's position and buttons and
        // the keys held this frame. Returns the mouse mode wanted (true: relative).
        update(elapsedTime: number, mouseX: number, mouseY: number, leftButton: boolean, rightButton: boolean, held: boolean[]) {
            const handed = -1.0;
            const im = inverse(this.getView());

            if (!this.relativeMouse && !this.arcBall.drag) {
                // Keyboard controls
                let orbitX = 0.0;
                let orbitY = 0.0;
                if (held[Key.Up] || held[Key.W]) {
                    orbitY = 1.0;
                }
                if (held[Key.Down] || held[Key.S]) {
                    orbitY = -1.0;
                }
                if (held[Key.Right] || held[Key.D]) {
                    orbitX = 1.0;
                }
                if (held[Key.Left] || held[Key.A]) {
                    orbitX = -1.0;
                }
                if (orbitX != 0.0 || orbitY != 0.0) {
                    orbitX = f(orbitX * elapsedTime);
                    orbitY = f(orbitY * elapsedTime);
                    const right = [im[0], im[1], im[2]];
                    const up = [im[4], im[5], im[6]];
                    this.rotation = quaternionMultiply(this.rotation, quaternionRotationAxis(right, orbitY * handed));
                    this.rotation = quaternionMultiply(this.rotation, quaternionRotationAxis(up, -orbitX * handed));
                    this.rotation = quaternionNormalize(this.rotation);
                }

                if (held[Key.Home]) {
                    this.reset();
                } else if (held[Key.End]) {
                    this.radius = this.defaultRadius;
                    this.focus = [this.homeFocus[0], this.homeFocus[1], this.homeFocus[2]];
                }
            }

            // Mouse controls
            if (!this.relativeMouse && this.arcBall.drag) {
                // Rotate camera
                this.arcBall.onMove(mouseX, mouseY);
                this.rotation = quaternionInverse(this.arcBall.qnow);
            }

            if (!this.arcBall.drag) {
                if (rightButton && !this.relativeMouse) {
                    this.relativeMouse = true;
                } else if (!rightButton && this.relativeMouse) {
                    this.relativeMouse = false;
                }
                if (leftButton) {
                    this.arcBall.onBegin(mouseX, mouseY, quaternionInverse(this.rotation));
                }
            } else if (!leftButton) {
                this.arcBall.drag = false;
            }
            return this.relativeMouse;
        }
    }

    // --- The sample ---------------------------------------------------------------------------

    // Port of the Xbox ATG Collision UWP sample (as examples/collision.ts ports it) to NRI: four
    // groups of objects, each a primary object (a frustum, an axis-aligned box, an oriented box, a
    // ray, in blue) with a sphere, an oriented box, an axis-aligned box and a triangle moving around
    // it, colored by DirectXMath's collision test against it (green: disjoint, orange: intersecting,
    // white: contained; for the ray, white on a hit, and an orange box where it hit). 1 to 4 look at
    // a group, the orbit camera turns around it. The objects are drawn as the sample's DebugDraw
    // lines: 1 pixel wide (NRI has no line width or line rasterization mode).
    class Collision {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private pipelineLayout: NriPipelineLayoutHandle | null = null;
        private pipeline: NriPipelineHandle | null = null;
        // The lines' vertices, a queued frame's each, MAX_VERTICES * VERTEX_FLOATS floats apart.
        private vertexBuffer: NriBufferHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        private camera: OrbitCamera = new OrbitCamera();
        // The held keys, by Key value (CAMERA_KEYS'), and the pressed ones' last state (PRESS_KEYS').
        private held: boolean[] = [];
        private wasDown: boolean[] = [];
        private relativeMouse: boolean = false;
        private totalTime: number = 0.0;
        // The time animate uses: the total time, or a fixed one (-time).
        fixedTime: number = -1.0;
        // -help: start with the help screen; -noUI: no HUD.
        showHelp: boolean = false;
        noUI: boolean = false;
        private name: string = GROUP_NAMES[0];

        // The objects as DirectXCollision takes them (CollisionShape floats).
        private primaryFrustum: f32[] = [];
        private primaryAABox: f32[] = [];
        private primaryOrientedBox: f32[] = [];
        private rayOrigin: f32[] = [];
        private rayDirection: f32[] = [];
        private spheres: f32[][] = [];
        private orientedBoxes: f32[][] = [];
        private aaBoxes: f32[][] = [];
        private triangles: f32[][] = [];
        // Containment per group: sphere, oriented box, box, triangle.
        private collisions: int[] = [];
        private rayHitBox: f32[] = [];
        private rayHit: boolean = false;
        private cameraOrigins: number[][] = [];
        private distance: f32[] = [0.0];

        private vertices: f32[] = [];
        private vertexCount: int = 0;
        private constants: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < 512; i++) {
                this.held.push(false);
            }
            for (let i = 0; i < PRESS_KEYS.length; i++) {
                this.wasDown.push(false);
            }
            for (let i = 0; i < MAX_VERTICES * VERTEX_FLOATS; i++) {
                this.vertices.push(0.0);
            }
            for (let i = 0; i < 16; i++) {
                this.constants.push(0.0);
            }
            this.initializeObjects();
            this.setViewForGroup(0);
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
            this.camera.setWindow(this.width, this.height);

            // Swap chain: rendered through UNORM views, as the sample's B8G8R8A8_UNORM back buffers.
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

            // The layout: the view-projection matrix (push constants, b0).
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(layoutDesc, 0, 64, NriStage.Vertex);
            this.pipelineLayout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // PrimitiveBatch's line lists: collision.hlsl's shaders as compiled for the Donut example,
            // VertexPositionColor vertices, opaque, no depth, no culling.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            const shaders = `shaders/collision/${folder}/collision`;
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_line_vs.bin`, "line_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_line_ps.bin`, "line_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "COLOR", NriFormat.RGBA32_SFLOAT, 12);
            Nri_PipelineDescSetTopology(desc, NriTopology.LineList);
            Nri_PipelineDescSetColor(desc, format, NriColorWrite.RGBA);
            if (loaded) {
                this.pipeline = Nri_CreatePipelineFromDesc(device, pipelineLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            if (!this.pipeline) {
                console.log("Cannot load the collision shaders");
                return 0;
            }

            this.vertexBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * MAX_VERTICES * VERTEX_FLOATS * 4, NriBufferUsage.VertexBuffer);
            if (!this.vertexBuffer) {
                console.log("Cannot create the vertex buffer");
                return 0;
            }

            // The sample's HUD.
            if (!this.noUI) {
                if (Nri_InitImgui(this.sample, device) == 0) {
                    console.log("Cannot initialize the user interface");
                    return 0;
                }
                this.imgui = true;
            }

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        initializeObjects() {
            // Set up the primary frustum object from a D3D projection matrix
            // NOTE: This can also be done on your camera's projection matrix.  The projection
            // matrix built here is somewhat contrived so it renders well.
            const projection: f32[] = [];
            const xmProj = perspectiveFov(f(PI / 4.0), 1.77778, 0.5, 10.0, false);
            for (let i = 0; i < 16; i++) {
                projection.push(xmProj[i]);
            }
            this.primaryFrustum = [];
            for (let i = 0; i < 13; i++) {
                this.primaryFrustum.push(0.0);
            }
            DirectXCollision.frustumFromMatrix(Ref(projection[0]), Ref(this.primaryFrustum[0]));
            this.primaryFrustum[2] = -7.0;
            this.cameraOrigins.push([0.0, 0.0, 0.0]);

            // Set up the primary axis aligned box
            this.primaryAABox = [CAMERA_SPACING, 0.0, 0.0, 5.0, 5.0, 5.0];
            this.cameraOrigins.push([CAMERA_SPACING, 0.0, 0.0]);

            // Set up the primary oriented box with some rotation
            const orientation = quaternionRollPitchYaw(f(PI / 4.0), f(PI / 4.0), 0.0);
            this.primaryOrientedBox = [-CAMERA_SPACING, 0.0, 0.0, 5.0, 5.0, 5.0, orientation[0], orientation[1], orientation[2], orientation[3]];
            this.cameraOrigins.push([-CAMERA_SPACING, 0.0, 0.0]);

            // Set up the primary ray
            this.rayOrigin = [0.0, 0.0, CAMERA_SPACING];
            this.rayDirection = [0.0, 0.0, 1.0];
            this.cameraOrigins.push([0.0, 0.0, CAMERA_SPACING]);

            // Initialize all of the secondary objects with default values
            for (let i = 0; i < GROUP_COUNT; i++) {
                this.spheres.push([0.0, 0.0, 0.0, 1.0]);
                this.orientedBoxes.push([0.0, 0.0, 0.0, 0.5, 0.5, 0.5, 0.0, 0.0, 0.0, 1.0]);
                this.aaBoxes.push([0.0, 0.0, 0.0, 0.5, 0.5, 0.5]);
                this.triangles.push([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
                for (let j = 0; j < 4; j++) {
                    this.collisions.push(Containment.Disjoint);
                }
            }

            // Set up ray hit result box
            this.rayHitBox = [0.0, 0.0, 0.0, 0.05, 0.05, 0.05];
            this.rayHit = false;
        }

        // A triangle's points: the equilateral triangle of radius 2 in local space, turned by
        // XMMatrixRotationRollPitchYaw(t * 1.4, t * 2.5, t) and moved to (x, y, z).
        setTriangle(triangle: f32[], t: number, x: number, y: number, z: number) {
            // triangle points in local space - equilateral triangle with radius of 2
            const points = [0.0, 2.0, 0.0, 1.732, -1.0, 0.0, -1.732, -1.0, 0.0];
            let coords = matrixRollPitchYaw(f(t * 1.4), f(t * 2.5), t);
            coords[12] = x;
            coords[13] = y;
            coords[14] = z;
            for (let p = 0; p < 3; p++) {
                const v = transformPoint([points[p * 3], points[p * 3 + 1], points[p * 3 + 2]], coords);
                triangle[p * 3] = v[0];
                triangle[p * 3 + 1] = v[1];
                triangle[p * 3 + 2] = v[2];
            }
        }

        setOrientation(box: f32[], q: number[]) {
            box[6] = q[0];
            box[7] = q[1];
            box[8] = q[2];
            box[9] = q[3];
        }

        animate(time: number) {
            const t = f(time * 0.2);

            const camera0OriginX = this.cameraOrigins[0][0];
            const camera1OriginX = this.cameraOrigins[1][0];
            const camera2OriginX = this.cameraOrigins[2][0];
            const camera3OriginX = this.cameraOrigins[3][0];
            const camera3OriginZ = this.cameraOrigins[3][2];
            const s = this.spheres;
            const o = this.orientedBoxes;
            const a = this.aaBoxes;

            // animate sphere 0 around the frustum
            s[0][0] = f(10.0 * f(Math.sin(f(3.0 * t))));
            s[0][1] = f(7.0 * f(Math.cos(f(5.0 * t))));

            // animate oriented box 0 around the frustum
            o[0][0] = f(8.0 * f(Math.sin(f(3.5 * t))));
            o[0][1] = f(5.0 * f(Math.cos(f(5.1 * t))));
            this.setOrientation(o[0], quaternionRollPitchYaw(f(t * 1.4), f(t * 0.2), t));

            // animate aligned box 0 around the frustum
            a[0][0] = f(10.0 * f(Math.sin(f(2.1 * t))));
            a[0][1] = f(7.0 * f(Math.cos(f(3.8 * t))));

            // animate sphere 1 around the aligned box
            s[1][0] = f(f(8.0 * f(Math.sin(f(2.9 * t)))) + camera1OriginX);
            s[1][1] = f(8.0 * f(Math.cos(f(4.6 * t))));
            s[1][2] = f(8.0 * f(Math.cos(f(1.6 * t))));

            // animate oriented box 1 around the aligned box
            o[1][0] = f(f(8.0 * f(Math.sin(f(3.2 * t)))) + camera1OriginX);
            o[1][1] = f(8.0 * f(Math.cos(f(2.1 * t))));
            o[1][2] = f(8.0 * f(Math.sin(f(1.6 * t))));
            this.setOrientation(o[1], quaternionRollPitchYaw(f(t * 0.7), f(t * 1.3), t));

            // animate aligned box 1 around the aligned box
            a[1][0] = f(f(8.0 * f(Math.sin(f(1.1 * t)))) + camera1OriginX);
            a[1][1] = f(8.0 * f(Math.cos(f(5.8 * t))));
            a[1][2] = f(8.0 * f(Math.cos(f(3.0 * t))));

            // animate sphere 2 around the oriented box
            s[2][0] = f(f(8.0 * f(Math.sin(f(2.2 * t)))) + camera2OriginX);
            s[2][1] = f(8.0 * f(Math.cos(f(4.3 * t))));
            s[2][2] = f(8.0 * f(Math.cos(f(1.8 * t))));

            // animate oriented box 2 around the oriented box
            o[2][0] = f(f(8.0 * f(Math.sin(f(3.7 * t)))) + camera2OriginX);
            o[2][1] = f(8.0 * f(Math.cos(f(2.5 * t))));
            o[2][2] = f(8.0 * f(Math.sin(f(1.1 * t))));
            this.setOrientation(o[2], quaternionRollPitchYaw(f(t * 0.9), f(t * 1.8), t));

            // animate aligned box 2 around the oriented box
            a[2][0] = f(f(8.0 * f(Math.sin(f(1.3 * t)))) + camera2OriginX);
            a[2][1] = f(8.0 * f(Math.cos(f(5.2 * t))));
            a[2][2] = f(8.0 * f(Math.cos(f(3.5 * t))));

            // animate triangle 0 around the frustum
            this.setTriangle(this.triangles[0], t, f(f(5.0 * f(Math.sin(f(5.3 * t)))) + camera0OriginX),
                f(5.0 * f(Math.cos(f(2.3 * t)))), f(5.0 * f(Math.sin(f(3.4 * t)))));

            // animate triangle 1 around the aligned box
            this.setTriangle(this.triangles[1], t, f(f(8.0 * f(Math.sin(f(5.3 * t)))) + camera1OriginX),
                f(8.0 * f(Math.cos(f(2.3 * t)))), f(8.0 * f(Math.sin(f(3.4 * t)))));

            // animate triangle 2 around the oriented box
            this.setTriangle(this.triangles[2], t, f(f(8.0 * f(Math.sin(f(5.3 * t)))) + camera2OriginX),
                f(8.0 * f(Math.cos(f(2.3 * t)))), f(8.0 * f(Math.sin(f(3.4 * t)))));

            // animate primary ray (this is the only animated primary object)
            this.rayDirection[0] = f(Math.sin(f(t * 3.0)));
            this.rayDirection[1] = 0.0;
            this.rayDirection[2] = f(Math.cos(f(t * 3.0)));

            // animate sphere 3 around the ray
            s[3][0] = f(camera3OriginX - 3.0);
            s[3][1] = f(0.5 * f(Math.sin(f(t * 5.0))));
            s[3][2] = camera3OriginZ;

            // animate aligned box 3 around the ray
            a[3][0] = f(camera3OriginX + 3.0);
            a[3][1] = f(0.5 * f(Math.sin(f(t * 4.0))));
            a[3][2] = camera3OriginZ;

            // animate oriented box 3 around the ray
            o[3][0] = camera3OriginX;
            o[3][1] = f(0.5 * f(Math.sin(f(t * 4.5))));
            o[3][2] = f(camera3OriginZ + 3.0);
            this.setOrientation(o[3], quaternionRollPitchYaw(f(t * 0.9), f(t * 1.8), t));

            // animate triangle 3 around the ray
            this.setTriangle(this.triangles[3], t, camera3OriginX, f(0.5 * f(Math.cos(f(4.3 * t)))), f(camera3OriginZ - 3.0));
        }

        // The containment of group g's objects in its primary (shape, floats).
        collideGroup(g: int, primaryShape: CollisionShape, primary: f32[]) {
            this.collisions[g * 4] = DirectXCollision.contains(primaryShape, Ref(primary[0]), CollisionShape.Sphere, Ref(this.spheres[g][0]));
            this.collisions[g * 4 + 1] = DirectXCollision.contains(primaryShape, Ref(primary[0]), CollisionShape.OrientedBox, Ref(this.orientedBoxes[g][0]));
            this.collisions[g * 4 + 2] = DirectXCollision.contains(primaryShape, Ref(primary[0]), CollisionShape.Box, Ref(this.aaBoxes[g][0]));
            this.collisions[g * 4 + 3] = DirectXCollision.contains(primaryShape, Ref(primary[0]), CollisionShape.Triangle, Ref(this.triangles[g][0]));
        }

        // A ray test: the hit's distance in fDistance (the last hit wins, as in the sample).
        rayTest(shape: CollisionShape, s: f32[], index: int, fDistance: number): number {
            if (DirectXCollision.intersectsRay(shape, Ref(s[0]), Ref(this.rayOrigin[0]), Ref(this.rayDirection[0]), Ref(this.distance[0])) != 0) {
                this.collisions[3 * 4 + index] = Containment.Intersects;
                return this.distance[0];
            }
            this.collisions[3 * 4 + index] = Containment.Disjoint;
            return fDistance;
        }

        collide() {
            // test collisions between objects and frustum
            this.collideGroup(0, CollisionShape.Frustum, this.primaryFrustum);
            // test collisions between objects and aligned box
            this.collideGroup(1, CollisionShape.Box, this.primaryAABox);
            // test collisions between objects and oriented box
            this.collideGroup(2, CollisionShape.OrientedBox, this.primaryOrientedBox);

            // test collisions between objects and ray
            let fDistance = -1.0;
            fDistance = this.rayTest(CollisionShape.Sphere, this.spheres[3], 0, fDistance);
            fDistance = this.rayTest(CollisionShape.OrientedBox, this.orientedBoxes[3], 1, fDistance);
            fDistance = this.rayTest(CollisionShape.Box, this.aaBoxes[3], 2, fDistance);
            fDistance = this.rayTest(CollisionShape.Triangle, this.triangles[3], 3, fDistance);

            // If one of the ray intersection tests was successful, fDistance will be positive.
            // If so, compute the intersection location and store it in g_RayHitResultBox.
            if (fDistance > 0.0) {
                // The primary ray's direction is assumed to be normalized.
                for (let i = 0; i < 3; i++) {
                    this.rayHitBox[i] = f(this.rayDirection[i] * fDistance + this.rayOrigin[i]);
                }
                this.rayHit = true;
            } else {
                this.rayHit = false;
            }
        }

        // Sets the camera to view a particular group of objects
        setViewForGroup(group: int) {
            this.camera.setFocus(this.cameraOrigins[group]);
            this.camera.setRotation(quaternionRollPitchYaw(f(-PI / 4.0), 0.0, 0.0));
            this.name = GROUP_NAMES[group];
        }

        // A key pressed since the last frame: F1 toggles the help screen (Escape hides it); 1 to 4
        // look at a group.
        onKeyPressed(key: Key) {
            if (key == Key.F1) {
                this.showHelp = !this.showHelp;
            } else if (this.showHelp && key == Key.Escape) {
                this.showHelp = false;
            } else if (!this.showHelp && key >= Key.Num1 && key <= Key.Num4) {
                this.setViewForGroup(key - Key.Num1);
            }
        }

        // Sample::Update: the keys, then the objects move and are tested, then the camera follows
        // the input (none in the test, which takes 1/60 second a frame, as Donut's test mode).
        update() {
            const elapsedSeconds = this.test ? 1.0 / 60.0 : Nri_GetFrameTime(this.sample);
            if (!this.test) {
                for (const key of CAMERA_KEYS) {
                    this.held[key] = Nri_IsKeyPressed(this.sample, key) != 0;
                }
                for (let i = 0; i < PRESS_KEYS.length; i++) {
                    const down = Nri_IsKeyPressed(this.sample, PRESS_KEYS[i]) != 0;
                    if (down && !this.wasDown[i]) {
                        this.onKeyPressed(PRESS_KEYS[i]);
                    }
                    this.wasDown[i] = down;
                }
            }
            this.totalTime += elapsedSeconds;

            // Update position of collision objects.
            this.animate(this.fixedTime >= 0.0 ? this.fixedTime : this.totalTime);

            // Compute collisions.
            this.collide();

            if (!this.showHelp && !this.test) {
                const leftButton = Nri_IsButtonPressed(this.sample, 0) != 0;
                const rightButton = Nri_IsButtonPressed(this.sample, 1) != 0;
                const relative = this.camera.update(f(elapsedSeconds), Nri_GetMouseX(this.sample), Nri_GetMouseY(this.sample),
                    leftButton, rightButton, this.held);
                if (relative != this.relativeMouse) {
                    this.relativeMouse = relative;
                    Nri_SetCursorDisabled(this.sample, relative ? 1 : 0);
                }
            }
        }

        // --- DebugDraw ---------------------------------------------------------------------------

        vertex(p: number[], color: number[]) {
            if (this.vertexCount >= MAX_VERTICES) {
                return;
            }
            const v = this.vertices;
            const base = this.vertexCount * VERTEX_FLOATS;
            v[base] = p[0];
            v[base + 1] = p[1];
            v[base + 2] = p[2];
            v[base + 3] = color[0];
            v[base + 4] = color[1];
            v[base + 5] = color[2];
            v[base + 6] = 1.0;
            this.vertexCount++;
        }

        line(a: number[], b: number[], color: number[]) {
            this.vertex(a, color);
            this.vertex(b, color);
        }

        // DrawCube: the unit cube's 12 edges through matWorld.
        drawCube(world: number[], color: number[]) {
            const corners = [
                -1.0, -1.0, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0, -1.0, -1.0, 1.0,
                -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0, 1.0, -1.0, 1.0, 1.0,
            ];
            const indices = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
            const verts: number[][] = [];
            for (let i = 0; i < 8; i++) {
                verts.push(transformPoint([corners[i * 3], corners[i * 3 + 1], corners[i * 3 + 2]], world));
            }
            for (const index of indices) {
                this.vertex(verts[index], color);
            }
        }

        drawBox(box: f32[], color: number[]) {
            const world: number[] = [box[3], 0.0, 0.0, 0.0, 0.0, box[4], 0.0, 0.0, 0.0, 0.0, box[5], 0.0, box[0], box[1], box[2], 1.0];
            this.drawCube(world, color);
        }

        drawOrientedBox(box: f32[], color: number[]) {
            const scale: number[] = [box[3], 0.0, 0.0, 0.0, 0.0, box[4], 0.0, 0.0, 0.0, 0.0, box[5], 0.0, 0.0, 0.0, 0.0, 1.0];
            const orientation: number[] = [box[6], box[7], box[8], box[9]];
            let world = multiplyF32(scale, matrixRotationQuaternion(orientation));
            world[12] = box[0];
            world[13] = box[1];
            world[14] = box[2];
            this.drawCube(world, color);
        }

        drawFrustum(frustum: f32[], color: number[]) {
            let c: f32[] = [];
            for (let i = 0; i < 24; i++) {
                c.push(0.0);
            }
            DirectXCollision.frustumCorners(Ref(frustum[0]), Ref(c[0]));
            const edges = [0, 1, 1, 2, 2, 3, 3, 0, 0, 4, 1, 5, 2, 6, 3, 7, 4, 5, 5, 6, 6, 7, 7, 4];
            for (const k of edges) {
                const corner: number[] = [c[k * 3], c[k * 3 + 1], c[k * 3 + 2]];
                this.vertex(corner, color);
            }
        }

        // DrawRing: 32 segments, the sines and cosines rotated incrementally.
        drawRing(origin: number[], majorAxis: number[], minorAxis: number[], color: number[]) {
            const segments = 32;
            const angleDelta = f(f(2.0 * PI) / segments);
            const cosDelta = f(Math.cos(angleDelta));
            const sinDelta = f(Math.sin(angleDelta));
            let incrementalSin = 0.0;
            let incrementalCos = 1.0;
            const points: number[][] = [];
            for (let i = 0; i < segments; i++) {
                const pos: number[] = [];
                for (let k = 0; k < 3; k++) {
                    pos.push(f(f(majorAxis[k] * incrementalCos + origin[k]) + minorAxis[k] * incrementalSin));
                }
                points.push(pos);
                // Standard formula to rotate a vector.
                const newCos = f(f(incrementalCos * cosDelta) - f(incrementalSin * sinDelta));
                const newSin = f(f(incrementalCos * sinDelta) + f(incrementalSin * cosDelta));
                incrementalCos = newCos;
                incrementalSin = newSin;
            }
            for (let i = 0; i < segments; i++) {
                this.line(points[i], points[(i + 1) % segments], color);
            }
        }

        drawSphere(sphere: f32[], color: number[]) {
            const origin: number[] = [sphere[0], sphere[1], sphere[2]];
            const radius = sphere[3];
            const xaxis: number[] = [radius, 0.0, 0.0];
            const yaxis: number[] = [0.0, radius, 0.0];
            const zaxis: number[] = [0.0, 0.0, radius];
            this.drawRing(origin, xaxis, zaxis, color);
            this.drawRing(origin, xaxis, yaxis, color);
            this.drawRing(origin, yaxis, zaxis, color);
        }

        drawGrid(xAxis: number[], yAxis: number[], origin: number[], xdivs: int, ydivs: int, color: number[]) {
            for (let i = 0; i <= xdivs; i++) {
                const percent = f(f(f(i) / f(xdivs)) * 2.0 - 1.0);
                const scale = [f(xAxis[0] * percent + origin[0]), f(xAxis[1] * percent + origin[1]), f(xAxis[2] * percent + origin[2])];
                this.line([f(scale[0] - yAxis[0]), f(scale[1] - yAxis[1]), f(scale[2] - yAxis[2])],
                    [f(scale[0] + yAxis[0]), f(scale[1] + yAxis[1]), f(scale[2] + yAxis[2])], color);
            }
            for (let i = 0; i <= ydivs; i++) {
                const percent = f(f(f(i) / f(ydivs)) * 2.0 - 1.0);
                const scale = [f(yAxis[0] * percent + origin[0]), f(yAxis[1] * percent + origin[1]), f(yAxis[2] * percent + origin[2])];
                this.line([f(scale[0] - xAxis[0]), f(scale[1] - xAxis[1]), f(scale[2] - xAxis[2])],
                    [f(scale[0] + xAxis[0]), f(scale[1] + xAxis[1]), f(scale[2] + xAxis[2])], color);
            }
        }

        // DrawRay (not normalized): its line strip has only the first two points, origin and
        // origin + direction.
        drawRay(origin: number[], direction: number[], color: number[]) {
            this.line(origin, [f(direction[0] + origin[0]), f(direction[1] + origin[1]), f(direction[2] + origin[2])], color);
        }

        drawTriangle(t: f32[], color: number[]) {
            const a: number[] = [t[0], t[1], t[2]];
            const b: number[] = [t[3], t[4], t[5]];
            const c: number[] = [t[6], t[7], t[8]];
            this.line(a, b, color);
            this.line(b, c, color);
            this.line(c, a, color);
        }

        // Returns the color based on the collision result and the group number.
        // Frustum tests (group 0) return 0, 1, or 2 for outside, partially inside, and fully inside;
        // all other tests return 0 or 1 for no collision or collision.
        collisionColor(collision: int, group: int) {
            // special case: a value of 1 for groups 1 and higher needs to register as a full collision
            let c = collision;
            if (group >= 3 && c > 0) {
                c = Containment.Contains;
            }
            if (c == Containment.Disjoint) {
                return GREEN;
            }
            if (c == Containment.Intersects) {
                return ORANGE;
            }
            return WHITE;
        }

        // --- Rendering ----------------------------------------------------------------------------

        // The scene's lines into this frame's part of the vertex buffer (from vertexOffset bytes):
        // none on the help screen.
        buildLines(vertexBuffer: NriBufferHandle, vertexOffset: int) {
            this.vertexCount = 0;
            if (this.showHelp) {
                return;
            }
            // Draw ground planes
            for (let i = 0; i < GROUP_COUNT; i++) {
                const origin = this.cameraOrigins[i];
                this.drawGrid([20.0, 0.0, 0.0], [0.0, 0.0, 20.0], [origin[0], f(origin[1] - 10.0), origin[2]], 20, 20, OFF_WHITE);
            }

            // Draw primary collision objects in white
            this.drawFrustum(this.primaryFrustum, BLUE);
            this.drawBox(this.primaryAABox, BLUE);
            this.drawOrientedBox(this.primaryOrientedBox, BLUE);

            const origin: number[] = [this.rayOrigin[0], this.rayOrigin[1], this.rayOrigin[2]];
            const direction = [f(this.rayDirection[0] * 10.0), f(this.rayDirection[1] * 10.0), f(this.rayDirection[2] * 10.0)];
            this.drawRay(origin, direction, LIGHT_GREY);
            this.drawRay(origin, direction, WHITE);

            // Draw secondary collision objects in colors based on collision results
            for (let i = 0; i < GROUP_COUNT; i++) {
                this.drawSphere(this.spheres[i], this.collisionColor(this.collisions[i * 4], i));
                this.drawOrientedBox(this.orientedBoxes[i], this.collisionColor(this.collisions[i * 4 + 1], i));
                this.drawBox(this.aaBoxes[i], this.collisionColor(this.collisions[i * 4 + 2], i));
                this.drawTriangle(this.triangles[i], this.collisionColor(this.collisions[i * 4 + 3], i));
            }

            // Draw results of ray-object intersection, if there was a hit this frame
            if (this.rayHit) {
                this.drawBox(this.rayHitBox, ORANGE);
            }

            const viewProjection = multiplyF32(this.camera.getView(), this.camera.getProjection());
            for (let i = 0; i < 16; i++) {
                this.constants[i] = viewProjection[i];
            }
            if (this.vertexCount > 0) {
                Nri_WriteBuffer(vertexBuffer, vertexOffset, Ref(this.vertices[0]), this.vertexCount * VERTEX_FLOATS * 4);
            }
        }

        // Sample::Render's lines (between Nri_CmdBeginRendering and Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle, vertexOffset: int) {
            const pipelineLayout = this.pipelineLayout;
            const pipeline = this.pipeline;
            const vertexBuffer = this.vertexBuffer;
            if (this.vertexCount == 0 || !pipelineLayout || !pipeline || !vertexBuffer) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, pipelineLayout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.constants[0]), 64);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, vertexBuffer, vertexOffset, VERTEX_FLOATS * 4);
            Nri_CmdDraw(commandBuffer, this.vertexCount, 1, 0, 0);
        }

        // The sample's HUD (SpriteFont text in the title-safe area): the group's name at the top, the
        // controls at the bottom. As in the Donut example, the help screen (ATG::Help, a gamepad
        // picture with callouts) is the sample's title, description and keyboard and mouse controls
        // as text.
        buildUI() {
            // SimpleMath::Viewport::ComputeTitleSafeArea
            const safeW = Math.fround((this.width + 19.0) / 20.0);
            const safeH = Math.fround((this.height + 19.0) / 20.0);
            const left: int = Math.floor(safeW);
            const top: int = Math.floor(safeH);
            const bottom: int = Math.floor(this.height - safeH + 0.5);

            Nri_ImguiNewFrame(this.sample);
            if (this.showHelp) {
                Nri_ImguiDrawText(left, top, "Collision sample", WHITE[0], WHITE[1], WHITE[2], 1.0, 0);
                const y = top + TITLE_FONT_SIZE + LINE_SPACING;
                Nri_ImguiDrawText(left, y, "This sample demonstrates DirectXMath's collision types", WHITE[0], WHITE[1], WHITE[2], 1.0, 0);
                const controls = [
                    "1: Frustum",
                    "2: Axis-aligned box",
                    "3: Oriented box",
                    "4: Ray",
                    "Arrow keys / W, A, S, D, left mouse button drag: Orbit X/Y",
                    "Home: Reset view",
                    "F1: Toggle help",
                    "Esc: Hide this help",
                ];
                for (let i = 0; i < controls.length; i++) {
                    Nri_ImguiDrawText(left, y + (i + 2) * LINE_SPACING, controls[i], WHITE[0], WHITE[1], WHITE[2], 1.0, 0);
                }
            } else {
                Nri_ImguiDrawText(left, top, this.name, WHITE[0], WHITE[1], WHITE[2], 1.0, 0);
                Nri_ImguiDrawText(left, bottom - LINE_SPACING, "F1 - Help", LIGHT_GREY[0], LIGHT_GREY[1], LIGHT_GREY[2], 1.0, 0);
            }
            Nri_ImguiRender(this.sample);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.update();
            const vertexOffset = queuedFrameIndex * MAX_VERTICES * VERTEX_FLOATS * 4;
            const vertexBuffer = this.vertexBuffer;
            if (vertexBuffer) {
                this.buildLines(vertexBuffer, vertexOffset);
            }
            if (this.imgui) {
                this.buildUI();
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: Sample::Clear, the lines, the HUD over them.
                Nri_BeginCommandBuffer(commandBuffer);
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                Nri_CmdClearColor(commandBuffer, BACKGROUND, BACKGROUND, BACKGROUND, 1.0);
                this.recordDraw(commandBuffer, vertexOffset);
                if (this.imgui) {
                    Nri_CmdDrawImgui(this.sample, commandBuffer, this.viewFormat);
                }
                Nri_CmdEndRendering(commandBuffer);

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
                if (this.imgui) {
                    Nri_DestroyImgui(this.sample);
                }
                for (const queuedFrame of this.queuedFrames) {
                    Nri_DestroyCommandBuffer(queuedFrame.commandBuffer);
                    Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
                }
                for (const swapChainTexture of this.swapChainTextures) {
                    Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                    Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                    Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
                }
                const vertexBuffer = this.vertexBuffer;
                if (vertexBuffer) {
                    Nri_DestroyBuffer(vertexBuffer);
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
                }
                const pipeline = this.pipeline;
                if (pipeline) {
                    Nri_DestroyPipeline(pipeline);
                }
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    Nri_DestroyPipelineLayout(pipelineLayout);
                }
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const collision = new Collision(sample);
        // -group <1..4>: the group looked at first; -time <seconds>: the objects frozen at that time;
        // -help: start with the help screen; -noUI: no HUD.
        Nri_AddExampleOptionWithValues(sample, "-group", 1);
        Nri_AddExampleOptionWithValues(sample, "-time", 1);
        Nri_AddExampleOption(sample, "-help");
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-group" && i + 1 < argc) {
                i++;
                collision.setViewForGroup(Math.min(Math.max(parseInt(Nri_GetArg(argc, argv, i)), 1), GROUP_COUNT) - 1);
            } else if (arg == "-time" && i + 1 < argc) {
                i++;
                collision.fixedTime = parseFloat(Nri_GetArg(argc, argv, i));
            } else if (arg == "-help") {
                collision.showHelp = true;
            } else if (arg == "-noUI") {
                collision.noUI = true;
            }
        }
        return collision.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return CollisionNri.main(argc, argv);
}

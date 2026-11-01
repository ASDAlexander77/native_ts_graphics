/// <reference path="../../core/nri/nri_interop.d.ts" />
import { formatFixed } from "../../core/text_format";

namespace SimpleBezierNri {
    // simple_bezier, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut
    // and NVRHI: the same shaders (simple_bezier.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws, with NRIFramework's ImGui for the
    // sample's HUD text. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Simple Bezier";

    // The HUD's lines, 32 pixels apart (the sample's SegoeUI_18 sprite font; NRIFramework's ImGui
    // font here, which the Donut example's OpenSans replaces there), and the help screen's title.
    const LINE_SPACING = 32.0;
    const TITLE_SPACING = 61.8;

    // GLFW's key codes (Donut's Key values), which Nri_IsKeyPressed and Nri_IsKeyToggled take.
    const KEY_W = 87;
    const KEY_1 = 49;
    const KEY_2 = 50;
    const KEY_3 = 51;
    const KEY_KP_1 = 321;
    const KEY_KP_2 = 322;
    const KEY_KP_3 = 323;
    const KEY_F1 = 290;
    const KEY_RIGHT = 262;
    const KEY_LEFT = 263;
    const KEY_DOWN = 264;
    const KEY_UP = 265;

    // Min and max divisions of the patch per side for the slider control.
    const MIN_DIVS = 4.0;
    const MAX_DIVS = 16.0;
    // Startup subdivisions per side.
    const DEFAULT_SUBDIVS = 8.0;
    // Camera's rotation angle per step (XM_2PI / 360.0f).
    const ROTATION_ANGLE_PER_STEP = 0.0174532924;

    // cbPerFrame: float4x4 viewProjection, float3 cameraWorldPos, float tessellationFactor; a queued
    // frame's each CB_STRIDE bytes apart (D3D12 constant buffer views' alignment).
    const CB_FLOATS = 20;
    const CB_STRIDE = 256;

    // ATG::ColorsLinear::Background, cleared in the sRGB back buffer as the sample's; the text's
    // ATG::Colors::LightGrey (#7A7A7A), written as is as SpriteBatch does.
    const BACKGROUND = 0.052860655;
    const LIGHT_GREY = 0.478431374;

    // Partition modes: the hull shaders' order.
    enum PartitionMode {
        Integer = 0,
        FractionalEven = 1,
        FractionalOdd = 2
    }
    const HULL_SHADERS = ["BezierHS_int", "BezierHS_fracEven", "BezierHS_fracOdd"];
    const PARTITION_NAMES = ["Integer", "Fractional Even", "Fractional Odd"];

    // Simple Bezier patch for a Mobius strip.
    // 4 patches with 16 control points each.
    const MOBIUS_STRIP: number[] = [
        1.0, -0.5, 0.0,
        1.0, -0.5, 0.5,
        0.5, -0.3536, 1.354,
        0.0, -0.3536, 1.354,
        1.0, -0.1667, 0.0,
        1.0, -0.1667, 0.5,
        0.5, -0.1179, 1.118,
        0.0, -0.1179, 1.118,
        1.0, 0.1667, 0.0,
        1.0, 0.1667, 0.5,
        0.5, 0.1179, 0.8821,
        0.0, 0.1179, 0.8821,
        1.0, 0.5, 0.0,
        1.0, 0.5, 0.5,
        0.5, 0.3536, 0.6464,
        0.0, 0.3536, 0.6464,
        0.0, -0.3536, 1.354,
        -0.5, -0.3536, 1.354,
        -1.5, 0.0, 0.5,
        -1.5, 0.0, 0.0,
        0.0, -0.1179, 1.118,
        -0.5, -0.1179, 1.118,
        -1.167, 0.0, 0.5,
        -1.167, 0.0, 0.0,
        0.0, 0.1179, 0.8821,
        -0.5, 0.1179, 0.8821,
        -0.8333, 0.0, 0.5,
        -0.8333, 0.0, 0.0,
        0.0, 0.3536, 0.6464,
        -0.5, 0.3536, 0.6464,
        -0.5, 0.0, 0.5,
        -0.5, 0.0, 0.0,
        -1.5, 0.0, 0.0,
        -1.5, 0.0, -0.5,
        -0.5, 0.3536, -1.354,
        0.0, 0.3536, -1.354,
        -1.167, 0.0, 0.0,
        -1.167, 0.0, -0.5,
        -0.5, 0.1179, -1.118,
        0.0, 0.1179, -1.118,
        -0.8333, 0.0, 0.0,
        -0.8333, 0.0, -0.5,
        -0.5, -0.1179, -0.8821,
        0.0, -0.1179, -0.8821,
        -0.5, 0.0, 0.0,
        -0.5, 0.0, -0.5,
        -0.5, -0.3536, -0.6464,
        0.0, -0.3536, -0.6464,
        0.0, 0.3536, -1.354,
        0.5, 0.3536, -1.354,
        1.0, 0.5, -0.5,
        1.0, 0.5, 0.0,
        0.0, 0.1179, -1.118,
        0.5, 0.1179, -1.118,
        1.0, 0.1667, -0.5,
        1.0, 0.1667, 0.0,
        0.0, -0.1179, -0.8821,
        0.5, -0.1179, -0.8821,
        1.0, -0.1667, -0.5,
        1.0, -0.1667, 0.0,
        0.0, -0.3536, -0.6464,
        0.5, -0.3536, -0.6464,
        1.0, -0.5, -0.5,
        1.0, -0.5, 0.0,
    ];
    const CONTROL_POINTS = 64;
    const PATCH_SIZE = 16;
    const VERTEX_SIZE = 12;

    // Initial camera setup
    const CAMERA_EYE = [0.0, 0.45, 2.7];
    const CAMERA_AT = [0.0, 0.0, 0.0];
    const CAMERA_UP = [0.0, 1.0, 0.0];

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

    // --- Math (DirectXMath's layout: 4 x 4 matrices by rows, for row vectors; float precision) -

    function f(x: number) {
        return Math.fround(x);
    }

    function multiply(a: number[], b: number[]) {
        let result: number[] = [];
        for (let row = 0; row < 4; row++) {
            for (let column = 0; column < 4; column++) {
                let sum = 0.0;
                for (let k = 0; k < 4; k++) {
                    sum = f(sum + f(a[row * 4 + k] * b[k * 4 + column]));
                }
                result.push(sum);
            }
        }
        return result;
    }

    function normalize3(v: number[]) {
        const length = f(Math.sqrt(f(f(f(v[0] * v[0]) + f(v[1] * v[1])) + f(v[2] * v[2]))));
        return [f(v[0] / length), f(v[1] / length), f(v[2] / length)];
    }

    function cross3(a: number[], b: number[]) {
        return [f(f(a[1] * b[2]) - f(a[2] * b[1])), f(f(a[2] * b[0]) - f(a[0] * b[2])), f(f(a[0] * b[1]) - f(a[1] * b[0]))];
    }

    function dot3(a: number[], b: number[]) {
        return f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
    }

    // XMMatrixLookAtLH.
    function lookAtLH(eye: number[], at: number[], up: number[]) {
        const r2 = normalize3([f(at[0] - eye[0]), f(at[1] - eye[1]), f(at[2] - eye[2])]);
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

    // XMMatrixPerspectiveFovLH.
    function perspectiveFovLH(fovY: number, aspect: number, nearZ: number, farZ: number) {
        const height = f(f(Math.cos(0.5 * fovY)) / f(Math.sin(0.5 * fovY)));
        const width = f(height / aspect);
        const range = f(farZ / f(farZ - nearZ));
        return [
            width, 0.0, 0.0, 0.0,
            0.0, height, 0.0, 0.0,
            0.0, 0.0, range, 1.0,
            0.0, 0.0, f(-range * nearZ), 0.0,
        ];
    }

    // XMVector3Transform(v, XMMatrixRotationY(angle)).
    function rotateY(v: number[], angle: number) {
        const c = f(Math.cos(angle));
        const s = f(Math.sin(angle));
        return [f(f(v[0] * c) + f(v[2] * s)), v[1], f(f(-v[0] * s) + f(v[2] * c))];
    }

    // -test: checks the last frame, read back, as the Donut example does. The corners are the gray
    // clear color; the tessellated red Bezier patches cover 25% to 36% of the frame, red in the
    // middle.
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
        const middle = pixels[(height / 2) * width + width / 2];
        if ((middle & 0xFF) < 150 || ((middle >> 8) & 0xFF) > 60) {
            return "the middle isn't the patches' red";
        }
        let patches = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r >= 151 && g <= 89 && b <= 89) {
                patches++;
            }
        }
        const total = width * height;
        const percent = 100.0 * patches / total;
        console.log(`Patches: ${percent}% (${patches} of ${total} pixels)`);
        if (percent < 25.0 || percent > 36.0) {
            return `Patches: ${percent}% of the pixels, not 25% to 36%`;
        }
        return "";
    }

    // Port of SimpleBezierPC12.cpp (as examples/simple_bezier.ts ports it) to NRI: a Mobius strip
    // made of four bicubic Bezier patches (16 control points each), tessellated by hull and domain
    // shaders with the same factor on every edge and inside, in one of the three partitioning
    // modes; lit by N dot L from the camera, or drawn in dark green wireframe. Left/Right turn the
    // camera around the strip, Up/Down change the subdivisions (per frame, as the sample), 1/2/3 the
    // partition mode, W the wireframe, F1 the help screen. The wireframe's edges are NRI's default
    // lines: the Donut example asks Vulkan for Bresenham lines (D3D's aliased ones), which NRI has no
    // setting for.
    class SimpleBezier {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private pipelineLayout: NriPipelineLayoutHandle | null = null;
        // [wireframe][partition mode]
        private pipelines: (NriPipelineHandle | null)[] = [];
        private controlPointVB: NriBufferHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private constantBufferView: NriDescriptorHandle | null = null;
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        private viewMatrix: number[] = [];
        private projectionMatrix: number[] = [];
        private cameraEye: number[] = [CAMERA_EYE[0], CAMERA_EYE[1], CAMERA_EYE[2]];
        private cb: f32[] = [];

        // Control variables: -wireframe, -partition <0..2>, -subdivs <4..16>, -help (and -rotate
        // <steps>, applied in main); -noUI: no HUD.
        subdivs: number = DEFAULT_SUBDIVS;
        drawWires: boolean = false;
        partitionMode: int = PartitionMode.Integer;
        showHelp: boolean = false;
        noUI: boolean = false;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            this.viewMatrix = lookAtLH(this.cameraEye, CAMERA_AT, CAMERA_UP);
            for (let i = 0; i < CB_FLOATS; i++) {
                this.cb.push(0.0);
            }
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

        // Turns the camera around the strip (positive: to the left), steps times.
        rotateCamera(angle: number, steps: int) {
            for (let i = 0; i < steps; i++) {
                this.cameraEye = rotateY(this.cameraEye, angle);
            }
            this.viewMatrix = lookAtLH(this.cameraEye, CAMERA_AT, CAMERA_UP);
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

            // Swap chain: rendered through sRGB views, as the sample's sRGB back buffers (gamma-correct
            // rendering).
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, queuedFrameNum + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            const viewFormat = Nri_GetSrgbFormat(format);
            this.viewFormat = viewFormat;
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(this.swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, viewFormat),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }

            // Queued frames
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator)));
            }

            // Sample::CreateWindowSizeDependentResources: the depth buffer (D32_FLOAT) and projection.
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return 0;
            }
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);
            const aspect = f(f(this.width) / f(this.height));
            this.projectionMatrix = perspectiveFovLH(Math.PI / 4.0, aspect, 0.01, 100.0);

            // The layout: the per frame constant buffer (b0), for every stage, a root descriptor.
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootDescriptor(layoutDesc, 0, NriDescriptorType.ConstantBuffer, NriStage.VertexTessellationPixel);
            this.pipelineLayout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The sample's PSOs: simple_bezier.hlsl's shaders, as compiled for the Donut example.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            const shaders = `shaders/simple_bezier/${folder}/simple_bezier`;
            for (let wireframe = 0; wireframe < 2; wireframe++) {
                for (let mode = 0; mode < HULL_SHADERS.length; mode++) {
                    const pipeline = this.createPipeline(device, pipelineLayout, shaders, wireframe, mode);
                    if (!pipeline) {
                        console.log("Cannot load the simple Bezier shaders");
                        return 0;
                    }
                    this.pipelines.push(pipeline);
                }
            }

            // The control points, and the per frame constants, a queued frame's each.
            const points: f32[] = [];
            for (const v of MOBIUS_STRIP) {
                points.push(v);
            }
            this.controlPointVB = Nri_CreateUploadedBuffer(device, this.queue, Ref(points[0]), CONTROL_POINTS * VERTEX_SIZE,
                NriBufferUsage.VertexBuffer);
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * CB_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            if (!this.controlPointVB || !constantBuffer) {
                console.log("Cannot create the buffers");
                return 0;
            }
            this.constantBufferView = Nri_CreateConstantBufferView(constantBuffer, 0, CB_STRIDE);

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

        // The sample's PSOs: 16 control point patches, no culling, depth clip on, depth tested
        // (less) and written; solid with BezierPS or wireframe with SolidColorPS.
        createPipeline(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle, shaders: string, wireframe: int, mode: int) {
            const desc = Nri_CreatePipelineDesc();
            const hs = HULL_SHADERS[mode];
            const ps = wireframe != 0 ? "SolidColorPS" : "BezierPS";
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_BezierVS.bin`, "BezierVS") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Hull, `${shaders}_${hs}.bin`, hs) != 0;
            }
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Domain, `${shaders}_BezierDS.bin`, "BezierDS") != 0;
            }
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_${ps}.bin`, ps) != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescSetTopology(desc, NriTopology.PatchList);
            Nri_PipelineDescSetPatchControlPoints(desc, PATCH_SIZE);
            Nri_PipelineDescSetWireframe(desc, wireframe);
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Less, 1, 0);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, pipelineLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // 1 if the key was pressed since the last frame.
        toggled(key: int) {
            return Nri_IsKeyToggled(this.sample, key) != 0;
        }

        held(key: int) {
            return Nri_IsKeyPressed(this.sample, key) != 0;
        }

        // Sample::Update: the key presses (one action per press, in the sample's order), then the
        // held keys, once per frame.
        update() {
            if (this.toggled(KEY_F1)) {
                this.showHelp = !this.showHelp;
            }
            if (this.toggled(KEY_W)) {
                this.drawWires = !this.drawWires;
            }
            if (this.toggled(KEY_1) || this.toggled(KEY_KP_1)) {
                this.partitionMode = PartitionMode.Integer;
            }
            if (this.toggled(KEY_2) || this.toggled(KEY_KP_2)) {
                this.partitionMode = PartitionMode.FractionalEven;
            }
            if (this.toggled(KEY_3) || this.toggled(KEY_KP_3)) {
                this.partitionMode = PartitionMode.FractionalOdd;
            }
            if (this.held(KEY_DOWN)) {
                this.subdivs = Math.max(f(this.subdivs - f(0.1)), MIN_DIVS);
            }
            if (this.held(KEY_UP)) {
                this.subdivs = Math.min(f(this.subdivs + f(0.1)), MAX_DIVS);
            }
            if (this.held(KEY_LEFT)) {
                this.rotateCamera(ROTATION_ANGLE_PER_STEP, 1);
            } else if (this.held(KEY_RIGHT)) {
                this.rotateCamera(-ROTATION_ANGLE_PER_STEP, 1);
            }
        }

        line(x: number, y: number, text: string) {
            Nri_ImguiDrawText(x, y, text, LIGHT_GREY, LIGHT_GREY, LIGHT_GREY, 1.0, 0);
        }

        // The sample's HUD (SpriteFont text in the title-safe area): the settings at the top, the
        // controls at the bottom; the help screen (ATG::Help, a gamepad picture with callouts) as
        // the sample's title, description and keyboard controls in text.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            // SimpleMath::Viewport::ComputeTitleSafeArea
            const safeW = Math.fround((this.width + 19.0) / 20.0);
            const safeH = Math.fround((this.height + 19.0) / 20.0);
            const left: int = Math.floor(safeW);
            const top: int = Math.floor(safeH);
            const bottom: int = Math.floor(this.height - safeH + 0.5);

            if (this.showHelp) {
                this.line(left, top, "Simple Bezier Sample");
                const y = top + TITLE_SPACING + LINE_SPACING;
                this.line(left, y, "Demonstrates how to create hull and domain shaders to draw a");
                this.line(left, y + LINE_SPACING, "tessellated Bezier surface representing a Mobius strip.");
                const controls = [
                    "Left/Right: Rotate Camera",
                    "Down: Decrease Subdivisions",
                    "Up: Increase Subdivisions",
                    "W: Toggle Wireframe",
                    "1: Integer Partitioning",
                    "2: Fractional Partitioning (Even)",
                    "3: Fractional Partitioning (Odd)",
                    "F1: Show/Hide Help",
                    "Esc: Exit",
                ];
                for (let i = 0; i < controls.length; i++) {
                    this.line(left, y + (i + 3) * LINE_SPACING, controls[i]);
                }
            } else {
                this.line(left, top, `Subdivisions: ${formatFixed(this.subdivs, 2)}   Partition Mode: ${PARTITION_NAMES[this.partitionMode]}`);
                this.line(left, bottom - 2 * LINE_SPACING, "Left/Right - Rotate   Up/Down - Increase/decrease subdivisions");
                this.line(left, bottom - LINE_SPACING, "1/2/3 - Change partition mode   W - Toggle wireframe   Esc - Exit   F1 - Help");
            }
            Nri_ImguiRender(this.sample);
        }

        // Draw the mesh (between Nri_CmdBeginRenderingWithDepth and Nri_CmdEndRendering), its
        // constants at constantsOffset.
        recordDraw(commandBuffer: NriCommandBufferHandle, constantsOffset: int) {
            const pipelineLayout = this.pipelineLayout;
            const pipeline = this.pipelines[(this.drawWires ? 1 : 0) * HULL_SHADERS.length + this.partitionMode];
            const constantBuffer = this.constantBuffer;
            const constantBufferView = this.constantBufferView;
            const controlPointVB = this.controlPointVB;
            if (!pipelineLayout || !pipeline || !constantBuffer || !constantBufferView || !controlPointVB) {
                return;
            }

            // Update per-frame variables.
            const viewProjection = multiply(this.viewMatrix, this.projectionMatrix);
            for (let i = 0; i < 16; i++) {
                this.cb[i] = viewProjection[i];
            }
            this.cb[16] = this.cameraEye[0];
            this.cb[17] = this.cameraEye[1];
            this.cb[18] = this.cameraEye[2];
            this.cb[19] = this.subdivs;
            Nri_WriteBuffer(constantBuffer, constantsOffset, Ref(this.cb[0]), CB_FLOATS * 4);

            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, pipelineLayout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetRootDescriptor(commandBuffer, 0, constantBufferView, constantsOffset);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, controlPointVB, 0, VERTEX_SIZE);
            Nri_CmdDraw(commandBuffer, CONTROL_POINTS, 1, 0, 0);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.update();
            if (this.imgui) {
                this.buildUI();
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: Sample::Clear, the mesh (not behind the help screen), then the HUD.
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                    Nri_CmdClearColor(commandBuffer, BACKGROUND, BACKGROUND, BACKGROUND, 1.0);
                    Nri_CmdClearDepth(commandBuffer, 1.0);
                    if (!this.showHelp) {
                        this.recordDraw(commandBuffer, queuedFrameIndex * CB_STRIDE);
                    }
                    Nri_CmdEndRendering(commandBuffer);
                }
                // (A pass of its own: the UI's pipeline has no depth attachment.)
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                    Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                    Nri_CmdDrawImgui(this.sample, commandBuffer, this.viewFormat);
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
                this.destroyDescriptor(this.constantBufferView);
                this.destroyDescriptor(this.depthAttachment);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.controlPointVB);
                this.destroyBuffer(this.readbackBuffer);
                const depthTexture = this.depthTexture;
                if (depthTexture) {
                    Nri_DestroyTexture(depthTexture);
                }
                for (const pipeline of this.pipelines) {
                    if (pipeline) {
                        Nri_DestroyPipeline(pipeline);
                    }
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
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const simpleBezier = new SimpleBezier(sample);
        // The initial settings: -wireframe, -partition <0..2>, -subdivs <4..16>, -rotate <steps>,
        // -help (wireframe, partition mode, subdivisions, the camera turned by Left/Right steps, the
        // help screen); -noUI: no HUD.
        Nri_AddExampleOption(sample, "-wireframe");
        Nri_AddExampleOptionWithValues(sample, "-partition", 1);
        Nri_AddExampleOptionWithValues(sample, "-subdivs", 1);
        Nri_AddExampleOptionWithValues(sample, "-rotate", 1);
        Nri_AddExampleOption(sample, "-help");
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        let rotateSteps = 0;
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-wireframe") {
                simpleBezier.drawWires = true;
            } else if (arg == "-partition" && i + 1 < argc) {
                i++;
                simpleBezier.partitionMode = Math.min(Math.max(parseInt(Nri_GetArg(argc, argv, i)), 0), 2);
            } else if (arg == "-subdivs" && i + 1 < argc) {
                i++;
                simpleBezier.subdivs = Math.min(Math.max(Math.fround(parseFloat(Nri_GetArg(argc, argv, i))), MIN_DIVS), MAX_DIVS);
            } else if (arg == "-rotate" && i + 1 < argc) {
                i++;
                rotateSteps = parseInt(Nri_GetArg(argc, argv, i));
            } else if (arg == "-help") {
                simpleBezier.showHelp = true;
            } else if (arg == "-noUI") {
                simpleBezier.noUI = true;
            }
        }
        if (rotateSteps > 0) {
            simpleBezier.rotateCamera(ROTATION_ANGLE_PER_STEP, rotateSteps);
        } else if (rotateSteps < 0) {
            simpleBezier.rotateCamera(-ROTATION_ANGLE_PER_STEP, -rotateSteps);
        }
        return simpleBezier.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return SimpleBezierNri.main(argc, argv);
}

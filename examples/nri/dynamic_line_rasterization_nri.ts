/// <reference path="../../core/nri/nri_interop.d.ts" />
import { multiply, radians, perspective, inverseGaussJordan } from "../../core/matrix";
import { comboItems } from "../../core/text_format";
import { LookAtCamera } from "../../core/vulkan_samples_camera";

namespace DynamicLineRasterizationNri {
    // dynamic_line_rasterization, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework
    // instead of Donut and NVRHI: the same shaders (dynamic_line_rasterization.hlsl's), through the NRI
    // calls core/nri/nri_interop.d.ts binds (lines' rasterization mode, width and stipple: NRI patched
    // for them, patches/NRI-line-rasterization.patch), with NRIFramework's ImGui for the sample's
    // options. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Dynamic Line Rasterization";

    // -test: checks the last frame, read back, as the Donut example does. The corners are the gray
    // background; the orange cube and its lines color about a quarter of the frame (channels 61 or more
    // apart).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const background = 0x3F3F3F;
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != background) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 63, 63, 63`;
            }
        }
        let colored = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            const high = Math.max(r, Math.max(g, b));
            const low = Math.min(r, Math.min(g, b));
            if (high - low >= 61) {
                colored++;
            }
        }
        const total = width * height;
        const percent = 100.0 * colored / total;
        console.log(`Cube: ${percent}% (${colored} of ${total} pixels)`);
        if (percent < 15.0 || percent > 35.0) {
            return `Cube: ${percent}% of the pixels, not 15% to 35%`;
        }
        return "";
    }

    // The sample's cube: its corners (float3), its triangles and its 12 edges.
    const VERTICES = [
        -1.0, -1.0, 1.0,
        1.0, -1.0, 1.0,
        1.0, 1.0, 1.0,
        -1.0, 1.0, 1.0,

        -1.0, -1.0, -1.0,
        1.0, -1.0, -1.0,
        1.0, 1.0, -1.0,
        -1.0, 1.0, -1.0,
    ];
    const CUBE_INDICES = [
        0, 1, 2, 2, 3, 0,
        4, 5, 6, 6, 7, 4,
        0, 3, 7, 7, 4, 0,
        1, 5, 6, 6, 2, 1,
        3, 2, 6, 6, 7, 3,
        0, 4, 5, 5, 1, 0,
    ];
    const EDGE_INDICES = [
        0, 1, 1, 2, 2, 3, 3, 0,
        4, 5, 5, 6, 6, 7, 7, 4,
        0, 4, 1, 5, 2, 6, 3, 7,
    ];
    const VERTEX_SIZE = 12;

    // The fill (mostly transparent) and edge colors.
    const FILL_COLOR = [0.957, 0.384, 0.024, 0.1];
    const EDGE_COLOR = [0.957, 0.384, 0.024, 1.0];
    const CLEAR_COLOR = [0.05, 0.05, 0.05, 1.0];

    // The sample's camera: a look-at camera at (0, 1, -5) turned by (-15, 15, 0) degrees, a 45
    // degree vertical field of view, depth reversed (near 128, far 0.1, as the sample passes them).
    const CAMERA_POSITION = [0.0, 1.0, -5.0];
    const CAMERA_ROTATION = [-15.0, 15.0, 0.0];
    const CAMERA_FOV = 45.0;
    const Z_NEAR = 128.0;
    const Z_FAR = 0.1;

    // The sample's rasterization modes (VkLineRasterizationModeEXT), and the line rasterization bits
    // of each, plain and stippled (DEFAULT: rectangular lines, as strictLines makes them).
    const MODE_NAMES = ["DEFAULT", "RECT", "BRESENHAM", "SMOOTH"];
    const MODE_BITS = [NriLineRasterizationBits.Rectangular, NriLineRasterizationBits.Rectangular, NriLineRasterizationBits.Bresenham,
        NriLineRasterizationBits.Smooth];
    const STIPPLED_MODE_BITS = [NriLineRasterizationBits.StippledRectangular, NriLineRasterizationBits.StippledRectangular,
        NriLineRasterizationBits.StippledBresenham, NriLineRasterizationBits.StippledSmooth];

    // A queued frame's constants, each in a 256-byte slice (D3D12 constant buffer views' alignment):
    // CameraUbo (projection * view and its inverse), then the fill's color, then the edges' (the
    // sample's push constant, which Donut writes before each draw).
    const CAMERA_FLOATS = 32;
    const CONST_SLICE = 256;
    const CAMERA_OFFSET = 0;
    const FILL_COLOR_OFFSET = 256;
    const EDGE_COLOR_OFFSET = 512;
    const CONST_STRIDE = 768;

    // The edges' pipelines kept at most (all dropped past it, as the Donut example does).
    const MAX_EDGE_PIPELINES = 32;

    // value as std::hex prints it (lowercase, no leading zeros).
    function hex(value: int) {
        const digits = "0123456789abcdef";
        let result = "";
        let v = value;
        do {
            result = digits.charAt(v % 16) + result;
            v = Math.floor(v / 16);
        } while (v > 0);
        return result;
    }

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

    // Port of Vulkan-Samples' dynamic_line_rasterization (as examples/dynamic_line_rasterization.ts
    // ports it) to NRI: a cube, filled faintly, its edges drawn as lines whose rasterization mode
    // (VK_EXT_line_rasterization's rectangular, Bresenham or smooth lines), width and stipple are set in
    // the UI, over a grid on the ground. The sample sets these as dynamic state; here each combination
    // in use is a pipeline of its own, made when first drawn, as in the Donut example. D3D has its own
    // three kinds of lines (quadrilateral, aliased, alpha antialiased) and no width or stipple.
    class DynamicLineRasterization {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private shaders: string = "";
        private pipelineLayout: NriPipelineLayoutHandle | null = null;
        private gridPipeline: NriPipelineHandle | null = null;
        private fillPipeline: NriPipelineHandle | null = null;
        // The edges' pipelines made so far, by their line state (edgeKey).
        private edgeKeys: string[] = [];
        private edgePipelines: NriPipelineHandle[] = [];
        private vertexBuffer: NriBufferHandle | null = null;
        private cubeIndexBuffer: NriBufferHandle | null = null;
        private edgeIndexBuffer: NriBufferHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private constantBufferView: NriDescriptorHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        private camera: LookAtCamera = new LookAtCamera(CAMERA_POSITION, CAMERA_ROTATION);
        // The mouse buttons as the camera last saw them.
        private buttons: boolean[] = [false, false, false];

        // The sample's settings, from its UI and the options: -mode <n>, -width <w>, -nostipple,
        // -nofill, -nogrid; -noUI: no options window.
        fillEnabled: boolean = true;
        gridEnabled: boolean = true;
        rasterizationMode: int = 0;
        requestedMode: int = 0;
        lineWidth: number = 1.0;
        requestedLineWidth: number = 1.0;
        stippleEnabled: boolean = true;
        stippleFactor: int = 1;
        // The first half on: 0x00ff.
        stipplePattern: boolean[] = [];
        noUI: boolean = false;
        // Line rasterization bits and the widest line the device draws.
        modes: int = 0;
        maxLineWidth: number = 1.0;

        // Upload buffers.
        private cameraConstants: f32[] = [];
        private colorConstants: f32[] = [0.0, 0.0, 0.0, 0.0];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < 16; i++) {
                this.stipplePattern.push(i < 8);
            }
            for (let i = 0; i < CAMERA_FLOATS; i++) {
                this.cameraConstants.push(0.0);
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

            // The line rasterization modes and the widest line, and the options' settings within them.
            this.modes = Nri_GetLineRasterizationModes(device);
            this.maxLineWidth = Nri_GetMaxLineWidth(device);
            const mode = this.requestedMode;
            if (mode > 0 && mode < MODE_NAMES.length && (this.modes & MODE_BITS[mode]) != 0) {
                this.rasterizationMode = mode;
            } else if (mode != 0) {
                console.log("The graphics device doesn't have that line rasterization mode");
            }
            this.lineWidth = Math.max(1.0, Math.min(this.requestedLineWidth, this.maxLineWidth));

            // Swap chain: rendered through sRGB views, as the Donut example's sRGB back buffer.
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

            // The layout: CameraUbo (b0) and the color (b1), root descriptors bound at the frame's
            // slices, for every stage (the grid's pixel shader reads the camera too).
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootDescriptor(layoutDesc, 0, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel);
            Nri_PipelineLayoutDescAddRootDescriptor(layoutDesc, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel);
            this.pipelineLayout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The grid's and the faces' pipelines: dynamic_line_rasterization.hlsl's shaders, as
            // compiled for the Donut example.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            this.shaders = `shaders/dynamic_line_rasterization/${folder}/dynamic_line_rasterization`;
            this.gridPipeline = this.createPipeline(device, pipelineLayout, "grid", NriTopology.TriangleList, false, -1);
            this.fillPipeline = this.createPipeline(device, pipelineLayout, "base", NriTopology.TriangleList, true, -1);
            if (!this.gridPipeline || !this.fillPipeline) {
                console.log("Cannot load the dynamic line rasterization shaders");
                return 0;
            }

            // The cube's vertices, triangles and edges.
            let vertices = VERTICES.map((v): f32 => v);
            let cubeIndices = CUBE_INDICES.map((v): int => v);
            let edgeIndices = EDGE_INDICES.map((v): int => v);
            this.vertexBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            this.cubeIndexBuffer = Nri_CreateUploadedBufferFromInts(device, this.queue, Ref(cubeIndices[0]), cubeIndices.length * 4,
                NriBufferUsage.IndexBuffer);
            this.edgeIndexBuffer = Nri_CreateUploadedBufferFromInts(device, this.queue, Ref(edgeIndices[0]), edgeIndices.length * 4,
                NriBufferUsage.IndexBuffer);

            // The constants, a queued frame's each.
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * CONST_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            if (!this.vertexBuffer || !this.cubeIndexBuffer || !this.edgeIndexBuffer || !constantBuffer) {
                console.log("Cannot create the buffers");
                return 0;
            }
            this.constantBufferView = Nri_CreateConstantBufferView(constantBuffer, 0, CONST_SLICE);

            // The sample's options.
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

        // The sample's pipeline state: no depth test, no culling, counter-clockwise front faces, depth
        // clipping off (NVRHI's default), blending by the source's alpha (the alpha written as is).
        // name: "grid" (no vertices) or "base" (the cube's positions); lines with the line settings
        // (stipple 0 or 1), triangles with mode -1.
        createPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, name: string, topology: NriTopology, withVertices: boolean,
            stipple: int) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${this.shaders}_${name}_vs.bin`, `${name}_vs`) != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${this.shaders}_${name}_ps.bin`, `${name}_ps`) != 0;
            }
            if (withVertices) {
                Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            }
            Nri_PipelineDescSetTopology(desc, topology);
            Nri_PipelineDescSetFrontCounterClockwise(desc, 1);
            Nri_PipelineDescSetDepthClip(desc, 0);
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetBlend(desc, NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha, NriBlendOp.Add,
                NriBlendFactor.One, NriBlendFactor.Zero, NriBlendOp.Add);
            if (stipple >= 0) {
                Nri_PipelineDescSetLineRasterization(desc, <NriLineRasterizationMode>this.rasterizationMode, Math.fround(this.lineWidth), stipple,
                    this.stippleFactor, this.pattern());
            }
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // The stipple pattern's bits, the first checkbox the lowest.
        pattern() {
            let result = 0;
            for (let i = 0; i < 16; i++) {
                if (this.stipplePattern[i]) {
                    result |= 1 << i;
                }
            }
            return result;
        }

        // Whether the device stipples lines of the selected mode.
        canStipple() {
            return (this.modes & STIPPLED_MODE_BITS[this.rasterizationMode]) != 0;
        }

        // The edges' pipeline for the line settings; null if it can't be made.
        edgePipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle): NriPipelineHandle | null {
            const stipple = this.stippleEnabled && this.canStipple();
            const key = `${this.rasterizationMode} ${this.lineWidth} ${stipple ? 1 : 0} ${this.stippleFactor} ${this.pattern()}`;
            for (let i = 0; i < this.edgeKeys.length; i++) {
                if (this.edgeKeys[i] == key) {
                    return this.edgePipelines[i];
                }
            }
            const pipeline = this.createPipeline(device, layout, "base", NriTopology.LineList, true, stipple ? 1 : 0);
            if (pipeline) {
                this.edgeKeys.push(key);
                this.edgePipelines.push(pipeline);
            }
            return pipeline;
        }

        // Keeps a handful of edge pipelines: drops them all now and then (after the frames in flight
        // that may draw with them).
        trimEdgePipelines(device: NriDeviceHandle) {
            if (this.edgePipelines.length <= MAX_EDGE_PIPELINES) {
                return;
            }
            Nri_DeviceWaitIdle(device);
            for (const edgePipeline of this.edgePipelines) {
                Nri_DestroyPipeline(edgePipeline);
            }
            this.edgeKeys = [];
            this.edgePipelines = [];
        }

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The camera's mouse handling (ApiVulkanSample's), unless the options window has the mouse:
        // the buttons' changes, then the cursor's position.
        handleMouse() {
            const overlay = this.imgui && Nri_ImguiWantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = Nri_IsButtonPressed(this.sample, button) != 0;
                if (pressed != this.buttons[button]) {
                    if (!pressed || !overlay) {
                        this.camera.mouseButton(<MouseButton>button, <Action>(pressed ? 1 : 0));
                    }
                    this.buttons[button] = pressed;
                }
            }
            this.camera.mouseMove(Nri_GetMouseX(this.sample), Nri_GetMouseY(this.sample));
        }

        // The sample's options.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Options", 1);
            if (Nri_ImguiCollapsingHeader("Primitive options", 1) != 0) {
                this.fillEnabled = Nri_ImguiCheckbox("Fill", this.fillEnabled ? 1 : 0) != 0;
                this.gridEnabled = Nri_ImguiCheckbox("Grid", this.gridEnabled ? 1 : 0) != 0;
                // Only the modes the device has (DEFAULT always).
                const mode = Nri_ImguiCombo("Rasterization mode", this.rasterizationMode, comboItems(MODE_NAMES));
                if (mode == 0 || (this.modes & MODE_BITS[mode]) != 0) {
                    this.rasterizationMode = mode;
                }
                // Wide lines and stipple: Vulkan's only.
                if (this.maxLineWidth > 1.0) {
                    this.lineWidth = Nri_ImguiSliderFloat("Line width", this.lineWidth, 1.0, Math.min(64.0, this.maxLineWidth));
                }
                if (this.canStipple()) {
                    this.stippleEnabled = Nri_ImguiCheckbox("Stipple enabled", this.stippleEnabled ? 1 : 0) != 0;
                    // The stipple factor has a maximum value of 256. Here, a limit of 64 has been chosen to achieve a scroll step equal to 1.
                    this.stippleFactor = Nri_ImguiSliderInt("Stipple factor", this.stippleFactor, 1, 64);
                    Nri_ImguiText(`Stipple pattern: ${hex(this.pattern())}`);
                    for (let i = 0; i < 16; i++) {
                        Nri_ImguiPushID(i);
                        this.stipplePattern[i] = Nri_ImguiCheckbox("", this.stipplePattern[i] ? 1 : 0) != 0;
                        Nri_ImguiPopID();
                        if (i % 8 != 7) {
                            Nri_ImguiSameLine();
                        }
                    }
                }
            }
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The sample's update_uniform_buffers (projection * view, into Donut's clip space: y negated,
        // and its inverse) and the colors, into this queued frame's slices from offset.
        writeConstants(constantBuffer: NriBufferHandle, offset: int) {
            const view = this.camera.view();
            let viewProj = multiply(perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR), view);
            for (let i = 1; i < 16; i += 4) {
                viewProj[i] = -viewProj[i];
            }
            const viewProjInverse = inverseGaussJordan(viewProj);
            for (let i = 0; i < 16; i++) {
                this.cameraConstants[i] = viewProj[i];
                this.cameraConstants[16 + i] = viewProjInverse[i];
            }
            Nri_WriteBuffer(constantBuffer, offset + CAMERA_OFFSET, Ref(this.cameraConstants[0]), CAMERA_FLOATS * 4);
            this.writeColor(constantBuffer, offset + FILL_COLOR_OFFSET, FILL_COLOR);
            this.writeColor(constantBuffer, offset + EDGE_COLOR_OFFSET, EDGE_COLOR);
        }

        // The sample's push constant.
        writeColor(constantBuffer: NriBufferHandle, offset: int, color: number[]) {
            for (let i = 0; i < 4; i++) {
                this.colorConstants[i] = color[i];
            }
            Nri_WriteBuffer(constantBuffer, offset, Ref(this.colorConstants[0]), 4 * 4);
        }

        // The grid, the cube's faces and its edges (between Nri_CmdBeginRendering and
        // Nri_CmdEndRendering); this queued frame's constants from frameOffset.
        recordDraw(device: NriDeviceHandle, commandBuffer: NriCommandBufferHandle, frameOffset: int) {
            const pipelineLayout = this.pipelineLayout;
            const gridPipeline = this.gridPipeline;
            const fillPipeline = this.fillPipeline;
            const vertexBuffer = this.vertexBuffer;
            const cubeIndexBuffer = this.cubeIndexBuffer;
            const edgeIndexBuffer = this.edgeIndexBuffer;
            const constantBufferView = this.constantBufferView;
            if (!pipelineLayout || !gridPipeline || !fillPipeline || !vertexBuffer || !cubeIndexBuffer || !edgeIndexBuffer
                || !constantBufferView) {
                return;
            }
            const edgePipeline = this.edgePipeline(device, pipelineLayout);

            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, pipelineLayout);
            Nri_CmdSetRootDescriptor(commandBuffer, 0, constantBufferView, frameOffset + CAMERA_OFFSET);
            Nri_CmdSetRootDescriptor(commandBuffer, 1, constantBufferView, frameOffset + FILL_COLOR_OFFSET);

            // The grid.
            if (this.gridEnabled) {
                Nri_CmdSetPipeline(commandBuffer, gridPipeline);
                Nri_CmdDraw(commandBuffer, 6, 1, 0, 0);
            }

            // The cube's faces.
            Nri_CmdSetVertexBuffer(commandBuffer, 0, vertexBuffer, 0, VERTEX_SIZE);
            if (this.fillEnabled) {
                Nri_CmdSetPipeline(commandBuffer, fillPipeline);
                Nri_CmdSetIndexBuffer(commandBuffer, cubeIndexBuffer, 0, NriIndexType.UInt32);
                Nri_CmdDrawIndexed(commandBuffer, CUBE_INDICES.length, 1, 0, 0, 0);
            }

            // Its edges.
            if (edgePipeline) {
                Nri_CmdSetRootDescriptor(commandBuffer, 1, constantBufferView, frameOffset + EDGE_COLOR_OFFSET);
                Nri_CmdSetPipeline(commandBuffer, edgePipeline);
                Nri_CmdSetIndexBuffer(commandBuffer, edgeIndexBuffer, 0, NriIndexType.UInt32);
                Nri_CmdDrawIndexed(commandBuffer, EDGE_INDICES.length, 1, 0, 0, 0);
            }
        }

        renderFrame(frameIndex: int) {
            const device = this.device;
            const constantBuffer = this.constantBuffer;
            if (!device || !constantBuffer) {
                return;
            }
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();
            this.trimEdgePipelines(device);

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;
                const frameOffset = queuedFrameIndex * CONST_STRIDE;
                this.writeConstants(constantBuffer, frameOffset);

                // Record: cleared to dark gray, the grid, the cube; the options window over them (the
                // pass has no depth attachment, which NRIFramework's ImGui pipeline doesn't have
                // either).
                Nri_BeginCommandBuffer(commandBuffer);
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                Nri_CmdClearColor(commandBuffer, CLEAR_COLOR[0], CLEAR_COLOR[1], CLEAR_COLOR[2], CLEAR_COLOR[3]);
                this.recordDraw(device, commandBuffer, frameOffset);
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
                const constantBufferView = this.constantBufferView;
                if (constantBufferView) {
                    Nri_DestroyDescriptor(constantBufferView);
                }
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.cubeIndexBuffer);
                this.destroyBuffer(this.edgeIndexBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.gridPipeline);
                this.destroyPipeline(this.fillPipeline);
                for (const edgePipeline of this.edgePipelines) {
                    Nri_DestroyPipeline(edgePipeline);
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
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const lines = new DynamicLineRasterization(sample);
        // -mode <n>: the rasterization mode (0 DEFAULT, 1 RECT, 2 BRESENHAM, 3 SMOOTH); -width <w>: the
        // line width; -nostipple: stipple off; -nofill: fill off; -nogrid: grid off; -noUI: no options
        // window.
        Nri_AddExampleOptionWithValues(sample, "-mode", 1);
        Nri_AddExampleOptionWithValues(sample, "-width", 1);
        Nri_AddExampleOption(sample, "-nostipple");
        Nri_AddExampleOption(sample, "-nofill");
        Nri_AddExampleOption(sample, "-nogrid");
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-mode" && i + 1 < argc) {
                lines.requestedMode = parseInt(Nri_GetArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-width" && i + 1 < argc) {
                lines.requestedLineWidth = parseFloat(Nri_GetArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-nostipple") {
                lines.stippleEnabled = false;
            } else if (arg == "-nofill") {
                lines.fillEnabled = false;
            } else if (arg == "-nogrid") {
                lines.gridEnabled = false;
            } else if (arg == "-noUI") {
                lines.noUI = true;
            }
        }
        return lines.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return DynamicLineRasterizationNri.main(argc, argv);
}

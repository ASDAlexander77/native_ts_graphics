/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { multiply, radians, perspective, inverseGaussJordan } from "../../core/matrix";
import { comboItems } from "../../core/text_format";
import { LookAtCamera } from "../../core/vulkan_samples_camera";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDevice, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample } from "../../core/nri";

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

    // Port of Vulkan-Samples' dynamic_line_rasterization (as examples/dynamic_line_rasterization.ts
    // ports it) to NRI: a cube, filled faintly, its edges drawn as lines whose rasterization mode
    // (VK_EXT_line_rasterization's rectangular, Bresenham or smooth lines), width and stipple are set in
    // the UI, over a grid on the ground. The sample sets these as dynamic state; here each combination
    // in use is a pipeline of its own, made when first drawn, as in the Donut example. D3D has its own
    // three kinds of lines (quadrilateral, aliased, alpha antialiased) and no width or stipple.
    class DynamicLineRasterization {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private viewFormat: NriFormat = NriFormat.Unknown;
        private shaders: string = "";
        private pipelineLayout: NriPipelineLayout | null = null;
        private gridPipeline: NriPipeline | null = null;
        private fillPipeline: NriPipeline | null = null;
        // The edges' pipelines made so far, by their line state (edgeKey).
        private edgeKeys: string[] = [];
        private edgePipelines: NriPipeline[] = [];
        private vertexBuffer: NriBuffer | null = null;
        private cubeIndexBuffer: NriBuffer | null = null;
        private edgeIndexBuffer: NriBuffer | null = null;
        private constantBuffer: NriBuffer | null = null;
        private constantBufferView: NriDescriptor | null = null;
        private imgui: boolean = false;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;

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
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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
            this.sample.setInitializeCallback(initialize);
            this.sample.setLatencySleepCallback(latencySleep);
            this.sample.setRenderFrameCallback(renderFrame);

            // On a wrapper of its own: the callbacks Nri_RunSample runs may overwrite this.sample.
            let result = new NriSample(this.sample.handle).run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (result == 0 && this.test) {
                const failure = checkFrame(this.readBack(), this.width, this.height);
                console.log(failure == "" ? "Test PASSED" : `Test FAILED: ${failure}`);
                result = failure == "" ? 0 : 1;
            }
            this.destroy();
            return result;
        }

        initialize(graphicsAPI: NriGraphicsAPI): int {
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // The line rasterization modes and the widest line, and the options' settings within them.
            this.modes = device.getLineRasterizationModes();
            this.maxLineWidth = device.getMaxLineWidth();
            const mode = this.requestedMode;
            if (mode > 0 && mode < MODE_NAMES.length && (this.modes & MODE_BITS[mode]) != 0) {
                this.rasterizationMode = mode;
            } else if (mode != 0) {
                console.log("The graphics device doesn't have that line rasterization mode");
            }
            this.lineWidth = Math.max(1.0, Math.min(this.requestedLineWidth, this.maxLineWidth));

            // Swap chain: rendered through sRGB views, as the Donut example's sRGB back buffer.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;
            this.viewFormat = viewFormat;

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);

            // The layout: CameraUbo (b0) and the color (b1), root descriptors bound at the frame's
            // slices, for every stage (the grid's pixel shader reads the camera too).
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRootDescriptor(0, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel);
            layoutDesc.addRootDescriptor(1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel);
            this.pipelineLayout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
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
            this.vertexBuffer = device.createUploadedBuffer(this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            this.cubeIndexBuffer = device.createUploadedBufferFromInts(this.queue, Ref(cubeIndices[0]), cubeIndices.length * 4,
                NriBufferUsage.IndexBuffer);
            this.edgeIndexBuffer = device.createUploadedBufferFromInts(this.queue, Ref(edgeIndices[0]), edgeIndices.length * 4,
                NriBufferUsage.IndexBuffer);

            // The constants, a queued frame's each.
            const constantBuffer = device.createHostBuffer(queuedFrameNum * CONST_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            if (!this.vertexBuffer || !this.cubeIndexBuffer || !this.edgeIndexBuffer || !constantBuffer) {
                console.log("Cannot create the buffers");
                return 0;
            }
            this.constantBufferView = constantBuffer.createConstantView(0, CONST_SLICE);

            // The sample's options.
            if (!this.noUI) {
                if (this.sample.initImgui(device) == 0) {
                    console.log("Cannot initialize the user interface");
                    return 0;
                }
                this.imgui = true;
            }

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The sample's pipeline state: no depth test, no culling, counter-clockwise front faces, depth
        // clipping off (NVRHI's default), blending by the source's alpha (the alpha written as is).
        // name: "grid" (no vertices) or "base" (the cube's positions); lines with the line settings
        // (stipple 0 or 1), triangles with mode -1.
        createPipeline(device: NriDevice, layout: NriPipelineLayout, name: string, topology: NriTopology, withVertices: boolean,
            stipple: int) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${this.shaders}_${name}_vs.bin`, `${name}_vs`) != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${this.shaders}_${name}_ps.bin`, `${name}_ps`) != 0;
            }
            if (withVertices) {
                desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            }
            desc.setTopology(topology);
            desc.setFrontCounterClockwise(1);
            desc.setDepthClip(0);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
            desc.setBlend(NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha, NriBlendOp.Add,
                NriBlendFactor.One, NriBlendFactor.Zero, NriBlendOp.Add);
            if (stipple >= 0) {
                desc.setLineRasterization(<NriLineRasterizationMode>this.rasterizationMode, Math.fround(this.lineWidth), stipple,
                    this.stippleFactor, this.pattern());
            }
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
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
        edgePipeline(device: NriDevice, layout: NriPipelineLayout): NriPipeline | null {
            const stipple = this.stippleEnabled && this.canStipple();
            const key = `${this.rasterizationMode} ${this.lineWidth} ${stipple ? 1 : 0} ${this.stippleFactor} ${this.pattern()}`;
            for (let i = 0; i < this.edgeKeys.length; i++) {
                if (this.edgeKeys[i] == key) {
                    return new NriPipeline(this.edgePipelines[i].handle);
                }
            }
            const pipeline = this.createPipeline(device, layout, "base", NriTopology.LineList, true, stipple ? 1 : 0);
            if (!pipeline) {
                return null;
            }
            // A wrapper of its own (destroying nothing) for the caller: the list keeps the pipeline.
            const result = new NriPipeline(pipeline.handle);
            this.edgeKeys.push(key);
            this.edgePipelines.push(pipeline);
            return result;
        }

        // Keeps a handful of edge pipelines: drops them all now and then (after the frames in flight
        // that may draw with them).
        trimEdgePipelines(device: NriDevice) {
            if (this.edgePipelines.length <= MAX_EDGE_PIPELINES) {
                return;
            }
            device.waitIdle();
            for (const edgePipeline of this.edgePipelines) {
                edgePipeline.destroy();
            }
            this.edgeKeys = [];
            this.edgePipelines = [];
        }

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The camera's mouse handling (ApiVulkanSample's), unless the options window has the mouse:
        // the buttons' changes, then the cursor's position.
        handleMouse() {
            const overlay = this.imgui && NriImgui.wantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = this.sample.isButtonPressed(button) != 0;
                if (pressed != this.buttons[button]) {
                    if (!pressed || !overlay) {
                        this.camera.mouseButton(<MouseButton>button, <Action>(pressed ? 1 : 0));
                    }
                    this.buttons[button] = pressed;
                }
            }
            this.camera.mouseMove(this.sample.getMouseX(), this.sample.getMouseY());
        }

        // The sample's options.
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Options", 1);
            if (NriImgui.collapsingHeader("Primitive options", 1) != 0) {
                this.fillEnabled = NriImgui.checkbox("Fill", this.fillEnabled ? 1 : 0) != 0;
                this.gridEnabled = NriImgui.checkbox("Grid", this.gridEnabled ? 1 : 0) != 0;
                // Only the modes the device has (DEFAULT always).
                const mode = NriImgui.combo("Rasterization mode", this.rasterizationMode, comboItems(MODE_NAMES));
                if (mode == 0 || (this.modes & MODE_BITS[mode]) != 0) {
                    this.rasterizationMode = mode;
                }
                // Wide lines and stipple: Vulkan's only.
                if (this.maxLineWidth > 1.0) {
                    this.lineWidth = NriImgui.sliderFloat("Line width", this.lineWidth, 1.0, Math.min(64.0, this.maxLineWidth));
                }
                if (this.canStipple()) {
                    this.stippleEnabled = NriImgui.checkbox("Stipple enabled", this.stippleEnabled ? 1 : 0) != 0;
                    // The stipple factor has a maximum value of 256. Here, a limit of 64 has been chosen to achieve a scroll step equal to 1.
                    this.stippleFactor = NriImgui.sliderInt("Stipple factor", this.stippleFactor, 1, 64);
                    NriImgui.text(`Stipple pattern: ${hex(this.pattern())}`);
                    for (let i = 0; i < 16; i++) {
                        NriImgui.pushID(i);
                        this.stipplePattern[i] = NriImgui.checkbox("", this.stipplePattern[i] ? 1 : 0) != 0;
                        NriImgui.popID();
                        if (i % 8 != 7) {
                            NriImgui.sameLine();
                        }
                    }
                }
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The sample's update_uniform_buffers (projection * view, into Donut's clip space: y negated,
        // and its inverse) and the colors, into this queued frame's slices from offset.
        writeConstants(constantBuffer: NriBuffer, offset: int) {
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
            constantBuffer.write(offset + CAMERA_OFFSET, Ref(this.cameraConstants[0]), CAMERA_FLOATS * 4);
            this.writeColor(constantBuffer, offset + FILL_COLOR_OFFSET, FILL_COLOR);
            this.writeColor(constantBuffer, offset + EDGE_COLOR_OFFSET, EDGE_COLOR);
        }

        // The sample's push constant.
        writeColor(constantBuffer: NriBuffer, offset: int, color: number[]) {
            for (let i = 0; i < 4; i++) {
                this.colorConstants[i] = color[i];
            }
            constantBuffer.write(offset, Ref(this.colorConstants[0]), 4 * 4);
        }

        // The grid, the cube's faces and its edges (between NriCommandBuffer.beginRendering and
        // NriCommandBuffer.endRendering); this queued frame's constants from frameOffset.
        recordDraw(device: NriDevice, commandBuffer: NriCommandBuffer, frameOffset: int) {
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

            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(pipelineLayout);
            commandBuffer.setRootDescriptor(0, constantBufferView, frameOffset + CAMERA_OFFSET);
            commandBuffer.setRootDescriptor(1, constantBufferView, frameOffset + FILL_COLOR_OFFSET);

            // The grid.
            if (this.gridEnabled) {
                commandBuffer.setPipeline(gridPipeline);
                commandBuffer.draw(6, 1, 0, 0);
            }

            // The cube's faces.
            commandBuffer.setVertexBuffer(0, vertexBuffer, 0, VERTEX_SIZE);
            if (this.fillEnabled) {
                commandBuffer.setPipeline(fillPipeline);
                commandBuffer.setIndexBuffer(cubeIndexBuffer, 0, NriIndexType.UInt32);
                commandBuffer.drawIndexed(CUBE_INDICES.length, 1, 0, 0, 0);
            }

            // Its edges.
            if (edgePipeline) {
                commandBuffer.setRootDescriptor(1, constantBufferView, frameOffset + EDGE_COLOR_OFFSET);
                commandBuffer.setPipeline(edgePipeline);
                commandBuffer.setIndexBuffer(edgeIndexBuffer, 0, NriIndexType.UInt32);
                commandBuffer.drawIndexed(EDGE_INDICES.length, 1, 0, 0, 0);
            }
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain (and what has the window's
        // size) made again at its size, once the GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            this.swapChain.recreate();
            this.sizeToSwapChain();
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const device = this.device;
            const constantBuffer = this.constantBuffer;
            if (!device || !constantBuffer) {
                return;
            }
            const queuedFrameIndex = frameIndex % this.frames.size();
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();
            this.trimEdgePipelines(device);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);
                const frameOffset = queuedFrameIndex * CONST_STRIDE;
                this.writeConstants(constantBuffer, frameOffset);

                // Record: cleared to dark gray, the grid, the cube; the options window over them (the
                // pass has no depth attachment, which NRIFramework's ImGui pipeline doesn't have
                // either).
                commandBuffer.begin();
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                commandBuffer.clearColor(CLEAR_COLOR[0], CLEAR_COLOR[1], CLEAR_COLOR[2], CLEAR_COLOR[3]);
                this.recordDraw(device, commandBuffer, frameOffset);
                if (this.imgui) {
                    this.sample.drawImgui(commandBuffer, this.viewFormat);
                }
                commandBuffer.endRendering();

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

        // The last frame's pixels (0xAABBGGRR), empty if it can't be read.
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
            if (readbackBuffer.readRGBA8(this.rowPitch, this.width, this.height, this.readbackFormat,
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
                const constantBufferView = this.constantBufferView;
                if (constantBufferView) {
                    constantBufferView.destroy();
                }
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.cubeIndexBuffer);
                this.destroyBuffer(this.edgeIndexBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.gridPipeline);
                this.destroyPipeline(this.fillPipeline);
                for (const edgePipeline of this.edgePipelines) {
                    edgePipeline.destroy();
                }
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    pipelineLayout.destroy();
                }
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }

        destroyBuffer(buffer: NriBuffer | null) {
            if (buffer) {
                buffer.destroy();
            }
        }

        destroyPipeline(pipeline: NriPipeline | null) {
            if (pipeline) {
                pipeline.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const lines = new DynamicLineRasterization(sample);
        // -mode <n>: the rasterization mode (0 DEFAULT, 1 RECT, 2 BRESENHAM, 3 SMOOTH); -width <w>: the
        // line width; -nostipple: stipple off; -nofill: fill off; -nogrid: grid off; -noUI: no options
        // window.
        sample.addExampleOptionWithValues("-mode", 1);
        sample.addExampleOptionWithValues("-width", 1);
        sample.addExampleOption("-nostipple");
        sample.addExampleOption("-nofill");
        sample.addExampleOption("-nogrid");
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-mode" && i + 1 < argc) {
                lines.requestedMode = parseInt(Nri.getArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-width" && i + 1 < argc) {
                lines.requestedLineWidth = parseFloat(Nri.getArg(argc, argv, i + 1));
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

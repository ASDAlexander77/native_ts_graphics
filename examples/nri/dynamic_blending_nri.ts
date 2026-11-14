/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { multiply, inverseRigid, radians, perspective } from "../../core/matrix";
import { comboItems } from "../../core/text_format";
import { LookAtCamera } from "../../core/vulkan_samples_camera";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace DynamicBlendingNri {
    // dynamic_blending, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (dynamic_blending.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws, with NRIFramework's ImGui for the
    // sample's options. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Dynamic Blending";

    // The sample's two faces: float3 position, float2 texture coordinates per vertex.
    const VERTEX_FLOATS = 5;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const VERTICES = [
        -1.0, -1.0, 1.0, 0.0, 0.0,
        1.0, -1.0, 1.0, 1.0, 0.0,
        1.0, 1.0, 1.0, 1.0, 1.0,
        -1.0, 1.0, 1.0, 0.0, 1.0,

        -1.0, -1.0, -1.0, 0.0, 0.0,
        1.0, -1.0, -1.0, 1.0, 0.0,
        1.0, 1.0, -1.0, 1.0, 1.0,
        -1.0, 1.0, -1.0, 0.0, 1.0,
    ];
    // The face at z = -1 (6 indices from 0), then the one at z = 1 (6 from 6).
    const INDICES = [6, 5, 4, 4, 7, 6, 0, 1, 2, 2, 3, 0];
    const FACE_INDEX_COUNT = 6;

    // The sample's camera: a look-at camera at (0, 0, -5) turned by (-15, 15, 0) degrees, a 45
    // degree vertical field of view, depth reversed (near 256, far 0.1, as the sample passes them).
    const CAMERA_POSITION = [0.0, 0.0, -5.0];
    const CAMERA_ROTATION = [-15.0, 15.0, 0.0];
    const CAMERA_FOV = 45.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // Vulkan's blend operations (VK_BLEND_OP_ADD ... MAX) and blend factors (VK_BLEND_FACTOR_ZERO
    // ... SRC_ALPHA_SATURATE), as the sample names them; NRI's are in the same order. The factors
    // as the Donut example maps them, so the frames match: NVRHI has no constant alpha factors, and
    // uses the constant color's for them (the blend constants are zeros either way: the sample's);
    // a color factor's alpha is its alpha factor's (D3D takes only those for the alpha).
    const BLEND_OP_NAMES = ["ADD", "SUBTRACT", "REVERSE_SUBTRACT", "MIN", "MAX"];
    const BLEND_FACTOR_NAMES = ["ZERO", "ONE", "SRC_COLOR", "ONE_MINUS_SRC_COLOR", "DST_COLOR", "ONE_MINUS_DST_COLOR",
        "SRC_ALPHA", "ONE_MINUS_SRC_ALPHA", "DST_ALPHA", "ONE_MINUS_DST_ALPHA", "CONSTANT_COLOR",
        "ONE_MINUS_CONSTANT_COLOR", "CONSTANT_ALPHA", "ONE_MINUS_CONSTANT_ALPHA", "SRC_ALPHA_SATURATE"];
    const BLEND_FACTORS = [NriBlendFactor.Zero, NriBlendFactor.One, NriBlendFactor.SrcColor, NriBlendFactor.OneMinusSrcColor,
        NriBlendFactor.DstColor, NriBlendFactor.OneMinusDstColor, NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha,
        NriBlendFactor.DstAlpha, NriBlendFactor.OneMinusDstAlpha, NriBlendFactor.ConstantColor, NriBlendFactor.OneMinusConstantColor,
        NriBlendFactor.ConstantColor, NriBlendFactor.OneMinusConstantColor, NriBlendFactor.SrcAlphaSaturate];
    const ALPHA_BLEND_FACTORS = [NriBlendFactor.Zero, NriBlendFactor.One, NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha,
        NriBlendFactor.DstAlpha, NriBlendFactor.OneMinusDstAlpha, NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha,
        NriBlendFactor.DstAlpha, NriBlendFactor.OneMinusDstAlpha, NriBlendFactor.ConstantColor, NriBlendFactor.OneMinusConstantColor,
        NriBlendFactor.ConstantColor, NriBlendFactor.OneMinusConstantColor, NriBlendFactor.SrcAlphaSaturate];
    const BLEND_OPS = [NriBlendOp.Add, NriBlendOp.Subtract, NriBlendOp.ReverseSubtract, NriBlendOp.Min, NriBlendOp.Max];
    const VK_BLEND_FACTOR_ZERO = 0;
    const VK_BLEND_FACTOR_ONE = 1;
    const VK_BLEND_FACTOR_SRC_ALPHA = 6;
    const VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA = 7;

    // CameraUbo (a float4x4) and ColorUbo (8 float4 colors), each in a constant buffer view of 256
    // bytes (D3D12's alignment); a queued frame's pair each, FRAME_CONSTANTS_STRIDE bytes apart.
    const COLOR_FLOATS = 32;
    const CONSTANT_VIEW_SIZE = 256;
    const FRAME_CONSTANTS_STRIDE = 512;

    // The pipelines kept: past this many, they're all dropped (as the Donut example does).
    const MAX_PIPELINES = 32;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // A frame in flight's own data: its descriptor set (its copy of the constants).
    class QueuedFrame {
        constructor(public descriptorSet: NriDescriptorSet | null, public cameraView: NriDescriptor | null,
            public colorView: NriDescriptor | null) {
        }
    }

    // A pipeline made for a blend state (DynamicBlending.pipelineKey).
    class KeyedPipeline {
        constructor(public key: string, public pipeline: NriPipeline) {
        }
    }

    // An NriColorWrite mask from the sample's red, green, blue, alpha switches.
    function colorMask(enabled: boolean[]) {
        let mask = 0;
        if (enabled[0]) {
            mask |= NriColorWrite.R;
        }
        if (enabled[1]) {
            mask |= NriColorWrite.G;
        }
        if (enabled[2]) {
            mask |= NriColorWrite.B;
        }
        if (enabled[3]) {
            mask |= NriColorWrite.A;
        }
        return mask;
    }

    // One face's settings: its corner colors (top left, top right, bottom left, bottom right; 4
    // floats each) and which channels it writes (red, green, blue, alpha).
    class FacePreferences {
        colors: f32[] = [];
        colorBitEnabled: boolean[] = [true, true, true, true];

        constructor(public indexOffset: int, colors: number[]) {
            for (let i = 0; i < 16; i++) {
                this.colors.push(colors[i]);
            }
        }
    }

    // -test: checks the last frame, read back, as the Donut example does. The corners are the gray
    // background; the two blended quads, right of the settings window, cover 12% to 35% of the
    // frame's right half and its middle.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const background = 0xBCBCBC;
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != background) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 188, 188, 188`;
            }
        }
        if ((pixels[Math.floor(height / 2) * width + Math.floor(width / 2)] & 0xFFFFFF) == background) {
            return "no quad in the middle";
        }
        const half: int = Math.floor(width / 2);
        let quads = 0;
        for (let y = 0; y < height; y++) {
            for (let x = half; x < width; x++) {
                if ((pixels[y * width + x] & 0xFFFFFF) != background) {
                    quads++;
                }
            }
        }
        const total = (width - half) * height;
        const percent = 100.0 * quads / total;
        console.log(`Quads, right half: ${percent}% (${quads} of ${total} pixels)`);
        if (percent < 12.0 || percent > 35.0) {
            return `Quads, right half: ${percent}% of the pixels, not 12% to 35%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' dynamic_blending (as examples/dynamic_blending.ts ports it) to NRI: two
    // overlapping faces, each with a color per corner, the far one drawn first, blended by the blend
    // state set in the UI: blending on or off, its equation (operations and factors of the color and
    // of the alpha), and each face's color write mask. The sample sets these as dynamic state
    // (VK_EXT_extended_dynamic_state3); here each combination in use is a pipeline of its own, made
    // when first drawn. NRI has no advanced blend operations (VK_EXT_blend_operation_advanced, which
    // the Donut example offers on Vulkan): the UI has the blend equation only. The left mouse button
    // turns the camera.
    class DynamicBlending {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        // The swap chain textures' format (its views' are viewFormat).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private viewFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private layout: NriPipelineLayout | null = null;
        private shaders: string = "";
        private pipelines: KeyedPipeline[] = [];
        private vertexBuffer: NriBuffer | null = null;
        private indexBuffer: NriBuffer | null = null;
        private constantBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private imgui: boolean = false;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;

        private camera: LookAtCamera = new LookAtCamera(CAMERA_POSITION, CAMERA_ROTATION);
        // The mouse, as the camera sees it: its position (summed from its moves) and buttons.
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;
        private buttons: boolean[] = [false, false, false];

        // The sample's settings, from its UI (-noblend: blending off); -noUI: no options window.
        clearColor: f32[] = [0.5, 0.5, 0.5, 1.0];
        faces: FacePreferences[] = [
            new FacePreferences(0, [
                1.0, 0.0, 0.0, 1.0,
                0.0, 1.0, 0.0, 1.0,
                0.0, 0.0, 1.0, 1.0,
                0.0, 0.0, 0.0, 1.0]),
            new FacePreferences(FACE_INDEX_COUNT, [
                0.0, 1.0, 1.0, 0.5,
                1.0, 0.0, 1.0, 0.5,
                1.0, 1.0, 0.0, 0.5,
                1.0, 1.0, 1.0, 0.5]),
        ];
        blendEnable: boolean = true;
        colorOperator: int = 0;
        alphaOperator: int = 0;
        srcColorBlendFactor: int = VK_BLEND_FACTOR_SRC_ALPHA;
        dstColorBlendFactor: int = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
        srcAlphaBlendFactor: int = VK_BLEND_FACTOR_ZERO;
        dstAlphaBlendFactor: int = VK_BLEND_FACTOR_ONE;
        noUI: boolean = false;

        // Upload buffers.
        private cameraConstants: f32[] = [];
        private colorConstants: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < 16; i++) {
                this.cameraConstants.push(0.0);
            }
            for (let i = 0; i < COLOR_FLOATS; i++) {
                this.colorConstants.push(0.0);
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

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.viewFormat;

            // The depth buffer: D32, cleared to 0 (the sample's reversed depth).
            if (!this.createDepth(device)) {
                console.log("Cannot create the depth buffer");
                return 0;
            }

            // The layout: CameraUbo (b0, the vertex shader's) and ColorUbo (b1, the pixel shader's).
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 2, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            const layout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // dynamic_blending.hlsl's shaders, as compiled for the Donut example; the first pipeline
            // made now, to find them.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            this.shaders = `shaders/dynamic_blending/${folder}/dynamic_blending`;
            if (!this.facePipeline(this.faces[0])) {
                console.log("Cannot load the dynamic blending shaders");
                return 0;
            }

            // The faces.
            const vertices = VERTICES.map((v): f32 => v);
            const indices = INDICES.map((v): int => v);
            this.vertexBuffer = device.createUploadedBuffer(this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            this.indexBuffer = device.createUploadedBufferFromInts(this.queue, Ref(indices[0]), indices.length * 4, NriBufferUsage.IndexBuffer);

            // A queued frame's constants each, in its own descriptor set.
            const constantBuffer = device.createHostBuffer(queuedFrameNum * FRAME_CONSTANTS_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = device.createDescriptorPool(queuedFrameNum, 0, 2 * queuedFrameNum, 0, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const descriptorSet = descriptorPool.allocateDescriptorSet(layout, 0, 0);
                const cameraView = constantBuffer.createConstantView(i * FRAME_CONSTANTS_STRIDE, CONSTANT_VIEW_SIZE);
                const colorView = constantBuffer.createConstantView(i * FRAME_CONSTANTS_STRIDE + CONSTANT_VIEW_SIZE, CONSTANT_VIEW_SIZE);
                this.queuedFrames.push(new QueuedFrame(descriptorSet,
                    cameraView, colorView));
                if (!descriptorSet || !cameraView || !colorView) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                descriptorSet.updateDescriptor(0, 0, cameraView);
                descriptorSet.updateDescriptor(0, 1, colorView);
            }

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

        // What makes a face's pipeline differ: the blend state and the face's write mask.
        pipelineKey(face: FacePreferences) {
            const blend = this.blendEnable ? 1 : 0;
            return `${blend} ${this.colorOperator} ${this.srcColorBlendFactor} ${this.dstColorBlendFactor} `
                + `${this.alphaOperator} ${this.srcAlphaBlendFactor} ${this.dstAlphaBlendFactor} ${colorMask(face.colorBitEnabled)}`;
        }

        // The sample's pipeline with a face's dynamic state: depth test (greater: reversed) and
        // write, no culling, the blend state, the face's color write mask. Null if it can't be made.
        facePipeline(face: FacePreferences): NriPipeline | null {
            const device = this.device;
            const layout = this.layout;
            if (!device || !layout) {
                return null;
            }
            const key = this.pipelineKey(face);
            for (const keyed of this.pipelines) {
                if (keyed.key == key) {
                    return new NriPipeline(keyed.pipeline.handle);
                }
            }
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${this.shaders}_main_vs.bin`, "main_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${this.shaders}_main_ps.bin`, "main_ps") != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, 12);
            desc.setFrontCounterClockwise(1);
            desc.setColor(this.viewFormat, colorMask(face.colorBitEnabled));
            if (this.blendEnable) {
                desc.setBlend(
                    BLEND_FACTORS[this.srcColorBlendFactor], BLEND_FACTORS[this.dstColorBlendFactor], BLEND_OPS[this.colorOperator],
                    ALPHA_BLEND_FACTORS[this.srcAlphaBlendFactor], ALPHA_BLEND_FACTORS[this.dstAlphaBlendFactor],
                    BLEND_OPS[this.alphaOperator]);
            }
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return this.keep(key, pipeline);
        }

        // Keeps the pipeline made for key (if made).
        keep(key: string, pipeline: NriPipeline | null): NriPipeline | null {
            if (!pipeline) {
                return null;
            }
            // A wrapper of its own (destroying nothing) for the caller: the list keeps the pipeline.
            const result = new NriPipeline(pipeline.handle);
            this.pipelines.push(new KeyedPipeline(key, pipeline));
            return result;
        }

        // Keep a handful of pipelines: drop them all now and then (once the GPU is done with them).
        trimPipelines() {
            const device = this.device;
            if (!device || this.pipelines.length <= MAX_PIPELINES) {
                return;
            }
            device.waitIdle();
            for (const keyed of this.pipelines) {
                keyed.pipeline.destroy();
            }
            this.pipelines = [];
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The camera's mouse handling, unless the options window has the mouse: the buttons'
        // changes, then the move.
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
            this.mouseX += this.sample.getMouseDeltaX();
            this.mouseY += this.sample.getMouseDeltaY();
            this.camera.mouseMove(this.mouseX, this.mouseY);
        }

        // A color editor (as the sample's, 200 pixels wide).
        colorEdit(id: int, caption: string, colors: f32[], first: int) {
            NriImgui.pushID(id);
            NriImgui.colorEdit4(caption, Ref(colors[first]), 200.0);
            NriImgui.popID();
        }

        // A "Next" button, then a combo of names; the new index.
        comboWithButton(id: int, caption: string, index: int, names: string[]) {
            let result = index;
            NriImgui.pushID(id);
            if (NriImgui.button("Next") != 0) {
                result = (result + 1) % names.length;
            }
            NriImgui.popID();
            NriImgui.sameLine();
            return NriImgui.combo(caption, result, comboItems(names));
        }

        // The sample's random colors (alpha kept).
        randomize(colors: f32[]) {
            for (let corner = 0; corner < 4; corner++) {
                for (let i = 0; i < 3; i++) {
                    colors[corner * 4 + i] = Math.random();
                }
            }
        }

        // The sample's options.
        buildUI() {
            this.sample.imguiNewFrame();
            let id = 0;
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Options", 1);

            id++;
            this.colorEdit(id, "Background", this.clearColor, 0);

            // (The sample titles both headers "Second face", which ImGui then opens and closes
            // together.)
            for (let f = 0; f < 2; f++) {
                const face = this.faces[f];
                if (NriImgui.collapsingHeader(f == 0 ? "First face" : "Second face", 1) != 0) {
                    const corners = ["Top left", "Top right", "Bottom left", "Bottom right"];
                    for (let c = 0; c < 4; c++) {
                        id++;
                        this.colorEdit(id, corners[c], face.colors, c * 4);
                    }
                    id++;
                    NriImgui.pushID(id);
                    if (NriImgui.button("Random") != 0) {
                        this.randomize(face.colors);
                    }
                    NriImgui.popID();

                    NriImgui.text("Color write mask");
                    const channels = ["Red", "Green", "Blue", "Alpha"];
                    for (let c = 0; c < 4; c++) {
                        id++;
                        NriImgui.pushID(id);
                        face.colorBitEnabled[c] = NriImgui.checkbox(channels[c], face.colorBitEnabled[c] ? 1 : 0) != 0;
                        NriImgui.popID();
                        if (c < 3) {
                            NriImgui.sameLine();
                        }
                    }
                } else {
                    id += 9;
                }
            }

            if (NriImgui.collapsingHeader("Blending", 1) != 0) {
                this.blendEnable = NriImgui.checkbox("Enabled", this.blendEnable ? 1 : 0) != 0;
                if (NriImgui.collapsingHeader("BlendEquationEXT", 1) != 0) {
                    this.colorOperator = this.comboWithButton(++id, "Color operator", this.colorOperator, BLEND_OP_NAMES);
                    this.srcColorBlendFactor = this.comboWithButton(++id, "SrcColorBlendFactor", this.srcColorBlendFactor, BLEND_FACTOR_NAMES);
                    this.dstColorBlendFactor = this.comboWithButton(++id, "DstColorBlendFactor", this.dstColorBlendFactor, BLEND_FACTOR_NAMES);
                    this.alphaOperator = this.comboWithButton(++id, "Alpha operator", this.alphaOperator, BLEND_OP_NAMES);
                    this.srcAlphaBlendFactor = this.comboWithButton(++id, "SrcAlphaBlendFactor", this.srcAlphaBlendFactor, BLEND_FACTOR_NAMES);
                    this.dstAlphaBlendFactor = this.comboWithButton(++id, "DstAlphaBlendFactor", this.dstAlphaBlendFactor, BLEND_FACTOR_NAMES);
                }
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The sample's update_uniform_buffers: projection * view * model (identity), into Donut's
        // clip space (y negated); and its update_color; into the queued frame's copies.
        writeConstants(queuedFrameIndex: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            const view = this.camera.view();
            const viewProj = multiply(perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR), view);
            for (let i = 0; i < 16; i++) {
                this.cameraConstants[i] = i % 4 == 1 ? -viewProj[i] : viewProj[i];
            }
            for (let face = 0; face < 2; face++) {
                for (let i = 0; i < 16; i++) {
                    this.colorConstants[face * 16 + i] = this.faces[face].colors[i];
                }
            }
            const offset = queuedFrameIndex * FRAME_CONSTANTS_STRIDE;
            constantBuffer.write(offset, Ref(this.cameraConstants[0]), 16 * 4);
            constantBuffer.write(offset + CONSTANT_VIEW_SIZE, Ref(this.colorConstants[0]), COLOR_FLOATS * 4);
        }

        // Which face is drawn first, as the sample decides it: the vertices 0 (on the z = 1 face) and
        // 4 (on the z = -1 one) through the inverse of the view, the one with the smaller z last.
        reversed() {
            const inverseView = inverseRigid(this.camera.view());
            const z0 = inverseView[2] * VERTICES[0] + inverseView[6] * VERTICES[1] + inverseView[10] * VERTICES[2] + inverseView[14];
            const z4 = inverseView[2] * VERTICES[20] + inverseView[6] * VERTICES[21] + inverseView[10] * VERTICES[22] + inverseView[14];
            return z0 < z4;
        }

        // The two faces (between NriCommandBuffer.beginRenderingWithDepth and NriCommandBuffer.endRendering).
        recordDraw(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = queuedFrame.descriptorSet;
            const vertexBuffer = this.vertexBuffer;
            const indexBuffer = this.indexBuffer;
            if (!layout || !descriptorPool || !descriptorSet || !vertexBuffer || !indexBuffer) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setDescriptorSet(0, descriptorSet);
            commandBuffer.setVertexBuffer(0, vertexBuffer, 0, VERTEX_SIZE);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
            // The sample's blend constants (zeros).
            commandBuffer.setBlendConstants(0.0, 0.0, 0.0, 0.0);
            const reverse = this.reversed();
            for (let i = 0; i < 2; i++) {
                const face = this.faces[reverse ? 1 - i : i];
                const pipeline = this.facePipeline(face);
                if (pipeline) {
                    commandBuffer.setPipeline(pipeline);
                    commandBuffer.drawIndexed(FACE_INDEX_COUNT, 1, face.indexOffset, 0, 0);
                }
            }
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The D32 depth buffer at the swap chain's size; false on failure.
        createDepth(device: NriDevice): boolean {
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                return false;
            }
            this.depthAttachment = depthTexture.createDepthAttachmentView(NriFormat.D32_SFLOAT);
            return true;
        }

        destroyDepth() {
            const depthAttachment = this.depthAttachment;
            if (depthAttachment) {
                depthAttachment.destroy();
            }
            this.depthAttachment = null;
            const depthTexture = this.depthTexture;
            if (depthTexture) {
                depthTexture.destroy();
            }
            this.depthTexture = null;
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain and the depth buffer made again at its size, once the
        // GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            device.waitIdle();
            this.destroyDepth();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.createDepth(device);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();
            this.trimPipelines();
            this.writeConstants(queuedFrameIndex);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the background color, depth cleared to 0, the faces; then the options
                // window over them.
                commandBuffer.begin();
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
                    commandBuffer.clearColor(this.clearColor[0], this.clearColor[1], this.clearColor[2], this.clearColor[3]);
                    commandBuffer.clearDepth(0.0);
                    this.recordDraw(commandBuffer, queuedFrame);
                    commandBuffer.endRendering();
                }
                // (A pass of its own: the UI's pipeline has no depth attachment.)
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                    commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                    this.sample.drawImgui(commandBuffer, this.viewFormat);
                    commandBuffer.endRendering();
                }

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
                for (const queuedFrame of this.queuedFrames) {
                    this.destroyDescriptor(queuedFrame.cameraView);
                    this.destroyDescriptor(queuedFrame.colorView);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroyDepth();
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                for (const keyed of this.pipelines) {
                    keyed.pipeline.destroy();
                }
                const layout = this.layout;
                if (layout) {
                    layout.destroy();
                }
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }

        destroyDescriptor(descriptor: NriDescriptor | null) {
            if (descriptor) {
                descriptor.destroy();
            }
        }

        destroyBuffer(buffer: NriBuffer | null) {
            if (buffer) {
                buffer.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const blending = new DynamicBlending(sample);
        // -noblend: blending off; -advanced <n>: the Donut example's advanced blend operation, which
        // NRI doesn't have (said so, then ignored); -noUI: no options window.
        sample.addExampleOption("-noblend");
        sample.addExampleOptionWithValues("-advanced", 1);
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-noblend") {
                blending.blendEnable = false;
            } else if (arg == "-advanced" && i + 1 < argc) {
                console.log("No advanced blend operations (NRI has no VK_EXT_blend_operation_advanced)");
                i++;
            } else if (arg == "-noUI") {
                blending.noUI = true;
            }
        }
        return blending.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return DynamicBlendingNri.main(argc, argv);
}

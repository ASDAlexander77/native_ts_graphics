/// <reference path="../../core/nri/nri_interop.d.ts" />
import { formatFixed } from "../../core/text_format";

namespace SimpleHdrNri {
    // simple_hdr, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut
    // and NVRHI: the same shaders (simple_hdr_scene.hlsl's and simple_hdr_convert.hlsl's), through the
    // NRI calls core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui drawing the sample's text
    // into the HDR scene as Donut's does. This example creates everything it runs, and does the
    // rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Simple HDR";
    const FONT_PATH = "media/fonts/DroidSans/DroidSans-Mono.ttf";

    // The sample's layout: the 1920x1080 screen its sprites and text are placed on.
    const LAYOUT_WIDTH = 1920.0;
    const LAYOUT_HEIGHT = 1080.0;

    // HDRCommon.h: the ST.2084 spec defines max nits as 10,000 nits.
    const MAX_NITS_FOR_2084 = 10000.0;

    // The sample's HDR scene values: the fourth is the one Up / Down change.
    const NUM_INPUT_VALUES = 4;
    const CUSTOM_INPUT_VALUE_INDEX = 3;

    // Its steps: Up / Down (Shift: slowly) change the custom value or the curve's nits by these each
    // frame, here each 1/60 s.
    const FAST_NITS_DELTA = 25.0;
    const SLOW_NITS_DELTA = 1.0;
    const FAST_SCENE_VALUE_DELTA = 0.05;
    const SLOW_SCENE_VALUE_DELTA = 0.005;
    const STEPS_PER_SECOND = 60.0;

    // The sample's Courier_36 font at the scales it draws with (1, 0.75, 0.65, 0.4, 1.75): here
    // DroidSans Mono, as wide, in layout pixels (as the Donut example sizes it).
    const FONT_LAYOUT_SIZE = 57.6;
    const FONT_SCALES = [1.0, 0.75, 0.65, 0.4, 1.75];
    enum FontKind {
        Title = 0,
        Text = 1,
        Help = 2,
        Small = 3,
        Countdown = 4
    }

    // DrawConstants of simple_hdr_scene.hlsl: rect, color, the pixels-to-clip-space scale and offset
    // (push constants, b0).
    const DRAW_CONSTANTS_FLOATS = 12;
    // The curve's lines (outline, ticks, graph, selection) for target heights up to 4320 pixels.
    const MAX_LINE_VERTICES = 16384;

    // GLFW's key codes (Donut's Key) of the sample's controls.
    const KEY_SPACE = 32;
    const KEY_MINUS = 45;
    const KEY_EQUAL = 61;
    const KEY_ENTER = 257;
    const KEY_RIGHT = 262;
    const KEY_LEFT = 263;
    const KEY_DOWN = 264;
    const KEY_UP = 265;
    const KEY_KP_SUBTRACT = 333;
    const KEY_KP_ADD = 334;
    const KEY_KP_ENTER = 335;
    const KEY_LEFT_SHIFT = 340;
    const KEY_RIGHT_SHIFT = 344;
    // The keys that act when pressed (Donut's Action.Press), watched for their presses.
    const PRESS_KEYS = [KEY_SPACE, KEY_ENTER, KEY_KP_ENTER, KEY_MINUS, KEY_KP_SUBTRACT, KEY_EQUAL, KEY_KP_ADD];

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // HDRCommon.h (float arithmetic as the sample's): the ST.2084 curve of a normalized linear
    // value (1.0 = 10,000 nits).
    function linearToST2084(normalizedLinearValue: number) {
        const p = Math.fround(Math.pow(Math.abs(normalizedLinearValue), Math.fround(0.1593017578)));
        const numerator = Math.fround(Math.fround(0.8359375) + Math.fround(Math.fround(18.8515625) * p));
        const denominator = Math.fround(1.0 + Math.fround(Math.fround(18.6875) * p));
        return Math.fround(Math.pow(Math.fround(numerator / denominator), Math.fround(78.84375)));
    }

    // The same of an HDR scene value (1.0 = paper white).
    function sceneValueToST2084(hdrSceneValue: number, paperWhiteNits: number) {
        return linearToST2084(Math.fround(Math.fround(hdrSceneValue * paperWhiteNits) / MAX_NITS_FOR_2084));
    }

    // The brightness of an HDR scene value, in nits.
    function calcNits(hdrSceneValue: number, paperWhiteNits: number) {
        return Math.fround(Math.fround(Math.fround(hdrSceneValue * paperWhiteNits) / MAX_NITS_FOR_2084) * MAX_NITS_FOR_2084);
    }

    // The sample's LinearToSRGB: the sRGB curve of a value clamped to [0, 1] (for the UI).
    function linearToSRGB(hdrSceneValue: number) {
        const value = Math.min(Math.max(hdrSceneValue, 0.0), 1.0);
        if (value < 0.0031308) {
            return Math.fround(value * 12.92);
        }
        return Math.fround(Math.fround(1.055) * Math.fround(Math.pow(value, Math.fround(1.0 / 2.4))) - Math.fround(0.055));
    }

    // What a frame in flight records into, and its copy of the curve's lines (a host buffer the
    // vertex shader reads, in its own descriptor set).
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public lineBuffer: NriBufferHandle | null, public lineView: NriDescriptorHandle | null,
            public sceneSet: NriDescriptorSetHandle | null) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // The checks of Donut's TestCheck over pixels read back (0xAABBGGRR).
    class FramePixels {
        constructor(public pixels: int[], public width: int, public height: int) {
        }

        rgb(x: int, y: int) {
            return this.pixels[y * this.width + x] & 0xFFFFFF;
        }

        corners(rgb: int) {
            const xs = [0, this.width - 1, 0, this.width - 1];
            const ys = [0, 0, this.height - 1, this.height - 1];
            for (let k = 0; k < 4; k++) {
                const p = this.rgb(xs[k], ys[k]);
                if (p != rgb) {
                    return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not ${rgb & 0xFF}, ${(rgb >> 8) & 0xFF}, ${(rgb >> 16) & 0xFF}`;
                }
            }
            return "";
        }

        countOtherThan(rgb: int) {
            let count = 0;
            for (let i = 0; i < this.width * this.height; i++) {
                if ((this.pixels[i] & 0xFFFFFF) != rgb) {
                    count++;
                }
            }
            return count;
        }

        countInRange(rMin: int, rMax: int, gMin: int, gMax: int, bMin: int, bMax: int) {
            let count = 0;
            for (let i = 0; i < this.width * this.height; i++) {
                const p = this.pixels[i];
                const r = p & 0xFF;
                const g = (p >> 8) & 0xFF;
                const b = (p >> 16) & 0xFF;
                if (r >= rMin && r <= rMax && g >= gMin && g <= gMax && b >= bMin && b <= bMax) {
                    count++;
                }
            }
            return count;
        }

        share(count: int, min: number, max: number, what: string) {
            const total = this.width * this.height;
            const percent = 100.0 * count / total;
            console.log(`${what}: ${percent}% (${count} of ${total} pixels)`);
            if (percent < min || percent > max) {
                return `${what}: ${percent}% of the pixels, not ${min}% to ${max}%`;
            }
            return "";
        }
    }

    // -test: checks the last frame, read back (R10G10B10A2 back buffers, SDR), as the Donut example
    // does. The corners are black; the paper white block in the middle is white, about 5% of the
    // frame, the text and it about 7%.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const check = new FramePixels(pixels, width, height);
        const corners = check.corners(0x000000);
        if (corners != "") {
            return corners;
        }
        if (check.rgb(Math.floor(width / 2), Math.floor(height / 2)) != 0xFFFFFF) {
            return "the paper white block isn't white";
        }
        const white = check.share(check.countInRange(221, 255, 221, 255, 221, 255), 3.5, 7.0, "White");
        if (white != "") {
            return white;
        }
        return check.share(check.countOtherThan(0x000000), 5.0, 10.0, "Text and block");
    }

    // Port of the Xbox ATG SimpleHDR_PC12 sample (as examples/simple_hdr.ts ports it) to NRI: an HDR
    // scene (linear, Rec.709 primaries, 1.0 = paper white) of blocks brighter than white, or the
    // ST.2084 curve, sent to an HDR10 swap chain (Rec.2020, ST.2084, 10 bits) when the display is in
    // HDR mode, clipped to SDR in a 10-bit one otherwise; paper white's brightness adjustable, bright
    // blocks shown after a 5 second countdown so that eyes take white as white first.
    //
    // A frame: the blocks or the curve into the RGBA16F HDR scene, its text (ImGui, at 1.0 = paper
    // white) into it too, then PrepareSwapChainBuffer into the swap chain texture. The display's mode
    // is checked every second (the swap chain made again when it changes).
    class SimpleHdr {
        private device: NriDeviceHandle | null = null;
        private graphicsAPI: NriGraphicsAPI = NriGraphicsAPI.None;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle | null = null;
        private swapChainTextures: SwapChainTexture[] = [];
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private hdr10: boolean = false;
        private queuedFrames: QueuedFrame[] = [];
        private sceneLayout: NriPipelineLayoutHandle | null = null;
        private convertLayout: NriPipelineLayoutHandle | null = null;
        private rectPipeline: NriPipelineHandle | null = null;
        private linePipeline: NriPipelineHandle | null = null;
        private hdr10Pipeline: NriPipelineHandle | null = null;
        private sdrPipeline: NriPipelineHandle | null = null;
        private hdrScene: NriTextureHandle | null = null;
        private hdrSceneAttachment: NriDescriptorHandle | null = null;
        private hdrSceneView: NriDescriptorHandle | null = null;
        private pointSampler: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private convertSet: NriDescriptorSetHandle | null = null;
        private imgui: boolean = false;
        private fonts: NriImguiFontHandle[] = [];
        private width: int = 0;
        private height: int = 0;
        private apiName: string = "";

        // Upload buffers.
        private lineVertices: f32[] = [];
        private drawConstants: f32[] = [];
        private convertConstants: f32[] = [0.0, 0.0, 0.0, 0.0];

        // The sample's state.
        render2084Curve: boolean = false;
        showOnlyPaperWhite: boolean = true;
        countDownToBright: number = 5.0;
        current2084CurveRenderingNits: number = 500.0;
        hdrSceneValues: number[] = [0.5, 1.0, 6.0, 10.0];
        paperWhiteNits: number = 100.0;
        private colorSpaceCheck: number = 0.0;
        // -sdr: the SDR signal even on an HDR display.
        forceSdr: boolean = false;
        // The keys of PRESS_KEYS down last frame (1), or not (0).
        private keysDown: int[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < MAX_LINE_VERTICES * 2; i++) {
                this.lineVertices.push(0.0);
            }
            for (let i = 0; i < DRAW_CONSTANTS_FLOATS; i++) {
                this.drawConstants.push(0.0);
            }
            for (let i = 0; i < PRESS_KEYS.length; i++) {
                this.keysDown.push(0);
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
            this.graphicsAPI = graphicsAPI;
            console.log(`Renderer: ${Nri_GetGraphicsAPIString(graphicsAPI)} (${Nri_GetAdapterName(device)})`);
            this.apiName = graphicsAPI == NriGraphicsAPI.D3D11 ? "DirectX 11" : graphicsAPI == NriGraphicsAPI.D3D12 ? "DirectX 12" : "Vulkan";

            this.queue = Nri_GetGraphicsQueue(device);
            this.frameFence = Nri_CreateFence(device, 0);
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.test = Nri_IsTest(this.sample) != 0;
            // Donut's -test runs without a window, so its display is never in HDR mode: SDR, as there.
            if (this.test) {
                this.forceSdr = true;
            }

            // The swap chain: 10-bit (R10G10B10A2, as Donut's AppOptions.HdrBackBuffer), sRGB's color
            // space, or HDR10 when the display is in HDR mode (DeviceResources::UpdateColorSpace).
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
            console.log(`Display in HDR mode: ${this.hdr10 ? "yes" : "no"}`);

            if (!this.createHdrScene(device)) {
                console.log("Cannot create the HDR scene");
                return 0;
            }
            this.pointSampler = Nri_CreateSampler(device, NriFilter.Nearest, NriAddressMode.ClampToEdge, 1);

            // The layouts: the scene's DrawConstants (push constants, b0) and lines (t0); the
            // conversion's HDR10Data (push constants, b0), the HDR scene (t0) and its sampler (s0).
            const sceneLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(sceneLayoutDesc, 0, DRAW_CONSTANTS_FLOATS * 4, NriStage.VertexPixel);
            Nri_PipelineLayoutDescAddRange(sceneLayoutDesc, 0, 0, 1, NriDescriptorType.StructuredBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            this.sceneLayout = Nri_CreatePipelineLayoutFromDesc(device, sceneLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(sceneLayoutDesc);
            const convertLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(convertLayoutDesc, 0, 16, NriStage.VertexPixel);
            Nri_PipelineLayoutDescAddRange(convertLayoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(convertLayoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.VertexPixel, NriRangeFlags.None);
            this.convertLayout = Nri_CreatePipelineLayoutFromDesc(device, convertLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(convertLayoutDesc);
            const sceneLayout = this.sceneLayout;
            const convertLayout = this.convertLayout;
            if (!sceneLayout || !convertLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: the shaders as compiled for the Donut example; no culling, no depth.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const scene = `shaders/simple_hdr/${folder}/simple_hdr_scene`;
            const convert = `shaders/simple_hdr/${folder}/simple_hdr_convert`;
            this.rectPipeline = this.createPipeline(sceneLayout, `${scene}_rect_vs.bin`, "rect_vs", `${scene}_color_ps.bin`, "color_ps",
                NriFormat.RGBA16_SFLOAT, NriTopology.TriangleList);
            // The sample's lines are aliased (MultisampleEnable FALSE): NRI's default lines.
            this.linePipeline = this.createPipeline(sceneLayout, `${scene}_line_vs.bin`, "line_vs", `${scene}_color_ps.bin`, "color_ps",
                NriFormat.RGBA16_SFLOAT, NriTopology.LineList);
            this.hdr10Pipeline = this.createPipeline(convertLayout, `${convert}_quad_vs.bin`, "quad_vs", `${convert}_prepare_hdr10_ps.bin`,
                "prepare_hdr10_ps", this.swapChainFormat, NriTopology.TriangleList);
            this.sdrPipeline = this.createPipeline(convertLayout, `${convert}_quad_vs.bin`, "quad_vs", `${convert}_tonemap_sdr_ps.bin`,
                "tonemap_sdr_ps", this.swapChainFormat, NriTopology.TriangleList);
            if (!this.rectPipeline || !this.linePipeline || !this.hdr10Pipeline || !this.sdrPipeline) {
                console.log("Cannot load the simple HDR shaders");
                return 0;
            }

            // A queued frame's lines and their set each, and the conversion's set.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            const descriptorPool = Nri_CreateDescriptorPoolWithBuffers(device, queuedFrameNum + 1, 1, 0, 1, 0, queuedFrameNum, 0, 0);
            this.descriptorPool = descriptorPool;
            const hdrSceneView = this.hdrSceneView;
            const pointSampler = this.pointSampler;
            if (!descriptorPool || !hdrSceneView || !pointSampler) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const lineBuffer = Nri_CreateHostBufferWithStride(device, MAX_LINE_VERTICES * 8, NriBufferUsage.StructuredBuffer, 8);
                let lineView: NriDescriptorHandle | null = null;
                if (lineBuffer) {
                    lineView = Nri_CreateStructuredBufferView(lineBuffer, 0);
                }
                const sceneSet = Nri_AllocateDescriptorSet(descriptorPool, sceneLayout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), lineBuffer, lineView, sceneSet));
                if (!lineView || !sceneSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(sceneSet, 0, 0, lineView);
            }
            const convertSet = Nri_AllocateDescriptorSet(descriptorPool, convertLayout, 0, 0);
            this.convertSet = convertSet;
            if (!convertSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            Nri_UpdateDescriptor(convertSet, 0, 0, hdrSceneView);
            Nri_UpdateDescriptor(convertSet, 1, 0, pointSampler);

            // The text, in the sample's font at its scales (at the starting height: text draws them at
            // the current height's sizes, Nri_ImguiPushFontSized).
            if (Nri_InitImgui(this.sample, device) == 0) {
                console.log("Cannot initialize the user interface");
                return 0;
            }
            this.imgui = true;
            for (const fontScale of FONT_SCALES) {
                const font = Nri_ImguiCreateFont(FONT_PATH, FONT_LAYOUT_SIZE * fontScale * this.height / LAYOUT_HEIGHT);
                if (!font) {
                    console.log("Cannot load the font: set DONUT_SAMPLES_MEDIA_DIR when configuring");
                    return 0;
                }
                this.fonts.push(font as NriImguiFontHandle);
            }

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
            }
            return 1;
        }

        createPipeline(layout: NriPipelineLayoutHandle, vsPath: string, vsEntry: string, psPath: string, psEntry: string,
            format: NriFormat, topology: NriTopology): NriPipelineHandle | null {
            const device = this.device;
            if (!device) {
                return null;
            }
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, vsPath, vsEntry) != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, psPath, psEntry) != 0;
            }
            Nri_PipelineDescSetTopology(desc, topology);
            Nri_PipelineDescSetColor(desc, format, NriColorWrite.RGBA);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // The HDR scene: RGBA16F, at the stored (window's) size; the conversion's set (once made) reads
        // the new one. False on failure.
        createHdrScene(device: NriDeviceHandle): boolean {
            const hdrScene = Nri_CreateRenderTargetTexture(device, this.queue, this.width, this.height, NriFormat.RGBA16_SFLOAT);
            this.hdrScene = hdrScene;
            if (!hdrScene) {
                return false;
            }
            this.hdrSceneAttachment = Nri_CreateColorAttachmentView(hdrScene, NriFormat.RGBA16_SFLOAT);
            const hdrSceneView = Nri_CreateTextureView(hdrScene, NriFormat.RGBA16_SFLOAT);
            this.hdrSceneView = hdrSceneView;
            const convertSet = this.convertSet;
            if (convertSet) {
                Nri_UpdateDescriptor(convertSet, 0, 0, hdrSceneView);
            }
            return true;
        }

        destroyHdrScene() {
            this.destroyDescriptor(this.hdrSceneAttachment);
            this.destroyDescriptor(this.hdrSceneView);
            const hdrScene = this.hdrScene;
            if (hdrScene) {
                Nri_DestroyTexture(hdrScene);
            }
            this.hdrSceneAttachment = null;
            this.hdrSceneView = null;
            this.hdrScene = null;
        }

        // The window was resized (Nri_UseResizableWindow): the swap chain (in its color space as
        // before) and the HDR scene again at its size, once the GPU is done with the old ones.
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
            this.destroyHdrScene();
            this.createHdrScene(device);
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

        // DeviceResources::UpdateColorSpace: HDR10 when the window's display is in HDR mode (the
        // swap chain made again, as Donut's color space change resizes it), sRGB otherwise.
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

        // The sample's keys: Space toggles the curve, Enter the paper white block alone, + / - change
        // paper white; Up / Down (Shift: slowly), held, the custom value or the curve's nits.
        handleKeys(elapsedSeconds: number) {
            for (let i = 0; i < PRESS_KEYS.length; i++) {
                const key = PRESS_KEYS[i];
                const down = Nri_IsKeyPressed(this.sample, key) != 0;
                if (down && this.keysDown[i] == 0) {
                    if (key == KEY_SPACE) {
                        this.render2084Curve = !this.render2084Curve;
                    } else if (key == KEY_ENTER || key == KEY_KP_ENTER) {
                        this.showOnlyPaperWhite = !this.showOnlyPaperWhite;
                    } else if (key == KEY_MINUS || key == KEY_KP_SUBTRACT) {
                        this.paperWhiteNits = Math.max(this.paperWhiteNits - 20.0, 80.0);
                    } else {
                        this.paperWhiteNits = Math.min(this.paperWhiteNits + 20.0, MAX_NITS_FOR_2084);
                    }
                }
                this.keysDown[i] = down ? 1 : 0;
            }
            const upHeld = Nri_IsKeyPressed(this.sample, KEY_UP) != 0 || Nri_IsKeyPressed(this.sample, KEY_RIGHT) != 0;
            const downHeld = Nri_IsKeyPressed(this.sample, KEY_DOWN) != 0 || Nri_IsKeyPressed(this.sample, KEY_LEFT) != 0;
            const shiftHeld = Nri_IsKeyPressed(this.sample, KEY_LEFT_SHIFT) != 0 || Nri_IsKeyPressed(this.sample, KEY_RIGHT_SHIFT) != 0;
            const steps = elapsedSeconds * STEPS_PER_SECOND;
            const sign = upHeld ? 1.0 : downHeld ? -1.0 : 0.0;
            if (sign != 0.0) {
                if (this.render2084Curve) {
                    const delta = (shiftHeld ? SLOW_NITS_DELTA : FAST_NITS_DELTA) * steps;
                    this.current2084CurveRenderingNits = Math.min(Math.max(this.current2084CurveRenderingNits + sign * delta, 0.0),
                        MAX_NITS_FOR_2084);
                } else {
                    const delta = (shiftHeld ? SLOW_SCENE_VALUE_DELTA : FAST_SCENE_VALUE_DELTA) * steps;
                    this.hdrSceneValues[CUSTOM_INPUT_VALUE_INDEX] = Math.min(Math.max(
                        this.hdrSceneValues[CUSTOM_INPUT_VALUE_INDEX] + sign * delta, 0.0), 125.0);
                }
            }
        }

        // The sample's Update: the countdown, the keys, and the display's mode.
        update(elapsedSeconds: number) {
            if (this.countDownToBright >= 0.0) {
                this.countDownToBright -= elapsedSeconds;
                if (this.countDownToBright < 0.0) {
                    this.showOnlyPaperWhite = false;
                }
            }
            this.handleKeys(elapsedSeconds);
            this.colorSpaceCheck -= elapsedSeconds;
            if (this.colorSpaceCheck <= 0.0) {
                this.updateColorSpace();
                this.colorSpaceCheck = 1.0;
            }
        }

        // --- The text (the sample's SpriteFont: white, so 1.0 in the HDR scene, paper white) ---

        // Text at the sample's layout position, in one of its font scales; right-aligned at x if
        // alignRight (where the sample's text is rotated by -90 degrees).
        text(font: FontKind, x: number, y: number, text: string, alignRight: boolean) {
            Nri_ImguiPushFontSized(this.fonts[font], FONT_LAYOUT_SIZE * FONT_SCALES[font] * this.height / LAYOUT_HEIGHT);
            Nri_ImguiDrawText(x * this.width / LAYOUT_WIDTH, y * this.height / LAYOUT_HEIGHT, text, 1.0, 1.0, 1.0, 1.0, alignRight ? 1 : 0);
            Nri_ImguiPopFont();
        }

        // RenderHDRScene's text: the values of each block, in the HDR scene, SDR and HDR10.
        hdrSceneText() {
            const step = Math.floor(LAYOUT_WIDTH / (NUM_INPUT_VALUES + 2.0));
            const startY = 40.0;
            const startX = 50.0;
            let y = startY + 270.0;
            this.text(FontKind.Text, startX, y, "HDR Scene Values", false);
            this.text(FontKind.Text, startX, y + 40.0, "SDR sRGB Curve", false);
            this.text(FontKind.Text, startX, y + 80.0, "HDR ST.2084 Curve", false);
            this.text(FontKind.Text, startX, y + 120.0, "HDR Nits Output", false);

            let x = startX + 100.0;
            for (let i = 0; i < NUM_INPUT_VALUES; i++) {
                const hdrSceneValue = this.hdrSceneValues[i];
                x += step;
                this.text(FontKind.Text, x, y, formatFixed(hdrSceneValue, 6), false);
                this.text(FontKind.Text, x, y + 40.0, formatFixed(linearToSRGB(hdrSceneValue), 6), false);
                this.text(FontKind.Text, x, y + 80.0, formatFixed(sceneValueToST2084(hdrSceneValue, this.paperWhiteNits), 6), false);
                this.text(FontKind.Text, x, y + 120.0, formatFixed(calcNits(hdrSceneValue, this.paperWhiteNits), 6), false);
            }

            y = startY + 700.0;
            x = startX + 100.0 + step + step - 15.0;
            this.text(FontKind.Text, x, y, "Paper White", false);
            if (!this.showOnlyPaperWhite) {
                this.text(FontKind.Text, x + step + 45.0, y, "Bright", false);
            }
        }

        // Render2084Curve's text: the axes' ends and the selected brightness.
        curveText() {
            const startX = 150.0;
            const startY = 250.0;
            const viewportWidth = 1675.0;
            const viewportHeight = 600.0;
            let y = startY + viewportHeight + 5.0;
            this.text(FontKind.Small, startX - 100.0, y, "Linear", false);
            this.text(FontKind.Small, startX - 100.0, y + 20.0, "Nits", false);
            this.text(FontKind.Small, startX - 100.0, y + 40.0, "HDR Scene", false);

            this.text(FontKind.Small, startX + viewportWidth - 5.0, y, "1.0", false);      // Always [0..1]
            this.text(FontKind.Small, startX + viewportWidth - 5.0, y + 20.0, "10K", false);  // Spec defines 10K nits
            // Max HDR scene value changes as white paper nits change
            this.text(FontKind.Small, startX + viewportWidth - 5.0, y + 40.0, formatFixed(MAX_NITS_FOR_2084 / this.paperWhiteNits, 0), false);

            const normalizedLinearValue = Math.fround(this.current2084CurveRenderingNits / MAX_NITS_FOR_2084);
            const normalizedNonLinearValue = linearToST2084(normalizedLinearValue);
            const hdrSceneValue = this.current2084CurveRenderingNits / this.paperWhiteNits;
            const x = normalizedLinearValue * viewportWidth + 1.0;
            const curveY = viewportHeight - normalizedNonLinearValue * viewportHeight;
            this.text(FontKind.Small, startX + x, y, formatFixed(normalizedLinearValue, 2), false);
            this.text(FontKind.Small, startX + x, y + 20.0, formatFixed(this.current2084CurveRenderingNits, 0), false);
            this.text(FontKind.Small, startX + x, y + 40.0, formatFixed(hdrSceneValue, 2), false);

            // The sample's vertical labels (rotated by -90 degrees), here horizontal, right-aligned
            // left of the curve.
            this.text(FontKind.Small, startX - 5.0, startY - 50.0, "ST.2084", true);
            this.text(FontKind.Small, startX - 5.0, startY - 30.0, "Nits", true);
            this.text(FontKind.Small, startX - 5.0, curveY + startY - 20.0, formatFixed(normalizedNonLinearValue, 2), true);
            this.text(FontKind.Small, startX - 5.0, curveY + startY, formatFixed(this.current2084CurveRenderingNits, 0), true);

            // Text for blocks
            const size = 150.0;
            this.text(FontKind.Small, LAYOUT_WIDTH - size * 4.0 - 5.0, 50.0 + size / 2.0, "Paper White", true);
            y = 50.0 + size;
            this.text(FontKind.Small, LAYOUT_WIDTH - size * 4.0 + 25.0, y, `${formatFixed(this.paperWhiteNits, 0)} nits`, false);
            this.text(FontKind.Small, LAYOUT_WIDTH - size * 4.0 + 25.0 + size * 2.0, y, `${formatFixed(this.current2084CurveRenderingNits, 0)} nits`, false);
        }

        // The sample's RenderUI, with its keyboard controls.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            const startX = 50.0;
            const startY = 40.0;
            this.text(FontKind.Title, startX, startY, `SimpleHDR Sample for ${this.apiName}`, false);

            if (this.render2084Curve) {
                this.curveText();
            } else {
                this.text(FontKind.Text, startX, startY + 100.0, this.hdr10 ? "TV in HDR Mode: TRUE" : "TV in HDR Mode: FALSE", false);
                this.hdrSceneText();
            }

            this.text(FontKind.Help, startX, 955.0, "Space - Toggle displaying ST.2084 curve", false);
            this.text(FontKind.Help, startX, 990.0, "Enter - Toggle displaying only paper white block", false);
            this.text(FontKind.Help, LAYOUT_WIDTH / 2.0 + startX, 955.0, "+ / - - Adjust paper white nits", false);
            this.text(FontKind.Help, LAYOUT_WIDTH / 2.0 + startX, 990.0, "Up/Down - Adjust values quickly", false);
            this.text(FontKind.Help, LAYOUT_WIDTH / 2.0 + startX, 1025.0, "Shift + Up/Down - Adjust values slowly", false);

            if (this.countDownToBright >= 0.0) {
                this.text(FontKind.Countdown, 1170.0, 550.0, formatFixed(this.countDownToBright, 0), false);
            }
            Nri_ImguiRender(this.sample);
        }

        // --- The scene ---

        // A rectangle of the sample's layout in one color (SpriteBatch::Draw with ColorPS), the rect
        // pipeline and the scene's set bound.
        drawRect(commandBuffer: NriCommandBufferHandle, left: number, top: number, right: number, bottom: number, value: number) {
            this.drawConstants[0] = left;
            this.drawConstants[1] = top;
            this.drawConstants[2] = right;
            this.drawConstants[3] = bottom;
            this.drawConstants[4] = value;
            this.drawConstants[5] = value;
            this.drawConstants[6] = value;
            this.drawConstants[7] = 1.0;
            // SpriteBatch's viewport transform for a 1920x1080 viewport.
            this.drawConstants[8] = Math.fround(2.0 / LAYOUT_WIDTH);
            this.drawConstants[9] = Math.fround(-2.0 / LAYOUT_HEIGHT);
            this.drawConstants[10] = -1.0;
            this.drawConstants[11] = 1.0;
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.drawConstants[0]), DRAW_CONSTANTS_FLOATS * 4);
            Nri_CmdDraw(commandBuffer, 6, 1, 0, 0);
        }

        // The full window as the viewport (and scissor rectangle), the rect pipeline bound.
        bindRects(commandBuffer: NriCommandBufferHandle) {
            const rectPipeline = this.rectPipeline;
            if (!rectPipeline) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipeline(commandBuffer, rectPipeline);
        }

        // The sample's RenderHDRScene: four blocks with the HDR scene values (only the paper white
        // one at first). Its text is the UI's.
        renderHDRScene(commandBuffer: NriCommandBufferHandle) {
            this.bindRects(commandBuffer);
            const step = Math.floor(LAYOUT_WIDTH / (NUM_INPUT_VALUES + 2.0));
            let left = 115.0;
            for (let i = 0; i < NUM_INPUT_VALUES; i++) {
                left += step;
                const top = 485.0;
                const right = left + Math.floor(step / 1.25);
                const bottom = top + 250.0;
                const value = this.hdrSceneValues[i];
                if (!this.showOnlyPaperWhite || value == 1.0) {
                    this.drawRect(commandBuffer, left, top, right, bottom, value);
                }
            }
        }

        addLine(count: int, x1: number, y1: number, x2: number, y2: number) {
            this.lineVertices[count * 2] = x1;
            this.lineVertices[count * 2 + 1] = y1;
            this.lineVertices[count * 2 + 2] = x2;
            this.lineVertices[count * 2 + 3] = y2;
            return count + 2;
        }

        // The sample's Render2084Curve: the curve's outline, ticks and graph and the selected
        // brightness's lines in a viewport (lines in its pixels), then a paper white block and one
        // of the selected brightness. Its text is the UI's.
        renderST2084Curve(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const lineBuffer = queuedFrame.lineBuffer;
            const linePipeline = this.linePipeline;
            if (!lineBuffer || !linePipeline) {
                return;
            }
            const scale = Math.fround(this.height / LAYOUT_HEIGHT);
            const viewportWidth = Math.fround(1675.0 * scale);
            const viewportHeight = Math.fround(600.0 * scale);
            const startX = 150.0;
            const startY = 250.0;

            let n = 0;
            // Render the outline
            n = this.addLine(n, 0.5, 0.5, viewportWidth, 0.5);
            n = this.addLine(n, 0.5, viewportHeight, viewportWidth, viewportHeight);
            n = this.addLine(n, 0.5, 0.5, 0.5, viewportHeight);
            n = this.addLine(n, viewportWidth, 0.5, viewportWidth, viewportHeight);

            // Render horizontal tick marks
            const numSteps = 16.0;
            for (let i = 0; i < numSteps; i++) {
                const x = Math.fround(i * Math.fround(viewportWidth / numSteps)) + 0.5;
                n = this.addLine(n, x, viewportHeight, x, viewportHeight - 10.0);
            }

            // Render the graph
            for (let i = 0; i < viewportWidth && n + 6 < MAX_LINE_VERTICES; i++) {
                const x1 = i + 0.5;
                const y1 = viewportHeight - Math.fround(linearToST2084(Math.fround(i / viewportWidth)) * viewportHeight);
                const x2 = x1 + 1.0;
                const y2 = viewportHeight - Math.fround(linearToST2084(Math.fround(x2 / viewportWidth)) * viewportHeight);
                n = this.addLine(n, x1, y1, x2, y2);
            }

            // Render the lines indication the current selection
            const normalizedLinearValue = Math.fround(this.current2084CurveRenderingNits / MAX_NITS_FOR_2084);
            const normalizedNonLinearValue = linearToST2084(normalizedLinearValue);
            const x = Math.fround(normalizedLinearValue * viewportWidth);
            const y = viewportHeight - Math.fround(normalizedNonLinearValue * viewportHeight);
            n = this.addLine(n, x, viewportHeight, x, y);
            n = this.addLine(n, x, y, 0.0, y);

            Nri_WriteBuffer(lineBuffer, 0, Ref(this.lineVertices[0]), n * 8);
            this.drawConstants[4] = 1.0;
            this.drawConstants[5] = 1.0;
            this.drawConstants[6] = 1.0;
            this.drawConstants[7] = 1.0;
            // CreateOrthographicOffCenter(0, viewportWidth, viewportHeight, 0, 0, 1) as DirectXMath
            // computes it.
            const reciprocalWidth = Math.fround(1.0 / viewportWidth);
            const reciprocalHeight = Math.fround(1.0 / -viewportHeight);
            this.drawConstants[8] = Math.fround(reciprocalWidth + reciprocalWidth);
            this.drawConstants[9] = Math.fround(reciprocalHeight + reciprocalHeight);
            this.drawConstants[10] = Math.fround(-viewportWidth * reciprocalWidth);
            this.drawConstants[11] = Math.fround(-viewportHeight * reciprocalHeight);
            // The viewport, and its scissor rectangle as NVRHI rounds it (outwards).
            const left = Math.fround(startX * scale);
            const top = Math.fround(startY * scale);
            const right = Math.fround(startX * scale + viewportWidth);
            const bottom = Math.fround(startY * scale + viewportHeight);
            Nri_CmdSetViewport(commandBuffer, left, top, Math.fround(right - left), Math.fround(bottom - top));
            const scissorLeft: int = Math.floor(left);
            const scissorTop: int = Math.floor(top);
            const scissorRight: int = Math.ceil(right);
            const scissorBottom: int = Math.ceil(bottom);
            Nri_CmdSetScissor(commandBuffer, scissorLeft, scissorTop, scissorRight - scissorLeft, scissorBottom - scissorTop);
            Nri_CmdSetPipeline(commandBuffer, linePipeline);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.drawConstants[0]), DRAW_CONSTANTS_FLOATS * 4);
            Nri_CmdDraw(commandBuffer, n, 1, 0, 0);

            // Render blocks
            this.bindRects(commandBuffer);
            const size = 150.0;
            const blockLeft = LAYOUT_WIDTH - size * 4.0;
            this.drawRect(commandBuffer, blockLeft, 50.0, blockLeft + size, 50.0 + size, 1.0);
            const hdrSceneValue = Math.fround(this.current2084CurveRenderingNits / this.paperWhiteNits);
            this.drawRect(commandBuffer, blockLeft + size * 2.0, 50.0, blockLeft + size * 3.0, 50.0 + size, hdrSceneValue);
        }

        // The HDR scene, cleared to black, its blocks or curve, then its text.
        recordScene(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const hdrScene = this.hdrScene;
            const hdrSceneAttachment = this.hdrSceneAttachment;
            const sceneLayout = this.sceneLayout;
            const descriptorPool = this.descriptorPool;
            const sceneSet = queuedFrame.sceneSet;
            if (!hdrScene || !hdrSceneAttachment || !sceneLayout || !descriptorPool || !sceneSet) {
                return;
            }
            Nri_CmdTextureBarrier(commandBuffer, hdrScene, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            Nri_CmdBeginRendering(commandBuffer, hdrSceneAttachment);
            Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 1.0);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, sceneLayout);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, sceneSet);
            if (this.render2084Curve) {
                // Render the ST.2084 curve
                this.renderST2084Curve(commandBuffer, queuedFrame);
            } else {
                // Render the HDR scene with values larger than 1.0f, which will be perceived as bright
                this.renderHDRScene(commandBuffer);
            }
            // The text goes into the HDR scene too.
            if (this.imgui) {
                Nri_CmdDrawImguiUnconverted(this.sample, commandBuffer, NriFormat.RGBA16_SFLOAT);
            }
            Nri_CmdEndRendering(commandBuffer);
            Nri_CmdTextureBarrier(commandBuffer, hdrScene, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
        }

        // The sample's PrepareSwapChainBuffer: the HDR scene as HDR10 (Rec.2020, ST.2084) into the
        // swap chain texture when it is in that color space, clipped to SDR otherwise.
        recordPrepareSwapChain(commandBuffer: NriCommandBufferHandle, colorAttachment: NriDescriptorHandle) {
            const convertLayout = this.convertLayout;
            const descriptorPool = this.descriptorPool;
            const convertSet = this.convertSet;
            const pipeline = this.hdr10 ? this.hdr10Pipeline : this.sdrPipeline;
            if (!convertLayout || !descriptorPool || !convertSet || !pipeline) {
                return;
            }
            this.convertConstants[0] = this.paperWhiteNits;
            Nri_CmdBeginRendering(commandBuffer, colorAttachment);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            // (ImGui's draw bound its own pool.)
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, convertLayout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, convertSet);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.convertConstants[0]), 16);
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

                // Record: the HDR scene and its text, then the swap chain texture from it.
                Nri_BeginCommandBuffer(commandBuffer);
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                this.recordScene(commandBuffer, queuedFrame);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                this.recordPrepareSwapChain(commandBuffer, swapChainTexture.colorAttachment);

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
                    this.destroyDescriptor(queuedFrame.lineView);
                    this.destroyBuffer(queuedFrame.lineBuffer);
                }
                this.destroySwapChain();
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                this.destroyHdrScene();
                this.destroyDescriptor(this.pointSampler);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.rectPipeline);
                this.destroyPipeline(this.linePipeline);
                this.destroyPipeline(this.hdr10Pipeline);
                this.destroyPipeline(this.sdrPipeline);
                this.destroyLayout(this.sceneLayout);
                this.destroyLayout(this.convertLayout);
                Nri_DestroyFence(this.frameFence);
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
        const simpleHdr = new SimpleHdr(sample);
        // -curve: start with the ST.2084 curve. -bright: the bright blocks without the countdown.
        // -sdr: the SDR signal even on an HDR display. -noUI: accepted (the text is the scene's, drawn
        // as the Donut example draws it with -noUI).
        Nri_AddExampleOption(sample, "-curve");
        Nri_AddExampleOption(sample, "-bright");
        Nri_AddExampleOption(sample, "-sdr");
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        Nri_UseResizableWindow(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-curve") {
                simpleHdr.render2084Curve = true;
            } else if (arg == "-bright") {
                simpleHdr.countDownToBright = -1.0;
                simpleHdr.showOnlyPaperWhite = false;
            } else if (arg == "-sdr") {
                simpleHdr.forceSdr = true;
            }
        }
        return simpleHdr.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return SimpleHdrNri.main(argc, argv);
}

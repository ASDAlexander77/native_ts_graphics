/// <reference path="../../core/nri/nri_interop.d.ts" />

namespace HdrDisplayNri {
    // hdr_display, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut
    // and NVRHI: the same shaders (hdr_display.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui drawing the UI layer's text into its
    // texture as Donut's does. This example creates everything it runs, and does the rendering.

    const WINDOW_TITLE = "NRI Example: D3D12 HDR sample";
    const FONT_PATH = "media/fonts/OpenSans/OpenSans-Regular.ttf";
    // The sample's UI text: Arial at height / 30 and height / 40. OpenSans at an ImGui size 1.278
    // times that (ImGui's size is ascent + descent) matches the glyphs' sizes (as the Donut example).
    const FONT_SCALE = 23.0 / 18.0;

    // The back buffer formats PgUp / PgDn cycle through (SwapChainBitDepth: 8, 10, 16 bits).
    enum BitDepth {
        Bits8 = 0,
        Bits10 = 1,
        Bits16 = 2
    }
    const BIT_DEPTH_COUNT = 3;
    const FORMAT_NAMES = ["R8G8B8A8_UNORM", "R10G10B10A2_UNORM", "R16G16B16A16_FLOAT"];

    // The display curves (DisplayCurve): what the present shader outputs.
    enum Curve {
        Srgb = 0,
        St2084 = 1,
        Linear = 2
    }
    const CURVE_NAMES = ["sRGB", "ST.2084", "Linear"];

    // HDRMetaDataPool: MaxOutputNits, MinOutputNits, MaxCLL, MaxFALL.
    const META_DATA_POOL = [
        [1000.0, 0.001, 2000.0, 500.0],
        [500.0, 0.001, 2000.0, 500.0],
        [500.0, 0.100, 500.0, 100.0],
        [2000.0, 1.000, 2000.0, 1000.0],
    ];

    // The reference white's brightness.
    const REFERENCE_WHITE_NITS = 80.0;
    // The push constants: the reference white's nits, the display curve (floats).
    const ROOT_CONSTANTS_SIZE = 8;

    // The gradients' vertices: position, color (the sample's GradientVertex).
    const GRADIENT_STRIDE = 24;
    // The triangles' and the present triangle's: position, uv.
    const UV_STRIDE = 20;

    // Test mode: the frames rendered, each 1/60 s.
    const TEST_FRAMES = 3;
    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no D3D11 shaders.
    const TEST_SKIPPED = 77;

    // GLFW's key codes (Donut's Key) of the sample's controls, which act when pressed.
    const KEY_H = 72;
    const KEY_M = 77;
    const KEY_U = 85;
    const KEY_PAGE_UP = 266;
    const KEY_PAGE_DOWN = 267;
    const PRESS_KEYS = [KEY_PAGE_UP, KEY_PAGE_DOWN, KEY_H, KEY_U, KEY_M];

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

    // A half float's value.
    function halfToFloat(h: int) {
        const sign = (h & 0x8000) != 0 ? -1.0 : 1.0;
        const exponent = (h >> 10) & 0x1F;
        const mantissa = h & 0x3FF;
        if (exponent == 0) {
            return sign * mantissa * Math.pow(2.0, -24.0);
        }
        return sign * (1.0 + mantissa / 1024.0) * Math.pow(2.0, exponent - 15);
    }

    // The back buffer read back (raw texels, rows rowPitch bytes apart), as the Donut example's
    // readTextureLevel gives it.
    class BackBufferPixels {
        constructor(public pixels: int[], public format: NriFormat, public rowPitch: int) {
        }

        // Pixel (x, y) as RGB, 0 to 1 for UNORM formats and linear for RGBA16_SFLOAT.
        rgb(x: int, y: int) {
            const row = y * Math.floor(this.rowPitch / 4);
            if (this.format == NriFormat.RGBA16_SFLOAT) {
                const lo = this.pixels[row + x * 2];
                const hi = this.pixels[row + x * 2 + 1];
                return [halfToFloat(lo & 0xFFFF), halfToFloat((lo >> 16) & 0xFFFF), halfToFloat(hi & 0xFFFF)];
            }
            const p = this.pixels[row + x];
            if (this.format == NriFormat.R10_G10_B10_A2_UNORM) {
                return [(p & 0x3FF) / 1023.0, ((p >> 10) & 0x3FF) / 1023.0, ((p >> 20) & 0x3FF) / 1023.0];
            }
            const r = (p & 0xFF) / 255.0;
            const g = ((p >> 8) & 0xFF) / 255.0;
            const b = ((p >> 16) & 0xFF) / 255.0;
            if (this.format == NriFormat.BGRA8_UNORM || this.format == NriFormat.BGRA8_SRGB) {
                return [b, g, r];
            }
            return [r, g, b];
        }
    }

    // -test: checks the last frame (at the back buffer format -testFormat picked), on the gradients'
    // middle rows, as the Donut example does: the SDR gradient black at its left end, white at its
    // right, rising between; the HDR gradient clipped to white past its first third with the sRGB
    // curve, above 1 in scRGB (linear, its right end pow(3, 2.2)); the right half of the window
    // shows the gamut triangles.
    function checkFrame(check: BackBufferPixels | null, width: int, height: int, displayCurve: Curve) {
        if (!check) {
            return "cannot read the back buffer";
        }
        const sdrRow = Math.floor(height * 0.25);
        const hdrRow = Math.floor(height * 0.75);
        const sdrLeft = check.rgb(0, sdrRow);
        const sdrMiddle = check.rgb(width / 4, sdrRow);
        const sdrRight = check.rgb(width / 2 - 1, sdrRow);
        const hdrMiddle = check.rgb(width / 4, hdrRow);
        const hdrRight = check.rgb(width / 2 - 1, hdrRow);
        console.log(`Format ${check.format}, curve ${CURVE_NAMES[displayCurve]}: SDR gradient ${sdrLeft[0]} ${sdrMiddle[0]} ${sdrRight[0]}, HDR gradient ${hdrMiddle[0]} ${hdrRight[0]}`);
        if (sdrLeft[0] > 0.02 || sdrRight[0] < 0.97 || !(sdrMiddle[0] > sdrLeft[0] && sdrMiddle[0] < sdrRight[0])) {
            return "the SDR gradient doesn't go from black to white";
        }
        if (displayCurve == Curve.Linear) {
            if (hdrRight[0] < 9.0 || hdrMiddle[0] < 1.5) {
                return "the HDR gradient doesn't go above 1 in scRGB";
            }
        } else if (displayCurve == Curve.Srgb) {
            if (hdrMiddle[0] < 0.99 || hdrRight[0] < 0.99) {
                return "the HDR gradient isn't clipped to white with the sRGB curve";
            }
        }
        // Colored pixels in the right half (the triangles).
        let colored = 0;
        for (let y = 0; y < height; y += 4) {
            for (let x = width / 2; x < width; x += 4) {
                const c = check.rgb(x, y);
                let hi = c[0];
                let lo = c[0];
                for (let k = 1; k < 3; k++) {
                    if (c[k] > hi) {
                        hi = c[k];
                    }
                    if (c[k] < lo) {
                        lo = c[k];
                    }
                }
                if (hi - lo > 0.3) {
                    colored++;
                }
            }
        }
        if (colored < 1000) {
            return `the gamut triangles show in ${colored} sampled pixels only`;
        }
        return "";
    }

    // Port of DirectX-Graphics-Samples' D3D12HDR (as examples/hdr_display.ts ports it) to NRI: an SDR
    // gradient [0, 1] and an HDR one [0, 9] (perceptual: their colors to the power 2.2) and the
    // Rec.709 and Rec.2020 gamuts (CIE xyY triangles converted to Rec.709) drawn into an RGBA16_FLOAT
    // target, then presented into the swap chain texture with the display's curve: sRGB, ST.2084
    // (Rec.709 to Rec.2020 first; HDR10, 10-bit swap chains with H) or linear (scRGB, 16-bit float
    // swap chains), the UI layer's text composed over it. PgUp / PgDn change the swap chain's
    // format (it's made again), U hides the UI, M picks another HDR metadata set (shown only). The
    // sample's Direct2D UI layer is ImGui text in an RGBA8 texture, as the Donut example's.
    class HdrDisplay {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle | null = null;
        private swapChainTextures: SwapChainTexture[] = [];
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private queuedFrames: QueuedFrame[] = [];
        private layout: NriPipelineLayoutHandle | null = null;
        private gradientPipeline: NriPipelineHandle | null = null;
        private palettePipeline: NriPipelineHandle | null = null;
        private presentPipeline: NriPipelineHandle | null = null;
        private gradientBuffer: NriBufferHandle | null = null;
        private trianglesBuffer: NriBufferHandle | null = null;
        private presentBuffer: NriBufferHandle | null = null;
        private sceneTexture: NriTextureHandle | null = null;
        private sceneAttachment: NriDescriptorHandle | null = null;
        private sceneView: NriDescriptorHandle | null = null;
        private uiTexture: NriTextureHandle | null = null;
        private uiAttachment: NriDescriptorHandle | null = null;
        private uiView: NriDescriptorHandle | null = null;
        private sampler: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private descriptorSet: NriDescriptorSetHandle | null = null;
        private imgui: boolean = false;
        private font: NriImguiFontHandle | null = null;
        private smallFont: NriImguiFontHandle | null = null;
        private rootConstants: f32[] = [REFERENCE_WHITE_NITS, Curve.Srgb];
        private width: int = 0;
        private height: int = 0;
        private shaderFolder: string = "";
        private unsupportedReason: string = "";
        // The keys of PRESS_KEYS down last frame (1), or not (0).
        private keysDown: int[] = [];

        // The sample's state.
        bitDepth: BitDepth = BitDepth.Bits8;
        displayCurve: Curve = Curve.Srgb;
        enableST2084: boolean = false;
        enableUI: boolean = true;
        hdrSupport: boolean = false;
        metaDataIndex: int = 0;
        // -testFormat 8|10|16: the bits of the swap chain of -test.
        testFormat: int = 8;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;

        constructor(private sample: NriSampleHandle) {
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
            if (this.unsupportedReason != "") {
                const test = Nri_IsTest(this.sample) != 0;
                console.log(test ? `Test SKIPPED: ${this.unsupportedReason}` : this.unsupportedReason);
                result = test ? TEST_SKIPPED : 1;
            } else if (result == 0 && this.test) {
                const failure = checkFrame(this.readBack(), this.width, this.height, this.displayCurve);
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

            // The sample's shaders are compiled for D3D12 and Vulkan only (as the Donut example's).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (hdr_display.hlsl is compiled for D3D12 and Vulkan)";
                return 0;
            }
            this.shaderFolder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";

            // The sample's root signature: the root constants (push constants, b0), the scene's and
            // the UI's textures (t0, t1) and the sampler (s0).
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(layoutDesc, 0, ROOT_CONSTANTS_SIZE, NriStage.VertexPixel);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 2, NriDescriptorType.Texture, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.VertexPixel, NriRangeFlags.None);
            const layout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The scene (RGBA16_FLOAT) and the UI layer (RGBA8_UNORM): the window's size.
            const sceneTexture = Nri_CreateRenderTargetTexture(device, this.queue, this.width, this.height, NriFormat.RGBA16_SFLOAT);
            const uiTexture = Nri_CreateRenderTargetTexture(device, this.queue, this.width, this.height, NriFormat.RGBA8_UNORM);
            this.sceneTexture = sceneTexture;
            this.uiTexture = uiTexture;
            if (!sceneTexture || !uiTexture) {
                console.log("Cannot create the render targets");
                return 0;
            }
            this.sceneAttachment = Nri_CreateColorAttachmentView(sceneTexture, NriFormat.RGBA16_SFLOAT);
            this.sceneView = Nri_CreateTextureView(sceneTexture, NriFormat.RGBA16_SFLOAT);
            this.uiAttachment = Nri_CreateColorAttachmentView(uiTexture, NriFormat.RGBA8_UNORM);
            this.uiView = Nri_CreateTextureView(uiTexture, NriFormat.RGBA8_UNORM);
            // The sample's static sampler: point filtering (its border addressing only ever reached
            // outside the window; Donut's point clamp sampler).
            this.sampler = Nri_CreateSampler(device, NriFilter.Nearest, NriAddressMode.ClampToEdge, 1);

            // The pipelines into the scene.
            this.gradientPipeline = this.createPipeline("GradientVS", "GradientPS", true, NriFormat.RGBA16_SFLOAT);
            this.palettePipeline = this.createPipeline("PaletteVS", "PalettePS", false, NriFormat.RGBA16_SFLOAT);
            if (!this.gradientPipeline || !this.palettePipeline) {
                console.log("Cannot load the HDR shaders");
                return 0;
            }

            // The set: the scene, the UI layer, the sampler.
            const descriptorPool = Nri_CreateDescriptorPool(device, 1, 1, 0, 2, 0, 0);
            this.descriptorPool = descriptorPool;
            const sceneView = this.sceneView;
            const uiView = this.uiView;
            const sampler = this.sampler;
            if (!descriptorPool || !sampler) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            const descriptorSet = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
            this.descriptorSet = descriptorSet;
            if (!descriptorSet) {
                console.log("Cannot create the descriptor set");
                return 0;
            }
            Nri_UpdateDescriptor(descriptorSet, 0, 0, sceneView);
            Nri_UpdateDescriptor(descriptorSet, 0, 1, uiView);
            Nri_UpdateDescriptor(descriptorSet, 1, 0, sampler);

            // The gradients: the SDR one [0, 1] at the top, the HDR one [0, 3] (9 perceptually) at
            // the bottom; one triangle over the whole window for presenting; the gamut triangles.
            const gradients: f32[] = [
                -1.0, 0.45, 0.0, 0.0, 0.0, 0.0,
                -1.0, 0.55, 0.0, 0.0, 0.0, 0.0,
                0.0, 0.45, 0.0, 1.0, 1.0, 1.0,
                0.0, 0.55, 0.0, 1.0, 1.0, 1.0,
                -1.0, -0.55, 0.0, 0.0, 0.0, 0.0,
                -1.0, -0.45, 0.0, 0.0, 0.0, 0.0,
                0.0, -0.55, 0.0, 3.0, 3.0, 3.0,
                0.0, -0.45, 0.0, 3.0, 3.0, 3.0,
            ];
            const present: f32[] = [
                -1.0, -3.0, 0.0, 0.0, 2.0,
                -1.0, 1.0, 0.0, 0.0, 0.0,
                3.0, 1.0, 0.0, 2.0, 0.0,
            ];
            const triangles = this.gamutTriangles();
            this.gradientBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(gradients[0]), gradients.length * 4, NriBufferUsage.VertexBuffer);
            this.presentBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(present[0]), present.length * 4, NriBufferUsage.VertexBuffer);
            this.trianglesBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(triangles[0]), triangles.length * 4, NriBufferUsage.VertexBuffer);
            if (!this.gradientBuffer || !this.presentBuffer || !this.trianglesBuffer) {
                console.log("Cannot create the vertex buffers");
                return 0;
            }

            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator)));
            }

            // The sample starts with 8-bit swap chains (CheckDisplayHDRSupport: ST.2084 on where the
            // display is in HDR mode). Donut's -test runs without a window, so its display is never
            // in HDR mode, and it picks -testFormat's format.
            this.createSwapChain();
            const swapChain = this.swapChain;
            if (!swapChain || !this.presentPipeline) {
                console.log("Cannot create the swap chain");
                return 0;
            }
            this.hdrSupport = !this.test && Nri_IsDisplayHdr(swapChain) != 0;
            this.enableST2084 = this.hdrSupport;
            if (this.test && this.testFormat == 10) {
                this.setBitDepth(BitDepth.Bits10);
            } else if (this.test && this.testFormat == 16) {
                this.setBitDepth(BitDepth.Bits16);
            }

            // The UI layer's text.
            if (Nri_InitImgui(this.sample, device) == 0) {
                console.log("Cannot initialize the user interface");
                return 0;
            }
            this.imgui = true;
            this.font = Nri_ImguiCreateFont(FONT_PATH, FONT_SCALE * this.height / 30.0);
            this.smallFont = Nri_ImguiCreateFont(FONT_PATH, FONT_SCALE * this.height / 40.0);
            if (!this.font || !this.smallFont) {
                console.log("Cannot load the font");
                return 0;
            }

            if (this.test) {
                // RGBA16_FLOAT texels are 8 bytes.
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 8 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
            }
            return 1;
        }

        // A pipeline of hdr_display.hlsl's entry points (the gradients' vertices, or the ones with
        // texture coordinates) into a format target: triangle strips for the gradients, lists else;
        // back faces culled, no depth.
        createPipeline(vsEntry: string, psEntry: string, gradient: boolean, format: NriFormat): NriPipelineHandle | null {
            const device = this.device;
            const layout = this.layout;
            if (!device || !layout) {
                return null;
            }
            const path = `shaders/hdr_display/${this.shaderFolder}/hdr_display_`;
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${path}${vsEntry}.bin`, vsEntry) != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${path}${psEntry}.bin`, psEntry) != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            if (gradient) {
                Nri_PipelineDescAddVertexAttribute(desc, "COLOR", NriFormat.RGB32_SFLOAT, 12);
            } else {
                Nri_PipelineDescAddVertexAttribute(desc, "TEXCOORD", NriFormat.RG32_SFLOAT, 12);
            }
            Nri_PipelineDescSetTopology(desc, gradient ? NriTopology.TriangleStrip : NriTopology.TriangleList);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            Nri_PipelineDescSetDepthClip(desc, 0);
            Nri_PipelineDescSetColor(desc, format, NriColorWrite.RGBA);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // The swap chain for the bit depth (and ST.2084 switch: EnsureSwapChainColorSpace), its
        // textures' views and semaphores, and the present pipeline for its format.
        createSwapChain() {
            const device = this.device;
            if (!device) {
                return;
            }
            let format = NriSwapChainFormat.BT709_G22_8BIT;
            if (this.bitDepth == BitDepth.Bits8) {
                this.displayCurve = Curve.Srgb;
            } else if (this.bitDepth == BitDepth.Bits10) {
                if (this.enableST2084) {
                    format = NriSwapChainFormat.BT2020_G2084_10BIT;
                    this.displayCurve = Curve.St2084;
                } else {
                    format = NriSwapChainFormat.BT709_G22_10BIT;
                    this.displayCurve = Curve.Srgb;
                }
            } else {
                format = NriSwapChainFormat.BT709_G10_16BIT;
                this.displayCurve = Curve.Linear;
            }
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            const swapChain = Nri_CreateSwapChainWithFormat(this.sample, device, this.queue, queuedFrameNum + 1, format);
            this.swapChain = swapChain;
            // UNORM views, as Donut's AppOptions.UnormBackBuffer back buffers.
            this.swapChainFormat = Nri_GetTextureFormat(Nri_GetSwapChainTexture(swapChain, 0));
            const textureNum = Nri_GetSwapChainTextureNum(swapChain);
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, this.swapChainFormat),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }
            this.presentPipeline = this.createPipeline("PresentVS", "PresentPS", false, this.swapChainFormat);
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
            this.destroyPipeline(this.presentPipeline);
            this.presentPipeline = null;
        }

        // The swap chain made again (UpdateSwapChainBuffer / EnsureSwapChainColorSpace).
        recreateSwapChain() {
            const device = this.device;
            if (!device) {
                return;
            }
            Nri_DeviceWaitIdle(device);
            this.destroySwapChain();
            this.createSwapChain();
        }

        // PgUp / PgDn: the next format.
        setBitDepth(bitDepth: BitDepth) {
            this.bitDepth = bitDepth;
            this.recreateSwapChain();
        }

        // TransformVertex: an xy chromaticity into the window, its aspect ratio kept, at an offset.
        transformVertex(x: number, y: number, offsetX: number, offsetY: number) {
            const aspectRatio = Math.fround(this.width / this.height);
            const scaleX = Math.min(1.0, Math.fround(1.0 / aspectRatio));
            const scaleY = Math.min(1.0, aspectRatio);
            const marginX = Math.fround(0.5 * Math.fround(1.0 - scaleX));
            const marginY = Math.fround(0.5 * Math.fround(1.0 - scaleY));
            return [Math.fround(Math.fround(Math.fround(x) * scaleX) + Math.fround(marginX + Math.fround(offsetX))),
                Math.fround(Math.fround(Math.fround(y) * scaleY) + Math.fround(marginY + Math.fround(offsetY)))];
        }

        // UpdateVertexBuffer: the gamut triangles for the window's size, three per gamut (red,
        // green, blue paired around the white point), Rec.709's offset by (0.2, 0), Rec.2020's by
        // (0.2, -1).
        gamutTriangles(): f32[] {
            const primaries709 = [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06], [0.3127, 0.3290]];
            const primaries2020 = [[0.708, 0.292], [0.170, 0.797], [0.131, 0.046], [0.3127, 0.3290]];
            // Each gamut's triangles: B G W, G R W, R B W.
            const order = [2, 1, 3, 1, 0, 3, 0, 2, 3];
            const vertices: f32[] = [];
            for (let g = 0; g < 2; g++) {
                const primaries = g == 0 ? primaries709 : primaries2020;
                const offsetY = g == 0 ? 0.0 : -1.0;
                for (const primaryIndex of order) {
                    const p = primaries[primaryIndex];
                    const v = this.transformVertex(p[0], p[1], 0.2, offsetY);
                    vertices.push(v[0]);
                    vertices.push(v[1]);
                    vertices.push(0.0);
                    vertices.push(p[0]);
                    vertices.push(p[1]);
                }
            }
            return vertices;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The sample's keys (when pressed): PgUp / PgDn the format, H the ST.2084 curve (10-bit
        // swap chains), U the UI, M the metadata set.
        handleKeys() {
            if (this.test) {
                return;
            }
            for (let i = 0; i < PRESS_KEYS.length; i++) {
                const key = PRESS_KEYS[i];
                const down = Nri_IsKeyPressed(this.sample, key) != 0;
                if (down && this.keysDown[i] == 0) {
                    if (key == KEY_PAGE_UP) {
                        this.setBitDepth((this.bitDepth - 1 + BIT_DEPTH_COUNT) % BIT_DEPTH_COUNT);
                    } else if (key == KEY_PAGE_DOWN) {
                        this.setBitDepth((this.bitDepth + 1) % BIT_DEPTH_COUNT);
                    } else if (key == KEY_H) {
                        this.enableST2084 = !this.enableST2084;
                        if (this.bitDepth == BitDepth.Bits10) {
                            this.recreateSwapChain();
                        }
                    } else if (key == KEY_U) {
                        this.enableUI = !this.enableUI;
                    } else {
                        this.metaDataIndex = (this.metaDataIndex + 1) % 4;
                    }
                }
                this.keysDown[i] = down ? 1 : 0;
            }
        }

        // A label drawn as DirectWrite lays it out: centered in [left, right] or from left.
        drawLabel(text: string, left: number, right: number, top: number, centered: boolean) {
            let x = left;
            if (centered) {
                x = left + (right - left - Nri_ImguiCalcTextWidth(text)) * 0.5;
            }
            Nri_ImguiDrawText(x, top, text, 1.0, 1.0, 1.0, 1.0, 0);
        }

        // UILayer: the format, signal and HDR support at the top; the gradients' and gamuts' names
        // under them; the keys at the bottom left (the sample's tabs as spaces).
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            const font = this.font;
            const smallFont = this.smallFont;
            // (No `handle && ...` conditions: tslang miscompiles them, TSLANG_ISSUES #23.)
            if (!this.enableUI || !font || !smallFont) {
                Nri_ImguiRender(this.sample);
                return;
            }
            const w = this.width;
            const h = this.height;
            const fontSize = h / 30.0;
            const smallFontSize = h / 40.0;
            const meta = META_DATA_POOL[this.metaDataIndex];
            Nri_ImguiPushFont(font);
            this.drawLabel(`Back Buffer Format = ${FORMAT_NAMES[this.bitDepth]}`, 0.0, w, 0.0, true);
            this.drawLabel(`Output Signal = ${CURVE_NAMES[this.displayCurve]}`, 0.0, w, fontSize, true);
            this.drawLabel(`Current Output HDR Support = ${this.hdrSupport ? "true" : "false"}`, 0.0, w, fontSize * 2.0, true);
            this.drawLabel("SDR Gradient [0,1]", 0.0, w * 0.5, h * 0.25 + fontSize, true);
            this.drawLabel("HDR Gradient [0,9]", 0.0, w * 0.5, h * 0.75 + fontSize, true);
            this.drawLabel("Rec 709", w * 0.5, w * 0.8, h * 0.25 + fontSize, true);
            this.drawLabel("Rec 2020", w * 0.5, w * 0.8, h * 0.75 + fontSize, true);
            Nri_ImguiPopFont();
            Nri_ImguiPushFont(smallFont);
            this.drawLabel("PgUp/PgDn    Change back buffer format", smallFontSize, w, h - fontSize * 5.0, false);
            this.drawLabel("H    Toggle between sRGB and ST.2084 (10-bit swap chain only)", smallFontSize, w, h - fontSize * 3.0, false);
            this.drawLabel("U    Toggle UI Visibility", smallFontSize, w, h - fontSize * 2.0, false);
            this.drawLabel(`M    Toggle HDR Meta Data     MaxOutputNits:${meta[0].toFixed(3)}     MinOutputNits:${meta[1].toFixed(3)}     MaxCLL:${meta[2].toFixed(3)}     MaxFALL:${meta[3].toFixed(3)}`,
                smallFontSize, w, h - fontSize, false);
            Nri_ImguiPopFont();
            Nri_ImguiRender(this.sample);
        }

        // RenderScene's first part: the gradients and the triangles into the scene's target
        // (cleared first).
        recordScene(commandBuffer: NriCommandBufferHandle) {
            const sceneTexture = this.sceneTexture;
            const sceneAttachment = this.sceneAttachment;
            const layout = this.layout;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = this.descriptorSet;
            const gradientPipeline = this.gradientPipeline;
            const palettePipeline = this.palettePipeline;
            const gradientBuffer = this.gradientBuffer;
            const trianglesBuffer = this.trianglesBuffer;
            if (!sceneTexture || !sceneAttachment || !layout || !descriptorPool || !descriptorSet || !gradientPipeline
                || !palettePipeline || !gradientBuffer || !trianglesBuffer) {
                return;
            }
            Nri_CmdTextureBarrier(commandBuffer, sceneTexture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            Nri_CmdBeginRendering(commandBuffer, sceneAttachment);
            Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, layout);
            // (No descriptor set: the gradients and triangles sample nothing, and the set holds the
            // scene texture, which D3D12 would check is a shader resource at the bind.)
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.rootConstants[0]), ROOT_CONSTANTS_SIZE);

            // The standard gradient, then the bright one.
            Nri_CmdSetPipeline(commandBuffer, gradientPipeline);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, gradientBuffer, 0, GRADIENT_STRIDE);
            Nri_CmdDraw(commandBuffer, 4, 1, 0, 0);
            Nri_CmdDraw(commandBuffer, 4, 1, 4, 0);

            Nri_CmdSetPipeline(commandBuffer, palettePipeline);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, trianglesBuffer, 0, UV_STRIDE);
            for (let t = 0; t < 6; t++) {
                Nri_CmdDraw(commandBuffer, 3, 1, t * 3, 0);
            }
            Nri_CmdEndRendering(commandBuffer);
            Nri_CmdTextureBarrier(commandBuffer, sceneTexture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
        }

        // The UI layer: its texture cleared, then the text (ImGui's colors as they are, as Donut's
        // ImGui renderer draws them) in a pass of its own (NRIFramework's ImGui has no depth).
        recordUI(commandBuffer: NriCommandBufferHandle) {
            const uiTexture = this.uiTexture;
            const uiAttachment = this.uiAttachment;
            if (!uiTexture || !uiAttachment) {
                return;
            }
            Nri_CmdTextureBarrier(commandBuffer, uiTexture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            Nri_CmdBeginRendering(commandBuffer, uiAttachment);
            Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
            if (this.imgui && this.enableUI) {
                Nri_CmdDrawImguiUnconverted(this.sample, commandBuffer, NriFormat.RGBA8_UNORM);
            }
            Nri_CmdEndRendering(commandBuffer);
            Nri_CmdTextureBarrier(commandBuffer, uiTexture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
        }

        // RenderScene's second part, after the UI: the scene and the UI layer composed and presented
        // into the swap chain texture (cleared to black first) with the display's curve.
        recordPresent(commandBuffer: NriCommandBufferHandle, colorAttachment: NriDescriptorHandle) {
            const layout = this.layout;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = this.descriptorSet;
            const presentPipeline = this.presentPipeline;
            const presentBuffer = this.presentBuffer;
            if (!layout || !descriptorPool || !descriptorSet || !presentPipeline || !presentBuffer) {
                return;
            }
            Nri_CmdBeginRendering(commandBuffer, colorAttachment);
            Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 1.0);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            // (ImGui's draw bound its own pool.)
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, layout);
            Nri_CmdSetPipeline(commandBuffer, presentPipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, descriptorSet);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.rootConstants[0]), ROOT_CONSTANTS_SIZE);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, presentBuffer, 0, UV_STRIDE);
            Nri_CmdDraw(commandBuffer, 3, 1, 0, 0);
            Nri_CmdEndRendering(commandBuffer);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.handleKeys();
            this.rootConstants[1] = this.displayCurve;
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

                // Record: the scene, the UI layer, then both presented into the swap chain texture.
                Nri_BeginCommandBuffer(commandBuffer);
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                this.recordScene(commandBuffer);
                this.recordUI(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                this.recordPresent(commandBuffer, swapChainTexture.colorAttachment);

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

        // The last frame's raw texels (null if it can't be read); -testOutput's PNG written as
        // Donut's is (8-bit: the texels; 10-bit and 16-bit float: blitted into sRGB8).
        readBack(): BackBufferPixels | null {
            const device = this.device;
            const readbackBuffer = this.readbackBuffer;
            if (!device || !readbackBuffer) {
                return null;
            }
            Nri_DeviceWaitIdle(device);
            const pixels: int[] = [];
            const count = Math.floor(this.rowPitch / 4) * this.height;
            for (let i = 0; i < count; i++) {
                pixels.push(0);
            }
            if (Nri_ReadBufferInts(readbackBuffer, Ref(pixels[0]), count) == 0) {
                return null;
            }
            if (this.swapChainFormat == NriFormat.RGBA16_SFLOAT) {
                Nri_WriteTestOutputRGBA16F(readbackBuffer, this.rowPitch, this.width, this.height);
            } else {
                const rgba: int[] = [];
                for (let i = 0; i < this.width * this.height; i++) {
                    rgba.push(0);
                }
                Nri_ReadBufferRGBA8(readbackBuffer, this.rowPitch, this.width, this.height, this.swapChainFormat, Ref(rgba[0]), rgba.length);
            }
            return new BackBufferPixels(pixels, this.swapChainFormat, this.rowPitch);
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
                this.destroySwapChain();
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                this.destroyDescriptor(this.sceneAttachment);
                this.destroyDescriptor(this.sceneView);
                this.destroyDescriptor(this.uiAttachment);
                this.destroyDescriptor(this.uiView);
                this.destroyDescriptor(this.sampler);
                this.destroyTexture(this.sceneTexture);
                this.destroyTexture(this.uiTexture);
                this.destroyBuffer(this.gradientBuffer);
                this.destroyBuffer(this.trianglesBuffer);
                this.destroyBuffer(this.presentBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.gradientPipeline);
                this.destroyPipeline(this.palettePipeline);
                const layout = this.layout;
                if (layout) {
                    Nri_DestroyPipelineLayout(layout);
                }
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

        destroyTexture(texture: NriTextureHandle | null) {
            if (texture) {
                Nri_DestroyTexture(texture);
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
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const hdrDisplay = new HdrDisplay(sample);
        // -noUI: without the UI layer (U), as the Donut example. -testFormat 8|10|16: the bits of
        // the swap chain of -test (8 by default).
        Nri_AddExampleOption(sample, "-noUI");
        Nri_AddExampleOptionWithValues(sample, "-testFormat", 1);
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-noUI") {
                hdrDisplay.enableUI = false;
            } else if (arg == "-testFormat" && i + 1 < argc) {
                i++;
                hdrDisplay.testFormat = parseInt(Nri_GetArg(argc, argv, i));
            }
        }
        return hdrDisplay.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return HdrDisplayNri.main(argc, argv);
}

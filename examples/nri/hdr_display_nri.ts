/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriImgui, NriImguiFont, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private layout: NriPipelineLayout | null = null;
        private gradientPipeline: NriPipeline | null = null;
        private palettePipeline: NriPipeline | null = null;
        private presentPipeline: NriPipeline | null = null;
        private gradientBuffer: NriBuffer | null = null;
        private trianglesBuffer: NriBuffer | null = null;
        private presentBuffer: NriBuffer | null = null;
        private sceneTexture: NriTexture | null = null;
        private sceneAttachment: NriDescriptor | null = null;
        private sceneView: NriDescriptor | null = null;
        private uiTexture: NriTexture | null = null;
        private uiAttachment: NriDescriptor | null = null;
        private uiView: NriDescriptor | null = null;
        private sampler: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private descriptorSet: NriDescriptorSet | null = null;
        private imgui: boolean = false;
        private font: NriImguiFont | null = null;
        private smallFont: NriImguiFont | null = null;
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
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;

        constructor(private sample: NriSample) {
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
            this.sample.setInitializeCallback(initialize);
            this.sample.setLatencySleepCallback(latencySleep);
            this.sample.setRenderFrameCallback(renderFrame);

            let result = this.sample.run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (this.unsupportedReason != "") {
                const test = this.sample.isTest() != 0;
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

            // The sample's shaders are compiled for D3D12 and Vulkan only (as the Donut example's).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (hdr_display.hlsl is compiled for D3D12 and Vulkan)";
                return 0;
            }
            this.shaderFolder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";

            // The sample's root signature: the root constants (push constants, b0), the scene's and
            // the UI's textures (t0, t1) and the sampler (s0).
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRootConstants(0, ROOT_CONSTANTS_SIZE, NriStage.VertexPixel);
            layoutDesc.addRange(0, 0, 2, NriDescriptorType.Texture, NriStage.VertexPixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.VertexPixel, NriRangeFlags.None);
            const layout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The scene (RGBA16_FLOAT) and the UI layer (RGBA8_UNORM): the window's size.
            if (!this.createTargets(device)) {
                console.log("Cannot create the render targets");
                return 0;
            }
            // The sample's static sampler: point filtering (its border addressing only ever reached
            // outside the window; Donut's point clamp sampler).
            this.sampler = device.createSampler(NriFilter.Nearest, NriAddressMode.ClampToEdge, 1);

            // The pipelines into the scene.
            this.gradientPipeline = this.createPipeline("GradientVS", "GradientPS", true, NriFormat.RGBA16_SFLOAT);
            this.palettePipeline = this.createPipeline("PaletteVS", "PalettePS", false, NriFormat.RGBA16_SFLOAT);
            if (!this.gradientPipeline || !this.palettePipeline) {
                console.log("Cannot load the HDR shaders");
                return 0;
            }

            // The set: the scene, the UI layer, the sampler.
            const descriptorPool = device.createDescriptorPool(1, 1, 0, 2, 0, 0);
            this.descriptorPool = descriptorPool;
            const sampler = this.sampler;
            if (!descriptorPool || !sampler) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            const descriptorSet = descriptorPool.allocateDescriptorSet(layout, 0, 0);
            this.descriptorSet = descriptorSet;
            if (!descriptorSet) {
                console.log("Cannot create the descriptor set");
                return 0;
            }
            this.updateTargetDescriptors();
            descriptorSet.updateDescriptor(1, 0, sampler);

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
            this.gradientBuffer = device.createUploadedBuffer(this.queue, Ref(gradients[0]), gradients.length * 4, NriBufferUsage.VertexBuffer);
            this.presentBuffer = device.createUploadedBuffer(this.queue, Ref(present[0]), present.length * 4, NriBufferUsage.VertexBuffer);
            this.trianglesBuffer = device.createUploadedBuffer(this.queue, Ref(triangles[0]), triangles.length * 4, NriBufferUsage.VertexBuffer);
            if (!this.gradientBuffer || !this.presentBuffer || !this.trianglesBuffer) {
                console.log("Cannot create the vertex buffers");
                return 0;
            }

            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.frames.init(device, this.queue, queuedFrameNum);

            // The sample starts with 8-bit swap chains (CheckDisplayHDRSupport: ST.2084 on where the
            // display is in HDR mode). Donut's -test runs without a window, so its display is never
            // in HDR mode, and it picks -testFormat's format.
            this.createSwapChain();
            if (!this.swapChain.exists() || !this.presentPipeline) {
                console.log("Cannot create the swap chain");
                return 0;
            }
            this.hdrSupport = !this.test && this.swapChain.object().isDisplayHdr() != 0;
            this.enableST2084 = this.hdrSupport;
            if (this.test && this.testFormat == 10) {
                this.setBitDepth(BitDepth.Bits10);
            } else if (this.test && this.testFormat == 16) {
                this.setBitDepth(BitDepth.Bits16);
            }

            // The UI layer's text.
            if (this.sample.initImgui(device) == 0) {
                console.log("Cannot initialize the user interface");
                return 0;
            }
            this.imgui = true;
            this.createFonts();
            if (!this.font || !this.smallFont) {
                console.log("Cannot load the font");
                return 0;
            }

            if (this.test) {
                // RGBA16_FLOAT texels are 8 bytes.
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 8 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
            }
            return 1;
        }

        // A pipeline of hdr_display.hlsl's entry points (the gradients' vertices, or the ones with
        // texture coordinates) into a format target: triangle strips for the gradients, lists else;
        // back faces culled, no depth.
        createPipeline(vsEntry: string, psEntry: string, gradient: boolean, format: NriFormat): NriPipeline | null {
            const device = this.device;
            const layout = this.layout;
            if (!device || !layout) {
                return null;
            }
            const path = `shaders/hdr_display/${this.shaderFolder}/hdr_display_`;
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${path}${vsEntry}.bin`, vsEntry) != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${path}${psEntry}.bin`, psEntry) != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            if (gradient) {
                desc.addVertexAttribute("COLOR", NriFormat.RGB32_SFLOAT, 12);
            } else {
                desc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, 12);
            }
            desc.setTopology(gradient ? NriTopology.TriangleStrip : NriTopology.TriangleList);
            desc.setCullMode(NriCullMode.Back);
            desc.setDepthClip(0);
            desc.setColor(format, NriColorWrite.RGBA);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
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
            this.swapChain.initWithFormat(this.sample, device, this.queue, format);
            // UNORM views, as Donut's AppOptions.UnormBackBuffer back buffers.
            this.swapChainFormat = this.swapChain.format();
            this.presentPipeline = this.createPipeline("PresentVS", "PresentPS", false, this.swapChainFormat);
        }

        destroySwapChain() {
            this.swapChain.destroy();
            this.destroyPipeline(this.presentPipeline);
            this.presentPipeline = null;
        }

        // The swap chain made again (UpdateSwapChainBuffer / EnsureSwapChainColorSpace).
        recreateSwapChain() {
            const device = this.device;
            if (!device) {
                return;
            }
            device.waitIdle();
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

        // The scene (RGBA16_FLOAT) and the UI layer (RGBA8_UNORM) at the window's size, in
        // ShaderResource (as the frames leave them); false on failure.
        createTargets(device: NriDevice): boolean {
            const sceneTexture = device.createRenderTargetTexture(this.queue, this.width, this.height, NriFormat.RGBA16_SFLOAT);
            const uiTexture = device.createRenderTargetTexture(this.queue, this.width, this.height, NriFormat.RGBA8_UNORM);
            this.sceneTexture = sceneTexture;
            this.uiTexture = uiTexture;
            if (!sceneTexture || !uiTexture) {
                return false;
            }
            this.sceneAttachment = sceneTexture.createColorAttachmentView(NriFormat.RGBA16_SFLOAT);
            this.sceneView = sceneTexture.createView(NriFormat.RGBA16_SFLOAT);
            this.uiAttachment = uiTexture.createColorAttachmentView(NriFormat.RGBA8_UNORM);
            this.uiView = uiTexture.createView(NriFormat.RGBA8_UNORM);
            return true;
        }

        destroyTargets() {
            this.destroyDescriptor(this.sceneAttachment);
            this.destroyDescriptor(this.sceneView);
            this.destroyDescriptor(this.uiAttachment);
            this.destroyDescriptor(this.uiView);
            this.destroyTexture(this.sceneTexture);
            this.destroyTexture(this.uiTexture);
            this.sceneAttachment = null;
            this.sceneView = null;
            this.uiAttachment = null;
            this.uiView = null;
            this.sceneTexture = null;
            this.uiTexture = null;
        }

        // The set's scene and UI layer: the current targets' views.
        updateTargetDescriptors() {
            const descriptorSet = this.descriptorSet;
            const sceneView = this.sceneView;
            const uiView = this.uiView;
            if (descriptorSet) {
                if (sceneView) {
                    descriptorSet.updateDescriptor(0, 0, sceneView);
                }
                if (uiView) {
                    descriptorSet.updateDescriptor(0, 1, uiView);
                }
            }
        }

        // The UI's fonts, at the window's starting height (1/30 and 1/40 of it, the sample's); buildUI
        // draws them at the current height's sizes (NriImguiFont.pushFontSized), so a resize needs no new ones.
        createFonts() {
            this.font = NriImgui.createFont(FONT_PATH, FONT_SCALE * this.height / 30.0);
            this.smallFont = NriImgui.createFont(FONT_PATH, FONT_SCALE * this.height / 40.0);
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain (its format as before), the
        // scene and UI layer and the gamut triangles (kept in the window's aspect ratio), once the GPU is
        // done with the old ones. The fonts follow the height in buildUI.
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
            this.destroySwapChain();
            this.createSwapChain();
            this.destroyTargets();
            this.createTargets(device);
            this.updateTargetDescriptors();
            this.destroyBuffer(this.trianglesBuffer);
            const triangles = this.gamutTriangles();
            this.trianglesBuffer = device.createUploadedBuffer(this.queue, Ref(triangles[0]), triangles.length * 4, NriBufferUsage.VertexBuffer);
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The sample's keys (when pressed): PgUp / PgDn the format, H the ST.2084 curve (10-bit
        // swap chains), U the UI, M the metadata set.
        handleKeys() {
            if (this.test) {
                return;
            }
            for (let i = 0; i < PRESS_KEYS.length; i++) {
                const key = PRESS_KEYS[i];
                const down = this.sample.isKeyPressed(key) != 0;
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
                x = left + (right - left - NriImgui.calcTextWidth(text)) * 0.5;
            }
            NriImgui.drawText(x, top, text, 1.0, 1.0, 1.0, 1.0, 0);
        }

        // UILayer: the format, signal and HDR support at the top; the gradients' and gamuts' names
        // under them; the keys at the bottom left (the sample's tabs as spaces).
        buildUI() {
            this.sample.imguiNewFrame();
            const font = this.font;
            const smallFont = this.smallFont;
            // (No `handle && ...` conditions: tslang miscompiles them, TSLANG_ISSUES #23.)
            if (!this.enableUI || !font || !smallFont) {
                this.sample.imguiRender();
                return;
            }
            const w = this.width;
            const h = this.height;
            const fontSize = h / 30.0;
            const smallFontSize = h / 40.0;
            const meta = META_DATA_POOL[this.metaDataIndex];
            font.pushFontSized(FONT_SCALE * h / 30.0);
            this.drawLabel(`Back Buffer Format = ${FORMAT_NAMES[this.bitDepth]}`, 0.0, w, 0.0, true);
            this.drawLabel(`Output Signal = ${CURVE_NAMES[this.displayCurve]}`, 0.0, w, fontSize, true);
            this.drawLabel(`Current Output HDR Support = ${this.hdrSupport ? "true" : "false"}`, 0.0, w, fontSize * 2.0, true);
            this.drawLabel("SDR Gradient [0,1]", 0.0, w * 0.5, h * 0.25 + fontSize, true);
            this.drawLabel("HDR Gradient [0,9]", 0.0, w * 0.5, h * 0.75 + fontSize, true);
            this.drawLabel("Rec 709", w * 0.5, w * 0.8, h * 0.25 + fontSize, true);
            this.drawLabel("Rec 2020", w * 0.5, w * 0.8, h * 0.75 + fontSize, true);
            NriImgui.popFont();
            smallFont.pushFontSized(FONT_SCALE * h / 40.0);
            this.drawLabel("PgUp/PgDn    Change back buffer format", smallFontSize, w, h - fontSize * 5.0, false);
            this.drawLabel("H    Toggle between sRGB and ST.2084 (10-bit swap chain only)", smallFontSize, w, h - fontSize * 3.0, false);
            this.drawLabel("U    Toggle UI Visibility", smallFontSize, w, h - fontSize * 2.0, false);
            this.drawLabel(`M    Toggle HDR Meta Data     MaxOutputNits:${meta[0].toFixed(3)}     MinOutputNits:${meta[1].toFixed(3)}     MaxCLL:${meta[2].toFixed(3)}     MaxFALL:${meta[3].toFixed(3)}`,
                smallFontSize, w, h - fontSize, false);
            NriImgui.popFont();
            this.sample.imguiRender();
        }

        // RenderScene's first part: the gradients and the triangles into the scene's target
        // (cleared first).
        recordScene(commandBuffer: NriCommandBuffer) {
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
            commandBuffer.textureBarrier(sceneTexture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(sceneAttachment);
            commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(layout);
            // (No descriptor set: the gradients and triangles sample nothing, and the set holds the
            // scene texture, which D3D12 would check is a shader resource at the bind.)
            commandBuffer.setRootConstants(0, Ref(this.rootConstants[0]), ROOT_CONSTANTS_SIZE);

            // The standard gradient, then the bright one.
            commandBuffer.setPipeline(gradientPipeline);
            commandBuffer.setVertexBuffer(0, gradientBuffer, 0, GRADIENT_STRIDE);
            commandBuffer.draw(4, 1, 0, 0);
            commandBuffer.draw(4, 1, 4, 0);

            commandBuffer.setPipeline(palettePipeline);
            commandBuffer.setVertexBuffer(0, trianglesBuffer, 0, UV_STRIDE);
            for (let t = 0; t < 6; t++) {
                commandBuffer.draw(3, 1, t * 3, 0);
            }
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(sceneTexture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
        }

        // The UI layer: its texture cleared, then the text (ImGui's colors as they are, as Donut's
        // ImGui renderer draws them) in a pass of its own (NRIFramework's ImGui has no depth).
        recordUI(commandBuffer: NriCommandBuffer) {
            const uiTexture = this.uiTexture;
            const uiAttachment = this.uiAttachment;
            if (!uiTexture || !uiAttachment) {
                return;
            }
            commandBuffer.textureBarrier(uiTexture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(uiAttachment);
            commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
            if (this.imgui && this.enableUI) {
                this.sample.drawImguiUnconverted(commandBuffer, NriFormat.RGBA8_UNORM);
            }
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(uiTexture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
        }

        // RenderScene's second part, after the UI: the scene and the UI layer composed and presented
        // into the swap chain texture (cleared to black first) with the display's curve.
        recordPresent(commandBuffer: NriCommandBuffer, colorAttachment: NriDescriptor) {
            const layout = this.layout;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = this.descriptorSet;
            const presentPipeline = this.presentPipeline;
            const presentBuffer = this.presentBuffer;
            if (!layout || !descriptorPool || !descriptorSet || !presentPipeline || !presentBuffer) {
                return;
            }
            commandBuffer.beginRendering(colorAttachment);
            commandBuffer.clearColor(0.0, 0.0, 0.0, 1.0);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            // (ImGui's draw bound its own pool.)
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setPipeline(presentPipeline);
            commandBuffer.setDescriptorSet(0, descriptorSet);
            commandBuffer.setRootConstants(0, Ref(this.rootConstants[0]), ROOT_CONSTANTS_SIZE);
            commandBuffer.setVertexBuffer(0, presentBuffer, 0, UV_STRIDE);
            commandBuffer.draw(3, 1, 0, 0);
            commandBuffer.endRendering();
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.frames.size();
            this.handleKeys();
            this.rootConstants[1] = this.displayCurve;
            if (this.imgui) {
                this.buildUI();
            }
            if (!this.swapChain.exists()) {
                return;
            }

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the scene, the UI layer, then both presented into the swap chain texture.
                commandBuffer.begin();
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                this.recordScene(commandBuffer);
                this.recordUI(commandBuffer);
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                this.recordPresent(commandBuffer, this.swapChain.colorAttachment(index));

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

        // The last frame's raw texels (null if it can't be read); -testOutput's PNG written as
        // Donut's is (8-bit: the texels; 10-bit and 16-bit float: blitted into sRGB8).
        readBack(): BackBufferPixels | null {
            const device = this.device;
            const readbackBuffer = this.readbackBuffer;
            if (!device || !readbackBuffer) {
                return null;
            }
            device.waitIdle();
            const pixels: int[] = [];
            const count = Math.floor(this.rowPitch / 4) * this.height;
            for (let i = 0; i < count; i++) {
                pixels.push(0);
            }
            if (readbackBuffer.readInts(Ref(pixels[0]), count) == 0) {
                return null;
            }
            if (this.swapChainFormat == NriFormat.RGBA16_SFLOAT) {
                readbackBuffer.writeTestOutputRGBA16F(this.rowPitch, this.width, this.height);
            } else {
                const rgba: int[] = [];
                for (let i = 0; i < this.width * this.height; i++) {
                    rgba.push(0);
                }
                readbackBuffer.readRGBA8(this.rowPitch, this.width, this.height, this.swapChainFormat, Ref(rgba[0]), rgba.length);
            }
            return new BackBufferPixels(pixels, this.swapChainFormat, this.rowPitch);
        }

        destroy() {
            const device = this.device;
            if (device) {
                device.waitIdle();
                if (this.imgui) {
                    this.sample.destroyImgui();
                }
                this.destroySwapChain();
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroyTargets();
                this.destroyDescriptor(this.sampler);
                this.destroyBuffer(this.gradientBuffer);
                this.destroyBuffer(this.trianglesBuffer);
                this.destroyBuffer(this.presentBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.gradientPipeline);
                this.destroyPipeline(this.palettePipeline);
                const layout = this.layout;
                if (layout) {
                    layout.destroy();
                }
                this.frames.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }

        destroyDescriptor(descriptor: NriDescriptor | null) {
            if (descriptor) {
                descriptor.destroy();
            }
        }

        destroyTexture(texture: NriTexture | null) {
            if (texture) {
                texture.destroy();
            }
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
        const hdrDisplay = new HdrDisplay(sample);
        // -noUI: without the UI layer (U), as the Donut example. -testFormat 8|10|16: the bits of
        // the swap chain of -test (8 by default).
        sample.addExampleOption("-noUI");
        sample.addExampleOptionWithValues("-testFormat", 1);
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-noUI") {
                hdrDisplay.enableUI = false;
            } else if (arg == "-testFormat" && i + 1 < argc) {
                i++;
                hdrDisplay.testFormat = parseInt(Nri.getArg(argc, argv, i));
            }
        }
        return hdrDisplay.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return HdrDisplayNri.main(argc, argv);
}

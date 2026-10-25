// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";

namespace HdrDisplay {
    const WINDOW_TITLE = "D3D12 HDR sample";
    const FONT_PATH = "media/fonts/OpenSans/OpenSans-Regular.ttf";
    // The sample's UI text: Arial at height / 30 and height / 40. OpenSans at an ImGui size 1.278
    // times that (ImGui's size is ascent + descent) matches the glyphs' sizes (as wave_intrinsics).
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

    // Port of DirectX-Graphics-Samples' D3D12HDR: an SDR gradient [0, 1] and an HDR one [0, 9]
    // (perceptual: their colors to the power 2.2) and the Rec.709 and Rec.2020 gamuts (CIE xyY
    // triangles converted to Rec.709) drawn into an RGBA16_FLOAT target, then presented into the
    // back buffer with the display's curve: sRGB, ST.2084 (Rec.709 to Rec.2020 first; HDR10, 10-bit
    // back buffers with H) or linear (scRGB, 16-bit float back buffers), the UI layer's text
    // composed over it. PgUp / PgDn change the back buffers' format, U hides the UI, M picks another
    // HDR metadata set (shown only: Donut has no HDR metadata). The sample's Direct2D UI layer is
    // ImGui text in an RGBA8 texture here.
    class HdrPass {
        private app: App;
        private gradientVS: ShaderHandle;
        private gradientPS: ShaderHandle;
        private paletteVS: ShaderHandle;
        private palettePS: ShaderHandle;
        private presentVS: ShaderHandle;
        private presentPS: ShaderHandle;
        private gradientLayout: InputLayoutHandle;
        private uvLayout: InputLayoutHandle;
        private bindingLayout: BindingLayoutHandle;
        private sampler: SamplerHandle;
        private gradientBuffer: BufferHandle;
        private trianglesBuffer: BufferHandle | null;
        private presentBuffer: BufferHandle;
        private hasTargets: boolean;
        private sceneTexture: TextureHandle;
        private uiTexture: TextureHandle;
        private sceneFramebuffer: FramebufferHandle;
        private uiFramebuffer: FramebufferHandle;
        private bindingSet: BindingSet;
        private gradientPipeline: GraphicsPipelineHandle;
        private palettePipeline: GraphicsPipelineHandle;
        private hasPresentPipeline: boolean;
        private presentPipeline: GraphicsPipelineHandle;
        private rootConstants: f32[];
        private width: int;
        private height: int;
        imguiPass: ImGuiPass;
        private font: ImGuiFont;
        private smallFont: ImGuiFont;
        bitDepth: BitDepth;
        displayCurve: Curve;
        enableST2084: boolean;
        enableUI: boolean;
        hdrSupport: boolean;
        metaDataIndex: int;

        constructor(app: App) {
            this.app = app;
            this.trianglesBuffer = null;
            this.hasTargets = false;
            this.hasPresentPipeline = false;
            this.rootConstants = [REFERENCE_WHITE_NITS, Curve.Srgb];
            this.width = 1280;
            this.height = 720;
            this.bitDepth = BitDepth.Bits8;
            this.displayCurve = Curve.Srgb;
            this.enableST2084 = false;
            this.enableUI = true;
            this.hdrSupport = false;
            this.metaDataIndex = 0;
        }

        init() {
            // The sample's static sampler: point filtering (its border addressing only ever reached
            // outside the window).
            this.sampler = this.app.getCommonSampler(CommonSampler.PointClamp);

            const shader = "hdr_display.hlsl";
            this.gradientVS = this.app.createShader(shader, "GradientVS", ShaderType.Vertex);
            this.gradientPS = this.app.createShader(shader, "GradientPS", ShaderType.Pixel);
            this.paletteVS = this.app.createShader(shader, "PaletteVS", ShaderType.Vertex);
            this.palettePS = this.app.createShader(shader, "PalettePS", ShaderType.Pixel);
            this.presentVS = this.app.createShader(shader, "PresentVS", ShaderType.Vertex);
            this.presentPS = this.app.createShader(shader, "PresentPS", ShaderType.Pixel);
            if (!this.gradientVS || !this.gradientPS || !this.paletteVS || !this.palettePS || !this.presentVS || !this.presentPS) {
                return false;
            }
            const gradientLayoutDesc = InputLayoutDesc.create();
            gradientLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, GRADIENT_STRIDE);
            gradientLayoutDesc.addVertexAttribute("COLOR", Format.RGB32_FLOAT, 12, 0, GRADIENT_STRIDE);
            this.gradientLayout = this.app.createInputLayout(gradientLayoutDesc, this.gradientVS);
            const uvLayoutDesc = InputLayoutDesc.create();
            uvLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, UV_STRIDE);
            uvLayoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 12, 0, UV_STRIDE);
            this.uvLayout = this.app.createInputLayout(uvLayoutDesc, this.paletteVS);

            // The sample's root signature: the root constants, the scene's and UI's SRVs, the sampler.
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutPushConstants(0, ROOT_CONSTANTS_SIZE);
            layoutDesc.layoutTextureSRV(0);
            layoutDesc.layoutTextureSRV(1);
            layoutDesc.layoutSampler(0);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);

            // The gradients: the SDR one [0, 1] at the top, the HDR one [0, 3] (9 perceptually) at
            // the bottom; and one triangle over the whole window for presenting.
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
            const commandList = this.app.createCommandList();
            commandList.open();
            this.gradientBuffer = this.app.createStaticVertexBuffer(commandList, Ref(gradients[0]), gradients.length * 4, "Gradients");
            this.presentBuffer = this.app.createStaticVertexBuffer(commandList, Ref(present[0]), present.length * 4, "Present");
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);

            // CheckDisplayHDRSupport: ST.2084 on where the display is in HDR mode.
            this.hdrSupport = this.app.isDisplayHdr();
            this.enableST2084 = this.hdrSupport;
            this.ensureColorSpace();

            // The scene, the UI (into its texture), presenting.
            const scenePass = this.app.addPass();
            scenePass.setKeyboardCallback(this.onKey);
            scenePass.setAnimateCallback(this.onAnimate);
            scenePass.setBackBufferResizingCallback(this.onBackBufferResizing);
            scenePass.setRenderCallback(this.onRenderScene);

            const imguiPass = this.app.addImGuiPass(this.buildUI);
            if (imguiPass.isNull()) {
                return false;
            }
            this.imguiPass = imguiPass;
            const font = imguiPass.createFont(FONT_PATH, FONT_SCALE * this.height / 30.0);
            const smallFont = imguiPass.createFont(FONT_PATH, FONT_SCALE * this.height / 40.0);
            if (font.isNull() || smallFont.isNull()) {
                console.log("Cannot load the font");
                return false;
            }
            this.font = font;
            this.smallFont = smallFont;

            const presentPass = this.app.addPass();
            presentPass.setRenderCallback(this.onRenderPresent);
            return true;
        }

        // EnsureSwapChainColorSpace: the display curve for the format (and ST.2084 switch), and the
        // swap chain's color space where it can present it.
        ensureColorSpace() {
            let colorSpace = SwapChainColorSpace.SRGB;
            if (this.bitDepth == BitDepth.Bits8) {
                this.displayCurve = Curve.Srgb;
            } else if (this.bitDepth == BitDepth.Bits10) {
                if (this.enableST2084) {
                    colorSpace = SwapChainColorSpace.HDR10;
                    this.displayCurve = Curve.St2084;
                } else {
                    this.displayCurve = Curve.Srgb;
                }
            } else {
                colorSpace = SwapChainColorSpace.ScRGB;
                this.displayCurve = Curve.Linear;
            }
            if (this.app.getSwapChainColorSpace() != colorSpace) {
                this.app.setSwapChainColorSpace(colorSpace);
            }
        }

        // PgUp / PgDn: UpdateSwapChainBuffer with the next format.
        setBitDepth(bitDepth: BitDepth) {
            const formats = [Format.RGBA8_UNORM, Format.R10G10B10A2_UNORM, Format.RGBA16_FLOAT];
            if (this.app.setSwapChainFormat(formats[bitDepth]) == 0) {
                console.log(`The swap chain can't have ${FORMAT_NAMES[bitDepth]} back buffers`);
                return;
            }
            this.bitDepth = bitDepth;
            this.ensureColorSpace();
        }

        onKey(key: Key, scancode: int, action: Action, mods: KeyMods) {
            if (action != Action.Press) {
                return 0;
            }
            if (key == Key.PageUp) {
                this.setBitDepth((this.bitDepth - 1 + BIT_DEPTH_COUNT) % BIT_DEPTH_COUNT);
            } else if (key == Key.PageDown) {
                this.setBitDepth((this.bitDepth + 1) % BIT_DEPTH_COUNT);
            } else if (key == Key.H) {
                this.enableST2084 = !this.enableST2084;
                if (this.bitDepth == BitDepth.Bits10) {
                    this.ensureColorSpace();
                }
            } else if (key == Key.U) {
                this.enableUI = !this.enableUI;
            } else if (key == Key.M) {
                this.metaDataIndex = (this.metaDataIndex + 1) % 4;
            } else {
                return 0;
            }
            return 1;
        }

        onAnimate(elapsedSeconds: number) {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        onBackBufferResizing() {
            if (this.hasPresentPipeline) {
                this.app.releaseResource(this.presentPipeline);
                this.hasPresentPipeline = false;
            }
            if (!this.hasTargets) {
                return;
            }
            this.imguiPass.setFramebuffer(null);
            this.app.releaseResource(this.gradientPipeline);
            this.app.releaseResource(this.palettePipeline);
            this.app.releaseResource(this.sceneFramebuffer);
            this.app.releaseResource(this.uiFramebuffer);
            this.app.releaseResource(this.sceneTexture);
            this.app.releaseResource(this.uiTexture);
            this.app.clearBindingCache();
            this.hasTargets = false;
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

        // LoadSizeDependentResources and UpdateVertexBuffer: the scene's and the UI layer's targets
        // (the back buffer's size), the pipelines for them, and the gamut triangles for this size:
        // three per gamut (red, green, blue paired around the white point), Rec.709's offset by
        // (0.2, 0), Rec.2020's by (0.2, -1).
        createTargets(commandList: CommandList, width: int, height: int) {
            this.width = width;
            this.height = height;
            this.sceneTexture = this.app.createRenderTargetTexture(width, height, Format.RGBA16_FLOAT, "Intermediate");
            this.uiTexture = this.app.createRenderTargetTexture(width, height, Format.RGBA8_UNORM, "UI");
            this.sceneFramebuffer = this.app.createFramebuffer(this.sceneTexture, null);
            this.uiFramebuffer = this.app.createFramebuffer(this.uiTexture, null);

            const gradientDesc = GraphicsPipelineDesc.create(this.gradientVS, this.gradientPS);
            gradientDesc.setInputLayout(this.gradientLayout);
            gradientDesc.addBindingLayout(this.bindingLayout);
            gradientDesc.setPrimitiveType(PrimitiveType.TriangleStrip);
            gradientDesc.setDepthState(0, 0, ComparisonFunc.Always);
            gradientDesc.setRasterState(CullMode.Back, FillMode.Solid, 0);
            this.gradientPipeline = this.app.createGraphicsPipelineFromDesc(gradientDesc, this.sceneFramebuffer);
            const paletteDesc = GraphicsPipelineDesc.create(this.paletteVS, this.palettePS);
            paletteDesc.setInputLayout(this.uvLayout);
            paletteDesc.addBindingLayout(this.bindingLayout);
            paletteDesc.setDepthState(0, 0, ComparisonFunc.Always);
            paletteDesc.setRasterState(CullMode.Back, FillMode.Solid, 0);
            this.palettePipeline = this.app.createGraphicsPipelineFromDesc(paletteDesc, this.sceneFramebuffer);

            const setDesc = BindingSetDesc.create();
            setDesc.bindPushConstants(0, ROOT_CONSTANTS_SIZE);
            setDesc.bindTextureSRV(0, this.sceneTexture);
            setDesc.bindTextureSRV(1, this.uiTexture);
            setDesc.bindSampler(0, this.sampler);
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);

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
            const old = this.trianglesBuffer;
            if (old) {
                this.app.releaseResource(old);
            }
            this.trianglesBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Triangles");

            // The UI layer's text goes into its texture.
            this.imguiPass.setFramebuffer(this.uiFramebuffer);
            this.hasTargets = true;
        }

        // RenderScene's first part: the gradients and the triangles into the scene's target, and
        // the UI layer's texture cleared for the ImGui pass after this one.
        onRenderScene(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            if (!this.hasTargets) {
                this.createTargets(commandList, frame.getWidth(), frame.getHeight());
            }
            this.rootConstants[1] = this.displayCurve;

            commandList.clearTextureFloat(this.sceneTexture, 0.0, 0.0, 0.0, 0.0);
            commandList.clearTextureFloat(this.uiTexture, 0.0, 0.0, 0.0, 0.0);

            frame.beginDrawToFramebuffer(this.gradientPipeline, this.sceneFramebuffer);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawAddVertexBuffer(this.gradientBuffer, 0, 0);
            // The standard gradient, then the bright one.
            frame.drawVerticesRangeWithPushConstants(4, 0, Ref(this.rootConstants[0]), ROOT_CONSTANTS_SIZE);
            frame.drawVerticesRangeWithPushConstants(4, 4, Ref(this.rootConstants[0]), ROOT_CONSTANTS_SIZE);

            const trianglesBuffer = this.trianglesBuffer;
            if (trianglesBuffer) {
                frame.beginDrawToFramebuffer(this.palettePipeline, this.framebufferOrScene());
                frame.drawAddBindingSet(this.bindingSet);
                frame.drawAddVertexBuffer(trianglesBuffer, 0, 0);
                for (let t = 0; t < 6; t++) {
                    frame.drawVerticesRangeWithPushConstants(3, t * 3, Ref(this.rootConstants[0]), ROOT_CONSTANTS_SIZE);
                }
            }
        }

        framebufferOrScene() {
            return this.sceneFramebuffer;
        }

        // RenderScene's second part, after the UI: the scene and the UI layer composed and presented
        // into the back buffer (cleared to black first) with the display's curve.
        onRenderPresent(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            if (!this.hasTargets) {
                return;
            }
            if (!this.enableUI) {
                frame.getCommandList().clearTextureFloat(this.uiTexture, 0.0, 0.0, 0.0, 0.0);
            }
            if (!this.hasPresentPipeline) {
                const presentDesc = GraphicsPipelineDesc.create(this.presentVS, this.presentPS);
                presentDesc.setInputLayout(this.uvLayout);
                presentDesc.addBindingLayout(this.bindingLayout);
                presentDesc.setDepthState(0, 0, ComparisonFunc.Always);
                presentDesc.setRasterState(CullMode.Back, FillMode.Solid, 0);
                this.presentPipeline = this.app.createGraphicsPipelineFromDescForFrame(presentDesc, frame);
                this.hasPresentPipeline = true;
            }
            frame.clearColor(0.0, 0.0, 0.0, 1.0);
            frame.beginDraw(this.presentPipeline);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawAddVertexBuffer(this.presentBuffer, 0, 0);
            frame.drawVerticesRangeWithPushConstants(3, 0, Ref(this.rootConstants[0]), ROOT_CONSTANTS_SIZE);
        }

        // A label drawn as DirectWrite lays it out: centered in [left, right] or from left.
        drawLabel(text: string, left: number, right: number, top: number, centered: boolean) {
            let x = left;
            if (centered) {
                x = left + (right - left - Donut_ImGuiCalcTextWidth(text)) * 0.5;
            }
            Donut_ImGuiDrawText(x, top, text, 1.0, 1.0, 1.0, 1.0, 0);
        }

        // UILayer: the format, signal and HDR support at the top; the gradients' and gamuts' names
        // under them; the keys at the bottom left (the sample's tabs as spaces).
        buildUI() {
            if (!this.enableUI || !this.hasTargets) {
                return;
            }
            const w = this.width;
            const h = this.height;
            const fontSize = h / 30.0;
            const smallFontSize = h / 40.0;
            const meta = META_DATA_POOL[this.metaDataIndex];
            this.font.push();
            this.drawLabel(`Back Buffer Format = ${FORMAT_NAMES[this.bitDepth]}`, 0.0, w, 0.0, true);
            this.drawLabel(`Output Signal = ${CURVE_NAMES[this.displayCurve]}`, 0.0, w, fontSize, true);
            this.drawLabel(`Current Output HDR Support = ${this.hdrSupport ? "true" : "false"}`, 0.0, w, fontSize * 2.0, true);
            this.drawLabel("SDR Gradient [0,1]", 0.0, w * 0.5, h * 0.25 + fontSize, true);
            this.drawLabel("HDR Gradient [0,9]", 0.0, w * 0.5, h * 0.75 + fontSize, true);
            this.drawLabel("Rec 709", w * 0.5, w * 0.8, h * 0.25 + fontSize, true);
            this.drawLabel("Rec 2020", w * 0.5, w * 0.8, h * 0.75 + fontSize, true);
            Donut_ImGuiPopFont();
            this.smallFont.push();
            this.drawLabel("PgUp/PgDn    Change back buffer format", smallFontSize, w, h - fontSize * 5.0, false);
            this.drawLabel("H    Toggle between sRGB and ST.2084 (10-bit swap chain only)", smallFontSize, w, h - fontSize * 3.0, false);
            this.drawLabel("U    Toggle UI Visibility", smallFontSize, w, h - fontSize * 2.0, false);
            this.drawLabel(`M    Toggle HDR Meta Data     MaxOutputNits:${meta[0].toFixed(3)}     MinOutputNits:${meta[1].toFixed(3)}     MaxCLL:${meta[2].toFixed(3)}     MaxFALL:${meta[3].toFixed(3)}`,
                smallFontSize, w, h - fontSize, false);
            Donut_ImGuiPopFont();
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

    // The back buffer's pixel (x, y) as RGB, 0 to 1 for UNORM formats and linear for RGBA16_FLOAT,
    // from its raw texels (pixels: the back buffer read back, 4 or 8 bytes a pixel).
    function pixelRGB(pixels: int[], format: Format, width: int, x: int, y: int) {
        if (format == Format.RGBA16_FLOAT) {
            const lo = pixels[(y * width + x) * 2];
            const hi = pixels[(y * width + x) * 2 + 1];
            return [halfToFloat(lo & 0xFFFF), halfToFloat((lo >> 16) & 0xFFFF), halfToFloat(hi & 0xFFFF)];
        }
        const p = pixels[y * width + x];
        if (format == Format.R10G10B10A2_UNORM) {
            return [(p & 0x3FF) / 1023.0, ((p >> 10) & 0x3FF) / 1023.0, ((p >> 20) & 0x3FF) / 1023.0];
        }
        const r = (p & 0xFF) / 255.0;
        const g = ((p >> 8) & 0xFF) / 255.0;
        const b = ((p >> 16) & 0xFF) / 255.0;
        if (format == Format.BGRA8_UNORM || format == Format.SBGRA8_UNORM) {
            return [b, g, r];
        }
        return [r, g, b];
    }

    // -test: checks the last frame (at the back buffer format -testFormat picked), on the gradients'
    // middle rows: the SDR gradient black at its left end, white at its right, rising between; the
    // HDR gradient clipped to white past its first third with the sRGB curve, above 1 in scRGB
    // (linear, its right end pow(3, 2.2)); the right half of the window shows the gamut triangles.
    function checkFrame(app: App, pass: HdrPass) {
        const width = app.getWindowWidth();
        const height = app.getWindowHeight();
        const format = app.getBackBufferFormat();
        const wide = format == Format.RGBA16_FLOAT;
        const pixels: int[] = [];
        for (let i = 0; i < width * height * (wide ? 2 : 1); i++) {
            pixels.push(0);
        }
        const backBuffer = app.getBackBuffer(app.getCurrentBackBufferIndex());
        if (app.readTextureLevel(backBuffer, 0, Ref(pixels[0]), pixels.length * 4) == 0) {
            return "cannot read the back buffer";
        }
        const sdrRow = Math.floor(height * 0.25);
        const hdrRow = Math.floor(height * 0.75);
        const sdrLeft = pixelRGB(pixels, format, width, 0, sdrRow);
        const sdrMiddle = pixelRGB(pixels, format, width, width / 4, sdrRow);
        const sdrRight = pixelRGB(pixels, format, width, width / 2 - 1, sdrRow);
        const hdrMiddle = pixelRGB(pixels, format, width, width / 4, hdrRow);
        const hdrRight = pixelRGB(pixels, format, width, width / 2 - 1, hdrRow);
        console.log(`Format ${format}, curve ${CURVE_NAMES[pass.displayCurve]}: SDR gradient ${sdrLeft[0]} ${sdrMiddle[0]} ${sdrRight[0]}, HDR gradient ${hdrMiddle[0]} ${hdrRight[0]}`);
        if (sdrLeft[0] > 0.02 || sdrRight[0] < 0.97 || !(sdrMiddle[0] > sdrLeft[0] && sdrMiddle[0] < sdrRight[0])) {
            return "the SDR gradient doesn't go from black to white";
        }
        if (pass.displayCurve == Curve.Linear) {
            if (hdrRight[0] < 9.0 || hdrMiddle[0] < 1.5) {
                return "the HDR gradient doesn't go above 1 in scRGB";
            }
        } else if (pass.displayCurve == Curve.Srgb) {
            if (hdrMiddle[0] < 0.99 || hdrRight[0] < 0.99) {
                return "the HDR gradient isn't clipped to white with the sRGB curve";
            }
        }
        // Colored pixels in the right half (the triangles).
        let colored = 0;
        for (let y = 0; y < height; y += 4) {
            for (let x = width / 2; x < width; x += 4) {
                const c = pixelRGB(pixels, format, width, x, y);
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

    class HdrDisplayArgs extends Args {
        // -testFormat 8|10|16: the bits of the back buffers of -test.
        testFormat = 8;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-testFormat" && i + 1 < this.argc) {
                    i++;
                    this.testFormat = parseInt(this[i]);
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("hdr_display");

        // -noui: without the UI layer (U).
        // -test [-testOutput <file>] [-testFormat 8|10|16]: render a few frames without a window,
        // with back buffers of that many bits (8 by default), and check the last one (checkFrame).
        const args = new HdrDisplayArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // The sample's window, with UNORM back buffers, as the sample's R8G8B8A8_UNORM; R10G10B10A2
        // and scRGB too.
        const options = AppOptions.UnormBackBuffer | args.options;
        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, options | AppOptions.HdrBackBuffer);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        const pass = new HdrPass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }
        // The sample starts with 8-bit back buffers.
        pass.setBitDepth(BitDepth.Bits8);
        if (args.noUI) {
            pass.enableUI = false;
        }
        if (args.test && args.testFormat == 10) {
            pass.setBitDepth(BitDepth.Bits10);
        } else if (args.test && args.testFormat == 16) {
            pass.setBitDepth(BitDepth.Bits16);
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result =app.finishTest(checkFrame(app, pass));
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return HdrDisplay.main(argc, argv);
}

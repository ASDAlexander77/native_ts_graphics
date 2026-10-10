// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace SimpleHdr {
    const WINDOW_TITLE = "Donut Example: Simple HDR";
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
    // DroidSans Mono, as wide (its 36 is points; the same text measured 1.6 times as wide as
    // DroidSans Mono at 36 pixels), in layout pixels.
    const FONT_LAYOUT_SIZE = 57.6;
    const FONT_SCALES = [1.0, 0.75, 0.65, 0.4, 1.75];
    const FONT_TITLE = 0;
    const FONT_TEXT = 1;
    const FONT_HELP = 2;
    const FONT_SMALL = 3;
    const FONT_COUNTDOWN = 4;

    // DrawConstants of simple_hdr_scene.hlsl: rect, color, the pixels-to-clip-space scale and offset.
    const DRAW_CONSTANTS_FLOATS = 12;
    // The curve's lines (outline, ticks, graph, selection) for target heights up to 4320 pixels.
    const MAX_LINE_VERTICES = 16384;

    // GLFW keys.
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
    const ACTION_RELEASE = 0;
    const ACTION_PRESS = 1;

    function formatFixed(value: number, digits: int): string {
        let scale = 1.0;
        for (let i = 0; i < digits; i++) {
            scale *= 10.0;
        }
        const scaled = Math.round(Math.abs(value) * scale);
        const whole: int = Math.floor(scaled / scale);
        const fraction: int = scaled - whole * scale;
        let fractionText = `${fraction}`;
        while (fractionText.length < digits) {
            fractionText = "0" + fractionText;
        }
        const sign = value < 0.0 && scaled > 0.0 ? "-" : "";
        return digits > 0 ? `${sign}${whole}.${fractionText}` : `${sign}${whole}`;
    }

    // HDRCommon.h (float arithmetic as the sample's): the ST.2084 curve of a normalized linear
    // value (1.0 = 10,000 nits).
    function linearToST2084(normalizedLinearValue: number): number {
        const p = Math.fround(Math.pow(Math.abs(normalizedLinearValue), Math.fround(0.1593017578)));
        const numerator = Math.fround(Math.fround(0.8359375) + Math.fround(Math.fround(18.8515625) * p));
        const denominator = Math.fround(1.0 + Math.fround(Math.fround(18.6875) * p));
        return Math.fround(Math.pow(Math.fround(numerator / denominator), Math.fround(78.84375)));
    }

    // The same of an HDR scene value (1.0 = paper white).
    function sceneValueToST2084(hdrSceneValue: number, paperWhiteNits: number): number {
        return linearToST2084(Math.fround(Math.fround(hdrSceneValue * paperWhiteNits) / MAX_NITS_FOR_2084));
    }

    // The brightness of an HDR scene value, in nits.
    function calcNits(hdrSceneValue: number, paperWhiteNits: number): number {
        return Math.fround(Math.fround(Math.fround(hdrSceneValue * paperWhiteNits) / MAX_NITS_FOR_2084) * MAX_NITS_FOR_2084);
    }

    // The sample's LinearToSRGB: the sRGB curve of a value clamped to [0, 1] (for the UI).
    function linearToSRGB(hdrSceneValue: number): number {
        const value = Math.min(Math.max(hdrSceneValue, 0.0), 1.0);
        if (value < 0.0031308) {
            return Math.fround(value * 12.92);
        }
        return Math.fround(Math.fround(1.055) * Math.fround(Math.pow(value, Math.fround(1.0 / 2.4))) - Math.fround(0.055));
    }

    // --- Passes -----------------------------------------------------------------------------

    // Port of the Xbox ATG SimpleHDR_PC12 sample (PCSamples/Graphics/SimpleHDR_PC12): an HDR scene
    // (linear, Rec.709 primaries, 1.0 = paper white) of blocks brighter than white, or the ST.2084
    // curve, sent to an HDR10 back buffer (Rec.2020, ST.2084, 10 bits) when the display is in HDR
    // mode, clipped to SDR otherwise; paper white's brightness adjustable, bright blocks shown after
    // a 5 second countdown so that eyes take white as white first.
    //
    // The scene renders in three passes: its blocks or curve (this one), its text (the ImGui pass,
    // drawing into the HDR scene at 1.0 = paper white as the sample's SpriteFont text), then
    // PrepareSwapChainBuffer (a second pass). The display's mode is checked every second (the sample
    // checks when the window moves or the display changes).
    class SimpleHdrPass {
        private app: App;
        private sceneLayout: Opaque;
        private convertLayout: Opaque;
        private rectVS: Opaque;
        private lineVS: Opaque;
        private colorPS: Opaque;
        private quadVS: Opaque;
        private hdr10PS: Opaque;
        private sdrPS: Opaque;
        private pointSampler: Opaque;
        private lineBuffer: BufferHandle;
        private lineVertices: f32[];
        private drawConstants: f32[];
        private convertConstants: f32[];
        // Window-sized, made on the first frame and after each resize.
        private hdrScene: Opaque | null;
        private hdrSceneFramebuffer: Opaque | null;
        private sceneBindingSet: BindingSet;
        private convertBindingSet: BindingSet;
        private rectPipeline: Opaque | null;
        private linePipeline: Opaque | null;
        private hdr10Pipeline: Opaque | null;
        private sdrPipeline: Opaque | null;
        private lastWidth: int;
        private lastHeight: int;
        private colorSpaceCheck: number;

        imguiPass: ImGuiPass;
        fonts: ImGuiFont[];
        frameWidth: int;
        frameHeight: int;
        apiName: string;
        // -sdr: sRGB back buffers (the SDR signal) even on an HDR display.
        forceSdr: boolean;

        // The sample's state.
        render2084Curve: boolean;
        showOnlyPaperWhite: boolean;
        countDownToBright: number;
        current2084CurveRenderingNits: number;
        hdrSceneValues: number[];
        paperWhiteNits: number;

        private upHeld: boolean;
        private downHeld: boolean;
        private shiftHeld: boolean;

        constructor(app: App) {
            this.app = app;
            this.lineVertices = [];
            for (let i = 0; i < MAX_LINE_VERTICES * 2; i++) {
                this.lineVertices.push(0.0);
            }
            this.drawConstants = [];
            for (let i = 0; i < DRAW_CONSTANTS_FLOATS; i++) {
                this.drawConstants.push(0.0);
            }
            this.convertConstants = [0.0, 0.0, 0.0, 0.0];
            this.hdrScene = null;
            this.hdrSceneFramebuffer = null;
            this.sceneBindingSet = new BindingSet(null);
            this.convertBindingSet = new BindingSet(null);
            this.rectPipeline = null;
            this.linePipeline = null;
            this.hdr10Pipeline = null;
            this.sdrPipeline = null;
            this.lastWidth = 0;
            this.lastHeight = 0;
            this.colorSpaceCheck = 0.0;
            this.fonts = [];
            this.frameWidth = 1280;
            this.frameHeight = 720;
            this.apiName = "";
            this.forceSdr = false;
            this.render2084Curve = false;
            this.showOnlyPaperWhite = true;
            this.countDownToBright = 5.0;
            this.current2084CurveRenderingNits = 500.0;
            this.hdrSceneValues = [0.5, 1.0, 6.0, 10.0];
            this.paperWhiteNits = 100.0;
            this.upHeld = false;
            this.downHeld = false;
            this.shiftHeld = false;
        }

        // The sample's DeviceResources::UpdateColorSpace: HDR10 when the window's display is in HDR
        // mode (the swap chain takes it from the next frame on), sRGB otherwise.
        updateColorSpace(): void {
            const wanted = this.app.isDisplayHdr() != 0 && !this.forceSdr ? SwapChainColorSpace.HDR10 : SwapChainColorSpace.SRGB;
            if (wanted != this.app.getSwapChainColorSpace()) {
                this.app.setSwapChainColorSpace(wanted);
            }
        }

        hdrMode(): boolean {
            return this.app.getSwapChainColorSpace() == SwapChainColorSpace.HDR10;
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (key == KEY_UP || key == KEY_RIGHT) {
                this.upHeld = action != ACTION_RELEASE;
            } else if (key == KEY_DOWN || key == KEY_LEFT) {
                this.downHeld = action != ACTION_RELEASE;
            } else if (key == KEY_LEFT_SHIFT || key == KEY_RIGHT_SHIFT) {
                this.shiftHeld = action != ACTION_RELEASE;
            } else if (action == ACTION_PRESS) {
                if (key == KEY_SPACE) {
                    this.render2084Curve = !this.render2084Curve;
                } else if (key == KEY_ENTER || key == KEY_KP_ENTER) {
                    this.showOnlyPaperWhite = !this.showOnlyPaperWhite;
                } else if (key == KEY_MINUS || key == KEY_KP_SUBTRACT) {
                    this.paperWhiteNits = Math.max(this.paperWhiteNits - 20.0, 80.0);
                } else if (key == KEY_EQUAL || key == KEY_KP_ADD) {
                    this.paperWhiteNits = Math.min(this.paperWhiteNits + 20.0, MAX_NITS_FOR_2084);
                }
            }
            return 1;
        }

        // The sample's Update: the countdown, the held keys' changes, and the display's mode.
        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);

            if (this.countDownToBright >= 0.0) {
                this.countDownToBright -= elapsedSeconds;
                if (this.countDownToBright < 0.0) {
                    this.showOnlyPaperWhite = false;
                }
            }

            const steps = elapsedSeconds * STEPS_PER_SECOND;
            const sign = this.upHeld ? 1.0 : this.downHeld ? -1.0 : 0.0;
            if (sign != 0.0) {
                if (this.render2084Curve) {
                    const delta = (this.shiftHeld ? SLOW_NITS_DELTA : FAST_NITS_DELTA) * steps;
                    this.current2084CurveRenderingNits = Math.min(Math.max(this.current2084CurveRenderingNits + sign * delta, 0.0),
                        MAX_NITS_FOR_2084);
                } else {
                    const delta = (this.shiftHeld ? SLOW_SCENE_VALUE_DELTA : FAST_SCENE_VALUE_DELTA) * steps;
                    this.hdrSceneValues[CUSTOM_INPUT_VALUE_INDEX] = Math.min(Math.max(
                        this.hdrSceneValues[CUSTOM_INPUT_VALUE_INDEX] + sign * delta, 0.0), 125.0);
                }
            }

            this.colorSpaceCheck -= elapsedSeconds;
            if (this.colorSpaceCheck <= 0.0) {
                this.updateColorSpace();
                this.colorSpaceCheck = 1.0;
            }
        }

        onBackBufferResizing(): void {
            const sceneSet = this.sceneBindingSet;
            if (!sceneSet.isNull()) {
                this.app.releaseResource(sceneSet.handle);
                this.sceneBindingSet = new BindingSet(null);
            }
            const convertSet = this.convertBindingSet;
            if (!convertSet.isNull()) {
                this.app.releaseResource(convertSet.handle);
                this.convertBindingSet = new BindingSet(null);
            }
            const framebuffer = this.hdrSceneFramebuffer;
            if (framebuffer) {
                this.imguiPass.setFramebuffer(null);
                this.app.releaseResource(framebuffer);
                this.hdrSceneFramebuffer = null;
            }
            const hdrScene = this.hdrScene;
            if (hdrScene) {
                this.app.releaseResource(hdrScene);
                this.hdrScene = null;
            }
        }

        // A rectangle of the sample's layout in one color (SpriteBatch::Draw with ColorPS).
        drawRect(frame: Frame, left: number, top: number, right: number, bottom: number, value: number): void {
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
            frame.beginDrawToFramebuffer(this.rectPipeline as Opaque, this.hdrSceneFramebuffer as Opaque);
            frame.drawAddBindingSet(this.sceneBindingSet);
            frame.drawVerticesWithPushConstants(6, Ref(this.drawConstants[0]), DRAW_CONSTANTS_FLOATS * 4);
        }

        // The sample's RenderHDRScene: four blocks with the HDR scene values (only the paper white
        // one at first). Its text is the UI's.
        renderHDRScene(frame: Frame): void {
            const step = Math.floor(LAYOUT_WIDTH / (NUM_INPUT_VALUES + 2.0));
            let left = 115.0;
            for (let i = 0; i < NUM_INPUT_VALUES; i++) {
                left += step;
                const top = 485.0;
                const right = left + Math.floor(step / 1.25);
                const bottom = top + 250.0;
                const value = this.hdrSceneValues[i];
                if (!this.showOnlyPaperWhite || value == 1.0) {
                    this.drawRect(frame, left, top, right, bottom, value);
                }
            }
        }

        addLine(count: int, x1: number, y1: number, x2: number, y2: number): int {
            this.lineVertices[count * 2] = x1;
            this.lineVertices[count * 2 + 1] = y1;
            this.lineVertices[count * 2 + 2] = x2;
            this.lineVertices[count * 2 + 3] = y2;
            return count + 2;
        }

        // The sample's Render2084Curve: the curve's outline, ticks and graph and the selected
        // brightness's lines in a viewport (lines in its pixels), then a paper white block and one
        // of the selected brightness. Its text is the UI's.
        renderST2084Curve(frame: Frame, commandList: CommandList): void {
            const scale = Math.fround(this.frameHeight / LAYOUT_HEIGHT);
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

            commandList.writeBuffer(this.lineBuffer, Ref(this.lineVertices[0]), n * 8);
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
            frame.beginDrawToFramebuffer(this.linePipeline as Opaque, this.hdrSceneFramebuffer as Opaque);
            frame.drawAddBindingSet(this.sceneBindingSet);
            frame.drawSetViewport(startX * scale, startY * scale, viewportWidth, viewportHeight);
            frame.drawVerticesWithPushConstants(n, Ref(this.drawConstants[0]), DRAW_CONSTANTS_FLOATS * 4);

            // Render blocks
            const size = 150.0;
            const blockLeft = LAYOUT_WIDTH - size * 4.0;
            this.drawRect(frame, blockLeft, 50.0, blockLeft + size, 50.0 + size, 1.0);
            const hdrSceneValue = Math.fround(this.current2084CurveRenderingNits / this.paperWhiteNits);
            this.drawRect(frame, blockLeft + size * 2.0, 50.0, blockLeft + size * 3.0, 50.0 + size, hdrSceneValue);
        }

        createPipelines(frame: Frame): void {
            const rectDesc = GraphicsPipelineDesc.create(this.rectVS, this.colorPS);
            rectDesc.addBindingLayout(this.sceneLayout);
            rectDesc.setDepthState(0, 0, ComparisonFunc.Always);
            rectDesc.setRasterState(CullMode.None, FillMode.Solid, 0);
            this.rectPipeline = this.app.createGraphicsPipelineFromDesc(rectDesc, this.hdrSceneFramebuffer as Opaque);

            const lineDesc = GraphicsPipelineDesc.create(this.lineVS, this.colorPS);
            lineDesc.addBindingLayout(this.sceneLayout);
            lineDesc.setPrimitiveType(PrimitiveType.LineList);
            // The sample's lines are aliased (MultisampleEnable FALSE): D3D's diamond-exit rule,
            // which is Vulkan's Bresenham mode (VK_EXT_line_rasterization), where the device has it.
            if ((this.app.getLineRasterizationModes() & LineRasterization.Bresenham) != 0) {
                lineDesc.setLineRasterization(LineRasterizationMode.Bresenham, 1.0, 0, 1, 0xFFFF);
            }
            lineDesc.setDepthState(0, 0, ComparisonFunc.Always);
            lineDesc.setRasterState(CullMode.None, FillMode.Solid, 0);
            this.linePipeline = this.app.createGraphicsPipelineFromDesc(lineDesc, this.hdrSceneFramebuffer as Opaque);

            for (let i = 0; i < 2; i++) {
                const desc = GraphicsPipelineDesc.create(this.quadVS, i == 0 ? this.hdr10PS : this.sdrPS);
                desc.addBindingLayout(this.convertLayout);
                desc.setDepthState(0, 0, ComparisonFunc.Always);
                desc.setRasterState(CullMode.None, FillMode.Solid, 0);
                const pipeline = this.app.createGraphicsPipelineFromDescForFrame(desc, frame);
                if (i == 0) {
                    this.hdr10Pipeline = pipeline;
                } else {
                    this.sdrPipeline = pipeline;
                }
            }
        }

        // The sample's Clear and scene rendering: the HDR scene, window-sized, cleared to black.
        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            this.frameWidth = width;
            this.frameHeight = height;
            const commandList = frame.getCommandList();

            let hdrScene = this.hdrScene;
            if (!hdrScene) {
                hdrScene = this.app.createRenderTargetTexture(width, height, Format.RGBA16_FLOAT, "HDR Scene");
                this.hdrScene = hdrScene;
                this.hdrSceneFramebuffer = this.app.createFramebuffer(hdrScene, null);

                const sceneDesc = BindingSetDesc.create();
                sceneDesc.bindPushConstants(0, DRAW_CONSTANTS_FLOATS * 4);
                sceneDesc.bindStructuredBufferSRV(0, this.lineBuffer);
                this.sceneBindingSet = this.app.createBindingSetForLayout(sceneDesc, this.sceneLayout);

                const convertDesc = BindingSetDesc.create();
                convertDesc.bindPushConstants(0, 16);
                convertDesc.bindTextureSRV(0, hdrScene);
                convertDesc.bindSampler(0, this.pointSampler);
                this.convertBindingSet = this.app.createBindingSetForLayout(convertDesc, this.convertLayout);

                // CreateWindowSizeDependentResources: the countdown again after a resize (not after a
                // color space change, which comes as one).
                if ((width != this.lastWidth || height != this.lastHeight) && this.lastWidth != 0 && !this.render2084Curve) {
                    this.countDownToBright = 5.0;
                    this.showOnlyPaperWhite = true;
                }
                this.lastWidth = width;
                this.lastHeight = height;
            }
            if (!this.rectPipeline) {
                this.createPipelines(frame);
            }
            // The text goes into the HDR scene too.
            this.imguiPass.setFramebuffer(this.hdrSceneFramebuffer);

            commandList.clearTextureFloat(hdrScene, 0.0, 0.0, 0.0, 1.0);
            if (this.render2084Curve) {
                // Render the ST.2084 curve
                this.renderST2084Curve(frame, commandList);
            } else {
                // Render the HDR scene with values larger than 1.0f, which will be perceived as bright
                this.renderHDRScene(frame);
            }
        }

        // The sample's PrepareSwapChainBuffer: the HDR scene as HDR10 (Rec.2020, ST.2084) into the
        // back buffer when it is in that color space, clipped to SDR otherwise.
        onRenderPrepareSwapChain(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            this.convertConstants[0] = this.paperWhiteNits;
            const pipeline = this.hdrMode() ? this.hdr10Pipeline : this.sdrPipeline;
            if (!pipeline || this.convertBindingSet.isNull()) {
                return;
            }
            frame.beginDraw(pipeline as Opaque);
            frame.drawAddBindingSet(this.convertBindingSet);
            frame.drawVerticesWithPushConstants(3, Ref(this.convertConstants[0]), 16);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.pointSampler = this.app.getCommonSampler(CommonSampler.PointClamp);

            const sceneLayoutDesc = BindingLayoutDesc.create();
            sceneLayoutDesc.layoutPushConstants(0, DRAW_CONSTANTS_FLOATS * 4);
            sceneLayoutDesc.layoutStructuredBufferSRV(0);
            this.sceneLayout = this.app.createBindingLayout(sceneLayoutDesc, ShaderType.All);
            const convertLayoutDesc = BindingLayoutDesc.create();
            convertLayoutDesc.layoutPushConstants(0, 16);
            convertLayoutDesc.layoutTextureSRV(0);
            convertLayoutDesc.layoutSampler(0);
            this.convertLayout = this.app.createBindingLayout(convertLayoutDesc, ShaderType.All);

            this.rectVS = this.app.createShader("simple_hdr_scene.hlsl", "rect_vs", ShaderType.Vertex);
            this.lineVS = this.app.createShader("simple_hdr_scene.hlsl", "line_vs", ShaderType.Vertex);
            this.colorPS = this.app.createShader("simple_hdr_scene.hlsl", "color_ps", ShaderType.Pixel);
            this.quadVS = this.app.createShader("simple_hdr_convert.hlsl", "quad_vs", ShaderType.Vertex);
            this.hdr10PS = this.app.createShader("simple_hdr_convert.hlsl", "prepare_hdr10_ps", ShaderType.Pixel);
            this.sdrPS = this.app.createShader("simple_hdr_convert.hlsl", "tonemap_sdr_ps", ShaderType.Pixel);
            if (!this.rectVS || !this.lineVS || !this.colorPS || !this.quadVS || !this.hdr10PS || !this.sdrPS) {
                return false;
            }
            this.lineBuffer = this.app.createStructuredBuffer(8, MAX_LINE_VERTICES, "Lines");

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        // The second pass, after the ImGui one.
        initPrepareSwapChain(): void {
            const pass = this.app.addPass();
            pass.setRenderCallback(this.onRenderPrepareSwapChain);
        }
    }

    // The sample's text (SpriteFont there): white, so 1.0 in the HDR scene, which is paper white.
    class UserInterface {
        private sample: SimpleHdrPass;

        constructor(sample: SimpleHdrPass) {
            this.sample = sample;
        }

        // Text at the sample's layout position, in one of its font scales; right-aligned at x if
        // alignRight (where the sample's text is rotated by -90 degrees).
        text(font: int, x: number, y: number, text: string, alignRight: boolean): void {
            const sample = this.sample;
            sample.fonts[font].push();
            Donut_ImGuiDrawText(x * sample.frameWidth / LAYOUT_WIDTH, y * sample.frameHeight / LAYOUT_HEIGHT, text,
                1.0, 1.0, 1.0, 1.0, alignRight ? 1 : 0);
            Donut_ImGuiPopFont();
        }

        // RenderHDRScene's text: the values of each block, in the HDR scene, SDR and HDR10.
        hdrSceneText(): void {
            const sample = this.sample;
            const step = Math.floor(LAYOUT_WIDTH / (NUM_INPUT_VALUES + 2.0));
            const startY = 40.0;
            const startX = 50.0;
            let y = startY + 270.0;
            this.text(FONT_TEXT, startX, y, "HDR Scene Values", false);
            this.text(FONT_TEXT, startX, y + 40.0, "SDR sRGB Curve", false);
            this.text(FONT_TEXT, startX, y + 80.0, "HDR ST.2084 Curve", false);
            this.text(FONT_TEXT, startX, y + 120.0, "HDR Nits Output", false);

            let x = startX + 100.0;
            for (let i = 0; i < NUM_INPUT_VALUES; i++) {
                const hdrSceneValue = sample.hdrSceneValues[i];
                x += step;
                this.text(FONT_TEXT, x, y, formatFixed(hdrSceneValue, 6), false);
                this.text(FONT_TEXT, x, y + 40.0, formatFixed(linearToSRGB(hdrSceneValue), 6), false);
                this.text(FONT_TEXT, x, y + 80.0, formatFixed(sceneValueToST2084(hdrSceneValue, sample.paperWhiteNits), 6), false);
                this.text(FONT_TEXT, x, y + 120.0, formatFixed(calcNits(hdrSceneValue, sample.paperWhiteNits), 6), false);
            }

            y = startY + 700.0;
            x = startX + 100.0 + step + step - 15.0;
            this.text(FONT_TEXT, x, y, "Paper White", false);
            if (!sample.showOnlyPaperWhite) {
                this.text(FONT_TEXT, x + step + 45.0, y, "Bright", false);
            }
        }

        // Render2084Curve's text: the axes' ends and the selected brightness.
        curveText(): void {
            const sample = this.sample;
            const startX = 150.0;
            const startY = 250.0;
            const viewportWidth = 1675.0;
            const viewportHeight = 600.0;
            let y = startY + viewportHeight + 5.0;
            this.text(FONT_SMALL, startX - 100.0, y, "Linear", false);
            this.text(FONT_SMALL, startX - 100.0, y + 20.0, "Nits", false);
            this.text(FONT_SMALL, startX - 100.0, y + 40.0, "HDR Scene", false);

            this.text(FONT_SMALL, startX + viewportWidth - 5.0, y, "1.0", false);      // Always [0..1]
            this.text(FONT_SMALL, startX + viewportWidth - 5.0, y + 20.0, "10K", false);  // Spec defines 10K nits
            // Max HDR scene value changes as white paper nits change
            this.text(FONT_SMALL, startX + viewportWidth - 5.0, y + 40.0, formatFixed(MAX_NITS_FOR_2084 / sample.paperWhiteNits, 0), false);

            const normalizedLinearValue = Math.fround(sample.current2084CurveRenderingNits / MAX_NITS_FOR_2084);
            const normalizedNonLinearValue = linearToST2084(normalizedLinearValue);
            const hdrSceneValue = sample.current2084CurveRenderingNits / sample.paperWhiteNits;
            const x = normalizedLinearValue * viewportWidth + 1.0;
            const curveY = viewportHeight - normalizedNonLinearValue * viewportHeight;
            this.text(FONT_SMALL, startX + x, y, formatFixed(normalizedLinearValue, 2), false);
            this.text(FONT_SMALL, startX + x, y + 20.0, formatFixed(sample.current2084CurveRenderingNits, 0), false);
            this.text(FONT_SMALL, startX + x, y + 40.0, formatFixed(hdrSceneValue, 2), false);

            // The sample's vertical labels (rotated by -90 degrees), here horizontal, right-aligned
            // left of the curve.
            this.text(FONT_SMALL, startX - 5.0, startY - 50.0, "ST.2084", true);
            this.text(FONT_SMALL, startX - 5.0, startY - 30.0, "Nits", true);
            this.text(FONT_SMALL, startX - 5.0, curveY + startY - 20.0, formatFixed(normalizedNonLinearValue, 2), true);
            this.text(FONT_SMALL, startX - 5.0, curveY + startY, formatFixed(sample.current2084CurveRenderingNits, 0), true);

            // Text for blocks
            const size = 150.0;
            this.text(FONT_SMALL, LAYOUT_WIDTH - size * 4.0 - 5.0, 50.0 + size / 2.0, "Paper White", true);
            y = 50.0 + size;
            this.text(FONT_SMALL, LAYOUT_WIDTH - size * 4.0 + 25.0, y, `${formatFixed(sample.paperWhiteNits, 0)} nits`, false);
            this.text(FONT_SMALL, LAYOUT_WIDTH - size * 4.0 + 25.0 + size * 2.0, y, `${formatFixed(sample.current2084CurveRenderingNits, 0)} nits`, false);
        }

        // The sample's RenderUI, with its keyboard controls.
        buildUI(): void {
            const sample = this.sample;
            const startX = 50.0;
            const startY = 40.0;
            this.text(FONT_TITLE, startX, startY, `SimpleHDR Sample for ${sample.apiName}`, false);

            if (sample.render2084Curve) {
                this.curveText();
            } else {
                this.text(FONT_TEXT, startX, startY + 100.0, sample.hdrMode() ? "TV in HDR Mode: TRUE" : "TV in HDR Mode: FALSE", false);
                this.hdrSceneText();
            }

            this.text(FONT_HELP, startX, 955.0, "Space - Toggle displaying ST.2084 curve", false);
            this.text(FONT_HELP, startX, 990.0, "Enter - Toggle displaying only paper white block", false);
            this.text(FONT_HELP, LAYOUT_WIDTH / 2.0 + startX, 955.0, "+ / - - Adjust paper white nits", false);
            this.text(FONT_HELP, LAYOUT_WIDTH / 2.0 + startX, 990.0, "Up/Down - Adjust values quickly", false);
            this.text(FONT_HELP, LAYOUT_WIDTH / 2.0 + startX, 1025.0, "Shift + Up/Down - Adjust values slowly", false);

            if (sample.countDownToBright >= 0.0) {
                this.text(FONT_COUNTDOWN, 1170.0, 550.0, formatFixed(sample.countDownToBright, 0), false);
            }
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App, height: int): boolean {
            const imguiPass = app.addImGuiPass(this.buildUI);
            if (imguiPass.isNull()) {
                return false;
            }
            this.sample.imguiPass = imguiPass;
            for (let i = 0; i < FONT_SCALES.length; i++) {
                const font = imguiPass.createFont(FONT_PATH, FONT_LAYOUT_SIZE * FONT_SCALES[i] * height / LAYOUT_HEIGHT);
                if (font.isNull()) {
                    console.log("Cannot load the font: set DONUT_SAMPLES_MEDIA_DIR when configuring");
                    return false;
                }
                this.sample.fonts.push(font);
            }
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("simple_hdr");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -curve: start with the ST.2084 curve. -bright: the bright blocks without the countdown.
        // -sdr: the SDR signal (sRGB back buffers) even on an HDR display.
        let options = AppOptions.HdrBackBuffer;
        let curve = false;
        let bright = false;
        let sdr = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-curve") {
                curve = true;
            } else if (arg == "-bright") {
                bright = true;
            } else if (arg == "-sdr") {
                sdr = true;
            }
        }

        // The sample's 1920 x 1080, in a smaller window.
        const width = 1280;
        const height = 720;
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, width, height, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        // The scene, its text, then the HDR10 / SDR signal.
        const sample = new SimpleHdrPass(app);
        if (!sample.init()) {
            app.destroy();
            return 1;
        }
        const ui = new UserInterface(sample);
        if (!ui.init(app, height)) {
            app.destroy();
            return 1;
        }
        sample.initPrepareSwapChain();
        sample.apiName = api == GraphicsAPI.D3D11 ? "DirectX 11" : api == GraphicsAPI.D3D12 ? "DirectX 12" : "Vulkan";
        sample.render2084Curve = curve;
        sample.forceSdr = sdr;
        if (bright) {
            sample.countDownToBright = -1.0;
            sample.showOnlyPaperWhite = false;
        }
        sample.updateColorSpace();
        console.log(`Display in HDR mode: ${app.isDisplayHdr() != 0 ? "yes" : "no"}`);

        const input = new InputPass(app.handle);

        app.run();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return SimpleHdr.main(argc, argv);
}

// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace SimpleCompute {
    const WINDOW_TITLE = "Donut Example: Simple Compute";
    const FONT_PATH = "media/fonts/OpenSans/OpenSans-Regular.ttf";
    // The sample's SegoeUI_18 sprite font, its lines 32 pixels apart.
    // ImGui sizes a font by its ascent + descent (1.3618 OpenSans ems), so the 23 pixel em that gives
    // its strings' widths is 31.5.
    const FONT_SIZE = 31.5;
    const LINE_SPACING = 32.0;

    // The fractal textures are 1920 x 1080 whatever the window's size, computed in groups of
    // 8 x 8 threads (fractal_cs in simple_compute.hlsl).
    const TEXTURE_WIDTH = 1920;
    const TEXTURE_HEIGHT = 1080;
    const NUM_SHADER_THREADS = 8;
    const FRACTAL_MAX_ITERATIONS = 300;
    // CB_FractalCS: MaxThreadIter and Window, two float4s.
    const PUSH_CONSTANTS_SIZE = 32;
    // The color maps: 8 x 1 R8G8B8A8_UNORM.
    const COLOR_MAP_SIZE = 8;
    // The async compute worker's textures: one shown, one computed.
    const NUM_ASYNC_TEXTURES = 2;
    // SmoothedFPS's default interval.
    const FPS_FRAME_INTERVAL = 100;

    // ATG::Colors::Background (#414141), stored as is in the UNORM back buffer as the sample's.
    const BACKGROUND = 0.254901975;

    // GLFW keys.
    const KEY_SPACE = 32;
    const KEY_A = 65;
    const KEY_D = 68;
    const KEY_S = 83;
    const KEY_W = 87;
    const KEY_PAGE_UP = 266;
    const KEY_PAGE_DOWN = 267;
    const KEY_HOME = 268;
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

    // An R8G8B8A8_UNORM texel (the sample's 0xAABBGGRR values), opaque.
    function texel(r: int, g: int, b: int): int {
        return r | (g << 8) | (b << 16) | (255 << 24);
    }

    // --- The sample ---------------------------------------------------------------------------

    // Port of SimpleComputePC12.cpp: a compute shader draws a Mandelbrot fractal into a texture,
    // which is stretched over the window. Synchronous compute dispatches it in the frame's command
    // list (with the gradient color map); asynchronous compute has a worker thread dispatch it on
    // the compute queue, as fast as the render thread hands back the texture it stops showing (with
    // the rainbow color map). Space switches between the two.
    //
    // The worker thread (Donut_CreateAsyncComputeLoop) is C++: tslang code can't run on threads its
    // GC doesn't know about. It runs the same pipeline with the latest push constants. Port: the
    // synchronous path has a texture of its own (the sample's two textures swap roles in both
    // modes), shown until the worker's first run after a switch to async compute.
    class SimpleComputePass {
        private app: App;
        private computePipeline: Opaque;
        private syncTexture: Opaque;
        private syncBindingSet: BindingSet;
        private computeLoop: AsyncComputeLoop;
        private held: boolean[];
        // CB_FractalCS: MaxThreadIter (texture width, height, max iterations, 0), Window (scale x,
        // y, center x, y).
        private constants: f32[];

        // The last frame's size, for the HUD.
        frameWidth: int;
        frameHeight: int;
        hasAsyncCompute: boolean;
        usingAsyncCompute: boolean;
        // The worker's run count when async compute was last switched on.
        runsAtResume: int;

        // SmoothedFPS: frames (runs) and their time since the last update.
        renderFPS: number;
        private renderFrames: int;
        private renderTime: number;
        computeFPS: number;
        private computeRuns: int;
        private computeTime: number;
        // The worker's run count when last looked at.
        private lastRunCount: int;

        constructor(app: App) {
            this.app = app;
            this.held = [];
            for (let i = 0; i < 512; i++) {
                this.held.push(false);
            }
            this.constants = [TEXTURE_WIDTH, TEXTURE_HEIGHT, FRACTAL_MAX_ITERATIONS, 0.0, 0.0, 0.0, 0.0, 0.0];
            this.frameWidth = 1280;
            this.frameHeight = 720;
            this.hasAsyncCompute = false;
            this.usingAsyncCompute = false;
            this.runsAtResume = 0;
            this.renderFPS = 0.0;
            this.renderFrames = 0;
            this.renderTime = 0.0;
            this.computeFPS = 0.0;
            this.computeRuns = 0;
            this.computeTime = 0.0;
            this.lastRunCount = 0;
            this.resetWindow();
        }

        resetWindow(): void {
            this.constants[4] = 4.0;
            this.constants[5] = 2.25;
            this.constants[6] = -0.65;
            this.constants[7] = 0.0;
        }

        // The fractal window, for -window.
        setWindow(x: number, y: number, z: number, w: number): void {
            this.constants[4] = x;
            this.constants[5] = y;
            this.constants[6] = z;
            this.constants[7] = w;
        }

        setUsingAsyncCompute(value: boolean): void {
            if (!this.hasAsyncCompute) {
                return;
            }
            this.usingAsyncCompute = value;
            if (value) {
                this.runsAtResume = this.computeLoop.getRunCount();
                this.lastRunCount = this.runsAtResume;
            }
            this.computeLoop.setPaused(value ? 0 : 1);
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (key >= 0 && key < 512) {
                this.held[key] = action != ACTION_RELEASE;
            }
            if (action == ACTION_PRESS) {
                if (key == KEY_SPACE) {
                    this.setUsingAsyncCompute(!this.usingAsyncCompute);
                } else if (key == KEY_HOME) {
                    this.resetWindow();
                }
            }
            return 1;
        }

        // Sample::Update: the smoothed rates, then the held keys pan and zoom the window.
        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            const elapsedTime = Math.fround(elapsedSeconds);

            this.renderTime += elapsedTime;
            this.renderFrames++;
            if (this.renderFrames >= FPS_FRAME_INTERVAL) {
                this.renderFPS = FPS_FRAME_INTERVAL / this.renderTime;
                this.renderTime = 0.0;
                this.renderFrames = 0;
            }

            // The worker's rate: its runs over the time async compute was on.
            if (this.usingAsyncCompute) {
                const runCount = this.computeLoop.getRunCount();
                this.computeRuns += runCount - this.lastRunCount;
                this.lastRunCount = runCount;
                this.computeTime += elapsedTime;
                if (this.computeRuns >= FPS_FRAME_INTERVAL) {
                    this.computeFPS = this.computeRuns / this.computeTime;
                    this.computeTime = 0.0;
                    this.computeRuns = 0;
                }
            }

            const held = this.held;
            if (held[KEY_W] || held[KEY_S] || held[KEY_A] || held[KEY_D] || held[KEY_PAGE_UP] || held[KEY_PAGE_DOWN]) {
                let scaleSpeed = 1.0;
                if (held[KEY_LEFT_SHIFT] || held[KEY_RIGHT_SHIFT]) {
                    scaleSpeed = 4.0;
                }
                let zoom = 0.0;
                if (held[KEY_PAGE_DOWN]) {
                    zoom = 1.0;
                } else if (held[KEY_PAGE_UP]) {
                    zoom = -1.0;
                }
                let x = 0.0;
                if (held[KEY_D]) {
                    x = 1.0;
                } else if (held[KEY_A]) {
                    x = -1.0;
                }
                let y = 0.0;
                if (held[KEY_W]) {
                    y = 1.0;
                } else if (held[KEY_S]) {
                    y = -1.0;
                }

                const windowScale = Math.fround(1.0 + Math.fround(Math.fround(zoom * scaleSpeed) * elapsedTime));
                const c = this.constants;
                c[4] = Math.fround(c[4] * windowScale);
                c[5] = Math.fround(c[5] * windowScale);
                c[6] = Math.fround(c[6] + Math.fround(Math.fround(Math.fround(c[4] * x) * elapsedTime) * 0.5));
                c[7] = Math.fround(c[7] + Math.fround(Math.fround(Math.fround(c[5] * y) * elapsedTime) * 0.5));
            }
        }

        // Sample::Render: the fractal (computed now, or the worker's newest), stretched over the
        // window by a linear clamped blit as SpriteBatch draws it.
        onRender(frameHandle: Opaque): void {
            const frame = new Frame(frameHandle);
            this.frameWidth = frame.getWidth();
            this.frameHeight = frame.getHeight();

            let texture = this.syncTexture;
            if (this.usingAsyncCompute) {
                this.computeLoop.setPushConstants(Ref(this.constants[0]), PUSH_CONSTANTS_SIZE);
                const computed = this.computeLoop.acquireTexture(frame);
                if (computed) {
                    if (this.computeLoop.getRunCount() > this.runsAtResume) {
                        texture = computed;
                    }
                }
            } else {
                // The window is updated every frame (the sample never clears m_windowUpdated).
                frame.getCommandList().dispatchWithPushConstants(this.computePipeline, this.syncBindingSet,
                    Ref(this.constants[0]), PUSH_CONSTANTS_SIZE,
                    TEXTURE_WIDTH / NUM_SHADER_THREADS, TEXTURE_HEIGHT / NUM_SHADER_THREADS, 1);
            }

            frame.clearColor(BACKGROUND, BACKGROUND, BACKGROUND, 1.0);
            this.app.blitTexture(frame, texture);
        }

        // Joins the worker thread; before Donut_DestroyApp.
        stop(): void {
            if (this.hasAsyncCompute) {
                this.computeLoop.stop();
            }
        }

        // A color map texture of 8 texels, uploaded by an open command list. It rests at
        // NonPixelShaderResource, which the compute queue can use.
        createColorMap(commandList: CommandList, texels: int[], name: string): Opaque {
            const texture = this.app.createComputeTexture(COLOR_MAP_SIZE, 1, Format.RGBA8_UNORM, name);
            commandList.writeTextureLevel(texture, 0, Ref(texels[0]), COLOR_MAP_SIZE * 4);
            return texture;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const computeShader = this.app.createShader("simple_compute.hlsl", "fractal_cs", ShaderType.Compute);
            if (!computeShader) {
                return false;
            }

            let gradientTexels: int[] = [
                texel(0x40, 0x00, 0x00), texel(0x80, 0x00, 0x00), texel(0xC0, 0x00, 0x00), texel(0xFF, 0x00, 0x00),
                texel(0xFF, 0x40, 0x00), texel(0xFF, 0x80, 0x00), texel(0xFF, 0xC0, 0x00), texel(0xFF, 0xFF, 0x00),
            ];
            let rainbowTexels: int[] = [
                texel(0xFF, 0x00, 0x00), texel(0xFF, 0x80, 0x00), texel(0xFF, 0xFF, 0x00), texel(0x00, 0xFF, 0x00),
                texel(0x00, 0xFF, 0xFF), texel(0x00, 0x00, 0xFF), texel(0x00, 0x00, 0x80), texel(0xFF, 0x00, 0xFF),
            ];
            const commandList = this.app.createCommandList();
            commandList.open();
            const gradient = this.createColorMap(commandList, gradientTexels, "Fractal Color Map 0");
            const rainbow = this.createColorMap(commandList, rainbowTexels, "Fractal Color Map 1");
            commandList.close();
            this.app.executeCommandList(commandList);

            // MinMagMipPointUVWClamp.
            const sampler = this.app.getCommonSampler(CommonSampler.PointClamp);

            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutPushConstants(0, PUSH_CONSTANTS_SIZE);
            layoutDesc.layoutTextureUAV(0);
            layoutDesc.layoutTextureSRV(0);
            layoutDesc.layoutSampler(0);
            const bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.Compute);
            this.computePipeline = this.app.createComputePipelineWithLayout(computeShader, bindingLayout);

            this.syncTexture = this.app.createUAVTexture(TEXTURE_WIDTH, TEXTURE_HEIGHT, "Fractal Texture");
            const syncDesc = BindingSetDesc.create();
            syncDesc.bindPushConstants(0, PUSH_CONSTANTS_SIZE);
            syncDesc.bindTextureUAV(0, this.syncTexture);
            syncDesc.bindTextureSRV(0, gradient);
            syncDesc.bindSampler(0, sampler);
            this.syncBindingSet = this.app.getCachedBindingSet(syncDesc, bindingLayout);

            const computeLoop = this.app.createAsyncComputeLoop(this.computePipeline, bindingLayout,
                TEXTURE_WIDTH / NUM_SHADER_THREADS, TEXTURE_HEIGHT / NUM_SHADER_THREADS, 0);
            this.computeLoop = computeLoop;
            this.hasAsyncCompute = !computeLoop.isNull();
            if (this.hasAsyncCompute) {
                for (let i = 0; i < NUM_ASYNC_TEXTURES; i++) {
                    const texture = this.app.createUAVTexture(TEXTURE_WIDTH, TEXTURE_HEIGHT, `Async Fractal Texture ${i}`);
                    const asyncDesc = BindingSetDesc.create();
                    asyncDesc.bindPushConstants(0, PUSH_CONSTANTS_SIZE);
                    asyncDesc.bindTextureUAV(0, texture);
                    asyncDesc.bindTextureSRV(0, rainbow);
                    asyncDesc.bindSampler(0, sampler);
                    computeLoop.addTextureWithBindingSet(texture, this.app.getCachedBindingSet(asyncDesc, bindingLayout));
                }
                computeLoop.setPushConstants(Ref(this.constants[0]), PUSH_CONSTANTS_SIZE);
                computeLoop.setPaused(1);
                computeLoop.start();
            } else {
                console.log("The graphics device has no compute queue: synchronous compute only");
            }

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setAnimateCallback(this.onAnimate);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's HUD (SpriteFont text in the title-safe area): the rates at the top, the controls
    // at the bottom.
    class UserInterface {
        private sample: SimpleComputePass;
        private app: App;

        font: ImGuiFont;

        constructor(sample: SimpleComputePass, app: App) {
            this.sample = sample;
            this.app = app;
        }

        line(x: number, y: number, text: string): void {
            Donut_ImGuiDrawText(x, y, text, 1.0, 1.0, 1.0, 1.0, 0);
        }

        buildUI(): void {
            const sample = this.sample;
            const width = sample.frameWidth;
            const height = sample.frameHeight;
            // SimpleMath::Viewport::ComputeTitleSafeArea
            const safeW = Math.fround((width + 19.0) / 20.0);
            const safeH = Math.fround((height + 19.0) / 20.0);
            const left: int = Math.floor(safeW);
            const top: int = Math.floor(safeH);
            const bottom: int = Math.floor(height - safeH + 0.5);

            this.font.push();
            this.line(left, top, `Simple Compute Context ${formatFixed(sample.renderFPS, 2)} fps`);
            if (sample.usingAsyncCompute) {
                this.line(left, top + LINE_SPACING, `Asynchronous compute ${formatFixed(sample.computeFPS, 2)} fps`);
            } else {
                this.line(left, top + LINE_SPACING, `Synchronous compute ${formatFixed(sample.renderFPS, 2)} fps`);
            }
            this.line(left, bottom - LINE_SPACING,
                "WASD: Pan viewport   PageUp/Down: Zoom viewport    Space: Toggle async   Esc: Exit");
            Donut_ImGuiPopFont();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(): boolean {
            const imguiPass = this.app.addImGuiPass(this.buildUI);
            if (imguiPass.isNull()) {
                return false;
            }
            this.font = imguiPass.createFont(FONT_PATH, FONT_SIZE);
            if (this.font.isNull()) {
                console.log("Cannot load the font: set DONUT_SAMPLES_MEDIA_DIR when configuring");
                return false;
            }
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("simple_compute");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -async: start with asynchronous compute (Space toggles it).
        // -window X Y CX CY: the fractal window's size and center instead of the default (Home).
        let options = AppOptions.ComputeQueue | AppOptions.UnormBackBuffer;
        let startAsync = false;
        let hasWindow = false;
        let windowValues: number[] = [0.0, 0.0, 0.0, 0.0];
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-async") {
                startAsync = true;
            } else if (arg == "-window" && i + 4 < argc) {
                for (let j = 0; j < 4; j++) {
                    windowValues[j] = parseFloat(Donut_GetArg(argv, i + 1 + j));
                }
                hasWindow = true;
                i += 4;
            }
        }

        // The sample's B8G8R8A8_UNORM back buffers, in a 1280 x 720 window.
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new SimpleComputePass(app);
        if (!sample.init()) {
            app.destroy();
            return 1;
        }
        if (hasWindow) {
            sample.setWindow(windowValues[0], windowValues[1], windowValues[2], windowValues[3]);
        }
        sample.setUsingAsyncCompute(startAsync);

        const ui = new UserInterface(sample, app);
        if (!ui.init()) {
            sample.stop();
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        sample.stop();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return SimpleCompute.main(argc, argv);
}

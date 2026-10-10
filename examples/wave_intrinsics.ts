// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace WaveIntrinsics {
    const WINDOW_TITLE = "D3D12 Shader Model 6 WaveIntrinsics Sample";
    const FONT_PATH = "media/fonts/OpenSans/OpenSans-Regular.ttf";
    // The sample's UI text: Arial at height / 40 (18 px in its 720-pixel window), lines its height
    // apart (ascent + descent + line gap: 1.149 em). OpenSans at this ImGui size (its ascent +
    // descent) matches the glyphs' sizes.
    const FONT_SIZE_PER_HEIGHT = 23.0 / 720.0;
    const LINE_SPACING_PER_HEIGHT = 20.7 / 720.0;

    const KEY_1 = 49;
    const KEY_9 = 57;
    const ACTION_RELEASE = 0;
    const ACTION_PRESS = 1;
    const MOUSE_BUTTON_LEFT = 0;

    // SceneConstantBuffer: orthProjMatrix, mousePosition, resolution, time, renderMode, laneSize,
    // padding to 256 bytes.
    const CB_SIZE = 256;

    // Pass 1's triangle: position, color.
    const TRIANGLE_VERTICES = [
        0.0, 0.5, 0.0, 0.8, 0.8, 0.0, 1.0,
        0.5, -0.5, 0.0, 0.0, 0.8, 0.8, 1.0,
        -0.5, -0.5, 0.0, 0.8, 0.0, 0.8, 1.0,
    ];
    const TRIANGLE_STRIDE = 28;

    // UILayer's labels, the selected one marked "[x]".
    const LABELS = [
        "Press 1~9 to switch render mode.",
        "1. Normal render.",
        "2. Color pixels by lane indices.",
        "3. Show first lane (white dot) in each wave.",
        "4. Show first(white dot) and last(red dot) lanes in each wave.",
        "5. Color pixels by active lane ratio (white = 100%; black = 0%).",
        "6. Broadcast the color of the first active lane to the wave.",
        "7. Average the color in a wave.",
        "8. Color pixels by prefix sum of distance between current and first lane.",
        "9. Color pixels by their quad id.",
    ];

    // Port of DirectX-Graphics-Samples' D3D12SM6WaveIntrinsics: a triangle drawn into a texture with
    // its pixels colored by one of nine wave intrinsics demonstrations (lane indices, first and last
    // lanes, active lane ratios, broadcasts, wave averages, prefix sums, quad ids), then that
    // texture composed with a UI layer into the back buffer, magnified around the mouse while its
    // left button is held. Keys 1-9 pick the render mode.
    class WaveIntrinsicsPass {
        private app: App;
        private sceneLayout: Opaque;
        private composeLayout: Opaque;
        private waveVS: ShaderHandle;
        private wavePS: ShaderHandle;
        private magnifyVS: ShaderHandle;
        private magnifyPS: ShaderHandle;
        private waveInputLayout: InputLayoutHandle;
        private magnifyInputLayout: InputLayoutHandle;
        private triangleBuffer: BufferHandle;
        private quadBuffer: BufferHandle;
        private constantBuffer: BufferHandle;
        private sampler: SamplerHandle;
        // The size-dependent ones, made on the first frame and on resizes.
        private hasTargets: boolean;
        private sceneTexture: TextureHandle;
        private sceneFramebuffer: Opaque;
        private uiTexture: TextureHandle;
        private uiFramebuffer: Opaque;
        private wavePipeline: Opaque;
        private hasComposePipeline: boolean;
        private composePipeline: Opaque;
        private sceneBindingSet: BindingSet;
        private composeBindingSet: BindingSet;
        private constants: f32[];
        private constantInts: int[];

        renderMode: int;
        // WaveLaneCountMin: the shaders' laneSize.
        laneCount: int;
        private mousePosition: number[];
        private mouseLeftButtonDown: boolean;
        private width: int;
        private height: int;

        imguiPass: ImGuiPass;
        private font: ImGuiFont;
        private fontHeight: int;

        constructor(app: App) {
            this.app = app;
            this.hasTargets = false;
            this.hasComposePipeline = false;
            this.sceneBindingSet = new BindingSet(null);
            this.composeBindingSet = new BindingSet(null);
            this.constants = [];
            for (let i = 0; i < CB_SIZE / 4; i++) {
                this.constants.push(0.0);
            }
            this.constantInts = [0, 0];
            this.renderMode = 1;
            this.laneCount = 0;
            this.width = 1280;
            this.height = 720;
            this.mousePosition = [640.0, 360.0];
            this.mouseLeftButtonDown = false;
            this.fontHeight = 0;
        }

        onBackBufferResizing(): void {
            if (!this.hasTargets) {
                return;
            }
            this.imguiPass.setFramebuffer(null);
            this.app.releaseResource(this.sceneBindingSet.handle);
            this.app.releaseResource(this.composeBindingSet.handle);
            this.sceneBindingSet = new BindingSet(null);
            this.composeBindingSet = new BindingSet(null);
            this.app.releaseResource(this.wavePipeline);
            this.app.releaseResource(this.sceneFramebuffer);
            this.app.releaseResource(this.uiFramebuffer);
            this.app.releaseResource(this.sceneTexture);
            this.app.releaseResource(this.uiTexture);
            this.app.releaseResource(this.quadBuffer);
            if (this.hasComposePipeline) {
                this.app.releaseResource(this.composePipeline);
                this.hasComposePipeline = false;
            }
            this.hasTargets = false;
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (action == ACTION_PRESS && key >= KEY_1 && key <= KEY_9) {
                this.renderMode = key - KEY_1 + 1;
            }
            return 0;
        }

        // The magnified area follows the mouse while its left button is down.
        onMouseButton(button: int, action: int, mods: int): int {
            if (button == MOUSE_BUTTON_LEFT) {
                this.mouseLeftButtonDown = action != ACTION_RELEASE;
            }
            return 0;
        }

        onMousePos(x: number, y: number): int {
            if (this.mouseLeftButtonDown) {
                this.mousePosition[0] = Math.fround(x);
                this.mousePosition[1] = Math.fround(y);
            }
            return 0;
        }

        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        // LoadSizeDependentResources: pass 1's texture and the UI layer's (RGBA8_UNORM), and pass
        // 2's rectangle, its x scaled by the aspect ratio as the orthographic projection unscales it.
        createTargets(frame: Frame, commandList: CommandList): void {
            const aspectRatio = Math.fround(this.width / this.height);
            const a = aspectRatio;
            let quad: f32[] = [
                -a, -1.0, 0.0, 0.0, 1.0,
                -a, 1.0, 0.0, 0.0, 0.0,
                a, 1.0, 0.0, 1.0, 0.0,

                -a, -1.0, 0.0, 0.0, 1.0,
                a, 1.0, 0.0, 1.0, 0.0,
                a, -1.0, 0.0, 1.0, 1.0,
            ];
            this.quadBuffer = this.app.createStaticVertexBuffer(commandList, Ref(quad[0]), quad.length * 4, "Rectangle");

            this.sceneTexture = this.app.createRenderTargetTexture(this.width, this.height, Format.RGBA8_UNORM, "RenderPass1");
            this.sceneFramebuffer = this.app.createFramebuffer(this.sceneTexture, null);
            this.uiTexture = this.app.createRenderTargetTexture(this.width, this.height, Format.RGBA8_UNORM, "UI");
            this.uiFramebuffer = this.app.createFramebuffer(this.uiTexture, null);

            // Both passes: default rasterizer (back faces culled, clockwise front faces) and blend
            // states, no depth.
            const waveDesc = GraphicsPipelineDesc.create(this.waveVS, this.wavePS);
            waveDesc.addBindingLayout(this.sceneLayout);
            waveDesc.setInputLayout(this.waveInputLayout);
            waveDesc.setDepthState(0, 0, ComparisonFunc.Always);
            this.wavePipeline = this.app.createGraphicsPipelineFromDesc(waveDesc, this.sceneFramebuffer);

            const sceneSetDesc = BindingSetDesc.create();
            sceneSetDesc.bindEntireConstantBuffer(0, this.constantBuffer);
            this.sceneBindingSet = this.app.createBindingSetForLayout(sceneSetDesc, this.sceneLayout);

            const composeSetDesc = BindingSetDesc.create();
            composeSetDesc.bindEntireConstantBuffer(0, this.constantBuffer);
            composeSetDesc.bindTextureSRV(0, this.sceneTexture);
            composeSetDesc.bindTextureSRV(1, this.uiTexture);
            composeSetDesc.bindSampler(0, this.sampler);
            this.composeBindingSet = this.app.createBindingSetForLayout(composeSetDesc, this.composeLayout);

            // The UI layer's text goes into its texture.
            this.imguiPass.setFramebuffer(this.uiFramebuffer);
            this.hasTargets = true;
        }

        // OnUpdate: the orthographic projection (2 * aspect wide, 2 high, depth 0 to 1; transposed
        // for HLSL's column-major matrices: it is diagonal, so as is), the mouse, the resolution,
        // the render mode and WaveLaneCountMin.
        writeConstants(commandList: CommandList): void {
            const aspectRatio = Math.fround(this.width / this.height);
            for (let i = 0; i < 16; i++) {
                this.constants[i] = 0.0;
            }
            this.constants[0] = Math.fround(2.0 / Math.fround(2.0 * aspectRatio));
            this.constants[5] = 1.0;
            this.constants[10] = 1.0;
            this.constants[15] = 1.0;
            this.constants[16] = this.mousePosition[0];
            this.constants[17] = this.mousePosition[1];
            this.constants[18] = this.width;
            this.constants[19] = this.height;
            // time (unused: the sample never advances it).
            this.constants[20] = 0.0;
            commandList.writeBuffer(this.constantBuffer, Ref(this.constants[0]), CB_SIZE);
        }

        // RenderScene's pass 1: the triangle into its texture, cleared to transparent black; and
        // the UI layer's texture cleared for the ImGui pass after this one.
        onRenderScene(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            this.width = frame.getWidth();
            this.height = frame.getHeight();
            if (!this.hasTargets) {
                this.createTargets(frame, commandList);
            }

            this.writeConstants(commandList);
            // renderMode and laneSize after time: the constants' uints.
            this.constantInts[0] = this.renderMode;
            this.constantInts[1] = this.laneCount;
            commandList.writeBufferAt(this.constantBuffer, 21 * 4, Ref(this.constantInts[0]), 8);

            commandList.clearTextureFloat(this.sceneTexture, 0.0, 0.0, 0.0, 0.0);
            commandList.clearTextureFloat(this.uiTexture, 0.0, 0.0, 0.0, 0.0);
            frame.beginDrawToFramebuffer(this.wavePipeline, this.sceneFramebuffer);
            frame.drawAddBindingSet(this.sceneBindingSet);
            frame.drawAddVertexBuffer(this.triangleBuffer, 0, 0);
            frame.drawVertices(3);
        }

        // Pass 2, after the UI: the textures composed, magnified around the mouse, into the back
        // buffer (cleared to black first). The sample draws the rectangle twice (two instances of
        // the same six vertices, without blending): once is the same.
        onRenderCompose(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            if (!this.hasTargets) {
                return;
            }
            if (!this.hasComposePipeline) {
                const composeDesc = GraphicsPipelineDesc.create(this.magnifyVS, this.magnifyPS);
                composeDesc.addBindingLayout(this.composeLayout);
                composeDesc.setInputLayout(this.magnifyInputLayout);
                composeDesc.setDepthState(0, 0, ComparisonFunc.Always);
                this.composePipeline = this.app.createGraphicsPipelineFromDescForFrame(composeDesc, frame);
                this.hasComposePipeline = true;
            }
            frame.clearColor(0.0, 0.0, 0.0, 0.0);
            frame.beginDraw(this.composePipeline);
            frame.drawAddBindingSet(this.composeBindingSet);
            frame.drawAddVertexBuffer(this.quadBuffer, 0, 0);
            frame.drawVertices(6);
        }

        // UILayer: its labels from the top left corner, one a line.
        buildUI(): void {
            const lineSpacing = LINE_SPACING_PER_HEIGHT * this.height;
            this.font.push();
            for (let i = 0; i < LABELS.length; i++) {
                let label = LABELS[i];
                if (i == this.renderMode) {
                    label = label + "[x]";
                }
                Donut_ImGuiDrawText(0.0, i * lineSpacing, label, 1.0, 1.0, 1.0, 1.0, 0);
            }
            Donut_ImGuiPopFont();
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            // The sample's static sampler: point filtering, wrapping. Before any command list is
            // open: it creates Donut's common passes.
            this.sampler = this.app.createSampler(0, 0, 1);

            this.waveVS = this.app.createShader("wave_intrinsics.hlsl", "VSMain", ShaderType.Vertex);
            this.wavePS = this.app.createShader("wave_intrinsics.hlsl", "PSMain", ShaderType.Pixel);
            this.magnifyVS = this.app.createShader("wave_intrinsics_magnify.hlsl", "VSMain", ShaderType.Vertex);
            this.magnifyPS = this.app.createShader("wave_intrinsics_magnify.hlsl", "PSMain", ShaderType.Pixel);
            if (!this.waveVS || !this.wavePS || !this.magnifyVS || !this.magnifyPS) {
                return false;
            }

            const waveLayoutDesc = InputLayoutDesc.create();
            waveLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, TRIANGLE_STRIDE);
            waveLayoutDesc.addVertexAttribute("COLOR", Format.RGBA32_FLOAT, 12, 0, TRIANGLE_STRIDE);
            this.waveInputLayout = this.app.createInputLayout(waveLayoutDesc, this.waveVS);
            const magnifyLayoutDesc = InputLayoutDesc.create();
            magnifyLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, 20);
            magnifyLayoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 12, 0, 20);
            this.magnifyInputLayout = this.app.createInputLayout(magnifyLayoutDesc, this.magnifyVS);

            const sceneLayoutDesc = BindingLayoutDesc.create();
            sceneLayoutDesc.layoutConstantBuffer(0);
            this.sceneLayout = this.app.createBindingLayout(sceneLayoutDesc, ShaderType.All);
            const composeLayoutDesc = BindingLayoutDesc.create();
            composeLayoutDesc.layoutConstantBuffer(0);
            composeLayoutDesc.layoutTextureSRV(0);
            composeLayoutDesc.layoutTextureSRV(1);
            composeLayoutDesc.layoutSampler(0);
            this.composeLayout = this.app.createBindingLayout(composeLayoutDesc, ShaderType.All);

            // Written in two parts (floats, then uints): not volatile.
            this.constantBuffer = this.app.createConstantBuffer(CB_SIZE, "SceneConstantBuffer");

            const commandList = this.app.createCommandList();
            commandList.open();
            let vertices: f32[] = [];
            for (let i = 0; i < TRIANGLE_VERTICES.length; i++) {
                vertices.push(TRIANGLE_VERTICES[i]);
            }
            this.triangleBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Triangle");
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);

            // Pass 1, the UI (into its texture), pass 2.
            const scenePass = this.app.addPass();
            scenePass.setKeyboardCallback(this.onKey);
            scenePass.setMouseButtonCallback(this.onMouseButton);
            scenePass.setMousePosCallback(this.onMousePos);
            scenePass.setAnimateCallback(this.onAnimate);
            scenePass.setBackBufferResizingCallback(this.onBackBufferResizing);
            scenePass.setRenderCallback(this.onRenderScene);

            const imguiPass = this.app.addImGuiPass(this.buildUI);
            if (imguiPass.isNull()) {
                return false;
            }
            this.imguiPass = imguiPass;
            const font = imguiPass.createFont(FONT_PATH, FONT_SIZE_PER_HEIGHT * this.height);
            if (font.isNull()) {
                console.log("Cannot load the font");
                return false;
            }
            this.font = font;

            const composePass = this.app.addPass();
            composePass.setRenderCallback(this.onRenderCompose);
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("wave_intrinsics");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // UNORM back buffers, as the sample's R8G8B8A8_UNORM.
        let options = AppOptions.UnormBackBuffer;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            }
        }

        // The sample's window.
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        // The sample needs shader model 6 with wave intrinsics.
        const laneCount = app.getWaveLaneCountMin();
        if (laneCount == 0) {
            console.log("The graphics device does not support wave intrinsics (D3D12 or Vulkan)");
            app.destroy();
            return 1;
        }
        console.log(`Renderer: ${app.getRendererString()}, wave lanes: ${laneCount} to ${app.getWaveLaneCountMax()}`);

        const pass = new WaveIntrinsicsPass(app);
        pass.laneCount = laneCount;
        if (!pass.init()) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return WaveIntrinsics.main(argc, argv);
}

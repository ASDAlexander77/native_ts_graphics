// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace ColorWriteEnable {
    const WINDOW_TITLE = "Donut Example: Color Write Enable";

    // --- Pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' color_write_enable: a triangle with a color per corner drawn into
    // three targets at once, the first written only in red, the second in green, the third in
    // blue, each cleared to that channel of the background color; then the three added up into the
    // back buffer. The UI turns writing each target on and off (the sample's
    // VK_EXT_color_write_enable dynamic state; here a pipeline per combination, the disabled
    // targets' write masks 0) and picks the background color.
    class ColorWriteEnablePass {
        private app: App;

        // The sample's settings.
        backgroundColor: f32[];
        rBitEnabled: boolean;
        gBitEnabled: boolean;
        bBitEnabled: boolean;

        private triangleVS: Opaque;
        private trianglePS: Opaque;
        private compositionVS: Opaque;
        private compositionPS: Opaque;
        private compositionBindingLayout: Opaque;

        // The sample's three attachments (the back buffer's format, sRGB), their framebuffer and
        // the composition's binding set, for the back buffers' size; a framebuffer per back buffer.
        private colorR: Opaque;
        private colorG: Opaque;
        private colorB: Opaque;
        private targetsFramebuffer: Opaque;
        private compositionBindingSet: BindingSet;
        private framebuffers: Opaque[];
        private targetWidth: int;
        private targetHeight: int;

        // The triangle's pipelines by the enabled targets (bit 0 red, 1 green, 2 blue), made when
        // first needed; the composition's.
        private trianglePipelines: Opaque[];
        private trianglePipelineMade: boolean[];
        private compositionPipeline: Opaque;
        private compositionPipelineMade: boolean;

        constructor(app: App) {
            this.app = app;
            this.backgroundColor = [0.5, 0.5, 0.5];
            this.rBitEnabled = true;
            this.gBitEnabled = true;
            this.bBitEnabled = true;
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.trianglePipelines = [];
            this.trianglePipelineMade = [];
            this.compositionPipelineMade = false;
        }

        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        // The framebuffers of the back buffers go before the back buffers do.
        onBackBufferResizing(): void {
            this.releaseTargets();
        }

        releaseTargets(): void {
            for (let i = 0; i < this.framebuffers.length; i++) {
                this.app.releaseResource(this.framebuffers[i]);
            }
            if (this.framebuffers.length > 0) {
                this.app.releaseResource(this.compositionBindingSet.handle);
                this.app.releaseResource(this.targetsFramebuffer);
                this.app.releaseResource(this.colorR);
                this.app.releaseResource(this.colorG);
                this.app.releaseResource(this.colorB);
            }
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
        }

        createTargets(width: int, height: int): void {
            this.releaseTargets();
            this.colorR = this.app.createRenderTargetTexture(width, height, Format.SRGBA8_UNORM, "Red");
            this.colorG = this.app.createRenderTargetTexture(width, height, Format.SRGBA8_UNORM, "Green");
            this.colorB = this.app.createRenderTargetTexture(width, height, Format.SRGBA8_UNORM, "Blue");
            this.targetsFramebuffer = this.app.createFramebufferWithThreeTargets(this.colorR, this.colorG, this.colorB, null);
            const setDesc = BindingSetDesc.create();
            setDesc.bindTextureSRV(0, this.colorR);
            setDesc.bindTextureSRV(1, this.colorG);
            setDesc.bindTextureSRV(2, this.colorB);
            this.compositionBindingSet = this.app.createBindingSetForLayout(setDesc, this.compositionBindingLayout);
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), null));
            }
            if (!this.compositionPipelineMade) {
                const desc = GraphicsPipelineDesc.create(this.compositionVS, this.compositionPS);
                desc.addBindingLayout(this.compositionBindingLayout);
                desc.setDepthState(0, 0, ComparisonFunc.Always);
                desc.setRasterState(CullMode.Back, FillMode.Solid, 0);
                this.compositionPipeline = this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]);
                this.compositionPipelineMade = true;
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        // The sample's color pipeline: back faces (clockwise front faces) culled, no depth, no
        // blending; each target written in its one channel, or not at all when disabled.
        trianglePipeline(enabled: int): Opaque {
            if (!this.trianglePipelineMade[enabled]) {
                const desc = GraphicsPipelineDesc.create(this.triangleVS, this.trianglePS);
                desc.setDepthState(0, 0, ComparisonFunc.Always);
                desc.setRasterState(CullMode.Back, FillMode.Solid, 0);
                desc.setTargetColorWriteMask(0, (enabled & 1) != 0 ? ColorMask.Red : ColorMask.None);
                desc.setTargetColorWriteMask(1, (enabled & 2) != 0 ? ColorMask.Green : ColorMask.None);
                desc.setTargetColorWriteMask(2, (enabled & 4) != 0 ? ColorMask.Blue : ColorMask.None);
                this.trianglePipelines[enabled] = this.app.createGraphicsPipelineFromDesc(desc, this.targetsFramebuffer);
                this.trianglePipelineMade[enabled] = true;
            }
            return this.trianglePipelines[enabled];
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            // The render pass's clears: the back buffer to transparent black, each attachment to
            // its channel of the background color.
            const index = this.app.getCurrentBackBufferIndex();
            const background = this.backgroundColor;
            commandList.clearTextureFloat(this.app.getBackBuffer(index), 0.0, 0.0, 0.0, 0.0);
            commandList.clearTextureFloat(this.colorR, background[0], 0.0, 0.0, 0.0);
            commandList.clearTextureFloat(this.colorG, 0.0, background[1], 0.0, 0.0);
            commandList.clearTextureFloat(this.colorB, 0.0, 0.0, background[2], 0.0);

            // First subpass: the triangle into the three attachments.
            const enabled = (this.rBitEnabled ? 1 : 0) | (this.gBitEnabled ? 2 : 0) | (this.bBitEnabled ? 4 : 0);
            frame.beginDrawToFramebuffer(this.trianglePipeline(enabled), this.targetsFramebuffer);
            frame.drawVertices(3);

            // Second subpass: the attachments added up into the back buffer.
            frame.beginDrawToFramebuffer(this.compositionPipeline, this.framebuffers[index]);
            frame.drawAddBindingSet(this.compositionBindingSet);
            frame.drawVertices(3);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "color_write_enable.hlsl";
            this.triangleVS = this.app.createShader(shader, "triangle_vs", ShaderType.Vertex);
            this.trianglePS = this.app.createShader(shader, "triangle_ps", ShaderType.Pixel);
            this.compositionVS = this.app.createShader(shader, "composition_vs", ShaderType.Vertex);
            this.compositionPS = this.app.createShader(shader, "composition_ps", ShaderType.Pixel);
            if (!this.triangleVS || !this.trianglePS || !this.compositionVS || !this.compositionPS) {
                return false;
            }
            for (let i = 0; i < 8; i++) {
                this.trianglePipelineMade.push(false);
                this.trianglePipelines.push(this.triangleVS);
            }

            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutTextureSRV(0);
            layoutDesc.layoutTextureSRV(1);
            layoutDesc.layoutTextureSRV(2);
            this.compositionBindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.Pixel);

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's overlay.
    class UserInterface {
        private sample: ColorWriteEnablePass;

        constructor(sample: ColorWriteEnablePass) {
            this.sample = sample;
        }

        buildUI(): void {
            const sample = this.sample;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Color Write Enable", 1);
            Donut_ImGuiPushItemWidth(110.0);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Background color") != 0) {
                Donut_ImGuiColorPicker3("", Ref(sample.backgroundColor[0]), 200.0);
            }
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Enabled attachment") != 0) {
                sample.rBitEnabled = Donut_ImGuiCheckbox("Red bit", sample.rBitEnabled ? 1 : 0) != 0;
                sample.gBitEnabled = Donut_ImGuiCheckbox("Green bit", sample.gBitEnabled ? 1 : 0) != 0;
                sample.bBitEnabled = Donut_ImGuiCheckbox("Blue bit", sample.bBitEnabled ? 1 : 0) != 0;
            }
            Donut_ImGuiPopItemWidth();
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("color_write_enable");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the settings window.
        // -nored, -nogreen, -noblue: the targets' initial write switches.
        // -background <r> <g> <b>: the initial background color.
        let options = AppOptions.None;
        let withUI = true;
        let r = true;
        let g = true;
        let b = true;
        let background: number[] = [0.5, 0.5, 0.5];
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-nored") {
                r = false;
            } else if (arg == "-nogreen") {
                g = false;
            } else if (arg == "-noblue") {
                b = false;
            } else if (arg == "-background" && i + 3 < argc) {
                for (let k = 0; k < 3; k++) {
                    background[k] = parseFloat(Donut_GetArg(argv, i + 1 + k));
                }
                i += 3;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new ColorWriteEnablePass(app);
        sample.rBitEnabled = r;
        sample.gBitEnabled = g;
        sample.bBitEnabled = b;
        for (let k = 0; k < 3; k++) {
            sample.backgroundColor[k] = background[k];
        }
        if (!sample.init()) {
            app.destroy();
            return 1;
        }

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(sample);
        if (withUI && !gui.init(app)) {
            console.log("Cannot initialize the user interface");
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
    return ColorWriteEnable.main(argc, argv);
}

// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace ShaderSpecializations {
    const WINDOW_TITLE = "Donut Example: Vulkan Shader Specializations";

    // --- Passes -----------------------------------------------------------------------------

    // Port of Donut-Samples' shader_specializations.cpp.
    class ShaderSpecializationsPass {
        private app: App;
        private vertexShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        // Created on the first frame (they depend on the framebuffer layout), dropped on resize.
        private pipelines: GraphicsPipelineHandle[];

        constructor(app: App) {
            this.app = app;
            this.pipelines = [];
        }

        onBackBufferResizing(): void {
            for (const pipeline of this.pipelines) {
                this.app.releaseResource(pipeline);
            }
            this.pipelines = [];
        }

        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            if (this.pipelines.length == 0) {
                // Create pipelines with shader specializations.
                // The specializations could be created ahead of time, but they're cheap and it doesn't really matter.
                const colors: int[] = [0x0000ff, 0x00ff00, 0xff0000, 0xff00ff];

                for (let i = 0; i < 4; i++) {
                    const vertexShader = this.app.specializeShaderFloat(this.vertexShader, 0, i * 0.5 - 0.75);
                    const pixelShader = this.app.specializeShaderUInt(this.pixelShader, 1, colors[i]);

                    this.pipelines.push(this.app.createGraphicsPipeline(frame, vertexShader, pixelShader));

                    // The pipeline holds its own references to the specialized shaders.
                    this.app.releaseResource(vertexShader);
                    this.app.releaseResource(pixelShader);
                }
            }

            frame.clearColor(0.0, 0.0, 0.0, 0.0);

            // Render triangles, one with each pipeline.
            // Expected output: 4 triangles side-by-side; red, green, blue, magenta.
            for (const pipeline of this.pipelines) {
                frame.draw(pipeline, 3);
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.vertexShader = this.app.createShader("shader_specializations.hlsl", "main_vs", ShaderType.Vertex);
            this.pixelShader = this.app.createShader("shader_specializations.hlsl", "main_ps", ShaderType.Pixel);

            if (!this.vertexShader || !this.pixelShader) {
                return false;
            }

            const pass = this.app.addPass();
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setAnimateCallback(this.onAnimate);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("shader_specializations");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        let options = AppOptions.None;
        for (let i = 1; i < argc; i++) {
            if (Donut_GetArg(argv, i) == "-debug") {
                options = AppOptions.DebugRuntime;
            }
        }

        const app = App.createWithOptions(GraphicsAPI.VULKAN, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.ShaderSpecializations)) {
            console.log("The graphics device does not support shader specializations");
            app.destroy();
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const specializations = new ShaderSpecializationsPass(app);
        if (!specializations.init()) {
            console.log("Cannot load the shader specialization shaders");
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
    return ShaderSpecializations.main(argc, argv);
}

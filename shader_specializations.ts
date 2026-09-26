// donut_interop.d.ts comes in through input_pass.ts: tslang would load it twice if this
// file referenced it too.
import { InputPass } from "./input_pass";

namespace ShaderSpecializations {
    const WINDOW_TITLE = "Donut Example: Vulkan Shader Specializations";

    // --- Passes -----------------------------------------------------------------------------

    // Port of Donut-Samples' shader_specializations.cpp.
    class ShaderSpecializationsPass {
        private app: Opaque;
        private vertexShader: Opaque;
        private pixelShader: Opaque;
        // Created on the first frame (they depend on the framebuffer layout), dropped on resize.
        private pipelines: Opaque[];

        constructor(app: Opaque) {
            this.app = app;
            this.pipelines = [];
        }

        onBackBufferResizing(): void {
            for (const pipeline of this.pipelines) {
                Donut_ReleaseResource(this.app, pipeline);
            }
            this.pipelines = [];
        }

        onAnimate(elapsedSeconds: number): void {
            Donut_SetInformativeWindowTitle(this.app, WINDOW_TITLE);
        }

        onRender(frame: Opaque): void {
            if (this.pipelines.length == 0) {
                // Create pipelines with shader specializations.
                // The specializations could be created ahead of time, but they're cheap and it doesn't really matter.
                const colors: int[] = [0x0000ff, 0x00ff00, 0xff0000, 0xff00ff];

                for (let i = 0; i < 4; i++) {
                    const vertexShader = Donut_SpecializeShaderFloat(this.app, this.vertexShader, 0, i * 0.5 - 0.75);
                    const pixelShader = Donut_SpecializeShaderUInt(this.app, this.pixelShader, 1, colors[i]);

                    this.pipelines.push(Donut_CreateGraphicsPipeline(this.app, frame, vertexShader, pixelShader));

                    // The pipeline holds its own references to the specialized shaders.
                    Donut_ReleaseResource(this.app, vertexShader);
                    Donut_ReleaseResource(this.app, pixelShader);
                }
            }

            Donut_ClearColor(frame, 0.0, 0.0, 0.0, 0.0);

            // Render triangles, one with each pipeline.
            // Expected output: 4 triangles side-by-side; red, green, blue, magenta.
            for (const pipeline of this.pipelines) {
                Donut_Draw(frame, pipeline, 3);
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.vertexShader = Donut_CreateShader(this.app, "shader_specializations.hlsl", "main_vs", ShaderType.Vertex);
            this.pixelShader = Donut_CreateShader(this.app, "shader_specializations.hlsl", "main_ps", ShaderType.Pixel);

            if (!this.vertexShader || !this.pixelShader) {
                return false;
            }

            const pass = Donut_AddPass(this.app);
            Donut_SetBackBufferResizingCallback(pass, this.onBackBufferResizing);
            Donut_SetAnimateCallback(pass, this.onAnimate);
            Donut_SetRenderCallback(pass, this.onRender);
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {

        const app = Donut_CreateAppForAPI(GraphicsAPI.VULKAN, WINDOW_TITLE, 1280, 720);
        if (!app) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!Donut_IsFeatureSupported(app, Feature.ShaderSpecializations)) {
            console.log("The graphics device does not support shader specializations");
            Donut_DestroyApp(app);
            return 1;
        }

        console.log(`Renderer: ${Donut_GetRendererString(app)}`);

        const specializations = new ShaderSpecializationsPass(app);
        if (!specializations.init()) {
            console.log("Cannot load the shader specialization shaders");
            Donut_DestroyApp(app);
            return 1;
        }

        const input = new InputPass(app);

        Donut_RunApp(app);
        Donut_DestroyApp(app);
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return ShaderSpecializations.main(argc, argv);
}

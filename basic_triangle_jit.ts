// donut_interop.d.ts comes in through input_pass.ts: tslang would load it twice if this
// file referenced it too.
import { InputPass } from "./input_pass";

namespace BasicTriangleJit {
    const WINDOW_TITLE = "Donut Example: Basic Triangle";

    // --- Passes -----------------------------------------------------------------------------

    // Port of Donut-Samples' basic_triangle.cpp.
    class TrianglePass {
        private app: Opaque;
        private vertexShader: Opaque;
        private pixelShader: Opaque;
        // Created on the first frame (it depends on the framebuffer layout), dropped on resize.
        private pipeline: Opaque | null;

        constructor(app: Opaque) {
            this.app = app;
            this.pipeline = null;
        }

        onBackBufferResizing(): void {
            const pipeline = this.pipeline;
            if (pipeline) {
                Donut_ReleaseResource(this.app, pipeline);
                this.pipeline = null;
            }
        }

        onAnimate(elapsedSeconds: number): void {
            Donut_SetInformativeWindowTitle(this.app, WINDOW_TITLE);
        }

        onRender(frame: Opaque): void {
            let pipeline = this.pipeline;
            if (!pipeline) {
                pipeline = Donut_CreateGraphicsPipeline(this.app, frame, this.vertexShader, this.pixelShader);
                this.pipeline = pipeline;
            }

            Donut_ClearColor(frame, 0.0, 0.0, 0.0, 0.0);
            Donut_Draw(frame, pipeline, 3);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.vertexShader = Donut_CreateShader(this.app, "basic_triangle.hlsl", "main_vs", ShaderType.Vertex);
            this.pixelShader = Donut_CreateShader(this.app, "basic_triangle.hlsl", "main_ps", ShaderType.Pixel);

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

    export function main() {

        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("basic_triangle");
        const app = Donut_CreateApp(0, Ref([""][0]), WINDOW_TITLE, 1280, 720);
        if (!app) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return;
        }

        console.log(`Renderer: ${Donut_GetRendererString(app)}`);

        const triangle = new TrianglePass(app);
        if (!triangle.init()) {
            console.log("Cannot load the triangle shaders");
            Donut_DestroyApp(app);
            return;
        }

        const input = new InputPass(app);

        Donut_RunApp(app);
        Donut_DestroyApp(app);
    }
}

// tslang starts the program at a global main.
function main() {
    BasicTriangleJit.main();
}

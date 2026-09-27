// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "./input_pass";

namespace BasicTriangle {
    const WINDOW_TITLE = "Donut Example: Basic Triangle";

    // --- Passes -----------------------------------------------------------------------------

    // Port of Donut-Samples' basic_triangle.cpp.
    class TrianglePass {
        private app: App;
        private vertexShader: Opaque;
        private pixelShader: Opaque;
        // Created on the first frame (it depends on the framebuffer layout), dropped on resize.
        private pipeline: Opaque | null;

        constructor(app: App) {
            this.app = app;
            this.pipeline = null;
        }

        onBackBufferResizing(): void {
            const pipeline = this.pipeline;
            if (pipeline) {
                this.app.releaseResource(pipeline);
                this.pipeline = null;
            }
        }

        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        onRender(frameHandle: Opaque): void {
            const frame = new Frame(frameHandle);
            let pipeline = this.pipeline;
            if (!pipeline) {
                pipeline = this.app.createGraphicsPipeline(frame, this.vertexShader, this.pixelShader);
                this.pipeline = pipeline;
            }

            frame.clearColor(0.0, 0.0, 0.0, 0.0);
            frame.draw(pipeline, 3);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.vertexShader = this.app.createShader("basic_triangle.hlsl", "main_vs", ShaderType.Vertex);
            this.pixelShader = this.app.createShader("basic_triangle.hlsl", "main_ps", ShaderType.Pixel);

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
        const app = App.create(argc, argv, WINDOW_TITLE, 1280, 720);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const triangle = new TrianglePass(app);
        if (!triangle.init()) {
            console.log("Cannot load the triangle shaders");
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
    return BasicTriangle.main(argc, argv);
}

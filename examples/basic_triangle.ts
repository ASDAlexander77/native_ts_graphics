// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck } from "../core/test_check";

namespace BasicTriangle {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame. The corners are the black clear color; the triangle covers an
    // eighth of the frame, its middle (the frame's) colored.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        const corners = check.corners(0x000000);
        if (corners != "") {
            return corners;
        }
        if (check.rgb(check.width / 2, check.height / 2) == 0) {
            return "the middle of the triangle is black";
        }
        return check.share(check.countOtherThan(0x000000, 0, 0, check.width, check.height), check.width * check.height,
            10.0, 15.0, "Triangle");
    }

    const WINDOW_TITLE = "Donut Example: Basic Triangle";

    // --- Passes -----------------------------------------------------------------------------

    // Port of Donut-Samples' basic_triangle.cpp.
    class TrianglePass {
        private app: App;
        private vertexShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        // Created on the first frame (it depends on the framebuffer layout), dropped on resize.
        private pipeline: GraphicsPipelineHandle | null;

        constructor(app: App) {
            this.app = app;
            this.pipeline = null;
        }

        onBackBufferResizing() {
            const pipeline = this.pipeline;
            if (pipeline) {
                this.app.releaseResource(pipeline);
                this.pipeline = null;
            }
        }

        onAnimate(elapsedSeconds: number) {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        onRender(frameHandle: FrameHandle) {
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
        init() {
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

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("basic_triangle");

        const args = new Args(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
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
        let result = 0;
        if (args.test) {
            result = app.finishTest(checkFrame(app));
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return BasicTriangle.main(argc, argv);
}

// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";

namespace ShaderSpecializations {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame. The corners are black; the four triangles, each from its own
    // specialization of one shader, red, green, blue and magenta, cover a quarter of the frame
    // (1/16 each).
    function checkFrame(app: App): string {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        const corners = check.corners(0x000000);
        if (corners != "") {
            return corners;
        }
        const red = check.share(check.countInRange(151, 255, 0, 89, 0, 89, 0, 0, check.width, check.height), total,
            5.0, 7.5, "Red");
        if (red != "") {
            return red;
        }
        const green = check.share(check.countInRange(0, 89, 121, 255, 0, 89, 0, 0, check.width, check.height), total,
            5.0, 7.5, "Green");
        if (green != "") {
            return green;
        }
        const blue = check.share(check.countInRange(0, 89, 0, 119, 121, 255, 0, 0, check.width, check.height), total,
            5.0, 7.5, "Blue");
        if (blue != "") {
            return blue;
        }
        return check.share(check.countOtherThan(0x000000, 0, 0, check.width, check.height), total,
            23.0, 27.0, "Triangles");
    }

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

        const args = new Args(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(GraphicsAPI.VULKAN, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.ShaderSpecializations)) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support shader specializations");
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
        let result = 0;
        if (args.test) {
            result = app.finishTest(checkFrame(app));
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return ShaderSpecializations.main(argc, argv);
}

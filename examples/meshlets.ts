// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";

namespace Meshlets {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame. The corners are the black clear color; the meshlet triangle
    // covers an eighth of the frame, colored in the middle.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        const corners = check.corners(0x000000);
        if (corners != "") {
            return corners;
        }
        const middle = check.rgb(check.width / 2, check.height / 2);
        if (!(middle != 0)) {
            return "the middle of the triangle is black";
        }
        return check.share(check.countOtherThan(0x000000, 0, 0, check.width, check.height), total,
            10.0, 15.0, "Triangle");
    }

    const WINDOW_TITLE = "Donut Example: Meshlets";

    // --- Passes -----------------------------------------------------------------------------

    // Port of Donut-Samples' meshlets.cpp.
    class MeshletPass {
        private app: App;
        private amplificationShader: ShaderHandle;
        private meshShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        // Created on the first frame (it depends on the framebuffer layout), dropped on resize.
        private pipeline: MeshletPipelineHandle | null;

        constructor(app: App) {
            this.app = app;
            this.pipeline = null;
        }

        init() {
            this.amplificationShader = this.app.createShader("meshlets.hlsl", "main_as", ShaderType.Amplification);
            this.meshShader = this.app.createShader("meshlets.hlsl", "main_ms", ShaderType.Mesh);
            this.pixelShader = this.app.createShader("meshlets.hlsl", "main_ps", ShaderType.Pixel);

            if (!this.amplificationShader || !this.meshShader || !this.pixelShader) {
                return false;
            }

            const pass = this.app.addPass();
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setAnimateCallback(this.onAnimate);
            pass.setRenderCallback(this.onRender);
            return true;
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
                pipeline = this.app.createMeshletPipeline(frame, this.amplificationShader, this.meshShader, this.pixelShader);
                this.pipeline = pipeline;
            }

            frame.clearColor(0.0, 0.0, 0.0, 0.0);
            frame.dispatchMesh(pipeline, 1);
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("meshlets");

        const args = new Args(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.Meshlets)) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support Meshlets");
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const meshlets = new MeshletPass(app);
        if (!meshlets.init()) {
            console.log("Cannot load the meshlet shaders");
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
    return Meshlets.main(argc, argv);
}

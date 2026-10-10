// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace Meshlets {
    const WINDOW_TITLE = "Donut Example: Meshlets";

    // --- Passes -----------------------------------------------------------------------------

    // Port of Donut-Samples' meshlets.cpp.
    class MeshletPass {
        private app: App;
        private amplificationShader: Opaque;
        private meshShader: Opaque;
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

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            let pipeline = this.pipeline;
            if (!pipeline) {
                pipeline = this.app.createMeshletPipeline(frame, this.amplificationShader, this.meshShader, this.pixelShader);
                this.pipeline = pipeline;
            }

            frame.clearColor(0.0, 0.0, 0.0, 0.0);
            frame.dispatchMesh(pipeline, 1);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
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
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("meshlets");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        let options = AppOptions.None;
        for (let i = 1; i < argc; i++) {
            if (Donut_GetArg(argv, i) == "-debug") {
                options = AppOptions.DebugRuntime;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.Meshlets)) {
            console.log("The graphics device does not support Meshlets");
            app.destroy();
            return 1;
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
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return Meshlets.main(argc, argv);
}

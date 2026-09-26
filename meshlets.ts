// donut_interop.d.ts comes in through input_pass.ts: tslang would load it twice if this
// file referenced it too.
import { InputPass } from "./input_pass";

namespace Meshlets {
    const WINDOW_TITLE = "Donut Example: Meshlets";

    // --- Passes -----------------------------------------------------------------------------

    // Port of Donut-Samples' meshlets.cpp.
    class MeshletPass {
        private app: Opaque;
        private amplificationShader: Opaque;
        private meshShader: Opaque;
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
                pipeline = Donut_CreateMeshletPipeline(this.app, frame, this.amplificationShader, this.meshShader, this.pixelShader);
                this.pipeline = pipeline;
            }

            Donut_ClearColor(frame, 0.0, 0.0, 0.0, 0.0);
            Donut_DispatchMesh(frame, pipeline, 1);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.amplificationShader = Donut_CreateShader(this.app, "meshlets.hlsl", "main_as", ShaderType.Amplification);
            this.meshShader = Donut_CreateShader(this.app, "meshlets.hlsl", "main_ms", ShaderType.Mesh);
            this.pixelShader = Donut_CreateShader(this.app, "meshlets.hlsl", "main_ps", ShaderType.Pixel);

            if (!this.amplificationShader || !this.meshShader || !this.pixelShader) {
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

        const app = Donut_CreateApp(argc, argv, WINDOW_TITLE, 1280, 720);
        if (!app) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!Donut_IsFeatureSupported(app, Feature.Meshlets)) {
            console.log("The graphics device does not support Meshlets");
            Donut_DestroyApp(app);
            return 1;
        }

        console.log(`Renderer: ${Donut_GetRendererString(app)}`);

        const meshlets = new MeshletPass(app);
        if (!meshlets.init()) {
            console.log("Cannot load the meshlet shaders");
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
    return Meshlets.main(argc, argv);
}

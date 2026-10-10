// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace MeshShading {
    const WINDOW_TITLE = "Donut Example: Mesh Shading";

    // ApiVulkanSample's default_clear_color.
    const CLEAR_COLOR = 0.002;

    // Port of Vulkan-Samples' mesh_shading: the simplest mesh shader pipeline, no vertex input
    // and no amplification (task) shader: one mesh shader workgroup outputs a triangle, drawn red.
    // D3D12 and Vulkan (mesh shaders).
    class MeshShadingPass {
        private app: App;
        private meshShader: Opaque;
        private pixelShader: Opaque;
        private pipeline: Opaque;
        private pipelineCreated: boolean;

        constructor(app: App) {
            this.app = app;
            this.pipelineCreated = false;
        }

        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            if (!this.pipelineCreated) {
                // The sample's pipeline: no culling, no depth test, no blending.
                const desc = GraphicsPipelineDesc.createMeshlet(null, this.meshShader, this.pixelShader);
                desc.setDepthState(0, 0, ComparisonFunc.Greater);
                desc.setRasterState(CullMode.None, FillMode.Solid, 1);
                this.pipeline = this.app.createMeshletPipelineFromDescForFrame(desc, frame);
                this.pipelineCreated = true;
            }

            frame.clearColor(CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
            frame.beginMeshDraw(this.pipeline);
            frame.drawMeshTasks(1);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            if (this.app.isFeatureSupported(Feature.Meshlets) == 0) {
                console.log("The graphics device does not support mesh shaders");
                return false;
            }
            this.meshShader = this.app.createShader("mesh_shading.hlsl", "triangle_ms", ShaderType.Mesh);
            this.pixelShader = this.app.createShader("mesh_shading.hlsl", "triangle_ps", ShaderType.Pixel);
            if (!this.meshShader || !this.pixelShader) {
                return false;
            }

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("mesh_shading");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        let options = AppOptions.None;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new MeshShadingPass(app);
        if (!pass.init()) {
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
    return MeshShading.main(argc, argv);
}

// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace ShaderQuadControl {
    const WINDOW_TITLE = "Donut Example: Shader Quad Control";

    // Port of Vulkan-Samples' shader_quad_control: a triangle over the screen showing its texture
    // coordinates, its pixel shader run in full quads (layout(full_quads): SPIR-V's
    // RequireFullQuadsKHR, VK_KHR_shader_quad_control; D3D12 always runs whole quads). As the sample
    // ships, that's all it draws; its README has each pixel show its quad's top left pixel's
    // coordinates instead (subgroupQuadBroadcast(vUV, 0)), 2 x 2 blocks of one color: "Broadcast
    // from the quad leader" here.
    class ShaderQuadControlPass {
        private app: App;
        private vs: Opaque;
        private plainPS: Opaque;
        private broadcastPS: Opaque;
        // Created on the first frame (the back buffer's layout), dropped on resize.
        private pipelinesCreated: boolean;
        private plainPipeline: Opaque;
        private broadcastPipeline: Opaque;

        // The README's quad broadcast, from the UI.
        broadcast: boolean;

        constructor(app: App) {
            this.app = app;
            this.pipelinesCreated = false;
            this.broadcast = false;
        }

        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        onBackBufferResizing(): void {
            if (this.pipelinesCreated) {
                this.app.releaseResource(this.plainPipeline);
                this.app.releaseResource(this.broadcastPipeline);
            }
            this.pipelinesCreated = false;
        }

        // The sample's build_command_buffers: cleared to black, the triangle drawn (no culling).
        onRender(frameHandle: Opaque): void {
            const frame = new Frame(frameHandle);
            if (!this.pipelinesCreated) {
                this.plainPipeline = this.app.createGraphicsPipelineWithTopology(frame, this.vs, this.plainPS, null, null,
                    PrimitiveType.TriangleList);
                this.broadcastPipeline = this.app.createGraphicsPipelineWithTopology(frame, this.vs, this.broadcastPS, null, null,
                    PrimitiveType.TriangleList);
                this.pipelinesCreated = true;
            }
            frame.clearColor(0.0, 0.0, 0.0, 1.0);
            frame.beginDraw(this.broadcast ? this.broadcastPipeline : this.plainPipeline);
            frame.drawVertices(3);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "shader_quad_control.hlsl";
            this.vs = this.app.createShader(shader, "main_vs", ShaderType.Vertex);
            this.plainPS = this.app.createShaderWithDefine(shader, "main_ps", ShaderType.Pixel, "BROADCAST", "0");
            this.broadcastPS = this.app.createShaderWithDefine(shader, "main_ps", ShaderType.Pixel, "BROADCAST", "1");
            if (!this.vs || !this.plainPS || !this.broadcastPS) {
                return false;
            }

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The options window.
    class UserInterface {
        private pass: ShaderQuadControlPass;

        constructor(pass: ShaderQuadControlPass) {
            this.pass = pass;
        }

        buildUI(): void {
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Options", 1);
            this.pass.broadcast = Donut_ImGuiCheckbox("Broadcast from the quad leader", this.pass.broadcast ? 1 : 0) != 0;
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("shader_quad_control");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the options window. -broadcast: each quad shows its top left pixel's
        // coordinates.
        let options = AppOptions.None;
        let withUI = true;
        let broadcast = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-broadcast") {
                broadcast = true;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        if (app.hasShaderQuadControl() == 0) {
            console.log("The graphics device has no shader quad control (Vulkan's VK_KHR_shader_quad_control, or D3D12)");
            app.destroy();
            return 1;
        }

        const pass = new ShaderQuadControlPass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }
        pass.broadcast = broadcast;

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(pass);
        if (withUI && !gui.init(app)) {
            console.log("Cannot initialize the user interface");
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
    return ShaderQuadControl.main(argc, argv);
}

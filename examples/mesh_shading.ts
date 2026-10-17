// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";

namespace MeshShading {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame. The corners are the dark clear color; the mesh shader's red
    // triangle covers an eighth of the frame, its middle included.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        const corners = check.corners(0x070707);
        if (corners != "") {
            return corners;
        }
        const middle = check.rgb(check.width / 2, check.height / 2);
        if (!(middle == 0x0000FF)) {
            return "the middle isn't the triangle's red";
        }
        return check.share(check.countInRange(151, 255, 0, 89, 0, 89, 0, 0, check.width, check.height), total,
            10.0, 15.0, "Triangle");
    }

    const WINDOW_TITLE = "Donut Example: Mesh Shading";

    // ApiVulkanSample's default_clear_color.
    const CLEAR_COLOR = 0.002;

    // Port of Vulkan-Samples' mesh_shading: the simplest mesh shader pipeline, no vertex input
    // and no amplification (task) shader: one mesh shader workgroup outputs a triangle, drawn red.
    // D3D12 and Vulkan (mesh shaders).
    class MeshShadingPass {
        private app: App;
        private meshShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private pipeline: MeshletPipelineHandle;
        private pipelineCreated: boolean;
        // Set by init() when the device lacks a feature it needs ("" otherwise).
        unsupportedReason: string;

        constructor(app: App) {
            this.app = app;
            this.pipelineCreated = false;
            this.unsupportedReason = "";
        }

        onAnimate(elapsedSeconds: number) {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        onRender(frameHandle: FrameHandle) {
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
        init() {
            if (this.app.isFeatureSupported(Feature.Meshlets) == 0) {
                this.unsupportedReason = "The graphics device does not support mesh shaders";
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

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("mesh_shading");

        const args = new Args(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new MeshShadingPass(app);
        if (!pass.init()) {
            app.destroy();
            return pass.unsupportedReason != "" ? unsupported(args.test, pass.unsupportedReason) : 1;
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
    return MeshShading.main(argc, argv);
}

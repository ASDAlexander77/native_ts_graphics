// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";

namespace ComputeShaderDerivatives {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame. The corners are black; the radial pattern, colored by the
    // compute shader's derivatives, lights about 84% of the frame, about 35% blue.
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
        const lit = check.share(total - check.countInRange(0, 20, 0, 20, 0, 20, 0, 0, check.width, check.height), total,
            75.0, 92.0, "Lit");
        if (lit != "") {
            return lit;
        }
        return check.share(check.countInRange(0, 89, 0, 119, 121, 255, 0, 0, check.width, check.height), total,
            25.0, 45.0, "Blue");
    }

    const WINDOW_TITLE = "Donut Example: Compute Shader Derivatives";

    // The image the compute shader writes, in 8 x 8 tiles.
    const IMAGE_WIDTH = 512;
    const IMAGE_HEIGHT = 512;
    const TILE_SIZE = 8;

    // Port of Vulkan-Samples' compute_shader_derivatives: a compute shader evaluates a radial
    // pattern and takes its derivatives (ddx, ddy) across neighbouring threads, as pixel shaders
    // do across pixels, drawing the gradient's magnitude as edges; the image is stretched over the
    // screen. The threads form quads of 2 x 2 where the device has them, of 4 in a row if not (or
    // with -linear).
    class DerivativesPass {
        private app: App;
        unsupportedReason: string;

        // Quads of 4 threads in a row rather than 2 x 2.
        useLinear: boolean;

        private computePipeline: ComputePipelineHandle;
        private computeBindingSet: BindingSet;
        private image: TextureHandle;
        private fullscreenVS: ShaderHandle;
        private fullscreenPS: ShaderHandle;
        private graphicsBindingLayout: BindingLayoutHandle;
        private graphicsBindingSet: BindingSet;

        // The back buffer's size: color (sRGB, as the sample's swapchain).
        private colorBuffer: TextureHandle | null;
        private framebuffer: FramebufferHandle | null;
        private graphicsPipeline: GraphicsPipelineHandle | null;

        constructor(app: App) {
            this.app = app;
            this.unsupportedReason = "";
            this.useLinear = false;
            this.colorBuffer = null;
            this.framebuffer = null;
            this.graphicsPipeline = null;
        }

        init() {
            // Prefer quads when available; otherwise, fall back to linear.
            const support = this.app.getComputeShaderDerivatives();
            if (support == 0) {
                this.unsupportedReason = "This example needs derivatives in compute shaders (D3D12 shader model 6.6 or Vulkan's VK_KHR_compute_shader_derivatives)";
                return false;
            }
            if ((support & ComputeDerivatives.Quads) == 0) {
                this.useLinear = true;
            } else if ((support & ComputeDerivatives.Linear) == 0) {
                this.useLinear = false;
            }

            const shader = "compute_shader_derivatives.hlsl";
            const computeShader = this.app.createShader(shader, this.useLinear ? "derivatives_linear" : "derivatives_quad", ShaderType.Compute);
            this.fullscreenVS = this.app.createShader(shader, "fullscreen_vs", ShaderType.Vertex);
            this.fullscreenPS = this.app.createShader(shader, "fullscreen_ps", ShaderType.Pixel);
            if (!computeShader || !this.fullscreenVS || !this.fullscreenPS) {
                return false;
            }

            // Storage image for compute shader output
            this.image = this.app.createUAVTextureWithFormat(IMAGE_WIDTH, IMAGE_HEIGHT, Format.RGBA8_UNORM, "StorageImage");

            const computeLayoutDesc = BindingLayoutDesc.create();
            computeLayoutDesc.layoutTextureUAV(0);
            const computeBindingLayout = this.app.createBindingLayout(computeLayoutDesc, ShaderType.Compute);
            this.computePipeline = this.app.createComputePipelineWithLayout(computeShader, computeBindingLayout);
            const computeSetDesc = BindingSetDesc.create();
            computeSetDesc.bindTextureUAV(0, this.image);
            this.computeBindingSet = this.app.createBindingSetForLayout(computeSetDesc, computeBindingLayout);

            // The image through a linear, clamped sampler.
            const graphicsLayoutDesc = BindingLayoutDesc.create();
            graphicsLayoutDesc.layoutTextureSRV(0);
            graphicsLayoutDesc.layoutSampler(0);
            this.graphicsBindingLayout = this.app.createBindingLayout(graphicsLayoutDesc, ShaderType.Pixel);
            const graphicsSetDesc = BindingSetDesc.create();
            graphicsSetDesc.bindTextureSRV(0, this.image);
            graphicsSetDesc.bindSampler(0, this.app.getCommonSampler(CommonSampler.LinearClamp));
            this.graphicsBindingSet = this.app.createBindingSetForLayout(graphicsSetDesc, this.graphicsBindingLayout);

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        onAnimate(elapsedSeconds: number) {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        releaseTargets() {
            this.app.releaseResources([this.graphicsPipeline, this.framebuffer, this.colorBuffer]);
            this.graphicsPipeline = null;
            this.framebuffer = null;
            this.colorBuffer = null;
        }

        onBackBufferResizing() {
            this.releaseTargets();
            // The blit's cached binding sets still reference the old color buffer.
            this.app.clearBindingCache();
        }

        createTargets(width: int, height: int) {
            const colorBuffer = this.app.createRenderTargetTexture(width, height, Format.SRGBA8_UNORM, "ColorBuffer");
            const framebuffer = this.app.createFramebuffer(colorBuffer, null);
            this.colorBuffer = colorBuffer;
            this.framebuffer = framebuffer;

            // Fullscreen triangle: no culling, no depth.
            const desc = GraphicsPipelineDesc.create(this.fullscreenVS, this.fullscreenPS);
            desc.addBindingLayout(this.graphicsBindingLayout);
            desc.setDepthState(0, 0, ComparisonFunc.Always);
            desc.setRasterState(CullMode.None, FillMode.Solid, 1);
            this.graphicsPipeline = this.app.createGraphicsPipelineFromDesc(desc, framebuffer);
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (!this.framebuffer) {
                this.createTargets(width, height);
            }
            const framebuffer = this.framebuffer;
            const colorBuffer = this.colorBuffer;
            const graphicsPipeline = this.graphicsPipeline;
            if (!framebuffer || !colorBuffer || !graphicsPipeline) {
                return;
            }

            // Dispatch compute shader: 512x512 image with 8x8 local size = 64x64 workgroups
            commandList.dispatch(this.computePipeline, this.computeBindingSet, IMAGE_WIDTH / TILE_SIZE, IMAGE_HEIGHT / TILE_SIZE, 1);

            // Render the computed image as a fullscreen triangle
            commandList.clearTextureFloat(colorBuffer, 0.0, 0.0, 0.0, 1.0);
            frame.beginDrawToFramebuffer(graphicsPipeline, framebuffer);
            frame.drawAddBindingSet(this.graphicsBindingSet);
            frame.drawVertices(3);

            this.app.blitTexture(frame, colorBuffer);
        }
    }

    // The sample's overlay.
    class UserInterface {
        private sample: DerivativesPass;

        constructor(sample: DerivativesPass) {
            this.sample = sample;
        }

        init(app: App) {
            return !app.addImGuiPass(this.buildUI).isNull();
        }

        buildUI() {
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            // The sample's title (ApiVulkanSample's default).
            Donut_ImGuiBegin("Vulkan Example", 1);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Compute Shader Derivatives") != 0) {
                Donut_ImGuiText("Visualization:");
                Donut_ImGuiText("- Blue: Base procedural radial pattern");
                Donut_ImGuiText("- Red/Yellow: Edges (high gradient magnitude)");
                Donut_ImGuiText("- Gradient magnitude = sqrt(dx^2 + dy^2)");
                Donut_ImGuiText("");

                Donut_ImGuiText("This demonstrates edge detection using compute shader");
                Donut_ImGuiText("derivatives, useful for LOD selection, filtering, and");
                Donut_ImGuiText("spatial analysis in compute pipelines.");
                Donut_ImGuiText("");
                Donut_ImGuiText(this.sample.useLinear ? "Derivative groups: linear (4 threads in a row)" : "Derivative groups: quads (2 x 2 threads)");
            }
            Donut_ImGuiEnd();
        }
    }

    class ComputeShaderDerivativesArgs extends Args {
        // -linear: linear derivative groups (4 threads in a row) where the device has them.
        linear = false;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-linear") {
                    this.linear = true;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("compute_shader_derivatives");

        const args = new ComputeShaderDerivativesArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new DerivativesPass(app);
        sample.useLinear = args.linear;
        if (!sample.init()) {
            app.destroy();
            return sample.unsupportedReason != "" ? unsupported(args.test, sample.unsupportedReason) : 1;
        }

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(sample);
        if (!args.noUI &&!gui.init(app)) {
            console.log("Cannot initialize the user interface");
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
    return ComputeShaderDerivatives.main(argc, argv);
}

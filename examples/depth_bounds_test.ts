// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace DepthBoundsTest {
    const WINDOW_TITLE = "D3D12 Depth Bounds Test Sample";

    // The sample's vertex: position, color.
    const VERTEX_STRIDE = 28;
    // Its frames run at the display's 60 Hz: its animation steps once a frame, here 60 times a
    // second (once a frame with -benchmark).
    const STEPS_PER_SECOND = 60.0;

    // Port of DirectX-Graphics-Samples' D3D12DepthBoundsTest: a triangle whose corners lie at depths
    // 0.1, 0.9 and 0.5 drawn into the depth buffer alone, then again with depth testing off but the
    // depth bounds test on: only where the depth it drew first lies within the bounds, which close
    // in and open up from [0, 1] to about [0.23, 0.77] and back as the frames go by.
    class DepthBoundsTestPass {
        private app: App;
        private vertexShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private vertexBuffer: BufferHandle;
        private hasTargets: boolean;
        private colorBuffer: TextureHandle;
        private depthBuffer: TextureHandle;
        private framebuffer: Opaque;
        private depthOnlyPipeline: Opaque;
        private boundsPipeline: Opaque;
        // m_frameNumber, and the fraction of a step since.
        private frameNumber: int;
        private stepFraction: number;

        depthBoundsTestSupported: boolean;
        benchmark: boolean;

        constructor(app: App) {
            this.app = app;
            this.hasTargets = false;
            this.frameNumber = 0;
            this.stepFraction = 0.0;
            this.depthBoundsTestSupported = false;
            this.benchmark = false;
        }

        onBackBufferResizing(): void {
            if (!this.hasTargets) {
                return;
            }
            this.app.releaseResource(this.depthOnlyPipeline);
            this.app.releaseResource(this.boundsPipeline);
            this.app.releaseResource(this.framebuffer);
            this.app.releaseResource(this.colorBuffer);
            this.app.releaseResource(this.depthBuffer);
            this.app.clearBindingCache();
            this.hasTargets = false;
        }

        // OnUpdate: the next frame number.
        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            if (this.benchmark) {
                this.frameNumber++;
                return;
            }
            this.stepFraction += elapsedSeconds * STEPS_PER_SECOND;
            const steps: int = Math.floor(this.stepFraction);
            this.frameNumber += steps;
            this.stepFraction -= steps;
        }

        // The sample's back buffer (RGBA8_UNORM) and D32_FLOAT depth buffer, here a color target
        // blitted into the back buffer; and its two pipeline states for them.
        createTargets(width: int, height: int): void {
            this.colorBuffer = this.app.createRenderTargetTexture(width, height, Format.RGBA8_UNORM, "ColorBuffer");
            this.depthBuffer = this.app.createRenderTargetTexture(width, height, Format.D32, "DepthBuffer");
            this.framebuffer = this.app.createFramebuffer(this.colorBuffer, this.depthBuffer);

            // Depth only: the vertex shader alone, the default depth state (less, writes). No pixel
            // shader writes no color on D3D; Vulkan's color writes are masked off too.
            const depthOnlyDesc = GraphicsPipelineDesc.create(this.vertexShader, this.pixelShader);
            depthOnlyDesc.setInputLayout(this.inputLayout);
            depthOnlyDesc.setDepthState(1, 1, ComparisonFunc.Less);
            depthOnlyDesc.setColorWriteMask(ColorMask.None);
            this.depthOnlyPipeline = this.app.createGraphicsPipelineFromDesc(depthOnlyDesc, this.framebuffer);

            // The triangle with depth testing off and, where the device has it, the depth bounds test.
            const boundsDesc = GraphicsPipelineDesc.create(this.vertexShader, this.pixelShader);
            boundsDesc.setInputLayout(this.inputLayout);
            boundsDesc.setDepthState(0, 1, ComparisonFunc.Less);
            if (this.depthBoundsTestSupported) {
                boundsDesc.setDepthBoundsTest(1);
            }
            this.boundsPipeline = this.app.createGraphicsPipelineFromDesc(boundsDesc, this.framebuffer);
            this.hasTargets = true;
        }

        // PopulateCommandList.
        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            if (!this.hasTargets) {
                this.createTargets(frame.getWidth(), frame.getHeight());
            }

            commandList.clearTextureFloat(this.colorBuffer, 0.392, 0.584, 0.929, 1.0);
            commandList.clearDepth(this.depthBuffer, 1.0);

            // Render only the depth of the triangle to prime the depth value of the triangle.
            frame.beginDrawToFramebuffer(this.depthOnlyPipeline, this.framebuffer);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            frame.drawVertices(3);

            // Move the depth bounds so we can see them move: [f, 1 - f], f in [0.125, 0.25]. The
            // test is against the depth primed above.
            const f = Math.fround(0.125 + Math.fround(Math.fround(Math.sin(Math.fround((this.frameNumber & 0x7F) / 127.0))) * 0.125));
            frame.beginDrawToFramebuffer(this.boundsPipeline, this.framebuffer);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            if (this.depthBoundsTestSupported) {
                frame.drawSetDepthBounds(Math.fround(0.0 + f), Math.fround(1.0 - f));
            }
            frame.drawVertices(3);

            this.app.blitTexture(frame, this.colorBuffer);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.vertexShader = this.app.createShader("depth_bounds_test.hlsl", "VSMain", ShaderType.Vertex);
            this.pixelShader = this.app.createShader("depth_bounds_test.hlsl", "PSMain", ShaderType.Pixel);
            if (!this.vertexShader || !this.pixelShader) {
                return false;
            }
            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_STRIDE);
            layoutDesc.addVertexAttribute("COLOR", Format.RGBA32_FLOAT, 12, 0, VERTEX_STRIDE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vertexShader);

            // The triangle in clip space (the window's aspect ratio applied to y): top red at depth
            // 0.1, right green at 0.9, left blue at 0.5.
            const aspectRatio = Math.fround(1280.0 / 720.0);
            const y = Math.fround(0.25 * aspectRatio);
            let vertices: f32[] = [
                0.0, y, 0.1, 1.0, 0.0, 0.0, 1.0,
                0.25, -y, 0.9, 0.0, 1.0, 0.0, 1.0,
                -0.25, -y, 0.5, 0.0, 0.0, 1.0, 1.0,
            ];
            // Blitting creates Donut's common passes: before any command list is open.
            this.app.getCommonSampler(CommonSampler.LinearClamp);
            const commandList = this.app.createCommandList();
            commandList.open();
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Triangle");
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("depth_bounds_test");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -benchmark: one animation step a frame, as the sample.
        // UNORM back buffers, as the sample's R8G8B8A8_UNORM.
        let options = AppOptions.UnormBackBuffer;
        let benchmark = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-benchmark") {
                benchmark = true;
            }
        }

        // The sample's window.
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        // Without it the sample draws the whole triangle, as here.
        const supported = app.hasDepthBoundsTest() != 0;
        let support = "not supported";
        if (supported) {
            support = "supported";
        }
        console.log(`Renderer: ${app.getRendererString()}, depth bounds test: ${support}`);

        const pass = new DepthBoundsTestPass(app);
        pass.depthBoundsTestSupported = supported;
        pass.benchmark = benchmark;
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
    return DepthBoundsTest.main(argc, argv);
}

// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace AsyncCompute {
    const WINDOW_TITLE = "Donut Example: Async Compute";

    // Textures the compute queue writes and the render thread shows, in turns.
    const NUM_TEXTURES = 2;
    const TEXTURE_SIZE = 512;
    // main_cs in async_compute.hlsl runs 8 x 8 threads per group.
    const COMPUTE_GROUPS = TEXTURE_SIZE / 8;
    // sizeof(uint32_t): the run counter, the compute shader's push constants.
    const PUSH_CONSTANTS_SIZE = 4;
    // 100Hz.
    const COMPUTE_INTERVAL_MICROSECONDS = 10000;

    // --- Passes -------------------------------------------------------------------------------

    // Port of Donut-Samples' async_compute.cpp: a worker thread animates simplex noise into textures
    // on the compute queue at 100Hz, independently of the frame rate, and the render pass draws the
    // newest finished one.
    //
    // The worker thread (Donut_CreateAsyncComputeLoop) is C++: tslang code can't run on threads its
    // GC doesn't know about. This class creates everything it runs, and does the rendering.
    class AsyncComputePass {
        private app: App;
        private vertexShader: Opaque;
        private pixelShader: Opaque;
        private computeShader: Opaque;
        private drawBindingLayout: Opaque;
        private sampler: Opaque;
        private computeLoop: AsyncComputeLoop;
        // Created on the first frame (it depends on the framebuffer layout), dropped on resize.
        private graphicsPipeline: Opaque | null;

        constructor(app: App) {
            this.app = app;
            this.graphicsPipeline = null;
        }

        onBackBufferResizing(): void {
            const graphicsPipeline = this.graphicsPipeline;
            if (graphicsPipeline) {
                this.app.releaseResource(graphicsPipeline);
                this.graphicsPipeline = null;
            }
        }

        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            let graphicsPipeline = this.graphicsPipeline;
            if (!graphicsPipeline) {
                graphicsPipeline = this.app.createGraphicsPipelineWithTopology(frame, this.vertexShader, this.pixelShader,
                    null, this.drawBindingLayout, PrimitiveType.TriangleStrip);
                this.graphicsPipeline = graphicsPipeline;
            }

            const texture = this.computeLoop.acquireTexture(frame);

            frame.clearColor(0.0, 0.0, 0.0, 0.0);

            if (texture) {
                const bindingSetDesc = BindingSetDesc.create();
                bindingSetDesc.bindTextureSRV(0, texture);
                bindingSetDesc.bindSampler(0, this.sampler);
                const bindingSet = this.app.getCachedBindingSet(bindingSetDesc, this.drawBindingLayout);

                frame.beginDraw(graphicsPipeline);
                frame.drawAddBindingSet(bindingSet);
                frame.drawVertices(4);
            }
        }

        // Joins the worker thread; before Donut_DestroyApp.
        stop(): void {
            this.computeLoop.stop();
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.vertexShader = this.app.createShader("async_compute.hlsl", "main_vs", ShaderType.Vertex);
            this.pixelShader = this.app.createShader("async_compute.hlsl", "main_ps", ShaderType.Pixel);
            this.computeShader = this.app.createShader("async_compute.hlsl", "main_cs", ShaderType.Compute);

            if (!this.vertexShader || !this.pixelShader || !this.computeShader) {
                return false;
            }

            // Trilinear, clamped: nvrhi::SamplerDesc's defaults, as the sample creates it.
            this.sampler = this.app.getCommonSampler(CommonSampler.LinearClamp);

            const drawLayoutDesc = BindingLayoutDesc.create();
            drawLayoutDesc.layoutTextureSRV(0);
            drawLayoutDesc.layoutSampler(0);
            this.drawBindingLayout = this.app.createBindingLayout(drawLayoutDesc, ShaderType.Pixel);

            const computeLayoutDesc = BindingLayoutDesc.create();
            computeLayoutDesc.layoutPushConstants(0, PUSH_CONSTANTS_SIZE);
            computeLayoutDesc.layoutTextureUAV(0);
            const computeBindingLayout = this.app.createBindingLayout(computeLayoutDesc, ShaderType.Compute);

            const computePipeline = this.app.createComputePipelineWithLayout(this.computeShader, computeBindingLayout);

            const computeLoop = this.app.createAsyncComputeLoop(computePipeline, computeBindingLayout,
                COMPUTE_GROUPS, COMPUTE_GROUPS, COMPUTE_INTERVAL_MICROSECONDS);
            if (computeLoop.isNull()) {
                console.log("The graphics device has no compute queue");
                return false;
            }
            this.computeLoop = computeLoop;

            for (let i = 0; i < NUM_TEXTURES; i++) {
                computeLoop.addTexture(this.app.createUAVTexture(TEXTURE_SIZE, TEXTURE_SIZE, "AsyncComputeTexture"));
            }

            computeLoop.start();

            const pass = this.app.addPass();
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setAnimateCallback(this.onAnimate);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("async_compute");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        let options = AppOptions.ComputeQueue;
        for (let i = 1; i < argc; i++) {
            if (Donut_GetArg(argv, i) == "-debug") {
                options = AppOptions.ComputeQueue | AppOptions.DebugRuntime;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const asyncCompute = new AsyncComputePass(app);
        if (!asyncCompute.init()) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        asyncCompute.stop();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return AsyncCompute.main(argc, argv);
}

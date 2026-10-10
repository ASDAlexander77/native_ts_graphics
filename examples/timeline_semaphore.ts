// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace TimelineSemaphore {
    const WINDOW_TITLE = "Donut Example: Timeline Semaphore";

    // The Game of Life grid, and the images it alternates between (the sample's NumAsyncFrames).
    const GRID_WIDTH = 64;
    const GRID_HEIGHT = 64;
    const NUM_ASYNC_FRAMES = 2;

    // The push constants: float counter.
    const PUSH_SIZE = 4;

    // The render pass's clear color.
    const CLEAR_COLOR = [0.033, 0.073, 0.133];

    // --- Pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' timeline_semaphore: Conway's Game of Life on a 64 x 64 grid, a step a
    // second on the compute queue (between steps the living cells' colors fade in), drawn on the
    // graphics queue in a square over the screen. The sample runs the two queues' work on two CPU
    // threads, ordered by one timeline semaphore (the main thread signals "submit", the compute
    // thread's submission signals "draw", the graphics thread's submission waits for it and
    // signals "present", which the main thread waits for). Here the frame does it in order: what
    // the frame recorded so far goes to the graphics queue, the compute command list to the
    // compute queue after it, and the frame's draw waits for the compute work (NVRHI orders the
    // queues with timeline semaphores on Vulkan, fences on D3D12). Without a compute queue (D3D11)
    // the compute work goes on the frame's command list, as the sample does when its compute and
    // graphics queues are the same.
    class TimelineSemaphorePass {
        private app: App;

        private initPipeline: Opaque;
        private mutatePipeline: Opaque;
        private updatePipeline: Opaque;
        private renderVS: Opaque;
        private renderPS: Opaque;
        private computeCommandList: CommandList | null;
        private images: Opaque[];
        // Per image: the compute binding set writing it (reading the other), and the graphics one
        // reading it.
        private storageBindingSets: BindingSet[];
        private sampledBindingSets: BindingSet[];
        private graphicsBindingLayout: Opaque;

        // The sample's timeline frame, and its compute timer: seconds since the last step.
        private frameNumber: int;
        private computeElapsed: number;
        // -benchmark: 1/60 second per frame instead of the clock.
        benchmark: boolean;

        // A framebuffer per back buffer, for the back buffers' size, and the pipeline made for them.
        private framebuffers: Opaque[];
        private targetWidth: int;
        private targetHeight: int;
        private renderPipeline: Opaque;
        private pipelineCreated: boolean;

        // Upload buffer.
        private push: f32[];

        constructor(app: App) {
            this.app = app;
            this.computeCommandList = null;
            this.images = [];
            this.storageBindingSets = [];
            this.sampledBindingSets = [];
            this.frameNumber = 0;
            this.computeElapsed = 0.0;
            this.benchmark = false;
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.pipelineCreated = false;
            this.push = [0.0];
        }

        onAnimate(elapsedSeconds: number): void {
            this.computeElapsed += this.benchmark ? 1.0 / 60.0 : elapsedSeconds;
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        // The framebuffers of the back buffers go before the back buffers do.
        onBackBufferResizing(): void {
            this.releaseTargets();
        }

        releaseTargets(): void {
            for (let i = 0; i < this.framebuffers.length; i++) {
                this.app.releaseResource(this.framebuffers[i]);
            }
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
        }

        createTargets(width: int, height: int): void {
            this.releaseTargets();
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), null));
            }
            // The sample's graphics pipeline: no culling, no depth, no blending.
            if (!this.pipelineCreated) {
                const desc = GraphicsPipelineDesc.create(this.renderVS, this.renderPS);
                desc.addBindingLayout(this.graphicsBindingLayout);
                desc.setDepthState(0, 0, ComparisonFunc.Always);
                desc.setRasterState(CullMode.None, FillMode.Solid, 0);
                this.renderPipeline = this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]);
                this.pipelineCreated = true;
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        // The sample's build_compute_command_buffers: this frame's image from the previous one,
        // stepped once the timer passes a second (and the timer restarted), else its cells'
        // intensity raised to the seconds since the last step.
        recordCompute(commandList: CommandList): void {
            const frameIndex = this.frameNumber % NUM_ASYNC_FRAMES;
            if (this.computeElapsed > 1.0) {
                // (The layout's push constants are set for every dispatch; the step doesn't read them.)
                commandList.dispatchWithPushConstants(this.updatePipeline, this.storageBindingSets[frameIndex],
                    Ref(this.push[0]), PUSH_SIZE, GRID_WIDTH / 8, GRID_HEIGHT / 8, 1);
                this.computeElapsed = 0.0;
            } else {
                this.push[0] = this.computeElapsed;
                commandList.dispatchWithPushConstants(this.mutatePipeline, this.storageBindingSets[frameIndex],
                    Ref(this.push[0]), PUSH_SIZE, GRID_WIDTH / 8, GRID_HEIGHT / 8, 1);
            }
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            // Compute, then graphics after it.
            const computeCommandList = this.computeCommandList;
            if (computeCommandList) {
                computeCommandList.open();
                this.recordCompute(computeCommandList);
                computeCommandList.close();
                this.app.executeFrameComputeWork(frame, computeCommandList);
            } else {
                this.recordCompute(commandList);
            }

            // The sample's build_graphics_command_buffer: this frame's image in the largest square
            // centered in the window.
            let left = 0.0;
            let top = 0.0;
            let size = width;
            if (width > height) {
                left = 0.5 * (width - height);
                size = height;
            } else if (height > width) {
                top = 0.5 * (height - width);
            }
            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), CLEAR_COLOR[0], CLEAR_COLOR[1], CLEAR_COLOR[2], 0.0);
            frame.beginDrawToFramebuffer(this.renderPipeline, this.framebuffers[index]);
            frame.drawAddBindingSet(this.sampledBindingSets[this.frameNumber % NUM_ASYNC_FRAMES]);
            frame.drawSetViewport(left, top, size, size);
            frame.drawVertices(3);

            this.frameNumber++;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "timeline_semaphore.hlsl";
            const initCS = this.app.createShader(shader, "init_cs", ShaderType.Compute);
            const mutateCS = this.app.createShader(shader, "mutate_cs", ShaderType.Compute);
            const updateCS = this.app.createShader(shader, "update_cs", ShaderType.Compute);
            this.renderVS = this.app.createShader(shader, "render_vs", ShaderType.Vertex);
            this.renderPS = this.app.createShader(shader, "render_ps", ShaderType.Pixel);
            if (!initCS || !mutateCS || !updateCS || !this.renderVS || !this.renderPS) {
                return false;
            }

            const computeCommandList = this.app.createComputeQueueCommandList();
            if (!computeCommandList.isNull()) {
                this.computeCommandList = computeCommandList;
            }

            // The sample's shared resources: the images, and an immutable sampler (nearest,
            // repeating).
            for (let i = 0; i < NUM_ASYNC_FRAMES; i++) {
                this.images.push(this.app.createUAVTexture(GRID_WIDTH, GRID_HEIGHT, `Game of Life ${i}`));
            }
            const sampler = this.app.createSamplerWithDesc(0, 0, 0, SamplerAddressMode.Wrap, 0.0, 0.0, 1000.0, 1.0);

            const computeLayoutDesc = BindingLayoutDesc.create();
            computeLayoutDesc.layoutTextureUAV(0);
            computeLayoutDesc.layoutTextureSRV(0);
            computeLayoutDesc.layoutSampler(0);
            computeLayoutDesc.layoutPushConstants(0, PUSH_SIZE);
            const computeBindingLayout = this.app.createBindingLayout(computeLayoutDesc, ShaderType.Compute);
            const graphicsLayoutDesc = BindingLayoutDesc.create();
            graphicsLayoutDesc.layoutTextureSRV(0);
            graphicsLayoutDesc.layoutSampler(0);
            this.graphicsBindingLayout = this.app.createBindingLayout(graphicsLayoutDesc, ShaderType.Pixel);
            for (let i = 0; i < NUM_ASYNC_FRAMES; i++) {
                const storageDesc = BindingSetDesc.create();
                storageDesc.bindTextureUAV(0, this.images[i]);
                storageDesc.bindTextureSRV(0, this.images[(i + NUM_ASYNC_FRAMES - 1) % NUM_ASYNC_FRAMES]);
                storageDesc.bindSampler(0, sampler);
                storageDesc.bindPushConstants(0, PUSH_SIZE);
                this.storageBindingSets.push(this.app.createBindingSetForLayout(storageDesc, computeBindingLayout));
                const sampledDesc = BindingSetDesc.create();
                sampledDesc.bindTextureSRV(0, this.images[i]);
                sampledDesc.bindSampler(0, sampler);
                this.sampledBindingSets.push(this.app.createBindingSetForLayout(sampledDesc, this.graphicsBindingLayout));
            }
            this.initPipeline = this.app.createComputePipelineWithLayout(initCS, computeBindingLayout);
            this.mutatePipeline = this.app.createComputePipelineWithLayout(mutateCS, computeBindingLayout);
            this.updatePipeline = this.app.createComputePipelineWithLayout(updateCS, computeBindingLayout);

            // The sample's setup_game_of_life: both images get the starting pattern.
            const commandList = this.app.createCommandList();
            commandList.open();
            for (let i = 0; i < NUM_ASYNC_FRAMES; i++) {
                commandList.dispatchWithPushConstants(this.initPipeline, this.storageBindingSets[i], Ref(this.push[0]), PUSH_SIZE,
                    GRID_WIDTH / 8, GRID_HEIGHT / 8, 1);
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
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
        Donut_SetAppName("timeline_semaphore");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -benchmark: 1/60 second per frame instead of the clock.
        let options = AppOptions.ComputeQueue;
        let benchmark = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-benchmark") {
                benchmark = true;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new TimelineSemaphorePass(app);
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
    return TimelineSemaphore.main(argc, argv);
}

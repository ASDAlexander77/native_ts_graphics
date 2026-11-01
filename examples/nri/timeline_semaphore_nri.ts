/// <reference path="../../core/nri/nri_interop.d.ts" />

namespace TimelineSemaphoreNri {
    // timeline_semaphore, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (timeline_semaphore.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws. This example creates everything
    // it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Timeline Semaphore";

    // The Game of Life grid, and the images it alternates between (the sample's NumAsyncFrames).
    const GRID_WIDTH = 64;
    const GRID_HEIGHT = 64;
    const NUM_ASYNC_FRAMES = 2;
    // The compute shaders run 8 x 8 threads per group.
    const GROUPS_X = GRID_WIDTH / 8;
    const GROUPS_Y = GRID_HEIGHT / 8;

    // The root constants: float counter.
    const PUSH_SIZE = 4;

    // The render pass's clear color.
    const CLEAR_COLOR = [0.033, 0.073, 0.133];
    // ... in the sRGB back buffer (0xBBGGRR).
    const CLEAR_RGB = 0x664C33;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into: the graphics queue's command buffer, and the compute
    // queue's.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public computeCommandAllocator: NriCommandAllocatorHandle | null, public computeCommandBuffer: NriCommandBufferHandle | null) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // A Game of Life image, its views, and the descriptor sets binding it: the compute pipelines'
    // writing it (reading the other image), and the draw's.
    class GridImage {
        constructor(public texture: NriTextureHandle, public storageView: NriDescriptorHandle, public view: NriDescriptorHandle,
            public computeSet: NriDescriptorSetHandle | null, public drawSet: NriDescriptorSetHandle | null) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does: the corners are the blue
    // background, beside the square grid; about a tenth of its cells are alive (white) by then.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != CLEAR_RGB) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not ${CLEAR_RGB & 0xFF}, ${(CLEAR_RGB >> 8) & 0xFF}, ${(CLEAR_RGB >> 16) & 0xFF}`;
            }
        }
        const x0 = Math.floor((width - height) / 2);
        let live = 0;
        for (let y = 0; y < height; y++) {
            for (let x = x0; x < x0 + height; x++) {
                const p = pixels[y * width + x];
                if ((p & 0xFF) >= 201 && ((p >> 8) & 0xFF) >= 201 && ((p >> 16) & 0xFF) >= 201) {
                    live++;
                }
            }
        }
        const percent = 100.0 * live / (height * height);
        console.log(`Live cells: ${percent}% (${live} of ${height * height} pixels)`);
        if (percent < 5.0 || percent > 20.0) {
            return `Live cells: ${percent}% of the pixels, not 5% to 20%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' timeline_semaphore (as examples/timeline_semaphore.ts ports it) to
    // NRI: Conway's Game of Life on a 64 x 64 grid, a step a second on the compute queue (between
    // steps the living cells' colors fade in), drawn on the graphics queue in a square over the
    // screen. NRI's fences are timeline semaphores (D3D12 fences), as the sample orders its queues:
    // a frame's compute work waits for the previous frame's graphics work (frameFence), and signals
    // computeFence with the frame's number, which the frame's graphics work waits for. Without a
    // compute queue the compute work goes on the frame's command buffer, as the sample does when its
    // compute and graphics queues are the same.
    //
    // The images' states change on the graphics queue only (D3D12's compute queue can't make pixel
    // shader resource transitions): a frame moves the image its compute work wrote to
    // AllShaderResource (drawn now, read by the next frame's compute work), and the other one, which
    // its compute work read, back to Storage (written by the next frame's).
    class TimelineSemaphore {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private computeQueue: NriQueueHandle | null = null;
        private frameFence: NriFenceHandle;
        private computeFence: NriFenceHandle | null = null;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private drawLayout: NriPipelineLayoutHandle | null = null;
        private drawPipeline: NriPipelineHandle | null = null;
        private computeLayout: NriPipelineLayoutHandle | null = null;
        private initPipeline: NriPipelineHandle | null = null;
        private mutatePipeline: NriPipelineHandle | null = null;
        private updatePipeline: NriPipelineHandle | null = null;
        private sampler: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private images: GridImage[] = [];
        private width: int = 0;
        private height: int = 0;

        // The sample's timeline frame (the frames drawn), and its compute timer: seconds since the
        // last step.
        private frameNumber: int = 0;
        private computeElapsed: number = 0.0;
        // -benchmark: 1/60 second per frame instead of the clock (as in test mode).
        benchmark: boolean = false;

        // Upload buffer.
        private push: f32[] = [0.0];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
        }

        // Renders until the window is closed (in test mode, the test's frames); the exit code.
        run(argc: int, argv: Ref<string>): int {
            const initialize: NriInitializeCallback = this.initialize;
            const latencySleep: NriFrameCallback = this.latencySleep;
            const renderFrame: NriFrameCallback = this.renderFrame;
            retainedInitializeCallbacks.push(initialize);
            retainedFrameCallbacks.push(latencySleep);
            retainedFrameCallbacks.push(renderFrame);
            Nri_SetInitializeCallback(this.sample, initialize);
            Nri_SetLatencySleepCallback(this.sample, latencySleep);
            Nri_SetRenderFrameCallback(this.sample, renderFrame);

            let result = Nri_RunSample(this.sample, argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (result == 0 && this.test) {
                const failure = checkFrame(this.readBack(), this.width, this.height);
                console.log(failure == "" ? "Test PASSED" : `Test FAILED: ${failure}`);
                result = failure == "" ? 0 : 1;
            }
            this.destroy();
            return result;
        }

        initialize(graphicsAPI: NriGraphicsAPI): int {
            const device = Nri_CreateDevice(this.sample, graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri_GetGraphicsAPIString(graphicsAPI)} (${Nri_GetAdapterName(device)})`);

            this.queue = Nri_GetGraphicsQueue(device);
            this.computeQueue = Nri_GetComputeQueue(device);
            this.frameFence = Nri_CreateFence(device, 0);
            if (this.computeQueue) {
                this.computeFence = Nri_CreateFence(device, 0);
            }
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.test = Nri_IsTest(this.sample) != 0;

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, queuedFrameNum + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            const viewFormat = Nri_GetSrgbFormat(format);
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(this.swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, viewFormat),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }

            // Queued frames
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                this.queuedFrames.push(this.createQueuedFrame(commandAllocator));
            }

            // The layouts: the compute pipelines' counter (push constants, b0), this frame's image
            // (u0), the previous one (t0) and the sampler (s0); the draw's image (t0) and sampler (s0).
            const computeLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(computeLayoutDesc, 0, PUSH_SIZE, NriStage.Compute);
            Nri_PipelineLayoutDescAddRange(computeLayoutDesc, 0, 0, 1, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(computeLayoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(computeLayoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Compute, NriRangeFlags.None);
            this.computeLayout = Nri_CreatePipelineLayoutFromDesc(device, computeLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(computeLayoutDesc);
            const drawLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(drawLayoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(drawLayoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.drawLayout = Nri_CreatePipelineLayoutFromDesc(device, drawLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(drawLayoutDesc);
            const computeLayout = this.computeLayout;
            const drawLayout = this.drawLayout;
            if (!computeLayout || !drawLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: timeline_semaphore.hlsl's shaders, as compiled for the Donut example;
            // the draw a triangle over the viewport (no culling, no depth, no blending).
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/timeline_semaphore/${folder}/timeline_semaphore`;
            this.initPipeline = Nri_CreateComputePipeline(device, computeLayout, `${shaders}_init_cs.bin`, "init_cs");
            this.mutatePipeline = Nri_CreateComputePipeline(device, computeLayout, `${shaders}_mutate_cs.bin`, "mutate_cs");
            this.updatePipeline = Nri_CreateComputePipeline(device, computeLayout, `${shaders}_update_cs.bin`, "update_cs");
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_render_vs.bin`, "render_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_render_ps.bin`, "render_ps") != 0;
            }
            Nri_PipelineDescSetCullMode(desc, NriCullMode.None);
            Nri_PipelineDescSetColor(desc, viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.drawPipeline = Nri_CreatePipelineFromDesc(device, drawLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            const initPipeline = this.initPipeline;
            if (!initPipeline || !this.mutatePipeline || !this.updatePipeline || !this.drawPipeline) {
                console.log("Cannot load the timeline semaphore shaders");
                return 0;
            }

            // The sample's shared resources: the images, and an immutable sampler (nearest,
            // repeating).
            const sampler = Nri_CreateSampler(device, NriFilter.Nearest, NriAddressMode.Repeat, 1);
            this.sampler = sampler;
            const descriptorPool = Nri_CreateDescriptorPool(device, 2 * NUM_ASYNC_FRAMES, 2 * NUM_ASYNC_FRAMES, 0, 2 * NUM_ASYNC_FRAMES,
                NUM_ASYNC_FRAMES, 0);
            this.descriptorPool = descriptorPool;
            if (!sampler || !descriptorPool) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            for (let i = 0; i < NUM_ASYNC_FRAMES; i++) {
                const texture = Nri_CreateStorageTexture(device, this.queue, GRID_WIDTH, GRID_HEIGHT, NriFormat.RGBA8_UNORM);
                if (!texture) {
                    console.log("Cannot create the images");
                    return 0;
                }
                this.images.push(new GridImage(texture, Nri_CreateStorageTextureView(texture, NriFormat.RGBA8_UNORM),
                    Nri_CreateTextureView(texture, NriFormat.RGBA8_UNORM), Nri_AllocateDescriptorSet(descriptorPool, computeLayout, 0, 0),
                    Nri_AllocateDescriptorSet(descriptorPool, drawLayout, 0, 0)));
            }
            for (let i = 0; i < NUM_ASYNC_FRAMES; i++) {
                const image = this.images[i];
                const computeSet = image.computeSet;
                const drawSet = image.drawSet;
                if (!computeSet || !drawSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(computeSet, 0, 0, image.storageView);
                Nri_UpdateDescriptor(computeSet, 1, 0, this.images[(i + NUM_ASYNC_FRAMES - 1) % NUM_ASYNC_FRAMES].view);
                Nri_UpdateDescriptor(computeSet, 2, 0, sampler);
                Nri_UpdateDescriptor(drawSet, 0, 0, image.view);
                Nri_UpdateDescriptor(drawSet, 1, 0, sampler);
            }

            // The sample's setup_game_of_life: both images get the starting pattern. Each dispatch's
            // set holds the other image too, which must be readable then (D3D12 checks the states of
            // a set's resources when it's bound); the last image, the first frame's previous one,
            // stays readable. A command buffer per dispatch: within one, NRI's D3D11 backend unbinds
            // the second dispatch's u0 when its t0 is the image the first one wrote (it unbinds the
            // UAV slot that image was bound to, without checking what's bound there now).
            const commandAllocator = Nri_CreateCommandAllocator(this.queue);
            const commandBuffer = Nri_CreateCommandBuffer(commandAllocator);
            const setupFence = Nri_CreateFence(device, 0);
            for (let i = 0; i < NUM_ASYNC_FRAMES; i++) {
                const other = this.images[(i + NUM_ASYNC_FRAMES - 1) % NUM_ASYNC_FRAMES].texture;
                Nri_ResetCommandAllocator(commandAllocator);
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
                Nri_CmdSetComputePipelineLayout(commandBuffer, computeLayout);
                Nri_CmdSetPipeline(commandBuffer, initPipeline);
                Nri_CmdTextureBarrier(commandBuffer, other, NriTextureState.Storage, NriTextureState.AllShaderResource);
                this.dispatch(commandBuffer, i);
                Nri_CmdTextureBarrier(commandBuffer, other, NriTextureState.AllShaderResource, NriTextureState.Storage);
                if (i == NUM_ASYNC_FRAMES - 1) {
                    Nri_CmdTextureBarrier(commandBuffer, this.images[i].texture, NriTextureState.Storage, NriTextureState.AllShaderResource);
                }
                Nri_EndCommandBuffer(commandBuffer);
                Nri_QueueSubmitWithFences(this.queue, commandBuffer, null, 0, setupFence, 1 + i);
                Nri_Wait(setupFence, 1 + i);
            }
            Nri_DestroyFence(setupFence);
            Nri_DestroyCommandBuffer(commandBuffer);
            Nri_DestroyCommandAllocator(commandAllocator);

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // A queued frame recording into commandAllocator's command buffer, and, with a compute
        // queue, into one of its own.
        createQueuedFrame(commandAllocator: NriCommandAllocatorHandle): QueuedFrame {
            const computeQueue = this.computeQueue;
            if (!computeQueue) {
                return new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), null, null);
            }
            const computeCommandAllocator = Nri_CreateCommandAllocator(computeQueue);
            return new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), computeCommandAllocator,
                Nri_CreateCommandBuffer(computeCommandAllocator));
        }

        // The compute pipeline set, on the image numbered index (reading the previous one), with the
        // counter.
        dispatch(commandBuffer: NriCommandBufferHandle, index: int) {
            const computeSet = this.images[index].computeSet;
            if (!computeSet) {
                return;
            }
            Nri_CmdSetComputeDescriptorSet(commandBuffer, 0, computeSet);
            Nri_CmdSetComputeRootConstants(commandBuffer, 0, Ref(this.push[0]), PUSH_SIZE);
            Nri_CmdDispatch(commandBuffer, GROUPS_X, GROUPS_Y, 1);
        }

        // Waits for the frame that last used this frame's command allocators (its compute work done
        // before it).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
            const computeCommandAllocator = queuedFrame.computeCommandAllocator;
            if (computeCommandAllocator) {
                Nri_ResetCommandAllocator(computeCommandAllocator);
            }
        }

        // The sample's build_compute_command_buffers: this frame's image from the previous one,
        // stepped once the timer passes a second (and the timer restarted), else its cells'
        // intensity raised to the seconds since the last step.
        recordCompute(commandBuffer: NriCommandBufferHandle) {
            const computeLayout = this.computeLayout;
            const descriptorPool = this.descriptorPool;
            const updatePipeline = this.updatePipeline;
            const mutatePipeline = this.mutatePipeline;
            if (!computeLayout || !descriptorPool || !updatePipeline || !mutatePipeline) {
                return;
            }
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetComputePipelineLayout(commandBuffer, computeLayout);
            if (this.computeElapsed > 1.0) {
                // (The layout's push constants are set for every dispatch; the step doesn't read them.)
                Nri_CmdSetPipeline(commandBuffer, updatePipeline);
                this.computeElapsed = 0.0;
            } else {
                this.push[0] = this.computeElapsed;
                Nri_CmdSetPipeline(commandBuffer, mutatePipeline);
            }
            this.dispatch(commandBuffer, this.frameNumber % NUM_ASYNC_FRAMES);
        }

        // The sample's build_graphics_command_buffer: this frame's image in the largest square
        // centered in the window (between Nri_CmdBeginRendering and Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle) {
            const drawLayout = this.drawLayout;
            const drawPipeline = this.drawPipeline;
            const descriptorPool = this.descriptorPool;
            const drawSet = this.images[this.frameNumber % NUM_ASYNC_FRAMES].drawSet;
            if (!drawLayout || !drawPipeline || !descriptorPool || !drawSet) {
                return;
            }
            let left = 0.0;
            let top = 0.0;
            let size = this.width;
            if (this.width > this.height) {
                left = 0.5 * (this.width - this.height);
                size = this.height;
            } else if (this.height > this.width) {
                top = 0.5 * (this.height - this.width);
            }
            Nri_CmdSetViewport(commandBuffer, left, top, size, size);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, drawLayout);
            Nri_CmdSetPipeline(commandBuffer, drawPipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, drawSet);
            Nri_CmdDraw(commandBuffer, 3, 1, 0, 0);
        }

        // Compute, then graphics after it.
        renderFrame(frameIndex: int) {
            const queuedFrame = this.queuedFrames[frameIndex % this.queuedFrames.length];
            this.computeElapsed += this.benchmark || this.test ? 1.0 / 60.0 : Nri_GetFrameTime(this.sample);

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;
                const current = this.frameNumber % NUM_ASYNC_FRAMES;
                const previous = (current + NUM_ASYNC_FRAMES - 1) % NUM_ASYNC_FRAMES;

                // The compute work: on the compute queue once the previous frame's graphics work is
                // done (its image states changed), signaling computeFence with this frame's number.
                const computeQueue = this.computeQueue;
                const computeFence = this.computeFence;
                const computeCommandBuffer = queuedFrame.computeCommandBuffer;
                Nri_BeginCommandBuffer(commandBuffer);
                if (!computeQueue || !computeFence || !computeCommandBuffer) {
                    this.recordCompute(commandBuffer);
                } else {
                    Nri_BeginCommandBuffer(computeCommandBuffer);
                    this.recordCompute(computeCommandBuffer);
                    Nri_EndCommandBuffer(computeCommandBuffer);
                    Nri_QueueSubmitWithFences(computeQueue, computeCommandBuffer, this.frameFence, frameIndex, computeFence, 1 + this.frameNumber);
                    // The graphics work submitted from now on waits for it.
                    Nri_QueueWait(this.queue, computeFence, 1 + this.frameNumber);
                }

                // Record: this frame's image to be drawn (and read by the next frame's compute
                // work), the previous one to be written by it.
                Nri_CmdTextureBarrier(commandBuffer, this.images[current].texture, NriTextureState.Storage, NriTextureState.AllShaderResource);
                Nri_CmdTextureBarrier(commandBuffer, this.images[previous].texture, NriTextureState.AllShaderResource, NriTextureState.Storage);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                Nri_CmdClearColor(commandBuffer, CLEAR_COLOR[0], CLEAR_COLOR[1], CLEAR_COLOR[2], 0.0);
                this.recordDraw(commandBuffer);
                Nri_CmdEndRendering(commandBuffer);

                // The test's last frame: read back
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                        Nri_CmdReadbackTextureToBuffer(commandBuffer, readbackBuffer, this.rowPitch, swapChainTexture.texture, this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                    }
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, presentFrom, NriTextureState.Present);
                Nri_EndCommandBuffer(commandBuffer);

                // Submit and present
                Nri_QueueSubmit(this.queue, commandBuffer, acquireSemaphore, swapChainTexture.releaseSemaphore);
                Nri_QueuePresent(this.swapChain, swapChainTexture.releaseSemaphore);
                this.frameNumber++;
            }

            // Signaled after the present, as NRISamples do
            Nri_QueueSignal(this.queue, this.frameFence, 1 + frameIndex);
        }

        // The last frame's pixels (0xAABBGGRR), empty if it can't be read.
        readBack(): int[] {
            const device = this.device;
            const readbackBuffer = this.readbackBuffer;
            if (!device || !readbackBuffer) {
                return [];
            }
            Nri_DeviceWaitIdle(device);
            const pixels: int[] = [];
            for (let i = 0; i < this.width * this.height; i++) {
                pixels.push(0);
            }
            if (Nri_ReadBufferRGBA8(readbackBuffer, this.rowPitch, this.width, this.height, this.readbackFormat,
                Ref(pixels[0]), pixels.length) == 0) {
                return [];
            }
            return pixels;
        }

        destroy() {
            const device = this.device;
            if (device) {
                Nri_DeviceWaitIdle(device);
                for (const queuedFrame of this.queuedFrames) {
                    Nri_DestroyCommandBuffer(queuedFrame.commandBuffer);
                    Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
                    this.destroyComputeCommands(queuedFrame);
                }
                for (const swapChainTexture of this.swapChainTextures) {
                    Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                    Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                    Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
                }
                for (const image of this.images) {
                    Nri_DestroyDescriptor(image.storageView);
                    Nri_DestroyDescriptor(image.view);
                    Nri_DestroyTexture(image.texture);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                const sampler = this.sampler;
                if (sampler) {
                    Nri_DestroyDescriptor(sampler);
                }
                this.destroyPipeline(this.drawPipeline);
                this.destroyPipeline(this.initPipeline);
                this.destroyPipeline(this.mutatePipeline);
                this.destroyPipeline(this.updatePipeline);
                const drawLayout = this.drawLayout;
                if (drawLayout) {
                    Nri_DestroyPipelineLayout(drawLayout);
                }
                const computeLayout = this.computeLayout;
                if (computeLayout) {
                    Nri_DestroyPipelineLayout(computeLayout);
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
                }
                const computeFence = this.computeFence;
                if (computeFence) {
                    Nri_DestroyFence(computeFence);
                }
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }

        destroyComputeCommands(queuedFrame: QueuedFrame) {
            const computeCommandBuffer = queuedFrame.computeCommandBuffer;
            const computeCommandAllocator = queuedFrame.computeCommandAllocator;
            if (!computeCommandBuffer || !computeCommandAllocator) {
                return;
            }
            Nri_DestroyCommandBuffer(computeCommandBuffer);
            Nri_DestroyCommandAllocator(computeCommandAllocator);
        }

        destroyPipeline(pipeline: NriPipelineHandle | null) {
            if (pipeline) {
                Nri_DestroyPipeline(pipeline);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const timelineSemaphore = new TimelineSemaphore(sample);
        // -benchmark: 1/60 second per frame instead of the clock.
        Nri_AddExampleOption(sample, "-benchmark");
        for (let i = 1; i < argc; i++) {
            if (Nri_GetArg(argc, argv, i) == "-benchmark") {
                timelineSemaphore.benchmark = true;
            }
        }
        return timelineSemaphore.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return TimelineSemaphoreNri.main(argc, argv);
}

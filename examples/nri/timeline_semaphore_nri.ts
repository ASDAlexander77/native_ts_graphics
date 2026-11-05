/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriSwapChain } from "../../core/nri_swap_chain";
import { Nri, NriBuffer, NriCommandAllocator, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriFence, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

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
        constructor(public commandAllocator: NriCommandAllocator, public commandBuffer: NriCommandBuffer,
            public computeCommandAllocator: NriCommandAllocator | null, public computeCommandBuffer: NriCommandBuffer | null) {
        }
    }

    // A Game of Life image, its views, and the descriptor sets binding it: the compute pipelines'
    // writing it (reading the other image), and the draw's.
    class GridImage {
        constructor(public texture: NriTexture, public storageView: NriDescriptor, public view: NriDescriptor,
            public computeSet: NriDescriptorSet | null, public drawSet: NriDescriptorSet | null) {
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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private computeQueue: NriQueue | null = null;
        private frameFence: NriFence;
        private computeFence: NriFence | null = null;
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private drawLayout: NriPipelineLayout | null = null;
        private drawPipeline: NriPipeline | null = null;
        private computeLayout: NriPipelineLayout | null = null;
        private initPipeline: NriPipeline | null = null;
        private mutatePipeline: NriPipeline | null = null;
        private updatePipeline: NriPipeline | null = null;
        private sampler: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private images: GridImage[] = [];
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views' (the swap chain's).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private swapChainViewFormat: NriFormat = NriFormat.Unknown;

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
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
        }

        // Renders until the window is closed (in test mode, the test's frames); the exit code.
        run(argc: int, argv: Ref<string>): int {
            const initialize: NriInitializeCallback = this.initialize;
            const latencySleep: NriFrameCallback = this.latencySleep;
            const renderFrame: NriFrameCallback = this.renderFrame;
            retainedInitializeCallbacks.push(initialize);
            retainedFrameCallbacks.push(latencySleep);
            retainedFrameCallbacks.push(renderFrame);
            this.sample.setInitializeCallback(initialize);
            this.sample.setLatencySleepCallback(latencySleep);
            this.sample.setRenderFrameCallback(renderFrame);

            let result = this.sample.run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (result == 0 && this.test) {
                const failure = checkFrame(this.readBack(), this.width, this.height);
                console.log(failure == "" ? "Test PASSED" : `Test FAILED: ${failure}`);
                result = failure == "" ? 0 : 1;
            }
            this.destroy();
            return result;
        }

        initialize(graphicsAPI: NriGraphicsAPI): int {
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);

            this.queue = device.getGraphicsQueue();
            this.computeQueue = device.getComputeQueue();
            this.frameFence = device.createFence(0);
            if (this.computeQueue) {
                this.computeFence = device.createFence(0);
            }
            this.test = this.sample.isTest() != 0;

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;

            // Queued frames
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = this.queue.createCommandAllocator();
                this.queuedFrames.push(this.createQueuedFrame(commandAllocator));
            }

            // The layouts: the compute pipelines' counter (push constants, b0), this frame's image
            // (u0), the previous one (t0) and the sampler (s0); the draw's image (t0) and sampler (s0).
            const computeLayoutDesc = NriPipelineLayoutDesc.create();
            computeLayoutDesc.addRootConstants(0, PUSH_SIZE, NriStage.Compute);
            computeLayoutDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
            computeLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Compute, NriRangeFlags.None);
            computeLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Compute, NriRangeFlags.None);
            this.computeLayout = device.createPipelineLayoutFromDesc(computeLayoutDesc);
            computeLayoutDesc.destroy();
            const drawLayoutDesc = NriPipelineLayoutDesc.create();
            drawLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            drawLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.drawLayout = device.createPipelineLayoutFromDesc(drawLayoutDesc);
            drawLayoutDesc.destroy();
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
            this.initPipeline = device.createComputePipeline(computeLayout, `${shaders}_init_cs.bin`, "init_cs");
            this.mutatePipeline = device.createComputePipeline(computeLayout, `${shaders}_mutate_cs.bin`, "mutate_cs");
            this.updatePipeline = device.createComputePipeline(computeLayout, `${shaders}_update_cs.bin`, "update_cs");
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_render_vs.bin`, "render_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_render_ps.bin`, "render_ps") != 0;
            }
            desc.setCullMode(NriCullMode.None);
            desc.setColor(viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.drawPipeline = device.createPipelineFromDesc(drawLayout, desc);
            }
            desc.destroy();
            const initPipeline = this.initPipeline;
            if (!initPipeline || !this.mutatePipeline || !this.updatePipeline || !this.drawPipeline) {
                console.log("Cannot load the timeline semaphore shaders");
                return 0;
            }

            // The sample's shared resources: the images, and an immutable sampler (nearest,
            // repeating).
            const sampler = device.createSampler(NriFilter.Nearest, NriAddressMode.Repeat, 1);
            this.sampler = sampler;
            const descriptorPool = device.createDescriptorPool(2 * NUM_ASYNC_FRAMES, 2 * NUM_ASYNC_FRAMES, 0, 2 * NUM_ASYNC_FRAMES,
                NUM_ASYNC_FRAMES, 0);
            this.descriptorPool = descriptorPool;
            if (!sampler || !descriptorPool) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            for (let i = 0; i < NUM_ASYNC_FRAMES; i++) {
                const texture = device.createStorageTexture(this.queue, GRID_WIDTH, GRID_HEIGHT, NriFormat.RGBA8_UNORM);
                if (!texture) {
                    console.log("Cannot create the images");
                    return 0;
                }
                this.images.push(new GridImage(texture, texture.createStorageView(NriFormat.RGBA8_UNORM),
                    texture.createView(NriFormat.RGBA8_UNORM), descriptorPool.allocateDescriptorSet(computeLayout, 0, 0),
                    descriptorPool.allocateDescriptorSet(drawLayout, 0, 0)));
            }
            for (let i = 0; i < NUM_ASYNC_FRAMES; i++) {
                const image = this.images[i];
                const computeSet = image.computeSet;
                const drawSet = image.drawSet;
                if (!computeSet || !drawSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                computeSet.updateDescriptor(0, 0, image.storageView);
                computeSet.updateDescriptor(1, 0, this.images[(i + NUM_ASYNC_FRAMES - 1) % NUM_ASYNC_FRAMES].view);
                computeSet.updateDescriptor(2, 0, sampler);
                drawSet.updateDescriptor(0, 0, image.view);
                drawSet.updateDescriptor(1, 0, sampler);
            }

            // The sample's setup_game_of_life: both images get the starting pattern. Each dispatch's
            // set holds the other image too, which must be readable then (D3D12 checks the states of
            // a set's resources when it's bound); the last image, the first frame's previous one,
            // stays readable. A command buffer per dispatch: within one, NRI's D3D11 backend unbinds
            // the second dispatch's u0 when its t0 is the image the first one wrote (it unbinds the
            // UAV slot that image was bound to, without checking what's bound there now).
            const commandAllocator = this.queue.createCommandAllocator();
            const commandBuffer = commandAllocator.createCommandBuffer();
            const setupFence = device.createFence(0);
            for (let i = 0; i < NUM_ASYNC_FRAMES; i++) {
                const other = this.images[(i + NUM_ASYNC_FRAMES - 1) % NUM_ASYNC_FRAMES].texture;
                commandAllocator.reset();
                commandBuffer.begin();
                commandBuffer.setDescriptorPool(descriptorPool);
                commandBuffer.setComputePipelineLayout(computeLayout);
                commandBuffer.setPipeline(initPipeline);
                commandBuffer.textureBarrier(other, NriTextureState.Storage, NriTextureState.AllShaderResource);
                this.dispatch(commandBuffer, i);
                commandBuffer.textureBarrier(other, NriTextureState.AllShaderResource, NriTextureState.Storage);
                if (i == NUM_ASYNC_FRAMES - 1) {
                    commandBuffer.textureBarrier(this.images[i].texture, NriTextureState.Storage, NriTextureState.AllShaderResource);
                }
                commandBuffer.end();
                this.queue.submitWithFences(commandBuffer, null, 0, setupFence, 1 + i);
                setupFence.wait(1 + i);
            }
            setupFence.destroy();
            commandBuffer.destroy();
            commandAllocator.destroy();

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // A queued frame recording into commandAllocator's command buffer, and, with a compute
        // queue, into one of its own.
        createQueuedFrame(commandAllocator: NriCommandAllocator): QueuedFrame {
            const computeQueue = this.computeQueue;
            if (!computeQueue) {
                return new QueuedFrame(commandAllocator, commandAllocator.createCommandBuffer(), null, null);
            }
            const computeCommandAllocator = computeQueue.createCommandAllocator();
            return new QueuedFrame(commandAllocator, commandAllocator.createCommandBuffer(), computeCommandAllocator,
                computeCommandAllocator.createCommandBuffer());
        }

        // The compute pipeline set, on the image numbered index (reading the previous one), with the
        // counter.
        dispatch(commandBuffer: NriCommandBuffer, index: int) {
            const computeSet = this.images[index].computeSet;
            if (!computeSet) {
                return;
            }
            commandBuffer.setComputeDescriptorSet(0, computeSet);
            commandBuffer.setComputeRootConstants(0, Ref(this.push[0]), PUSH_SIZE);
            commandBuffer.dispatch(GROUPS_X, GROUPS_Y, 1);
        }

        // Waits for the frame that last used this frame's command allocators (its compute work done
        // before it).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            this.frameFence.wait(frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            queuedFrame.commandAllocator.reset();
            const computeCommandAllocator = queuedFrame.computeCommandAllocator;
            if (computeCommandAllocator) {
                computeCommandAllocator.reset();
            }
        }

        // The sample's build_compute_command_buffers: this frame's image from the previous one,
        // stepped once the timer passes a second (and the timer restarted), else its cells'
        // intensity raised to the seconds since the last step.
        recordCompute(commandBuffer: NriCommandBuffer) {
            const computeLayout = this.computeLayout;
            const descriptorPool = this.descriptorPool;
            const updatePipeline = this.updatePipeline;
            const mutatePipeline = this.mutatePipeline;
            if (!computeLayout || !descriptorPool || !updatePipeline || !mutatePipeline) {
                return;
            }
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setComputePipelineLayout(computeLayout);
            if (this.computeElapsed > 1.0) {
                // (The layout's push constants are set for every dispatch; the step doesn't read them.)
                commandBuffer.setPipeline(updatePipeline);
                this.computeElapsed = 0.0;
            } else {
                this.push[0] = this.computeElapsed;
                commandBuffer.setPipeline(mutatePipeline);
            }
            this.dispatch(commandBuffer, this.frameNumber % NUM_ASYNC_FRAMES);
        }

        // The sample's build_graphics_command_buffer: this frame's image in the largest square
        // centered in the window (between NriCommandBuffer.beginRendering and NriCommandBuffer.endRendering).
        recordDraw(commandBuffer: NriCommandBuffer) {
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
            commandBuffer.setViewport(left, top, size, size);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(drawLayout);
            commandBuffer.setPipeline(drawPipeline);
            commandBuffer.setDescriptorSet(0, drawSet);
            commandBuffer.draw(3, 1, 0, 0);
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain made
        // again at its size, once the GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            this.swapChain.recreate();
            this.sizeToSwapChain();
        }

        // Compute, then graphics after it.
        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrame = this.queuedFrames[frameIndex % this.queuedFrames.length];
            this.computeElapsed += this.benchmark || this.test ? 1.0 / 60.0 : this.sample.getFrameTime();

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = queuedFrame.commandBuffer;
                const current = this.frameNumber % NUM_ASYNC_FRAMES;
                const previous = (current + NUM_ASYNC_FRAMES - 1) % NUM_ASYNC_FRAMES;

                // The compute work: on the compute queue once the previous frame's graphics work is
                // done (its image states changed), signaling computeFence with this frame's number.
                const computeQueue = this.computeQueue;
                const computeFence = this.computeFence;
                const computeCommandBuffer = queuedFrame.computeCommandBuffer;
                commandBuffer.begin();
                if (!computeQueue || !computeFence || !computeCommandBuffer) {
                    this.recordCompute(commandBuffer);
                } else {
                    computeCommandBuffer.begin();
                    this.recordCompute(computeCommandBuffer);
                    computeCommandBuffer.end();
                    computeQueue.submitWithFences(computeCommandBuffer, this.frameFence, frameIndex, computeFence, 1 + this.frameNumber);
                    // The graphics work submitted from now on waits for it.
                    this.queue.wait(computeFence, 1 + this.frameNumber);
                }

                // Record: this frame's image to be drawn (and read by the next frame's compute
                // work), the previous one to be written by it.
                commandBuffer.textureBarrier(this.images[current].texture, NriTextureState.Storage, NriTextureState.AllShaderResource);
                commandBuffer.textureBarrier(this.images[previous].texture, NriTextureState.AllShaderResource, NriTextureState.Storage);
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                commandBuffer.clearColor(CLEAR_COLOR[0], CLEAR_COLOR[1], CLEAR_COLOR[2], 0.0);
                this.recordDraw(commandBuffer);
                commandBuffer.endRendering();

                // The test's last frame: read back
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        commandBuffer.textureBarrier(texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                        commandBuffer.readbackTextureToBuffer(readbackBuffer, this.rowPitch, texture, this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                    }
                }
                commandBuffer.textureBarrier(texture, presentFrom, NriTextureState.Present);
                commandBuffer.end();

                // Submit and present
                this.swapChain.submit(commandBuffer, index);
                this.swapChain.present(index);
                this.frameNumber++;
            }

            // Signaled after the present, as NRISamples do
            this.queue.signal(this.frameFence, 1 + frameIndex);
        }

        // The last frame's pixels (0xAABBGGRR), empty if it can't be read.
        readBack(): int[] {
            const device = this.device;
            const readbackBuffer = this.readbackBuffer;
            if (!device || !readbackBuffer) {
                return [];
            }
            device.waitIdle();
            const pixels: int[] = [];
            for (let i = 0; i < this.width * this.height; i++) {
                pixels.push(0);
            }
            if (readbackBuffer.readRGBA8(this.rowPitch, this.width, this.height, this.readbackFormat,
                Ref(pixels[0]), pixels.length) == 0) {
                return [];
            }
            return pixels;
        }

        destroy() {
            const device = this.device;
            if (device) {
                device.waitIdle();
                for (const queuedFrame of this.queuedFrames) {
                    queuedFrame.commandBuffer.destroy();
                    queuedFrame.commandAllocator.destroy();
                    this.destroyComputeCommands(queuedFrame);
                }
                for (const image of this.images) {
                    image.storageView.destroy();
                    image.view.destroy();
                    image.texture.destroy();
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                const sampler = this.sampler;
                if (sampler) {
                    sampler.destroy();
                }
                this.destroyPipeline(this.drawPipeline);
                this.destroyPipeline(this.initPipeline);
                this.destroyPipeline(this.mutatePipeline);
                this.destroyPipeline(this.updatePipeline);
                const drawLayout = this.drawLayout;
                if (drawLayout) {
                    drawLayout.destroy();
                }
                const computeLayout = this.computeLayout;
                if (computeLayout) {
                    computeLayout.destroy();
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    readbackBuffer.destroy();
                }
                const computeFence = this.computeFence;
                if (computeFence) {
                    computeFence.destroy();
                }
                this.frameFence.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }

        destroyComputeCommands(queuedFrame: QueuedFrame) {
            const computeCommandBuffer = queuedFrame.computeCommandBuffer;
            const computeCommandAllocator = queuedFrame.computeCommandAllocator;
            if (!computeCommandBuffer || !computeCommandAllocator) {
                return;
            }
            computeCommandBuffer.destroy();
            computeCommandAllocator.destroy();
        }

        destroyPipeline(pipeline: NriPipeline | null) {
            if (pipeline) {
                pipeline.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const timelineSemaphore = new TimelineSemaphore(sample);
        // -benchmark: 1/60 second per frame instead of the clock.
        sample.addExampleOption("-benchmark");
        for (let i = 1; i < argc; i++) {
            if (Nri.getArg(argc, argv, i) == "-benchmark") {
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

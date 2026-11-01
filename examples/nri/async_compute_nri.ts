/// <reference path="../../core/nri/nri_interop.d.ts" />

namespace AsyncComputeNri {
    // async_compute, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut
    // and NVRHI: the same shaders (async_compute.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws. The worker thread is C++
    // (Nri_CreateAsyncComputeLoop), as Donut's: tslang code can't run on threads its GC doesn't know
    // about. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): the device has no compute queue.
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Async Compute";

    // Textures the compute queue writes and the render thread shows, in turns.
    const NUM_TEXTURES = 2;
    const TEXTURE_SIZE = 512;
    // main_cs in async_compute.hlsl runs 8 x 8 threads per group.
    const COMPUTE_GROUPS = TEXTURE_SIZE / 8;
    // 100Hz.
    const COMPUTE_INTERVAL_MICROSECONDS = 10000;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // A texture the compute loop writes: its views, and the descriptor sets that bind them (the
    // compute pipeline's, the draw's).
    class ComputeTexture {
        constructor(public texture: NriTextureHandle, public storageView: NriDescriptorHandle, public view: NriDescriptorHandle,
            public drawSet: NriDescriptorSetHandle) {
        }
    }

    // -test: checks the last frame, read back: the simplex noise the compute queue animates (at
    // 100Hz of real time, so not the same frame every run) covers it, colored (about 80% to 90%):
    // its channels drift apart as the run counter grows (a run with counter 0, or no texture, would
    // be all gray), and seldom black (a few %). Not the Donut example's checks: its headless test
    // renders 120 frames before the compute loop gets going, showing a gray early run; at v-sync
    // here, as the sample runs, the noise has moved on.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        let colored = 0;
        let black = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            const high = Math.max(Math.max(r, g), b);
            const low = Math.min(Math.min(r, g), b);
            if (high - low >= 61) {
                colored++;
            }
            if (high <= 19) {
                black++;
            }
        }
        const total = width * height;
        const coloredPercent = 100.0 * colored / total;
        const blackPercent = 100.0 * black / total;
        console.log(`Colored: ${coloredPercent}% (${colored} of ${total} pixels)`);
        console.log(`Black: ${blackPercent}% (${black} of ${total} pixels)`);
        if (coloredPercent < 50.0 || coloredPercent > 98.0) {
            return `Colored: ${coloredPercent}% of the pixels, not 50% to 98%`;
        }
        if (blackPercent > 25.0) {
            return `Black: ${blackPercent}% of the pixels, more than 25%`;
        }
        return "";
    }

    // Port of Donut-Samples' async_compute.cpp (as examples/async_compute.ts ports it) to NRI: a
    // worker thread animates simplex noise into textures on the compute queue at 100Hz, independently
    // of the frame rate, and the render pass draws the newest finished one.
    class AsyncCompute {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private drawLayout: NriPipelineLayoutHandle | null = null;
        private drawPipeline: NriPipelineHandle | null = null;
        private computeLayout: NriPipelineLayoutHandle | null = null;
        private computePipeline: NriPipelineHandle | null = null;
        private sampler: NriDescriptorHandle | null = null;
        // The draw's descriptor sets, and the compute loop's (only its worker uses them).
        private drawPool: NriDescriptorPoolHandle | null = null;
        private computePool: NriDescriptorPoolHandle | null = null;
        private textures: ComputeTexture[] = [];
        private computeLoop: NriAsyncComputeLoopHandle | null = null;
        // The texture shown (-1: none yet).
        private current: int = -1;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the device has no compute queue ("" otherwise).
        private unsupportedReason: string = "";

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
            // The worker thread stops first: then the GPU is done with everything.
            const computeLoop = this.computeLoop;
            if (computeLoop) {
                Nri_DestroyAsyncComputeLoop(computeLoop);
                this.computeLoop = null;
            }
            if (this.unsupportedReason != "") {
                const test = Nri_IsTest(this.sample) != 0;
                console.log(test ? `Test SKIPPED: ${this.unsupportedReason}` : this.unsupportedReason);
                result = test ? TEST_SKIPPED : 1;
            } else if (result == 0 && this.test) {
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
            this.frameFence = Nri_CreateFence(device, 0);
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
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator)));
            }

            const computeQueue = Nri_GetComputeQueue(device);
            if (!computeQueue) {
                this.unsupportedReason = "The graphics device has no compute queue";
                return 0;
            }

            // The layouts: the draw's texture (t0) and sampler (s0); the compute pipeline's run
            // counter (push constants, b0) and texture (u0).
            const drawLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(drawLayoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(drawLayoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.drawLayout = Nri_CreatePipelineLayoutFromDesc(device, drawLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(drawLayoutDesc);
            const computeLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(computeLayoutDesc, 0, 4, NriStage.Compute);
            Nri_PipelineLayoutDescAddRange(computeLayoutDesc, 0, 0, 1, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
            this.computeLayout = Nri_CreatePipelineLayoutFromDesc(device, computeLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(computeLayoutDesc);
            const drawLayout = this.drawLayout;
            const computeLayout = this.computeLayout;
            if (!drawLayout || !computeLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: async_compute.hlsl's shaders, as compiled for the Donut example; the
            // draw a triangle strip over the frame.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/async_compute/${folder}/async_compute`;
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_main_vs.bin`, "main_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_main_ps.bin`, "main_ps") != 0;
            }
            Nri_PipelineDescSetTopology(desc, NriTopology.TriangleStrip);
            Nri_PipelineDescSetColor(desc, viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.drawPipeline = Nri_CreatePipelineFromDesc(device, drawLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            const computePipeline = Nri_CreateComputePipeline(device, computeLayout, `${shaders}_main_cs.bin`, "main_cs");
            this.computePipeline = computePipeline;
            if (!this.drawPipeline || !computePipeline) {
                console.log("Cannot load the async compute shaders");
                return 0;
            }

            // Trilinear, clamped: nvrhi::SamplerDesc's defaults, as the sample creates it.
            const sampler = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            this.sampler = sampler;
            const drawPool = Nri_CreateDescriptorPool(device, NUM_TEXTURES, NUM_TEXTURES, 0, NUM_TEXTURES, 0, 0);
            const computePool = Nri_CreateDescriptorPool(device, NUM_TEXTURES, 0, 0, 0, NUM_TEXTURES, 0);
            this.drawPool = drawPool;
            this.computePool = computePool;
            if (!sampler || !drawPool || !computePool) {
                console.log("Cannot create the descriptors");
                return 0;
            }

            const computeLoop = Nri_CreateAsyncComputeLoop(computeQueue, device, this.frameFence, computeLayout, computePipeline, computePool,
                COMPUTE_GROUPS, COMPUTE_GROUPS, COMPUTE_INTERVAL_MICROSECONDS);
            this.computeLoop = computeLoop;
            if (!computeLoop) {
                console.log("Cannot create the compute loop");
                return 0;
            }
            for (let i = 0; i < NUM_TEXTURES; i++) {
                const texture = Nri_CreateStorageTexture(device, this.queue, TEXTURE_SIZE, TEXTURE_SIZE, NriFormat.RGBA8_UNORM);
                if (!texture) {
                    console.log("Cannot create the textures");
                    return 0;
                }
                const storageView = Nri_CreateStorageTextureView(texture, NriFormat.RGBA8_UNORM);
                const view = Nri_CreateTextureView(texture, NriFormat.RGBA8_UNORM);
                const computeSet = Nri_AllocateDescriptorSet(computePool, computeLayout, 0, 0);
                const drawSet = Nri_AllocateDescriptorSet(drawPool, drawLayout, 0, 0);
                if (!computeSet || !drawSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(computeSet, 0, 0, storageView);
                Nri_UpdateDescriptor(drawSet, 0, 0, view);
                Nri_UpdateDescriptor(drawSet, 1, 0, sampler);
                this.textures.push(new ComputeTexture(texture, storageView, view, drawSet));
                Nri_AddAsyncComputeTexture(computeLoop, computeSet);
            }
            Nri_StartAsyncComputeLoop(computeLoop);

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The texture over the frame (between Nri_CmdBeginRendering and Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle) {
            const drawLayout = this.drawLayout;
            const drawPipeline = this.drawPipeline;
            const drawPool = this.drawPool;
            if (this.current < 0 || !drawLayout || !drawPipeline || !drawPool) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, drawPool);
            Nri_CmdSetPipelineLayout(commandBuffer, drawLayout);
            Nri_CmdSetPipeline(commandBuffer, drawPipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, this.textures[this.current].drawSet);
            Nri_CmdDraw(commandBuffer, 4, 1, 0, 0);
        }

        renderFrame(frameIndex: int) {
            const queuedFrame = this.queuedFrames[frameIndex % this.queuedFrames.length];

            // If the loop finished a texture, switch to it (the work submitted from now on waiting for
            // its run); the one shown until then goes back to the loop after this frame.
            let switched = false;
            let previous = -1;
            const computeLoop = this.computeLoop;
            if (computeLoop) {
                const next = Nri_AcquireAsyncComputeTexture(computeLoop, this.queue);
                if (next >= 0) {
                    switched = true;
                    previous = this.current;
                    this.current = next;
                }
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the new texture from the compute queue's state, the previous one back.
                Nri_BeginCommandBuffer(commandBuffer);
                if (switched) {
                    Nri_CmdTextureBarrier(commandBuffer, this.textures[this.current].texture, NriTextureState.Storage, NriTextureState.ShaderResource);
                }
                if (previous >= 0) {
                    Nri_CmdTextureBarrier(commandBuffer, this.textures[previous].texture, NriTextureState.ShaderResource, NriTextureState.Storage);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
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
            }

            // Signaled after the present, as NRISamples do
            Nri_QueueSignal(this.queue, this.frameFence, 1 + frameIndex);
            if (previous >= 0) {
                if (computeLoop) {
                    Nri_ReleaseAsyncComputeTexture(computeLoop, previous, 1 + frameIndex);
                }
            }
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
                }
                for (const swapChainTexture of this.swapChainTextures) {
                    Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                    Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                    Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
                }
                for (const texture of this.textures) {
                    Nri_DestroyDescriptor(texture.storageView);
                    Nri_DestroyDescriptor(texture.view);
                    Nri_DestroyTexture(texture.texture);
                }
                const drawPool = this.drawPool;
                if (drawPool) {
                    Nri_DestroyDescriptorPool(drawPool);
                }
                const computePool = this.computePool;
                if (computePool) {
                    Nri_DestroyDescriptorPool(computePool);
                }
                const sampler = this.sampler;
                if (sampler) {
                    Nri_DestroyDescriptor(sampler);
                }
                const drawPipeline = this.drawPipeline;
                if (drawPipeline) {
                    Nri_DestroyPipeline(drawPipeline);
                }
                const computePipeline = this.computePipeline;
                if (computePipeline) {
                    Nri_DestroyPipeline(computePipeline);
                }
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
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const asyncCompute = new AsyncCompute(Nri_CreateSample());
        return asyncCompute.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return AsyncComputeNri.main(argc, argv);
}

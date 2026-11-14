/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { Nri, NriAsyncComputeLoop, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace AsyncComputeNri {
    // async_compute, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut
    // and NVRHI: the same shaders (async_compute.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws. The worker thread is C++
    // (NriQueue.createAsyncComputeLoop), as Donut's: tslang code can't run on threads its GC doesn't know
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

    // A texture the compute loop writes: its views, and the descriptor sets that bind them (the
    // compute pipeline's, the draw's).
    class ComputeTexture {
        constructor(public texture: NriTexture, public storageView: NriDescriptor, public view: NriDescriptor,
            public drawSet: NriDescriptorSet) {
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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private drawLayout: NriPipelineLayout | null = null;
        private drawPipeline: NriPipeline | null = null;
        private computeLayout: NriPipelineLayout | null = null;
        private computePipeline: NriPipeline | null = null;
        private sampler: NriDescriptor | null = null;
        // The draw's descriptor sets, and the compute loop's (only its worker uses them).
        private drawPool: NriDescriptorPool | null = null;
        private computePool: NriDescriptorPool | null = null;
        private textures: ComputeTexture[] = [];
        private computeLoop: NriAsyncComputeLoop | null = null;
        // The texture shown (-1: none yet).
        private current: int = -1;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;
        // Set by initialize when the device has no compute queue ("" otherwise).
        private unsupportedReason: string = "";

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

            // On a wrapper of its own: the callbacks Nri_RunSample runs may overwrite this.sample.
            let result = new NriSample(this.sample.handle).run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
            // The worker thread stops first: then the GPU is done with everything.
            const computeLoop = this.computeLoop;
            if (computeLoop) {
                computeLoop.destroy();
                this.computeLoop = null;
            }
            if (this.unsupportedReason != "") {
                const test = this.sample.isTest() != 0;
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
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);

            const computeQueue = device.getComputeQueue();
            if (!computeQueue) {
                this.unsupportedReason = "The graphics device has no compute queue";
                return 0;
            }

            // The layouts: the draw's texture (t0) and sampler (s0); the compute pipeline's run
            // counter (push constants, b0) and texture (u0).
            const drawLayoutDesc = NriPipelineLayoutDesc.create();
            drawLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            drawLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.drawLayout = device.createPipelineLayoutFromDesc(drawLayoutDesc);
            drawLayoutDesc.destroy();
            const computeLayoutDesc = NriPipelineLayoutDesc.create();
            computeLayoutDesc.addRootConstants(0, 4, NriStage.Compute);
            computeLayoutDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
            this.computeLayout = device.createPipelineLayoutFromDesc(computeLayoutDesc);
            computeLayoutDesc.destroy();
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
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_main_vs.bin`, "main_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_main_ps.bin`, "main_ps") != 0;
            }
            desc.setTopology(NriTopology.TriangleStrip);
            desc.setColor(viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.drawPipeline = device.createPipelineFromDesc(drawLayout, desc);
            }
            desc.destroy();
            const computePipeline = device.createComputePipeline(computeLayout, `${shaders}_main_cs.bin`, "main_cs");
            this.computePipeline = computePipeline;
            if (!this.drawPipeline || !computePipeline) {
                console.log("Cannot load the async compute shaders");
                return 0;
            }

            // Trilinear, clamped: nvrhi::SamplerDesc's defaults, as the sample creates it.
            const sampler = device.createSampler(NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            this.sampler = sampler;
            const drawPool = device.createDescriptorPool(NUM_TEXTURES, NUM_TEXTURES, 0, NUM_TEXTURES, 0, 0);
            const computePool = device.createDescriptorPool(NUM_TEXTURES, 0, 0, 0, NUM_TEXTURES, 0);
            this.drawPool = drawPool;
            this.computePool = computePool;
            if (!sampler || !drawPool || !computePool) {
                console.log("Cannot create the descriptors");
                return 0;
            }

            const computeLoop = computeQueue.createAsyncComputeLoop(device, this.frames.fence(), computeLayout, computePipeline, computePool,
                COMPUTE_GROUPS, COMPUTE_GROUPS, COMPUTE_INTERVAL_MICROSECONDS);
            this.computeLoop = computeLoop;
            if (!computeLoop) {
                console.log("Cannot create the compute loop");
                return 0;
            }
            for (let i = 0; i < NUM_TEXTURES; i++) {
                const texture = device.createStorageTexture(this.queue, TEXTURE_SIZE, TEXTURE_SIZE, NriFormat.RGBA8_UNORM);
                if (!texture) {
                    console.log("Cannot create the textures");
                    return 0;
                }
                const storageView = texture.createStorageView(NriFormat.RGBA8_UNORM);
                const view = texture.createView(NriFormat.RGBA8_UNORM);
                const computeSet = computePool.allocateDescriptorSet(computeLayout, 0, 0);
                const drawSet = drawPool.allocateDescriptorSet(drawLayout, 0, 0);
                if (!computeSet || !drawSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                computeSet.updateDescriptor(0, 0, storageView);
                drawSet.updateDescriptor(0, 0, view);
                drawSet.updateDescriptor(1, 0, sampler);
                this.textures.push(new ComputeTexture(texture, storageView, view, drawSet));
                computeLoop.addTexture(computeSet);
            }
            computeLoop.start();

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain (and what has the window's
        // size) made again at its size, once the GPU is done with the old ones.
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

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The texture over the frame (between NriCommandBuffer.beginRendering and NriCommandBuffer.endRendering).
        recordDraw(commandBuffer: NriCommandBuffer) {
            const drawLayout = this.drawLayout;
            const drawPipeline = this.drawPipeline;
            const drawPool = this.drawPool;
            if (this.current < 0 || !drawLayout || !drawPipeline || !drawPool) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(drawPool);
            commandBuffer.setPipelineLayout(drawLayout);
            commandBuffer.setPipeline(drawPipeline);
            commandBuffer.setDescriptorSet(0, this.textures[this.current].drawSet);
            commandBuffer.draw(4, 1, 0, 0);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();

            // If the loop finished a texture, switch to it (the work submitted from now on waiting for
            // its run); the one shown until then goes back to the loop after this frame.
            let switched = false;
            let previous = -1;
            const computeLoop = this.computeLoop;
            if (computeLoop) {
                const next = computeLoop.acquireTexture(this.queue);
                if (next >= 0) {
                    switched = true;
                    previous = this.current;
                    this.current = next;
                }
            }

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the new texture from the compute queue's state, the previous one back.
                commandBuffer.begin();
                if (switched) {
                    commandBuffer.textureBarrier(this.textures[this.current].texture, NriTextureState.Storage, NriTextureState.ShaderResource);
                }
                if (previous >= 0) {
                    commandBuffer.textureBarrier(this.textures[previous].texture, NriTextureState.ShaderResource, NriTextureState.Storage);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
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
            }

            // Signaled after the present, as NRISamples do
            this.frames.signal(frameIndex);
            if (previous >= 0) {
                if (computeLoop) {
                    computeLoop.releaseTexture(previous, 1 + frameIndex);
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
                for (const texture of this.textures) {
                    texture.storageView.destroy();
                    texture.view.destroy();
                    texture.texture.destroy();
                }
                const drawPool = this.drawPool;
                if (drawPool) {
                    drawPool.destroy();
                }
                const computePool = this.computePool;
                if (computePool) {
                    computePool.destroy();
                }
                const sampler = this.sampler;
                if (sampler) {
                    sampler.destroy();
                }
                const drawPipeline = this.drawPipeline;
                if (drawPipeline) {
                    drawPipeline.destroy();
                }
                const computePipeline = this.computePipeline;
                if (computePipeline) {
                    computePipeline.destroy();
                }
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
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const asyncCompute = new AsyncCompute(sample);
        return asyncCompute.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return AsyncComputeNri.main(argc, argv);
}

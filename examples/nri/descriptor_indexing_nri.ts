/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriRandomEngine, NriSample, NriTexture } from "../../core/nri";

namespace DescriptorIndexingNri {
    // descriptor_indexing, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (descriptor_indexing.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws. The push constants and the
    // immutable sampler are the layout's root constants and root sampler (register space 0); the
    // bindless texture array is a descriptor set in register space 1, a variable-sized array
    // updated after binding.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): the API can't run the example.
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Descriptor Indexing";

    // The streamed table's slots (the sample's NumDescriptorsStreaming), and the textures, one per
    // quad of each grid (NumDescriptorsNonUniform).
    const NUM_DESCRIPTORS_STREAMING = 2048;
    const NUM_DESCRIPTORS_NON_UNIFORM = 64;
    const IMAGE_SIZE = 16;

    // The push constants: float phase; uint table_offset; uint instance.
    const PUSH_SIZE = 12;

    // The render pass's clear color.
    const CLEAR_COLOR = [0.033, 0.073, 0.133];

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // A test image and its view.
    class TestImage {
        constructor(public texture: NriTexture, public view: NriDescriptor) {
        }
    }

    // --- The sample's test images ---------------------------------------------------------------

    // float_to_unorm8: v * 255 rounded (half up), clamped, in float as the sample computes it (its
    // truncation is a floor here: the two differ only below 0, clamped either way).
    function floatToUnorm8(v: number): int {
        const rounded = Math.floor(Math.fround(Math.fround(v * 255.0) + 0.5));
        return Math.min(Math.max(rounded, 0), 255);
    }

    // The sample's create_image: 16 x 16 RGBA8, a pattern picked by the seed (a checkerboard,
    // stripes or diagonals of 4-texel cells) in the color, the dark cells at a quarter, each
    // channel plus noise in [0, 0.1) from the sample's random engine; packed 4 bytes per int.
    function createImageData(rgb: number[], imageSeed: int, rng: NriRandomEngine) {
        const texels: int[] = [];
        for (let y = 0; y < IMAGE_SIZE; y++) {
            for (let x = 0; x < IMAGE_SIZE; x++) {
                let pattern = 0;
                const kind = imageSeed & 3;
                if (kind == 1) {
                    pattern = (x >> 2) & 1;
                } else if (kind == 2) {
                    pattern = (y >> 2) & 1;
                } else if (kind == 3) {
                    pattern = ((x + y) >> 2) & 1;
                } else {
                    pattern = ((x >> 2) ^ (y >> 2)) & 1;
                }
                const patternColor = pattern != 0 ? 0.25 : 1.0;
                let texel = 0;
                for (let i = 0; i < 3; i++) {
                    const noise = rng.randomUniformFloat(0.0, 0.1);
                    texel |= floatToUnorm8(Math.fround(Math.fround(patternColor * rgb[i]) + noise)) << (i * 8);
                }
                // Alpha 0xff.
                texel |= 255 << 24;
                texels.push(texel);
            }
        }
        return texels;
    }

    // -test: checks the last frame, read back. The corners are the blue clear color; the rows of
    // quads, each with its texture picked by index, cover about 21% of every quarter of the frame.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const background = 0x664C33;
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != background) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 51, 76, 102`;
            }
        }
        const w = Math.floor(width / 2);
        const h = Math.floor(height / 2);
        for (let q = 0; q < 4; q++) {
            const x0 = (q % 2) * w;
            const y0 = q < 2 ? 0 : h;
            let count = 0;
            for (let y = y0; y < y0 + h; y++) {
                for (let x = x0; x < x0 + w; x++) {
                    if ((pixels[y * width + x] & 0xFFFFFF) != background) {
                        count++;
                    }
                }
            }
            const percent = 100.0 * count / (w * h);
            console.log(`Quads, quarter ${q + 1}: ${percent}% (${count} of ${w * h} pixels)`);
            if (percent < 15.0 || percent > 30.0) {
                return `Quads, quarter ${q + 1}: ${percent}% of the pixels, not 15% to 30%`;
            }
        }
        return "";
    }

    // Port of Vulkan-Samples' descriptor_indexing (as examples/descriptor_indexing.ts ports it) to
    // NRI: two grids of 8 x 8 rotating quads, each showing one of 64 small textures from a bindless
    // texture array. The left grid is one instanced draw, its pixel shader indexing the array with
    // the instance (a non-uniform index). The right grid is a draw per quad, each preceded by
    // writing the quad's texture into the next slot of a 2048-slot set already bound (update after
    // bind), its shader reading that slot from a push constant. D3D12 and Vulkan.
    class DescriptorIndexing {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;
        private pipelineLayout: NriPipelineLayout | null = null;
        private nonUniformPipeline: NriPipeline | null = null;
        private updateAfterBindPipeline: NriPipeline | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        // The sample's two descriptor sets: the 64 textures, and the streamed one.
        private nonUniformSet: NriDescriptorSet | null = null;
        private updateAfterBindSet: NriDescriptorSet | null = null;
        private images: TestImage[] = [];
        private quadIndexBuffer: NriBuffer | null = null;
        private descriptorOffset: int = 0;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize on D3D11 ("" otherwise).
        private unsupportedReason: string = "";

        // The quads' rotation: a fraction of a turn, 0.2 turns per second.
        private accumulatedTime: number = 0.0;

        // The push constants.
        private push: f32[] = [0.0, 0.0, 0.0];

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

        // The sample's pipelines: triangle strips, no culling, no depth, no blending.
        createPipeline(device: NriDevice, pipelineLayout: NriPipelineLayout, shaders: string, vs: string, ps: string,
            colorFormat: NriFormat) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_${vs}.bin`, vs) != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_${ps}.bin`, ps) != 0;
            }
            desc.setTopology(NriTopology.TriangleStrip);
            desc.setColor(colorFormat, NriColorWrite.RGBA);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(pipelineLayout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        initialize(graphicsAPI: NriGraphicsAPI): int {
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "Descriptor indexing needs bindless descriptor tables: run with -dx12 or -vk";
                return 0;
            }
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

            // The layout: the push constants (b0) and the immutable sampler (s0: linear, the nearest
            // level, clamped) in register space 0; the bindless texture array (t0, space 1) as set 0,
            // up to 2048 long, partially bound, updated after binding.
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRootConstants(0, PUSH_SIZE, NriStage.VertexPixel);
            layoutDesc.addRootSampler(0, NriFilter.Linear, NriFilter.Nearest, NriAddressMode.ClampToEdge, NriStage.Pixel);
            layoutDesc.addRange(0, 0, NUM_DESCRIPTORS_STREAMING, NriDescriptorType.Texture, NriStage.Pixel,
                NriRangeFlags.PartiallyBound | NriRangeFlags.Array | NriRangeFlags.VariableSizedArray | NriRangeFlags.UpdateAfterSet);
            layoutDesc.setRegisterSpace(0, 1);
            this.pipelineLayout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The sample's two descriptor sets of it. Room for two whole arrays: NRI's D3D12 pool gives
            // every set the range's descriptorNum, whatever its variableDescriptorNum.
            const descriptorPool = device.createDescriptorPool(2, 0, 0, 2 * NUM_DESCRIPTORS_STREAMING, 0, 1);
            this.descriptorPool = descriptorPool;
            if (!descriptorPool) {
                console.log("Cannot create the descriptor pool");
                return 0;
            }
            this.nonUniformSet = descriptorPool.allocateDescriptorSet(pipelineLayout, 0, NUM_DESCRIPTORS_NON_UNIFORM);
            this.updateAfterBindSet = descriptorPool.allocateDescriptorSet(pipelineLayout, 0, NUM_DESCRIPTORS_STREAMING);
            if (!this.nonUniformSet || !this.updateAfterBindSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }

            // A quad's corners as a triangle strip.
            const quadIndices: int[] = [0, 1, 2, 3];
            this.quadIndexBuffer = device.createUploadedBufferFromInts(this.queue, Ref(quadIndices[0]), 16, NriBufferUsage.IndexBuffer);
            if (!this.quadIndexBuffer) {
                console.log("Cannot create the index buffer");
                return 0;
            }
            if (!this.createImages(device)) {
                console.log("Cannot create the test images");
                return 0;
            }

            // Pipelines: descriptor_indexing.hlsl's shaders, as compiled for the Donut example.
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/descriptor_indexing/${folder}/descriptor_indexing`;
            this.nonUniformPipeline = this.createPipeline(device, pipelineLayout, shaders, "nonuniform_vs", "nonuniform_ps", viewFormat);
            this.updateAfterBindPipeline = this.createPipeline(device, pipelineLayout, shaders, "update_after_bind_vs", "update_after_bind_ps", viewFormat);
            if (!this.nonUniformPipeline || !this.updateAfterBindPipeline) {
                console.log("Cannot load the descriptor indexing shaders");
                return 0;
            }

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The sample's create_images: 64 colors in [0.2, 0.8) from its random engine (seed 42),
        // then each image made with its color, and written into the non-uniform set.
        createImages(device: NriDevice) {
            const nonUniformSet = this.nonUniformSet;
            if (!nonUniformSet) {
                return false;
            }
            const rng = NriRandomEngine.create(42);
            const colors: number[] = [];
            for (let i = 0; i < NUM_DESCRIPTORS_NON_UNIFORM * 3; i++) {
                colors.push(rng.randomUniformFloat(0.2, 0.8));
            }
            let created = true;
            for (let i = 0; i < NUM_DESCRIPTORS_NON_UNIFORM; i++) {
                const texels = createImageData([colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]], i, rng);
                const texture = device.createCommittedTexture(IMAGE_SIZE, IMAGE_SIZE, NriFormat.RGBA8_UNORM);
                if (!texture) {
                    created = false;
                    break;
                }
                this.queue.uploadTexture(texture, Ref(texels[0]), IMAGE_SIZE * 4);
                const view = texture.createView(NriFormat.RGBA8_UNORM);
                nonUniformSet.updateDescriptor(0, i, view);
                this.images.push(new TestImage(texture, view));
            }
            rng.destroy();
            return created;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The two grids (between NriCommandBuffer.beginRendering and NriCommandBuffer.endRendering).
        recordGrids(commandBuffer: NriCommandBuffer) {
            const pipelineLayout = this.pipelineLayout;
            const nonUniformPipeline = this.nonUniformPipeline;
            const updateAfterBindPipeline = this.updateAfterBindPipeline;
            const descriptorPool = this.descriptorPool;
            const nonUniformSet = this.nonUniformSet;
            const updateAfterBindSet = this.updateAfterBindSet;
            const quadIndexBuffer = this.quadIndexBuffer;
            if (!pipelineLayout || !nonUniformPipeline || !updateAfterBindPipeline || !descriptorPool) {
                return;
            }
            if (!nonUniformSet || !updateAfterBindSet || !quadIndexBuffer) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(pipelineLayout);
            commandBuffer.setIndexBuffer(quadIndexBuffer, 0, NriIndexType.UInt32);

            this.push[0] = Math.fround(Math.fround(2.0 * Math.PI) * this.accumulatedTime);

            // The left grid: one draw of 64 instances, each indexing the set with its own index.
            commandBuffer.setPipeline(nonUniformPipeline);
            commandBuffer.setDescriptorSet(0, nonUniformSet);
            commandBuffer.setRootConstants(0, Ref(this.push[0]), PUSH_SIZE);
            commandBuffer.drawIndexed(4, NUM_DESCRIPTORS_NON_UNIFORM, 0, 0, 0);

            // The right grid: per quad, its texture written into the streamed set's next slot (the
            // set already bound), the slot passed in the push constants.
            commandBuffer.setPipeline(updateAfterBindPipeline);
            commandBuffer.setDescriptorSet(0, updateAfterBindSet);
            for (let i = 0; i < NUM_DESCRIPTORS_NON_UNIFORM; i++) {
                updateAfterBindSet.updateDescriptor(0, this.descriptorOffset, this.images[i].view);
                Nri.storeInt32(Ref(this.push[1]), this.descriptorOffset);
                Nri.storeInt32(Ref(this.push[2]), i);
                this.descriptorOffset = (this.descriptorOffset + 1) % NUM_DESCRIPTORS_STREAMING;
                commandBuffer.setRootConstants(0, Ref(this.push[0]), PUSH_SIZE);
                commandBuffer.drawIndexed(4, 1, 0, 0, 0);
            }
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain made again at its
        // size, once the GPU is done with the old ones.
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

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            // The sample's render: the time accumulated in float, wrapped to [0, 1). In test mode
            // 1/60 second a frame, as Donut's test mode.
            const deltaTime = Math.fround(this.test ? 1.0 / 60.0 : this.sample.getFrameTime());
            const time = Math.fround(this.accumulatedTime + Math.fround(Math.fround(0.2) * deltaTime));
            this.accumulatedTime = Math.fround(time - Math.floor(time));

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record
                commandBuffer.begin();
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                commandBuffer.clearColor(CLEAR_COLOR[0], CLEAR_COLOR[1], CLEAR_COLOR[2], 0.0);
                this.recordGrids(commandBuffer);
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
                for (const image of this.images) {
                    image.view.destroy();
                    image.texture.destroy();
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                const nonUniformPipeline = this.nonUniformPipeline;
                if (nonUniformPipeline) {
                    nonUniformPipeline.destroy();
                }
                const updateAfterBindPipeline = this.updateAfterBindPipeline;
                if (updateAfterBindPipeline) {
                    updateAfterBindPipeline.destroy();
                }
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    pipelineLayout.destroy();
                }
                const quadIndexBuffer = this.quadIndexBuffer;
                if (quadIndexBuffer) {
                    quadIndexBuffer.destroy();
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    readbackBuffer.destroy();
                }
                if (this.unsupportedReason == "") {
                    this.frames.destroy();
                    this.swapChain.destroy();
                }
                device.destroy();
            }
            this.sample.destroy();
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const descriptorIndexing = new DescriptorIndexing(sample);
        return descriptorIndexing.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return DescriptorIndexingNri.main(argc, argv);
}

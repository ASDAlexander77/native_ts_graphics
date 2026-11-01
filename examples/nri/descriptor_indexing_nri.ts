/// <reference path="../../core/nri/nri_interop.d.ts" />

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

    // A test image and its view.
    class TestImage {
        constructor(public texture: NriTextureHandle, public view: NriDescriptorHandle) {
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
    function createImageData(rgb: number[], imageSeed: int, rng: NriRandomEngineHandle) {
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
                    const noise = Nri_RandomUniformFloat(rng, 0.0, 0.1);
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
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private pipelineLayout: NriPipelineLayoutHandle | null = null;
        private nonUniformPipeline: NriPipelineHandle | null = null;
        private updateAfterBindPipeline: NriPipelineHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        // The sample's two descriptor sets: the 64 textures, and the streamed one.
        private nonUniformSet: NriDescriptorSetHandle | null = null;
        private updateAfterBindSet: NriDescriptorSetHandle | null = null;
        private images: TestImage[] = [];
        private quadIndexBuffer: NriBufferHandle | null = null;
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

        // The sample's pipelines: triangle strips, no culling, no depth, no blending.
        createPipeline(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle, shaders: string, vs: string, ps: string,
            colorFormat: NriFormat) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_${vs}.bin`, vs) != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_${ps}.bin`, ps) != 0;
            }
            Nri_PipelineDescSetTopology(desc, NriTopology.TriangleStrip);
            Nri_PipelineDescSetColor(desc, colorFormat, NriColorWrite.RGBA);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, pipelineLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        initialize(graphicsAPI: NriGraphicsAPI): int {
            const device = Nri_CreateDevice(this.sample, graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "Descriptor indexing needs bindless descriptor tables: run with -dx12 or -vk";
                return 0;
            }
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

            // The layout: the push constants (b0) and the immutable sampler (s0: linear, the nearest
            // level, clamped) in register space 0; the bindless texture array (t0, space 1) as set 0,
            // up to 2048 long, partially bound, updated after binding.
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(layoutDesc, 0, PUSH_SIZE, NriStage.VertexPixel);
            Nri_PipelineLayoutDescAddRootSampler(layoutDesc, 0, NriFilter.Linear, NriFilter.Nearest, NriAddressMode.ClampToEdge, NriStage.Pixel);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, NUM_DESCRIPTORS_STREAMING, NriDescriptorType.Texture, NriStage.Pixel,
                NriRangeFlags.PartiallyBound | NriRangeFlags.Array | NriRangeFlags.VariableSizedArray | NriRangeFlags.UpdateAfterSet);
            Nri_PipelineLayoutDescSetRegisterSpace(layoutDesc, 0, 1);
            this.pipelineLayout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The sample's two descriptor sets of it. Room for two whole arrays: NRI's D3D12 pool gives
            // every set the range's descriptorNum, whatever its variableDescriptorNum.
            const descriptorPool = Nri_CreateDescriptorPool(device, 2, 0, 0, 2 * NUM_DESCRIPTORS_STREAMING, 0, 1);
            this.descriptorPool = descriptorPool;
            if (!descriptorPool) {
                console.log("Cannot create the descriptor pool");
                return 0;
            }
            this.nonUniformSet = Nri_AllocateDescriptorSet(descriptorPool, pipelineLayout, 0, NUM_DESCRIPTORS_NON_UNIFORM);
            this.updateAfterBindSet = Nri_AllocateDescriptorSet(descriptorPool, pipelineLayout, 0, NUM_DESCRIPTORS_STREAMING);
            if (!this.nonUniformSet || !this.updateAfterBindSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }

            // A quad's corners as a triangle strip.
            const quadIndices: int[] = [0, 1, 2, 3];
            this.quadIndexBuffer = Nri_CreateUploadedBufferFromInts(device, this.queue, Ref(quadIndices[0]), 16, NriBufferUsage.IndexBuffer);
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
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The sample's create_images: 64 colors in [0.2, 0.8) from its random engine (seed 42),
        // then each image made with its color, and written into the non-uniform set.
        createImages(device: NriDeviceHandle) {
            const nonUniformSet = this.nonUniformSet;
            if (!nonUniformSet) {
                return false;
            }
            const rng = Nri_CreateRandomEngine(42);
            const colors: number[] = [];
            for (let i = 0; i < NUM_DESCRIPTORS_NON_UNIFORM * 3; i++) {
                colors.push(Nri_RandomUniformFloat(rng, 0.2, 0.8));
            }
            let created = true;
            for (let i = 0; i < NUM_DESCRIPTORS_NON_UNIFORM; i++) {
                const texels = createImageData([colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]], i, rng);
                const texture = Nri_CreateCommittedTexture(device, IMAGE_SIZE, IMAGE_SIZE, NriFormat.RGBA8_UNORM);
                if (!texture) {
                    created = false;
                    break;
                }
                Nri_UploadTexture(this.queue, texture, Ref(texels[0]), IMAGE_SIZE * 4);
                const view = Nri_CreateTextureView(texture, NriFormat.RGBA8_UNORM);
                Nri_UpdateDescriptor(nonUniformSet, 0, i, view);
                this.images.push(new TestImage(texture, view));
            }
            Nri_DestroyRandomEngine(rng);
            return created;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The two grids (between Nri_CmdBeginRendering and Nri_CmdEndRendering).
        recordGrids(commandBuffer: NriCommandBufferHandle) {
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
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, pipelineLayout);
            Nri_CmdSetIndexBuffer(commandBuffer, quadIndexBuffer, 0, NriIndexType.UInt32);

            this.push[0] = Math.fround(Math.fround(2.0 * Math.PI) * this.accumulatedTime);

            // The left grid: one draw of 64 instances, each indexing the set with its own index.
            Nri_CmdSetPipeline(commandBuffer, nonUniformPipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, nonUniformSet);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.push[0]), PUSH_SIZE);
            Nri_CmdDrawIndexed(commandBuffer, 4, NUM_DESCRIPTORS_NON_UNIFORM, 0, 0, 0);

            // The right grid: per quad, its texture written into the streamed set's next slot (the
            // set already bound), the slot passed in the push constants.
            Nri_CmdSetPipeline(commandBuffer, updateAfterBindPipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, updateAfterBindSet);
            for (let i = 0; i < NUM_DESCRIPTORS_NON_UNIFORM; i++) {
                Nri_UpdateDescriptor(updateAfterBindSet, 0, this.descriptorOffset, this.images[i].view);
                Nri_StoreInt32(Ref(this.push[1]), this.descriptorOffset);
                Nri_StoreInt32(Ref(this.push[2]), i);
                this.descriptorOffset = (this.descriptorOffset + 1) % NUM_DESCRIPTORS_STREAMING;
                Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.push[0]), PUSH_SIZE);
                Nri_CmdDrawIndexed(commandBuffer, 4, 1, 0, 0, 0);
            }
        }

        renderFrame(frameIndex: int) {
            // The sample's render: the time accumulated in float, wrapped to [0, 1). In test mode
            // 1/60 second a frame, as Donut's test mode.
            const deltaTime = Math.fround(this.test ? 1.0 / 60.0 : Nri_GetFrameTime(this.sample));
            const time = Math.fround(this.accumulatedTime + Math.fround(Math.fround(0.2) * deltaTime));
            this.accumulatedTime = Math.fround(time - Math.floor(time));

            const queuedFrame = this.queuedFrames[frameIndex % this.queuedFrames.length];

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                Nri_CmdClearColor(commandBuffer, CLEAR_COLOR[0], CLEAR_COLOR[1], CLEAR_COLOR[2], 0.0);
                this.recordGrids(commandBuffer);
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
                for (const image of this.images) {
                    Nri_DestroyDescriptor(image.view);
                    Nri_DestroyTexture(image.texture);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                const nonUniformPipeline = this.nonUniformPipeline;
                if (nonUniformPipeline) {
                    Nri_DestroyPipeline(nonUniformPipeline);
                }
                const updateAfterBindPipeline = this.updateAfterBindPipeline;
                if (updateAfterBindPipeline) {
                    Nri_DestroyPipeline(updateAfterBindPipeline);
                }
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    Nri_DestroyPipelineLayout(pipelineLayout);
                }
                const quadIndexBuffer = this.quadIndexBuffer;
                if (quadIndexBuffer) {
                    Nri_DestroyBuffer(quadIndexBuffer);
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
                }
                if (this.unsupportedReason == "") {
                    Nri_DestroyFence(this.frameFence);
                    Nri_DestroySwapChain(this.swapChain);
                }
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const descriptorIndexing = new DescriptorIndexing(Nri_CreateSample());
        return descriptorIndexing.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return DescriptorIndexingNri.main(argc, argv);
}

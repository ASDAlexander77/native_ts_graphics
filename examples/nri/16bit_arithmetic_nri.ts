/// <reference path="../../core/nri/nri_interop.d.ts" />

namespace Khr16BitArithmeticNri {
    // 16bit_arithmetic, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (16bit_arithmetic.hlsl's and 16bit_arithmetic_fp16.hlsl's),
    // through the NRI calls core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws, with
    // NRIFramework's ImGui for the sample's options window. This example creates everything it runs,
    // and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: 16-bit Arithmetic";

    // The image the compute shader renders, and its workgroup size (8 x 8).
    const WIDTH = 1024;
    const HEIGHT = 1024;
    const GROUP_SIZE = 8;
    const NUM_BLOBS = 16;

    // The sample's blobs, each four 16-bit floats (x, y position, intensity, falloff), as the Donut
    // example has them (the values the sample's MSVC build generates).
    const BLOBS = [
        0xaa9e, 0x2fd2, 0x3a3e, 0x5365,
        0x2c9e, 0x2d91, 0x391e, 0x54fd,
        0xaf9b, 0xa4ca, 0x3766, 0x52e0,
        0xac67, 0x9e7f, 0x39f9, 0x542b,
        0x279d, 0xaeb9, 0x3977, 0x5529,
        0xaf85, 0x2994, 0x382c, 0x5509,
        0x14ae, 0xa5d3, 0x3895, 0x5265,
        0xb1ea, 0x259e, 0x3928, 0x5460,
        0xac1c, 0xb01b, 0x38a9, 0x52d1,
        0x301b, 0x2ad0, 0x37ae, 0x5452,
        0x146d, 0x28b2, 0x3919, 0x5495,
        0x2e1c, 0x311f, 0x377e, 0x5488,
        0x2a52, 0x1edf, 0x39c9, 0x5454,
        0xa7ab, 0xa521, 0x3964, 0x53c2,
        0xabc2, 0x31f0, 0x372e, 0x5508,
        0x978e, 0x3014, 0x369f, 0x5355,
    ];
    const BLOB_STRIDE = 8;

    // The push constants: struct Push32 { uint num_blobs; float seed; int range_x, range_y; } and
    // struct Push16 { uint16_t num_blobs; float16_t seed; int16_t range_x, range_y; }.
    const PUSH32_SIZE = 16;
    const PUSH16_SIZE = 8;
    const RANGE_X = 2;
    const RANGE_Y = 1;

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

    // glm::packHalf2x16's conversion of one float: to the nearest 16-bit float, ties to even.
    function packHalf(value: number): int {
        if (value == 0.0) {
            return 0;
        }
        const sign = value < 0.0 ? 0x8000 : 0;
        const a = Math.abs(value);
        let exponent = Math.floor(Math.log2(a));
        if (Math.pow(2.0, exponent) > a) {
            exponent--;
        } else if (Math.pow(2.0, exponent + 1) <= a) {
            exponent++;
        }
        if (exponent > 15) {
            return sign | 0x7C00;
        }
        // Subnormals below 2^-14: mantissa in units of 2^-24.
        const unit = exponent < -14 ? Math.pow(2.0, -24) : Math.pow(2.0, exponent - 10);
        const scaled = a / unit;
        let rounded = Math.floor(scaled);
        const remainder = scaled - rounded;
        if (remainder > 0.5 || (remainder == 0.5 && rounded % 2 == 1)) {
            rounded++;
        }
        if (exponent < -14) {
            return sign | rounded;
        }
        // rounded is in [1024, 2048]: 2048 carries into the exponent.
        let e = exponent + 15;
        if (rounded == 2048) {
            rounded = 1024;
            e++;
        }
        if (e > 30) {
            return sign | 0x7C00;
        }
        return sign | (e << 10) | (rounded - 1024);
    }

    // -test: checks the last frame, read back, as the Donut example does. The corners are the black
    // clear color; the blobs, merged by then, make the middle of the frame white (90% or more of the
    // 100 x 100 pixels there all over 200).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != 0) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 0, 0, 0`;
            }
        }
        const x0 = width / 2 - 50;
        const y0 = height / 2 - 50;
        let white = 0;
        for (let y = y0; y < y0 + 100; y++) {
            for (let x = x0; x < x0 + 100; x++) {
                const p = pixels[y * width + x];
                if ((p & 0xFF) > 200 && ((p >> 8) & 0xFF) > 200 && ((p >> 16) & 0xFF) > 200) {
                    white++;
                }
            }
        }
        const percent = 100.0 * white / (100 * 100);
        console.log(`White in the middle: ${percent}% (${white} of 10000 pixels)`);
        if (percent < 90.0) {
            return `White in the middle: ${percent}% of the pixels, not 90% to 100%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' 16bit_arithmetic (as examples/16bit_arithmetic.ts ports it) to NRI: a
    // compute shader renders 16 blobs that look like a lens flare (a lot of arithmetic per pixel, the
    // blobs' parameters 16-bit floats in a buffer) into a 1024 x 1024 image, stretched over the
    // screen. With 16-bit arithmetic enabled (-fp16), a shader doing it in 16-bit floats, its push
    // constants 16-bit values too where the device takes them. The Donut example's GPU time isn't
    // shown: nri_interop has no timer queries.
    class ArithmeticSample {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private computeLayout: NriPipelineLayoutHandle | null = null;
        private computeLayoutFP16: NriPipelineLayoutHandle | null = null;
        private computeFP32: NriPipelineHandle | null = null;
        private computeFP16: NriPipelineHandle | null = null;
        private visualizeLayout: NriPipelineLayoutHandle | null = null;
        private visualizePipeline: NriPipelineHandle | null = null;
        private blobBuffer: NriBufferHandle | null = null;
        private blobView: NriDescriptorHandle | null = null;
        private image: NriTextureHandle | null = null;
        private imageStorage: NriDescriptorHandle | null = null;
        private imageView: NriDescriptorHandle | null = null;
        private sampler: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private computeSet: NriDescriptorSetHandle | null = null;
        private computeSetFP16: NriDescriptorSetHandle | null = null;
        private visualizeSet: NriDescriptorSetHandle | null = null;
        // The image is read by the draw (after the first frame).
        private imageDrawn: boolean = false;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        // What the device has: 16-bit arithmetic, and 16-bit push constants.
        native16Bit: boolean = false;
        private native16BitConstants: boolean = false;

        private frameCount: int = 0;
        private push32: f32[] = [0.0, 0.0, 0.0, 0.0];
        private push16: f32[] = [0.0, 0.0];

        // The sample's setting (-fp16, where the device has it); -noUI: no options window.
        fp16Enabled: boolean = false;
        noUI: boolean = false;

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
            this.frameFence = Nri_CreateFence(device, 0);
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.test = Nri_IsTest(this.sample) != 0;

            // Swap chain: rendered through sRGB views, as the sample's sRGB color buffer (which the
            // Donut example blits into its back buffer).
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, queuedFrameNum + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            const viewFormat = Nri_GetSrgbFormat(format);
            this.viewFormat = viewFormat;
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

            // 16-bit types need shader model 6.2 (no D3D11 shaders for them).
            this.native16Bit = graphicsAPI != NriGraphicsAPI.D3D11 && Nri_IsFeatureSupported(device, NriFeature.Native16Bit) != 0;
            this.native16BitConstants = this.native16Bit && Nri_IsFeatureSupported(device, NriFeature.Native16BitConstants) != 0;
            this.fp16Enabled = this.fp16Enabled && this.native16Bit;

            // The layouts: the compute shaders' push constants (b0), blobs (t0) and image (u0); the
            // visualization's image (t0) and sampler (s0).
            this.computeLayout = this.createComputeLayout(device, PUSH32_SIZE);
            const visualizeLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(visualizeLayoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(visualizeLayoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.visualizeLayout = Nri_CreatePipelineLayoutFromDesc(device, visualizeLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(visualizeLayoutDesc);
            const computeLayout = this.computeLayout;
            const visualizeLayout = this.visualizeLayout;
            if (!computeLayout || !visualizeLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: 16bit_arithmetic.hlsl's shaders, as compiled for the Donut example (the
            // FP16 shader with 16-bit push constants if the device takes them, 32-bit ones if not);
            // the triangle over the screen, no culling, no depth.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            const shaders = `shaders/16bit_arithmetic/${folder}/16bit_arithmetic`;
            this.computeFP32 = Nri_CreateComputePipeline(device, computeLayout, `${shaders}_compute_fp32.bin`, "compute_fp32");
            if (this.native16Bit) {
                const computeLayoutFP16 = this.createComputeLayout(device, this.native16BitConstants ? PUSH16_SIZE : PUSH32_SIZE);
                this.computeLayoutFP16 = computeLayoutFP16;
                if (computeLayoutFP16) {
                    this.computeFP16 = Nri_CreateComputePipelinePermutation(device, computeLayoutFP16,
                        `${shaders}_fp16_compute_fp16.bin`, "compute_fp16", this.native16BitConstants ? "PUSH_CONSTANT_16=1" : "PUSH_CONSTANT_16=0");
                }
            }
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_visualize_vs.bin`, "visualize_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_visualize_ps.bin`, "visualize_ps") != 0;
            }
            Nri_PipelineDescSetColor(desc, viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.visualizePipeline = Nri_CreatePipelineFromDesc(device, visualizeLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            if (!this.computeFP32 || !this.visualizePipeline || !this.fp16PipelineMade()) {
                console.log("Cannot load the 16-bit arithmetic shaders");
                return 0;
            }

            // The blobs (two 16-bit floats to a 32-bit word), and the image the compute shader
            // renders, read through a linear, clamped sampler.
            const blobs: f32[] = [];
            for (let i = 0; i < BLOBS.length; i += 2) {
                blobs.push(0.0);
                Nri_StoreInt32(Ref(blobs[blobs.length - 1]), BLOBS[i] | (BLOBS[i + 1] << 16));
            }
            const blobBuffer = Nri_CreateHostBufferWithStride(device, NUM_BLOBS * BLOB_STRIDE, NriBufferUsage.StructuredBuffer, BLOB_STRIDE);
            this.blobBuffer = blobBuffer;
            const image = Nri_CreateStorageTexture(device, this.queue, WIDTH, HEIGHT, NriFormat.RGBA16_SFLOAT);
            this.image = image;
            this.sampler = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            const descriptorPool = Nri_CreateDescriptorPoolWithBuffers(device, 3, 1, 0, 1, 2, 2, 0, 0);
            this.descriptorPool = descriptorPool;
            const sampler = this.sampler;
            if (!blobBuffer || !image || !sampler || !descriptorPool) {
                console.log("Cannot create the resources");
                return 0;
            }
            Nri_WriteBuffer(blobBuffer, 0, Ref(blobs[0]), NUM_BLOBS * BLOB_STRIDE);
            const blobView = Nri_CreateStructuredBufferView(blobBuffer, 0);
            this.blobView = blobView;
            const imageStorage = Nri_CreateStorageTextureView(image, NriFormat.RGBA16_SFLOAT);
            const imageView = Nri_CreateTextureView(image, NriFormat.RGBA16_SFLOAT);
            this.imageStorage = imageStorage;
            this.imageView = imageView;
            const computeSet = Nri_AllocateDescriptorSet(descriptorPool, computeLayout, 0, 0);
            const visualizeSet = Nri_AllocateDescriptorSet(descriptorPool, visualizeLayout, 0, 0);
            this.computeSet = computeSet;
            this.visualizeSet = visualizeSet;
            if (!blobView || !computeSet || !visualizeSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            this.updateComputeSet(computeSet);
            Nri_UpdateDescriptor(visualizeSet, 0, 0, imageView);
            Nri_UpdateDescriptor(visualizeSet, 1, 0, sampler);
            const computeLayoutFP16 = this.computeLayoutFP16;
            if (computeLayoutFP16) {
                const computeSetFP16 = Nri_AllocateDescriptorSet(descriptorPool, computeLayoutFP16, 0, 0);
                this.computeSetFP16 = computeSetFP16;
                if (!computeSetFP16) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                this.updateComputeSet(computeSetFP16);
            }

            // The sample's options window.
            if (!this.noUI) {
                if (Nri_InitImgui(this.sample, device) == 0) {
                    console.log("Cannot initialize the user interface");
                    return 0;
                }
                this.imgui = true;
            }

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The FP16 pipeline was made, where the device has 16-bit arithmetic.
        fp16PipelineMade(): boolean {
            if (!this.native16Bit) {
                return true;
            }
            return this.computeFP16 ? true : false;
        }

        // A compute layout with pushConstantsSize bytes of push constants.
        createComputeLayout(device: NriDeviceHandle, pushConstantsSize: int) {
            const desc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(desc, 0, pushConstantsSize, NriStage.Compute);
            Nri_PipelineLayoutDescAddRange(desc, 0, 0, 1, NriDescriptorType.StructuredBuffer, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(desc, 0, 0, 1, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
            const layout = Nri_CreatePipelineLayoutFromDesc(device, desc);
            Nri_DestroyPipelineLayoutDesc(desc);
            return layout;
        }

        updateComputeSet(set: NriDescriptorSetHandle) {
            const blobView = this.blobView;
            const imageStorage = this.imageStorage;
            if (!blobView || !imageStorage) {
                return;
            }
            Nri_UpdateDescriptor(set, 0, 0, blobView);
            Nri_UpdateDescriptor(set, 1, 0, imageStorage);
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The sample's options window.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("16-bit arithmetic", 1);
            if (this.native16Bit) {
                this.fp16Enabled = Nri_ImguiCheckbox("Enable 16-bit arithmetic", this.fp16Enabled ? 1 : 0) != 0;
            } else {
                Nri_ImguiText("16-bit arithmetic (unsupported features)");
            }
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        writePush32(seedValue: number) {
            Nri_StoreInt32(Ref(this.push32[0]), NUM_BLOBS);
            this.push32[1] = seedValue;
            Nri_StoreInt32(Ref(this.push32[2]), RANGE_X);
            Nri_StoreInt32(Ref(this.push32[3]), RANGE_Y);
        }

        // The compute shader over the image (1024 x 1024 in 8 x 8 groups), then the image goes to
        // the draw.
        recordCompute(commandBuffer: NriCommandBufferHandle) {
            const descriptorPool = this.descriptorPool;
            const image = this.image;
            if (!descriptorPool || !image) {
                return;
            }

            // The seed: half a sine over 512 frames.
            this.frameCount = (this.frameCount + 1) & 511;
            const seedValue = 0.5 * Math.sin(2.0 * Math.PI * (this.frameCount / 512.0));

            // (fp16Enabled only where native16Bit: then the FP16 pipeline was made, or initialize
            // failed.)
            let layout = this.computeLayout;
            let pipeline = this.computeFP32;
            let set = this.computeSet;
            let pushConstants = PUSH32_SIZE;
            if (this.fp16Enabled) {
                layout = this.computeLayoutFP16;
                pipeline = this.computeFP16;
                set = this.computeSetFP16;
            }
            if (this.fp16Enabled && this.native16BitConstants) {
                // 16-bit push constants are supported by VK_KHR_16bit_storage, which is handy for
                // conserving space without using many "unpack" instructions in the shader.
                const seed16 = packHalf(seedValue);
                Nri_StoreInt32(Ref(this.push16[0]), NUM_BLOBS | (seed16 << 16));
                Nri_StoreInt32(Ref(this.push16[1]), (RANGE_X & 0xFFFF) | ((RANGE_Y & 0xFFFF) << 16));
                pushConstants = PUSH16_SIZE;
            } else {
                this.writePush32(seedValue);
            }
            if (!layout || !pipeline || !set) {
                return;
            }

            if (this.imageDrawn) {
                Nri_CmdTextureBarrier(commandBuffer, image, NriTextureState.ShaderResource, NriTextureState.Storage);
            }
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetComputePipelineLayout(commandBuffer, layout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            if (pushConstants == PUSH16_SIZE) {
                Nri_CmdSetComputeRootConstants(commandBuffer, 0, Ref(this.push16[0]), PUSH16_SIZE);
            } else {
                Nri_CmdSetComputeRootConstants(commandBuffer, 0, Ref(this.push32[0]), PUSH32_SIZE);
            }
            Nri_CmdSetComputeDescriptorSet(commandBuffer, 0, set);
            Nri_CmdDispatch(commandBuffer, WIDTH / GROUP_SIZE, HEIGHT / GROUP_SIZE, 1);
            Nri_CmdTextureBarrier(commandBuffer, image, NriTextureState.Storage, NriTextureState.ShaderResource);
            this.imageDrawn = true;
        }

        // The image over the frame (between Nri_CmdBeginRendering and Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle) {
            const visualizeLayout = this.visualizeLayout;
            const visualizePipeline = this.visualizePipeline;
            const descriptorPool = this.descriptorPool;
            const visualizeSet = this.visualizeSet;
            if (!visualizeLayout || !visualizePipeline || !descriptorPool || !visualizeSet) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, visualizeLayout);
            Nri_CmdSetPipeline(commandBuffer, visualizePipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, visualizeSet);
            Nri_CmdDraw(commandBuffer, 3, 1, 0, 0);
        }

        renderFrame(frameIndex: int) {
            const queuedFrame = this.queuedFrames[frameIndex % this.queuedFrames.length];
            if (this.imgui) {
                this.buildUI();
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the compute pass; cleared to black, the image over the frame, the options
                // window over it.
                Nri_BeginCommandBuffer(commandBuffer);
                this.recordCompute(commandBuffer);
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 1.0);
                this.recordDraw(commandBuffer);
                if (this.imgui) {
                    Nri_CmdDrawImgui(this.sample, commandBuffer, this.viewFormat);
                }
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
                if (this.imgui) {
                    Nri_ImguiEndFrame(this.sample);
                }
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
                if (this.imgui) {
                    Nri_DestroyImgui(this.sample);
                }
                for (const queuedFrame of this.queuedFrames) {
                    Nri_DestroyCommandBuffer(queuedFrame.commandBuffer);
                    Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
                }
                for (const swapChainTexture of this.swapChainTextures) {
                    Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                    Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                    Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                this.destroyDescriptor(this.blobView);
                this.destroyDescriptor(this.imageStorage);
                this.destroyDescriptor(this.imageView);
                this.destroyDescriptor(this.sampler);
                const blobBuffer = this.blobBuffer;
                if (blobBuffer) {
                    Nri_DestroyBuffer(blobBuffer);
                }
                const image = this.image;
                if (image) {
                    Nri_DestroyTexture(image);
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
                }
                this.destroyPipeline(this.computeFP32);
                this.destroyPipeline(this.computeFP16);
                this.destroyPipeline(this.visualizePipeline);
                this.destroyLayout(this.computeLayout);
                this.destroyLayout(this.computeLayoutFP16);
                this.destroyLayout(this.visualizeLayout);
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }

        destroyDescriptor(descriptor: NriDescriptorHandle | null) {
            if (descriptor) {
                Nri_DestroyDescriptor(descriptor);
            }
        }

        destroyPipeline(pipeline: NriPipelineHandle | null) {
            if (pipeline) {
                Nri_DestroyPipeline(pipeline);
            }
        }

        destroyLayout(layout: NriPipelineLayoutHandle | null) {
            if (layout) {
                Nri_DestroyPipelineLayout(layout);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const arithmetic = new ArithmeticSample(sample);
        // -fp16: start with 16-bit arithmetic enabled (where the device has it); -noUI: no options
        // window.
        Nri_AddExampleOption(sample, "-fp16");
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-fp16") {
                arithmetic.fp16Enabled = true;
            } else if (arg == "-noUI") {
                arithmetic.noUI = true;
            }
        }
        return arithmetic.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return Khr16BitArithmeticNri.main(argc, argv);
}

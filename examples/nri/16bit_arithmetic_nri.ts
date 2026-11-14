/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private viewFormat: NriFormat = NriFormat.Unknown;
        private computeLayout: NriPipelineLayout | null = null;
        private computeLayoutFP16: NriPipelineLayout | null = null;
        private computeFP32: NriPipeline | null = null;
        private computeFP16: NriPipeline | null = null;
        private visualizeLayout: NriPipelineLayout | null = null;
        private visualizePipeline: NriPipeline | null = null;
        private blobBuffer: NriBuffer | null = null;
        private blobView: NriDescriptor | null = null;
        private image: NriTexture | null = null;
        private imageStorage: NriDescriptor | null = null;
        private imageView: NriDescriptor | null = null;
        private sampler: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private computeSet: NriDescriptorSet | null = null;
        private computeSetFP16: NriDescriptorSet | null = null;
        private visualizeSet: NriDescriptorSet | null = null;
        // The image is read by the draw (after the first frame).
        private imageDrawn: boolean = false;
        private imgui: boolean = false;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;

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
            this.test = this.sample.isTest() != 0;

            // Swap chain: rendered through sRGB views, as the sample's sRGB color buffer (which the
            // Donut example blits into its back buffer).
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;
            this.viewFormat = viewFormat;

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);

            // 16-bit types need shader model 6.2 (no D3D11 shaders for them).
            this.native16Bit = graphicsAPI != NriGraphicsAPI.D3D11 && device.isFeatureSupported(NriFeature.Native16Bit) != 0;
            this.native16BitConstants = this.native16Bit && device.isFeatureSupported(NriFeature.Native16BitConstants) != 0;
            this.fp16Enabled = this.fp16Enabled && this.native16Bit;

            // The layouts: the compute shaders' push constants (b0), blobs (t0) and image (u0); the
            // visualization's image (t0) and sampler (s0).
            this.computeLayout = this.createComputeLayout(device, PUSH32_SIZE);
            const visualizeLayoutDesc = NriPipelineLayoutDesc.create();
            visualizeLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            visualizeLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.visualizeLayout = device.createPipelineLayoutFromDesc(visualizeLayoutDesc);
            visualizeLayoutDesc.destroy();
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
            this.computeFP32 = device.createComputePipeline(computeLayout, `${shaders}_compute_fp32.bin`, "compute_fp32");
            if (this.native16Bit) {
                const computeLayoutFP16 = this.createComputeLayout(device, this.native16BitConstants ? PUSH16_SIZE : PUSH32_SIZE);
                this.computeLayoutFP16 = computeLayoutFP16;
                if (computeLayoutFP16) {
                    this.computeFP16 = device.createComputePipelinePermutation(computeLayoutFP16,
                        `${shaders}_fp16_compute_fp16.bin`, "compute_fp16", this.native16BitConstants ? "PUSH_CONSTANT_16=1" : "PUSH_CONSTANT_16=0");
                }
            }
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_visualize_vs.bin`, "visualize_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_visualize_ps.bin`, "visualize_ps") != 0;
            }
            desc.setColor(viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.visualizePipeline = device.createPipelineFromDesc(visualizeLayout, desc);
            }
            desc.destroy();
            if (!this.computeFP32 || !this.visualizePipeline || !this.fp16PipelineMade()) {
                console.log("Cannot load the 16-bit arithmetic shaders");
                return 0;
            }

            // The blobs (two 16-bit floats to a 32-bit word), and the image the compute shader
            // renders, read through a linear, clamped sampler.
            const blobs: f32[] = [];
            for (let i = 0; i < BLOBS.length; i += 2) {
                blobs.push(0.0);
                Nri.storeInt32(Ref(blobs[blobs.length - 1]), BLOBS[i] | (BLOBS[i + 1] << 16));
            }
            const blobBuffer = device.createHostBufferWithStride(NUM_BLOBS * BLOB_STRIDE, NriBufferUsage.StructuredBuffer, BLOB_STRIDE);
            this.blobBuffer = blobBuffer;
            const image = device.createStorageTexture(this.queue, WIDTH, HEIGHT, NriFormat.RGBA16_SFLOAT);
            this.image = image;
            this.sampler = device.createSampler(NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            const descriptorPool = device.createDescriptorPoolWithBuffers(3, 1, 0, 1, 2, 2, 0, 0);
            this.descriptorPool = descriptorPool;
            const sampler = this.sampler;
            if (!blobBuffer || !image || !sampler || !descriptorPool) {
                console.log("Cannot create the resources");
                return 0;
            }
            blobBuffer.write(0, Ref(blobs[0]), NUM_BLOBS * BLOB_STRIDE);
            const blobView = blobBuffer.createStructuredView(0);
            this.blobView = blobView;
            const imageStorage = image.createStorageView(NriFormat.RGBA16_SFLOAT);
            const imageView = image.createView(NriFormat.RGBA16_SFLOAT);
            this.imageStorage = imageStorage;
            this.imageView = imageView;
            const computeSet = descriptorPool.allocateDescriptorSet(computeLayout, 0, 0);
            const visualizeSet = descriptorPool.allocateDescriptorSet(visualizeLayout, 0, 0);
            this.computeSet = computeSet;
            this.visualizeSet = visualizeSet;
            if (!blobView || !computeSet || !visualizeSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            this.updateComputeSet(computeSet);
            visualizeSet.updateDescriptor(0, 0, imageView);
            visualizeSet.updateDescriptor(1, 0, sampler);
            const computeLayoutFP16 = this.computeLayoutFP16;
            if (computeLayoutFP16) {
                const computeSetFP16 = descriptorPool.allocateDescriptorSet(computeLayoutFP16, 0, 0);
                this.computeSetFP16 = computeSetFP16;
                if (!computeSetFP16) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                this.updateComputeSet(computeSetFP16);
            }

            // The sample's options window.
            if (!this.noUI) {
                if (this.sample.initImgui(device) == 0) {
                    console.log("Cannot initialize the user interface");
                    return 0;
                }
                this.imgui = true;
            }

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
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
        createComputeLayout(device: NriDevice, pushConstantsSize: int) {
            const desc = NriPipelineLayoutDesc.create();
            desc.addRootConstants(0, pushConstantsSize, NriStage.Compute);
            desc.addRange(0, 0, 1, NriDescriptorType.StructuredBuffer, NriStage.Compute, NriRangeFlags.None);
            desc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
            const layout = device.createPipelineLayoutFromDesc(desc);
            desc.destroy();
            return layout;
        }

        updateComputeSet(set: NriDescriptorSet) {
            const blobView = this.blobView;
            const imageStorage = this.imageStorage;
            if (!blobView || !imageStorage) {
                return;
            }
            set.updateDescriptor(0, 0, blobView);
            set.updateDescriptor(1, 0, imageStorage);
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

        // The sample's options window.
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("16-bit arithmetic", 1);
            if (this.native16Bit) {
                this.fp16Enabled = NriImgui.checkbox("Enable 16-bit arithmetic", this.fp16Enabled ? 1 : 0) != 0;
            } else {
                NriImgui.text("16-bit arithmetic (unsupported features)");
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        writePush32(seedValue: number) {
            Nri.storeInt32(Ref(this.push32[0]), NUM_BLOBS);
            this.push32[1] = seedValue;
            Nri.storeInt32(Ref(this.push32[2]), RANGE_X);
            Nri.storeInt32(Ref(this.push32[3]), RANGE_Y);
        }

        // The compute shader over the image (1024 x 1024 in 8 x 8 groups), then the image goes to
        // the draw.
        recordCompute(commandBuffer: NriCommandBuffer) {
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
                Nri.storeInt32(Ref(this.push16[0]), NUM_BLOBS | (seed16 << 16));
                Nri.storeInt32(Ref(this.push16[1]), (RANGE_X & 0xFFFF) | ((RANGE_Y & 0xFFFF) << 16));
                pushConstants = PUSH16_SIZE;
            } else {
                this.writePush32(seedValue);
            }
            if (!layout || !pipeline || !set) {
                return;
            }

            if (this.imageDrawn) {
                commandBuffer.textureBarrier(image, NriTextureState.ShaderResource, NriTextureState.Storage);
            }
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setComputePipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            if (pushConstants == PUSH16_SIZE) {
                commandBuffer.setComputeRootConstants(0, Ref(this.push16[0]), PUSH16_SIZE);
            } else {
                commandBuffer.setComputeRootConstants(0, Ref(this.push32[0]), PUSH32_SIZE);
            }
            commandBuffer.setComputeDescriptorSet(0, set);
            commandBuffer.dispatch(WIDTH / GROUP_SIZE, HEIGHT / GROUP_SIZE, 1);
            commandBuffer.textureBarrier(image, NriTextureState.Storage, NriTextureState.ShaderResource);
            this.imageDrawn = true;
        }

        // The image over the frame (between NriCommandBuffer.beginRendering and NriCommandBuffer.endRendering).
        recordDraw(commandBuffer: NriCommandBuffer) {
            const visualizeLayout = this.visualizeLayout;
            const visualizePipeline = this.visualizePipeline;
            const descriptorPool = this.descriptorPool;
            const visualizeSet = this.visualizeSet;
            if (!visualizeLayout || !visualizePipeline || !descriptorPool || !visualizeSet) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(visualizeLayout);
            commandBuffer.setPipeline(visualizePipeline);
            commandBuffer.setDescriptorSet(0, visualizeSet);
            commandBuffer.draw(3, 1, 0, 0);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            if (this.imgui) {
                this.buildUI();
            }

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the compute pass; cleared to black, the image over the frame, the options
                // window over it.
                commandBuffer.begin();
                this.recordCompute(commandBuffer);
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                commandBuffer.clearColor(0.0, 0.0, 0.0, 1.0);
                this.recordDraw(commandBuffer);
                if (this.imgui) {
                    this.sample.drawImgui(commandBuffer, this.viewFormat);
                }
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
                if (this.imgui) {
                    this.sample.imguiEndFrame();
                }
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
                if (this.imgui) {
                    this.sample.destroyImgui();
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroyDescriptor(this.blobView);
                this.destroyDescriptor(this.imageStorage);
                this.destroyDescriptor(this.imageView);
                this.destroyDescriptor(this.sampler);
                const blobBuffer = this.blobBuffer;
                if (blobBuffer) {
                    blobBuffer.destroy();
                }
                const image = this.image;
                if (image) {
                    image.destroy();
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    readbackBuffer.destroy();
                }
                this.destroyPipeline(this.computeFP32);
                this.destroyPipeline(this.computeFP16);
                this.destroyPipeline(this.visualizePipeline);
                this.destroyLayout(this.computeLayout);
                this.destroyLayout(this.computeLayoutFP16);
                this.destroyLayout(this.visualizeLayout);
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }

        destroyDescriptor(descriptor: NriDescriptor | null) {
            if (descriptor) {
                descriptor.destroy();
            }
        }

        destroyPipeline(pipeline: NriPipeline | null) {
            if (pipeline) {
                pipeline.destroy();
            }
        }

        destroyLayout(layout: NriPipelineLayout | null) {
            if (layout) {
                layout.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const arithmetic = new ArithmeticSample(sample);
        // -fp16: start with 16-bit arithmetic enabled (where the device has it); -noUI: no options
        // window.
        sample.addExampleOption("-fp16");
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
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

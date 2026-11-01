/// <reference path="../../core/nri/nri_interop.d.ts" />

namespace ComputeShaderDerivativesNri {
    // compute_shader_derivatives, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework
    // instead of Donut and NVRHI: the same shaders (compute_shader_derivatives.hlsl's), through the
    // NRI calls core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws, with NRIFramework's
    // ImGui for the sample's overlay. This example creates everything it runs, and does the
    // rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no derivatives in compute shaders,
    // or no shaders for the graphics API (D3D11).
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Compute Shader Derivatives";

    // The image the compute shader writes, in 8 x 8 tiles.
    const IMAGE_WIDTH = 512;
    const IMAGE_HEIGHT = 512;
    const TILE_SIZE = 8;

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

    // -test: checks the last frame, read back, as the Donut example does. The corners are black; the
    // radial pattern, colored by the compute shader's derivatives, lights about 84% of the frame,
    // about 35% blue.
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
        let dark = 0;
        let blue = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r <= 20 && g <= 20 && b <= 20) {
                dark++;
            }
            if (r <= 89 && g <= 119 && b >= 121) {
                blue++;
            }
        }
        const total = width * height;
        const lit = 100.0 * (total - dark) / total;
        console.log(`Lit: ${lit}% (${total - dark} of ${total} pixels)`);
        if (lit < 75.0 || lit > 92.0) {
            return `Lit: ${lit}% of the pixels, not 75% to 92%`;
        }
        const bluePercent = 100.0 * blue / total;
        console.log(`Blue: ${bluePercent}% (${blue} of ${total} pixels)`);
        if (bluePercent < 25.0 || bluePercent > 45.0) {
            return `Blue: ${bluePercent}% of the pixels, not 25% to 45%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' compute_shader_derivatives (as examples/compute_shader_derivatives.ts
    // ports it) to NRI: a compute shader evaluates a radial pattern and takes its derivatives (ddx,
    // ddy) across neighbouring threads, as pixel shaders do across pixels, drawing the gradient's
    // magnitude as edges; the image is stretched over the screen. The threads form quads of 2 x 2,
    // or of 4 in a row with -linear (NRI tells whether compute shaders have derivatives, not which
    // groups: the Donut example falls back to linear groups where quads are missing).
    class ComputeShaderDerivatives {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private computeLayout: NriPipelineLayoutHandle | null = null;
        private computePipeline: NriPipelineHandle | null = null;
        private drawLayout: NriPipelineLayoutHandle | null = null;
        private drawPipeline: NriPipelineHandle | null = null;
        private image: NriTextureHandle | null = null;
        private imageStorage: NriDescriptorHandle | null = null;
        private imageView: NriDescriptorHandle | null = null;
        private sampler: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private computeSet: NriDescriptorSetHandle | null = null;
        private drawSet: NriDescriptorSetHandle | null = null;
        // The image is read by the draw (after the first frame).
        private imageDrawn: boolean = false;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // -linear: quads of 4 threads in a row rather than 2 x 2; -noUI: no overlay.
        useLinear: boolean = false;
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

            // Shader model 6.6's shaders only (as the Donut example's), with derivatives in compute
            // shaders.
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (compute_shader_derivatives.hlsl needs shader model 6.6)";
                return 0;
            }
            if (Nri_IsFeatureSupported(device, NriFeature.ComputeShaderDerivatives) == 0) {
                this.unsupportedReason = "This example needs derivatives in compute shaders (D3D12 shader model 6.6 or Vulkan's VK_KHR_compute_shader_derivatives)";
                return 0;
            }

            // The layouts: the compute shader's image (u0); the draw's image (t0) and sampler (s0).
            const computeLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(computeLayoutDesc, 0, 0, 1, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
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

            // The pipelines: compute_shader_derivatives.hlsl's shaders, as compiled for the Donut
            // example; the fullscreen triangle with no culling, no depth.
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/compute_shader_derivatives/${folder}/compute_shader_derivatives`;
            const entry = this.useLinear ? "derivatives_linear" : "derivatives_quad";
            this.computePipeline = Nri_CreateComputePipeline(device, computeLayout, `${shaders}_${entry}.bin`, entry);
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_fullscreen_vs.bin`, "fullscreen_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_fullscreen_ps.bin`, "fullscreen_ps") != 0;
            }
            Nri_PipelineDescSetColor(desc, viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.drawPipeline = Nri_CreatePipelineFromDesc(device, drawLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            if (!this.computePipeline || !this.drawPipeline) {
                console.log("Cannot load the compute shader derivatives shaders");
                return 0;
            }

            // Storage image for compute shader output, read through a linear, clamped sampler.
            const image = Nri_CreateStorageTexture(device, this.queue, IMAGE_WIDTH, IMAGE_HEIGHT, NriFormat.RGBA8_UNORM);
            this.image = image;
            this.sampler = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            const descriptorPool = Nri_CreateDescriptorPool(device, 2, 1, 0, 1, 1, 0);
            this.descriptorPool = descriptorPool;
            const sampler = this.sampler;
            if (!image || !sampler || !descriptorPool) {
                console.log("Cannot create the image");
                return 0;
            }
            const imageStorage = Nri_CreateStorageTextureView(image, NriFormat.RGBA8_UNORM);
            const imageView = Nri_CreateTextureView(image, NriFormat.RGBA8_UNORM);
            this.imageStorage = imageStorage;
            this.imageView = imageView;
            const computeSet = Nri_AllocateDescriptorSet(descriptorPool, computeLayout, 0, 0);
            const drawSet = Nri_AllocateDescriptorSet(descriptorPool, drawLayout, 0, 0);
            this.computeSet = computeSet;
            this.drawSet = drawSet;
            if (!computeSet || !drawSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            Nri_UpdateDescriptor(computeSet, 0, 0, imageStorage);
            Nri_UpdateDescriptor(drawSet, 0, 0, imageView);
            Nri_UpdateDescriptor(drawSet, 1, 0, sampler);

            // The sample's overlay.
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

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The sample's overlay (its title, ApiVulkanSample's default).
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Vulkan Example", 1);
            if (Nri_ImguiCollapsingHeader("Compute Shader Derivatives", 1) != 0) {
                Nri_ImguiText("Visualization:");
                Nri_ImguiText("- Blue: Base procedural radial pattern");
                Nri_ImguiText("- Red/Yellow: Edges (high gradient magnitude)");
                Nri_ImguiText("- Gradient magnitude = sqrt(dx^2 + dy^2)");
                Nri_ImguiText("");
                Nri_ImguiText("This demonstrates edge detection using compute shader");
                Nri_ImguiText("derivatives, useful for LOD selection, filtering, and");
                Nri_ImguiText("spatial analysis in compute pipelines.");
                Nri_ImguiText("");
                Nri_ImguiText(this.useLinear ? "Derivative groups: linear (4 threads in a row)" : "Derivative groups: quads (2 x 2 threads)");
            }
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The compute shader: 512 x 512 image with 8 x 8 local size = 64 x 64 workgroups; then the
        // image goes to the draw.
        recordCompute(commandBuffer: NriCommandBufferHandle) {
            const computeLayout = this.computeLayout;
            const computePipeline = this.computePipeline;
            const descriptorPool = this.descriptorPool;
            const computeSet = this.computeSet;
            const image = this.image;
            if (!computeLayout || !computePipeline || !descriptorPool || !computeSet || !image) {
                return;
            }
            if (this.imageDrawn) {
                Nri_CmdTextureBarrier(commandBuffer, image, NriTextureState.ShaderResource, NriTextureState.Storage);
            }
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetComputePipelineLayout(commandBuffer, computeLayout);
            Nri_CmdSetPipeline(commandBuffer, computePipeline);
            Nri_CmdSetComputeDescriptorSet(commandBuffer, 0, computeSet);
            Nri_CmdDispatch(commandBuffer, IMAGE_WIDTH / TILE_SIZE, IMAGE_HEIGHT / TILE_SIZE, 1);
            Nri_CmdTextureBarrier(commandBuffer, image, NriTextureState.Storage, NriTextureState.ShaderResource);
            this.imageDrawn = true;
        }

        // The computed image as a fullscreen triangle (between Nri_CmdBeginRendering and
        // Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle) {
            const drawLayout = this.drawLayout;
            const drawPipeline = this.drawPipeline;
            const descriptorPool = this.descriptorPool;
            const drawSet = this.drawSet;
            if (!drawLayout || !drawPipeline || !descriptorPool || !drawSet) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, drawLayout);
            Nri_CmdSetPipeline(commandBuffer, drawPipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, drawSet);
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

                // Record: the compute pass, the image over the frame, the overlay over it.
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
                this.destroyDescriptor(this.imageStorage);
                this.destroyDescriptor(this.imageView);
                this.destroyDescriptor(this.sampler);
                const image = this.image;
                if (image) {
                    Nri_DestroyTexture(image);
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
                }
                this.destroyPipeline(this.computePipeline);
                this.destroyPipeline(this.drawPipeline);
                const computeLayout = this.computeLayout;
                if (computeLayout) {
                    Nri_DestroyPipelineLayout(computeLayout);
                }
                const drawLayout = this.drawLayout;
                if (drawLayout) {
                    Nri_DestroyPipelineLayout(drawLayout);
                }
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
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const computeShaderDerivatives = new ComputeShaderDerivatives(sample);
        // -linear: linear derivative groups; -noUI: no overlay.
        Nri_AddExampleOption(sample, "-linear");
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-linear") {
                computeShaderDerivatives.useLinear = true;
            } else if (arg == "-noUI") {
                computeShaderDerivatives.noUI = true;
            }
        }
        return computeShaderDerivatives.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return ComputeShaderDerivativesNri.main(argc, argv);
}

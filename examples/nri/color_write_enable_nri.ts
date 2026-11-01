/// <reference path="../../core/nri/nri_interop.d.ts" />

namespace ColorWriteEnableNri {
    // color_write_enable, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (color_write_enable.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws, with NRIFramework's ImGui for the
    // sample's overlay. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Color Write Enable";

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

    // One of the sample's three attachments: the texture, rendered into and read.
    class Target {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle, public view: NriDescriptorHandle) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does. The corners are the gray
    // background color; the triangle (all three channels written: an eighth of the frame) and the
    // overlay, unless -noUI, cover 10% to 30% of the frame, the middle of the frame colored.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const background = 0xBCBCBC;
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != background) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 188, 188, 188`;
            }
        }
        if ((pixels[(height / 2) * width + width / 2] & 0xFFFFFF) == background) {
            return "the middle of the triangle is the background";
        }
        let triangle = 0;
        for (let i = 0; i < width * height; i++) {
            if ((pixels[i] & 0xFFFFFF) != background) {
                triangle++;
            }
        }
        const total = width * height;
        const percent = 100.0 * triangle / total;
        console.log(`Triangle and overlay: ${percent}% (${triangle} of ${total} pixels)`);
        if (percent < 10.0 || percent > 30.0) {
            return `Triangle and overlay: ${percent}% of the pixels, not 10% to 30%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' color_write_enable (as examples/color_write_enable.ts ports it) to NRI:
    // a triangle with a color per corner drawn into three targets at once, the first written only in
    // red, the second in green, the third in blue, each cleared to that channel of the background
    // color; then the three added up into the swap chain texture. The UI turns writing each target
    // on and off (the sample's VK_EXT_color_write_enable dynamic state; NRI has no dynamic color
    // write enable, so here a pipeline per combination, the disabled targets' write masks 0) and
    // picks the background color.
    class ColorWriteEnable {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private triangleLayout: NriPipelineLayoutHandle | null = null;
        private compositionLayout: NriPipelineLayoutHandle | null = null;
        // The triangle's pipelines by the enabled targets (bit 0 red, 1 green, 2 blue), made when
        // first needed; the composition's.
        private trianglePipelines: (NriPipelineHandle | null)[] = [];
        private compositionPipeline: NriPipelineHandle | null = null;
        private shaders: string = "";
        // The sample's three attachments (sRGB, as the swap chain's views), read by the composition
        // through its descriptor set.
        private targets: Target[] = [];
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private compositionSet: NriDescriptorSetHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // The sample's settings: -nored, -nogreen, -noblue, -background <r> <g> <b>; -noUI: no
        // overlay.
        backgroundColor: f32[] = [0.5, 0.5, 0.5];
        rBitEnabled: boolean = true;
        gBitEnabled: boolean = true;
        bBitEnabled: boolean = true;
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
                console.log(this.unsupportedReason);
                result = 1;
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

            // Swap chain: rendered through sRGB views, as the Donut example's sRGB back buffer.
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

            // The layouts: the triangle's binds nothing; the composition's has the three targets
            // (t0 to t2).
            this.triangleLayout = Nri_CreatePipelineLayout(device);
            const compositionLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(compositionLayoutDesc, 0, 0, 3, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            this.compositionLayout = Nri_CreatePipelineLayoutFromDesc(device, compositionLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(compositionLayoutDesc);
            const compositionLayout = this.compositionLayout;
            if (!compositionLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The composition's pipeline: color_write_enable.hlsl's shaders, as compiled for the
            // Donut example; back faces (clockwise front faces) culled, no depth, no blending.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            this.shaders = `shaders/color_write_enable/${folder}/color_write_enable`;
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${this.shaders}_composition_vs.bin`, "composition_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${this.shaders}_composition_ps.bin`, "composition_ps") != 0;
            }
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            Nri_PipelineDescSetColor(desc, viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.compositionPipeline = Nri_CreatePipelineFromDesc(device, compositionLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            for (let i = 0; i < 8; i++) {
                this.trianglePipelines.push(null);
            }
            if (!this.compositionPipeline || !this.trianglePipeline(7)) {
                console.log("Cannot load the color write enable shaders");
                return 0;
            }

            // The three attachments, the swap chain's size.
            for (let i = 0; i < 3; i++) {
                const texture = Nri_CreateRenderTargetTexture(device, this.queue, this.width, this.height, viewFormat);
                if (!texture) {
                    console.log("Cannot create the attachments");
                    return 0;
                }
                this.targets.push(new Target(texture, Nri_CreateColorAttachmentView(texture, viewFormat), Nri_CreateTextureView(texture, viewFormat)));
            }
            const descriptorPool = Nri_CreateDescriptorPool(device, 1, 0, 0, 3, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!descriptorPool) {
                console.log("Cannot create the descriptor pool");
                return 0;
            }
            const compositionSet = Nri_AllocateDescriptorSet(descriptorPool, compositionLayout, 0, 0);
            this.compositionSet = compositionSet;
            if (!compositionSet) {
                console.log("Cannot create the descriptor set");
                return 0;
            }
            for (let i = 0; i < 3; i++) {
                Nri_UpdateDescriptor(compositionSet, 0, i, this.targets[i].view);
            }

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

        // The sample's color pipeline for the enabled targets: back faces culled, no depth, no
        // blending; each target written in its one channel, or not at all when disabled. Null if
        // it can't be made.
        trianglePipeline(enabled: int): NriPipelineHandle | null {
            const device = this.device;
            const triangleLayout = this.triangleLayout;
            if (!device || !triangleLayout) {
                return null;
            }
            const made = this.trianglePipelines[enabled];
            if (made) {
                return made;
            }
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${this.shaders}_triangle_vs.bin`, "triangle_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${this.shaders}_triangle_ps.bin`, "triangle_ps") != 0;
            }
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            Nri_PipelineDescSetColor(desc, this.viewFormat, (enabled & 1) != 0 ? NriColorWrite.R : NriColorWrite.None);
            Nri_PipelineDescAddColor(desc, this.viewFormat, (enabled & 2) != 0 ? NriColorWrite.G : NriColorWrite.None);
            Nri_PipelineDescAddColor(desc, this.viewFormat, (enabled & 4) != 0 ? NriColorWrite.B : NriColorWrite.None);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, triangleLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            this.trianglePipelines[enabled] = pipeline;
            return pipeline;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The sample's overlay.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Color Write Enable", 1);
            Nri_ImguiPushItemWidth(110.0);
            if (Nri_ImguiCollapsingHeader("Background color", 1) != 0) {
                Nri_ImguiColorPicker3("", Ref(this.backgroundColor[0]), 200.0);
            }
            if (Nri_ImguiCollapsingHeader("Enabled attachment", 1) != 0) {
                this.rBitEnabled = Nri_ImguiCheckbox("Red bit", this.rBitEnabled ? 1 : 0) != 0;
                this.gBitEnabled = Nri_ImguiCheckbox("Green bit", this.gBitEnabled ? 1 : 0) != 0;
                this.bBitEnabled = Nri_ImguiCheckbox("Blue bit", this.bBitEnabled ? 1 : 0) != 0;
            }
            Nri_ImguiPopItemWidth();
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // First subpass: the attachments cleared, each to its channel of the background color, and
        // the triangle drawn into them; then they go to the composition.
        recordTriangle(commandBuffer: NriCommandBufferHandle) {
            const triangleLayout = this.triangleLayout;
            const enabled = (this.rBitEnabled ? 1 : 0) | (this.gBitEnabled ? 2 : 0) | (this.bBitEnabled ? 4 : 0);
            const pipeline = this.trianglePipeline(enabled);
            if (!triangleLayout || !pipeline) {
                return;
            }
            for (const target of this.targets) {
                Nri_CmdTextureBarrier(commandBuffer, target.texture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            }
            Nri_CmdBeginRenderingWithThreeColors(commandBuffer, this.targets[0].colorAttachment, this.targets[1].colorAttachment,
                this.targets[2].colorAttachment);
            const background = this.backgroundColor;
            Nri_CmdClearColorAttachment(commandBuffer, 0, background[0], 0.0, 0.0, 0.0);
            Nri_CmdClearColorAttachment(commandBuffer, 1, 0.0, background[1], 0.0, 0.0);
            Nri_CmdClearColorAttachment(commandBuffer, 2, 0.0, 0.0, background[2], 0.0);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, triangleLayout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdDraw(commandBuffer, 3, 1, 0, 0);
            Nri_CmdEndRendering(commandBuffer);
            for (const target of this.targets) {
                Nri_CmdTextureBarrier(commandBuffer, target.texture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
            }
        }

        // Second subpass: the attachments added up (between Nri_CmdBeginRendering and
        // Nri_CmdEndRendering).
        recordComposition(commandBuffer: NriCommandBufferHandle) {
            const compositionLayout = this.compositionLayout;
            const compositionPipeline = this.compositionPipeline;
            const descriptorPool = this.descriptorPool;
            const compositionSet = this.compositionSet;
            if (!compositionLayout || !compositionPipeline || !descriptorPool || !compositionSet) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, compositionLayout);
            Nri_CmdSetPipeline(commandBuffer, compositionPipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, compositionSet);
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

                // Record: the triangle into the attachments; the swap chain texture cleared to
                // transparent black, the attachments added up into it, the overlay over them.
                Nri_BeginCommandBuffer(commandBuffer);
                this.recordTriangle(commandBuffer);
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
                this.recordComposition(commandBuffer);
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
                for (const target of this.targets) {
                    Nri_DestroyDescriptor(target.colorAttachment);
                    Nri_DestroyDescriptor(target.view);
                    Nri_DestroyTexture(target.texture);
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
                }
                for (const pipeline of this.trianglePipelines) {
                    this.destroyPipeline(pipeline);
                }
                this.destroyPipeline(this.compositionPipeline);
                this.destroyLayout(this.triangleLayout);
                this.destroyLayout(this.compositionLayout);
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
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
        const colorWriteEnable = new ColorWriteEnable(sample);
        // -nored, -nogreen, -noblue: the targets' initial write switches; -background <r> <g> <b>:
        // the initial background color; -noUI: no overlay.
        Nri_AddExampleOption(sample, "-nored");
        Nri_AddExampleOption(sample, "-nogreen");
        Nri_AddExampleOption(sample, "-noblue");
        Nri_AddExampleOptionWithValues(sample, "-background", 3);
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-nored") {
                colorWriteEnable.rBitEnabled = false;
            } else if (arg == "-nogreen") {
                colorWriteEnable.gBitEnabled = false;
            } else if (arg == "-noblue") {
                colorWriteEnable.bBitEnabled = false;
            } else if (arg == "-background" && i + 3 < argc) {
                for (let k = 0; k < 3; k++) {
                    colorWriteEnable.backgroundColor[k] = parseFloat(Nri_GetArg(argc, argv, i + 1 + k));
                }
                i += 3;
            } else if (arg == "-noUI") {
                colorWriteEnable.noUI = true;
            }
        }
        return colorWriteEnable.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return ColorWriteEnableNri.main(argc, argv);
}

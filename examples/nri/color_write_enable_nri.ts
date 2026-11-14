/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

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

    // One of the sample's three attachments: the texture, rendered into and read.
    class Target {
        constructor(public texture: NriTexture, public colorAttachment: NriDescriptor, public view: NriDescriptor) {
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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;
        private viewFormat: NriFormat = NriFormat.Unknown;
        private triangleLayout: NriPipelineLayout | null = null;
        private compositionLayout: NriPipelineLayout | null = null;
        // The triangle's pipelines by the enabled targets (bit 0 red, 1 green, 2 blue), made when
        // first needed; the composition's.
        private trianglePipelines: (NriPipeline | null)[] = [];
        private compositionPipeline: NriPipeline | null = null;
        private shaders: string = "";
        // The sample's three attachments (sRGB, as the swap chain's views), read by the composition
        // through its descriptor set.
        private targets: Target[] = [];
        private descriptorPool: NriDescriptorPool | null = null;
        private compositionSet: NriDescriptorSet | null = null;
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
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // Swap chain: rendered through sRGB views, as the Donut example's sRGB back buffer.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);

            // The layouts: the triangle's binds nothing; the composition's has the three targets
            // (t0 to t2).
            this.triangleLayout = device.createPipelineLayout();
            const compositionLayoutDesc = NriPipelineLayoutDesc.create();
            compositionLayoutDesc.addRange(0, 0, 3, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            this.compositionLayout = device.createPipelineLayoutFromDesc(compositionLayoutDesc);
            compositionLayoutDesc.destroy();
            const compositionLayout = this.compositionLayout;
            if (!compositionLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The composition's pipeline: color_write_enable.hlsl's shaders, as compiled for the
            // Donut example; back faces (clockwise front faces) culled, no depth, no blending.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            this.shaders = `shaders/color_write_enable/${folder}/color_write_enable`;
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${this.shaders}_composition_vs.bin`, "composition_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${this.shaders}_composition_ps.bin`, "composition_ps") != 0;
            }
            desc.setCullMode(NriCullMode.Back);
            desc.setColor(viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.compositionPipeline = device.createPipelineFromDesc(compositionLayout, desc);
            }
            desc.destroy();
            for (let i = 0; i < 8; i++) {
                this.trianglePipelines.push(null);
            }
            if (!this.compositionPipeline || !this.trianglePipeline(7)) {
                console.log("Cannot load the color write enable shaders");
                return 0;
            }

            // The three attachments, the swap chain's size.
            if (!this.createSizeTargets(device)) {
                console.log("Cannot create the attachments");
                return 0;
            }
            const descriptorPool = device.createDescriptorPool(1, 0, 0, 3, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!descriptorPool) {
                console.log("Cannot create the descriptor pool");
                return 0;
            }
            const compositionSet = descriptorPool.allocateDescriptorSet(compositionLayout, 0, 0);
            this.compositionSet = compositionSet;
            if (!compositionSet) {
                console.log("Cannot create the descriptor set");
                return 0;
            }
            for (let i = 0; i < 3; i++) {
                compositionSet.updateDescriptor(0, i, this.targets[i].view);
            }

            // The sample's overlay.
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

        // The sample's color pipeline for the enabled targets: back faces culled, no depth, no
        // blending; each target written in its one channel, or not at all when disabled. Null if
        // it can't be made.
        trianglePipeline(enabled: int): NriPipeline | null {
            const device = this.device;
            const triangleLayout = this.triangleLayout;
            if (!device || !triangleLayout) {
                return null;
            }
            const made = this.trianglePipelines[enabled];
            if (made) {
                return new NriPipeline(made.handle);
            }
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${this.shaders}_triangle_vs.bin`, "triangle_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${this.shaders}_triangle_ps.bin`, "triangle_ps") != 0;
            }
            desc.setCullMode(NriCullMode.Back);
            desc.setColor(this.viewFormat, (enabled & 1) != 0 ? NriColorWrite.R : NriColorWrite.None);
            desc.addColor(this.viewFormat, (enabled & 2) != 0 ? NriColorWrite.G : NriColorWrite.None);
            desc.addColor(this.viewFormat, (enabled & 4) != 0 ? NriColorWrite.B : NriColorWrite.None);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(triangleLayout, desc);
            }
            desc.destroy();
            if (!pipeline) {
                return null;
            }
            // A wrapper of its own (destroying nothing) for the caller: the list keeps the pipeline.
            const result = new NriPipeline(pipeline.handle);
            this.trianglePipelines[enabled] = pipeline;
            return result;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The sample's overlay.
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Color Write Enable", 1);
            NriImgui.pushItemWidth(110.0);
            if (NriImgui.collapsingHeader("Background color", 1) != 0) {
                NriImgui.colorPicker3("", Ref(this.backgroundColor[0]), 200.0);
            }
            if (NriImgui.collapsingHeader("Enabled attachment", 1) != 0) {
                this.rBitEnabled = NriImgui.checkbox("Red bit", this.rBitEnabled ? 1 : 0) != 0;
                this.gBitEnabled = NriImgui.checkbox("Green bit", this.gBitEnabled ? 1 : 0) != 0;
                this.bBitEnabled = NriImgui.checkbox("Blue bit", this.bBitEnabled ? 1 : 0) != 0;
            }
            NriImgui.popItemWidth();
            NriImgui.end();
            this.sample.imguiRender();
        }

        // First subpass: the attachments cleared, each to its channel of the background color, and
        // the triangle drawn into them; then they go to the composition.
        recordTriangle(commandBuffer: NriCommandBuffer) {
            const triangleLayout = this.triangleLayout;
            const enabled = (this.rBitEnabled ? 1 : 0) | (this.gBitEnabled ? 2 : 0) | (this.bBitEnabled ? 4 : 0);
            const pipeline = this.trianglePipeline(enabled);
            if (!triangleLayout || !pipeline) {
                return;
            }
            for (const target of this.targets) {
                commandBuffer.textureBarrier(target.texture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            }
            commandBuffer.beginRenderingWithThreeColors(this.targets[0].colorAttachment, this.targets[1].colorAttachment,
                this.targets[2].colorAttachment);
            const background = this.backgroundColor;
            commandBuffer.clearColorAttachment(0, background[0], 0.0, 0.0, 0.0);
            commandBuffer.clearColorAttachment(1, 0.0, background[1], 0.0, 0.0);
            commandBuffer.clearColorAttachment(2, 0.0, 0.0, background[2], 0.0);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(triangleLayout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.draw(3, 1, 0, 0);
            commandBuffer.endRendering();
            for (const target of this.targets) {
                commandBuffer.textureBarrier(target.texture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
            }
        }

        // Second subpass: the attachments added up (between NriCommandBuffer.beginRendering and
        // NriCommandBuffer.endRendering).
        recordComposition(commandBuffer: NriCommandBuffer) {
            const compositionLayout = this.compositionLayout;
            const compositionPipeline = this.compositionPipeline;
            const descriptorPool = this.descriptorPool;
            const compositionSet = this.compositionSet;
            if (!compositionLayout || !compositionPipeline || !descriptorPool || !compositionSet) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(compositionLayout);
            commandBuffer.setPipeline(compositionPipeline);
            commandBuffer.setDescriptorSet(0, compositionSet);
            commandBuffer.draw(3, 1, 0, 0);
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.viewFormat = this.swapChain.viewFormat();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
        }

        // The window-size targets: the three attachments (the swap chain's size and view format), and
        // the composition set's slots pointing at them once it's there; false if one can't be created.
        createSizeTargets(device: NriDevice): boolean {
            const viewFormat = this.swapChainViewFormat;
            for (let i = 0; i < 3; i++) {
                const texture = device.createRenderTargetTexture(this.queue, this.width, this.height, viewFormat);
                if (!texture) {
                    return false;
                }
                this.targets.push(new Target(texture, texture.createColorAttachmentView(viewFormat), texture.createView(viewFormat)));
            }
            const compositionSet = this.compositionSet;
            if (compositionSet) {
                for (let i = 0; i < 3; i++) {
                    compositionSet.updateDescriptor(0, i, this.targets[i].view);
                }
            }
            return true;
        }

        destroySizeTargets() {
            for (const target of this.targets) {
                target.colorAttachment.destroy();
                target.view.destroy();
                target.texture.destroy();
            }
            this.targets = [];
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain and the window-size targets made again at its
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
            this.destroySizeTargets();
            this.createSizeTargets(device);
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

                // Record: the triangle into the attachments; the swap chain texture cleared to
                // transparent black, the attachments added up into it, the overlay over them.
                commandBuffer.begin();
                this.recordTriangle(commandBuffer);
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
                this.recordComposition(commandBuffer);
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
                this.destroySizeTargets();
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    readbackBuffer.destroy();
                }
                for (const pipeline of this.trianglePipelines) {
                    this.destroyPipeline(pipeline);
                }
                this.destroyPipeline(this.compositionPipeline);
                this.destroyLayout(this.triangleLayout);
                this.destroyLayout(this.compositionLayout);
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
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
        const colorWriteEnable = new ColorWriteEnable(sample);
        // -nored, -nogreen, -noblue: the targets' initial write switches; -background <r> <g> <b>:
        // the initial background color; -noUI: no overlay.
        sample.addExampleOption("-nored");
        sample.addExampleOption("-nogreen");
        sample.addExampleOption("-noblue");
        sample.addExampleOptionWithValues("-background", 3);
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-nored") {
                colorWriteEnable.rBitEnabled = false;
            } else if (arg == "-nogreen") {
                colorWriteEnable.gBitEnabled = false;
            } else if (arg == "-noblue") {
                colorWriteEnable.bBitEnabled = false;
            } else if (arg == "-background" && i + 3 < argc) {
                for (let k = 0; k < 3; k++) {
                    colorWriteEnable.backgroundColor[k] = parseFloat(Nri.getArg(argc, argv, i + 1 + k));
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

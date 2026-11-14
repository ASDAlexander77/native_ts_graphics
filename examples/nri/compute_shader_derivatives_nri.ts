/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private viewFormat: NriFormat = NriFormat.Unknown;
        private computeLayout: NriPipelineLayout | null = null;
        private computePipeline: NriPipeline | null = null;
        private drawLayout: NriPipelineLayout | null = null;
        private drawPipeline: NriPipeline | null = null;
        private image: NriTexture | null = null;
        private imageStorage: NriDescriptor | null = null;
        private imageView: NriDescriptor | null = null;
        private sampler: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private computeSet: NriDescriptorSet | null = null;
        private drawSet: NriDescriptorSet | null = null;
        // The image is read by the draw (after the first frame).
        private imageDrawn: boolean = false;
        private imgui: boolean = false;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // -linear: quads of 4 threads in a row rather than 2 x 2; -noUI: no overlay.
        useLinear: boolean = false;
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

            // Shader model 6.6's shaders only (as the Donut example's), with derivatives in compute
            // shaders.
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (compute_shader_derivatives.hlsl needs shader model 6.6)";
                return 0;
            }
            if (device.isFeatureSupported(NriFeature.ComputeShaderDerivatives) == 0) {
                this.unsupportedReason = "This example needs derivatives in compute shaders (D3D12 shader model 6.6 or Vulkan's VK_KHR_compute_shader_derivatives)";
                return 0;
            }

            // The layouts: the compute shader's image (u0); the draw's image (t0) and sampler (s0).
            const computeLayoutDesc = NriPipelineLayoutDesc.create();
            computeLayoutDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
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

            // The pipelines: compute_shader_derivatives.hlsl's shaders, as compiled for the Donut
            // example; the fullscreen triangle with no culling, no depth.
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/compute_shader_derivatives/${folder}/compute_shader_derivatives`;
            const entry = this.useLinear ? "derivatives_linear" : "derivatives_quad";
            this.computePipeline = device.createComputePipeline(computeLayout, `${shaders}_${entry}.bin`, entry);
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_fullscreen_vs.bin`, "fullscreen_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_fullscreen_ps.bin`, "fullscreen_ps") != 0;
            }
            desc.setColor(viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.drawPipeline = device.createPipelineFromDesc(drawLayout, desc);
            }
            desc.destroy();
            if (!this.computePipeline || !this.drawPipeline) {
                console.log("Cannot load the compute shader derivatives shaders");
                return 0;
            }

            // Storage image for compute shader output, read through a linear, clamped sampler.
            const image = device.createStorageTexture(this.queue, IMAGE_WIDTH, IMAGE_HEIGHT, NriFormat.RGBA8_UNORM);
            this.image = image;
            this.sampler = device.createSampler(NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            const descriptorPool = device.createDescriptorPool(2, 1, 0, 1, 1, 0);
            this.descriptorPool = descriptorPool;
            const sampler = this.sampler;
            if (!image || !sampler || !descriptorPool) {
                console.log("Cannot create the image");
                return 0;
            }
            const imageStorage = image.createStorageView(NriFormat.RGBA8_UNORM);
            const imageView = image.createView(NriFormat.RGBA8_UNORM);
            this.imageStorage = imageStorage;
            this.imageView = imageView;
            const computeSet = descriptorPool.allocateDescriptorSet(computeLayout, 0, 0);
            const drawSet = descriptorPool.allocateDescriptorSet(drawLayout, 0, 0);
            this.computeSet = computeSet;
            this.drawSet = drawSet;
            if (!computeSet || !drawSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            computeSet.updateDescriptor(0, 0, imageStorage);
            drawSet.updateDescriptor(0, 0, imageView);
            drawSet.updateDescriptor(1, 0, sampler);

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

        // The sample's overlay (its title, ApiVulkanSample's default).
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Vulkan Example", 1);
            if (NriImgui.collapsingHeader("Compute Shader Derivatives", 1) != 0) {
                NriImgui.text("Visualization:");
                NriImgui.text("- Blue: Base procedural radial pattern");
                NriImgui.text("- Red/Yellow: Edges (high gradient magnitude)");
                NriImgui.text("- Gradient magnitude = sqrt(dx^2 + dy^2)");
                NriImgui.text("");
                NriImgui.text("This demonstrates edge detection using compute shader");
                NriImgui.text("derivatives, useful for LOD selection, filtering, and");
                NriImgui.text("spatial analysis in compute pipelines.");
                NriImgui.text("");
                NriImgui.text(this.useLinear ? "Derivative groups: linear (4 threads in a row)" : "Derivative groups: quads (2 x 2 threads)");
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The compute shader: 512 x 512 image with 8 x 8 local size = 64 x 64 workgroups; then the
        // image goes to the draw.
        recordCompute(commandBuffer: NriCommandBuffer) {
            const computeLayout = this.computeLayout;
            const computePipeline = this.computePipeline;
            const descriptorPool = this.descriptorPool;
            const computeSet = this.computeSet;
            const image = this.image;
            if (!computeLayout || !computePipeline || !descriptorPool || !computeSet || !image) {
                return;
            }
            if (this.imageDrawn) {
                commandBuffer.textureBarrier(image, NriTextureState.ShaderResource, NriTextureState.Storage);
            }
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setComputePipelineLayout(computeLayout);
            commandBuffer.setPipeline(computePipeline);
            commandBuffer.setComputeDescriptorSet(0, computeSet);
            commandBuffer.dispatch(IMAGE_WIDTH / TILE_SIZE, IMAGE_HEIGHT / TILE_SIZE, 1);
            commandBuffer.textureBarrier(image, NriTextureState.Storage, NriTextureState.ShaderResource);
            this.imageDrawn = true;
        }

        // The computed image as a fullscreen triangle (between NriCommandBuffer.beginRendering and
        // NriCommandBuffer.endRendering).
        recordDraw(commandBuffer: NriCommandBuffer) {
            const drawLayout = this.drawLayout;
            const drawPipeline = this.drawPipeline;
            const descriptorPool = this.descriptorPool;
            const drawSet = this.drawSet;
            if (!drawLayout || !drawPipeline || !descriptorPool || !drawSet) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(drawLayout);
            commandBuffer.setPipeline(drawPipeline);
            commandBuffer.setDescriptorSet(0, drawSet);
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

                // Record: the compute pass, the image over the frame, the overlay over it.
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
                this.destroyDescriptor(this.imageStorage);
                this.destroyDescriptor(this.imageView);
                this.destroyDescriptor(this.sampler);
                const image = this.image;
                if (image) {
                    image.destroy();
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    readbackBuffer.destroy();
                }
                this.destroyPipeline(this.computePipeline);
                this.destroyPipeline(this.drawPipeline);
                const computeLayout = this.computeLayout;
                if (computeLayout) {
                    computeLayout.destroy();
                }
                const drawLayout = this.drawLayout;
                if (drawLayout) {
                    drawLayout.destroy();
                }
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
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const computeShaderDerivatives = new ComputeShaderDerivatives(sample);
        // -linear: linear derivative groups; -noUI: no overlay.
        sample.addExampleOption("-linear");
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
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

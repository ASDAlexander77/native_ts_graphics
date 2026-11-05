/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { radians, perspective } from "../../core/matrix";
import { SampleView } from "../../core/vulkan_samples_camera";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace SeparateImageSamplerNri {
    // separate_image_sampler, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework
    // instead of Donut and NVRHI: the same shaders (separate_image_sampler.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws, with NRIFramework's ImGui for
    // the sample's overlay. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Separate Image Sampler";

    // The sample's texture (Vulkan-Samples' asset, fragment_shading_rate's copy: the KTX file and
    // its mip levels converted to DDS at build time, see VULKAN_SAMPLES_ASSETS_DIR in
    // CMakeLists.txt), loaded as sRGB as the framework loads color textures.
    const TEXTURE_PATH = "media/fragment_shading_rate/metalplate01_rgba.dds";

    // The quad's vertices: float3 position, float2 uv, float3 normal.
    const VERTEX_FLOATS = 8;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const QUAD_VERTICES = [
        1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0,
        -1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0,
        -1.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        1.0, -1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0,
    ];
    const QUAD_INDICES = [0, 1, 2, 2, 3, 0];

    // struct UBO { float4x4 projection, model; float4 viewPos; }; a queued frame's copy each, 256
    // bytes apart (constant buffer views' alignment).
    const UBO_PROJECTION = 0;
    const UBO_MODEL = 16;
    const UBO_VIEW_POS = 32;
    const UBO_FLOATS = 36;
    const UBO_STRIDE = 256;

    // The samplers to pick from.
    const SAMPLER_NAMES = "Linear filtering|Nearest filtering";

    // The sample's view: ApiVulkanSample's zoom and rotation (degrees), its projection.
    const ZOOM = -0.5;
    const ROTATION = [45.0, 0.0, 0.0];
    const FOV = 60.0;
    const Z_NEAR = 0.001;
    const Z_FAR = 256.0;

    // ApiVulkanSample's default_clear_color, and in the sRGB back buffer (0xBBGGRR).
    const CLEAR_COLOR = 0.002;
    const CLEAR_RGB = 0x070707;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // A frame in flight's own data: its descriptor set (its copy of the UBO).
    class QueuedFrame {
        constructor(public descriptorSet: NriDescriptorSet | null, public uboView: NriDescriptor | null) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does. The top corners are the
    // dark clear color; the textured quad (its image and sampler bound apart) colors about a fifth of
    // the frame, the texture's cyan glow in the middle.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        if ((pixels[0] & 0xFFFFFF) != CLEAR_RGB || (pixels[width - 1] & 0xFFFFFF) != CLEAR_RGB) {
            return "the top corners aren't the clear color";
        }
        const middle = pixels[Math.floor(height / 2) * width + Math.floor(width / 2)];
        if (((middle >> 16) & 0xFF) < 200 || ((middle >> 8) & 0xFF) < 180) {
            return "the middle isn't the texture's glow";
        }
        // Colored: the channels at least 61 apart.
        let colored = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (Math.max(Math.max(r, g), b) - Math.min(Math.min(r, g), b) >= 61) {
                colored++;
            }
        }
        const percent = 100.0 * colored / (width * height);
        console.log(`Colored: ${percent}% (${colored} of ${width * height} pixels)`);
        if (percent < 15.0 || percent > 30.0) {
            return `Colored: ${percent}% of the pixels, not 15% to 30%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' separate_image_sampler (as examples/separate_image_sampler.ts ports
    // it) to NRI: a textured quad seen at a grazing angle, its image and its sampler bound separately
    // (HLSL's textures and samplers always are), the sampler in a set of its own: picking linear or
    // nearest filtering in the UI swaps that set only. The left mouse button turns the quad, the
    // right one zooms, the middle one pans (ApiVulkanSample's controls).
    class SeparateImageSampler {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private layout: NriPipelineLayout | null = null;
        private pipeline: NriPipeline | null = null;
        private vertexBuffer: NriBuffer | null = null;
        private indexBuffer: NriBuffer | null = null;
        private uniformBuffer: NriBuffer | null = null;
        private texture: NriTexture | null = null;
        private textureView: NriDescriptor | null = null;
        // The samplers (linear, nearest), and their sets.
        private samplers: NriDescriptor[] = [];
        private samplerSets: NriDescriptorSet[] = [];
        private descriptorPool: NriDescriptorPool | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views' (the swap chain's).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private swapChainViewFormat: NriFormat = NriFormat.Unknown;

        // The sample's view and setting: the sampler in use (0 linear, 1 nearest; -nearest: 1 at
        // first).
        private view: SampleView = new SampleView(ZOOM, ROTATION);
        selectedSampler: int = 0;
        // The mouse, as ApiVulkanSample sees it: its position (summed from its moves) and buttons.
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;
        private buttons: boolean[] = [false, false, false];
        // -noUI: no overlay.
        noUI: boolean = false;

        // Upload buffer.
        private ubo: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
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

            let result = this.sample.run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
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

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;

            // The depth buffer: D32, cleared to 0 (the sample's reversed depth).
            if (!this.createDepth(device)) {
                return 0;
            }

            // The layout: set 0 the UBO (b0, both stages) and the texture (t0); set 1 the sampler (s0,
            // space 1).
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(1, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const layout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The sample's pipeline: separate_image_sampler.hlsl's shaders, as compiled for the Donut
            // example; no culling, depth tested (greater) and written.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/separate_image_sampler/${folder}/separate_image_sampler`;
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_quad_vs.bin`, "quad_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_quad_ps.bin`, "quad_ps") != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, 12);
            desc.setColor(viewFormat, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            if (loaded) {
                this.pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            if (!this.pipeline) {
                console.log("Cannot load the separate image sampler shaders");
                return 0;
            }

            // The quad and the texture.
            const vertices = QUAD_VERTICES.map((v): f32 => v);
            const indices = QUAD_INDICES.map((v): int => v);
            this.vertexBuffer = device.createUploadedBuffer(this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            this.indexBuffer = device.createUploadedBufferFromInts(this.queue, Ref(indices[0]), indices.length * 4, NriBufferUsage.IndexBuffer);
            const texture = device.loadTexture(this.queue, TEXTURE_PATH, 1);
            this.texture = texture;
            if (!texture) {
                console.log("Cannot load the texture: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            this.textureView = texture.createView(texture.getFormat());

            // A queued frame's UBO copy each, in its own descriptor set; the samplers' sets.
            const uniformBuffer = device.createHostBuffer(queuedFrameNum * UBO_STRIDE, NriBufferUsage.ConstantBuffer);
            this.uniformBuffer = uniformBuffer;
            const descriptorPool = device.createDescriptorPool(queuedFrameNum + 2, 2, queuedFrameNum, queuedFrameNum, 0, 0);
            this.descriptorPool = descriptorPool;
            const textureView = this.textureView;
            if (!uniformBuffer || !descriptorPool || !textureView) {
                console.log("Cannot create the descriptors");
                return 0;
            }

            // The sample's setup_samplers: repeating, linear between levels, the device's widest
            // anisotropic filtering; linear or nearest within a level. A set of each.
            const anisotropy = device.getMaxSamplerAnisotropy();
            for (let linear = 1; linear >= 0; linear--) {
                const sampler = device.createSamplerWithMipFilter(linear == 1 ? NriFilter.Linear : NriFilter.Nearest, NriFilter.Linear,
                    NriAddressMode.Repeat, anisotropy);
                const samplerSet = descriptorPool.allocateDescriptorSet(layout, 1, 0);
                if (!sampler || !samplerSet) {
                    console.log("Cannot create the samplers");
                    return 0;
                }
                samplerSet.updateDescriptor(0, 0, sampler);
                this.samplers.push(sampler);
                this.samplerSets.push(samplerSet);
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const descriptorSet = descriptorPool.allocateDescriptorSet(layout, 0, 0);
                const uboView = uniformBuffer.createConstantView(i * UBO_STRIDE, UBO_STRIDE);
                this.queuedFrames.push(new QueuedFrame(descriptorSet, uboView));
                if (!descriptorSet || !uboView) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                descriptorSet.updateDescriptor(0, 0, uboView);
                descriptorSet.updateDescriptor(1, 0, textureView);
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

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // ApiVulkanSample's mouse handling, unless the overlay has the mouse: the buttons' changes,
        // then the move.
        handleMouse() {
            const overlay = NriImgui.wantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = this.sample.isButtonPressed(button) != 0;
                if (pressed != this.buttons[button]) {
                    if (!pressed || !overlay) {
                        this.view.mouseButton(<MouseButton>button, <Action>(pressed ? 1 : 0));
                    }
                    this.buttons[button] = pressed;
                }
            }
            this.mouseX += this.sample.getMouseDeltaX();
            this.mouseY += this.sample.getMouseDeltaY();
            this.view.mouseMove(this.mouseX, this.mouseY);
        }

        // The sample's overlay.
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Separate Image Sampler", 1);
            NriImgui.pushItemWidth(110.0);
            if (NriImgui.collapsingHeader("Settings", 1) != 0) {
                this.selectedSampler = NriImgui.combo("Sampler", this.selectedSampler, SAMPLER_NAMES);
            }
            NriImgui.popItemWidth();
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The sample's update_uniform_buffers: its projection (clip y negated for Donut's shaders),
        // the quad's model view, the eye; into the queued frame's copy.
        writeUniforms(queuedFrameIndex: int) {
            const uniformBuffer = this.uniformBuffer;
            if (!uniformBuffer) {
                return;
            }
            const projection = perspective(radians(FOV), this.width / this.height, Z_NEAR, Z_FAR);
            const model = this.view.model();
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.ubo[UBO_MODEL + i] = model[i];
            }
            this.ubo[UBO_VIEW_POS] = 0.0;
            this.ubo[UBO_VIEW_POS + 1] = 0.0;
            this.ubo[UBO_VIEW_POS + 2] = -this.view.zoom;
            uniformBuffer.write(queuedFrameIndex * UBO_STRIDE, Ref(this.ubo[0]), UBO_FLOATS * 4);
        }

        // The quad (between NriCommandBuffer.beginRenderingWithDepth and NriCommandBuffer.endRendering).
        recordDraw(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const pipeline = this.pipeline;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = queuedFrame.descriptorSet;
            const vertexBuffer = this.vertexBuffer;
            const indexBuffer = this.indexBuffer;
            if (!layout || !pipeline || !descriptorPool || !descriptorSet || !vertexBuffer || !indexBuffer) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setDescriptorSet(0, descriptorSet);
            commandBuffer.setDescriptorSet(1, this.samplerSets[this.selectedSampler]);
            commandBuffer.setVertexBuffer(0, vertexBuffer, 0, VERTEX_SIZE);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
            commandBuffer.drawIndexed(QUAD_INDICES.length, 1, 0, 0, 0);
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The depth buffer at the swap chain's size.
        createDepth(device: NriDevice): boolean {
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return false;
            }
            this.depthAttachment = depthTexture.createDepthAttachmentView(NriFormat.D32_SFLOAT);
            return true;
        }

        destroyDepth() {
            const depthAttachment = this.depthAttachment;
            if (depthAttachment) {
                depthAttachment.destroy();
            }
            this.depthAttachment = null;
            const depthTexture = this.depthTexture;
            if (depthTexture) {
                depthTexture.destroy();
            }
            this.depthTexture = null;
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain and the depth buffer made
        // again at its size, once the GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            device.waitIdle();
            this.destroyDepth();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.createDepth(device);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();
            this.writeUniforms(queuedFrameIndex);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the scene, then the overlay over it.
                commandBuffer.begin();
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
                    commandBuffer.clearColor(CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
                    commandBuffer.clearDepth(0.0);
                    this.recordDraw(commandBuffer, queuedFrame);
                    commandBuffer.endRendering();
                }
                // (A pass of its own: the UI's pipeline has no depth attachment.)
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                    commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                    this.sample.drawImgui(commandBuffer, this.viewFormat);
                    commandBuffer.endRendering();
                }

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
                for (const queuedFrame of this.queuedFrames) {
                    this.destroyDescriptor(queuedFrame.uboView);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroyDescriptor(this.textureView);
                for (const sampler of this.samplers) {
                    sampler.destroy();
                }
                this.destroyDescriptor(this.depthAttachment);
                this.destroyTexture(this.texture);
                this.destroyTexture(this.depthTexture);
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.uniformBuffer);
                this.destroyBuffer(this.readbackBuffer);
                const pipeline = this.pipeline;
                if (pipeline) {
                    pipeline.destroy();
                }
                const layout = this.layout;
                if (layout) {
                    layout.destroy();
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

        destroyTexture(texture: NriTexture | null) {
            if (texture) {
                texture.destroy();
            }
        }

        destroyBuffer(buffer: NriBuffer | null) {
            if (buffer) {
                buffer.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const separateImageSampler = new SeparateImageSampler(sample);
        // -noUI: no overlay; -nearest: nearest filtering at first.
        sample.addExampleOption("-noUI");
        sample.useImgui();
        sample.addExampleOption("-nearest");
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-noUI") {
                separateImageSampler.noUI = true;
            } else if (arg == "-nearest") {
                separateImageSampler.selectedSampler = 1;
            }
        }
        return separateImageSampler.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return SeparateImageSamplerNri.main(argc, argv);
}

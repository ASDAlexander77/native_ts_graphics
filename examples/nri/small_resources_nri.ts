/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { MsvcRandom } from "../../core/random";
import { Nri, NriBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriMemory, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace SmallResourcesNri {
    // small_resources, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (small_resources.hlsl's, the D3D12SmallResources sample's),
    // through the NRI calls core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws. Each
    // texture is bound as a descriptor set of its own (the texture and the sampler), as Donut's
    // binding sets.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): the API can't run the example.
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Small Resources";

    // The sample's grid of textures, each 32 x 32 RGBA8.
    const GRID_WIDTH = 11;
    const GRID_HEIGHT = 7;
    const TEXTURE_COUNT = GRID_WIDTH * GRID_HEIGHT;
    const TEXTURE_WIDTH = 32;
    const TEXTURE_HEIGHT = 32;
    const TEXTURE_PIXEL_SIZE = 4;
    // The sample's vertex: position, texture coordinates.
    const VERTEX_STRIDE = 20;
    const MB = 1048576.0;
    const KB = 1024.0;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // A texture of the grid, its view and the descriptor set binding it.
    class GridTexture {
        constructor(public texture: NriTexture, public view: NriDescriptor, public descriptorSet: NriDescriptorSet) {
        }
    }

    // FormatMemoryUsage.
    function formatMemoryUsage(usage: number) {
        if (usage > MB) {
            return `${Math.fround(usage / MB).toFixed(1)} MB`;
        }
        if (usage > KB) {
            return `${Math.fround(usage / KB).toFixed(1)} KB`;
        }
        return `${usage} B`;
    }

    // GenerateTexture: a checkerboard of 8 x 8 cells, black and a random color.
    function generateTexture(random: MsvcRandom) {
        const r = random.next() & 0xff;
        const g = random.next() & 0xff;
        const b = random.next() & 0xff;
        const color = r | (g << 8) | (b << 16) | (0xff << 24);
        const black = 0xff << 24;
        const data: int[] = [];
        for (let y = 0; y < TEXTURE_HEIGHT; y++) {
            for (let x = 0; x < TEXTURE_WIDTH; x++) {
                // The sample's cells: 16 bytes (4 pixels) wide, 4 rows high.
                const i = Math.floor(x / 4);
                const j = Math.floor(y / 4);
                if (i % 2 == j % 2) {
                    data.push(black);
                } else {
                    data.push(color);
                }
            }
        }
        return data;
    }

    // -test: checks the last frame, read back. The corners are the blue clear color; the grid of
    // small textures covers about 76% of the frame, 58% colored.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const background = 0x663300;
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != background) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 0, 51, 102`;
            }
        }
        // Colored: channels at least 61 apart (not the blue background, nor the black cells).
        let colored = 0;
        let textures = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            if (p != background) {
                textures++;
            }
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            const high = Math.max(Math.max(r, g), b);
            const low = Math.min(Math.min(r, g), b);
            if (high - low >= 61) {
                colored++;
            }
        }
        const total = width * height;
        const coloredPercent = 100.0 * colored / total;
        const texturesPercent = 100.0 * textures / total;
        console.log(`Colored: ${coloredPercent}% (${colored} of ${total} pixels)`);
        console.log(`Textures: ${texturesPercent}% (${textures} of ${total} pixels)`);
        if (coloredPercent < 45.0 || coloredPercent > 70.0) {
            return `Colored: ${coloredPercent}% of the pixels, not 45% to 70%`;
        }
        if (texturesPercent < 65.0 || texturesPercent > 85.0) {
            return `Textures: ${texturesPercent}% of the pixels, not 65% to 85%`;
        }
        return "";
    }

    // Port of DirectX-Graphics-Samples' D3D12SmallResources (as examples/small_resources.ts ports
    // it) to NRI: 77 small (32 x 32) checkerboard textures drawn in a grid, either placed in one
    // allocation at their own alignment (D3D12: the 4 KB small resource alignment) or committed
    // (64 KB each on D3D12); Space switches between the two, the window title shows the resource
    // type and the device memory in use.
    class SmallResources {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        // The swap chain textures' format.
        private swapChainFormat: NriFormat = 0;
        private pipelineLayout: NriPipelineLayout | null = null;
        private pipeline: NriPipeline | null = null;
        private vertexBuffer: NriBuffer | null = null;
        private sampler: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private textures: GridTexture[] = [];
        // The placed textures' memory, if they're placed.
        private textureMemory: NriMemory | null = null;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize on D3D11 ("" otherwise).
        private unsupportedReason: string = "";

        usePlacedResources: boolean = true;

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
            // Placed textures need D3D12 or Vulkan (and the Donut example's shaders have no DXBC).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "The Small Resources example can only run on D3D12 or Vulkan";
                return 0;
            }
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()}), a placed 32 x 32 RGBA8 texture takes ${device.getPlacedTextureSize(TEXTURE_WIDTH, TEXTURE_HEIGHT, NriFormat.RGBA8_UNORM)} bytes`);

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // Swap chain: the sample's R8G8B8A8_UNORM back buffers, rendered into as they are.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, false);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);

            // The root signature: a descriptor table of the texture (t0) and the sampler (s0), for the
            // pixel shader, as one descriptor set.
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.pipelineLayout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }
            this.descriptorPool = device.createDescriptorPool(TEXTURE_COUNT, TEXTURE_COUNT, 0, TEXTURE_COUNT, 0, 0);
            // The sample's static sampler: linear, wrapping.
            this.sampler = device.createSampler(NriFilter.Linear, NriAddressMode.Repeat, 1);

            // LoadAssets: a quad per texture, on a grid centered on the screen (the window's aspect
            // ratio applied to y), in float as the sample's.
            const aspectRatio = Math.fround(1280.0 / 720.0);
            const offsetX = Math.fround(0.15);
            const marginX = Math.fround(offsetX / 10.0);
            const startX = Math.fround(Math.fround(Math.fround(GRID_WIDTH / 2.0) * -Math.fround(offsetX + marginX)) + Math.fround(marginX / 2.0));
            const offsetY = Math.fround(offsetX * aspectRatio);
            const marginY = Math.fround(offsetY / 10.0);
            let y = Math.fround(Math.fround(Math.fround(GRID_HEIGHT / 2.0) * Math.fround(offsetY + marginY)) - Math.fround(marginY / 2.0));
            const vertices: f32[] = [];
            for (let row = 0; row < GRID_HEIGHT; row++) {
                let x = startX;
                for (let column = 0; column < GRID_WIDTH; column++) {
                    const right = Math.fround(x + offsetX);
                    const bottom = Math.fround(y - offsetY);
                    const quad: number[] = [
                        x, bottom, 0.0, 0.0, 0.0,
                        x, y, 0.0, 0.0, 1.0,
                        right, bottom, 0.0, 1.0, 0.0,
                        right, y, 0.0, 1.0, 1.0,
                    ];
                    for (const value of quad) {
                        vertices.push(value);
                    }
                    x = Math.fround(x + Math.fround(offsetX + marginX));
                }
                y = Math.fround(y - Math.fround(offsetY + marginY));
            }
            this.vertexBuffer = device.createUploadedBuffer(this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            if (!this.vertexBuffer) {
                console.log("Cannot create the vertex buffer");
                return 0;
            }

            if (!this.createTextures(device, pipelineLayout)) {
                console.log("Cannot create the textures");
                return 0;
            }

            // Pipeline: small_resources.hlsl's shaders, as compiled for the Donut example; quads as
            // triangle strips.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/small_resources/${folder}/small_resources`;
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_VSMain.bin`, "VSMain") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_PSMain.bin`, "PSMain") != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, 12);
            desc.setTopology(NriTopology.TriangleStrip);
            desc.setColor(format, NriColorWrite.RGBA);
            if (loaded) {
                this.pipeline = device.createPipelineFromDesc(pipelineLayout, desc);
            }
            desc.destroy();
            if (!this.pipeline) {
                console.log("Cannot load the small resources shaders");
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

        releaseTextures() {
            for (const gridTexture of this.textures) {
                gridTexture.view.destroy();
                gridTexture.texture.destroy();
            }
            this.textures = [];
            const textureMemory = this.textureMemory;
            if (textureMemory) {
                textureMemory.free();
                this.textureMemory = null;
            }
            const descriptorPool = this.descriptorPool;
            if (descriptorPool) {
                descriptorPool.reset();
            }
        }

        // CreateTextures: placed in one allocation, or committed; each with its descriptor set.
        createTextures(device: NriDevice, pipelineLayout: NriPipelineLayout) {
            this.releaseTextures();
            const descriptorPool = this.descriptorPool;
            const sampler = this.sampler;
            if (!descriptorPool || !sampler) {
                return false;
            }
            let placedSize = 0.0;
            if (this.usePlacedResources) {
                placedSize = device.getPlacedTextureSize(TEXTURE_WIDTH, TEXTURE_HEIGHT, NriFormat.RGBA8_UNORM);
                this.textureMemory = device.allocateTextureMemory(TEXTURE_COUNT * placedSize, TEXTURE_WIDTH, TEXTURE_HEIGHT,
                    NriFormat.RGBA8_UNORM);
            }

            // Colors are random, the same for both kinds of resources.
            const random = new MsvcRandom(100);
            for (let n = 0; n < TEXTURE_COUNT; n++) {
                let texture: NriTexture | null = null;
                const textureMemory = this.textureMemory;
                if (textureMemory) {
                    texture = device.createPlacedTexture(textureMemory, n * placedSize, TEXTURE_WIDTH, TEXTURE_HEIGHT, NriFormat.RGBA8_UNORM);
                } else {
                    texture = device.createCommittedTexture(TEXTURE_WIDTH, TEXTURE_HEIGHT, NriFormat.RGBA8_UNORM);
                }
                if (!texture) {
                    return false;
                }
                const data = generateTexture(random);
                this.queue.uploadTexture(texture, Ref(data[0]), TEXTURE_WIDTH * TEXTURE_PIXEL_SIZE);
                const view = texture.createView(NriFormat.RGBA8_UNORM);
                const descriptorSet = descriptorPool.allocateDescriptorSet(pipelineLayout, 0, 0);
                if (!descriptorSet) {
                    view.destroy();
                    texture.destroy();
                    return false;
                }
                descriptorSet.updateDescriptor(0, 0, view);
                descriptorSet.updateDescriptor(1, 0, sampler);
                this.textures.push(new GridTexture(texture, view, descriptorSet));
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocator; Space switches between
        // placed and committed textures (outside a frame: after the GPU is done with the old ones).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);

            const device = this.device;
            const pipelineLayout = this.pipelineLayout;
            if (device) {
                if (pipelineLayout) {
                    if (this.sample.isKeyToggled(NriKey.Space) != 0) {
                        device.waitIdle();
                        this.usePlacedResources = !this.usePlacedResources;
                        this.createTextures(device, pipelineLayout);
                    }
                    // OnRender's title: the resource type and the device memory in use.
                    const resourceType = this.usePlacedResources ? "Placed" : "Committed";
                    this.sample.setWindowTitle(`${WINDOW_TITLE}: [ResourceType: ${resourceType}] - Memory Used: ${formatMemoryUsage(device.getMemoryUsage())}`);
                }
            }
        }

        // The swap chain's size and formats (its views in the textures' format).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
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

        // PopulateCommandList: the grid, a quad (triangle strip) per texture.
        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record
                commandBuffer.begin();
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                commandBuffer.clearColor(0.0, 0.2, 0.4, 1.0);
                const pipelineLayout = this.pipelineLayout;
                const pipeline = this.pipeline;
                const vertexBuffer = this.vertexBuffer;
                const descriptorPool = this.descriptorPool;
                if (pipelineLayout) {
                    if (pipeline) {
                        if (vertexBuffer) {
                            if (descriptorPool) {
                                commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
                                commandBuffer.setScissor(0, 0, this.width, this.height);
                                commandBuffer.setDescriptorPool(descriptorPool);
                                commandBuffer.setPipelineLayout(pipelineLayout);
                                commandBuffer.setPipeline(pipeline);
                                for (let n = 0; n < this.textures.length; n++) {
                                    commandBuffer.setDescriptorSet(0, this.textures[n].descriptorSet);
                                    commandBuffer.setVertexBuffer(0, vertexBuffer, n * 4 * VERTEX_STRIDE, VERTEX_STRIDE);
                                    commandBuffer.draw(4, 1, 0, 0);
                                }
                            }
                        }
                    }
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
                this.releaseTextures();
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                const sampler = this.sampler;
                if (sampler) {
                    sampler.destroy();
                }
                const pipeline = this.pipeline;
                if (pipeline) {
                    pipeline.destroy();
                }
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    pipelineLayout.destroy();
                }
                const vertexBuffer = this.vertexBuffer;
                if (vertexBuffer) {
                    vertexBuffer.destroy();
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
        const smallResources = new SmallResources(sample);
        // -committed: start with committed resources (the sample starts with placed ones).
        sample.addExampleOption("-committed");
        for (let i = 1; i < argc; i++) {
            if (Nri.getArg(argc, argv, i) == "-committed") {
                smallResources.usePlacedResources = false;
            }
        }
        return smallResources.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return SmallResourcesNri.main(argc, argv);
}

/// <reference path="../../core/nri/nri_interop.d.ts" />
import { MsvcRandom } from "../../core/random";

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

    // A texture of the grid, its view and the descriptor set binding it.
    class GridTexture {
        constructor(public texture: NriTextureHandle, public view: NriDescriptorHandle, public descriptorSet: NriDescriptorSetHandle) {
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
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private pipelineLayout: NriPipelineLayoutHandle | null = null;
        private pipeline: NriPipelineHandle | null = null;
        private vertexBuffer: NriBufferHandle | null = null;
        private sampler: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private textures: GridTexture[] = [];
        // The placed textures' memory, if they're placed.
        private textureMemory: NriMemoryHandle | null = null;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize on D3D11 ("" otherwise).
        private unsupportedReason: string = "";

        usePlacedResources: boolean = true;

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
            // Placed textures need D3D12 or Vulkan (and the Donut example's shaders have no DXBC).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "The Small Resources example can only run on D3D12 or Vulkan";
                return 0;
            }
            console.log(`Renderer: ${Nri_GetGraphicsAPIString(graphicsAPI)} (${Nri_GetAdapterName(device)}), a placed 32 x 32 RGBA8 texture takes ${Nri_GetPlacedTextureSize(device, TEXTURE_WIDTH, TEXTURE_HEIGHT, NriFormat.RGBA8_UNORM)} bytes`);

            this.queue = Nri_GetGraphicsQueue(device);
            this.frameFence = Nri_CreateFence(device, 0);
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.test = Nri_IsTest(this.sample) != 0;

            // Swap chain: the sample's R8G8B8A8_UNORM back buffers, rendered into as they are.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, queuedFrameNum + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(this.swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, format),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }

            // Queued frames
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator)));
            }

            // The root signature: a descriptor table of the texture (t0) and the sampler (s0), for the
            // pixel shader, as one descriptor set.
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.pipelineLayout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }
            this.descriptorPool = Nri_CreateDescriptorPool(device, TEXTURE_COUNT, TEXTURE_COUNT, 0, TEXTURE_COUNT, 0, 0);
            // The sample's static sampler: linear, wrapping.
            this.sampler = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.Repeat, 1);

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
            this.vertexBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
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
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_VSMain.bin`, "VSMain") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_PSMain.bin`, "PSMain") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "TEXCOORD", NriFormat.RG32_SFLOAT, 12);
            Nri_PipelineDescSetTopology(desc, NriTopology.TriangleStrip);
            Nri_PipelineDescSetColor(desc, format, NriColorWrite.RGBA);
            if (loaded) {
                this.pipeline = Nri_CreatePipelineFromDesc(device, pipelineLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            if (!this.pipeline) {
                console.log("Cannot load the small resources shaders");
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

        releaseTextures() {
            for (const gridTexture of this.textures) {
                Nri_DestroyDescriptor(gridTexture.view);
                Nri_DestroyTexture(gridTexture.texture);
            }
            this.textures = [];
            const textureMemory = this.textureMemory;
            if (textureMemory) {
                Nri_FreeMemory(textureMemory);
                this.textureMemory = null;
            }
            const descriptorPool = this.descriptorPool;
            if (descriptorPool) {
                Nri_ResetDescriptorPool(descriptorPool);
            }
        }

        // CreateTextures: placed in one allocation, or committed; each with its descriptor set.
        createTextures(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle) {
            this.releaseTextures();
            const descriptorPool = this.descriptorPool;
            const sampler = this.sampler;
            if (!descriptorPool || !sampler) {
                return false;
            }
            let placedSize = 0.0;
            if (this.usePlacedResources) {
                placedSize = Nri_GetPlacedTextureSize(device, TEXTURE_WIDTH, TEXTURE_HEIGHT, NriFormat.RGBA8_UNORM);
                this.textureMemory = Nri_AllocateTextureMemory(device, TEXTURE_COUNT * placedSize, TEXTURE_WIDTH, TEXTURE_HEIGHT,
                    NriFormat.RGBA8_UNORM);
            }

            // Colors are random, the same for both kinds of resources.
            const random = new MsvcRandom(100);
            for (let n = 0; n < TEXTURE_COUNT; n++) {
                let texture: NriTextureHandle | null = null;
                const textureMemory = this.textureMemory;
                if (textureMemory) {
                    texture = Nri_CreatePlacedTexture(device, textureMemory, n * placedSize, TEXTURE_WIDTH, TEXTURE_HEIGHT, NriFormat.RGBA8_UNORM);
                } else {
                    texture = Nri_CreateCommittedTexture(device, TEXTURE_WIDTH, TEXTURE_HEIGHT, NriFormat.RGBA8_UNORM);
                }
                if (!texture) {
                    return false;
                }
                const data = generateTexture(random);
                Nri_UploadTexture(this.queue, texture, Ref(data[0]), TEXTURE_WIDTH * TEXTURE_PIXEL_SIZE);
                const view = Nri_CreateTextureView(texture, NriFormat.RGBA8_UNORM);
                const descriptorSet = Nri_AllocateDescriptorSet(descriptorPool, pipelineLayout, 0, 0);
                if (!descriptorSet) {
                    Nri_DestroyDescriptor(view);
                    Nri_DestroyTexture(texture);
                    return false;
                }
                Nri_UpdateDescriptor(descriptorSet, 0, 0, view);
                Nri_UpdateDescriptor(descriptorSet, 1, 0, sampler);
                this.textures.push(new GridTexture(texture, view, descriptorSet));
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocator; Space switches between
        // placed and committed textures (outside a frame: after the GPU is done with the old ones).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);

            const device = this.device;
            const pipelineLayout = this.pipelineLayout;
            if (device) {
                if (pipelineLayout) {
                    if (Nri_IsKeyToggled(this.sample, NriKey.Space) != 0) {
                        Nri_DeviceWaitIdle(device);
                        this.usePlacedResources = !this.usePlacedResources;
                        this.createTextures(device, pipelineLayout);
                    }
                    // OnRender's title: the resource type and the device memory in use.
                    const resourceType = this.usePlacedResources ? "Placed" : "Committed";
                    Nri_SetWindowTitle(this.sample, `${WINDOW_TITLE}: [ResourceType: ${resourceType}] - Memory Used: ${formatMemoryUsage(Nri_GetDeviceMemoryUsage(device))}`);
                }
            }
        }

        // PopulateCommandList: the grid, a quad (triangle strip) per texture.
        renderFrame(frameIndex: int) {
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
                Nri_CmdClearColor(commandBuffer, 0.0, 0.2, 0.4, 1.0);
                const pipelineLayout = this.pipelineLayout;
                const pipeline = this.pipeline;
                const vertexBuffer = this.vertexBuffer;
                const descriptorPool = this.descriptorPool;
                if (pipelineLayout) {
                    if (pipeline) {
                        if (vertexBuffer) {
                            if (descriptorPool) {
                                Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
                                Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
                                Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
                                Nri_CmdSetPipelineLayout(commandBuffer, pipelineLayout);
                                Nri_CmdSetPipeline(commandBuffer, pipeline);
                                for (let n = 0; n < this.textures.length; n++) {
                                    Nri_CmdSetDescriptorSet(commandBuffer, 0, this.textures[n].descriptorSet);
                                    Nri_CmdSetVertexBuffer(commandBuffer, 0, vertexBuffer, n * 4 * VERTEX_STRIDE, VERTEX_STRIDE);
                                    Nri_CmdDraw(commandBuffer, 4, 1, 0, 0);
                                }
                            }
                        }
                    }
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
                this.releaseTextures();
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                const sampler = this.sampler;
                if (sampler) {
                    Nri_DestroyDescriptor(sampler);
                }
                const pipeline = this.pipeline;
                if (pipeline) {
                    Nri_DestroyPipeline(pipeline);
                }
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    Nri_DestroyPipelineLayout(pipelineLayout);
                }
                const vertexBuffer = this.vertexBuffer;
                if (vertexBuffer) {
                    Nri_DestroyBuffer(vertexBuffer);
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
        const sample = Nri_CreateSample();
        const smallResources = new SmallResources(sample);
        // -committed: start with committed resources (the sample starts with placed ones).
        Nri_AddExampleOption(sample, "-committed");
        for (let i = 1; i < argc; i++) {
            if (Nri_GetArg(argc, argv, i) == "-committed") {
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

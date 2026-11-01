/// <reference path="../../core/nri/nri_interop.d.ts" />
import { matrixMultiply, matrixPerspectiveFovRH, matrixTranslation, matrixTranspose } from "../../core/directx_math";
import { SimpleCamera } from "../../core/simple_camera";

namespace BundlesNri {
    // bundles' scene, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (bundles.hlsl's, the D3D12Bundles sample's), through the NRI
    // calls core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws. NRI has no bundles (nor
    // secondary command buffers): the cities' draws, which the sample records once into a bundle,
    // are recorded into every frame's command buffer. SimpleCamera's keys are Donut's Key values
    // (declarations only: GLFW's key codes, as NRIFramework's).

    const WINDOW_TITLE = "NRI Example: Bundles";
    const DATA_FILE = "media/bundles/occcity.bin";

    // The sample's cities: 10 rows of 3, 8 units apart.
    const CITY_ROW_COUNT = 10;
    const CITY_COLUMN_COUNT = 3;
    const CITY_COUNT = CITY_ROW_COUNT * CITY_COLUMN_COUNT;
    const CITY_INTERVAL_X = 8.0;
    const CITY_INTERVAL_Z = -8.0;

    // occcity.h: the data file's parts. The city's diffuse texture (BC1, 1024 x 1024, its pitch
    // 2048 bytes) at 0; the vertices (position, normal, texture coordinates, tangent: 44 bytes)
    // and the 32-bit indices after it.
    const TEXTURE_SIZE = 1024;
    const TEXTURE_PITCH = 2048;
    const VERTEX_STRIDE = 44;
    const VERTEX_DATA_OFFSET = 524288;
    const VERTEX_DATA_SIZE = 820248;
    const INDEX_DATA_OFFSET = 1344536;
    const INDEX_DATA_SIZE = 74568;

    // SceneConstantBuffer: a city's model-view-projection matrix (transposed), padded to 256 bytes,
    // one after another in a constant buffer; a frame in flight's part holds every city's.
    const CONSTANTS_STRIDE = 256;
    const CONSTANTS_STRIDE_FLOATS = CONSTANTS_STRIDE / 4;
    const FRAME_CONSTANTS_SIZE = CITY_COUNT * CONSTANTS_STRIDE;

    // The sample's clear color, (0, 0.2, 0.4).
    const CLEAR_R = 0.0;
    const CLEAR_G = 0.2;
    const CLEAR_B = 0.4;

    // Test mode: the frames rendered, each 1/60 s.
    const TEST_FRAMES = 3;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): the API can't run the example.
    const TEST_SKIPPED = 77;

    // SimpleCamera's keys.
    const CAMERA_KEYS = [Key.W, Key.A, Key.S, Key.D, Key.Left, Key.Right, Key.Up, Key.Down];

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into, and the descriptor sets of its part of the constant
    // buffer (one per city: its constants, the texture, the sampler).
    class QueuedFrame {
        descriptorSets: NriDescriptorSetHandle[] = [];
        constantViews: NriDescriptorHandle[] = [];

        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // -test: checks the last frame, read back. The sky (the frame's top row) is the clear color; the
    // cities cover a good part of the frame, in both pipelines' colors: the city's texture as it is,
    // and filtered (red and blue at a quarter: green dominating).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const background = 0 | (51 << 8) | (102 << 16);
        for (let x = 0; x < width; x++) {
            const p = pixels[x] & 0xFFFFFF;
            if (p != background) {
                return `top row pixel ${x} is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not the clear color`;
            }
        }
        let covered = 0;
        let filtered = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            if (p == background) {
                continue;
            }
            covered++;
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (g > 2 * r + 8 && g > 2 * b + 8) {
                filtered++;
            }
        }
        const coverage = covered / (width * height);
        const filteredFraction = filtered / (width * height);
        console.log(`Coverage ${coverage}, filtered ${filteredFraction}`);
        if (coverage < 0.1) {
            return `the cities cover ${coverage} of the frame`;
        }
        if (filteredFraction < 0.05 || filteredFraction > coverage - 0.05) {
            return `${filteredFraction} of the frame is in the second pipeline's colors, of ${coverage} covered: not both pipelines`;
        }
        return "";
    }

    // Port of DirectX-Graphics-Samples' D3D12Bundles (as examples/bundles.ts ports it) to NRI: 30
    // copies of a city in 10 rows of 3, drawn with two pipelines taking turns (the second's pixel
    // shader filters out most of the red and blue), each city with constants of its own. As the
    // sample, into the swap chain's UNORM texture and a D32 depth buffer.
    class Bundles {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private pipelineLayout: NriPipelineLayoutHandle | null = null;
        private pipeline1: NriPipelineHandle | null = null;
        private pipeline2: NriPipelineHandle | null = null;
        private vertexBuffer: NriBufferHandle | null = null;
        private indexBuffer: NriBufferHandle | null = null;
        private diffuse: NriTextureHandle | null = null;
        private diffuseView: NriDescriptorHandle | null = null;
        private sampler: NriDescriptorHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize on D3D11 ("" otherwise).
        private unsupportedReason: string = "";

        private constants: f32[] = [];
        // The cities' model matrices (row vectors), set once.
        private modelMatrices: number[][] = [];
        private camera: SimpleCamera = new SimpleCamera();

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < CITY_COUNT * CONSTANTS_STRIDE_FLOATS; i++) {
                this.constants.push(0.0);
            }
            // The sample's camera: 8 right, 8 up and 30 back, at SimpleCamera's speeds.
            this.camera.init(8.0, 8.0, 30.0);
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

        // The sample's pipeline states: no culling, opaque, depth tested (less) and written, one of
        // the two pixel shaders.
        createPipeline(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle, shaders: string, ps: string, colorFormat: NriFormat) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_VSMain.bin`, "VSMain") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_${ps}.bin`, ps) != 0;
            }
            // The vertex shader reads the positions and texture coordinates of the 44-byte vertices.
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "TEXCOORD", NriFormat.RG32_SFLOAT, 24);
            Nri_PipelineDescSetColor(desc, colorFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Less, 1, 0);
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
            // The Donut example's shaders are DXIL and SPIR-V only.
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "The Bundles example can only run on D3D12 or Vulkan";
                return 0;
            }
            console.log(`Renderer: ${Nri_GetGraphicsAPIString(graphicsAPI)} (${Nri_GetAdapterName(device)})`);

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

            // The depth buffer: D32.
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return 0;
            }
            this.depthTexture = depthTexture;
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            // Queued frames
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator)));
            }

            // The sample's root signature: the city's CBV (b0), the texture's SRV (t0), the sampler
            // (s0), as one descriptor set.
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Vertex, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.pipelineLayout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            if (!this.loadAssets(device, pipelineLayout)) {
                return 0;
            }

            // Pipelines: bundles.hlsl's shaders, as compiled for the Donut example.
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/bundles/${folder}/bundles`;
            this.pipeline1 = this.createPipeline(device, pipelineLayout, shaders, "PSMain", format);
            this.pipeline2 = this.createPipeline(device, pipelineLayout, shaders, "PSAlt", format);
            if (!this.pipeline1 || !this.pipeline2) {
                console.log("Cannot load the bundles shaders");
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

        // LoadAssets: the city's mesh and diffuse texture from the data file, the cities' descriptor
        // sets (one per city per frame in flight) and positions (FrameResource::SetCityPositions; y
        // raised a little per city against z-fighting).
        loadAssets(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle) {
            const file = Nri_LoadFile(DATA_FILE);
            if (!file) {
                console.log(`Cannot load ${DATA_FILE} (the sample's data: build with DIRECTX_GRAPHICS_SAMPLES_DIR set)`);
                return false;
            }
            this.vertexBuffer = Nri_CreateUploadedBufferFromFile(device, this.queue, file, VERTEX_DATA_OFFSET, VERTEX_DATA_SIZE,
                NriBufferUsage.VertexBuffer);
            this.indexBuffer = Nri_CreateUploadedBufferFromFile(device, this.queue, file, INDEX_DATA_OFFSET, INDEX_DATA_SIZE,
                NriBufferUsage.IndexBuffer);
            const diffuse = Nri_CreateCommittedTexture(device, TEXTURE_SIZE, TEXTURE_SIZE, NriFormat.BC1_RGBA_UNORM);
            this.diffuse = diffuse;
            let uploaded = false;
            if (diffuse) {
                uploaded = Nri_UploadTextureFromFile(this.queue, diffuse, file, 0, TEXTURE_PITCH) != 0;
            }
            Nri_DestroyFile(file);
            if (!this.vertexBuffer || !this.indexBuffer || !diffuse || !uploaded) {
                console.log(`Cannot create the city from ${DATA_FILE}`);
                return false;
            }
            this.diffuseView = Nri_CreateTextureView(diffuse, NriFormat.BC1_RGBA_UNORM);

            // The sample's sampler: linear, wrapping.
            const sampler = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.Repeat, 1);
            this.sampler = sampler;
            const queuedFrameNum = this.queuedFrames.length;
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * FRAME_CONSTANTS_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const setNum = queuedFrameNum * CITY_COUNT;
            const descriptorPool = Nri_CreateDescriptorPool(device, setNum, setNum, setNum, setNum, 0, 0);
            this.descriptorPool = descriptorPool;
            const diffuseView = this.diffuseView;
            if (!sampler || !constantBuffer || !descriptorPool || !diffuseView) {
                console.log("Cannot create the cities' descriptors");
                return false;
            }
            for (let f = 0; f < queuedFrameNum; f++) {
                const queuedFrame = this.queuedFrames[f];
                for (let i = 0; i < CITY_COUNT; i++) {
                    const constantView = Nri_CreateConstantBufferView(constantBuffer, f * FRAME_CONSTANTS_SIZE + i * CONSTANTS_STRIDE, CONSTANTS_STRIDE);
                    const descriptorSet = Nri_AllocateDescriptorSet(descriptorPool, pipelineLayout, 0, 0);
                    if (!constantView || !descriptorSet) {
                        console.log("Cannot create the cities' descriptors");
                        return false;
                    }
                    Nri_UpdateDescriptor(descriptorSet, 0, 0, constantView);
                    Nri_UpdateDescriptor(descriptorSet, 1, 0, diffuseView);
                    Nri_UpdateDescriptor(descriptorSet, 2, 0, sampler);
                    queuedFrame.constantViews.push(constantView);
                    queuedFrame.descriptorSets.push(descriptorSet);
                }
            }

            for (let i = 0; i < CITY_ROW_COUNT; i++) {
                const cityOffsetZ = Math.fround(i * CITY_INTERVAL_Z);
                for (let j = 0; j < CITY_COLUMN_COUNT; j++) {
                    const cityOffsetX = Math.fround(j * CITY_INTERVAL_X);
                    const cityOffsetY = Math.fround(Math.fround(0.02) * (i * CITY_COLUMN_COUNT + j));
                    this.modelMatrices.push(matrixTranslation(cityOffsetX, cityOffsetY, cityOffsetZ));
                }
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // OnUpdate: the camera (its keys), and UpdateConstantBuffers: each city's
        // model-view-projection matrix, into this frame's part of the constant buffer.
        update(frameOffset: int, constantBuffer: NriBufferHandle) {
            for (const key of CAMERA_KEYS) {
                this.camera.onKey(key, Nri_IsKeyPressed(this.sample, key) != 0);
            }
            // In test mode 1/60 second a frame, as Donut's test mode.
            this.camera.update(Math.fround(this.test ? 1.0 / 60.0 : Nri_GetFrameTime(this.sample)));

            const view = this.camera.viewMatrix();
            const projection = matrixPerspectiveFovRH(Math.fround(0.8), Math.fround(this.width / this.height), 1.0, 1000.0);
            for (let i = 0; i < CITY_COUNT; i++) {
                // model * view * projection, as the sample multiplies them: (model * view) * projection.
                const mvp = matrixTranspose(matrixMultiply(matrixMultiply(this.modelMatrices[i], view), projection));
                for (let k = 0; k < 16; k++) {
                    this.constants[i * CONSTANTS_STRIDE_FLOATS + k] = mvp[k];
                }
            }
            Nri_WriteBuffer(constantBuffer, frameOffset, Ref(this.constants[0]), FRAME_CONSTANTS_SIZE);
        }

        // FrameResource::PopulateCommandList's bundle: the cities, the pipeline alternating from city
        // to city (recorded every frame: NRI has no bundles).
        recordCities(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const pipelineLayout = this.pipelineLayout;
            const pipeline1 = this.pipeline1;
            const pipeline2 = this.pipeline2;
            const vertexBuffer = this.vertexBuffer;
            const indexBuffer = this.indexBuffer;
            const descriptorPool = this.descriptorPool;
            if (!pipelineLayout || !pipeline1 || !pipeline2) {
                return;
            }
            if (!vertexBuffer || !indexBuffer || !descriptorPool) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, pipelineLayout);
            Nri_CmdSetIndexBuffer(commandBuffer, indexBuffer, 0, NriIndexType.UInt32);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, vertexBuffer, 0, VERTEX_STRIDE);
            let usePipeline1 = true;
            for (let i = 0; i < CITY_COUNT; i++) {
                Nri_CmdSetPipeline(commandBuffer, usePipeline1 ? pipeline1 : pipeline2);
                usePipeline1 = !usePipeline1;
                Nri_CmdSetDescriptorSet(commandBuffer, 0, queuedFrame.descriptorSets[i]);
                Nri_CmdDrawIndexed(commandBuffer, INDEX_DATA_SIZE / 4, 1, 0, 0, 0);
            }
        }

        // PopulateCommandList: clear, the cities.
        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            const constantBuffer = this.constantBuffer;
            if (constantBuffer) {
                this.update(queuedFrameIndex * FRAME_CONSTANTS_SIZE, constantBuffer);
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                const depthAttachment = this.depthAttachment;
                if (depthAttachment) {
                    Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                    Nri_CmdClearColor(commandBuffer, CLEAR_R, CLEAR_G, CLEAR_B, 1.0);
                    Nri_CmdClearDepth(commandBuffer, 1.0);
                    this.recordCities(commandBuffer, queuedFrame);
                    Nri_CmdEndRendering(commandBuffer);
                }

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
                    for (const constantView of queuedFrame.constantViews) {
                        Nri_DestroyDescriptor(constantView);
                    }
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
                const pipeline1 = this.pipeline1;
                if (pipeline1) {
                    Nri_DestroyPipeline(pipeline1);
                }
                const pipeline2 = this.pipeline2;
                if (pipeline2) {
                    Nri_DestroyPipeline(pipeline2);
                }
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    Nri_DestroyPipelineLayout(pipelineLayout);
                }
                const sampler = this.sampler;
                if (sampler) {
                    Nri_DestroyDescriptor(sampler);
                }
                const diffuseView = this.diffuseView;
                if (diffuseView) {
                    Nri_DestroyDescriptor(diffuseView);
                }
                const diffuse = this.diffuse;
                if (diffuse) {
                    Nri_DestroyTexture(diffuse);
                }
                const constantBuffer = this.constantBuffer;
                if (constantBuffer) {
                    Nri_DestroyBuffer(constantBuffer);
                }
                const vertexBuffer = this.vertexBuffer;
                if (vertexBuffer) {
                    Nri_DestroyBuffer(vertexBuffer);
                }
                const indexBuffer = this.indexBuffer;
                if (indexBuffer) {
                    Nri_DestroyBuffer(indexBuffer);
                }
                const depthAttachment = this.depthAttachment;
                if (depthAttachment) {
                    Nri_DestroyDescriptor(depthAttachment);
                }
                const depthTexture = this.depthTexture;
                if (depthTexture) {
                    Nri_DestroyTexture(depthTexture);
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
        const bundles = new Bundles(Nri_CreateSample());
        return bundles.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return BundlesNri.main(argc, argv);
}

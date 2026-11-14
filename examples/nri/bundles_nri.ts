/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { matrixMultiply, matrixPerspectiveFovRH, matrixTranslation, matrixTranspose } from "../../core/directx_math";
import { SimpleCamera } from "../../core/simple_camera";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriFile, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

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

    // A frame in flight's own data: the descriptor sets of its part of the constant
    // buffer (one per city: its constants, the texture, the sampler).
    class QueuedFrame {
        descriptorSets: NriDescriptorSet[] = [];
        constantViews: NriDescriptor[] = [];
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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private pipelineLayout: NriPipelineLayout | null = null;
        private pipeline1: NriPipeline | null = null;
        private pipeline2: NriPipeline | null = null;
        private vertexBuffer: NriBuffer | null = null;
        private indexBuffer: NriBuffer | null = null;
        private diffuse: NriTexture | null = null;
        private diffuseView: NriDescriptor | null = null;
        private sampler: NriDescriptor | null = null;
        private constantBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format (the swap chain's).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        // Set by initialize on D3D11 ("" otherwise).
        private unsupportedReason: string = "";

        private constants: f32[] = [];
        // The cities' model matrices (row vectors), set once.
        private modelMatrices: number[][] = [];
        private camera: SimpleCamera = new SimpleCamera();

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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

        // The sample's pipeline states: no culling, opaque, depth tested (less) and written, one of
        // the two pixel shaders.
        createPipeline(device: NriDevice, pipelineLayout: NriPipelineLayout, shaders: string, ps: string, colorFormat: NriFormat) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_VSMain.bin`, "VSMain") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_${ps}.bin`, ps) != 0;
            }
            // The vertex shader reads the positions and texture coordinates of the 44-byte vertices.
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, 24);
            desc.setColor(colorFormat, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.Less, 1, 0);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(pipelineLayout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        initialize(graphicsAPI: NriGraphicsAPI): int {
            const device = this.sample.createDevice(graphicsAPI);
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
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // Swap chain: the sample's R8G8B8A8_UNORM back buffers, rendered into as they are.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, false);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;

            // The depth buffer: D32.
            if (!this.createDepth(device)) {
                return 0;
            }

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                this.queuedFrames.push(new QueuedFrame());
            }

            // The sample's root signature: the city's CBV (b0), the texture's SRV (t0), the sampler
            // (s0), as one descriptor set.
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Vertex, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.pipelineLayout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
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
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // LoadAssets: the city's mesh and diffuse texture from the data file, the cities' descriptor
        // sets (one per city per frame in flight) and positions (FrameResource::SetCityPositions; y
        // raised a little per city against z-fighting).
        loadAssets(device: NriDevice, pipelineLayout: NriPipelineLayout) {
            const file = NriFile.load(DATA_FILE);
            if (!file) {
                console.log(`Cannot load ${DATA_FILE} (the sample's data: build with DIRECTX_GRAPHICS_SAMPLES_DIR set)`);
                return false;
            }
            this.vertexBuffer = device.createUploadedBufferFromFile(this.queue, file, VERTEX_DATA_OFFSET, VERTEX_DATA_SIZE,
                NriBufferUsage.VertexBuffer);
            this.indexBuffer = device.createUploadedBufferFromFile(this.queue, file, INDEX_DATA_OFFSET, INDEX_DATA_SIZE,
                NriBufferUsage.IndexBuffer);
            const diffuse = device.createCommittedTexture(TEXTURE_SIZE, TEXTURE_SIZE, NriFormat.BC1_RGBA_UNORM);
            this.diffuse = diffuse;
            let uploaded = false;
            if (diffuse) {
                uploaded = this.queue.uploadTextureFromFile(diffuse, file, 0, TEXTURE_PITCH) != 0;
            }
            file.destroy();
            if (!this.vertexBuffer || !this.indexBuffer || !diffuse || !uploaded) {
                console.log(`Cannot create the city from ${DATA_FILE}`);
                return false;
            }
            this.diffuseView = diffuse.createView(NriFormat.BC1_RGBA_UNORM);

            // The sample's sampler: linear, wrapping.
            const sampler = device.createSampler(NriFilter.Linear, NriAddressMode.Repeat, 1);
            this.sampler = sampler;
            const queuedFrameNum = this.queuedFrames.length;
            const constantBuffer = device.createHostBuffer(queuedFrameNum * FRAME_CONSTANTS_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const setNum = queuedFrameNum * CITY_COUNT;
            const descriptorPool = device.createDescriptorPool(setNum, setNum, setNum, setNum, 0, 0);
            this.descriptorPool = descriptorPool;
            const diffuseView = this.diffuseView;
            if (!sampler || !constantBuffer || !descriptorPool || !diffuseView) {
                console.log("Cannot create the cities' descriptors");
                return false;
            }
            for (let f = 0; f < queuedFrameNum; f++) {
                const queuedFrame = this.queuedFrames[f];
                for (let i = 0; i < CITY_COUNT; i++) {
                    const constantView = constantBuffer.createConstantView(f * FRAME_CONSTANTS_SIZE + i * CONSTANTS_STRIDE, CONSTANTS_STRIDE);
                    const descriptorSet = descriptorPool.allocateDescriptorSet(pipelineLayout, 0, 0);
                    if (!constantView || !descriptorSet) {
                        console.log("Cannot create the cities' descriptors");
                        return false;
                    }
                    descriptorSet.updateDescriptor(0, 0, constantView);
                    descriptorSet.updateDescriptor(1, 0, diffuseView);
                    descriptorSet.updateDescriptor(2, 0, sampler);
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
            this.frames.wait(frameIndex);
        }

        // OnUpdate: the camera (its keys), and UpdateConstantBuffers: each city's
        // model-view-projection matrix, into this frame's part of the constant buffer.
        update(frameOffset: int, constantBuffer: NriBuffer) {
            for (const key of CAMERA_KEYS) {
                this.camera.onKey(key, this.sample.isKeyPressed(key) != 0);
            }
            // In test mode 1/60 second a frame, as Donut's test mode.
            this.camera.update(Math.fround(this.test ? 1.0 / 60.0 : this.sample.getFrameTime()));

            const view = this.camera.viewMatrix();
            const projection = matrixPerspectiveFovRH(Math.fround(0.8), Math.fround(this.width / this.height), 1.0, 1000.0);
            for (let i = 0; i < CITY_COUNT; i++) {
                // model * view * projection, as the sample multiplies them: (model * view) * projection.
                const mvp = matrixTranspose(matrixMultiply(matrixMultiply(this.modelMatrices[i], view), projection));
                for (let k = 0; k < 16; k++) {
                    this.constants[i * CONSTANTS_STRIDE_FLOATS + k] = mvp[k];
                }
            }
            constantBuffer.write(frameOffset, Ref(this.constants[0]), FRAME_CONSTANTS_SIZE);
        }

        // FrameResource::PopulateCommandList's bundle: the cities, the pipeline alternating from city
        // to city (recorded every frame: NRI has no bundles).
        recordCities(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
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
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(pipelineLayout);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
            commandBuffer.setVertexBuffer(0, vertexBuffer, 0, VERTEX_STRIDE);
            let usePipeline1 = true;
            for (let i = 0; i < CITY_COUNT; i++) {
                commandBuffer.setPipeline(usePipeline1 ? pipeline1 : pipeline2);
                usePipeline1 = !usePipeline1;
                commandBuffer.setDescriptorSet(0, queuedFrame.descriptorSets[i]);
                commandBuffer.drawIndexed(INDEX_DATA_SIZE / 4, 1, 0, 0, 0);
            }
        }

        // The swap chain's size and formats (its views in the textures' format).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
        }

        // The depth buffer at the swap chain's size.
        createDepth(device: NriDevice): boolean {
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return false;
            }
            this.depthTexture = depthTexture;
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

        // PopulateCommandList: clear, the cities.
        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            const constantBuffer = this.constantBuffer;
            if (constantBuffer) {
                this.update(queuedFrameIndex * FRAME_CONSTANTS_SIZE, constantBuffer);
            }

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record
                commandBuffer.begin();
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                const depthAttachment = this.depthAttachment;
                if (depthAttachment) {
                    commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
                    commandBuffer.clearColor(CLEAR_R, CLEAR_G, CLEAR_B, 1.0);
                    commandBuffer.clearDepth(1.0);
                    this.recordCities(commandBuffer, queuedFrame);
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
                for (const queuedFrame of this.queuedFrames) {
                    for (const constantView of queuedFrame.constantViews) {
                        constantView.destroy();
                    }
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                const pipeline1 = this.pipeline1;
                if (pipeline1) {
                    pipeline1.destroy();
                }
                const pipeline2 = this.pipeline2;
                if (pipeline2) {
                    pipeline2.destroy();
                }
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    pipelineLayout.destroy();
                }
                const sampler = this.sampler;
                if (sampler) {
                    sampler.destroy();
                }
                const diffuseView = this.diffuseView;
                if (diffuseView) {
                    diffuseView.destroy();
                }
                const diffuse = this.diffuse;
                if (diffuse) {
                    diffuse.destroy();
                }
                const constantBuffer = this.constantBuffer;
                if (constantBuffer) {
                    constantBuffer.destroy();
                }
                const vertexBuffer = this.vertexBuffer;
                if (vertexBuffer) {
                    vertexBuffer.destroy();
                }
                const indexBuffer = this.indexBuffer;
                if (indexBuffer) {
                    indexBuffer.destroy();
                }
                const depthAttachment = this.depthAttachment;
                if (depthAttachment) {
                    depthAttachment.destroy();
                }
                const depthTexture = this.depthTexture;
                if (depthTexture) {
                    depthTexture.destroy();
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
        const bundles = new Bundles(sample);
        return bundles.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return BundlesNri.main(argc, argv);
}

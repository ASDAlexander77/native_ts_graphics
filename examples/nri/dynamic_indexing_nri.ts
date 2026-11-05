/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { matrixMultiply, matrixPerspectiveFovRH, matrixTranslation, matrixTranspose } from "../../core/directx_math";
import { SimpleCamera } from "../../core/simple_camera";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriFile, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace DynamicIndexingNri {
    // dynamic_indexing, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (dynamic_indexing.hlsl's, the D3D12DynamicIndexing
    // sample's), through the NRI calls core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws.
    // The push constants (the city's matrix and material index) are the layout's root constants;
    // the diffuse texture, the 120 materials and the sampler one descriptor set. The cities' draws,
    // which the sample records once into a bundle, are recorded into every frame's command buffer
    // (NRI has no bundles). SimpleCamera's keys are Donut's Key values (declarations only: GLFW's
    // key codes, as NRIFramework's).

    const WINDOW_TITLE = "NRI Example: Dynamic Indexing";
    const DATA_FILE = "media/dynamic_indexing/occcity.bin";

    // The sample's cities: 15 rows of 8, each with a material texture of its own (a 64 x 64 slice of
    // a rainbow), 16 units apart.
    const CITY_ROW_COUNT = 15;
    const CITY_COLUMN_COUNT = 8;
    const CITY_MATERIAL_COUNT = CITY_ROW_COUNT * CITY_COLUMN_COUNT;
    const CITY_MATERIAL_TEXTURE_SIZE = 64;
    const CITY_SPACING_INTERVAL = 16.0;

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

    // The push constants: the city's world-view-projection matrix (transposed) and its material
    // index (a float).
    const DRAW_CONSTANT_FLOATS = 17;

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

    // DirectXMath's XMColorHSLToRGB, in float, for the saturation and lightness the sample uses (0.5,
    // 0.5): its q, p and hue-to-color steps (multiplies and adds without fusing, as its SSE2 path).
    function hue2Clr(p: number, q: number, h: number) {
        const oneSixth = Math.fround(1.0 / 6.0);
        const twoThirds = Math.fround(2.0 / 3.0);
        let t = h;
        if (t < 0.0) {
            t = Math.fround(t + 1.0);
        }
        if (t > 1.0) {
            t = Math.fround(t - 1.0);
        }
        if (t < oneSixth) {
            return Math.fround(Math.fround(Math.fround(q - p) * Math.fround(6.0 * t)) + p);
        }
        if (t < 0.5) {
            return q;
        }
        if (t < twoThirds) {
            return Math.fround(Math.fround(Math.fround(q - p) * Math.fround(6.0 * Math.fround(twoThirds - t))) + p);
        }
        return p;
    }

    function hslToRgb(h: number, s: number, l: number) {
        const oneThird = Math.fround(1.0 / 3.0);
        let q = 0.0;
        if (l < 0.5) {
            q = Math.fround(l * Math.fround(1.0 + s));
        } else {
            q = Math.fround(Math.fround(l + s) - Math.fround(l * s));
        }
        const p = Math.fround(Math.fround(2.0 * l) - q);
        return [hue2Clr(p, q, Math.fround(h + oneThird)), hue2Clr(p, q, h), hue2Clr(p, q, Math.fround(h - oneThird))];
    }

    // -test: checks the last frame, read back. The sky (the frame's top row) is the clear color; the cities
    // cover a good part of the frame, each in its own color: their pixels spread over many hues.
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
        // Covered pixels by which channel dominates: red, green, blue, or two of them.
        let covered = 0;
        const hues: int[] = [0, 0, 0, 0, 0, 0];
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            if (p == background) {
                continue;
            }
            covered++;
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r > g + 20 && r > b + 20) {
                hues[0]++;
            } else if (g > r + 20 && g > b + 20) {
                hues[1]++;
            } else if (b > r + 20 && b > g + 20) {
                hues[2]++;
            } else if (r > b + 20 && g > b + 20) {
                hues[3]++;
            } else if (g > r + 20 && b > r + 20) {
                hues[4]++;
            } else if (r > g + 20 && b > g + 20) {
                hues[5]++;
            }
        }
        let huesShown = 0;
        for (let k = 0; k < 6; k++) {
            if (hues[k] > 500) {
                huesShown++;
            }
        }
        const coverage = covered / (width * height);
        console.log(`Coverage ${coverage}; reddish ${hues[0]}, greenish ${hues[1]}, bluish ${hues[2]}, yellowish ${hues[3]}, cyan ${hues[4]}, magenta ${hues[5]}`);
        if (coverage < 0.2) {
            return `the cities cover ${coverage} of the frame`;
        }
        if (huesShown < 5) {
            return `the cities show ${huesShown} of 6 hue families, not 5 or more`;
        }
        return "";
    }

    // Port of DirectX-Graphics-Samples' D3D12DynamicIndexing (as examples/dynamic_indexing.ts ports
    // it) to NRI: 120 copies of a city in 15 rows of 8, drawn with one pipeline, each draw's pixel
    // shader picking the city's material (a rainbow slice) from an array of 120 textures by an index
    // set per draw and modulating the city's diffuse texture with it. As the sample, into the swap
    // chain's UNORM texture and a D32 depth buffer.
    class DynamicIndexing {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private pipelineLayout: NriPipelineLayout | null = null;
        private pipeline: NriPipeline | null = null;
        private vertexBuffer: NriBuffer | null = null;
        private indexBuffer: NriBuffer | null = null;
        private diffuse: NriTexture | null = null;
        private diffuseView: NriDescriptor | null = null;
        private materials: NriTexture[] = [];
        private materialViews: NriDescriptor[] = [];
        private sampler: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private descriptorSet: NriDescriptorSet | null = null;
        // The swap chain's size (the window's when it was made), its textures' format and their views'.
        private width: int = 0;
        private height: int = 0;
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private viewFormat: NriFormat = NriFormat.Unknown;
        // Set by initialize on D3D11 ("" otherwise).
        private unsupportedReason: string = "";

        private drawConstants: f32[] = [];
        // The cities' model matrices (row vectors), set once.
        private modelMatrices: number[][] = [];
        private camera: SimpleCamera = new SimpleCamera();

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < DRAW_CONSTANT_FLOATS; i++) {
                this.drawConstants.push(0.0);
            }
            // The sample's camera: over the middle of the first row's cities, 15 up and 50 back,
            // twice the city spacing a second.
            this.camera.init(Math.fround(Math.fround(CITY_COLUMN_COUNT / 2.0) * CITY_SPACING_INTERVAL - CITY_SPACING_INTERVAL / 2.0), 15.0, 50.0);
            this.camera.setMoveSpeed(CITY_SPACING_INTERVAL * 2.0);
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

        // The sample's pipeline state: no culling, opaque, depth tested (less) and written.
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
                this.unsupportedReason = "The Dynamic Indexing example can only run on D3D12 or Vulkan";
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
                console.log("Cannot create the depth buffer");
                return 0;
            }

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);

            // The sample's root signature: the city's matrix and material index (b0, root constants
            // here), the diffuse texture (t0), the materials (t1 onwards) and the sampler (s0), as
            // one descriptor set.
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRootConstants(0, DRAW_CONSTANT_FLOATS * 4, NriStage.VertexPixel);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 1, CITY_MATERIAL_COUNT, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.Array);
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

            // Pipeline: dynamic_indexing.hlsl's shaders, as compiled for the Donut example.
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/dynamic_indexing/${folder}/dynamic_indexing`;
            this.pipeline = this.createPipeline(device, pipelineLayout, shaders, "PSMain", format);
            if (!this.pipeline) {
                console.log("Cannot load the dynamic indexing shaders");
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

        // The swap chain's size and formats (its views in the textures' format).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The D32 depth buffer at the swap chain's size; false on failure.
        createDepth(device: NriDevice): boolean {
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
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

        // The window was resized (NriSample.useResizableWindow): the swap chain and the depth buffer made again at its size, once the
        // GPU is done with the old ones.
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

        // LoadAssets: the city's mesh and diffuse texture from the data file, the material textures,
        // the descriptor set, and the cities' positions (SetCityPositions; y raised a little per city
        // against z-fighting).
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

            // The material textures: rows of a rainbow, city i spanning hues i / 120 to (i + 1) / 120
            // down its texture.
            const step = Math.fround(1.0 / Math.fround(CITY_MATERIAL_COUNT));
            const size = CITY_MATERIAL_TEXTURE_SIZE;
            for (let i = 0; i < CITY_MATERIAL_COUNT; i++) {
                const t = Math.fround(i * step);
                const pixels: int[] = [];
                for (let y = 0; y < size; y++) {
                    const tPrime = Math.fround(t + Math.fround(Math.fround(Math.fround(y) / Math.fround(size)) * step));
                    const rgb = hslToRgb(tPrime, 0.5, 0.5);
                    // static_cast<unsigned char>(255 * c): truncated.
                    const r: int = Math.floor(Math.fround(255.0 * rgb[0]));
                    const g: int = Math.floor(Math.fround(255.0 * rgb[1]));
                    const b: int = Math.floor(Math.fround(255.0 * rgb[2]));
                    const pixel = r | (g << 8) | (b << 16) | (255 << 24);
                    for (let x = 0; x < size; x++) {
                        pixels.push(pixel);
                    }
                }
                const material = device.createCommittedTexture(size, size, NriFormat.RGBA8_UNORM);
                if (!material) {
                    console.log("Cannot create the material textures");
                    return false;
                }
                this.queue.uploadTexture(material, Ref(pixels[0]), size * 4);
                this.materials.push(material);
                this.materialViews.push(material.createView(NriFormat.RGBA8_UNORM));
            }

            // The sample's sampler: linear, wrapping. The one descriptor set: the diffuse texture,
            // the materials, the sampler.
            const sampler = device.createSampler(NriFilter.Linear, NriAddressMode.Repeat, 1);
            this.sampler = sampler;
            const descriptorPool = device.createDescriptorPool(1, 1, 0, 1 + CITY_MATERIAL_COUNT, 0, 0);
            this.descriptorPool = descriptorPool;
            const diffuseView = this.diffuseView;
            if (!sampler || !descriptorPool || !diffuseView) {
                console.log("Cannot create the descriptors");
                return false;
            }
            const descriptorSet = descriptorPool.allocateDescriptorSet(pipelineLayout, 0, 0);
            this.descriptorSet = descriptorSet;
            if (!descriptorSet) {
                console.log("Cannot create the descriptor set");
                return false;
            }
            descriptorSet.updateDescriptor(0, 0, diffuseView);
            for (let i = 0; i < CITY_MATERIAL_COUNT; i++) {
                descriptorSet.updateDescriptor(1, i, this.materialViews[i]);
            }
            descriptorSet.updateDescriptor(2, 0, sampler);

            for (let i = 0; i < CITY_ROW_COUNT; i++) {
                const cityOffsetZ = Math.fround(i * -CITY_SPACING_INTERVAL);
                for (let j = 0; j < CITY_COLUMN_COUNT; j++) {
                    const cityOffsetX = Math.fround(j * CITY_SPACING_INTERVAL);
                    const cityOffsetY = Math.fround(Math.fround(0.02) * (i * CITY_COLUMN_COUNT + j));
                    this.modelMatrices.push(matrixTranslation(cityOffsetX, cityOffsetY, cityOffsetZ));
                }
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // OnUpdate: the camera (its keys).
        update() {
            for (const key of CAMERA_KEYS) {
                this.camera.onKey(key, this.sample.isKeyPressed(key) != 0);
            }
            // In test mode 1/60 second a frame, as Donut's test mode.
            this.camera.update(Math.fround(this.test ? 1.0 / 60.0 : this.sample.getFrameTime()));
        }

        // The bundle's draws (recorded every frame: NRI has no bundles): each city with its
        // model-view-projection matrix and material index.
        recordCities(commandBuffer: NriCommandBuffer) {
            const pipelineLayout = this.pipelineLayout;
            const pipeline = this.pipeline;
            const vertexBuffer = this.vertexBuffer;
            const indexBuffer = this.indexBuffer;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = this.descriptorSet;
            if (!pipelineLayout || !pipeline || !vertexBuffer) {
                return;
            }
            if (!indexBuffer || !descriptorPool || !descriptorSet) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(pipelineLayout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setDescriptorSet(0, descriptorSet);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
            commandBuffer.setVertexBuffer(0, vertexBuffer, 0, VERTEX_STRIDE);

            const view = this.camera.viewMatrix();
            const projection = matrixPerspectiveFovRH(Math.fround(0.8), Math.fround(this.width / this.height), 1.0, 1000.0);
            for (let i = 0; i < CITY_MATERIAL_COUNT; i++) {
                // model * view * projection, as the sample multiplies them: (model * view) * projection.
                const mvp = matrixTranspose(matrixMultiply(matrixMultiply(this.modelMatrices[i], view), projection));
                for (let k = 0; k < 16; k++) {
                    this.drawConstants[k] = mvp[k];
                }
                this.drawConstants[16] = i;
                commandBuffer.setRootConstants(0, Ref(this.drawConstants[0]), DRAW_CONSTANT_FLOATS * 4);
                commandBuffer.drawIndexed(INDEX_DATA_SIZE / 4, 1, 0, 0, 0);
            }
        }

        // PopulateCommandList: clear, the cities.
        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            this.update();

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
                    this.recordCities(commandBuffer);
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
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                const pipeline = this.pipeline;
                if (pipeline) {
                    pipeline.destroy();
                }
                for (const materialView of this.materialViews) {
                    materialView.destroy();
                }
                for (const material of this.materials) {
                    material.destroy();
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
                const vertexBuffer = this.vertexBuffer;
                if (vertexBuffer) {
                    vertexBuffer.destroy();
                }
                const indexBuffer = this.indexBuffer;
                if (indexBuffer) {
                    indexBuffer.destroy();
                }
                this.destroyDepth();
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
        const dynamicIndexing = new DynamicIndexing(sample);
        return dynamicIndexing.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return DynamicIndexingNri.main(argc, argv);
}

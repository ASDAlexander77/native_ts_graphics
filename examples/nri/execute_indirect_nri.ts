/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { matrixPerspectiveFovLH, matrixTranspose } from "../../core/directx_math";
import { MsvcRandom } from "../../core/random";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDevice, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace ExecuteIndirectNri {
    // execute_indirect, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (execute_indirect.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws. This example creates everything
    // it runs, and does the rendering.

    const WINDOW_TITLE = "NRI Example: Execute Indirect - Press the SPACE bar to toggle GPU primitive culling";

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no indirect draw counts, or no
    // shaders for the graphics API (D3D11).
    const TEST_SKIPPED = 77;

    // The sample's frames in flight: each has its own copy of the triangles' constants and commands.
    const FRAME_COUNT = 3;
    const TRIANGLE_COUNT = 1024;
    const TRIANGLE_RESOURCE_COUNT = TRIANGLE_COUNT * FRAME_COUNT;
    // Should match compute shader's threadBlockSize.
    const COMPUTE_THREAD_BLOCK_SIZE = 128;
    // The x and y offsets of the triangle vertices, their z, and the culling planes' +/- x in
    // homogenous space.
    const TRIANGLE_HALF_WIDTH = Math.fround(0.05);
    const TRIANGLE_DEPTH = 1.0;
    const CULLING_CUTOFF = 0.5;

    // SceneConstantBuffer: velocity, offset, color, projection, padding: 256 bytes.
    const CONSTANTS_STRIDE = 256;
    const CONSTANT_FLOATS = 64;
    // An indexed indirect draw's arguments: 5 uints.
    const COMMAND_SIZE = 20;
    // The culling shader's push constants: xOffset, zOffset, cullOffset, commandCount, frameOffset
    // (floats).
    const ROOT_CONSTANTS_SIZE = 20;

    // The sample's clear color, (0, 0.2, 0.4).
    const CLEAR_R = 0.0;
    const CLEAR_G = 0.2;
    const CLEAR_B = 0.4;

    // Test mode: the frames rendered, culling on: the triangles start left of the screen and drift in.
    const TEST_FRAMES = 300;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // A sample frame's culling outputs: the commands kept and their count, and their views.
    class CulledCommands {
        constructor(public commands: NriBuffer, public count: NriBuffer, public commandsStorage: NriDescriptor | null,
            public countStorage: NriDescriptor | null) {
        }
    }

    // The sample's GetRandomFloat over MSVC's rand() (seed 1, the default), in float.
    function randomFloat(rand: MsvcRandom, min: number, max: number) {
        const scale = Math.fround(Math.fround(rand.next()) / 32767.0);
        const range = Math.fround(Math.fround(max) - Math.fround(min));
        return Math.fround(Math.fround(scale * range) + Math.fround(min));
    }

    // -test: checks the last frame, culling on, as the Donut example does: outside the culling band
    // (the middle half of the screen) only the clear color; inside it, triangles.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const background = 0 | (51 << 8) | (102 << 16);
        const left = width / 4;
        const right = width * 3 / 4;
        let inside = 0;
        let outside = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if ((pixels[y * width + x] & 0xFFFFFF) != background) {
                    if (x >= left && x < right) {
                        inside++;
                    } else {
                        outside++;
                    }
                }
            }
        }
        console.log(`Triangle pixels inside the culling band ${inside}, outside ${outside}`);
        if (outside != 0) {
            return `${outside} triangle pixels outside the culling band`;
        }
        if (inside < 2000) {
            return `only ${inside} triangle pixels inside the culling band`;
        }
        return "";
    }

    // Port of DirectX-Graphics-Samples' D3D12ExecuteIndirect (as examples/execute_indirect.ts ports
    // it) to NRI: 1024 triangles drifting across the screen, each with its own constants, drawn by
    // one indirect call of 1024 commands; with culling on (Space switches it), a compute shader
    // first keeps only the commands of the triangles within the middle half of the screen (the draw
    // scissored to it) and the indirect call takes their count from a buffer. As in the Donut
    // example, the sample's compute queue is the frame's command buffer, its root CBV per command
    // an instance index (see execute_indirect.hlsl). The sample's R8G8B8A8_UNORM back buffer is the
    // swap chain's (rendered through its UNORM view), with a D32_FLOAT depth buffer.
    class ExecuteIndirect {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private drawLayout: NriPipelineLayout | null = null;
        private drawPipeline: NriPipeline | null = null;
        private computeLayout: NriPipelineLayout | null = null;
        private computePipeline: NriPipeline | null = null;
        private vertexBuffer: NriBuffer | null = null;
        private triangleIndexBuffer: NriBuffer | null = null;
        private indexBuffer: NriBuffer | null = null;
        // The triangles' constants, every sample frame's copy, written by the CPU.
        private constantBuffer: NriBuffer | null = null;
        private constantsView: NriDescriptor | null = null;
        // Every sample frame's commands, and each frame's culling outputs.
        private commandBuffer: NriBuffer | null = null;
        private commandsView: NriDescriptor | null = null;
        private culledCommands: CulledCommands[] = [];
        // The swap chain's size (the window's when it was made), its textures' format and their views'.
        private width: int = 0;
        private height: int = 0;
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private viewFormat: NriFormat = NriFormat.Unknown;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // The triangles' constants (m_constantBufferData), 64 floats each.
        private constants: f32[] = [];
        private rootConstants: f32[] = [TRIANGLE_HALF_WIDTH, TRIANGLE_DEPTH, CULLING_CUTOFF, TRIANGLE_COUNT, 0.0];
        private rand: MsvcRandom = new MsvcRandom(1);
        // The sample's frame index (FRAME_COUNT frames).
        private frameIndex: int = 0;
        private enableCulling: boolean = true;

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

            // Swap chain: rendered through its UNORM views, as the sample's R8G8B8A8_UNORM back
            // buffer.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, false);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);

            // The sample's D3D12 shaders only (as the Donut example's), and indirect draw counts.
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (execute_indirect.hlsl is compiled for D3D12 and Vulkan)";
                return 0;
            }
            if (device.isFeatureSupported(NriFeature.DrawIndirectCount) == 0) {
                this.unsupportedReason = "The graphics device can't take indirect draw counts from a buffer";
                return 0;
            }

            // The depth buffer: D32_FLOAT, as the sample's.
            if (!this.createDepth(device)) {
                console.log("Cannot create the depth buffer");
                return 0;
            }

            // The layouts: the vertex shader's constants (t0); the culling's push constants (b0),
            // constants (t0), commands (t1) and outputs (u0, u1). All root descriptors.
            const drawLayoutDesc = NriPipelineLayoutDesc.create();
            drawLayoutDesc.addRootDescriptor(0, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            this.drawLayout = device.createPipelineLayoutFromDesc(drawLayoutDesc);
            drawLayoutDesc.destroy();
            const computeLayoutDesc = NriPipelineLayoutDesc.create();
            computeLayoutDesc.addRootConstants(0, ROOT_CONSTANTS_SIZE, NriStage.Compute);
            computeLayoutDesc.addRootDescriptor(0, NriDescriptorType.StructuredBuffer, NriStage.Compute);
            computeLayoutDesc.addRootDescriptor(1, NriDescriptorType.StructuredBuffer, NriStage.Compute);
            computeLayoutDesc.addRootDescriptor(0, NriDescriptorType.StorageStructuredBuffer, NriStage.Compute);
            computeLayoutDesc.addRootDescriptor(1, NriDescriptorType.StorageStructuredBuffer, NriStage.Compute);
            this.computeLayout = device.createPipelineLayoutFromDesc(computeLayoutDesc);
            computeLayoutDesc.destroy();
            const drawLayout = this.drawLayout;
            const computeLayout = this.computeLayout;
            if (!drawLayout || !computeLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: execute_indirect.hlsl's shaders, as compiled for the Donut example; the
            // sample's pipeline state: the triangle's positions (stream 0) and the triangles' indices
            // (stream 1, per instance), triangle strips, back faces culled, opaque, depth less.
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/execute_indirect/${folder}/execute_indirect`;
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_VSMain.bin`, "VSMain") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_PSMain.bin`, "PSMain") != 0;
            }
            desc.addVertexAttributeFromStream("POSITION", NriFormat.RGB32_SFLOAT, 0, 0);
            desc.addVertexAttributeFromStream("TRIANGLE", NriFormat.R32_UINT, 0, 1);
            desc.setInstanceStream(1);
            desc.setTopology(NriTopology.TriangleStrip);
            desc.setCullMode(NriCullMode.Back);
            desc.setColor(format, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.Less, 1, 0);
            if (loaded) {
                this.drawPipeline = device.createPipelineFromDesc(drawLayout, desc);
            }
            desc.destroy();
            this.computePipeline = device.createComputePipeline(computeLayout, `${shaders}_CSMain.bin`, "CSMain");
            if (!this.drawPipeline || !this.computePipeline) {
                console.log("Cannot load the execute indirect shaders");
                return 0;
            }

            if (!this.createResources(device)) {
                console.log("Cannot create the buffers");
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

        // LoadAssets: the triangle, its indices (the strip's three), the triangles' indices for the
        // instance attribute, their constants (random speeds, positions, colors), the commands of
        // every frame and the buffers the culling writes.
        createResources(device: NriDevice): boolean {
            const h = TRIANGLE_HALF_WIDTH;
            const vertices: f32[] = [
                0.0, h, TRIANGLE_DEPTH,
                h, -h, TRIANGLE_DEPTH,
                -h, -h, TRIANGLE_DEPTH,
            ];
            this.vertexBuffer = device.createUploadedBuffer(this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            const indices: int[] = [0, 1, 2];
            this.indexBuffer = device.createUploadedBufferFromInts(this.queue, Ref(indices[0]), 12, NriBufferUsage.IndexBuffer);
            const triangleIndices: int[] = [];
            for (let i = 0; i < TRIANGLE_RESOURCE_COUNT; i++) {
                triangleIndices.push(i);
            }
            this.triangleIndexBuffer = device.createUploadedBufferFromInts(this.queue, Ref(triangleIndices[0]), TRIANGLE_RESOURCE_COUNT * 4,
                NriBufferUsage.VertexBuffer);

            // The constant buffers: velocity, offset and color from GetRandomFloat, in the order the
            // sample's MSVC build calls it for the XMFLOAT4 constructors' arguments (offset z, y, x;
            // color g, r, b: read from its constants); the projection.
            const aspectRatio = Math.fround(Math.fround(this.width) / Math.fround(this.height));
            const projection = matrixTranspose(matrixPerspectiveFovLH(Math.fround(0.785398163), aspectRatio, 0.01, 20.0));
            for (let n = 0; n < TRIANGLE_COUNT; n++) {
                const velocity = randomFloat(this.rand, 0.01, 0.02);
                const oz = randomFloat(this.rand, 0.0, 2.0);
                const oy = randomFloat(this.rand, -1.0, 1.0);
                const ox = randomFloat(this.rand, -5.0, -1.5);
                const cg = randomFloat(this.rand, 0.5, 1.0);
                const cr = randomFloat(this.rand, 0.5, 1.0);
                const cb = randomFloat(this.rand, 0.5, 1.0);
                const values = [velocity, 0.0, 0.0, 0.0, ox, oy, oz, 0.0, cr, cg, cb, 1.0];
                for (let i = 0; i < 12; i++) {
                    this.constants.push(values[i]);
                }
                for (let i = 0; i < 16; i++) {
                    this.constants.push(projection[i]);
                }
                for (let i = 0; i < 36; i++) {
                    this.constants.push(0.0);
                }
            }
            const constantBuffer = device.createHostBufferWithStride(TRIANGLE_RESOURCE_COUNT * CONSTANTS_STRIDE, NriBufferUsage.StructuredBuffer,
                CONSTANTS_STRIDE);
            this.constantBuffer = constantBuffer;

            // Every frame's commands: a triangle each, its constants by its start instance (read by
            // the culling and the unculled draws: raw, 4-byte structures).
            const commands: int[] = [];
            for (let i = 0; i < TRIANGLE_RESOURCE_COUNT; i++) {
                commands.push(3);
                commands.push(1);
                commands.push(0);
                commands.push(0);
                commands.push(i);
            }
            const commandBuffer = device.createStorageBufferFromInts(this.queue, Ref(commands[0]), TRIANGLE_RESOURCE_COUNT * COMMAND_SIZE, 4,
                NriBufferState.IndirectArgumentAndComputeResource);
            this.commandBuffer = commandBuffer;
            if (!constantBuffer || !commandBuffer) {
                return false;
            }
            this.constantsView = constantBuffer.createStructuredView(0);
            this.commandsView = commandBuffer.createStructuredView(0);

            const zeros: int[] = [];
            for (let i = 0; i < TRIANGLE_COUNT * COMMAND_SIZE / 4; i++) {
                zeros.push(0);
            }
            for (let f = 0; f < FRAME_COUNT; f++) {
                const processed = device.createStorageBufferFromInts(this.queue, Ref(zeros[0]), TRIANGLE_COUNT * COMMAND_SIZE, 4,
                    NriBufferState.IndirectArgument);
                const count = device.createStorageBufferFromInts(this.queue, Ref(zeros[0]), 4, 4, NriBufferState.IndirectArgument);
                if (!processed || !count) {
                    return false;
                }
                this.culledCommands.push(new CulledCommands(processed, count, processed.createStructuredView(1),
                    count.createStructuredView(1)));
            }
            return this.created();
        }

        // The buffers and views createResources makes were created (early returns: tslang can't
        // && @cpp handles, TSLANG_ISSUES #23).
        created(): boolean {
            if (!this.vertexBuffer || !this.indexBuffer || !this.triangleIndexBuffer || !this.constantsView || !this.commandsView) {
                return false;
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // OnUpdate: the triangles move right, coming back at the left with a new speed past the
        // bounds; the sample frame's copy of their constants is written (the GPU is done with it:
        // NRIFramework's frames in flight are fewer than the sample's). Space toggles the culling.
        update() {
            if (this.sample.isKeyToggled(NriKey.Space) != 0) {
                this.enableCulling = !this.enableCulling;
            }
            const offsetBounds = 2.5;
            const c = this.constants;
            for (let n = 0; n < TRIANGLE_COUNT; n++) {
                const base = n * CONSTANT_FLOATS;
                c[base + 4] = Math.fround(c[base + 4] + c[base]);
                if (c[base + 4] > offsetBounds) {
                    c[base] = randomFloat(this.rand, 0.01, 0.02);
                    c[base + 4] = -offsetBounds;
                }
            }
            const constantBuffer = this.constantBuffer;
            if (constantBuffer) {
                constantBuffer.write(this.frameIndex * TRIANGLE_COUNT * CONSTANTS_STRIDE, Ref(this.constants[0]),
                    TRIANGLE_COUNT * CONSTANTS_STRIDE);
            }
        }

        // The culling: the frame's count reset, then the compute shader keeps the commands of the
        // triangles in the culling band; the outputs then go to the indirect draw.
        recordCulling(commandBuffer: NriCommandBuffer) {
            const computeLayout = this.computeLayout;
            const computePipeline = this.computePipeline;
            const constantsView = this.constantsView;
            const commandsView = this.commandsView;
            const culled = this.culledCommands[this.frameIndex];
            const commandsStorage = culled.commandsStorage;
            const countStorage = culled.countStorage;
            if (!computeLayout || !computePipeline || !constantsView || !commandsView || !commandsStorage || !countStorage) {
                return;
            }
            commandBuffer.bufferBarrier(culled.count, NriBufferState.IndirectArgument, NriBufferState.CopyDestination);
            commandBuffer.zeroBuffer(culled.count);
            commandBuffer.bufferBarrier(culled.count, NriBufferState.CopyDestination, NriBufferState.Storage);
            commandBuffer.bufferBarrier(culled.commands, NriBufferState.IndirectArgument, NriBufferState.Storage);

            // xOffset, zOffset, cullOffset, commandCount, and the frame's offset (a float here).
            this.rootConstants[4] = this.frameIndex * TRIANGLE_COUNT;
            commandBuffer.setComputePipelineLayout(computeLayout);
            commandBuffer.setPipeline(computePipeline);
            commandBuffer.setComputeRootConstants(0, Ref(this.rootConstants[0]), ROOT_CONSTANTS_SIZE);
            commandBuffer.setComputeRootDescriptor(0, constantsView);
            commandBuffer.setComputeRootDescriptor(1, commandsView);
            commandBuffer.setComputeRootDescriptor(2, commandsStorage);
            commandBuffer.setComputeRootDescriptor(3, countStorage);
            commandBuffer.dispatch(Math.ceil(TRIANGLE_COUNT / COMPUTE_THREAD_BLOCK_SIZE), 1, 1);

            commandBuffer.bufferBarrier(culled.commands, NriBufferState.Storage, NriBufferState.IndirectArgument);
            commandBuffer.bufferBarrier(culled.count, NriBufferState.Storage, NriBufferState.IndirectArgument);
        }

        // The indirect draw of all or (with culling, scissored to the culling band) the kept commands
        // (between NriCommandBuffer.beginRenderingWithDepth and NriCommandBuffer.endRendering).
        recordDraw(commandBuffer: NriCommandBuffer) {
            const drawLayout = this.drawLayout;
            const drawPipeline = this.drawPipeline;
            const constantsView = this.constantsView;
            const vertexBuffer = this.vertexBuffer;
            const triangleIndexBuffer = this.triangleIndexBuffer;
            const indexBuffer = this.indexBuffer;
            const allCommands = this.commandBuffer;
            if (!drawLayout || !drawPipeline || !constantsView || !vertexBuffer || !triangleIndexBuffer || !indexBuffer || !allCommands) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setPipelineLayout(drawLayout);
            commandBuffer.setPipeline(drawPipeline);
            commandBuffer.setRootDescriptor(0, constantsView, 0);
            commandBuffer.setVertexBuffer(0, vertexBuffer, 0, 12);
            commandBuffer.setVertexBuffer(1, triangleIndexBuffer, 0, 4);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
            if (this.enableCulling) {
                // m_cullingScissorRect: the middle half of the screen, as the culling planes.
                const center = Math.fround(this.width / 2.0);
                const left: int = Math.floor(Math.fround(center - Math.fround(center * CULLING_CUTOFF)));
                const right: int = Math.floor(Math.fround(center + Math.fround(center * CULLING_CUTOFF)));
                commandBuffer.setScissor(left, 0, right - left, this.height);
                const culled = this.culledCommands[this.frameIndex];
                commandBuffer.drawIndexedIndirect(culled.commands, 0, TRIANGLE_COUNT, COMMAND_SIZE, culled.count, 0);
            } else {
                commandBuffer.setScissor(0, 0, this.width, this.height);
                commandBuffer.drawIndexedIndirect(allCommands, this.frameIndex * TRIANGLE_COUNT * COMMAND_SIZE, TRIANGLE_COUNT, COMMAND_SIZE,
                    null, 0);
            }
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

        // The triangles' projection (in each one's constants, which update writes every frame) for the
        // swap chain's aspect ratio, as LoadAssets computes it.
        updateProjection() {
            const aspectRatio = Math.fround(Math.fround(this.width) / Math.fround(this.height));
            const projection = matrixTranspose(matrixPerspectiveFovLH(Math.fround(0.785398163), aspectRatio, 0.01, 20.0));
            for (let n = 0; n < TRIANGLE_COUNT; n++) {
                for (let i = 0; i < 16; i++) {
                    this.constants[n * CONSTANT_FLOATS + 12 + i] = projection[i];
                }
            }
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain, the depth buffer and the projection made again at its size, once the
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
            this.updateProjection();
        }

        // PopulateCommandLists
        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            this.update();

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record
                commandBuffer.begin();
                if (this.enableCulling) {
                    this.recordCulling(commandBuffer);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
                    commandBuffer.clearColor(CLEAR_R, CLEAR_G, CLEAR_B, 1.0);
                    commandBuffer.clearDepth(1.0);
                    this.recordDraw(commandBuffer);
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
            this.frameIndex = (this.frameIndex + 1) % FRAME_COUNT;

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
                for (const culled of this.culledCommands) {
                    this.destroyDescriptor(culled.commandsStorage);
                    this.destroyDescriptor(culled.countStorage);
                    culled.commands.destroy();
                    culled.count.destroy();
                }
                this.destroyDescriptor(this.constantsView);
                this.destroyDescriptor(this.commandsView);
                this.destroyDepth();
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.triangleIndexBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.commandBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.drawPipeline);
                this.destroyPipeline(this.computePipeline);
                const drawLayout = this.drawLayout;
                if (drawLayout) {
                    drawLayout.destroy();
                }
                const computeLayout = this.computeLayout;
                if (computeLayout) {
                    computeLayout.destroy();
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

        destroyBuffer(buffer: NriBuffer | null) {
            if (buffer) {
                buffer.destroy();
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
        const executeIndirect = new ExecuteIndirect(sample);
        return executeIndirect.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return ExecuteIndirectNri.main(argc, argv);
}

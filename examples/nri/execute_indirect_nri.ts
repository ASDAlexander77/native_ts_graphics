/// <reference path="../../core/nri/nri_interop.d.ts" />
import { matrixPerspectiveFovLH, matrixTranspose } from "../../core/directx_math";
import { MsvcRandom } from "../../core/random";

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

    // A sample frame's culling outputs: the commands kept and their count, and their views.
    class CulledCommands {
        constructor(public commands: NriBufferHandle, public count: NriBufferHandle, public commandsStorage: NriDescriptorHandle | null,
            public countStorage: NriDescriptorHandle | null) {
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
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private drawLayout: NriPipelineLayoutHandle | null = null;
        private drawPipeline: NriPipelineHandle | null = null;
        private computeLayout: NriPipelineLayoutHandle | null = null;
        private computePipeline: NriPipelineHandle | null = null;
        private vertexBuffer: NriBufferHandle | null = null;
        private triangleIndexBuffer: NriBufferHandle | null = null;
        private indexBuffer: NriBufferHandle | null = null;
        // The triangles' constants, every sample frame's copy, written by the CPU.
        private constantBuffer: NriBufferHandle | null = null;
        private constantsView: NriDescriptorHandle | null = null;
        // Every sample frame's commands, and each frame's culling outputs.
        private commandBuffer: NriBufferHandle | null = null;
        private commandsView: NriDescriptorHandle | null = null;
        private culledCommands: CulledCommands[] = [];
        private width: int = 0;
        private height: int = 0;
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
            console.log(`Renderer: ${Nri_GetGraphicsAPIString(graphicsAPI)} (${Nri_GetAdapterName(device)})`);

            this.queue = Nri_GetGraphicsQueue(device);
            this.frameFence = Nri_CreateFence(device, 0);
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.test = Nri_IsTest(this.sample) != 0;

            // Swap chain: rendered through its UNORM views, as the sample's R8G8B8A8_UNORM back
            // buffer.
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

            // The sample's D3D12 shaders only (as the Donut example's), and indirect draw counts.
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (execute_indirect.hlsl is compiled for D3D12 and Vulkan)";
                return 0;
            }
            if (Nri_IsFeatureSupported(device, NriFeature.DrawIndirectCount) == 0) {
                this.unsupportedReason = "The graphics device can't take indirect draw counts from a buffer";
                return 0;
            }

            // The depth buffer: D32_FLOAT, as the sample's.
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return 0;
            }
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            // The layouts: the vertex shader's constants (t0); the culling's push constants (b0),
            // constants (t0), commands (t1) and outputs (u0, u1). All root descriptors.
            const drawLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootDescriptor(drawLayoutDesc, 0, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            this.drawLayout = Nri_CreatePipelineLayoutFromDesc(device, drawLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(drawLayoutDesc);
            const computeLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(computeLayoutDesc, 0, ROOT_CONSTANTS_SIZE, NriStage.Compute);
            Nri_PipelineLayoutDescAddRootDescriptor(computeLayoutDesc, 0, NriDescriptorType.StructuredBuffer, NriStage.Compute);
            Nri_PipelineLayoutDescAddRootDescriptor(computeLayoutDesc, 1, NriDescriptorType.StructuredBuffer, NriStage.Compute);
            Nri_PipelineLayoutDescAddRootDescriptor(computeLayoutDesc, 0, NriDescriptorType.StorageStructuredBuffer, NriStage.Compute);
            Nri_PipelineLayoutDescAddRootDescriptor(computeLayoutDesc, 1, NriDescriptorType.StorageStructuredBuffer, NriStage.Compute);
            this.computeLayout = Nri_CreatePipelineLayoutFromDesc(device, computeLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(computeLayoutDesc);
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
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_VSMain.bin`, "VSMain") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_PSMain.bin`, "PSMain") != 0;
            }
            Nri_PipelineDescAddVertexAttributeFromStream(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0, 0);
            Nri_PipelineDescAddVertexAttributeFromStream(desc, "TRIANGLE", NriFormat.R32_UINT, 0, 1);
            Nri_PipelineDescSetInstanceStream(desc, 1);
            Nri_PipelineDescSetTopology(desc, NriTopology.TriangleStrip);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            Nri_PipelineDescSetColor(desc, format, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Less, 1, 0);
            if (loaded) {
                this.drawPipeline = Nri_CreatePipelineFromDesc(device, drawLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            this.computePipeline = Nri_CreateComputePipeline(device, computeLayout, `${shaders}_CSMain.bin`, "CSMain");
            if (!this.drawPipeline || !this.computePipeline) {
                console.log("Cannot load the execute indirect shaders");
                return 0;
            }

            if (!this.createResources(device)) {
                console.log("Cannot create the buffers");
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

        // LoadAssets: the triangle, its indices (the strip's three), the triangles' indices for the
        // instance attribute, their constants (random speeds, positions, colors), the commands of
        // every frame and the buffers the culling writes.
        createResources(device: NriDeviceHandle): boolean {
            const h = TRIANGLE_HALF_WIDTH;
            const vertices: f32[] = [
                0.0, h, TRIANGLE_DEPTH,
                h, -h, TRIANGLE_DEPTH,
                -h, -h, TRIANGLE_DEPTH,
            ];
            this.vertexBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            const indices: int[] = [0, 1, 2];
            this.indexBuffer = Nri_CreateUploadedBufferFromInts(device, this.queue, Ref(indices[0]), 12, NriBufferUsage.IndexBuffer);
            const triangleIndices: int[] = [];
            for (let i = 0; i < TRIANGLE_RESOURCE_COUNT; i++) {
                triangleIndices.push(i);
            }
            this.triangleIndexBuffer = Nri_CreateUploadedBufferFromInts(device, this.queue, Ref(triangleIndices[0]), TRIANGLE_RESOURCE_COUNT * 4,
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
            const constantBuffer = Nri_CreateHostBufferWithStride(device, TRIANGLE_RESOURCE_COUNT * CONSTANTS_STRIDE, NriBufferUsage.StructuredBuffer,
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
            const commandBuffer = Nri_CreateStorageBufferFromInts(device, this.queue, Ref(commands[0]), TRIANGLE_RESOURCE_COUNT * COMMAND_SIZE, 4,
                NriBufferState.IndirectArgumentAndComputeResource);
            this.commandBuffer = commandBuffer;
            if (!constantBuffer || !commandBuffer) {
                return false;
            }
            this.constantsView = Nri_CreateStructuredBufferView(constantBuffer, 0);
            this.commandsView = Nri_CreateStructuredBufferView(commandBuffer, 0);

            const zeros: int[] = [];
            for (let i = 0; i < TRIANGLE_COUNT * COMMAND_SIZE / 4; i++) {
                zeros.push(0);
            }
            for (let f = 0; f < FRAME_COUNT; f++) {
                const processed = Nri_CreateStorageBufferFromInts(device, this.queue, Ref(zeros[0]), TRIANGLE_COUNT * COMMAND_SIZE, 4,
                    NriBufferState.IndirectArgument);
                const count = Nri_CreateStorageBufferFromInts(device, this.queue, Ref(zeros[0]), 4, 4, NriBufferState.IndirectArgument);
                if (!processed || !count) {
                    return false;
                }
                this.culledCommands.push(new CulledCommands(processed, count, Nri_CreateStructuredBufferView(processed, 1),
                    Nri_CreateStructuredBufferView(count, 1)));
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
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // OnUpdate: the triangles move right, coming back at the left with a new speed past the
        // bounds; the sample frame's copy of their constants is written (the GPU is done with it:
        // NRIFramework's frames in flight are fewer than the sample's). Space toggles the culling.
        update() {
            if (Nri_IsKeyToggled(this.sample, NriKey.Space) != 0) {
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
                Nri_WriteBuffer(constantBuffer, this.frameIndex * TRIANGLE_COUNT * CONSTANTS_STRIDE, Ref(this.constants[0]),
                    TRIANGLE_COUNT * CONSTANTS_STRIDE);
            }
        }

        // The culling: the frame's count reset, then the compute shader keeps the commands of the
        // triangles in the culling band; the outputs then go to the indirect draw.
        recordCulling(commandBuffer: NriCommandBufferHandle) {
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
            Nri_CmdBufferBarrier(commandBuffer, culled.count, NriBufferState.IndirectArgument, NriBufferState.CopyDestination);
            Nri_CmdZeroBuffer(commandBuffer, culled.count);
            Nri_CmdBufferBarrier(commandBuffer, culled.count, NriBufferState.CopyDestination, NriBufferState.Storage);
            Nri_CmdBufferBarrier(commandBuffer, culled.commands, NriBufferState.IndirectArgument, NriBufferState.Storage);

            // xOffset, zOffset, cullOffset, commandCount, and the frame's offset (a float here).
            this.rootConstants[4] = this.frameIndex * TRIANGLE_COUNT;
            Nri_CmdSetComputePipelineLayout(commandBuffer, computeLayout);
            Nri_CmdSetPipeline(commandBuffer, computePipeline);
            Nri_CmdSetComputeRootConstants(commandBuffer, 0, Ref(this.rootConstants[0]), ROOT_CONSTANTS_SIZE);
            Nri_CmdSetComputeRootDescriptor(commandBuffer, 0, constantsView);
            Nri_CmdSetComputeRootDescriptor(commandBuffer, 1, commandsView);
            Nri_CmdSetComputeRootDescriptor(commandBuffer, 2, commandsStorage);
            Nri_CmdSetComputeRootDescriptor(commandBuffer, 3, countStorage);
            Nri_CmdDispatch(commandBuffer, Math.ceil(TRIANGLE_COUNT / COMPUTE_THREAD_BLOCK_SIZE), 1, 1);

            Nri_CmdBufferBarrier(commandBuffer, culled.commands, NriBufferState.Storage, NriBufferState.IndirectArgument);
            Nri_CmdBufferBarrier(commandBuffer, culled.count, NriBufferState.Storage, NriBufferState.IndirectArgument);
        }

        // The indirect draw of all or (with culling, scissored to the culling band) the kept commands
        // (between Nri_CmdBeginRenderingWithDepth and Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle) {
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
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, drawLayout);
            Nri_CmdSetPipeline(commandBuffer, drawPipeline);
            Nri_CmdSetRootDescriptor(commandBuffer, 0, constantsView, 0);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, vertexBuffer, 0, 12);
            Nri_CmdSetVertexBuffer(commandBuffer, 1, triangleIndexBuffer, 0, 4);
            Nri_CmdSetIndexBuffer(commandBuffer, indexBuffer, 0, NriIndexType.UInt32);
            if (this.enableCulling) {
                // m_cullingScissorRect: the middle half of the screen, as the culling planes.
                const center = Math.fround(this.width / 2.0);
                const left: int = Math.floor(Math.fround(center - Math.fround(center * CULLING_CUTOFF)));
                const right: int = Math.floor(Math.fround(center + Math.fround(center * CULLING_CUTOFF)));
                Nri_CmdSetScissor(commandBuffer, left, 0, right - left, this.height);
                const culled = this.culledCommands[this.frameIndex];
                Nri_CmdDrawIndexedIndirect(commandBuffer, culled.commands, 0, TRIANGLE_COUNT, COMMAND_SIZE, culled.count, 0);
            } else {
                Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
                Nri_CmdDrawIndexedIndirect(commandBuffer, allCommands, this.frameIndex * TRIANGLE_COUNT * COMMAND_SIZE, TRIANGLE_COUNT, COMMAND_SIZE,
                    null, 0);
            }
        }

        // PopulateCommandLists
        renderFrame(frameIndex: int) {
            const queuedFrame = this.queuedFrames[frameIndex % this.queuedFrames.length];
            this.update();

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record
                Nri_BeginCommandBuffer(commandBuffer);
                if (this.enableCulling) {
                    this.recordCulling(commandBuffer);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                    Nri_CmdClearColor(commandBuffer, CLEAR_R, CLEAR_G, CLEAR_B, 1.0);
                    Nri_CmdClearDepth(commandBuffer, 1.0);
                    this.recordDraw(commandBuffer);
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
            this.frameIndex = (this.frameIndex + 1) % FRAME_COUNT;

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
                for (const culled of this.culledCommands) {
                    this.destroyDescriptor(culled.commandsStorage);
                    this.destroyDescriptor(culled.countStorage);
                    Nri_DestroyBuffer(culled.commands);
                    Nri_DestroyBuffer(culled.count);
                }
                this.destroyDescriptor(this.constantsView);
                this.destroyDescriptor(this.commandsView);
                this.destroyDescriptor(this.depthAttachment);
                const depthTexture = this.depthTexture;
                if (depthTexture) {
                    Nri_DestroyTexture(depthTexture);
                }
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
                    Nri_DestroyPipelineLayout(drawLayout);
                }
                const computeLayout = this.computeLayout;
                if (computeLayout) {
                    Nri_DestroyPipelineLayout(computeLayout);
                }
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }

        destroyDescriptor(descriptor: NriDescriptorHandle | null) {
            if (descriptor) {
                Nri_DestroyDescriptor(descriptor);
            }
        }

        destroyBuffer(buffer: NriBufferHandle | null) {
            if (buffer) {
                Nri_DestroyBuffer(buffer);
            }
        }

        destroyPipeline(pipeline: NriPipelineHandle | null) {
            if (pipeline) {
                Nri_DestroyPipeline(pipeline);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const executeIndirect = new ExecuteIndirect(Nri_CreateSample());
        return executeIndirect.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return ExecuteIndirectNri.main(argc, argv);
}

/// <reference path="../../core/nri/nri_interop.d.ts" />

namespace BufferDeviceAddressNri {
    // buffer_device_address, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead
    // of Donut and NVRHI: the same shaders (buffer_device_address.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws. This example creates everything
    // it runs, and does the rendering.

    const WINDOW_TITLE = "NRI Example: Buffer Device Address";

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): not Vulkan, or no device
    // addresses.
    const TEST_SKIPPED = 77;

    // The sample's meshes: 64 of 16 x 16 vertices (float2 positions), drawn as triangle strips, 15
    // strips of 2 x 16 indices each closed by a primitive restart index.
    const MESH_COUNT = 64;
    const MESH_WIDTH = 16;
    const MESH_HEIGHT = 16;
    const MESH_STRIPS = MESH_HEIGHT - 1;
    const MESH_INDICES_PER_STRIP = 2 * MESH_WIDTH;
    const MESH_NUM_INDICES = MESH_STRIPS * (MESH_INDICES_PER_STRIP + 1);
    const PRIMITIVE_RESTART = 0xFFFF;
    // A VkDeviceAddress, and a float2.
    const ADDRESS_SIZE = 8;
    const POSITION_SIZE = 8;

    // PushCompute { VkDeviceAddress table; float fract_time; } (16 bytes with its padding) and
    // PushVertex { glm::mat4 view_projection; VkDeviceAddress table; } (72 bytes), as floats; the
    // addresses' 8 bytes go in two of them.
    const PUSH_COMPUTE_FLOATS = 4;
    const PUSH_VERTEX_FLOATS = 18;

    // update_meshlets' dispatch: 8 x 8 threads a group, 2 x 2 groups a mesh, a mesh per z.
    const GROUPS_X = MESH_WIDTH / 8;
    const GROUPS_Y = MESH_HEIGHT / 8;

    // The render pass's clear color.
    const CLEAR_R = 0.033;
    const CLEAR_G = 0.073;
    const CLEAR_B = 0.133;

    // Test mode: the frames rendered, each 1/60 s.
    const TEST_FRAMES = 60;

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

    // --- Math (glm's, in float32: 4 x 4 matrices by columns), as the Donut example's -------------

    function multiply(a: number[], b: number[]) {
        let result: number[] = [];
        for (let column = 0; column < 4; column++) {
            for (let row = 0; row < 4; row++) {
                let sum = Math.fround(a[row] * b[column * 4]);
                for (let k = 1; k < 4; k++) {
                    sum = Math.fround(sum + Math.fround(a[k * 4 + row] * b[column * 4 + k]));
                }
                result.push(sum);
            }
        }
        return result;
    }

    // glm::perspective (right-handed, depth from 0 to 1, as the samples build glm).
    function perspective(fovy: number, aspect: number, zNear: number, zFar: number) {
        const tanHalfFovy = Math.fround(Math.tan(Math.fround(fovy / 2.0)));
        const near = Math.fround(zNear);
        const far = Math.fround(zFar);
        return [
            Math.fround(1.0 / Math.fround(Math.fround(aspect) * tanHalfFovy)), 0.0, 0.0, 0.0,
            0.0, Math.fround(1.0 / tanHalfFovy), 0.0, 0.0,
            0.0, 0.0, Math.fround(far / Math.fround(near - far)), -1.0,
            0.0, 0.0, -Math.fround(Math.fround(far * near) / Math.fround(far - near)), 0.0,
        ];
    }

    // glm::lookAt from (0, 0, 5) at the origin, y up: a translation by -5 along z.
    function lookAtOriginFromZ5() {
        return [
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, -5.0, 1.0,
        ];
    }

    // -test: checks the last frame, as the Donut example does: the corners are the clear color; the
    // meshes (in their red, green and dark checkers) cover a good part of the frame.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const corner = pixels[0] & 0xFFFFFF;
        let covered = 0;
        let colorful = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            if (p == corner) {
                continue;
            }
            covered++;
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r > b + 40 || g > b + 40) {
                colorful++;
            }
        }
        const coverage = covered / (width * height);
        console.log(`Coverage ${coverage}, colorful ${colorful / (width * height)}`);
        if (coverage < 0.2) {
            return `the meshes cover ${coverage} of the frame`;
        }
        if (colorful < covered / 4) {
            return "the meshes don't have their red and green colors";
        }
        return "";
    }

    // Port of Vulkan-Samples' buffer_device_address (as examples/buffer_device_address.ts ports
    // it) to NRI: 64 meshes animated by a compute shader and drawn instanced, every one of them in
    // a buffer that the shaders reach only through its device address (a GPU pointer). A table of
    // the 64 addresses is in a buffer the CPU writes, and its own address goes in push constants: no
    // descriptor sets, no vertex buffers. The vertex shader loads its instance's mesh address from
    // the table and its vertex by index. Vulkan only: D3D shaders have no pointers.
    class BufferDeviceAddress {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private computeLayout: NriPipelineLayoutHandle | null = null;
        private computePipeline: NriPipelineHandle | null = null;
        private drawLayout: NriPipelineLayoutHandle | null = null;
        private drawPipeline: NriPipelineHandle | null = null;
        private meshBuffers: NriBufferHandle[] = [];
        private pointerBuffer: NriBufferHandle | null = null;
        private indexBuffer: NriBufferHandle | null = null;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // The meshes' addresses (two floats' bits each), the push constants (the table's address in
        // them from the start), the animation time.
        private pointers: f32[] = [];
        private pushCompute: f32[] = [];
        private pushVertex: f32[] = [];
        private accumulatedTime: number = 0.0;
        // The meshes are written by the compute shader (after the first frame they're read by the
        // vertex shader).
        private meshesDrawn: boolean = false;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < MESH_COUNT * 2; i++) {
                this.pointers.push(0.0);
            }
            for (let i = 0; i < PUSH_COMPUTE_FLOATS; i++) {
                this.pushCompute.push(0.0);
            }
            for (let i = 0; i < PUSH_VERTEX_FLOATS; i++) {
                this.pushVertex.push(0.0);
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

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, queuedFrameNum + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            const viewFormat = Nri_GetSrgbFormat(format);
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(this.swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, viewFormat),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }

            // Queued frames
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator)));
            }

            // Device addresses are Vulkan's.
            if (graphicsAPI != NriGraphicsAPI.VK) {
                this.unsupportedReason = "The Buffer Device Address example can only run on Vulkan API.";
                return 0;
            }

            // create_vbo_buffers: the meshes' buffers, which the shaders write and read only through
            // their device addresses, and the table of those addresses (written once: they don't
            // change; the sample uploads it every frame).
            const zeros: f32[] = [];
            for (let i = 0; i < MESH_WIDTH * MESH_HEIGHT * 2; i++) {
                zeros.push(0.0);
            }
            for (let i = 0; i < MESH_COUNT; i++) {
                const buffer = Nri_CreateStorageBuffer(device, this.queue, Ref(zeros[0]), MESH_WIDTH * MESH_HEIGHT * POSITION_SIZE, POSITION_SIZE);
                if (!buffer) {
                    console.log("Cannot create the meshes' buffers");
                    return 0;
                }
                this.meshBuffers.push(buffer);
                if (Nri_GetBufferDeviceAddress(device, buffer, Ref(this.pointers[i * 2])) == 0) {
                    this.unsupportedReason = "The device doesn't support buffer device addresses (bufferDeviceAddress).";
                    return 0;
                }
            }
            const pointerBuffer = Nri_CreateHostBufferWithStride(device, MESH_COUNT * ADDRESS_SIZE, NriBufferUsage.StructuredBuffer, ADDRESS_SIZE);
            this.pointerBuffer = pointerBuffer;
            if (!pointerBuffer) {
                console.log("Cannot create the pointer buffer");
                return 0;
            }
            Nri_WriteBuffer(pointerBuffer, 0, Ref(this.pointers[0]), MESH_COUNT * ADDRESS_SIZE);
            Nri_GetBufferDeviceAddress(device, pointerBuffer, Ref(this.pushCompute[0]));
            Nri_GetBufferDeviceAddress(device, pointerBuffer, Ref(this.pushVertex[16]));

            // create_index_buffer: the strips' 16-bit indices, two to an int.
            const indices16: int[] = [];
            for (let strip = 0; strip < MESH_STRIPS; strip++) {
                for (let x = 0; x < MESH_WIDTH; x++) {
                    indices16.push(strip * MESH_WIDTH + x);
                    indices16.push((strip + 1) * MESH_WIDTH + x);
                }
                indices16.push(PRIMITIVE_RESTART);
            }
            if (indices16.length % 2 != 0) {
                indices16.push(0);
            }
            const indices: int[] = [];
            for (let i = 0; i < indices16.length; i += 2) {
                indices.push(indices16[i] | (indices16[i + 1] << 16));
            }
            this.indexBuffer = Nri_CreateUploadedBufferFromInts(device, this.queue, Ref(indices[0]), indices.length * 4, NriBufferUsage.IndexBuffer);

            // The pipelines' layouts: push constants only.
            const computeLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(computeLayoutDesc, 0, PUSH_COMPUTE_FLOATS * 4, NriStage.Compute);
            this.computeLayout = Nri_CreatePipelineLayoutFromDesc(device, computeLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(computeLayoutDesc);
            const drawLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(drawLayoutDesc, 0, PUSH_VERTEX_FLOATS * 4, NriStage.Vertex);
            this.drawLayout = Nri_CreatePipelineLayoutFromDesc(device, drawLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(drawLayoutDesc);
            const computeLayout = this.computeLayout;
            const drawLayout = this.drawLayout;
            if (!computeLayout || !drawLayout || !this.indexBuffer) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: buffer_device_address.hlsl's shaders, as compiled for the Donut example;
            // the sample's: triangle strips with primitive restart, no culling, no depth test, no
            // vertex attributes.
            const shaders = "shaders/buffer_device_address/spirv/buffer_device_address";
            this.computePipeline = Nri_CreateComputePipeline(device, computeLayout, `${shaders}_update_vbo_cs.bin`, "update_vbo_cs");
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_render_vs.bin`, "render_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_render_ps.bin`, "render_ps") != 0;
            }
            Nri_PipelineDescSetTopology(desc, NriTopology.TriangleStrip);
            Nri_PipelineDescSetPrimitiveRestart(desc, NriIndexType.UInt16);
            Nri_PipelineDescSetColor(desc, viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.drawPipeline = Nri_CreatePipelineFromDesc(device, drawLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            if (!this.computePipeline || !this.drawPipeline) {
                console.log("Cannot load the buffer device address shaders");
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

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // render: the time advances 0.2 a second, kept to a fraction.
        update() {
            const elapsedSeconds = this.test ? 1.0 / 60.0 : Nri_GetFrameTime(this.sample);
            this.accumulatedTime = Math.fround(this.accumulatedTime + Math.fround(0.2 * Math.fround(elapsedSeconds)));
            this.accumulatedTime = Math.fround(this.accumulatedTime - Math.floor(this.accumulatedTime));
        }

        // update_meshlets: the compute shader writes every mesh through its address. The barriers
        // before and after are on the meshes' buffers, which the shaders reach without descriptors.
        recordCompute(commandBuffer: NriCommandBufferHandle) {
            const computeLayout = this.computeLayout;
            const computePipeline = this.computePipeline;
            if (!computeLayout || !computePipeline) {
                return;
            }
            if (this.meshesDrawn) {
                for (const buffer of this.meshBuffers) {
                    Nri_CmdBufferBarrier(commandBuffer, buffer, NriBufferState.VertexShaderResource, NriBufferState.Storage);
                }
            }
            this.pushCompute[2] = this.accumulatedTime;
            Nri_CmdSetComputePipelineLayout(commandBuffer, computeLayout);
            Nri_CmdSetPipeline(commandBuffer, computePipeline);
            Nri_CmdSetComputeRootConstants(commandBuffer, 0, Ref(this.pushCompute[0]), PUSH_COMPUTE_FLOATS * 4);
            Nri_CmdDispatch(commandBuffer, GROUPS_X, GROUPS_Y, MESH_COUNT);
            for (const buffer of this.meshBuffers) {
                Nri_CmdBufferBarrier(commandBuffer, buffer, NriBufferState.Storage, NriBufferState.VertexShaderResource);
            }
            this.meshesDrawn = true;
        }

        // The render pass: an ad-hoc perspective (90 degrees, depth 1 to 100) from (0, 0, 5), its
        // clip y negated for Donut's shaders, and the table's address; a mesh per instance (between
        // Nri_CmdBeginRendering and Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle) {
            const drawLayout = this.drawLayout;
            const drawPipeline = this.drawPipeline;
            const indexBuffer = this.indexBuffer;
            if (!drawLayout || !drawPipeline || !indexBuffer) {
                return;
            }
            const projection = perspective(Math.fround(0.5 * Math.fround(Math.PI)),
                Math.fround(Math.fround(this.width) / Math.fround(this.height)), 1.0, 100.0);
            const viewProjection = multiply(projection, lookAtOriginFromZ5());
            for (let i = 0; i < 16; i++) {
                this.pushVertex[i] = i % 4 == 1 ? -viewProjection[i] : viewProjection[i];
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, drawLayout);
            Nri_CmdSetPipeline(commandBuffer, drawPipeline);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.pushVertex[0]), PUSH_VERTEX_FLOATS * 4);
            Nri_CmdSetIndexBuffer(commandBuffer, indexBuffer, 0, NriIndexType.UInt16);
            Nri_CmdDrawIndexed(commandBuffer, MESH_NUM_INDICES, MESH_COUNT, 0, 0, 0);
        }

        renderFrame(frameIndex: int) {
            const queuedFrame = this.queuedFrames[frameIndex % this.queuedFrames.length];
            this.update();

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record
                Nri_BeginCommandBuffer(commandBuffer);
                this.recordCompute(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                Nri_CmdClearColor(commandBuffer, CLEAR_R, CLEAR_G, CLEAR_B, 1.0);
                this.recordDraw(commandBuffer);
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
                for (const buffer of this.meshBuffers) {
                    Nri_DestroyBuffer(buffer);
                }
                this.destroyBuffer(this.pointerBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.computePipeline);
                this.destroyPipeline(this.drawPipeline);
                const computeLayout = this.computeLayout;
                if (computeLayout) {
                    Nri_DestroyPipelineLayout(computeLayout);
                }
                const drawLayout = this.drawLayout;
                if (drawLayout) {
                    Nri_DestroyPipelineLayout(drawLayout);
                }
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
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
        const bufferDeviceAddress = new BufferDeviceAddress(Nri_CreateSample());
        return bufferDeviceAddress.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return BufferDeviceAddressNri.main(argc, argv);
}

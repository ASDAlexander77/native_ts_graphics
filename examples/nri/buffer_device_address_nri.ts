/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { Nri, NriBuffer, NriCommandBuffer, NriDevice, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample } from "../../core/nri";

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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;
        private computeLayout: NriPipelineLayout | null = null;
        private computePipeline: NriPipeline | null = null;
        private drawLayout: NriPipelineLayout | null = null;
        private drawPipeline: NriPipeline | null = null;
        private meshBuffers: NriBuffer[] = [];
        private pointerBuffer: NriBuffer | null = null;
        private indexBuffer: NriBuffer | null = null;
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
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);

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
                const buffer = device.createStorageBuffer(this.queue, Ref(zeros[0]), MESH_WIDTH * MESH_HEIGHT * POSITION_SIZE, POSITION_SIZE);
                if (!buffer) {
                    console.log("Cannot create the meshes' buffers");
                    return 0;
                }
                this.meshBuffers.push(buffer);
                if (device.getBufferAddress(buffer, Ref(this.pointers[i * 2])) == 0) {
                    this.unsupportedReason = "The device doesn't support buffer device addresses (bufferDeviceAddress).";
                    return 0;
                }
            }
            const pointerBuffer = device.createHostBufferWithStride(MESH_COUNT * ADDRESS_SIZE, NriBufferUsage.StructuredBuffer, ADDRESS_SIZE);
            this.pointerBuffer = pointerBuffer;
            if (!pointerBuffer) {
                console.log("Cannot create the pointer buffer");
                return 0;
            }
            pointerBuffer.write(0, Ref(this.pointers[0]), MESH_COUNT * ADDRESS_SIZE);
            device.getBufferAddress(pointerBuffer, Ref(this.pushCompute[0]));
            device.getBufferAddress(pointerBuffer, Ref(this.pushVertex[16]));

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
            this.indexBuffer = device.createUploadedBufferFromInts(this.queue, Ref(indices[0]), indices.length * 4, NriBufferUsage.IndexBuffer);

            // The pipelines' layouts: push constants only.
            const computeLayoutDesc = NriPipelineLayoutDesc.create();
            computeLayoutDesc.addRootConstants(0, PUSH_COMPUTE_FLOATS * 4, NriStage.Compute);
            this.computeLayout = device.createPipelineLayoutFromDesc(computeLayoutDesc);
            computeLayoutDesc.destroy();
            const drawLayoutDesc = NriPipelineLayoutDesc.create();
            drawLayoutDesc.addRootConstants(0, PUSH_VERTEX_FLOATS * 4, NriStage.Vertex);
            this.drawLayout = device.createPipelineLayoutFromDesc(drawLayoutDesc);
            drawLayoutDesc.destroy();
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
            this.computePipeline = device.createComputePipeline(computeLayout, `${shaders}_update_vbo_cs.bin`, "update_vbo_cs");
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_render_vs.bin`, "render_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_render_ps.bin`, "render_ps") != 0;
            }
            desc.setTopology(NriTopology.TriangleStrip);
            desc.setPrimitiveRestart(NriIndexType.UInt16);
            desc.setColor(viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.drawPipeline = device.createPipelineFromDesc(drawLayout, desc);
            }
            desc.destroy();
            if (!this.computePipeline || !this.drawPipeline) {
                console.log("Cannot load the buffer device address shaders");
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

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // render: the time advances 0.2 a second, kept to a fraction.
        update() {
            const elapsedSeconds = this.test ? 1.0 / 60.0 : this.sample.getFrameTime();
            this.accumulatedTime = Math.fround(this.accumulatedTime + Math.fround(0.2 * Math.fround(elapsedSeconds)));
            this.accumulatedTime = Math.fround(this.accumulatedTime - Math.floor(this.accumulatedTime));
        }

        // update_meshlets: the compute shader writes every mesh through its address. The barriers
        // before and after are on the meshes' buffers, which the shaders reach without descriptors.
        recordCompute(commandBuffer: NriCommandBuffer) {
            const computeLayout = this.computeLayout;
            const computePipeline = this.computePipeline;
            if (!computeLayout || !computePipeline) {
                return;
            }
            if (this.meshesDrawn) {
                for (const buffer of this.meshBuffers) {
                    commandBuffer.bufferBarrier(buffer, NriBufferState.VertexShaderResource, NriBufferState.Storage);
                }
            }
            this.pushCompute[2] = this.accumulatedTime;
            commandBuffer.setComputePipelineLayout(computeLayout);
            commandBuffer.setPipeline(computePipeline);
            commandBuffer.setComputeRootConstants(0, Ref(this.pushCompute[0]), PUSH_COMPUTE_FLOATS * 4);
            commandBuffer.dispatch(GROUPS_X, GROUPS_Y, MESH_COUNT);
            for (const buffer of this.meshBuffers) {
                commandBuffer.bufferBarrier(buffer, NriBufferState.Storage, NriBufferState.VertexShaderResource);
            }
            this.meshesDrawn = true;
        }

        // The render pass: an ad-hoc perspective (90 degrees, depth 1 to 100) from (0, 0, 5), its
        // clip y negated for Donut's shaders, and the table's address; a mesh per instance (between
        // NriCommandBuffer.beginRendering and NriCommandBuffer.endRendering).
        recordDraw(commandBuffer: NriCommandBuffer) {
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
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(drawLayout);
            commandBuffer.setPipeline(drawPipeline);
            commandBuffer.setRootConstants(0, Ref(this.pushVertex[0]), PUSH_VERTEX_FLOATS * 4);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt16);
            commandBuffer.drawIndexed(MESH_NUM_INDICES, MESH_COUNT, 0, 0, 0);
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
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
                this.recordCompute(commandBuffer);
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                commandBuffer.clearColor(CLEAR_R, CLEAR_G, CLEAR_B, 1.0);
                this.recordDraw(commandBuffer);
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
                for (const buffer of this.meshBuffers) {
                    buffer.destroy();
                }
                this.destroyBuffer(this.pointerBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.readbackBuffer);
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
        const bufferDeviceAddress = new BufferDeviceAddress(sample);
        return bufferDeviceAddress.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return BufferDeviceAddressNri.main(argc, argv);
}

/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { identity, multiply, rotate, translation, radians, perspective } from "../../core/matrix";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDevice, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriRandomEngine, NriSample, NriTexture } from "../../core/nri";

namespace DynamicUniformBuffersNri {
    // dynamic_uniform_buffers, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework
    // instead of Donut and NVRHI: the same shaders (dynamic_uniform_buffers.hlsl's), through the NRI
    // calls core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws. The sample's dynamic
    // uniform buffer is a root descriptor here (a push descriptor on Vulkan), bound per draw with
    // the cube's offset, as the sample's dynamic offsets are (the Donut example has a binding set per
    // slice instead).

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Dynamic Uniform Buffers";

    // The cubes: a 5 x 5 x 5 grid, 5 units apart.
    const OBJECT_INSTANCES = 125;
    const DIM = 5;
    const OFFSET = 5.0;

    // Each cube's model matrix lives in its own slice of the buffer; D3D binds constant buffers at
    // multiples of 256 bytes (the sample's dynamic offsets are multiples of
    // minUniformBufferOffsetAlignment).
    const DYNAMIC_ALIGNMENT = 256;
    const DYNAMIC_FLOATS = DYNAMIC_ALIGNMENT / 4;

    // struct UboView { float4x4 projection, view; }, in a 256-byte slice.
    const UBO_PROJECTION = 0;
    const UBO_VIEW = 16;
    const UBO_FLOATS = 32;
    const UBO_SIZE = 256;

    // A frame in flight's part of the constant buffer: the view, then the cubes' slices.
    const FRAME_CONSTANTS_SIZE = UBO_SIZE + OBJECT_INSTANCES * DYNAMIC_ALIGNMENT;

    // The cube's vertices: float3 position, float3 color.
    const VERTEX_FLOATS = 6;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const CUBE_VERTICES = [
        -1.0, -1.0, 1.0, 1.0, 0.0, 0.0,
        1.0, -1.0, 1.0, 0.0, 1.0, 0.0,
        1.0, 1.0, 1.0, 0.0, 0.0, 1.0,
        -1.0, 1.0, 1.0, 0.0, 0.0, 0.0,
        -1.0, -1.0, -1.0, 1.0, 0.0, 0.0,
        1.0, -1.0, -1.0, 0.0, 1.0, 0.0,
        1.0, 1.0, -1.0, 0.0, 0.0, 1.0,
        -1.0, 1.0, -1.0, 0.0, 0.0, 0.0,
    ];
    const CUBE_INDICES = [
        0, 1, 2, 2, 3, 0, 1, 5, 6, 6, 2, 1, 7, 6, 5, 5, 4, 7,
        4, 0, 3, 3, 7, 4, 4, 5, 1, 1, 0, 4, 3, 2, 6, 6, 7, 3,
    ];

    // The sample's look-at camera at (0, 0, -30) (vkb::Camera's position, the view's translation),
    // not turned; reversed depth from 0.1 to 256.
    const CAMERA_POSITION = [0.0, 0.0, -30.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // ApiVulkanSample's default_clear_color.
    const CLEAR_COLOR = 0.002;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // -test: checks the last frame, read back. The corners are the dark clear color; the cubes, each
    // with its own transform from the dynamic uniform buffer, color about a third of the frame.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != 0x070707) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 7, 7, 7`;
            }
        }
        // Colored: channels at least 61 apart.
        let count = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            const high = Math.max(Math.max(r, g), b);
            const low = Math.min(Math.min(r, g), b);
            if (high - low >= 61) {
                count++;
            }
        }
        const percent = 100.0 * count / (width * height);
        console.log(`Cubes: ${percent}% (${count} of ${width * height} pixels)`);
        if (percent < 25.0 || percent > 40.0) {
            return `Cubes: ${percent}% of the pixels, not 25% to 40%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' dynamic_uniform_buffers (as examples/dynamic_uniform_buffers.ts ports
    // it) to NRI: 125 spinning colored cubes, one draw each, all their model matrices in one uniform
    // buffer, each draw binding its slice by offset. The left mouse button turns the camera, the right
    // one and the wheel zoom, the middle one pans (ApiVulkanSample's).
    class DynamicUniformBuffers {
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
        // The constant buffer (FRAME_CONSTANTS_SIZE a frame in flight), and the views the root
        // descriptors bind at offsets in it: the view's, and a cube's.
        private constantBuffer: NriBuffer | null = null;
        private viewConstants: NriDescriptor | null = null;
        private modelConstants: NriDescriptor | null = null;
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views' (the swap chain's).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private swapChainViewFormat: NriFormat = NriFormat.Unknown;

        // The camera: vkb::Camera's rotation (degrees) and position.
        private cameraRotation: number[] = [0.0, 0.0, 0.0];
        private cameraPosition: number[] = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];

        // The cubes' rotations and rotation speeds (x, y, z each), and the time since the last
        // update (the sample updates at 60 per second at most).
        private rotations: number[] = [];
        private rotationSpeeds: number[] = [];
        private animationTimer: number = 0.0;
        // -benchmark: 1/60 second per frame, and the random engine seeded with 0 (the framework's
        // lock_simulation_speed), as vulkan_samples' --benchmark.
        benchmark: boolean = false;
        // -pause: not animating (the sample's paused).
        paused: boolean = false;

        // Upload buffers.
        private ubo: f32[] = [];
        private models: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < UBO_SIZE / 4; i++) {
                this.ubo.push(0.0);
            }
            for (let i = 0; i < OBJECT_INSTANCES * DYNAMIC_FLOATS; i++) {
                this.models.push(0.0);
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

            // The depth buffer: D32, cleared to 0 (reversed).
            if (!this.createDepth(device)) {
                return 0;
            }

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);

            // The cube
            let vertices = CUBE_VERTICES.map((v): f32 => v);
            let indices = CUBE_INDICES.map((v): int => v);
            this.vertexBuffer = device.createUploadedBuffer(this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            this.indexBuffer = device.createUploadedBufferFromInts(this.queue, Ref(indices[0]), indices.length * 4, NriBufferUsage.IndexBuffer);
            if (!this.vertexBuffer || !this.indexBuffer) {
                console.log("Cannot create the cube's buffers");
                return 0;
            }

            // The constant buffer, a part per frame in flight, and its views: the view's (b0) and a
            // cube's (b1), bound by offset.
            const constantBuffer = device.createHostBuffer(queuedFrameNum * FRAME_CONSTANTS_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            if (!constantBuffer) {
                console.log("Cannot create the constant buffer");
                return 0;
            }
            this.viewConstants = constantBuffer.createConstantView(0, UBO_SIZE);
            this.modelConstants = constantBuffer.createConstantView(0, DYNAMIC_ALIGNMENT);

            // The layout: the two constant buffers as root descriptors, for the vertex shader.
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRootDescriptor(0, NriDescriptorType.ConstantBuffer, NriStage.Vertex);
            layoutDesc.addRootDescriptor(1, NriDescriptorType.ConstantBuffer, NriStage.Vertex);
            this.pipelineLayout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The sample's pipeline: dynamic_uniform_buffers.hlsl's shaders, as compiled for the
            // Donut example; no culling, depth tested (greater: reversed) and written.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/dynamic_uniform_buffers/${folder}/dynamic_uniform_buffers`;
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_base_vs.bin`, "base_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_base_ps.bin`, "base_ps") != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("COLOR", NriFormat.RGB32_SFLOAT, 12);
            desc.setColor(viewFormat, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            if (loaded) {
                this.pipeline = device.createPipelineFromDesc(pipelineLayout, desc);
            }
            desc.destroy();
            if (!this.pipeline) {
                console.log("Cannot load the dynamic uniform buffers shaders");
                return 0;
            }

            // The sample's prepare_uniform_buffers: random rotations and speeds, from a normal
            // distribution of mean -1 and deviation 1 (the engine seeded with the time, or 0 with
            // -benchmark). MSVC evaluates the sample's vec3(rnd, rnd, rnd) from the last argument:
            // z, y, x.
            const rng = NriRandomEngine.create(this.benchmark ? 0 : -1);
            const values: f32[] = [];
            for (let i = 0; i < OBJECT_INSTANCES * 6; i++) {
                values.push(0.0);
            }
            rng.randomNormalFloats(-1.0, 1.0, values.length, Ref(values[0]));
            rng.destroy();
            for (let i = 0; i < OBJECT_INSTANCES; i++) {
                for (let k = 0; k < 3; k++) {
                    this.rotations.push(Math.fround(Math.fround(values[i * 6 + 2 - k] * 2.0) * Math.fround(Math.PI)));
                    this.rotationSpeeds.push(values[i * 6 + 5 - k]);
                }
            }
            this.updateModels(0.0);

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The sample's update_dynamic_uniform_buffer: each cube's rotations advanced by the time since
        // the last update times its speeds (in float, as the sample), its model matrix: moved to its
        // place in the grid, turned around (1, 1, 0), then y, then z.
        updateModels(time: number) {
            const diagonal = 1.0 / Math.sqrt(2.0);
            for (let x = 0; x < DIM; x++) {
                for (let y = 0; y < DIM; y++) {
                    for (let z = 0; z < DIM; z++) {
                        const index = x * DIM * DIM + y * DIM + z;
                        for (let k = 0; k < 3; k++) {
                            this.rotations[index * 3 + k] = Math.fround(this.rotations[index * 3 + k]
                                + Math.fround(time * this.rotationSpeeds[index * 3 + k]));
                        }
                        let m = identity();
                        m[12] = -((DIM * OFFSET) / 2.0) + OFFSET / 2.0 + x * OFFSET;
                        m[13] = -((DIM * OFFSET) / 2.0) + OFFSET / 2.0 + y * OFFSET;
                        m[14] = -((DIM * OFFSET) / 2.0) + OFFSET / 2.0 + z * OFFSET;
                        m = rotate(m, this.rotations[index * 3], diagonal, diagonal, 0.0);
                        m = rotate(m, this.rotations[index * 3 + 1], 0.0, 1.0, 0.0);
                        m = rotate(m, this.rotations[index * 3 + 2], 0.0, 0.0, 1.0);
                        for (let i = 0; i < 16; i++) {
                            this.models[index * DYNAMIC_FLOATS + i] = m[i];
                        }
                    }
                }
            }
        }

        // ApiVulkanSample's mouse: the left button turns, the right one zooms, the middle one pans
        // (speeds 1); the wheel zooms.
        updateCamera() {
            const dx = -this.sample.getMouseDeltaX();
            const dy = -this.sample.getMouseDeltaY();
            if (this.sample.isButtonPressed(0) != 0) {
                this.cameraRotation[0] += dy;
                this.cameraRotation[1] -= dx;
            }
            if (this.sample.isButtonPressed(1) != 0) {
                this.cameraPosition[2] += dy * 0.005;
            }
            if (this.sample.isButtonPressed(2) != 0) {
                this.cameraPosition[0] -= dx * 0.01;
                this.cameraPosition[1] -= dy * 0.01;
            }
            this.cameraPosition[2] += this.sample.getMouseWheel() * 0.005;
        }

        // vkb::Camera::update_view_matrix: translate(position) * rotations around x, y, z.
        view() {
            let r = identity();
            r = rotate(r, radians(this.cameraRotation[0]), 1.0, 0.0, 0.0);
            r = rotate(r, radians(this.cameraRotation[1]), 0.0, 1.0, 0.0);
            r = rotate(r, radians(this.cameraRotation[2]), 0.0, 0.0, 1.0);
            return multiply(translation(this.cameraPosition[0], this.cameraPosition[1], this.cameraPosition[2]), r);
        }

        // Waits for the frame that last used this frame's command allocator (and its part of the
        // constant buffer).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The cubes' matrices at most 60 times a second; the view's every frame; written into this
        // frame's part of the constant buffer.
        updateConstants(frameOffset: int, constantBuffer: NriBuffer) {
            if (!this.paused) {
                // In test mode 1/60 second a frame, as Donut's test mode.
                const deltaTime = this.benchmark || this.test ? 1.0 / 60.0 : this.sample.getFrameTime();
                this.animationTimer = Math.fround(this.animationTimer + Math.fround(deltaTime));
                if (this.animationTimer + 0.0025 >= Math.fround(1.0 / 60.0)) {
                    this.updateModels(this.animationTimer);
                    this.animationTimer = 0.0;
                }
            }
            this.updateCamera();

            // The sample's update_uniform_buffers: its projection (clip y negated for Donut's y-up
            // clip space, as the shaders expect) and view.
            const projection = perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            const view = this.view();
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.ubo[UBO_VIEW + i] = view[i];
            }
            constantBuffer.write(frameOffset, Ref(this.ubo[0]), UBO_FLOATS * 4);
            constantBuffer.write(frameOffset + UBO_SIZE, Ref(this.models[0]), OBJECT_INSTANCES * DYNAMIC_ALIGNMENT);
        }

        // One draw per cube, each binding its slice of this frame's part of the constant buffer.
        recordCubes(commandBuffer: NriCommandBuffer, frameOffset: int) {
            const pipelineLayout = this.pipelineLayout;
            const pipeline = this.pipeline;
            const vertexBuffer = this.vertexBuffer;
            const indexBuffer = this.indexBuffer;
            const viewConstants = this.viewConstants;
            const modelConstants = this.modelConstants;
            if (!pipelineLayout || !pipeline || !vertexBuffer || !indexBuffer) {
                return;
            }
            if (!viewConstants || !modelConstants) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(pipelineLayout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
            commandBuffer.setVertexBuffer(0, vertexBuffer, 0, VERTEX_SIZE);
            commandBuffer.setRootDescriptor(0, viewConstants, frameOffset);
            for (let j = 0; j < OBJECT_INSTANCES; j++) {
                commandBuffer.setRootDescriptor(1, modelConstants, frameOffset + UBO_SIZE + j * DYNAMIC_ALIGNMENT);
                commandBuffer.drawIndexed(CUBE_INDICES.length, 1, 0, 0, 0);
            }
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
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

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.frames.size();
            const frameOffset = queuedFrameIndex * FRAME_CONSTANTS_SIZE;
            const constantBuffer = this.constantBuffer;
            if (constantBuffer) {
                this.updateConstants(frameOffset, constantBuffer);
            }

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: color cleared to the default clear color, depth to 0 (reversed).
                commandBuffer.begin();
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                const depthAttachment = this.depthAttachment;
                if (depthAttachment) {
                    commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
                    commandBuffer.clearColor(CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
                    commandBuffer.clearDepth(0.0);
                    this.recordCubes(commandBuffer, frameOffset);
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
                const pipeline = this.pipeline;
                if (pipeline) {
                    pipeline.destroy();
                }
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    pipelineLayout.destroy();
                }
                const viewConstants = this.viewConstants;
                if (viewConstants) {
                    viewConstants.destroy();
                }
                const modelConstants = this.modelConstants;
                if (modelConstants) {
                    modelConstants.destroy();
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
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const dynamicUniformBuffers = new DynamicUniformBuffers(sample);
        // -benchmark: 1/60 second per frame and seed 0 (vulkan_samples' --benchmark); -pause: the
        // cubes not turning.
        sample.addExampleOption("-benchmark");
        sample.addExampleOption("-pause");
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-benchmark") {
                dynamicUniformBuffers.benchmark = true;
            } else if (arg == "-pause") {
                dynamicUniformBuffers.paused = true;
            }
        }
        return dynamicUniformBuffers.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return DynamicUniformBuffersNri.main(argc, argv);
}

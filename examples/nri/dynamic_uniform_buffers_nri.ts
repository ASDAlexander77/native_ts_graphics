/// <reference path="../../core/nri/nri_interop.d.ts" />
import { identity, multiply, rotate, translation, radians, perspective } from "../../core/matrix";

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
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private pipelineLayout: NriPipelineLayoutHandle | null = null;
        private pipeline: NriPipelineHandle | null = null;
        private vertexBuffer: NriBufferHandle | null = null;
        private indexBuffer: NriBufferHandle | null = null;
        // The constant buffer (FRAME_CONSTANTS_SIZE a frame in flight), and the views the root
        // descriptors bind at offsets in it: the view's, and a cube's.
        private constantBuffer: NriBufferHandle | null = null;
        private viewConstants: NriDescriptorHandle | null = null;
        private modelConstants: NriDescriptorHandle | null = null;
        private width: int = 0;
        private height: int = 0;

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
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
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
            Nri_SetInitializeCallback(this.sample, initialize);
            Nri_SetLatencySleepCallback(this.sample, latencySleep);
            Nri_SetRenderFrameCallback(this.sample, renderFrame);

            let result = Nri_RunSample(this.sample, argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (result == 0 && this.test) {
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

            // The depth buffer: D32, cleared to 0 (reversed).
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

            // The cube
            let vertices = CUBE_VERTICES.map((v): f32 => v);
            let indices = CUBE_INDICES.map((v): int => v);
            this.vertexBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            this.indexBuffer = Nri_CreateUploadedBufferFromInts(device, this.queue, Ref(indices[0]), indices.length * 4, NriBufferUsage.IndexBuffer);
            if (!this.vertexBuffer || !this.indexBuffer) {
                console.log("Cannot create the cube's buffers");
                return 0;
            }

            // The constant buffer, a part per frame in flight, and its views: the view's (b0) and a
            // cube's (b1), bound by offset.
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * FRAME_CONSTANTS_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            if (!constantBuffer) {
                console.log("Cannot create the constant buffer");
                return 0;
            }
            this.viewConstants = Nri_CreateConstantBufferView(constantBuffer, 0, UBO_SIZE);
            this.modelConstants = Nri_CreateConstantBufferView(constantBuffer, 0, DYNAMIC_ALIGNMENT);

            // The layout: the two constant buffers as root descriptors, for the vertex shader.
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootDescriptor(layoutDesc, 0, NriDescriptorType.ConstantBuffer, NriStage.Vertex);
            Nri_PipelineLayoutDescAddRootDescriptor(layoutDesc, 1, NriDescriptorType.ConstantBuffer, NriStage.Vertex);
            this.pipelineLayout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The sample's pipeline: dynamic_uniform_buffers.hlsl's shaders, as compiled for the
            // Donut example; no culling, depth tested (greater: reversed) and written.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/dynamic_uniform_buffers/${folder}/dynamic_uniform_buffers`;
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_base_vs.bin`, "base_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_base_ps.bin`, "base_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "COLOR", NriFormat.RGB32_SFLOAT, 12);
            Nri_PipelineDescSetColor(desc, viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            if (loaded) {
                this.pipeline = Nri_CreatePipelineFromDesc(device, pipelineLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            if (!this.pipeline) {
                console.log("Cannot load the dynamic uniform buffers shaders");
                return 0;
            }

            // The sample's prepare_uniform_buffers: random rotations and speeds, from a normal
            // distribution of mean -1 and deviation 1 (the engine seeded with the time, or 0 with
            // -benchmark). MSVC evaluates the sample's vec3(rnd, rnd, rnd) from the last argument:
            // z, y, x.
            const rng = Nri_CreateRandomEngine(this.benchmark ? 0 : -1);
            const values: f32[] = [];
            for (let i = 0; i < OBJECT_INSTANCES * 6; i++) {
                values.push(0.0);
            }
            Nri_RandomNormalFloats(rng, -1.0, 1.0, values.length, Ref(values[0]));
            Nri_DestroyRandomEngine(rng);
            for (let i = 0; i < OBJECT_INSTANCES; i++) {
                for (let k = 0; k < 3; k++) {
                    this.rotations.push(Math.fround(Math.fround(values[i * 6 + 2 - k] * 2.0) * Math.fround(Math.PI)));
                    this.rotationSpeeds.push(values[i * 6 + 5 - k]);
                }
            }
            this.updateModels(0.0);

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
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
            const dx = -Nri_GetMouseDeltaX(this.sample);
            const dy = -Nri_GetMouseDeltaY(this.sample);
            if (Nri_IsButtonPressed(this.sample, 0) != 0) {
                this.cameraRotation[0] += dy;
                this.cameraRotation[1] -= dx;
            }
            if (Nri_IsButtonPressed(this.sample, 1) != 0) {
                this.cameraPosition[2] += dy * 0.005;
            }
            if (Nri_IsButtonPressed(this.sample, 2) != 0) {
                this.cameraPosition[0] -= dx * 0.01;
                this.cameraPosition[1] -= dy * 0.01;
            }
            this.cameraPosition[2] += Nri_GetMouseWheel(this.sample) * 0.005;
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
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The cubes' matrices at most 60 times a second; the view's every frame; written into this
        // frame's part of the constant buffer.
        updateConstants(frameOffset: int, constantBuffer: NriBufferHandle) {
            if (!this.paused) {
                // In test mode 1/60 second a frame, as Donut's test mode.
                const deltaTime = this.benchmark || this.test ? 1.0 / 60.0 : Nri_GetFrameTime(this.sample);
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
            Nri_WriteBuffer(constantBuffer, frameOffset, Ref(this.ubo[0]), UBO_FLOATS * 4);
            Nri_WriteBuffer(constantBuffer, frameOffset + UBO_SIZE, Ref(this.models[0]), OBJECT_INSTANCES * DYNAMIC_ALIGNMENT);
        }

        // One draw per cube, each binding its slice of this frame's part of the constant buffer.
        recordCubes(commandBuffer: NriCommandBufferHandle, frameOffset: int) {
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
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, pipelineLayout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetIndexBuffer(commandBuffer, indexBuffer, 0, NriIndexType.UInt32);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, vertexBuffer, 0, VERTEX_SIZE);
            Nri_CmdSetRootDescriptor(commandBuffer, 0, viewConstants, frameOffset);
            for (let j = 0; j < OBJECT_INSTANCES; j++) {
                Nri_CmdSetRootDescriptor(commandBuffer, 1, modelConstants, frameOffset + UBO_SIZE + j * DYNAMIC_ALIGNMENT);
                Nri_CmdDrawIndexed(commandBuffer, CUBE_INDICES.length, 1, 0, 0, 0);
            }
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            const frameOffset = queuedFrameIndex * FRAME_CONSTANTS_SIZE;
            const constantBuffer = this.constantBuffer;
            if (constantBuffer) {
                this.updateConstants(frameOffset, constantBuffer);
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: color cleared to the default clear color, depth to 0 (reversed).
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                const depthAttachment = this.depthAttachment;
                if (depthAttachment) {
                    Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                    Nri_CmdClearColor(commandBuffer, CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
                    Nri_CmdClearDepth(commandBuffer, 0.0);
                    this.recordCubes(commandBuffer, frameOffset);
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
                    Nri_DestroyCommandBuffer(queuedFrame.commandBuffer);
                    Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
                }
                for (const swapChainTexture of this.swapChainTextures) {
                    Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                    Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                    Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
                }
                const pipeline = this.pipeline;
                if (pipeline) {
                    Nri_DestroyPipeline(pipeline);
                }
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    Nri_DestroyPipelineLayout(pipelineLayout);
                }
                const viewConstants = this.viewConstants;
                if (viewConstants) {
                    Nri_DestroyDescriptor(viewConstants);
                }
                const modelConstants = this.modelConstants;
                if (modelConstants) {
                    Nri_DestroyDescriptor(modelConstants);
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
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const dynamicUniformBuffers = new DynamicUniformBuffers(sample);
        // -benchmark: 1/60 second per frame and seed 0 (vulkan_samples' --benchmark); -pause: the
        // cubes not turning.
        Nri_AddExampleOption(sample, "-benchmark");
        Nri_AddExampleOption(sample, "-pause");
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
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

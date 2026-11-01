/// <reference path="../../core/nri/nri_interop.d.ts" />
import { dot3, matrixInverse, matrixMultiply, matrixPerspectiveFovRH } from "../../core/directx_math";
import { SimpleCamera } from "../../core/simple_camera";
import { MsvcRandom } from "../../core/random";

namespace NBodyGravityNri {
    // n_body_gravity, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (n_body_gravity_draw.hlsl's and n_body_gravity_cs.hlsl's),
    // through the NRI calls core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws. This
    // example creates everything it runs, and does the rendering. SimpleCamera's keys are Donut's Key
    // values (GLFW's key codes), which Nri_IsKeyPressed takes.

    const WINDOW_TITLE = "NRI Example: D3D12 n-Body Gravity Simulation";

    // The sample's particles: two groups of 5000 in spheres of radius 400, 200 left and right of the
    // middle. The step's thread groups take 128 each: the buffers have room for 79 groups, the
    // elements past the particles zero (the sample's out of bounds reads).
    const PARTICLE_COUNT = 10000;
    const PARTICLE_SPREAD = 400.0;
    const BLOCK_SIZE = 128;
    const GROUP_COUNT = 79;
    const PARTICLE_STRIDE = 32;

    // The push constants: the draw's world-view-projection and inverse view matrices; the step's
    // particle count, group count, time step and damping.
    const DRAW_CONSTANT_FLOATS = 32;
    const STEP_CONSTANT_FLOATS = 8;

    // The sample's clear color, (0, 0, 0.1, 0).
    const CLEAR_B = 0.1;

    // Simulation steps per frame (-steps), as the Donut example's.
    const DEFAULT_STEPS_PER_FRAME = 10;

    // Test mode: the frames rendered (200 steps at the default steps per frame).
    const TEST_FRAMES = 20;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no shaders for the graphics API
    // (D3D11).
    const TEST_SKIPPED = 77;

    // SimpleCamera's keys.
    const CAMERA_KEYS = [Key.W, Key.A, Key.S, Key.D, Key.Left, Key.Right, Key.Up, Key.Down];

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

    // A particle buffer, its views (read, and written) and its state (an NriBufferState).
    class ParticleBuffer {
        state: NriBufferState = NriBufferState.Storage;

        constructor(public buffer: NriBufferHandle, public view: NriDescriptorHandle, public storage: NriDescriptorHandle) {
        }
    }

    // The sample's RandomPercent over MSVC's rand() seeded with srand(0), as it does for each group, in
    // float: -1 to 1.
    function randomPercent(rand: MsvcRandom) {
        const value = Math.fround((rand.next() % 10000) - 5000);
        return Math.fround(value / 5000.0);
    }

    // The sample's LoadParticles: count particles at random within a sphere of radius spread around
    // (centerX, 0, 0), their mass (10000 * 10000) in position.w, all moving along z at velocityZ.
    function loadParticles(data: f32[], first: int, count: int, centerX: number, velocityZ: number, spread: number) {
        const rand = new MsvcRandom(0);
        const spreadSquared = Math.fround(spread * spread);
        for (let i = 0; i < count; i++) {
            let delta = [spread, spread, spread, 0.0];
            while (dot3(delta, delta) > spreadSquared) {
                const x = Math.fround(randomPercent(rand) * spread);
                const y = Math.fround(randomPercent(rand) * spread);
                const z = Math.fround(randomPercent(rand) * spread);
                delta = [x, y, z, 0.0];
            }
            const base = (first + i) * 8;
            data[base] = Math.fround(centerX + delta[0]);
            data[base + 1] = delta[1];
            data[base + 2] = delta[2];
            data[base + 3] = 100000000.0;
            data[base + 4] = 0.0;
            data[base + 5] = 0.0;
            data[base + 6] = velocityZ;
            data[base + 7] = Math.fround(1.0 / 100000000.0);
        }
    }

    // -test: checks the last frame, read back, as the Donut example does. The corners are the clear
    // color; the clusters (merging by then) show as bright, mostly yellow pixels, in both the left
    // and the right half of the frame.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        // The clear color: 0.1 is 25 of 255 in the UNORM back buffer (26 where 25.5 rounds up).
        const corners = [0, width - 1, (height - 1) * width, height * width - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[corners[k]] & 0xFFFFFF;
            const blue = (p >> 16) & 0xFF;
            if ((p & 0xFFFF) != 0 || blue < 25 || blue > 26) {
                return `corner pixel ${corners[k]} is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not the clear color`;
            }
        }
        // Bright pixels (red over 128) in each half, and the yellow ones (green over 128 too).
        let left = 0;
        let right = 0;
        let yellow = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const p = pixels[y * width + x];
                const r = p & 0xFF;
                const g = (p >> 8) & 0xFF;
                if (r <= 128) {
                    continue;
                }
                if (x < width / 2) {
                    left++;
                } else {
                    right++;
                }
                if (g > 128) {
                    yellow++;
                }
            }
        }
        console.log(`Bright pixels: left ${left}, right ${right}, yellow ${yellow}`);
        const minimum = (width * height) / 50;
        if (left < minimum || right < minimum) {
            return `bright pixels left ${left}, right ${right}: not both ${minimum} or more`;
        }
        if (yellow * 2 < left + right) {
            return `${yellow} of ${left + right} bright pixels are yellow, not half or more`;
        }
        return "";
    }

    // Port of DirectX-Graphics-Samples' D3D12nBodyGravity (as examples/n_body_gravity.ts ports it)
    // to NRI: two clusters of 5000 particles, every particle pulling on every other (an n-body
    // simulation in a compute shader), drawn as additive point sprites, yellow turning red with
    // their acceleration. Each frame steps the simulation a set number of times (-steps), ping-ponging
    // between two particle buffers, then draws the latest: in the frame's command buffer, as the Donut
    // example does where there's no compute queue (the sample steps on a compute queue from a CPU
    // thread of its own). The camera is the sample's SimpleCamera, moved by a tenth of a second per
    // frame as the sample's.
    class NBodyGravity {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private drawLayout: NriPipelineLayoutHandle | null = null;
        private drawPipeline: NriPipelineHandle | null = null;
        private stepLayout: NriPipelineLayoutHandle | null = null;
        private stepPipeline: NriPipelineHandle | null = null;
        private vertexBuffer: NriBufferHandle | null = null;
        private particleBuffers: ParticleBuffer[] = [];
        // The particle buffer the next step reads and the draw shows (the sample's m_srvIndex).
        private srvIndex: int = 0;
        private camera: SimpleCamera = new SimpleCamera();
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // Upload buffers.
        private drawConstants: f32[] = [];
        // The sample's cbCS: param (particle count, group count), paramf (time step, damping).
        private stepConstants: f32[] = [PARTICLE_COUNT, GROUP_COUNT, 0.0, 0.0, 0.1, 1.0, 0.0, 0.0];

        // -steps <n>: simulation steps per frame.
        stepsPerFrame: int = DEFAULT_STEPS_PER_FRAME;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < DRAW_CONSTANT_FLOATS; i++) {
                this.drawConstants.push(0.0);
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

            // Swap chain: rendered through UNORM views, as the sample's R8G8B8A8_UNORM back buffer.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, queuedFrameNum + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            this.viewFormat = format;
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

            // Shader model 6's shaders only (as the Donut example's).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (n_body_gravity's shaders are compiled for D3D12 and Vulkan only)";
                return 0;
            }

            // The sample's root signatures: the draw's constants and particles (t0); the step's
            // constants, particles read (t0) and written (u0).
            const drawLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(drawLayoutDesc, 0, DRAW_CONSTANT_FLOATS * 4, NriStage.VertexGeometry);
            Nri_PipelineLayoutDescAddRootDescriptor(drawLayoutDesc, 0, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            this.drawLayout = Nri_CreatePipelineLayoutFromDesc(device, drawLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(drawLayoutDesc);
            const stepLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(stepLayoutDesc, 0, STEP_CONSTANT_FLOATS * 4, NriStage.Compute);
            Nri_PipelineLayoutDescAddRootDescriptor(stepLayoutDesc, 0, NriDescriptorType.StructuredBuffer, NriStage.Compute);
            Nri_PipelineLayoutDescAddRootDescriptor(stepLayoutDesc, 0, NriDescriptorType.StorageStructuredBuffer, NriStage.Compute);
            this.stepLayout = Nri_CreatePipelineLayoutFromDesc(device, stepLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(stepLayoutDesc);
            const drawLayout = this.drawLayout;
            const stepLayout = this.stepLayout;
            if (!drawLayout || !stepLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: the shaders as compiled for the Donut example. The draw's: points the
            // geometry shader makes quads of, the particles' color per vertex, back faces culled,
            // blended additively by the sprites' alpha (alpha written as 0), no depth.
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/n_body_gravity/${folder}`;
            this.stepPipeline = Nri_CreateComputePipeline(device, stepLayout, `${shaders}/n_body_gravity_cs_CSMain.bin`, "CSMain");
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}/n_body_gravity_draw_VSParticleDraw.bin`,
                "VSParticleDraw") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Geometry, `${shaders}/n_body_gravity_draw_GSParticleDraw.bin`,
                    "GSParticleDraw") != 0;
            }
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}/n_body_gravity_draw_PSParticleDraw.bin`,
                    "PSParticleDraw") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "COLOR", NriFormat.RGBA32_SFLOAT, 0);
            Nri_PipelineDescSetTopology(desc, NriTopology.PointList);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            Nri_PipelineDescSetColor(desc, format, NriColorWrite.RGBA);
            Nri_PipelineDescSetBlend(desc, NriBlendFactor.SrcAlpha, NriBlendFactor.One, NriBlendOp.Add, NriBlendFactor.Zero, NriBlendFactor.Zero,
                NriBlendOp.Add);
            if (loaded) {
                this.drawPipeline = Nri_CreatePipelineFromDesc(device, drawLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            if (!this.stepPipeline || !this.drawPipeline) {
                console.log("Cannot load the n-body gravity shaders");
                return 0;
            }

            // CreateVertexBuffer and CreateParticleBuffers: the particles all yellow; the two groups
            // moving along z, 20 a second either way, in both particle buffers.
            const data: f32[] = [];
            for (let i = 0; i < GROUP_COUNT * BLOCK_SIZE * 8; i++) {
                data.push(0.0);
            }
            const centerSpread = Math.fround(PARTICLE_SPREAD * 0.5);
            loadParticles(data, 0, PARTICLE_COUNT / 2, centerSpread, -20.0, PARTICLE_SPREAD);
            loadParticles(data, PARTICLE_COUNT / 2, PARTICLE_COUNT / 2, -centerSpread, 20.0, PARTICLE_SPREAD);
            const colors: f32[] = [];
            for (let i = 0; i < PARTICLE_COUNT; i++) {
                colors.push(1.0);
                colors.push(1.0);
                colors.push(Math.fround(0.2));
                colors.push(1.0);
            }
            this.vertexBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(colors[0]), PARTICLE_COUNT * 16, NriBufferUsage.VertexBuffer);
            for (let i = 0; i < 2; i++) {
                const buffer = Nri_CreateStorageBuffer(device, this.queue, Ref(data[0]), GROUP_COUNT * BLOCK_SIZE * PARTICLE_STRIDE,
                    PARTICLE_STRIDE);
                if (!buffer) {
                    console.log("Cannot create the particle buffers");
                    return 0;
                }
                const view = Nri_CreateStructuredBufferView(buffer, 0);
                const storage = Nri_CreateStructuredBufferView(buffer, 1);
                if (!view || !storage) {
                    console.log("Cannot create the particle buffers' views");
                    return 0;
                }
                this.particleBuffers.push(new ParticleBuffer(buffer, view, storage));
            }
            if (!this.vertexBuffer) {
                console.log("Cannot create the vertex buffer");
                return 0;
            }

            // The sample's camera: 1500 back from the middle, 250 a second.
            this.camera.init(0.0, 0.0, 1500.0);
            this.camera.setMoveSpeed(250.0);

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

        // OnUpdate: the camera (its keys), by a tenth of a second whatever the frame time (as the
        // sample's); its constants, view * projection and the view's inverse (row vectors, as the
        // shaders' row_major matrices take them).
        update() {
            for (const key of CAMERA_KEYS) {
                this.camera.onKey(key, Nri_IsKeyPressed(this.sample, key) != 0);
            }
            this.camera.update(Math.fround(0.1));
            const view = this.camera.viewMatrix();
            const aspectRatio = Math.fround(Math.fround(this.width) / Math.fround(this.height));
            const projection = matrixPerspectiveFovRH(Math.fround(0.8), aspectRatio, 1.0, 5000.0);
            const worldViewProjection = matrixMultiply(view, projection);
            const inverseView = matrixInverse(view);
            for (let k = 0; k < 16; k++) {
                this.drawConstants[k] = worldViewProjection[k];
                this.drawConstants[16 + k] = inverseView[k];
            }
        }

        // Moves the particle buffer to state (an NriBufferState), if it isn't in it.
        transition(commandBuffer: NriCommandBufferHandle, particleBuffer: ParticleBuffer, state: NriBufferState) {
            if (particleBuffer.state != state) {
                Nri_CmdBufferBarrier(commandBuffer, particleBuffer.buffer, particleBuffer.state, state);
                particleBuffer.state = state;
            }
        }

        // The sample's Simulate, stepsPerFrame times: each step reads one particle buffer and writes
        // the other, which the next step reads; the last one written goes to the draw.
        recordSteps(commandBuffer: NriCommandBufferHandle) {
            const stepLayout = this.stepLayout;
            const stepPipeline = this.stepPipeline;
            if (!stepLayout || !stepPipeline) {
                return;
            }
            Nri_CmdSetComputePipelineLayout(commandBuffer, stepLayout);
            Nri_CmdSetPipeline(commandBuffer, stepPipeline);
            for (let i = 0; i < this.stepsPerFrame; i++) {
                const source = this.particleBuffers[this.srvIndex];
                const destination = this.particleBuffers[1 - this.srvIndex];
                this.transition(commandBuffer, source, NriBufferState.VertexAndComputeShaderResource);
                // a step's writes before the next step's (the same state: a UAV barrier)
                Nri_CmdBufferBarrier(commandBuffer, destination.buffer, destination.state, NriBufferState.Storage);
                destination.state = NriBufferState.Storage;
                Nri_CmdSetComputeRootConstants(commandBuffer, 0, Ref(this.stepConstants[0]), STEP_CONSTANT_FLOATS * 4);
                Nri_CmdSetComputeRootDescriptor(commandBuffer, 0, source.view);
                Nri_CmdSetComputeRootDescriptor(commandBuffer, 1, destination.storage);
                Nri_CmdDispatch(commandBuffer, GROUP_COUNT, 1, 1);
                this.srvIndex = 1 - this.srvIndex;
            }
            this.transition(commandBuffer, this.particleBuffers[this.srvIndex], NriBufferState.VertexAndComputeShaderResource);
        }

        // The particles from the buffer the last step wrote (between Nri_CmdBeginRendering and
        // Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle) {
            const drawLayout = this.drawLayout;
            const drawPipeline = this.drawPipeline;
            const vertexBuffer = this.vertexBuffer;
            if (!drawLayout || !drawPipeline || !vertexBuffer) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, drawLayout);
            Nri_CmdSetPipeline(commandBuffer, drawPipeline);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.drawConstants[0]), DRAW_CONSTANT_FLOATS * 4);
            Nri_CmdSetRootDescriptor(commandBuffer, 0, this.particleBuffers[this.srvIndex].view, 0);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, vertexBuffer, 0, 16);
            Nri_CmdDraw(commandBuffer, PARTICLE_COUNT, 1, 0, 0);
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

                // Record: the steps; cleared to the sample's dark blue, the particles.
                Nri_BeginCommandBuffer(commandBuffer);
                this.recordSteps(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                Nri_CmdClearColor(commandBuffer, 0.0, 0.0, CLEAR_B, 0.0);
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
                for (const particleBuffer of this.particleBuffers) {
                    Nri_DestroyDescriptor(particleBuffer.view);
                    Nri_DestroyDescriptor(particleBuffer.storage);
                    Nri_DestroyBuffer(particleBuffer.buffer);
                }
                const vertexBuffer = this.vertexBuffer;
                if (vertexBuffer) {
                    Nri_DestroyBuffer(vertexBuffer);
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
                }
                this.destroyPipeline(this.stepPipeline);
                this.destroyPipeline(this.drawPipeline);
                this.destroyLayout(this.stepLayout);
                this.destroyLayout(this.drawLayout);
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }

        destroyPipeline(pipeline: NriPipelineHandle | null) {
            if (pipeline) {
                Nri_DestroyPipeline(pipeline);
            }
        }

        destroyLayout(layout: NriPipelineLayoutHandle | null) {
            if (layout) {
                Nri_DestroyPipelineLayout(layout);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const nBodyGravity = new NBodyGravity(sample);
        // -steps <n>: simulation steps per frame (10 by default).
        Nri_AddExampleOptionWithValues(sample, "-steps", 1);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-steps" && i + 1 < argc) {
                nBodyGravity.stepsPerFrame = parseInt(Nri_GetArg(argc, argv, i + 1));
                i++;
            }
        }
        return nBodyGravity.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return NBodyGravityNri.main(argc, argv);
}

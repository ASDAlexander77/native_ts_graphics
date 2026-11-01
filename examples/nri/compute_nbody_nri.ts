/// <reference path="../../core/nri/nri_interop.d.ts" />
import { radians, perspProjD3DStyleReverse } from "../../core/matrix";
import { randomFloat } from "../../core/random";

namespace ComputeNBodyNri {
    // compute_nbody, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (compute_nbody.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws. This example creates everything
    // it runs, and does the rendering.

    const WINDOW_TITLE = "NRI Example: Compute N-Body";

    const NUM_ATTRACTORS = 6;
    const PARTICLES_PER_ATTRACTOR = 4 * 1024;
    // Test mode: the frames rendered (5 seconds).
    const TEST_FRAMES = 300;
    // calculate_cs / integrate_cs in compute_nbody.hlsl run 256 threads per group.
    const WORKGROUP_SIZE = 256;
    // struct Particle: float4 pos, float4 vel.
    const PARTICLE_FLOATS = 8;
    // struct SimulationConstants: float deltaT, int particleCount.
    const SIMULATION_CONSTANTS_SIZE = 8;
    // The quad each particle is drawn as (main_vs).
    const VERTICES_PER_PARTICLE = 6;

    // PlanarViewConstants (donut/shaders/view_cb.h): ten float4x4, eight float2, a float4; the
    // fields main_vs reads, in floats.
    const VIEW_CONSTANTS_SIZE = 720;
    const MAT_WORLD_TO_VIEW = 0;
    const MAT_VIEW_TO_CLIP = 16;
    const VIEWPORT_ORIGIN = 160;
    const VIEWPORT_SIZE = 162;
    const VIEWPORT_SIZE_INV = 164;
    // A queued frame's part of the constant buffer, and its view's size (D3D12: a multiple of 256 bytes).
    const VIEW_CONSTANTS_STRIDE = 768;

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

    // std::normal_distribution<float>(0, 1) replacement: Box-Muller over randomFloat, which never
    // returns 0 (as the Donut example draws them).
    function randomNormal() {
        const u1 = randomFloat();
        const u2 = randomFloat();
        return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    }

    // A float32 value is finite.
    function isFinite32(x: number): boolean {
        return x > -1.0e38 && x < 1.0e38;
    }

    // Quaternion product a * b, (w, x, y, z), in float32 as donut::math's.
    function quatMultiply(a: number[], b: number[]) {
        const f = Math.fround;
        return [
            f(f(f(f(a[0] * b[0]) - f(a[1] * b[1])) - f(a[2] * b[2])) - f(a[3] * b[3])),
            f(f(f(f(a[0] * b[1]) + f(a[1] * b[0])) + f(a[2] * b[3])) - f(a[3] * b[2])),
            f(f(f(f(a[0] * b[2]) + f(a[2] * b[0])) + f(a[3] * b[1])) - f(a[1] * b[3])),
            f(f(f(f(a[0] * b[3]) + f(a[3] * b[0])) + f(a[1] * b[2])) - f(a[2] * b[1])),
        ];
    }

    // Donut's ThirdPersonCamera, as the Donut example uses it: orbiting target at distance,
    // turned by yaw and pitch (the left mouse button drags them, the wheel zooms). Its world-to-view
    // matrix in float32, as Donut computes it.
    class ThirdPersonCamera {
        target: number[] = [0.0, 0.0, 0.0];
        distance: number = 0.0;
        yaw: number = 0.0;
        pitch: number = 0.0;
        // mouse sensitivity in radians/pixel
        rotateSpeed: number = 0.005;

        // Row-major, for row vectors (Donut's affineToHomogeneous(m_MatWorldToView)).
        worldToView: number[] = [];

        // The sample's ThirdPersonCamera::Animate with the mouse's motion.
        animate(sample: NriSampleHandle) {
            const f = Math.fround;
            if (Nri_IsButtonPressed(sample, 0) != 0) {
                this.yaw = f(this.yaw - f(this.rotateSpeed * f(Nri_GetMouseDeltaX(sample))));
                this.pitch = f(this.pitch + f(this.rotateSpeed * f(Nri_GetMouseDeltaY(sample))));
                this.pitch = Math.min(Math.max(this.pitch, f(-0.5 * Math.PI)), f(0.5 * Math.PI));
            }
            const wheel = Nri_GetMouseWheel(sample);
            if (wheel != 0.0) {
                this.distance = f(wheel < 0.0 ? this.distance * f(1.15) : this.distance * f(1.0 / f(1.15)));
            }

            // rotationQuat(float3(pitch, yaw, 0)).toMatrix()
            const halfX = f(0.5 * this.pitch);
            const halfY = f(0.5 * this.yaw);
            const quatX = [f(Math.cos(halfX)), f(Math.sin(halfX)), 0.0, 0.0];
            const quatY = [f(Math.cos(halfY)), 0.0, f(Math.sin(halfY)), 0.0];
            const quatZ = [1.0, 0.0, 0.0, 0.0];
            const q = quatMultiply(quatMultiply(quatZ, quatY), quatX);
            const w = q[0];
            const x = q[1];
            const y = q[2];
            const z = q[3];
            const row0 = [f(1.0 - f(2.0 * f(f(y * y) + f(z * z)))), f(2.0 * f(f(x * y) + f(z * w))), f(2.0 * f(f(x * z) - f(y * w)))];
            const row1 = [f(2.0 * f(f(x * y) - f(z * w))), f(1.0 - f(2.0 * f(f(x * x) + f(z * z)))), f(2.0 * f(f(y * z) + f(x * w)))];
            const row2 = [f(2.0 * f(f(x * z) + f(y * w))), f(2.0 * f(f(y * z) - f(x * w))), f(1.0 - f(2.0 * f(f(x * x) + f(y * y))))];

            // The camera at target - distance * forward; right = -row0, up = row1, forward = row2.
            const camPos = [0.0, 0.0, 0.0];
            const right = [0.0, 0.0, 0.0];
            for (let i = 0; i < 3; i++) {
                camPos[i] = f(this.target[i] + f(f(-this.distance) * row2[i]));
                right[i] = -row0[i];
            }

            // translation(-camPos) * affine3::from_cols(right, up, forward, 0)
            const columns = [right, row1, row2];
            const m: number[] = [];
            for (let r = 0; r < 3; r++) {
                for (let c = 0; c < 3; c++) {
                    m.push(columns[c][r]);
                }
                m.push(0.0);
            }
            for (let c = 0; c < 3; c++) {
                const column = columns[c];
                m.push(f(f(f(f(-camPos[0]) * column[0]) + f(f(-camPos[1]) * column[1])) + f(f(-camPos[2]) * column[2])));
            }
            m.push(1.0);
            this.worldToView = m;
        }
    }

    // Port of Vulkan-Samples' compute_nbody (as examples/compute_nbody.ts ports it) to NRI: an
    // N-body simulation in two compute passes (velocities from the gravity of the other particles,
    // with group shared memory; then positions), drawn as additively blended sprites. The compute
    // passes go into the frame's command buffer ahead of the draw, as in the Donut example, with
    // the particle buffer's barriers between them.
    class ComputeNBody {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private computeLayout: NriPipelineLayoutHandle | null = null;
        private calculatePipeline: NriPipelineHandle | null = null;
        private integratePipeline: NriPipelineHandle | null = null;
        private drawLayout: NriPipelineLayoutHandle | null = null;
        private drawPipeline: NriPipelineHandle | null = null;
        private particleBuffer: NriBufferHandle | null = null;
        // The particles, written by the compute passes and read by the draw.
        private particlesStorage: NriDescriptorHandle | null = null;
        private particlesView: NriDescriptorHandle | null = null;
        // A queued frame's view constants each, VIEW_CONSTANTS_STRIDE bytes apart.
        private constantBuffer: NriBufferHandle | null = null;
        private viewConstantsView: NriDescriptorHandle | null = null;
        // The particle buffer's state between frames (Storage before the first).
        private particlesDrawn: boolean = false;
        private camera: ThirdPersonCamera = new ThirdPersonCamera();
        private numParticles: int = 0;
        private paused: boolean = false;
        private width: int = 0;
        private height: int = 0;

        // The SimulationConstants push constants, and the PlanarViewConstants.
        private simulationConstants: f32[] = [0.0, 0.0];
        private viewConstants: f32[] = [];

        // -test: the last frame and the particles after it are read back.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private particleReadbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < VIEW_CONSTANTS_SIZE / 4; i++) {
                this.viewConstants.push(0.0);
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
                const failure = this.checkTest();
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

            // The layouts: the compute passes' SimulationConstants (push constants, b0) and particles
            // (u0); the draw's view constants (b1) and particles (t0). All root descriptors.
            const computeLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(computeLayoutDesc, 0, SIMULATION_CONSTANTS_SIZE, NriStage.Compute);
            Nri_PipelineLayoutDescAddRootDescriptor(computeLayoutDesc, 0, NriDescriptorType.StorageStructuredBuffer, NriStage.Compute);
            this.computeLayout = Nri_CreatePipelineLayoutFromDesc(device, computeLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(computeLayoutDesc);
            const drawLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootDescriptor(drawLayoutDesc, 1, NriDescriptorType.ConstantBuffer, NriStage.Vertex);
            Nri_PipelineLayoutDescAddRootDescriptor(drawLayoutDesc, 0, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            this.drawLayout = Nri_CreatePipelineLayoutFromDesc(device, drawLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(drawLayoutDesc);
            const computeLayout = this.computeLayout;
            const drawLayout = this.drawLayout;
            if (!computeLayout || !drawLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: compute_nbody.hlsl's shaders, as compiled for the Donut example; the
            // draw additively blended, back faces culled (NVRHI's default raster state).
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/compute_nbody/${folder}/compute_nbody`;
            this.calculatePipeline = Nri_CreateComputePipeline(device, computeLayout, `${shaders}_calculate_cs.bin`, "calculate_cs");
            this.integratePipeline = Nri_CreateComputePipeline(device, computeLayout, `${shaders}_integrate_cs.bin`, "integrate_cs");
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_main_vs.bin`, "main_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_main_ps.bin`, "main_ps") != 0;
            }
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            Nri_PipelineDescSetColor(desc, viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetAdditiveBlend(desc);
            if (loaded) {
                this.drawPipeline = Nri_CreatePipelineFromDesc(device, drawLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            if (!this.calculatePipeline || !this.integratePipeline || !this.drawPipeline) {
                console.log("Cannot load the compute n-body shaders");
                return 0;
            }

            const particleBuffer = this.createParticles(device);
            this.particleBuffer = particleBuffer;
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * VIEW_CONSTANTS_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            if (!particleBuffer || !constantBuffer) {
                console.log("Cannot create the buffers");
                return 0;
            }
            this.particlesStorage = Nri_CreateStructuredBufferView(particleBuffer, 1);
            this.particlesView = Nri_CreateStructuredBufferView(particleBuffer, 0);
            this.viewConstantsView = Nri_CreateConstantBufferView(constantBuffer, 0, VIEW_CONSTANTS_STRIDE);
            if (!this.particlesStorage || !this.particlesView || !this.viewConstantsView) {
                console.log("Cannot create the buffer views");
                return 0;
            }
            Nri_StoreInt32(Ref(this.simulationConstants[1]), this.numParticles);

            // The sample's look-at camera: 14 units from the origin, rotated (-26, 75) degrees.
            this.camera.distance = 14.0;
            this.camera.yaw = Math.fround(radians(75.0));
            this.camera.pitch = Math.fround(radians(26.0));

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.particleReadbackBuffer = Nri_CreateReadbackBuffer(device, this.numParticles * PARTICLE_FLOATS * 4);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The sample's prepare_storage_buffers: the particles around their attractors, uploaded
        // once (the Donut example's numbers: the same random generator).
        createParticles(device: NriDeviceHandle): NriBufferHandle | null {
            const attractors: number[] = [
                5.0, 0.0, 0.0,
                -5.0, 0.0, 0.0,
                0.0, 0.0, 5.0,
                0.0, 0.0, -5.0,
                0.0, 4.0, 0.0,
                0.0, -8.0, 0.0,
            ];
            this.numParticles = NUM_ATTRACTORS * PARTICLES_PER_ATTRACTOR;

            const particles: f32[] = [];
            for (let i = 0; i < this.numParticles * PARTICLE_FLOATS; i++) {
                particles.push(0.0);
            }

            for (let i = 0; i < NUM_ATTRACTORS; i++) {
                const ax = attractors[i * 3 + 0];
                const ay = attractors[i * 3 + 1];
                const az = attractors[i * 3 + 2];

                for (let j = 0; j < PARTICLES_PER_ATTRACTOR; j++) {
                    const p = (i * PARTICLES_PER_ATTRACTOR + j) * PARTICLE_FLOATS;

                    if (j == 0) {
                        // First particle in group as heavy center of gravity
                        particles[p + 0] = ax * 1.5;
                        particles[p + 1] = ay * 1.5;
                        particles[p + 2] = az * 1.5;
                        particles[p + 3] = 90000.0;
                    } else {
                        // Position. The sample then scales y by 2 - length(normalize(position -
                        // attractor))^2, which is 1.
                        const px = ax + randomNormal() * 0.75;
                        const py = ay + randomNormal() * 0.75;
                        const pz = az + randomNormal() * 0.75;

                        // Velocity: cross(position - attractor, angular) plus some randomness.
                        const sign = i % 2 == 0 ? 1.0 : -1.0;
                        const angularX = 0.5 * sign;
                        const angularY = 1.5 * sign;
                        const angularZ = 0.5 * sign;
                        const ex = px - ax;
                        const ey = py - ay;
                        const ez = pz - az;
                        const vx = ey * angularZ - ez * angularY + randomNormal();
                        const vy = ez * angularX - ex * angularZ + randomNormal();
                        const vz = ex * angularY - ey * angularX + randomNormal() * 0.025;

                        const mass = (randomNormal() * 0.5 + 0.5) * 75.0;
                        particles[p + 0] = px;
                        particles[p + 1] = py;
                        particles[p + 2] = pz;
                        particles[p + 3] = mass;
                        particles[p + 4] = vx;
                        particles[p + 5] = vy;
                        particles[p + 6] = vz;
                    }

                    // Color gradient offset
                    particles[p + 7] = i / NUM_ATTRACTORS;
                }
            }

            return Nri_CreateStorageBuffer(device, this.queue, Ref(particles[0]), this.numParticles * PARTICLE_FLOATS * 4, PARTICLE_FLOATS * 4);
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The sample's OnUpdate: the camera, the time step (none when paused; space toggles it), the
        // window title.
        update() {
            if (Nri_IsKeyToggled(this.sample, NriKey.Space) != 0) {
                this.paused = !this.paused;
            }
            this.camera.animate(this.sample);
            const elapsedSeconds = this.test ? 1.0 / 60.0 : Nri_GetFrameTime(this.sample);
            this.simulationConstants[0] = this.paused ? 0.0 : elapsedSeconds;
            Nri_SetWindowTitle(this.sample,
                this.paused ? `${WINDOW_TITLE} - ${this.numParticles} particles (paused)` : `${WINDOW_TITLE} - ${this.numParticles} particles`);
        }

        // The view constants main_vs reads, for this frame (the camera; 60 degrees vertically, as
        // in the sample), into the queued frame's part of the constant buffer.
        writeViewConstants(offset: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            const projection = perspProjD3DStyleReverse(radians(60.0), this.width / this.height, 0.1);
            const worldToView = this.camera.worldToView;
            for (let i = 0; i < 16; i++) {
                this.viewConstants[MAT_WORLD_TO_VIEW + i] = worldToView[i];
                this.viewConstants[MAT_VIEW_TO_CLIP + i] = projection[i];
            }
            this.viewConstants[VIEWPORT_ORIGIN] = 0.0;
            this.viewConstants[VIEWPORT_ORIGIN + 1] = 0.0;
            this.viewConstants[VIEWPORT_SIZE] = this.width;
            this.viewConstants[VIEWPORT_SIZE + 1] = this.height;
            this.viewConstants[VIEWPORT_SIZE_INV] = 1.0 / Math.fround(this.width);
            this.viewConstants[VIEWPORT_SIZE_INV + 1] = 1.0 / Math.fround(this.height);
            Nri_WriteBuffer(constantBuffer, offset, Ref(this.viewConstants[0]), VIEW_CONSTANTS_SIZE);
        }

        // First pass: calculate particle movement; second pass: integrate particles. The particles
        // then go to the draw.
        recordCompute(commandBuffer: NriCommandBufferHandle) {
            const computeLayout = this.computeLayout;
            const calculatePipeline = this.calculatePipeline;
            const integratePipeline = this.integratePipeline;
            const particleBuffer = this.particleBuffer;
            const particlesStorage = this.particlesStorage;
            if (!computeLayout || !calculatePipeline || !integratePipeline || !particleBuffer || !particlesStorage) {
                return;
            }
            if (this.particlesDrawn) {
                Nri_CmdBufferBarrier(commandBuffer, particleBuffer, NriBufferState.VertexShaderResource, NriBufferState.Storage);
            }
            const groups: int = Math.floor(this.numParticles / WORKGROUP_SIZE);
            Nri_CmdSetComputePipelineLayout(commandBuffer, computeLayout);
            Nri_CmdSetPipeline(commandBuffer, calculatePipeline);
            Nri_CmdSetComputeRootConstants(commandBuffer, 0, Ref(this.simulationConstants[0]), SIMULATION_CONSTANTS_SIZE);
            Nri_CmdSetComputeRootDescriptor(commandBuffer, 0, particlesStorage);
            Nri_CmdDispatch(commandBuffer, groups, 1, 1);
            Nri_CmdBufferBarrier(commandBuffer, particleBuffer, NriBufferState.Storage, NriBufferState.Storage);
            Nri_CmdSetPipeline(commandBuffer, integratePipeline);
            Nri_CmdSetComputeRootConstants(commandBuffer, 0, Ref(this.simulationConstants[0]), SIMULATION_CONSTANTS_SIZE);
            Nri_CmdSetComputeRootDescriptor(commandBuffer, 0, particlesStorage);
            Nri_CmdDispatch(commandBuffer, groups, 1, 1);
            Nri_CmdBufferBarrier(commandBuffer, particleBuffer, NriBufferState.Storage, NriBufferState.VertexShaderResource);
            this.particlesDrawn = true;
        }

        // The particles' sprites (between Nri_CmdBeginRendering and Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle, constantsOffset: int) {
            const drawLayout = this.drawLayout;
            const drawPipeline = this.drawPipeline;
            const viewConstantsView = this.viewConstantsView;
            const particlesView = this.particlesView;
            if (!drawLayout || !drawPipeline || !viewConstantsView || !particlesView) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, drawLayout);
            Nri_CmdSetPipeline(commandBuffer, drawPipeline);
            Nri_CmdSetRootDescriptor(commandBuffer, 0, viewConstantsView, constantsOffset);
            Nri_CmdSetRootDescriptor(commandBuffer, 1, particlesView, 0);
            Nri_CmdDraw(commandBuffer, this.numParticles * VERTICES_PER_PARTICLE, 1, 0, 0);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.update();

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;
                const constantsOffset = queuedFrameIndex * VIEW_CONSTANTS_STRIDE;
                this.writeViewConstants(constantsOffset);

                // Record
                Nri_BeginCommandBuffer(commandBuffer);
                this.recordCompute(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 1.0);
                this.recordDraw(commandBuffer, constantsOffset);
                Nri_CmdEndRendering(commandBuffer);

                // The test's last frame: read back, and the particles after it
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                        Nri_CmdReadbackTextureToBuffer(commandBuffer, readbackBuffer, this.rowPitch, swapChainTexture.texture, this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                        this.recordParticleReadback(commandBuffer);
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

        // Copies the particles to particleReadbackBuffer (after the last frame's draw).
        recordParticleReadback(commandBuffer: NriCommandBufferHandle) {
            const particleBuffer = this.particleBuffer;
            const particleReadbackBuffer = this.particleReadbackBuffer;
            if (!particleBuffer || !particleReadbackBuffer) {
                return;
            }
            Nri_CmdBufferBarrier(commandBuffer, particleBuffer, NriBufferState.VertexShaderResource, NriBufferState.CopySource);
            Nri_CmdCopyBuffer(commandBuffer, particleReadbackBuffer, particleBuffer, this.numParticles * PARTICLE_FLOATS * 4);
            Nri_CmdBufferBarrier(commandBuffer, particleBuffer, NriBufferState.CopySource, NriBufferState.VertexShaderResource);
        }

        // -test, as the Donut example checks: the particles after the last frame, every position
        // and velocity finite, then the frame: black corners, and particles drawn.
        checkTest(): string {
            const device = this.device;
            const particleReadbackBuffer = this.particleReadbackBuffer;
            if (!device || !particleReadbackBuffer) {
                return "cannot read the particles back";
            }
            Nri_DeviceWaitIdle(device);
            const particles: f32[] = [];
            for (let i = 0; i < this.numParticles * PARTICLE_FLOATS; i++) {
                particles.push(0.0);
            }
            if (Nri_ReadBufferFloats(particleReadbackBuffer, Ref(particles[0]), particles.length) == 0) {
                return "cannot read the particles back";
            }
            for (let i = 0; i < this.numParticles; i++) {
                for (let k = 0; k < 7; k++) {
                    // Position xyz, then velocity xyz (not w, the mass).
                    const value = particles[i * PARTICLE_FLOATS + k];
                    if (k != 3 && !isFinite32(value)) {
                        return `particle ${i}: ${k < 3 ? "position" : "velocity"} ${value} is not finite`;
                    }
                }
            }

            const pixels = this.readBack();
            if (pixels.length == 0) {
                return "cannot read the back buffer";
            }
            const xs = [0, this.width - 1, 0, this.width - 1];
            const ys = [0, 0, this.height - 1, this.height - 1];
            for (let k = 0; k < 4; k++) {
                const p = pixels[ys[k] * this.width + xs[k]] & 0xFFFFFF;
                if (p != 0) {
                    return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 0, 0, 0`;
                }
            }
            let drawn = 0;
            for (let i = 0; i < pixels.length; i++) {
                if ((pixels[i] & 0xFFFFFF) != 0) {
                    drawn++;
                }
            }
            console.log(`Particles: ${drawn} pixels drawn`);
            if (drawn < 1000) {
                return `Particles: ${drawn} pixels drawn, fewer than 1000`;
            }
            return "";
        }

        // The last frame's pixels (0xAABBGGRR), empty if it can't be read.
        readBack(): int[] {
            const readbackBuffer = this.readbackBuffer;
            if (!readbackBuffer) {
                return [];
            }
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
                this.destroyDescriptor(this.particlesStorage);
                this.destroyDescriptor(this.particlesView);
                this.destroyDescriptor(this.viewConstantsView);
                this.destroyBuffer(this.particleBuffer);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyBuffer(this.particleReadbackBuffer);
                this.destroyPipeline(this.calculatePipeline);
                this.destroyPipeline(this.integratePipeline);
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
        const computeNBody = new ComputeNBody(Nri_CreateSample());
        return computeNBody.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return ComputeNBodyNri.main(argc, argv);
}

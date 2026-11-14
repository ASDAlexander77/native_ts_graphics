/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { radians, perspProjD3DStyleReverse } from "../../core/matrix";
import { randomFloat } from "../../core/random";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDevice, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample } from "../../core/nri";

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
        animate(sample: NriSample) {
            const f = Math.fround;
            if (sample.isButtonPressed(0) != 0) {
                this.yaw = f(this.yaw - f(this.rotateSpeed * f(sample.getMouseDeltaX())));
                this.pitch = f(this.pitch + f(this.rotateSpeed * f(sample.getMouseDeltaY())));
                this.pitch = Math.min(Math.max(this.pitch, f(-0.5 * Math.PI)), f(0.5 * Math.PI));
            }
            const wheel = sample.getMouseWheel();
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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private computeLayout: NriPipelineLayout | null = null;
        private calculatePipeline: NriPipeline | null = null;
        private integratePipeline: NriPipeline | null = null;
        private drawLayout: NriPipelineLayout | null = null;
        private drawPipeline: NriPipeline | null = null;
        private particleBuffer: NriBuffer | null = null;
        // The particles, written by the compute passes and read by the draw.
        private particlesStorage: NriDescriptor | null = null;
        private particlesView: NriDescriptor | null = null;
        // A queued frame's view constants each, VIEW_CONSTANTS_STRIDE bytes apart.
        private constantBuffer: NriBuffer | null = null;
        private viewConstantsView: NriDescriptor | null = null;
        // The particle buffer's state between frames (Storage before the first).
        private particlesDrawn: boolean = false;
        private camera: ThirdPersonCamera = new ThirdPersonCamera();
        private numParticles: int = 0;
        private paused: boolean = false;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;

        // The SimulationConstants push constants, and the PlanarViewConstants.
        private simulationConstants: f32[] = [0.0, 0.0];
        private viewConstants: f32[] = [];

        // -test: the last frame and the particles after it are read back.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private particleReadbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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
            this.sample.setInitializeCallback(initialize);
            this.sample.setLatencySleepCallback(latencySleep);
            this.sample.setRenderFrameCallback(renderFrame);

            // On a wrapper of its own: the callbacks Nri_RunSample runs may overwrite this.sample.
            let result = new NriSample(this.sample.handle).run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (result == 0 && this.test) {
                const failure = this.checkTest();
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

            // The layouts: the compute passes' SimulationConstants (push constants, b0) and particles
            // (u0); the draw's view constants (b1) and particles (t0). All root descriptors.
            const computeLayoutDesc = NriPipelineLayoutDesc.create();
            computeLayoutDesc.addRootConstants(0, SIMULATION_CONSTANTS_SIZE, NriStage.Compute);
            computeLayoutDesc.addRootDescriptor(0, NriDescriptorType.StorageStructuredBuffer, NriStage.Compute);
            this.computeLayout = device.createPipelineLayoutFromDesc(computeLayoutDesc);
            computeLayoutDesc.destroy();
            const drawLayoutDesc = NriPipelineLayoutDesc.create();
            drawLayoutDesc.addRootDescriptor(1, NriDescriptorType.ConstantBuffer, NriStage.Vertex);
            drawLayoutDesc.addRootDescriptor(0, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            this.drawLayout = device.createPipelineLayoutFromDesc(drawLayoutDesc);
            drawLayoutDesc.destroy();
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
            this.calculatePipeline = device.createComputePipeline(computeLayout, `${shaders}_calculate_cs.bin`, "calculate_cs");
            this.integratePipeline = device.createComputePipeline(computeLayout, `${shaders}_integrate_cs.bin`, "integrate_cs");
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_main_vs.bin`, "main_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_main_ps.bin`, "main_ps") != 0;
            }
            desc.setCullMode(NriCullMode.Back);
            desc.setColor(viewFormat, NriColorWrite.RGBA);
            desc.setAdditiveBlend();
            if (loaded) {
                this.drawPipeline = device.createPipelineFromDesc(drawLayout, desc);
            }
            desc.destroy();
            if (!this.calculatePipeline || !this.integratePipeline || !this.drawPipeline) {
                console.log("Cannot load the compute n-body shaders");
                return 0;
            }

            const particleBuffer = this.createParticles(device);
            this.particleBuffer = particleBuffer;
            const constantBuffer = device.createHostBuffer(queuedFrameNum * VIEW_CONSTANTS_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            if (!particleBuffer || !constantBuffer) {
                console.log("Cannot create the buffers");
                return 0;
            }
            this.particlesStorage = particleBuffer.createStructuredView(1);
            this.particlesView = particleBuffer.createStructuredView(0);
            this.viewConstantsView = constantBuffer.createConstantView(0, VIEW_CONSTANTS_STRIDE);
            if (!this.particlesStorage || !this.particlesView || !this.viewConstantsView) {
                console.log("Cannot create the buffer views");
                return 0;
            }
            Nri.storeInt32(Ref(this.simulationConstants[1]), this.numParticles);

            // The sample's look-at camera: 14 units from the origin, rotated (-26, 75) degrees.
            this.camera.distance = 14.0;
            this.camera.yaw = Math.fround(radians(75.0));
            this.camera.pitch = Math.fround(radians(26.0));

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.particleReadbackBuffer = device.createReadbackBuffer(this.numParticles * PARTICLE_FLOATS * 4);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The sample's prepare_storage_buffers: the particles around their attractors, uploaded
        // once (the Donut example's numbers: the same random generator).
        createParticles(device: NriDevice): NriBuffer | null {
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

            return device.createStorageBuffer(this.queue, Ref(particles[0]), this.numParticles * PARTICLE_FLOATS * 4, PARTICLE_FLOATS * 4);
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain (and what has the window's
        // size) made again at its size, once the GPU is done with the old ones.
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

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The sample's OnUpdate: the camera, the time step (none when paused; space toggles it), the
        // window title.
        update() {
            if (this.sample.isKeyToggled(NriKey.Space) != 0) {
                this.paused = !this.paused;
            }
            this.camera.animate(this.sample);
            const elapsedSeconds = this.test ? 1.0 / 60.0 : this.sample.getFrameTime();
            this.simulationConstants[0] = this.paused ? 0.0 : elapsedSeconds;
            this.sample.setWindowTitle(
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
            constantBuffer.write(offset, Ref(this.viewConstants[0]), VIEW_CONSTANTS_SIZE);
        }

        // First pass: calculate particle movement; second pass: integrate particles. The particles
        // then go to the draw.
        recordCompute(commandBuffer: NriCommandBuffer) {
            const computeLayout = this.computeLayout;
            const calculatePipeline = this.calculatePipeline;
            const integratePipeline = this.integratePipeline;
            const particleBuffer = this.particleBuffer;
            const particlesStorage = this.particlesStorage;
            if (!computeLayout || !calculatePipeline || !integratePipeline || !particleBuffer || !particlesStorage) {
                return;
            }
            if (this.particlesDrawn) {
                commandBuffer.bufferBarrier(particleBuffer, NriBufferState.VertexShaderResource, NriBufferState.Storage);
            }
            const groups: int = Math.floor(this.numParticles / WORKGROUP_SIZE);
            commandBuffer.setComputePipelineLayout(computeLayout);
            commandBuffer.setPipeline(calculatePipeline);
            commandBuffer.setComputeRootConstants(0, Ref(this.simulationConstants[0]), SIMULATION_CONSTANTS_SIZE);
            commandBuffer.setComputeRootDescriptor(0, particlesStorage);
            commandBuffer.dispatch(groups, 1, 1);
            commandBuffer.bufferBarrier(particleBuffer, NriBufferState.Storage, NriBufferState.Storage);
            commandBuffer.setPipeline(integratePipeline);
            commandBuffer.setComputeRootConstants(0, Ref(this.simulationConstants[0]), SIMULATION_CONSTANTS_SIZE);
            commandBuffer.setComputeRootDescriptor(0, particlesStorage);
            commandBuffer.dispatch(groups, 1, 1);
            commandBuffer.bufferBarrier(particleBuffer, NriBufferState.Storage, NriBufferState.VertexShaderResource);
            this.particlesDrawn = true;
        }

        // The particles' sprites (between NriCommandBuffer.beginRendering and NriCommandBuffer.endRendering).
        recordDraw(commandBuffer: NriCommandBuffer, constantsOffset: int) {
            const drawLayout = this.drawLayout;
            const drawPipeline = this.drawPipeline;
            const viewConstantsView = this.viewConstantsView;
            const particlesView = this.particlesView;
            if (!drawLayout || !drawPipeline || !viewConstantsView || !particlesView) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(drawLayout);
            commandBuffer.setPipeline(drawPipeline);
            commandBuffer.setRootDescriptor(0, viewConstantsView, constantsOffset);
            commandBuffer.setRootDescriptor(1, particlesView, 0);
            commandBuffer.draw(this.numParticles * VERTICES_PER_PARTICLE, 1, 0, 0);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.frames.size();
            this.update();

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);
                const constantsOffset = queuedFrameIndex * VIEW_CONSTANTS_STRIDE;
                this.writeViewConstants(constantsOffset);

                // Record
                commandBuffer.begin();
                this.recordCompute(commandBuffer);
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                commandBuffer.clearColor(0.0, 0.0, 0.0, 1.0);
                this.recordDraw(commandBuffer, constantsOffset);
                commandBuffer.endRendering();

                // The test's last frame: read back, and the particles after it
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        commandBuffer.textureBarrier(texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                        commandBuffer.readbackTextureToBuffer(readbackBuffer, this.rowPitch, texture, this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                        this.recordParticleReadback(commandBuffer);
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

        // Copies the particles to particleReadbackBuffer (after the last frame's draw).
        recordParticleReadback(commandBuffer: NriCommandBuffer) {
            const particleBuffer = this.particleBuffer;
            const particleReadbackBuffer = this.particleReadbackBuffer;
            if (!particleBuffer || !particleReadbackBuffer) {
                return;
            }
            commandBuffer.bufferBarrier(particleBuffer, NriBufferState.VertexShaderResource, NriBufferState.CopySource);
            commandBuffer.copyBuffer(particleReadbackBuffer, particleBuffer, this.numParticles * PARTICLE_FLOATS * 4);
            commandBuffer.bufferBarrier(particleBuffer, NriBufferState.CopySource, NriBufferState.VertexShaderResource);
        }

        // -test, as the Donut example checks: the particles after the last frame, every position
        // and velocity finite, then the frame: black corners, and particles drawn.
        checkTest(): string {
            const device = this.device;
            const particleReadbackBuffer = this.particleReadbackBuffer;
            if (!device || !particleReadbackBuffer) {
                return "cannot read the particles back";
            }
            device.waitIdle();
            const particles: f32[] = [];
            for (let i = 0; i < this.numParticles * PARTICLE_FLOATS; i++) {
                particles.push(0.0);
            }
            if (particleReadbackBuffer.readFloats(Ref(particles[0]), particles.length) == 0) {
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
        const computeNBody = new ComputeNBody(sample);
        return computeNBody.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return ComputeNBodyNri.main(argc, argv);
}

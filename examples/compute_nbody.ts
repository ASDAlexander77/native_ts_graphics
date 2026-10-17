// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, isFinite32 } from "../core/test_check";
import { radians, perspProjD3DStyleReverse } from "../core/matrix";

namespace ComputeNBody {
    const WINDOW_TITLE = "Donut Example: Compute N-Body";

    // GLFW values, as passed to the keyboard callback.
    const KEY_SPACE = 32;
    const ACTION_PRESS = 1;

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

    // --- Math ---------------------------------------------------------------------------------

    // std::default_random_engine replacement: a Park-Miller generator (tslang's Math.random isn't usable).
    let g_RandomSeed = 12345.0;
    function randomFloat() {
        g_RandomSeed = (g_RandomSeed * 16807.0) % 2147483647.0;
        return g_RandomSeed / 2147483647.0;
    }

    // std::normal_distribution<float>(0, 1) replacement: Box-Muller over randomFloat, which never
    // returns 0.
    function randomNormal() {
        const u1 = randomFloat();
        const u2 = randomFloat();
        return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    }

    // --- Passes -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' compute_nbody: an N-body simulation in two compute passes (velocities
    // from the gravity of the other particles, with group shared memory; then positions), drawn as
    // additively blended sprites.
    //
    // The sample runs the compute passes on a compute queue, synchronized with the graphics queue
    // by semaphores and queue family ownership transfers. Here they go into the frame's command
    // list ahead of the draw, and NVRHI places the barriers.
    class NBodyPass {
        private app: App;
        private camera: Camera;
        private view: View;
        private paused: boolean;
        private numParticles: int;

        private particleBuffer: BufferHandle;
        private calculatePipeline: ComputePipelineHandle;
        private integratePipeline: ComputePipelineHandle;
        private computeBindingSet: BindingSet;
        private vertexShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private drawBindingLayout: BindingLayoutHandle;
        private drawBindingSet: BindingSet;
        private viewConstantBuffer: BufferHandle;
        // Created on the first frame (it depends on the framebuffer layout), dropped on resize.
        private graphicsPipeline: GraphicsPipelineHandle | null;

        // The SimulationConstants push constants.
        private simulationConstants: f32[];
        // The PlanarViewConstants contents.
        private viewConstants: f32[];
        private viewConstantsSize: int;
        // Passed to Donut_SetPlanarView, 16 floats each.
        private viewMatrix: f32[];
        private projMatrix: f32[];

        constructor(app: App) {
            this.app = app;
            this.paused = false;
            this.numParticles = 0;
            this.graphicsPipeline = null;
            this.viewConstantsSize = 0;

            this.simulationConstants = [0.0, 0.0];
            this.viewConstants = [];
            this.viewMatrix = [];
            this.projMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
                this.projMatrix.push(0.0);
            }
        }

        onKey(key: int, scancode: int, action: int, mods: int) {
            this.camera.keyboardUpdate(key, scancode, action, mods);

            if (key == KEY_SPACE && action == ACTION_PRESS) {
                this.paused = !this.paused;
            }

            return 1;
        }

        onMousePos(x: number, y: number) {
            this.camera.mousePosUpdate(x, y);
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int) {
            this.camera.mouseButtonUpdate(button, action, mods);
            return 1;
        }

        onMouseScroll(xOffset: number, yOffset: number) {
            this.camera.mouseScrollUpdate(xOffset, yOffset);
            return 1;
        }

        onAnimate(elapsedSeconds: number) {
            this.camera.animate(elapsedSeconds);

            this.simulationConstants[0] = this.paused ? 0.0 : elapsedSeconds;

            this.app.setInformativeWindowTitleWithInfo(WINDOW_TITLE,
                this.paused ? `${this.numParticles} particles (paused)` : `${this.numParticles} particles`);
        }

        onBackBufferResizing() {
            const graphicsPipeline = this.graphicsPipeline;
            if (graphicsPipeline) {
                this.app.releaseResource(graphicsPipeline);
                this.graphicsPipeline = null;
            }
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            let graphicsPipeline = this.graphicsPipeline;
            if (!graphicsPipeline) {
                graphicsPipeline = this.app.createGraphicsPipelineWithBlend(frame, this.vertexShader, this.pixelShader,
                    null, this.drawBindingLayout, PrimitiveType.TriangleList, BlendMode.Additive);
                this.graphicsPipeline = graphicsPipeline;
            }

            // First pass: calculate particle movement; second pass: integrate particles.
            const groups: int = Math.floor(this.numParticles / WORKGROUP_SIZE);
            commandList.dispatchWithPushConstants(this.calculatePipeline, this.computeBindingSet,
                Ref(this.simulationConstants[0]), SIMULATION_CONSTANTS_SIZE, groups, 1, 1);
            commandList.dispatchWithPushConstants(this.integratePipeline, this.computeBindingSet,
                Ref(this.simulationConstants[0]), SIMULATION_CONSTANTS_SIZE, groups, 1, 1);

            // The camera: 60 degrees vertically, as in the sample.
            this.camera.getWorldToView(Ref(this.viewMatrix[0]));
            const projection = perspProjD3DStyleReverse(radians(60.0), width / height, 0.1);
            for (let i = 0; i < 16; i++) {
                this.projMatrix[i] = projection[i];
            }
            this.view.setPlanarView(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);
            this.camera.thirdPersonSetView(this.view);
            this.view.fillPlanarViewConstants(Ref(this.viewConstants[0]));
            commandList.writeBuffer(this.viewConstantBuffer, Ref(this.viewConstants[0]), this.viewConstantsSize);

            frame.clearColor(0.0, 0.0, 0.0, 1.0);

            frame.beginDraw(graphicsPipeline);
            frame.drawAddBindingSet(this.drawBindingSet);
            frame.drawVertices(this.numParticles * VERTICES_PER_PARTICLE);
        }

        // The sample's prepare_storage_buffers: the particles around their attractors, uploaded once.
        createParticles() {
            const attractors: number[] = [
                5.0, 0.0, 0.0,
                -5.0, 0.0, 0.0,
                0.0, 0.0, 5.0,
                0.0, 0.0, -5.0,
                0.0, 4.0, 0.0,
                0.0, -8.0, 0.0,
            ];
            this.numParticles = NUM_ATTRACTORS * PARTICLES_PER_ATTRACTOR;

            let particles: f32[] = [];
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

            this.particleBuffer = this.app.createRWStructuredBuffer(PARTICLE_FLOATS * 4, this.numParticles, "Particles");

            const commandList = this.app.createCommandList();
            commandList.open();
            commandList.writeBuffer(this.particleBuffer, Ref(particles[0]), this.numParticles * PARTICLE_FLOATS * 4);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
        }

        // -test: checks the particles after the last frame, every position and velocity finite,
        // then the frame: black corners, and particles drawn.
        checkTest() {
            const check = new TestCheck(this.app);
            const particles = check.readFloats(this.particleBuffer, this.numParticles * PARTICLE_FLOATS * 4);
            if (particles.length == 0) {
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
            const corners = check.corners(0x000000);
            if (corners != "") {
                return corners;
            }
            return check.drawn(0x000000, 1000, "Particles");
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init() {
            this.vertexShader = this.app.createShader("compute_nbody.hlsl", "main_vs", ShaderType.Vertex);
            this.pixelShader = this.app.createShader("compute_nbody.hlsl", "main_ps", ShaderType.Pixel);
            const calculateShader = this.app.createShaderWithDefine("compute_nbody.hlsl", "calculate_cs", ShaderType.Compute, "SIMULATION", "1");
            const integrateShader = this.app.createShaderWithDefine("compute_nbody.hlsl", "integrate_cs", ShaderType.Compute, "SIMULATION", "1");
            if (!this.vertexShader || !this.pixelShader || !calculateShader || !integrateShader) {
                return false;
            }

            this.createParticles();

            // Compute: the particles and the SimulationConstants push constants.
            const computeLayoutDesc = BindingLayoutDesc.create();
            computeLayoutDesc.layoutPushConstants(0, SIMULATION_CONSTANTS_SIZE);
            computeLayoutDesc.layoutStructuredBufferUAV(0);
            const computeBindingLayout = this.app.createBindingLayout(computeLayoutDesc, ShaderType.Compute);

            this.calculatePipeline = this.app.createComputePipelineWithLayout(calculateShader, computeBindingLayout);
            this.integratePipeline = this.app.createComputePipelineWithLayout(integrateShader, computeBindingLayout);

            const computeSetDesc = BindingSetDesc.create();
            computeSetDesc.bindPushConstants(0, SIMULATION_CONSTANTS_SIZE);
            computeSetDesc.bindStructuredBufferUAV(0, this.particleBuffer);
            this.computeBindingSet = this.app.createBindingSetForLayout(computeSetDesc, computeBindingLayout);

            Donut_StoreInt32(Ref(this.simulationConstants[1]), this.numParticles);

            // Drawing: the view constants and the particles, read by the vertex shader.
            this.viewConstantsSize = Donut_GetPlanarViewConstantsSize();
            for (let i = 0; i < this.viewConstantsSize / 4; i++) {
                this.viewConstants.push(0.0);
            }
            // Static, written in the command list every frame: a volatile one runs out of versions in
            // -test's unthrottled frames on Vulkan.
            this.viewConstantBuffer = this.app.createConstantBuffer(this.viewConstantsSize, "ViewConstants");

            const drawLayoutDesc = BindingLayoutDesc.create();
            drawLayoutDesc.layoutConstantBuffer(1);
            drawLayoutDesc.layoutStructuredBufferSRV(0);
            this.drawBindingLayout = this.app.createBindingLayout(drawLayoutDesc, ShaderType.Vertex);

            const drawSetDesc = BindingSetDesc.create();
            drawSetDesc.bindEntireConstantBuffer(1, this.viewConstantBuffer);
            drawSetDesc.bindStructuredBufferSRV(0, this.particleBuffer);
            this.drawBindingSet = this.app.createBindingSetForLayout(drawSetDesc, this.drawBindingLayout);

            // The sample's look-at camera: 14 units from the origin, rotated (-26, 75) degrees.
            this.camera = this.app.createThirdPersonCamera();
            this.camera.thirdPersonSetTarget(0.0, 0.0, 0.0);
            this.camera.thirdPersonSetDistance(14.0);
            this.camera.thirdPersonSetRotation(radians(75.0), radians(26.0));
            this.camera.setMoveSpeed(2.5);

            this.view = this.app.createPlanarView();

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setMouseScrollCallback(this.onMouseScroll);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("compute_nbody");

        // -test [-testOutput <file>]: render TEST_FRAMES frames without a window and check the
        // particles and the last frame (see checkTest).
        const args = new Args(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const nbody = new NBodyPass(app);
        if (!nbody.init()) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(nbody.checkTest());
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return ComputeNBody.main(argc, argv);
}

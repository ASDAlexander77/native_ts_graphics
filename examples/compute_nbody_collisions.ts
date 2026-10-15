// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, absolute, isFinite32 } from "../core/test_check";

namespace ComputeNBodyCollisions {
    const WINDOW_TITLE = "Donut Example: Compute N-Body Collisions";

    // GLFW values, as passed to the keyboard callback.
    const KEY_SPACE = 32;
    const KEY_C = 67;
    const KEY_H = 72;
    const ACTION_PRESS = 1;

    // The defaults of -attractors and -particles.
    const NUM_ATTRACTORS = 6;
    // A quarter of compute_nbody's: collisions test every pair, and fewer, larger particles make
    // the bounces visible. Still a multiple of 1024, where the gravity pass expects the heavy centers
    // (it reads the first 256 particles of every 1024: any count works up to 256 particles in all).
    const PARTICLES_PER_ATTRACTOR = 1024;
    const MAX_ATTRACTORS = 6;
    // Test mode: the frames rendered (15 seconds). Head on (-attractors 2 -particles 1), the two
    // heavy centers have met once by then and are moving apart again.
    const TEST_FRAMES = 900;
    // Test mode: the fastest a particle may be after them. Gravity alone keeps them under about
    // 120; collisions that added up their impulses threw them out at thousands.
    const MAX_TEST_SPEED = 500.0;
    // The compute passes in compute_nbody_collisions.hlsl run 256 threads per group.
    const WORKGROUP_SIZE = 256;
    // struct Particle: float4 pos, float4 vel, float4 info.
    const PARTICLE_FLOATS = 12;
    // struct Contact: float4 velocity, float4 shift.
    const CONTACT_FLOATS = 8;
    // struct SimulationConstants: float deltaT, int particleCount, int collisions, int heating.
    const SIMULATION_CONSTANTS_SIZE = 16;
    // Collision radii: the heavy centers are balls the light particles bounce off, the light ones
    // grow with their mass (20 to 80).
    const HEAVY_RADIUS = 0.5;
    const LIGHT_RADIUS_BASE = 0.04;
    const LIGHT_RADIUS_PER_MASS = 0.0005;
    // Longest simulation step, in seconds: a stall (window dragged, breakpoint) would otherwise move
    // the particles through each other in one step.
    const MAX_DELTA_T = 1.0 / 30.0;
    // Positions drawn for a light particle before it is kept overlapping (none needs more than a
    // few with the default cloud: it is a sixth full at its center).
    const MAX_PLACEMENT_ATTEMPTS = 100;
    // The quad each particle is drawn as (main_vs).
    const VERTICES_PER_PARTICLE = 6;

    // --- Math ---------------------------------------------------------------------------------

    function radians(degrees: number): number {
        return degrees * Math.PI / 180.0;
    }

    // std::default_random_engine replacement: a Park-Miller generator (tslang's Math.random isn't usable).
    let g_RandomSeed = 12345.0;
    function randomFloat(): number {
        g_RandomSeed = (g_RandomSeed * 16807.0) % 2147483647.0;
        return g_RandomSeed / 2147483647.0;
    }

    // std::normal_distribution<float>(0, 1) replacement: Box-Muller over randomFloat, which never
    // returns 0.
    function randomNormal(): number {
        const u1 = randomFloat();
        const u2 = randomFloat();
        return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    }

    // math::perspProjD3DStyleReverse(verticalFOV, aspect, zNear): reverse Z, infinite far plane,
    // row-major with Donut's row-vector convention.
    // In float32 as Donut's (computed in double, the scales differ in the last bit, which moves
    // edges by a pixel here and there).
    function perspProjD3DStyleReverse(verticalFOV: number, aspect: number, zNear: number): number[] {
        const yScale = Math.fround(1.0 / Math.fround(Math.tan(Math.fround(0.5 * Math.fround(verticalFOV)))));
        const xScale = Math.fround(yScale / Math.fround(aspect));
        return [
            xScale, 0.0,    0.0,   0.0,
            0.0,    yScale, 0.0,   0.0,
            0.0,    0.0,    0.0,   1.0,
            0.0,    0.0,    zNear, 0.0,
        ];
    }

    // --- Passes -------------------------------------------------------------------------------

    // compute_nbody with collisions: the particles are spheres that bounce off each other and off
    // the heavy centers. Four compute passes: velocities from gravity (as compute_nbody), then each
    // particle's contacts counted, then the collisions (every particle against every other, each
    // writing only its own velocity change and position correction into a second buffer, so no
    // particle reads one that another thread has already moved), then positions. Space pauses, C
    // turns the collisions off and on. The kinetic energy the bounces lose becomes heat (info.y: it
    // makes the particle glow, and cools off over a few seconds), H turns the heating off and on.
    class NBodyCollisionsPass {
        private app: App;
        private camera: Camera;
        private view: View;
        private paused: boolean;
        private collisions: boolean;
        private heating: boolean;
        private numParticles: int;

        private particleBuffer: BufferHandle;
        private contactBuffer: BufferHandle;
        private calculatePipeline: ComputePipelineHandle;
        private countPipeline: ComputePipelineHandle;
        private collidePipeline: ComputePipelineHandle;
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

        constructor(app: App, private numAttractors: int, private particlesPerAttractor: int) {
            this.app = app;
            this.paused = false;
            this.collisions = true;
            this.heating = true;
            this.numParticles = 0;
            this.graphicsPipeline = null;
            this.viewConstantsSize = 0;

            this.simulationConstants = [0.0, 0.0, 0.0, 0.0];
            this.viewConstants = [];
            this.viewMatrix = [];
            this.projMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
                this.projMatrix.push(0.0);
            }
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            this.camera.keyboardUpdate(key, scancode, action, mods);

            if (key == KEY_SPACE && action == ACTION_PRESS) {
                this.paused = !this.paused;
            }
            if (key == KEY_C && action == ACTION_PRESS) {
                this.collisions = !this.collisions;
                Donut_StoreInt32(Ref(this.simulationConstants[2]), this.collisions ? 1 : 0);
            }
            if (key == KEY_H && action == ACTION_PRESS) {
                this.heating = !this.heating;
                Donut_StoreInt32(Ref(this.simulationConstants[3]), this.heating ? 1 : 0);
            }

            return 1;
        }

        onMousePos(x: number, y: number): int {
            this.camera.mousePosUpdate(x, y);
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            this.camera.mouseButtonUpdate(button, action, mods);
            return 1;
        }

        onMouseScroll(xOffset: number, yOffset: number): int {
            this.camera.mouseScrollUpdate(xOffset, yOffset);
            return 1;
        }

        onAnimate(elapsedSeconds: number): void {
            this.camera.animate(elapsedSeconds);

            this.simulationConstants[0] = elapsedSeconds < MAX_DELTA_T ? elapsedSeconds : MAX_DELTA_T;

            const collisionsInfo = (this.collisions ? "collisions on" : "collisions off")
                + (this.heating ? ", heating on" : ", heating off");
            this.app.setInformativeWindowTitleWithInfo(WINDOW_TITLE, this.paused
                ? `${this.numParticles} particles, ${collisionsInfo} (paused)`
                : `${this.numParticles} particles, ${collisionsInfo}`);
        }

        onBackBufferResizing(): void {
            const graphicsPipeline = this.graphicsPipeline;
            if (graphicsPipeline) {
                this.app.releaseResource(graphicsPipeline);
                this.graphicsPipeline = null;
            }
        }

        onRender(frameHandle: FrameHandle): void {
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

            // Gravity, collisions, integration. Paused, nothing moves: the collision pass would
            // still push overlapping particles apart.
            if (!this.paused) {
                // Rounded up: the shaders skip the threads past particleCount.
                const groups: int = Math.floor((this.numParticles + WORKGROUP_SIZE - 1) / WORKGROUP_SIZE);
                commandList.dispatchWithPushConstants(this.calculatePipeline, this.computeBindingSet,
                    Ref(this.simulationConstants[0]), SIMULATION_CONSTANTS_SIZE, groups, 1, 1);
                if (this.collisions) {
                    commandList.dispatchWithPushConstants(this.countPipeline, this.computeBindingSet,
                        Ref(this.simulationConstants[0]), SIMULATION_CONSTANTS_SIZE, groups, 1, 1);
                    commandList.dispatchWithPushConstants(this.collidePipeline, this.computeBindingSet,
                        Ref(this.simulationConstants[0]), SIMULATION_CONSTANTS_SIZE, groups, 1, 1);
                }
                commandList.dispatchWithPushConstants(this.integratePipeline, this.computeBindingSet,
                    Ref(this.simulationConstants[0]), SIMULATION_CONSTANTS_SIZE, groups, 1, 1);
            }

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

        // Whether a light particle at (x, y, z) would overlap one of the first `count` particles or
        // any attractor's heavy center (those of later groups aren't placed yet).
        overlaps(particles: f32[], count: int, attractors: number[], x: number, y: number, z: number,
            radius: number): boolean {
            for (let i = 0; i < count; i++) {
                const q = i * PARTICLE_FLOATS;
                const dx = x - particles[q + 0];
                const dy = y - particles[q + 1];
                const dz = z - particles[q + 2];
                const reach = radius + particles[q + 8];
                if (dx * dx + dy * dy + dz * dz < reach * reach) {
                    return true;
                }
            }
            for (let i = 0; i < this.numAttractors; i++) {
                const dx = x - attractors[i * 3 + 0] * 1.5;
                const dy = y - attractors[i * 3 + 1] * 1.5;
                const dz = z - attractors[i * 3 + 2] * 1.5;
                const reach = radius + HEAVY_RADIUS;
                if (dx * dx + dy * dy + dz * dz < reach * reach) {
                    return true;
                }
            }
            return false;
        }

        // compute_nbody's particles around their attractors, uploaded once, with collision radii.
        createParticles(): void {
            const attractors: number[] = [
                5.0, 0.0, 0.0,
                -5.0, 0.0, 0.0,
                0.0, 0.0, 5.0,
                0.0, 0.0, -5.0,
                0.0, 4.0, 0.0,
                0.0, -8.0, 0.0,
            ];
            this.numParticles = this.numAttractors * this.particlesPerAttractor;

            let particles: f32[] = [];
            for (let i = 0; i < this.numParticles * PARTICLE_FLOATS; i++) {
                particles.push(0.0);
            }

            for (let i = 0; i < this.numAttractors; i++) {
                const ax = attractors[i * 3 + 0];
                const ay = attractors[i * 3 + 1];
                const az = attractors[i * 3 + 2];

                for (let j = 0; j < this.particlesPerAttractor; j++) {
                    const p = (i * this.particlesPerAttractor + j) * PARTICLE_FLOATS;

                    if (j == 0) {
                        // First particle in group as heavy center of gravity
                        particles[p + 0] = ax * 1.5;
                        particles[p + 1] = ay * 1.5;
                        particles[p + 2] = az * 1.5;
                        particles[p + 3] = 90000.0;
                        particles[p + 8] = HEAVY_RADIUS;
                    } else {
                        // Positive masses, unlike compute_nbody's (normal around 37.5, some
                        // negative): a collision's impulse is shared in proportion to them.
                        const mass = 20.0 + 60.0 * randomFloat();
                        const radius = LIGHT_RADIUS_BASE + LIGHT_RADIUS_PER_MASS * mass;

                        // Position. The sample then scales y by 2 - length(normalize(position -
                        // attractor))^2, which is 1. Drawn again while it overlaps a particle
                        // placed before or a heavy center: compute_nbody's cloud has a third of
                        // the particles overlapping, which collide_cs would push apart and bounce
                        // off each other all at once in the first frames.
                        let px = 0.0;
                        let py = 0.0;
                        let pz = 0.0;
                        for (let attempt = 0; attempt < MAX_PLACEMENT_ATTEMPTS; attempt++) {
                            px = ax + randomNormal() * 0.75;
                            py = ay + randomNormal() * 0.75;
                            pz = az + randomNormal() * 0.75;
                            if (!this.overlaps(particles, p / PARTICLE_FLOATS, attractors, px, py, pz, radius)) {
                                break;
                            }
                        }

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

                        particles[p + 0] = px;
                        particles[p + 1] = py;
                        particles[p + 2] = pz;
                        particles[p + 3] = mass;
                        particles[p + 4] = vx;
                        particles[p + 5] = vy;
                        particles[p + 6] = vz;
                        particles[p + 8] = radius;
                    }

                    // Color gradient offset
                    particles[p + 7] = i / this.numAttractors;
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

            // Written by collide_cs before integrate_cs reads it, every frame.
            this.contactBuffer = this.app.createRWStructuredBuffer(CONTACT_FLOATS * 4, this.numParticles, "Contacts");
        }

        // -test: checks the particles after the last frame. Every position and velocity is finite
        // (light particles slung out of the scene go far, legitimately), and none is faster than
        // MAX_TEST_SPEED, though the clouds have fallen into each other by then. Head on (2 heavy centers
        // alone), the two have bounced off each other once, symmetrically: equal and opposite
        // positions and velocities (the momentum kept), as far apart and as fast as a CPU run of the
        // shaders has them at frame 900. Then the frame: black corners, and particles drawn.
        checkTest(): string {
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
                const vx = particles[i * PARTICLE_FLOATS + 4];
                const vy = particles[i * PARTICLE_FLOATS + 5];
                const vz = particles[i * PARTICLE_FLOATS + 6];
                const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
                if (speed > MAX_TEST_SPEED) {
                    return `particle ${i}: speed ${speed} above ${MAX_TEST_SPEED}, the collisions gained energy`;
                }
            }

            // Heat (info.y): never negative, and some particle is hot or was (collisions add it).
            let maxHeat = 0.0;
            let sumHeat = 0.0;
            for (let i = 0; i < this.numParticles; i++) {
                const heat = particles[i * PARTICLE_FLOATS + 9];
                if (!isFinite32(heat) || heat < 0.0) {
                    return `particle ${i}: heat ${heat} is not finite or is negative`;
                }
                maxHeat = Math.max(maxHeat, heat);
                sumHeat += heat;
            }
            console.log(`Heat: max ${maxHeat}, mean ${sumHeat / this.numParticles}`);
            if (maxHeat <= 0.0) {
                return "no particle has any heat: the collisions lost no energy into it";
            }

            if (this.numAttractors == 2 && this.particlesPerAttractor == 1) {
                const x0 = particles[0];
                const x1 = particles[PARTICLE_FLOATS];
                const v0 = particles[4];
                const v1 = particles[PARTICLE_FLOATS + 4];
                console.log(`Head on: x ${x0}, ${x1}; v ${v0}, ${v1}`);
                // Symmetric to float precision: a race of the passes broke the momentum by tens.
                if (absolute(x0 + x1) > 0.01 || absolute(v0 + v1) > 0.01) {
                    return `positions ${x0}, ${x1} and velocities ${v0}, ${v1} are not symmetric: momentum not kept`;
                }
                // The CPU run: x 3.773, v 5.698.
                if (absolute(x0 - 3.773) > 0.1 || absolute(v0 - 5.698) > 0.1) {
                    return `position ${x0}, velocity ${v0}: not the CPU run's 3.773, 5.698 after one bounce`;
                }
            }

            const corners = check.corners(0x000000);
            if (corners != "") {
                return corners;
            }
            return check.drawn(0x000000, 100, "Particles");
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shaderFile = "compute_nbody_collisions.hlsl";
            this.vertexShader = this.app.createShader(shaderFile, "main_vs", ShaderType.Vertex);
            this.pixelShader = this.app.createShader(shaderFile, "main_ps", ShaderType.Pixel);
            const calculateShader = this.app.createShaderWithDefine(shaderFile, "calculate_cs", ShaderType.Compute, "SIMULATION", "1");
            const countShader = this.app.createShaderWithDefine(shaderFile, "count_cs", ShaderType.Compute, "SIMULATION", "1");
            const collideShader = this.app.createShaderWithDefine(shaderFile, "collide_cs", ShaderType.Compute, "SIMULATION", "1");
            const integrateShader = this.app.createShaderWithDefine(shaderFile, "integrate_cs", ShaderType.Compute, "SIMULATION", "1");
            if (!this.vertexShader || !this.pixelShader || !calculateShader || !countShader || !collideShader || !integrateShader) {
                return false;
            }

            this.createParticles();

            // Compute: the particles, their contacts and the SimulationConstants push constants.
            const computeLayoutDesc = BindingLayoutDesc.create();
            computeLayoutDesc.layoutPushConstants(0, SIMULATION_CONSTANTS_SIZE);
            computeLayoutDesc.layoutStructuredBufferUAV(0);
            computeLayoutDesc.layoutStructuredBufferUAV(1);
            const computeBindingLayout = this.app.createBindingLayout(computeLayoutDesc, ShaderType.Compute);

            this.calculatePipeline = this.app.createComputePipelineWithLayout(calculateShader, computeBindingLayout);
            this.countPipeline = this.app.createComputePipelineWithLayout(countShader, computeBindingLayout);
            this.collidePipeline = this.app.createComputePipelineWithLayout(collideShader, computeBindingLayout);
            this.integratePipeline = this.app.createComputePipelineWithLayout(integrateShader, computeBindingLayout);

            const computeSetDesc = BindingSetDesc.create();
            computeSetDesc.bindPushConstants(0, SIMULATION_CONSTANTS_SIZE);
            computeSetDesc.bindStructuredBufferUAV(0, this.particleBuffer);
            computeSetDesc.bindStructuredBufferUAV(1, this.contactBuffer);
            this.computeBindingSet = this.app.createBindingSetForLayout(computeSetDesc, computeBindingLayout);

            Donut_StoreInt32(Ref(this.simulationConstants[1]), this.numParticles);
            Donut_StoreInt32(Ref(this.simulationConstants[2]), 1);
            Donut_StoreInt32(Ref(this.simulationConstants[3]), 1);

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

            // compute_nbody's look-at camera: 14 units from the origin, rotated (-26, 75) degrees.
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

    class NBodyCollisionsArgs extends Args {
        // -attractors <n>: heavy centers, 1 to 6 (6 by default), each with its group of particles.
        numAttractors: int = NUM_ATTRACTORS;
        // -particles <n>: particles per attractor, the heavy center first (1024 by default).
        particlesPerAttractor: int = PARTICLES_PER_ATTRACTOR;

        protected parseOptions(): void {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-attractors" && i + 1 < this.argc) {
                    this.numAttractors = parseInt(this[i + 1]);
                    i++;
                } else if (arg == "-particles" && i + 1 < this.argc) {
                    this.particlesPerAttractor = parseInt(this[i + 1]);
                    i++;
                }
            }
            if (this.numAttractors < 1) {
                this.numAttractors = 1;
            }
            if (this.numAttractors > MAX_ATTRACTORS) {
                this.numAttractors = MAX_ATTRACTORS;
            }
            if (this.particlesPerAttractor < 1) {
                this.particlesPerAttractor = 1;
            }
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("compute_nbody_collisions");

        // -test [-testOutput <file>]: render TEST_FRAMES frames without a window and check the
        // particles and the last frame (see checkTest).
        const args = new NBodyCollisionsArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const nbody = new NBodyCollisionsPass(app, args.numAttractors, args.particlesPerAttractor);
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
function main(argc: int, argv: Ref<string>): int {
    return ComputeNBodyCollisions.main(argc, argv);
}

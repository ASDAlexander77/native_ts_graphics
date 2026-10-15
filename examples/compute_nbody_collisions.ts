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
    const KEY_P = 80;
    const KEY_T = 84;
    const ACTION_PRESS = 1;
    const ACTION_RELEASE = 0;

    // Seconds without input before the camera starts to orbit the center by itself, the seconds it
    // takes to reach full speed, and that speed in radians per second (a turn in about 70 s).
    const IDLE_SECONDS = 5.0;
    const IDLE_RAMP_SECONDS = 2.0;
    const IDLE_ROTATION_SPEED = 0.09;

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
    // struct Particle: float4 pos, float4 vel, float4 info, float4 spin, float4 marker.
    const PARTICLE_FLOATS = 20;
    // struct Contact: float4 velocity, float4 shift, float4 spin.
    const CONTACT_FLOATS = 12;
    // struct SimulationConstants: float deltaT, int particleCount, int collisions, int heating, then
    // the UI's floats (the indices below), padded to 48 bytes.
    const SIMULATION_CONSTANTS_SIZE = 48;
    const SIMULATION_FLOATS = SIMULATION_CONSTANTS_SIZE / 4;
    const CONSTANT_TIME_FACTOR = 4;
    const CONSTANT_GRAVITY = 5;
    const CONSTANT_RESTITUTION = 6;
    const CONSTANT_HEAT_FACTOR = 7;
    const CONSTANT_COOL_SECONDS = 8;
    const CONSTANT_FRICTION = 9;
    const CONSTANT_MERGE_SPEED = 10;
    const CONSTANT_FULL_GRAVITY = 11;
    // The simulation's defaults (compute_nbody's, then the collisions'), and what the UI's sliders
    // can set them to.
    const DEFAULT_TIME_FACTOR = 0.05;
    const DEFAULT_GRAVITY = 0.002;
    const DEFAULT_RESTITUTION = 0.8;
    const DEFAULT_HEAT_FACTOR = 0.004;
    const DEFAULT_COOL_SECONDS = 3.0;
    const DEFAULT_FRICTION = 0.3;
    // Off: particles touching slower than this (relative speed) merge, and the UI's slider goes to
    // MERGE_SPEED_MAX.
    const DEFAULT_MERGE_SPEED = 0.0;
    const MERGE_SPEED_MAX = 8.0;
    // With gravity between all pairs (-fullgravity) and the heavy centers alone (-particles 1), the
    // test checks the momentum and the angular momentum drifted by less than this much of the sums
    // of their sizes. Merging the six centers (-merge 20) drifts the angular momentum by 3e-6 of
    // it with the merged spins' exact balance, and 2e-4 with their average.
    const MOMENTUM_DRIFT_LIMIT = 1.0e-3;
    const ANGULAR_DRIFT_LIMIT = 1.0e-4;
    // With merging on, the particles left (radius not negative) are counted back from the GPU every
    // this many frames, for the window title and the UI.
    const ALIVE_COUNT_FRAMES = 30;
    // The sigma of a group's cloud around its attractor, and the random seed (the Park-Miller
    // generator wants one from 1 up), at startup and as the UI's restart sets them.
    const DEFAULT_SPREAD = 0.75;
    const DEFAULT_SEED = 12345;
    // Collision radii: the heavy centers are balls the light particles bounce off, the light ones
    // differ in size: radii from LIGHT_RADIUS_MIN to LIGHT_RADIUS_MAX (mostly small ones), and a
    // mass of LIGHT_MASS_MIN at the smallest, growing with the volume (20 to 312).
    const HEAVY_RADIUS = 0.5;
    const LIGHT_RADIUS_MIN = 0.04;
    const LIGHT_RADIUS_MAX = 0.1;
    const LIGHT_MASS_MIN = 20.0;
    // Longest simulation step, in seconds: a stall (window dragged, breakpoint) would otherwise move
    // the particles through each other in one step.
    const MAX_DELTA_T = 1.0 / 30.0;
    // Positions drawn for a light particle before it is kept overlapping (none needs more than a
    // few with the default cloud: it is a sixth full at its center).
    const MAX_PLACEMENT_ATTEMPTS = 100;
    // The quad each particle is drawn as (main_vs).
    const VERTICES_PER_PARTICLE = 6;
    // The axis gizmo (axis_vs): up to GIZMO_MAX_SEGMENTS segments of 6 vertices, in a constant buffer
    // of a float4 (1 / viewport size), then every segment's endpoints and color. Sizes are for a
    // 720 pixel high window and scale with it.
    const GIZMO_MAX_SEGMENTS = 16;
    const GIZMO_FLOATS = 4 + GIZMO_MAX_SEGMENTS * 8;
    const GIZMO_ORIGIN = 70.0;
    const GIZMO_LENGTH = 45.0;
    const GIZMO_LABEL_DISTANCE = 15.0;
    const GIZMO_LABEL_HALF_WIDTH = 5.0;
    const GIZMO_LABEL_HALF_HEIGHT = 7.0;
    // The coordinate planes (plane_vs): 3 planes of 2 * 13 grid lines, 6 vertices each.
    const PLANE_LINE_COUNT = 3 * 2 * 13;
    // The trails (trail_vs): a quad of 6 vertices per particle, with a float4 constant buffer (the
    // world length of a unit of velocity, and the head's opacity). The length is in seconds of the
    // particle's own motion; the sliders' range and default.
    const TRAIL_CONSTANTS_SIZE = 16;
    // The bloom (compute_nbody_collisions_post.hlsl): the scene is drawn into an RGBA16F target, a
    // threshold pass keeps what is brighter than BLOOM_THRESHOLD (times the strength) at half size,
    // BLUR_LEVELS levels blur it down and back up, and the composite adds level BLOOM_INDEX to the
    // scene. struct BlurConstants: uint2 resolution, float2 1 / resolution, float2 1 / input
    // resolution, float threshold, float strength.
    const BLUR_FLOATS = 8;
    const BLUR_SIZE = BLUR_FLOATS * 4;
    const BLUR_LEVELS = 6;
    const BLOOM_INDEX = 1;
    const BLUR_GROUP_SIZE = 8;
    const DEFAULT_BLOOM_THRESHOLD = 1.0;
    const DEFAULT_BLOOM_STRENGTH = 0.3;
    const TRAIL_SECONDS_MAX = 3.0;
    const DEFAULT_TRAIL_SECONDS = 0.35;
    const TRAIL_OPACITY = 0.25;

    // The UI's choices of particles per attractor: the gravity pass expects the heavy centers at
    // multiples of 1024 (but any count works up to 256 particles in all, as in -particles 1).
    const PARTICLE_CHOICES = "1|1024|2048";
    function particleChoiceIndex(particles: int): int {
        return particles == 1 ? 0 : (particles == 1024 ? 1 : (particles == 2048 ? 2 : -1));
    }
    function particleChoice(index: int): int {
        return index == 0 ? 1 : (index == 1 ? 1024 : 2048);
    }

    // The size of a level of the blur chain: level 0 is the target's.
    function levelSize(size: int, level: int): int {
        return Math.max(1, size >> level);
    }

    // --- Math ---------------------------------------------------------------------------------

    function radians(degrees: number): number {
        return degrees * Math.PI / 180.0;
    }

    // std::default_random_engine replacement: a Park-Miller generator (tslang's Math.random isn't usable).
    let g_RandomSeed = DEFAULT_SEED * 1.0;
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
    // makes the particle glow, and cools off over a few seconds), H turns the heating off and on, P the coordinate planes (XY, XZ and YZ grids through the origin).
    // The particles are solid spheres with spin: friction at a contact (Coulomb, the Friction slider)
    // slows their sliding and, by its torque, sets them spinning (ApplyFriction in the shader); the
    // spin shows as a mark at the poles of a direction fixed in the particle, which it turns.
    // The UI (a window in the top right corner, off with -noui) sets the gravity, time scale,
    // bounciness and heat live, and the number of attractors and particles, the spread of the clouds
    // and the random seed on Restart, which starts the simulation again from the initial state.
    // Left alone for IDLE_SECONDS, the camera starts to orbit the target slowly; any input stops it.
    class NBodyCollisionsPass {
        private app: App;
        private camera: Camera;
        private view: View;
        private paused: boolean;
        private collisions: boolean;
        private heating: boolean;
        private showPlanes: boolean;
        private showTrails: boolean;
        private bloomThreshold: number;
        private bloomStrength: number;
        // The bloom's targets, made for the size of the frame (bloomWidth x bloomHeight, 0 before the
        // first frame) and again when it changes.
        private bloomWidth: int;
        private bloomHeight: int;
        private hdrTarget: TextureHandle;
        private hdrFramebuffer: FramebufferHandle;
        private blurChain: TextureHandle[];
        private blurConstants: f32[];
        private linearClamp: SamplerHandle;
        private blurBindingLayout: BindingLayoutHandle;
        private thresholdPipeline: ComputePipelineHandle;
        private blurDownPipeline: ComputePipelineHandle;
        private blurUpPipeline: ComputePipelineHandle;
        private thresholdBindingSet: BindingSet;
        private blurDownBindingSets: BindingSet[];
        private blurUpBindingSets: BindingSet[];
        private compositeVertexShader: ShaderHandle;
        private compositePixelShader: ShaderHandle;
        private compositeBindingLayout: BindingLayoutHandle;
        private compositeBindingSet: BindingSet;
        private compositePipeline: GraphicsPipelineHandle | null;
        private trailSeconds: number;
        // The UI's settings applied on Restart (the pass's own are those of the running simulation),
        // and whether Restart was pressed: it is done at the start of the next frame.
        private uiAttractors: int;
        private uiParticles: int;
        private uiSpread: number;
        private uiSeed: int;
        private spread: number;
        private restartRequested: boolean;
        private frameWidth: int;
        // Seconds since the last input, and the mouse buttons held: dragging pauses the rotation.
        private idleSeconds: number;
        private buttonsDown: int;
        // -test renders the same frames every run: no rotation.
        private autoRotate: boolean;
        private numParticles: int;

        private particleBuffer: BufferHandle;
        private contactBuffer: BufferHandle;
        private calculatePipeline: ComputePipelineHandle;
        private countPipeline: ComputePipelineHandle;
        private collidePipeline: ComputePipelineHandle;
        private absorbPipeline: ComputePipelineHandle;
        private killPipeline: ComputePipelineHandle;
        // The mass and the volume (sum of cubed radii) the particles started with: merging keeps both.
        private initialMass: number;
        private aliveCount: int;
        private framesSinceCount: int;
        private initialVolume: number;
        // The angular momentum about the origin (x, y, z) the particles started with.
        private initialAngular: number[];
        // The linear momentum (x, y, z, and the sum of m |v|, its scale), and the angular
        // momentum's scale, the same way.
        private initialMomentum: number[];
        private fullGravity: boolean;
        private integratePipeline: ComputePipelineHandle;
        private computeBindingLayout: BindingLayoutHandle;
        private computeBindingSet: BindingSet;
        private vertexShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private drawBindingLayout: BindingLayoutHandle;
        private drawBindingSet: BindingSet;
        private viewConstantBuffer: BufferHandle;
        private axisVertexShader: ShaderHandle;
        private axisPixelShader: ShaderHandle;
        private gizmoBindingLayout: BindingLayoutHandle;
        private gizmoBindingSet: BindingSet;
        private gizmoBuffer: BufferHandle;
        private gizmoPipeline: GraphicsPipelineHandle | null;
        private planeVertexShader: ShaderHandle;
        private planePixelShader: ShaderHandle;
        private planePipeline: GraphicsPipelineHandle | null;
        private trailVertexShader: ShaderHandle;
        private trailPipeline: GraphicsPipelineHandle | null;
        private trailBindingLayout: BindingLayoutHandle;
        private trailBindingSet: BindingSet;
        private trailBuffer: BufferHandle;
        private trailConstants: f32[];
        private gizmoConstants: f32[];
        private gizmoSegments: int;
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

        constructor(app: App, private numAttractors: int, private particlesPerAttractor: int, autoRotate: boolean,
            private showUI: boolean) {
            this.app = app;
            this.autoRotate = autoRotate;
            this.idleSeconds = 0.0;
            this.buttonsDown = 0;
            this.paused = false;
            this.collisions = true;
            this.heating = true;
            this.showPlanes = true;
            this.showTrails = true;
            this.bloomThreshold = DEFAULT_BLOOM_THRESHOLD;
            this.bloomStrength = DEFAULT_BLOOM_STRENGTH;
            this.bloomWidth = 0;
            this.bloomHeight = 0;
            this.blurChain = [];
            this.blurDownBindingSets = [];
            this.blurUpBindingSets = [];
            this.compositePipeline = null;
            this.blurConstants = [];
            for (let i = 0; i < BLUR_FLOATS; i++) {
                this.blurConstants.push(0.0);
            }
            this.trailSeconds = DEFAULT_TRAIL_SECONDS;
            this.trailConstants = [0.0, TRAIL_OPACITY, 0.0, 0.0];
            this.initialMass = 0.0;
            this.initialVolume = 0.0;
            this.initialAngular = [0.0, 0.0, 0.0, 0.0];
            this.initialMomentum = [0.0, 0.0, 0.0, 0.0];
            this.fullGravity = false;
            this.aliveCount = 0;
            this.framesSinceCount = 0;
            this.uiAttractors = numAttractors;
            this.uiParticles = particlesPerAttractor;
            this.uiSpread = DEFAULT_SPREAD;
            this.uiSeed = DEFAULT_SEED;
            this.spread = DEFAULT_SPREAD;
            this.restartRequested = false;
            this.frameWidth = 1280;
            this.numParticles = 0;
            this.graphicsPipeline = null;
            this.gizmoPipeline = null;
            this.planePipeline = null;
            this.trailPipeline = null;
            this.gizmoSegments = 0;
            this.gizmoConstants = [];
            for (let i = 0; i < GIZMO_FLOATS; i++) {
                this.gizmoConstants.push(0.0);
            }
            this.viewConstantsSize = 0;

            this.simulationConstants = [];
            for (let i = 0; i < SIMULATION_FLOATS; i++) {
                this.simulationConstants.push(0.0);
            }
            this.resetSimulationConstants();
            this.viewConstants = [];
            this.viewMatrix = [];
            this.projMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
                this.projMatrix.push(0.0);
            }
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            this.idleSeconds = 0.0;
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

            if (key == KEY_P && action == ACTION_PRESS) {
                this.showPlanes = !this.showPlanes;
            }
            if (key == KEY_T && action == ACTION_PRESS) {
                this.showTrails = !this.showTrails;
            }

            return 1;
        }

        onMousePos(x: number, y: number): int {
            // The mouse moving over the window isn't input for the camera, dragging is.
            if (this.buttonsDown > 0) {
                this.idleSeconds = 0.0;
            }
            this.camera.mousePosUpdate(x, y);
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            this.idleSeconds = 0.0;
            if (action == ACTION_PRESS) {
                this.buttonsDown++;
            } else if (action == ACTION_RELEASE && this.buttonsDown > 0) {
                this.buttonsDown--;
            }
            this.camera.mouseButtonUpdate(button, action, mods);
            return 1;
        }

        onMouseScroll(xOffset: number, yOffset: number): int {
            this.idleSeconds = 0.0;
            this.camera.mouseScrollUpdate(xOffset, yOffset);
            return 1;
        }

        onAnimate(elapsedSeconds: number): void {
            // Before this frame's commands exist: the GPU is idle, so the buffers can be replaced.
            if (this.restartRequested) {
                this.restartRequested = false;
                this.restart();
            }

            // Left alone for a while, the camera drifts around the target, keeping its pitch and
            // distance, from wherever the user left it: speeding up so it doesn't start with a jerk.
            this.idleSeconds += elapsedSeconds;
            if (this.autoRotate && this.idleSeconds > IDLE_SECONDS) {
                const ramp = Math.min((this.idleSeconds - IDLE_SECONDS) / IDLE_RAMP_SECONDS, 1.0);
                this.camera.thirdPersonSetRotation(
                    this.camera.thirdPersonGetYaw() + IDLE_ROTATION_SPEED * ramp * elapsedSeconds,
                    this.camera.thirdPersonGetPitch());
            }

            this.camera.animate(elapsedSeconds);

            this.simulationConstants[0] = elapsedSeconds < MAX_DELTA_T ? elapsedSeconds : MAX_DELTA_T;

            // Merged-away particles don't show: count the ones left now and then (the GPU is idle
            // here, as for a restart).
            this.framesSinceCount++;
            if (this.simulationConstants[CONSTANT_MERGE_SPEED] > 0.0 && !this.paused && this.framesSinceCount >= ALIVE_COUNT_FRAMES) {
                this.framesSinceCount = 0;
                this.countAlive();
            }

            const collisionsInfo = (this.collisions ? "collisions on" : "collisions off")
                + (this.heating ? ", heating on" : ", heating off");
            this.app.setInformativeWindowTitleWithInfo(WINDOW_TITLE, this.paused
                ? `${this.aliveCount} particles, ${collisionsInfo} (paused)`
                : `${this.aliveCount} particles, ${collisionsInfo}`);
        }

        onBackBufferResizing(): void {
            const graphicsPipeline = this.graphicsPipeline;
            if (graphicsPipeline) {
                this.app.releaseResource(graphicsPipeline);
                this.graphicsPipeline = null;
            }
            const planePipeline = this.planePipeline;
            if (planePipeline) {
                this.app.releaseResource(planePipeline);
                this.planePipeline = null;
            }
            const trailPipeline = this.trailPipeline;
            if (trailPipeline) {
                this.app.releaseResource(trailPipeline);
                this.trailPipeline = null;
            }
            const compositePipeline = this.compositePipeline;
            if (compositePipeline) {
                this.app.releaseResource(compositePipeline);
                this.compositePipeline = null;
            }
            const gizmoPipeline = this.gizmoPipeline;
            if (gizmoPipeline) {
                this.app.releaseResource(gizmoPipeline);
                this.gizmoPipeline = null;
            }
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            this.frameWidth = width;
            const commandList = frame.getCommandList();

            this.ensureBloomTargets(width, height);

            let graphicsPipeline = this.graphicsPipeline;
            if (!graphicsPipeline) {
                graphicsPipeline = this.createHdrPipeline(this.vertexShader, this.pixelShader, this.drawBindingLayout, BlendMode.Additive);
                this.graphicsPipeline = graphicsPipeline;
            }
            let compositePipeline = this.compositePipeline;
            if (!compositePipeline) {
                compositePipeline = this.app.createGraphicsPipelineWithTopology(frame, this.compositeVertexShader,
                    this.compositePixelShader, null, this.compositeBindingLayout, PrimitiveType.TriangleList);
                this.compositePipeline = compositePipeline;
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
                    if (this.simulationConstants[CONSTANT_MERGE_SPEED] > 0.0) {
                        // The survivors absorb the merging particles, which are then removed.
                        commandList.dispatchWithPushConstants(this.absorbPipeline, this.computeBindingSet,
                            Ref(this.simulationConstants[0]), SIMULATION_CONSTANTS_SIZE, groups, 1, 1);
                        commandList.dispatchWithPushConstants(this.killPipeline, this.computeBindingSet,
                            Ref(this.simulationConstants[0]), SIMULATION_CONSTANTS_SIZE, groups, 1, 1);
                    }
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

            commandList.clearTextureFloat(this.hdrTarget, 0.0, 0.0, 0.0, 1.0);

            // The trails: as long as the time scale makes them, under the balls (they add up to a haze in the pile).
            if (this.showTrails && this.trailSeconds > 0.0) {
                this.trailConstants[0] = this.simulationConstants[CONSTANT_TIME_FACTOR] * this.trailSeconds;
                commandList.writeBuffer(this.trailBuffer, Ref(this.trailConstants[0]), TRAIL_CONSTANTS_SIZE);
                let trailPipeline = this.trailPipeline;
                if (!trailPipeline) {
                    trailPipeline = this.createHdrPipeline(this.trailVertexShader, this.axisPixelShader,
                        this.trailBindingLayout, BlendMode.AlphaBlend);
                    this.trailPipeline = trailPipeline;
                }
                frame.beginDrawToFramebuffer(trailPipeline, this.hdrFramebuffer);
                frame.drawAddBindingSet(this.trailBindingSet);
                frame.drawVertices(this.numParticles * VERTICES_PER_PARTICLE);
            }

            frame.beginDrawToFramebuffer(graphicsPipeline, this.hdrFramebuffer);
            frame.drawAddBindingSet(this.drawBindingSet);
            frame.drawVertices(this.numParticles * VERTICES_PER_PARTICLE);

            // The bloom, then the scene and it into the back buffer.
            this.renderBloom(commandList);
            frame.beginDraw(compositePipeline);
            frame.drawAddBindingSet(this.compositeBindingSet);
            frame.drawVertices(3);

            // The coordinate planes, under the gizmo.
            if (this.showPlanes) {
                let planePipeline = this.planePipeline;
                if (!planePipeline) {
                    planePipeline = this.app.createGraphicsPipelineWithBlend(frame, this.planeVertexShader, this.planePixelShader,
                        null, this.drawBindingLayout, PrimitiveType.TriangleList, BlendMode.AlphaBlend);
                    this.planePipeline = planePipeline;
                }
                frame.beginDraw(planePipeline);
                frame.drawAddBindingSet(this.drawBindingSet);
                frame.drawVertices(PLANE_LINE_COUNT * VERTICES_PER_PARTICLE);
            }

            // The axes, over the particles, in the top left corner.
            this.buildGizmo(width, height);
            commandList.writeBuffer(this.gizmoBuffer, Ref(this.gizmoConstants[0]), GIZMO_FLOATS * 4);
            let gizmoPipeline = this.gizmoPipeline;
            if (!gizmoPipeline) {
                gizmoPipeline = this.app.createGraphicsPipelineWithBlend(frame, this.axisVertexShader, this.axisPixelShader,
                    null, this.gizmoBindingLayout, PrimitiveType.TriangleList, BlendMode.AlphaBlend);
                this.gizmoPipeline = gizmoPipeline;
            }
            frame.beginDraw(gizmoPipeline);
            frame.drawAddBindingSet(this.gizmoBindingSet);
            frame.drawVertices(this.gizmoSegments * VERTICES_PER_PARTICLE);
        }

        // A pipeline drawing into the HDR target: no depth, blended as the pass wants.
        createHdrPipeline(vertexShader: ShaderHandle, pixelShader: ShaderHandle, bindingLayout: BindingLayoutHandle,
            blendMode: BlendMode): GraphicsPipelineHandle {
            const desc = GraphicsPipelineDesc.create(vertexShader, pixelShader);
            desc.addBindingLayout(bindingLayout);
            desc.setDepthState(0, 0, ComparisonFunc.Always);
            desc.setBlendMode(blendMode);
            return this.app.createGraphicsPipelineFromDesc(desc, this.hdrFramebuffer);
        }

        // The HDR target, the blur chain and the binding sets over them, for a frame of width x
        // height: made on the first frame and again when the size changes (the old ones released once
        // the GPU is done with them).
        ensureBloomTargets(width: int, height: int): void {
            if (width == this.bloomWidth && height == this.bloomHeight) {
                return;
            }
            if (this.bloomWidth > 0) {
                this.app.waitForIdle();
                this.app.releaseResource(this.hdrFramebuffer);
                this.app.releaseResource(this.hdrTarget);
                for (let i = 0; i < this.blurChain.length; i++) {
                    this.app.releaseResource(this.blurChain[i]);
                }
                this.app.releaseResource(this.thresholdBindingSet.handle);
                for (let i = 0; i < this.blurDownBindingSets.length; i++) {
                    this.app.releaseResource(this.blurDownBindingSets[i].handle);
                }
                for (let i = 0; i < this.blurUpBindingSets.length; i++) {
                    this.app.releaseResource(this.blurUpBindingSets[i].handle);
                }
                this.app.releaseResource(this.compositeBindingSet.handle);
                // The pipelines were made for the old framebuffer.
                const graphicsPipeline = this.graphicsPipeline;
                if (graphicsPipeline) {
                    this.app.releaseResource(graphicsPipeline);
                    this.graphicsPipeline = null;
                }
                const trailPipeline = this.trailPipeline;
                if (trailPipeline) {
                    this.app.releaseResource(trailPipeline);
                    this.trailPipeline = null;
                }
                this.blurChain = [];
                this.blurDownBindingSets = [];
                this.blurUpBindingSets = [];
            }
            this.bloomWidth = width;
            this.bloomHeight = height;

            this.hdrTarget = this.app.createComputeReadableRenderTarget(width, height, Format.RGBA16_FLOAT, "HDR Color");
            this.hdrFramebuffer = this.app.createFramebuffer(this.hdrTarget, null);
            for (let level = 1; level <= BLUR_LEVELS; level++) {
                this.blurChain.push(this.app.createComputeTexture(levelSize(width, level), levelSize(height, level),
                    Format.RGBA16_FLOAT, `Blur Chain ${level}`));
            }
            this.thresholdBindingSet = this.createBlurBindingSet(this.hdrTarget, this.blurChain[0]);
            for (let index = 1; index < BLUR_LEVELS; index++) {
                this.blurDownBindingSets.push(this.createBlurBindingSet(this.blurChain[index - 1], this.blurChain[index]));
            }
            for (let index = BLUR_LEVELS - 2; index >= 1; index--) {
                this.blurUpBindingSets.push(this.createBlurBindingSet(this.blurChain[index + 1], this.blurChain[index]));
            }

            const compositeSetDesc = BindingSetDesc.create();
            compositeSetDesc.bindTextureSRV(4, this.hdrTarget);
            compositeSetDesc.bindTextureSRV(5, this.blurChain[BLOOM_INDEX]);
            compositeSetDesc.bindSampler(0, this.linearClamp);
            this.compositeBindingSet = this.app.createBindingSetForLayout(compositeSetDesc, this.compositeBindingLayout);
        }

        createBlurBindingSet(input: TextureHandle, output: TextureHandle): BindingSet {
            const setDesc = BindingSetDesc.create();
            setDesc.bindTextureSRV(0, input);
            setDesc.bindSampler(0, this.linearClamp);
            setDesc.bindTextureUAV(0, output);
            setDesc.bindPushConstants(0, BLUR_SIZE);
            return this.app.createBindingSetForLayout(setDesc, this.blurBindingLayout);
        }

        // One bloom pass: a thread per texel of the destination.
        dispatchBlurPass(commandList: CommandList, pipeline: ComputePipelineHandle, bindingSet: BindingSet,
            width: int, height: int, inputWidth: int, inputHeight: int): void {
            const b = this.blurConstants;
            Donut_StoreInt32(Ref(b[0]), width);
            Donut_StoreInt32(Ref(b[1]), height);
            b[2] = 1.0 / width;
            b[3] = 1.0 / height;
            b[4] = 1.0 / inputWidth;
            b[5] = 1.0 / inputHeight;
            b[6] = this.bloomThreshold;
            b[7] = this.bloomStrength;
            commandList.dispatchWithPushConstants(pipeline, bindingSet, Ref(b[0]), BLUR_SIZE,
                Math.floor((width + BLUR_GROUP_SIZE - 1) / BLUR_GROUP_SIZE), Math.floor((height + BLUR_GROUP_SIZE - 1) / BLUR_GROUP_SIZE), 1);
        }

        // A threshold pass into the first blur level, then blurring down the levels and back up to
        // the second (async_compute's "very basic and dumb HDR Bloom pipeline"). With no strength, the
        // chain stays black: the passes still run, as the composite reads it.
        renderBloom(commandList: CommandList): void {
            const w = this.bloomWidth;
            const h = this.bloomHeight;
            this.dispatchBlurPass(commandList, this.thresholdPipeline, this.thresholdBindingSet,
                levelSize(w, 1), levelSize(h, 1), w, h);
            for (let index = 1; index < BLUR_LEVELS; index++) {
                this.dispatchBlurPass(commandList, this.blurDownPipeline, this.blurDownBindingSets[index - 1],
                    levelSize(w, index + 1), levelSize(h, index + 1), levelSize(w, index), levelSize(h, index));
            }
            for (let index = BLUR_LEVELS - 2; index >= 1; index--) {
                this.dispatchBlurPass(commandList, this.blurUpPipeline, this.blurUpBindingSets[BLUR_LEVELS - 2 - index],
                    levelSize(w, index + 1), levelSize(h, index + 1), levelSize(w, index + 2), levelSize(h, index + 2));
            }
        }

        // Adds a segment from (x0, y0) to (x1, y1), in pixels from the top left, to the gizmo.
        addGizmoSegment(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, a: number): void {
            if (this.gizmoSegments >= GIZMO_MAX_SEGMENTS) {
                return;
            }
            const points = 4 + this.gizmoSegments * 4;
            const colors = 4 + (GIZMO_MAX_SEGMENTS + this.gizmoSegments) * 4;
            this.gizmoConstants[points + 0] = x0;
            this.gizmoConstants[points + 1] = y0;
            this.gizmoConstants[points + 2] = x1;
            this.gizmoConstants[points + 3] = y1;
            this.gizmoConstants[colors + 0] = r;
            this.gizmoConstants[colors + 1] = g;
            this.gizmoConstants[colors + 2] = b;
            this.gizmoConstants[colors + 3] = a;
            this.gizmoSegments++;
        }

        // The world X, Y and Z axes as the camera sees them: each axis direction in view space is a
        // row of the view matrix (row-vector convention), x to the right, y up and z away from the
        // camera. Axes pointing away are fainter, and each has its letter beyond the tip.
        buildGizmo(width: number, height: number): void {
            const scale = height / 720.0;
            const originX = GIZMO_ORIGIN * scale;
            const originY = GIZMO_ORIGIN * scale;
            this.gizmoConstants[0] = 1.0 / width;
            this.gizmoConstants[1] = 1.0 / height;
            this.gizmoSegments = 0;

            for (let axis = 0; axis < 3; axis++) {
                const viewX = this.viewMatrix[axis * 4 + 0];
                const viewY = this.viewMatrix[axis * 4 + 1];
                const viewZ = this.viewMatrix[axis * 4 + 2];
                const dx = viewX * GIZMO_LENGTH * scale;
                const dy = -viewY * GIZMO_LENGTH * scale;
                const tipX = originX + dx;
                const tipY = originY + dy;
                const r = axis == 0 ? 1.0 : 0.3;
                const g = axis == 1 ? 1.0 : (axis == 0 ? 0.3 : 0.55);
                const b = axis == 2 ? 1.0 : 0.3;
                const a = 0.35 + 0.65 * (0.5 - 0.5 * viewZ);
                this.addGizmoSegment(originX, originY, tipX, tipY, r, g, b, a);

                // The letter, outward from the origin (above the tip when the axis points at the camera).
                const length = Math.sqrt(dx * dx + dy * dy);
                const cx = length > 1.0 ? tipX + dx / length * GIZMO_LABEL_DISTANCE * scale : tipX;
                const cy = length > 1.0 ? tipY + dy / length * GIZMO_LABEL_DISTANCE * scale : tipY - GIZMO_LABEL_DISTANCE * scale;
                const w = GIZMO_LABEL_HALF_WIDTH * scale;
                const h = GIZMO_LABEL_HALF_HEIGHT * scale;
                if (axis == 0) {
                    this.addGizmoSegment(cx - w, cy - h, cx + w, cy + h, r, g, b, a);
                    this.addGizmoSegment(cx - w, cy + h, cx + w, cy - h, r, g, b, a);
                } else if (axis == 1) {
                    this.addGizmoSegment(cx - w, cy - h, cx, cy, r, g, b, a);
                    this.addGizmoSegment(cx + w, cy - h, cx, cy, r, g, b, a);
                    this.addGizmoSegment(cx, cy, cx, cy + h, r, g, b, a);
                } else {
                    this.addGizmoSegment(cx - w, cy - h, cx + w, cy - h, r, g, b, a);
                    this.addGizmoSegment(cx + w, cy - h, cx - w, cy + h, r, g, b, a);
                    this.addGizmoSegment(cx - w, cy + h, cx + w, cy + h, r, g, b, a);
                }
            }
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
                        const sizeRandom = randomFloat();
                        const radius = LIGHT_RADIUS_MIN + (LIGHT_RADIUS_MAX - LIGHT_RADIUS_MIN) * sizeRandom * sizeRandom;
                        const sizeRatio = radius / LIGHT_RADIUS_MIN;
                        const mass = LIGHT_MASS_MIN * sizeRatio * sizeRatio * sizeRatio;

                        // Position. The sample then scales y by 2 - length(normalize(position -
                        // attractor))^2, which is 1. Drawn again while it overlaps a particle
                        // placed before or a heavy center: compute_nbody's cloud has a third of
                        // the particles overlapping, which collide_cs would push apart and bounce
                        // off each other all at once in the first frames.
                        let px = 0.0;
                        let py = 0.0;
                        let pz = 0.0;
                        for (let attempt = 0; attempt < MAX_PLACEMENT_ATTEMPTS; attempt++) {
                            px = ax + randomNormal() * this.spread;
                            py = ay + randomNormal() * this.spread;
                            pz = az + randomNormal() * this.spread;
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

                    // No spin; the marker's direction from the particle's index, spread evenly over
                    // the sphere (a Fibonacci spiral: not from randomFloat, which would move
                    // the particles placed after it).
                    const index = i * this.particlesPerAttractor + j;
                    const markerZ = 1.0 - 2.0 * ((index % 997) + 0.5) / 997.0;
                    const markerRing = Math.sqrt(1.0 - markerZ * markerZ);
                    particles[p + 16] = markerRing * Math.cos(index * 2.399963);
                    particles[p + 17] = markerRing * Math.sin(index * 2.399963);
                    particles[p + 18] = markerZ;
                }
            }

            this.initialMass = 0.0;
            this.initialVolume = 0.0;
            for (let i = 0; i < this.numParticles; i++) {
                const radius = particles[i * PARTICLE_FLOATS + 8];
                this.initialMass += particles[i * PARTICLE_FLOATS + 3];
                this.initialVolume += radius * radius * radius;
            }
            this.initialAngular = this.angularMomentum(particles);
            this.initialMomentum = this.linearMomentum(particles);

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
            Donut_StoreInt32(Ref(this.simulationConstants[1]), this.numParticles);
            this.aliveCount = this.numParticles;
        }

        // The binding sets over the particle and contact buffers (compute, and the vertex shader's).
        createParticleBindings(): void {
            const computeSetDesc = BindingSetDesc.create();
            computeSetDesc.bindPushConstants(0, SIMULATION_CONSTANTS_SIZE);
            computeSetDesc.bindStructuredBufferUAV(0, this.particleBuffer);
            computeSetDesc.bindStructuredBufferUAV(1, this.contactBuffer);
            this.computeBindingSet = this.app.createBindingSetForLayout(computeSetDesc, this.computeBindingLayout);

            const drawSetDesc = BindingSetDesc.create();
            drawSetDesc.bindEntireConstantBuffer(1, this.viewConstantBuffer);
            drawSetDesc.bindStructuredBufferSRV(0, this.particleBuffer);
            this.drawBindingSet = this.app.createBindingSetForLayout(drawSetDesc, this.drawBindingLayout);

            const trailSetDesc = BindingSetDesc.create();
            trailSetDesc.bindEntireConstantBuffer(1, this.viewConstantBuffer);
            trailSetDesc.bindStructuredBufferSRV(0, this.particleBuffer);
            trailSetDesc.bindEntireConstantBuffer(3, this.trailBuffer);
            this.trailBindingSet = this.app.createBindingSetForLayout(trailSetDesc, this.trailBindingLayout);
        }

        // The total linear momentum m v of the particles in `particles` (the PARTICLE_FLOATS layout)
        // that are left, and the sum of m |v|, what its drift is measured against.
        linearMomentum(particles: f32[]): number[] {
            let total = [0.0, 0.0, 0.0, 0.0];
            for (let i = 0; i < this.numParticles; i++) {
                const q = i * PARTICLE_FLOATS;
                if (particles[q + 8] < 0.0) {
                    continue;
                }
                const mass = particles[q + 3];
                total[0] += mass * particles[q + 4];
                total[1] += mass * particles[q + 5];
                total[2] += mass * particles[q + 6];
                total[3] += mass * Math.sqrt(particles[q + 4] * particles[q + 4] + particles[q + 5] * particles[q + 5]
                    + particles[q + 6] * particles[q + 6]);
            }
            return total;
        }

        // The total angular momentum about the origin of the particles in `particles`: the orbits
        // m (p x v), and the spins 2/5 m r^2 w of the solid spheres; and, as the fourth number, the
        // sum of their sizes, what its drift is measured against.
        angularMomentum(particles: f32[]): number[] {
            let total = [0.0, 0.0, 0.0, 0.0];
            for (let i = 0; i < this.numParticles; i++) {
                const q = i * PARTICLE_FLOATS;
                const radius = particles[q + 8];
                if (radius < 0.0) {
                    continue;
                }
                const mass = particles[q + 3];
                const inertia = 0.4 * mass * radius * radius;
                total[0] += mass * (particles[q + 1] * particles[q + 6] - particles[q + 2] * particles[q + 5]) + inertia * particles[q + 12];
                total[1] += mass * (particles[q + 2] * particles[q + 4] - particles[q + 0] * particles[q + 6]) + inertia * particles[q + 13];
                total[2] += mass * (particles[q + 0] * particles[q + 5] - particles[q + 1] * particles[q + 4]) + inertia * particles[q + 14];
                total[3] += mass * Math.sqrt(particles[q + 0] * particles[q + 0] + particles[q + 1] * particles[q + 1]
                    + particles[q + 2] * particles[q + 2]) * Math.sqrt(particles[q + 4] * particles[q + 4]
                    + particles[q + 5] * particles[q + 5] + particles[q + 6] * particles[q + 6])
                    + inertia * Math.sqrt(particles[q + 12] * particles[q + 12] + particles[q + 13] * particles[q + 13]
                    + particles[q + 14] * particles[q + 14]);
            }
            return total;
        }

        // How many particles are left (the others merged into them), read back from the GPU. Only
        // ever fewer than at the start: a failed read keeps the last count.
        countAlive(): void {
            const particles = new TestCheck(this.app).readFloats(this.particleBuffer, this.numParticles * PARTICLE_FLOATS * 4);
            if (particles.length == 0) {
                return;
            }
            let alive = 0;
            for (let i = 0; i < this.numParticles; i++) {
                if (particles[i * PARTICLE_FLOATS + 8] >= 0.0) {
                    alive++;
                }
            }
            this.aliveCount = alive;
        }

        setFullGravity(full: boolean): void {
            this.fullGravity = full;
            Donut_StoreInt32(Ref(this.simulationConstants[CONSTANT_FULL_GRAVITY]), full ? 1 : 0);
        }

        setMergeSpeed(speed: number): void {
            this.simulationConstants[CONSTANT_MERGE_SPEED] = speed;
        }

        // The simulation's live settings back to their defaults (the UI's Defaults button).
        resetSimulationConstants(): void {
            this.simulationConstants[CONSTANT_TIME_FACTOR] = DEFAULT_TIME_FACTOR;
            this.simulationConstants[CONSTANT_GRAVITY] = DEFAULT_GRAVITY;
            this.simulationConstants[CONSTANT_RESTITUTION] = DEFAULT_RESTITUTION;
            this.simulationConstants[CONSTANT_HEAT_FACTOR] = DEFAULT_HEAT_FACTOR;
            this.simulationConstants[CONSTANT_COOL_SECONDS] = DEFAULT_COOL_SECONDS;
            this.simulationConstants[CONSTANT_FRICTION] = DEFAULT_FRICTION;
            this.simulationConstants[CONSTANT_MERGE_SPEED] = DEFAULT_MERGE_SPEED;
        }

        // Starts again with the UI's attractors, particles, spread and seed: new particles, in
        // new buffers (the old ones are released once the GPU is done with them).
        restart(): void {
            this.app.waitForIdle();
            this.app.releaseResource(this.computeBindingSet.handle);
            this.app.releaseResource(this.drawBindingSet.handle);
            this.app.releaseResource(this.trailBindingSet.handle);
            this.app.releaseResource(this.particleBuffer);
            this.app.releaseResource(this.contactBuffer);

            this.numAttractors = this.uiAttractors;
            this.particlesPerAttractor = this.uiParticles;
            this.spread = this.uiSpread;
            g_RandomSeed = this.uiSeed * 1.0;
            this.createParticles();
            this.createParticleBindings();
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
                // Merged away (a negative radius): not moving, its velocity means nothing.
                if (particles[i * PARTICLE_FLOATS + 8] >= 0.0 && speed > MAX_TEST_SPEED) {
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

            // Merging: the mass and the volume are kept, and some particles are gone (negative radius).
            if (this.simulationConstants[CONSTANT_MERGE_SPEED] > 0.0) {
                let mass = 0.0;
                let volume = 0.0;
                let gone = 0;
                for (let i = 0; i < this.numParticles; i++) {
                    const radius = particles[i * PARTICLE_FLOATS + 8];
                    mass += particles[i * PARTICLE_FLOATS + 3];
                    if (radius < 0.0) {
                        gone++;
                    } else {
                        volume += radius * radius * radius;
                    }
                }
                const angular = this.angularMomentum(particles);
                console.log(`Angular momentum: ${angular[0]}, ${angular[1]}, ${angular[2]} of ${this.initialAngular[0]}, ${this.initialAngular[1]}, ${this.initialAngular[2]}`);
                console.log(`Merged: ${gone} of ${this.numParticles} particles gone, mass ${mass} of ${this.initialMass}, volume ${volume} of ${this.initialVolume}`);
                if (gone == 0) {
                    return "no particles merged";
                }
                if (absolute(mass - this.initialMass) > this.initialMass * 1.0e-4
                    || absolute(volume - this.initialVolume) > this.initialVolume * 1.0e-3) {
                    return `the merges did not keep the mass (${mass} of ${this.initialMass}) or the volume (${volume} of ${this.initialVolume})`;
                }
            }

            // Every pair pulling both ways: the collisions, the friction and the merges keep the linear
            // and the angular momentum, measured against the larger of the sums of their sizes at
            // the start and now (the heavy centers start at rest). The push-outs of overlapping
            // particles move them without a velocity change and drift the angular momentum, a lot
            // for the light ones resting on a heavy center: use this for the heavy centers alone.
            if (this.fullGravity && this.particlesPerAttractor == 1) {
                const momentum = this.linearMomentum(particles);
                const angular = this.angularMomentum(particles);
                let momentumDrift = 0.0;
                let angularDrift = 0.0;
                for (let k = 0; k < 3; k++) {
                    momentumDrift = Math.max(momentumDrift, absolute(momentum[k] - this.initialMomentum[k]));
                    angularDrift = Math.max(angularDrift, absolute(angular[k] - this.initialAngular[k]));
                }
                const momentumLimit = Math.max(this.initialMomentum[3], momentum[3]) * MOMENTUM_DRIFT_LIMIT;
                const angularLimit = Math.max(this.initialAngular[3], angular[3]) * ANGULAR_DRIFT_LIMIT;
                console.log(`Momentum drift ${momentumDrift} (limit ${momentumLimit}), angular momentum drift ${angularDrift} (limit ${angularLimit})`);
                if (momentumDrift > momentumLimit || angularDrift > angularLimit) {
                    return `momentum drifts by ${momentumDrift} (over ${momentumLimit}) or angular momentum by ${angularDrift} (over ${angularLimit})`;
                }
            }

            // Spin (friction's torque): finite, and the marker stays a unit vector.
            let maxSpin = 0.0;
            for (let i = 0; i < this.numParticles; i++) {
                const q = i * PARTICLE_FLOATS;
                const spin = Math.sqrt(particles[q + 12] * particles[q + 12] + particles[q + 13] * particles[q + 13]
                    + particles[q + 14] * particles[q + 14]);
                const marker = Math.sqrt(particles[q + 16] * particles[q + 16] + particles[q + 17] * particles[q + 17]
                    + particles[q + 18] * particles[q + 18]);
                if (!isFinite32(spin) || !isFinite32(marker) || absolute(marker - 1.0) > 0.001) {
                    return `particle ${i}: spin ${spin} or marker length ${marker} is not finite or 1`;
                }
                maxSpin = Math.max(maxSpin, spin);
            }
            console.log(`Spin: max ${maxSpin}`);
            if (this.numParticles > 2 && this.simulationConstants[CONSTANT_FRICTION] > 0.0 && maxSpin <= 0.0) {
                return "no particle spins: the friction gave none a torque";
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

        // Slider and checkbox values are written back to the simulation as they change.
        buildUI(): void {
            Donut_ImGuiSetNextWindowPosPivot(this.frameWidth - 10.0, 10.0, 1.0, 0.0);
            Donut_ImGuiBegin("N-Body Collisions", 1);
            Donut_ImGuiPushItemWidth(180.0);

            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Simulation") != 0) {
                this.paused = Donut_ImGuiCheckbox("Paused (Space)", this.paused ? 1 : 0) != 0;
                const collisions = Donut_ImGuiCheckbox("Collisions (C)", this.collisions ? 1 : 0) != 0;
                if (collisions != this.collisions) {
                    this.collisions = collisions;
                    Donut_StoreInt32(Ref(this.simulationConstants[2]), collisions ? 1 : 0);
                }
                const heating = Donut_ImGuiCheckbox("Heating (H)", this.heating ? 1 : 0) != 0;
                if (heating != this.heating) {
                    this.heating = heating;
                    Donut_StoreInt32(Ref(this.simulationConstants[3]), heating ? 1 : 0);
                }
                this.showPlanes = Donut_ImGuiCheckbox("Planes (P)", this.showPlanes ? 1 : 0) != 0;
                const fullGravity = Donut_ImGuiCheckbox("Gravity between all pairs", this.fullGravity ? 1 : 0) != 0;
                if (fullGravity != this.fullGravity) {
                    this.setFullGravity(fullGravity);
                }
                this.showTrails = Donut_ImGuiCheckbox("Trails (T)", this.showTrails ? 1 : 0) != 0;
                this.trailSeconds = Donut_ImGuiSliderFloat("Trail length", this.trailSeconds, 0.0, TRAIL_SECONDS_MAX);
                this.bloomStrength = Donut_ImGuiSliderFloat("Bloom", this.bloomStrength, 0.0, 2.0);
                this.bloomThreshold = Donut_ImGuiSliderFloat("Bloom threshold", this.bloomThreshold, 0.0, 2.0);

                this.simulationConstants[CONSTANT_TIME_FACTOR] = Donut_ImGuiSliderFloat("Time scale",
                    this.simulationConstants[CONSTANT_TIME_FACTOR], 0.0, 0.2);
                this.simulationConstants[CONSTANT_GRAVITY] = Donut_ImGuiSliderFloat("Gravity",
                    this.simulationConstants[CONSTANT_GRAVITY], 0.0, 0.01);
                this.simulationConstants[CONSTANT_RESTITUTION] = Donut_ImGuiSliderFloat("Bounciness",
                    this.simulationConstants[CONSTANT_RESTITUTION], 0.0, 1.0);
                this.simulationConstants[CONSTANT_FRICTION] = Donut_ImGuiSliderFloat("Friction",
                    this.simulationConstants[CONSTANT_FRICTION], 0.0, 1.0);
                this.simulationConstants[CONSTANT_MERGE_SPEED] = Donut_ImGuiSliderFloat("Merge below speed",
                    this.simulationConstants[CONSTANT_MERGE_SPEED], 0.0, MERGE_SPEED_MAX);
                this.simulationConstants[CONSTANT_HEAT_FACTOR] = Donut_ImGuiSliderFloat("Heat per bounce",
                    this.simulationConstants[CONSTANT_HEAT_FACTOR], 0.0, 0.02);
                this.simulationConstants[CONSTANT_COOL_SECONDS] = Donut_ImGuiSliderFloat("Cooling seconds",
                    this.simulationConstants[CONSTANT_COOL_SECONDS], 0.5, 10.0);
                if (Donut_ImGuiButton("Defaults") != 0) {
                    this.resetSimulationConstants();
                }
            }

            if (Donut_ImGuiCollapsingHeaderDefaultOpen("New simulation") != 0) {
                this.uiAttractors = Donut_ImGuiSliderInt("Attractors", this.uiAttractors, 1, MAX_ATTRACTORS);
                const choice = Donut_ImGuiCombo("Particles each", particleChoiceIndex(this.uiParticles), PARTICLE_CHOICES);
                if (choice >= 0 && choice != particleChoiceIndex(this.uiParticles)) {
                    this.uiParticles = particleChoice(choice);
                }
                this.uiSpread = Donut_ImGuiSliderFloat("Cloud spread", this.uiSpread, 0.2, 3.0);
                this.uiSeed = Donut_ImGuiSliderInt("Random seed", this.uiSeed, 1, 99999);
                if (Donut_ImGuiButton("Restart") != 0) {
                    this.restartRequested = true;
                }
                Donut_ImGuiText(this.aliveCount == this.numParticles
                    ? this.numParticles + " particles running"
                    : this.aliveCount + " of " + this.numParticles + " particles left");
            }

            Donut_ImGuiPopItemWidth();
            Donut_ImGuiEnd();
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shaderFile = "compute_nbody_collisions.hlsl";
            this.vertexShader = this.app.createShader(shaderFile, "main_vs", ShaderType.Vertex);
            this.pixelShader = this.app.createShader(shaderFile, "main_ps", ShaderType.Pixel);
            const calculateShader = this.app.createShaderWithDefine(shaderFile, "calculate_cs", ShaderType.Compute, "SIMULATION", "1");
            const countShader = this.app.createShaderWithDefine(shaderFile, "count_cs", ShaderType.Compute, "SIMULATION", "1");
            const collideShader = this.app.createShaderWithDefine(shaderFile, "collide_cs", ShaderType.Compute, "SIMULATION", "1");
            const absorbShader = this.app.createShaderWithDefine(shaderFile, "absorb_cs", ShaderType.Compute, "SIMULATION", "1");
            const killShader = this.app.createShaderWithDefine(shaderFile, "kill_cs", ShaderType.Compute, "SIMULATION", "1");
            this.compositeVertexShader = this.app.createShader(shaderFile, "composite_vs", ShaderType.Vertex);
            this.compositePixelShader = this.app.createShader(shaderFile, "composite_ps", ShaderType.Pixel);
            const postFile = "compute_nbody_collisions_post.hlsl";
            const thresholdShader = this.app.createShader(postFile, "threshold_cs", ShaderType.Compute);
            const blurDownShader = this.app.createShader(postFile, "blur_down_cs", ShaderType.Compute);
            const blurUpShader = this.app.createShader(postFile, "blur_up_cs", ShaderType.Compute);
            const integrateShader = this.app.createShaderWithDefine(shaderFile, "integrate_cs", ShaderType.Compute, "SIMULATION", "1");
            this.axisVertexShader = this.app.createShader(shaderFile, "axis_vs", ShaderType.Vertex);
            this.axisPixelShader = this.app.createShader(shaderFile, "axis_ps", ShaderType.Pixel);
            this.planeVertexShader = this.app.createShader(shaderFile, "plane_vs", ShaderType.Vertex);
            this.trailVertexShader = this.app.createShader(shaderFile, "trail_vs", ShaderType.Vertex);
            // The gizmo's pixel shader: a plain color.
            this.planePixelShader = this.axisPixelShader;
            if (!this.compositeVertexShader || !this.compositePixelShader || !thresholdShader || !blurDownShader || !blurUpShader
                || !this.planeVertexShader || !this.trailVertexShader || !this.axisVertexShader || !this.axisPixelShader || !this.vertexShader || !this.pixelShader || !calculateShader || !countShader || !collideShader || !absorbShader || !killShader || !integrateShader) {
                return false;
            }

            // Donut's common passes, which hold the samplers, upload their textures on a command list of
            // their own: before ours is open.
            this.linearClamp = this.app.getCommonSampler(CommonSampler.LinearClamp);

            this.createParticles();

            // The bloom's passes: each reads a texture through the sampler, writes another, and has
            // its resolutions as push constants; the composite reads the scene and the bloom.
            const blurLayoutDesc = BindingLayoutDesc.create();
            blurLayoutDesc.layoutTextureSRV(0);
            blurLayoutDesc.layoutSampler(0);
            blurLayoutDesc.layoutTextureUAV(0);
            blurLayoutDesc.layoutPushConstants(0, BLUR_SIZE);
            this.blurBindingLayout = this.app.createBindingLayout(blurLayoutDesc, ShaderType.Compute);
            this.thresholdPipeline = this.app.createComputePipelineWithLayout(thresholdShader, this.blurBindingLayout);
            this.blurDownPipeline = this.app.createComputePipelineWithLayout(blurDownShader, this.blurBindingLayout);
            this.blurUpPipeline = this.app.createComputePipelineWithLayout(blurUpShader, this.blurBindingLayout);
            const compositeLayoutDesc = BindingLayoutDesc.create();
            compositeLayoutDesc.layoutTextureSRV(4);
            compositeLayoutDesc.layoutTextureSRV(5);
            compositeLayoutDesc.layoutSampler(0);
            this.compositeBindingLayout = this.app.createBindingLayout(compositeLayoutDesc, ShaderType.Pixel);

            // Compute: the particles, their contacts and the SimulationConstants push constants.
            const computeLayoutDesc = BindingLayoutDesc.create();
            computeLayoutDesc.layoutPushConstants(0, SIMULATION_CONSTANTS_SIZE);
            computeLayoutDesc.layoutStructuredBufferUAV(0);
            computeLayoutDesc.layoutStructuredBufferUAV(1);
            const computeBindingLayout = this.app.createBindingLayout(computeLayoutDesc, ShaderType.Compute);
            this.computeBindingLayout = computeBindingLayout;

            this.calculatePipeline = this.app.createComputePipelineWithLayout(calculateShader, computeBindingLayout);
            this.countPipeline = this.app.createComputePipelineWithLayout(countShader, computeBindingLayout);
            this.collidePipeline = this.app.createComputePipelineWithLayout(collideShader, computeBindingLayout);
            this.absorbPipeline = this.app.createComputePipelineWithLayout(absorbShader, computeBindingLayout);
            this.killPipeline = this.app.createComputePipelineWithLayout(killShader, computeBindingLayout);
            this.integratePipeline = this.app.createComputePipelineWithLayout(integrateShader, computeBindingLayout);

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

            // The trails' length and opacity, written in the command list every frame.
            this.trailBuffer = this.app.createConstantBuffer(TRAIL_CONSTANTS_SIZE, "Trail");
            const trailLayoutDesc = BindingLayoutDesc.create();
            trailLayoutDesc.layoutConstantBuffer(1);
            trailLayoutDesc.layoutStructuredBufferSRV(0);
            trailLayoutDesc.layoutConstantBuffer(3);
            this.trailBindingLayout = this.app.createBindingLayout(trailLayoutDesc, ShaderType.Vertex);

            this.createParticleBindings();

            // The axis gizmo's segments, written in the command list every frame.
            this.gizmoBuffer = this.app.createConstantBuffer(GIZMO_FLOATS * 4, "Gizmo");
            const gizmoLayoutDesc = BindingLayoutDesc.create();
            gizmoLayoutDesc.layoutConstantBuffer(2);
            this.gizmoBindingLayout = this.app.createBindingLayout(gizmoLayoutDesc, ShaderType.Vertex);
            const gizmoSetDesc = BindingSetDesc.create();
            gizmoSetDesc.bindEntireConstantBuffer(2, this.gizmoBuffer);
            this.gizmoBindingSet = this.app.createBindingSetForLayout(gizmoSetDesc, this.gizmoBindingLayout);

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

            // Drawn after (over) the scene, and sees the mouse first.
            if (this.showUI && this.app.addImGuiPass(this.buildUI).isNull()) {
                return false;
            }
            return true;
        }
    }

    class NBodyCollisionsArgs extends Args {
        // -attractors <n>: heavy centers, 1 to 6 (6 by default), each with its group of particles.
        numAttractors: int = NUM_ATTRACTORS;
        // -particles <n>: particles per attractor, the heavy center first (1024 by default).
        particlesPerAttractor: int = PARTICLES_PER_ATTRACTOR;
        // -merge <speed>: particles touching slower than this merge (0, off, by default).
        mergeSpeed: number = DEFAULT_MERGE_SPEED;
        // -fullgravity: every pair pulls both ways (see SimulationConstants.fullGravity).
        fullGravity: boolean = false;

        protected parseOptions(): void {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-attractors" && i + 1 < this.argc) {
                    this.numAttractors = parseInt(this[i + 1]);
                    i++;
                } else if (arg == "-particles" && i + 1 < this.argc) {
                    this.particlesPerAttractor = parseInt(this[i + 1]);
                    i++;
                } else if (arg == "-fullgravity") {
                    this.fullGravity = true;
                } else if (arg == "-merge" && i + 1 < this.argc) {
                    this.mergeSpeed = parseFloat(this[i + 1]);
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

        const nbody = new NBodyCollisionsPass(app, args.numAttractors, args.particlesPerAttractor, !args.test, !args.noUI);
        if (!nbody.init()) {
            app.destroy();
            return 1;
        }
        nbody.setMergeSpeed(args.mergeSpeed);
        nbody.setFullGravity(args.fullGravity);

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

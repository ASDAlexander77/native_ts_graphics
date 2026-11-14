/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { radians, perspProjD3DStyleReverse } from "../../core/matrix";
import { DonutThirdPersonCamera } from "../../core/donut_third_person_camera";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace ComputeNBodyCollisionsNri {
    // compute_nbody_collisions, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead
    // of Donut and NVRHI: the same shaders (compute_nbody_collisions.hlsl's and
    // compute_nbody_collisions_post.hlsl's), Donut's ThirdPersonCamera and PlanarViewConstants as Donut
    // computes them (core/donut_third_person_camera.ts, Nri.fillDonutPlanarViewConstants), through the
    // NRI calls core/nri/nri_interop.d.ts binds. This example creates everything it runs, and does the
    // rendering.

    const WINDOW_TITLE = "NRI Example: Compute N-Body Collisions";

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): D3D11 (see initialize).
    const TEST_SKIPPED = 77;

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
    const MAX_ATTRACTORS = 24;
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
    // struct Contact: float4 velocity, float4 shift, float4 spin, float4 fragment.
    const CONTACT_FLOATS = 16;
    // struct SimulationConstants: float deltaT, int particleCount, int collisions, int heating, then
    // the UI's values (the indices below), padded to 80 bytes.
    const SIMULATION_CONSTANTS_SIZE = 80;
    const SIMULATION_FLOATS = SIMULATION_CONSTANTS_SIZE / 4;
    const CONSTANT_TIME_FACTOR = 4;
    const CONSTANT_GRAVITY = 5;
    const CONSTANT_RESTITUTION = 6;
    const CONSTANT_HEAT_FACTOR = 7;
    const CONSTANT_COOL_SECONDS = 8;
    const CONSTANT_FRICTION = 9;
    const CONSTANT_MERGE_SPEED = 10;
    const CONSTANT_FULL_GRAVITY = 11;
    const CONSTANT_FRAGMENT_SPEED = 12;
    const CONSTANT_CONTACT_SPRINGS = 13;
    const CONSTANT_RESTITUTION_SPEED = 14;
    const CONSTANT_ROLLING_RESISTANCE = 15;
    const CONSTANT_SIZE_SOFTENING = 16;
    const CONSTANT_HOT_MERGE_SPEED = 17;
    // The simulation's defaults (compute_nbody's, then the collisions'), and what the UI's sliders
    // can set them to.
    const DEFAULT_TIME_FACTOR = 0.05;
    const DEFAULT_GRAVITY = 0.002;
    const DEFAULT_RESTITUTION = 0.8;
    const DEFAULT_HEAT_FACTOR = 0.004;
    const DEFAULT_COOL_SECONDS = 3.0;
    const DEFAULT_FRICTION = 0.3;
    // Bounciness falls as (this / impact speed)^(1/4) above this impact speed, up to the slider's
    // RESTITUTION_SPEED_MAX.
    const DEFAULT_RESTITUTION_SPEED = 5.0;
    const RESTITUTION_SPEED_MAX = 50.0;
    // Rolling resistance: the couple at a contact over the contact radius times the normal impulse,
    // at most; the slider goes up to ROLLING_RESISTANCE_MAX.
    const DEFAULT_ROLLING_RESISTANCE = 0.05;
    const ROLLING_RESISTANCE_MAX = 0.5;
    // Off (-merge unset): particles touching slower than this (relative speed) merge; the UI's
    // switch for it is off, its slider at DEFAULT_MERGE_SLIDER, up to MERGE_SPEED_MAX.
    const DEFAULT_MERGE_SPEED = 0.0;
    const DEFAULT_MERGE_SLIDER = 2.0;
    const MERGE_SPEED_MAX = 8.0;
    // With merging: glowing particles merge up to this much faster (the shader's MergeSpeed), up to
    // the slider's HOT_MERGE_SPEED_MAX.
    const DEFAULT_HOT_MERGE_SPEED = 4.0;
    const HOT_MERGE_SPEED_MAX = 20.0;
    // Off: particles hit harder than this (approach speed) break in two, into free slots: those of
    // merged-away particles, and the room left at the start, a share of the particles placed
    // (-room <percent>, the UI's Fragment room, on restart). The UI's slider goes to
    // FRAGMENT_SPEED_MAX (its switch off, the slider at DEFAULT_FRAGMENT_SLIDER).
    const DEFAULT_FRAGMENT_SPEED = 0.0;
    const DEFAULT_FRAGMENT_SLIDER = 10.0;
    const FRAGMENT_SPEED_MAX = 50.0;
    const DEFAULT_FRAGMENT_ROOM = 0.0;
    // With gravity between all pairs (-fullgravity), the test checks the momentum and the angular
    // momentum drifted by less than this much of the sums of their sizes. The heavy centers alone
    // (-particles 1): merging the six (-merge 20) drifts the angular momentum by 3e-6 of it with the
    // merged spins' exact balance, and 2e-4 with their average. With light particles, piled up and
    // overlapping: 2e-3 with the contact springs, 0.8 with the push-outs they replaced.
    const MOMENTUM_DRIFT_LIMIT = 1.0e-3;
    const ANGULAR_DRIFT_LIMIT_HEAVY = 1.0e-4;
    const ANGULAR_DRIFT_LIMIT = 1.0e-2;
    // With merging, the merged particles are heavy and hit hard, and a particle's several swept
    // contacts in one step don't quite agree on where it is: the angular momentum drifts by up to
    // about 1.1e-2 (4e3 to 7e4, from run to run), a time-step error (a quarter of the step drifts
    // 10 to 30 times less), not a broken balance.
    const ANGULAR_DRIFT_LIMIT_MERGE = 2.0e-2;
    // With gravity between all pairs and no cooling (-fullgravity -nocool), the test checks the total
    // energy (kinetic, spin, potential and heat) drifted by less than this much of it: gravity alone
    // keeps it to 2e-3; the collisions, whose losses are all heat, to 2.5e-2 in 15 seconds.
    const ENERGY_DRIFT_LIMIT = 0.05;
    // With merging (and no breaking), the merged particles' collision radius over their true radius,
    // weighted by mass, is at least this at the end: they grow back to their size after a merge fits
    // them into a pile (0.62 to 1 measured; it was 0.02 to 0.11 when they grew into free room only).
    const MERGED_SIZE_MIN = 0.4;
    // -nocool's cooling time: the heat stays.
    const NO_COOLING_SECONDS = 1.0e9;
    // The gravity pass's softening (SOFTEN in the shader), in its potential energy; the contact
    // springs' stiffness and the share of the reach they push on (CONTACT_STIFFNESS,
    // CONTACT_OVERLAP_MAX), in theirs, for -test's step of 1/60 s.
    const GRAVITY_SOFTENING = 0.05;
    const CONTACT_STIFFNESS = 0.25;
    const CONTACT_OVERLAP_MAX = 0.5;
    const TEST_DELTA_T = 1.0 / 60.0;
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
    // A fragment is smaller than any particle placed at the start (half the volume of the smallest).
    const FRAGMENT_RADIUS = LIGHT_RADIUS_MIN * 0.7937005;
    const LIGHT_RADIUS_MAX = 0.1;
    const LIGHT_MASS_MIN = 20.0;
    // Mass follows volume: LIGHT_MASS_MIN at LIGHT_RADIUS_MIN, HEAVY_MASS at HEAVY_RADIUS, whatever
    // radii the UI sets. The sliders' ranges for the radii.
    const HEAVY_MASS = 90000.0;
    const HEAVY_RADIUS_MAX = 2.0;
    const LIGHT_RADIUS_SLIDER_MIN = 0.01;
    const LIGHT_RADIUS_SLIDER_MAX = 0.4;
    // How the light particles are placed around their attractor (sigma / radius from the cloud
    // spread), and how the attractors are laid out (the radius is the layout's, in scene units).
    const PARTICLE_LAYOUTS = "Gaussian cloud|Uniform ball|Spherical shell|Flat disk";
    enum ParticleLayout {
        Gaussian = 0,
        Ball = 1,
        Shell = 2,
        Disk = 3
    }
    const ATTRACTOR_LAYOUTS = "Preset (random beyond 6)|Random in a ball|Ring|Sphere|Line";
    enum AttractorLayout {
        Preset = 0,
        Random = 1,
        Ring = 2,
        Sphere = 3,
        Line = 4
    }
    const DEFAULT_LAYOUT_RADIUS = 8.0;
    const LAYOUT_RADIUS_MAX = 30.0;
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
    // Constant buffer views' alignment (D3D12: their size a multiple of 256 bytes).
    const CONSTANTS_ALIGNMENT = 256;

    // GLFW's key codes (NriSample.isKeyToggled): the example's keys.
    const KEY_C = 67;
    const KEY_H = 72;
    const KEY_P = 80;
    const KEY_T = 84;

    // The UI's choices of particles per attractor: the gravity pass expects the heavy centers at
    // multiples of 1024 (but any count works up to 256 particles in all, as in -particles 1).
    const PARTICLE_CHOICES = "1|1024|2048|4096|8192|16384|32768|65536";
    function particleChoiceIndex(particles: int) {
        return particles == 1 ? 0 : (particles == 1024 ? 1 : (particles == 2048 ? 2 : -1));
    }
    function particleChoice(index: int) {
        return index == 0 ? 1 : (index == 1 ? 1024 : 2048);
    }

    // The size of a level of the blur chain: level 0 is the target's.
    function levelSize(size: int, level: int): int {
        return Math.max(1, size >> level);
    }

    function align(size: int) {
        return Math.floor((size + CONSTANTS_ALIGNMENT - 1) / CONSTANTS_ALIGNMENT) * CONSTANTS_ALIGNMENT;
    }

    // An f32 array of n zeros.
    function zeros(n: int) {
        const values: f32[] = [];
        for (let i = 0; i < n; i++) {
            values.push(0.0);
        }
        return values;
    }

    // A float32 value is finite.
    function isFinite32(x: number): boolean {
        return x > -1.0e38 && x < 1.0e38;
    }

    // Whether moving a texture from state before to after needs a barrier: not to the state it's in.
    function needsBarrier(before: NriTextureState, after: NriTextureState) {
        return before != after;
    }

    // --- Math ---------------------------------------------------------------------------------

    // std::default_random_engine replacement: a Park-Miller generator, from a seed so runs repeat.
    let g_RandomSeed = DEFAULT_SEED * 1.0;
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

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into.
    class QueuedFrame {
        constructor(public commandBuffer: NriCommandBuffer) {
        }
    }

    // --- Passes -------------------------------------------------------------------------------

    // Port of examples/compute_nbody_collisions.ts to NRI. compute_nbody with collisions: the
    // particles are spheres that bounce off each other and off the heavy centers. Four compute
    // passes: velocities from gravity (as compute_nbody), then each particle's contacts counted,
    // then the collisions (every particle against every other, each writing only its own velocity
    // change and position correction into a second buffer, so no particle reads one that another
    // thread has already moved), then positions. Space pauses, C turns the collisions off and on.
    // The kinetic energy the bounces lose becomes heat (info.y: it makes the particle glow, and cools
    // off over a few seconds), H turns the heating off and on, P the coordinate planes (XY, XZ and YZ
    // grids through the origin), T the trails. The particles are solid spheres with spin: friction at
    // a contact (Coulomb, the Friction slider) slows their sliding and, by its torque, sets them
    // spinning (ApplyFriction in the shader); the spin shows as a mark at the poles of a direction
    // fixed in the particle, which it turns. The UI (a window in the top right corner, off with
    // -noUI) sets the gravity, time scale, bounciness and heat live, and the number of attractors and
    // particles, the spread of the clouds and the random seed on Restart, which starts the simulation
    // again from the initial state. Left alone for IDLE_SECONDS, the camera starts to orbit the target
    // slowly; any input stops it. The compute passes go into the frame's command buffer ahead of the
    // draws, with the buffers' barriers between them (NVRHI's UAV barriers between passes on one
    // binding set); the scene is drawn into an RGBA16F target, bloomed by compute passes and
    // composited into the swap chain.
    class NBodyCollisions {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        // The swap chain textures' format.
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        // The simulation's layout and pipelines: the SimulationConstants (root constants, b0), the
        // particles, contacts, free slots and pending particles (u0 to u3, a descriptor set).
        private computeLayout: NriPipelineLayout | null = null;
        // The simulation's descriptor set (the particles, contacts, free slots and pending particles)
        // and its pool.
        private computePool: NriDescriptorPool | null = null;
        private computeSet: NriDescriptorSet | null = null;
        private calculatePipeline: NriPipeline | null = null;
        private countPipeline: NriPipeline | null = null;
        private collidePipeline: NriPipeline | null = null;
        private absorbPipeline: NriPipeline | null = null;
        private killPipeline: NriPipeline | null = null;
        private collectFreePipeline: NriPipeline | null = null;
        private fragmentPipeline: NriPipeline | null = null;
        private splitPipeline: NriPipeline | null = null;
        private integratePipeline: NriPipeline | null = null;
        // The draws' layouts: the particles' and planes' (view b1, particles t0, trail b3), the
        // gizmo's (b2), the composite's (a set: the scene t4, the bloom t5, the sampler s0), the
        // bloom passes' (a set: input t0, sampler s0, output u0; BlurConstants root constants b0).
        private drawLayout: NriPipelineLayout | null = null;
        private gizmoLayout: NriPipelineLayout | null = null;
        private compositeLayout: NriPipelineLayout | null = null;
        private blurLayout: NriPipelineLayout | null = null;
        private graphicsPipeline: NriPipeline | null = null;
        private trailPipeline: NriPipeline | null = null;
        private planePipeline: NriPipeline | null = null;
        private gizmoPipeline: NriPipeline | null = null;
        private compositePipeline: NriPipeline | null = null;
        private thresholdPipeline: NriPipeline | null = null;
        private blurDownPipeline: NriPipeline | null = null;
        private blurUpPipeline: NriPipeline | null = null;

        // The particles (Storage while the passes run, VertexShaderResource for the draws), their
        // contacts, the free slots (u_Free: 2 counts, then up to numParticles indices) and the
        // particles absorb_cs and fragment_cs leave for the next pass to write back (u_Pending).
        private particleBuffer: NriBuffer | null = null;
        private contactBuffer: NriBuffer | null = null;
        private freeBuffer: NriBuffer | null = null;
        private pendingBuffer: NriBuffer | null = null;
        private particlesStorage: NriDescriptor | null = null;
        private particlesView: NriDescriptor | null = null;
        private contactsStorage: NriDescriptor | null = null;
        private freeStorage: NriDescriptor | null = null;
        private pendingStorage: NriDescriptor | null = null;
        private particleState: NriBufferState = NriBufferState.Storage;
        // The particles copied back (for the alive count and the test).
        private particleReadbackBuffer: NriBuffer | null = null;
        // The alive count's copy: asked for this frame, and recorded in a frame submitted since.
        private aliveCopyRequested: boolean = false;
        private aliveCopyPending: boolean = false;

        // A queued frame's PlanarViewConstants, trail constants and gizmo constants, frameStride
        // bytes apart (a view of each, bound at the frame's offset).
        private constantBuffer: NriBuffer | null = null;
        private viewConstantsView: NriDescriptor | null = null;
        private trailView: NriDescriptor | null = null;
        private gizmoView: NriDescriptor | null = null;
        private viewSize: int = 0;
        private viewStride: int = 0;
        private trailStride: int = 0;
        private gizmoStride: int = 0;
        private frameStride: int = 0;

        // The bloom's targets, for the frame's size: the HDR target (rendered into, read by the
        // threshold pass and the composite), the blur chain (written and read by the passes, level
        // BLOOM_INDEX read by the composite); their states; the sets.
        private hdrTarget: NriTexture | null = null;
        private hdrAttachment: NriDescriptor | null = null;
        private hdrView: NriDescriptor | null = null;
        private hdrState: NriTextureState = NriTextureState.ShaderResource;
        private blurChain: NriTexture[] = [];
        private blurViews: NriDescriptor[] = [];
        private blurStorages: NriDescriptor[] = [];
        private blurStates: NriTextureState[] = [];
        private linearClamp: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private thresholdSet: NriDescriptorSet | null = null;
        private blurDownSets: NriDescriptorSet[] = [];
        private blurUpSets: NriDescriptorSet[] = [];
        private compositeSet: NriDescriptorSet | null = null;
        private blurConstants: f32[] = zeros(BLUR_FLOATS);

        private camera: DonutThirdPersonCamera = new DonutThirdPersonCamera();
        private paused: boolean = false;
        private collisions: boolean = true;
        private heating: boolean = true;
        private showPlanes: boolean = true;
        // The UI's switches: each feature on or off, and the sliders' values, which the simulation
        // uses only while their switch is on (applySwitches).
        private frictionOn: boolean = true;
        private frictionValue: number = DEFAULT_FRICTION;
        private mergeOn: boolean = false;
        private mergeValue: number = DEFAULT_MERGE_SLIDER;
        // Hot particles sticking (merging faster): its switch and slider.
        private hotStickOn: boolean = true;
        private hotStickValue: number = DEFAULT_HOT_MERGE_SPEED;
        private breakOn: boolean = false;
        private breakValue: number = DEFAULT_FRAGMENT_SLIDER;
        private contactSprings: boolean = true;
        // Bounciness falling with the impact speed, rolling resistance, and gravity softened by the
        // particles' size: their switches, and the first two's sliders.
        private restitutionSpeedOn: boolean = true;
        private restitutionSpeedValue: number = DEFAULT_RESTITUTION_SPEED;
        private rollingOn: boolean = true;
        private rollingValue: number = DEFAULT_ROLLING_RESISTANCE;
        private sizeSoftening: boolean = true;
        private bloomOn: boolean = true;
        private litSpheres: boolean = true;
        private spinMarks: boolean = true;
        private showGizmo: boolean = true;
        private showTrails: boolean = true;
        private bloomThreshold: number = DEFAULT_BLOOM_THRESHOLD;
        private bloomStrength: number = DEFAULT_BLOOM_STRENGTH;
        private trailSeconds: number = DEFAULT_TRAIL_SECONDS;
        // The UI's settings applied on Restart (the pass's own are those of the running simulation),
        // and whether Restart was pressed: it is done at the start of the next frame.
        private uiAttractors: int = NUM_ATTRACTORS;
        private uiParticles: int = PARTICLES_PER_ATTRACTOR;
        private uiSpread: number = DEFAULT_SPREAD;
        private uiSeed: int = DEFAULT_SEED;
        // More of the UI's settings for the next Restart, read by createParticles: the radii of the
        // heavy centers and the range of the light ones, and how both are placed.
        private uiHeavyRadius: number = HEAVY_RADIUS;
        private uiLightRadiusMin: number = LIGHT_RADIUS_MIN;
        private uiLightRadiusMax: number = LIGHT_RADIUS_MAX;
        private uiParticleLayout: int = ParticleLayout.Gaussian;
        private uiAttractorLayout: int = AttractorLayout.Preset;
        private uiLayoutRadius: number = DEFAULT_LAYOUT_RADIUS;
        private spread: number = DEFAULT_SPREAD;
        private restartRequested: boolean = false;
        // Seconds since the last input.
        private idleSeconds: number = 0.0;
        // -test renders the same frames every run: no rotation.
        private autoRotate: boolean = true;
        private numParticles: int = 0;
        // The share of the particles placed left as free slots at the start (the one running, and the
        // UI's for the next restart), and how many were placed.
        private fragmentRoom: number = DEFAULT_FRAGMENT_ROOM;
        private uiFragmentRoom: number = DEFAULT_FRAGMENT_ROOM;
        private placedCount: int = 0;
        // The mass and the volume (sum of cubed radii) the particles started with: merging keeps both.
        private initialMass: number = 0.0;
        private aliveCount: int = 0;
        private framesSinceCount: int = 0;
        private initialVolume: number = 0.0;
        // The angular momentum about the origin (x, y, z) the particles started with, and its scale.
        private initialAngular: number[] = [0.0, 0.0, 0.0, 0.0];
        // The linear momentum (x, y, z, and the sum of m |v|, its scale).
        private initialMomentum: number[] = [0.0, 0.0, 0.0, 0.0];
        private initialEnergy: number = 0.0;
        private fullGravity: boolean = false;

        // The command line's settings (-attractors, -particles, -merge, -fragment, -room,
        // -fullgravity, -nocool, -noUI), applied in initialize where the Donut example applies them.
        numAttractors: int = NUM_ATTRACTORS;
        particlesPerAttractor: int = PARTICLES_PER_ATTRACTOR;
        argMergeSpeed: number = DEFAULT_MERGE_SPEED;
        argFragmentSpeed: number = DEFAULT_FRAGMENT_SPEED;
        argFragmentRoom: number = DEFAULT_FRAGMENT_ROOM;
        argFullGravity: boolean = false;
        argNoCool: boolean = false;
        noUI: boolean = false;

        // The SimulationConstants root constants, the trail and gizmo constants, the
        // PlanarViewConstants, and the matrices they're from (16 floats each).
        private simulationConstants: f32[] = zeros(SIMULATION_FLOATS);
        private trailConstants: f32[] = [0.0, TRAIL_OPACITY, 0.0, 0.0];
        private gizmoConstants: f32[] = zeros(GIZMO_FLOATS);
        private gizmoSegments: int = 0;
        private viewConstants: f32[] = [];
        private viewMatrix: f32[] = zeros(16);
        private projMatrix: f32[] = zeros(16);

        // -test: the last frame and the particles after it are read back.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        constructor(private sample: NriSample) {
            this.resetSimulationConstants();
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
            this.autoRotate = !this.test;

            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                this.queuedFrames.push(new QueuedFrame(new NriCommandBuffer(this.frames.commandBuffer(i).handle)));
            }

            // NRI's D3D11 backend makes every buffer of 4-byte structures a raw buffer, which the
            // shaders' free slots (RWStructuredBuffer<uint> u_Free) can't be bound as.
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "D3D11: NRI makes the free slots' RWStructuredBuffer<uint> a raw buffer";
                return 0;
            }

            if (!this.createLayouts(device) || !this.createPipelines(device, graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv")) {
                return 0;
            }

            // The common passes' linear clamp sampler.
            this.linearClamp = device.createSamplerWithMipFilter(NriFilter.Linear, NriFilter.Linear, NriAddressMode.ClampToEdge, 1);

            this.fragmentRoom = this.argFragmentRoom;
            this.uiFragmentRoom = this.argFragmentRoom;
            this.uiAttractors = this.numAttractors;
            this.uiParticles = this.particlesPerAttractor;
            if (!this.createParticles(device)) {
                console.log("Cannot create the particles");
                return 0;
            }
            Nri.storeInt32(Ref(this.simulationConstants[2]), 1);
            Nri.storeInt32(Ref(this.simulationConstants[3]), 1);

            // The constant buffer: a queued frame's PlanarViewConstants, trail constants and gizmo
            // constants.
            this.viewSize = Nri.getDonutConstantsSize(0);
            this.viewConstants = zeros(this.viewSize / 4);
            this.viewStride = align(this.viewSize);
            this.trailStride = align(TRAIL_CONSTANTS_SIZE);
            this.gizmoStride = align(GIZMO_FLOATS * 4);
            this.frameStride = this.viewStride + this.trailStride + this.gizmoStride;
            const constantBuffer = device.createHostBuffer(queuedFrameNum * this.frameStride, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            if (!constantBuffer || !this.linearClamp) {
                console.log("Cannot create the constant buffer");
                return 0;
            }
            this.viewConstantsView = constantBuffer.createConstantView(0, this.viewStride);
            this.trailView = constantBuffer.createConstantView(0, this.trailStride);
            this.gizmoView = constantBuffer.createConstantView(0, this.gizmoStride);
            if (!this.viewConstantsView || !this.trailView || !this.gizmoView) {
                console.log("Cannot create the constant buffer views");
                return 0;
            }

            if (!this.createBloomTargets(device)) {
                return 0;
            }

            // compute_nbody's look-at camera: 14 units from the origin, rotated (-26, 75) degrees.
            this.camera.setTarget(0.0, 0.0, 0.0);
            this.camera.setDistance(14.0);
            this.camera.setRotation(radians(75.0), radians(26.0));

            // The command line's settings, as the Donut example's main applies them after init.
            this.setMergeSpeed(this.argMergeSpeed);
            this.setFragmentSpeed(this.argFragmentSpeed);
            this.setFullGravity(this.argFullGravity);
            if (this.argNoCool) {
                this.setCooling(NO_COOLING_SECONDS);
            }

            // The settings window.
            if (!this.noUI) {
                if (this.sample.initImgui(device) == 0) {
                    console.log("Cannot initialize the user interface");
                    return 0;
                }
                this.imgui = true;
            }

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The layouts, as the Donut example's binding layouts. False (after printing why) on failure.
        createLayouts(device: NriDevice): boolean {
            const computeDesc = NriPipelineLayoutDesc.create();
            computeDesc.addRootConstants(0, SIMULATION_CONSTANTS_SIZE, NriStage.Compute);
            // The particles, contacts, free slots and pending particles (u0 to u3) in a descriptor set,
            // as the Donut example's binding set.
            computeDesc.addRange(0, 0, 4, NriDescriptorType.StorageStructuredBuffer, NriStage.Compute, NriRangeFlags.None);
            this.computeLayout = device.createPipelineLayoutFromDesc(computeDesc);
            computeDesc.destroy();

            const drawDesc = NriPipelineLayoutDesc.create();
            drawDesc.addRootDescriptor(1, NriDescriptorType.ConstantBuffer, NriStage.Vertex);
            drawDesc.addRootDescriptor(0, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            drawDesc.addRootDescriptor(3, NriDescriptorType.ConstantBuffer, NriStage.Vertex);
            this.drawLayout = device.createPipelineLayoutFromDesc(drawDesc);
            drawDesc.destroy();

            const gizmoDesc = NriPipelineLayoutDesc.create();
            gizmoDesc.addRootDescriptor(2, NriDescriptorType.ConstantBuffer, NriStage.Vertex);
            this.gizmoLayout = device.createPipelineLayoutFromDesc(gizmoDesc);
            gizmoDesc.destroy();

            const compositeDesc = NriPipelineLayoutDesc.create();
            compositeDesc.addRange(0, 4, 2, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            compositeDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.compositeLayout = device.createPipelineLayoutFromDesc(compositeDesc);
            compositeDesc.destroy();

            const blurDesc = NriPipelineLayoutDesc.create();
            blurDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Compute, NriRangeFlags.None);
            blurDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Compute, NriRangeFlags.None);
            blurDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
            blurDesc.addRootConstants(0, BLUR_SIZE, NriStage.Compute);
            this.blurLayout = device.createPipelineLayoutFromDesc(blurDesc);
            blurDesc.destroy();

            if (!this.computeLayout || !this.drawLayout || !this.gizmoLayout || !this.compositeLayout || !this.blurLayout) {
                console.log("Cannot create the pipeline layouts");
                return false;
            }
            return true;
        }

        // The pipelines: the shaders as compiled for the Donut example (the simulation's with
        // SIMULATION=1). False (after printing why) on failure.
        createPipelines(device: NriDevice, folder: string): boolean {
            const computeLayout = this.computeLayout;
            const drawLayout = this.drawLayout;
            const gizmoLayout = this.gizmoLayout;
            const compositeLayout = this.compositeLayout;
            const blurLayout = this.blurLayout;
            if (!computeLayout || !drawLayout || !gizmoLayout || !compositeLayout || !blurLayout) {
                return false;
            }
            const shaders = `shaders/compute_nbody_collisions/${folder}/compute_nbody_collisions`;
            this.calculatePipeline = this.createSimulationPipeline(device, computeLayout, shaders, "calculate_cs");
            this.countPipeline = this.createSimulationPipeline(device, computeLayout, shaders, "count_cs");
            this.collidePipeline = this.createSimulationPipeline(device, computeLayout, shaders, "collide_cs");
            this.absorbPipeline = this.createSimulationPipeline(device, computeLayout, shaders, "absorb_cs");
            this.killPipeline = this.createSimulationPipeline(device, computeLayout, shaders, "kill_cs");
            this.collectFreePipeline = this.createSimulationPipeline(device, computeLayout, shaders, "collect_free_cs");
            this.fragmentPipeline = this.createSimulationPipeline(device, computeLayout, shaders, "fragment_cs");
            this.splitPipeline = this.createSimulationPipeline(device, computeLayout, shaders, "split_cs");
            this.integratePipeline = this.createSimulationPipeline(device, computeLayout, shaders, "integrate_cs");
            this.thresholdPipeline = device.createComputePipeline(blurLayout, `${shaders}_post_threshold_cs.bin`, "threshold_cs");
            this.blurDownPipeline = device.createComputePipeline(blurLayout, `${shaders}_post_blur_down_cs.bin`, "blur_down_cs");
            this.blurUpPipeline = device.createComputePipeline(blurLayout, `${shaders}_post_blur_up_cs.bin`, "blur_up_cs");

            // Into the HDR target (createHdrPipeline: no depth): the balls additively, the trails
            // alpha blended. Into the swap chain: the composite not blended, the planes and the gizmo
            // alpha blended. Back faces culled (NVRHI's default raster state).
            this.graphicsPipeline = this.createPipeline(device, drawLayout, shaders, "main_vs", "main_ps", NriFormat.RGBA16_SFLOAT, 1);
            this.trailPipeline = this.createPipeline(device, drawLayout, shaders, "trail_vs", "axis_ps", NriFormat.RGBA16_SFLOAT, 2);
            this.planePipeline = this.createPipeline(device, drawLayout, shaders, "plane_vs", "axis_ps", this.viewFormat, 2);
            this.gizmoPipeline = this.createPipeline(device, gizmoLayout, shaders, "axis_vs", "axis_ps", this.viewFormat, 2);
            this.compositePipeline = this.createPipeline(device, compositeLayout, shaders, "composite_vs", "composite_ps", this.viewFormat, 0);

            if (!this.calculatePipeline || !this.countPipeline || !this.collidePipeline || !this.absorbPipeline || !this.killPipeline
                || !this.collectFreePipeline || !this.fragmentPipeline || !this.splitPipeline || !this.integratePipeline || !this.thresholdPipeline
                || !this.blurDownPipeline || !this.blurUpPipeline || !this.graphicsPipeline || !this.trailPipeline || !this.planePipeline
                || !this.gizmoPipeline || !this.compositePipeline) {
                console.log("Cannot load the compute n-body collisions shaders");
                return false;
            }
            return true;
        }

        createSimulationPipeline(device: NriDevice, layout: NriPipelineLayout, shaders: string, entry: string) {
            return device.createComputePipelinePermutation(layout, `${shaders}_${entry}.bin`, entry, "SIMULATION=1");
        }

        // A draw's pipeline into a target of format: blend 0 none, 1 Donut's additive (color one +
        // one, alpha srcAlpha + dstAlpha), 2 Donut's alpha blending (color srcAlpha + invSrcAlpha,
        // alpha invSrcAlpha + zero); back faces culled, no depth.
        createPipeline(device: NriDevice, layout: NriPipelineLayout, shaders: string, vs: string, ps: string,
            format: NriFormat, blend: int) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_${vs}.bin`, vs) != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_${ps}.bin`, ps) != 0;
            }
            desc.setCullMode(NriCullMode.Back);
            desc.setColor(format, NriColorWrite.RGBA);
            if (blend == 1) {
                desc.setAdditiveBlend();
            } else if (blend == 2) {
                desc.setBlend(NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha, NriBlendOp.Add,
                    NriBlendFactor.OneMinusSrcAlpha, NriBlendFactor.Zero, NriBlendOp.Add);
            }
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain and the bloom targets (with
        // their pool and sets) again at its size, once the GPU is done with the old ones. The gizmo,
        // the projection and the settings window follow the stored size each frame.
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
            this.destroyBloomTargets();
            this.createBloomTargets(device);
        }

        // Destroys the HDR target, the blur chain, their views and the pool and sets over them.
        destroyBloomTargets() {
            const descriptorPool = this.descriptorPool;
            if (descriptorPool) {
                descriptorPool.destroy();
            }
            this.descriptorPool = null;
            this.thresholdSet = null;
            this.blurDownSets = [];
            this.blurUpSets = [];
            this.compositeSet = null;
            this.destroyDescriptor(this.hdrAttachment);
            this.destroyDescriptor(this.hdrView);
            const hdrTarget = this.hdrTarget;
            if (hdrTarget) {
                hdrTarget.destroy();
            }
            this.hdrAttachment = null;
            this.hdrView = null;
            this.hdrTarget = null;
            this.hdrState = NriTextureState.ShaderResource;
            for (let i = 0; i < this.blurChain.length; i++) {
                this.blurViews[i].destroy();
                this.blurStorages[i].destroy();
                this.blurChain[i].destroy();
            }
            this.blurChain = [];
            this.blurViews = [];
            this.blurStorages = [];
            this.blurStates = [];
        }

        // The HDR target, the blur chain, their views and the sets over them, for the stored (window's)
        // size. False (after printing why) on failure.
        createBloomTargets(device: NriDevice): boolean {
            const compositeLayout = this.compositeLayout;
            const blurLayout = this.blurLayout;
            const linearClamp = this.linearClamp;
            if (!compositeLayout || !blurLayout || !linearClamp) {
                return false;
            }
            const hdrTarget = device.createRenderTargetTexture(this.queue, this.width, this.height, NriFormat.RGBA16_SFLOAT);
            this.hdrTarget = hdrTarget;
            if (!hdrTarget) {
                console.log("Cannot create the HDR target");
                return false;
            }
            this.hdrAttachment = hdrTarget.createColorAttachmentView(NriFormat.RGBA16_SFLOAT);
            const hdrView = hdrTarget.createView(NriFormat.RGBA16_SFLOAT);
            this.hdrView = hdrView;
            for (let level = 1; level <= BLUR_LEVELS; level++) {
                const texture = device.createStorageTexture(this.queue, levelSize(this.width, level), levelSize(this.height, level),
                    NriFormat.RGBA16_SFLOAT);
                if (!texture) {
                    console.log("Cannot create the blur chain");
                    return false;
                }
                this.blurChain.push(texture);
                this.blurViews.push(texture.createView(NriFormat.RGBA16_SFLOAT));
                this.blurStorages.push(texture.createStorageView(NriFormat.RGBA16_SFLOAT));
                this.blurStates.push(NriTextureState.Storage);
            }

            // A set per bloom pass (the threshold pass, BLUR_LEVELS - 1 down, BLUR_LEVELS - 2 up) and
            // the composite's.
            const blurSetNum = 1 + (BLUR_LEVELS - 1) + (BLUR_LEVELS - 2);
            const descriptorPool = device.createDescriptorPool(blurSetNum + 1, blurSetNum + 1, 0, blurSetNum + 2, blurSetNum, 0);
            this.descriptorPool = descriptorPool;
            if (!descriptorPool) {
                console.log("Cannot create the descriptor pool");
                return false;
            }
            this.thresholdSet = this.createBlurSet(descriptorPool, blurLayout, linearClamp, hdrView, this.blurStorages[0]);
            for (let index = 1; index < BLUR_LEVELS; index++) {
                const set = this.createBlurSet(descriptorPool, blurLayout, linearClamp, this.blurViews[index - 1], this.blurStorages[index]);
                if (!set) {
                    return false;
                }
                this.blurDownSets.push(set);
            }
            for (let index = BLUR_LEVELS - 2; index >= 1; index--) {
                const set = this.createBlurSet(descriptorPool, blurLayout, linearClamp, this.blurViews[index + 1], this.blurStorages[index]);
                if (!set) {
                    return false;
                }
                this.blurUpSets.push(set);
            }
            const compositeSet = descriptorPool.allocateDescriptorSet(compositeLayout, 0, 0);
            this.compositeSet = compositeSet;
            if (!this.thresholdSet || !compositeSet) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            compositeSet.updateDescriptor(0, 0, hdrView);
            compositeSet.updateDescriptor(0, 1, this.blurViews[BLOOM_INDEX]);
            compositeSet.updateDescriptor(1, 0, linearClamp);
            return true;
        }

        // A bloom pass's set: its input and sampler, its output.
        createBlurSet(descriptorPool: NriDescriptorPool, layout: NriPipelineLayout, sampler: NriDescriptor,
            input: NriDescriptor, output: NriDescriptor) {
            const set = descriptorPool.allocateDescriptorSet(layout, 0, 0);
            if (!set) {
                console.log("Cannot create the descriptor sets");
                return null;
            }
            set.updateDescriptor(0, 0, input);
            set.updateDescriptor(1, 0, sampler);
            set.updateDescriptor(2, 0, output);
            return set;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // 1 if the key (a GLFW key code) was pressed since the last frame.
        toggled(key: int) {
            return this.sample.isKeyToggled(key) != 0;
        }

        // The Donut example's input callbacks and onAnimate: a restart asked for (before this frame's
        // commands: the GPU idle, the buffers replaced); the keys; the camera (its input, unless the
        // settings window has the mouse; its idle orbit); the step; now and then the particles left
        // counted; the window title.
        update() {
            if (this.restartRequested) {
                this.restartRequested = false;
                this.restart();
            }

            // In test mode 1/60 second a frame in float32, as Donut's test mode passes it.
            const elapsedSeconds = Math.fround(this.test ? 1.0 / 60.0 : this.sample.getFrameTime());
            if (this.toggled(NriKey.Space)) {
                this.paused = !this.paused;
                this.idleSeconds = 0.0;
            }
            if (this.toggled(KEY_C)) {
                this.collisions = !this.collisions;
                Nri.storeInt32(Ref(this.simulationConstants[2]), this.collisions ? 1 : 0);
                this.idleSeconds = 0.0;
            }
            if (this.toggled(KEY_H)) {
                this.heating = !this.heating;
                Nri.storeInt32(Ref(this.simulationConstants[3]), this.heating ? 1 : 0);
                this.idleSeconds = 0.0;
            }
            if (this.toggled(KEY_P)) {
                this.showPlanes = !this.showPlanes;
                this.idleSeconds = 0.0;
            }
            if (this.toggled(KEY_T)) {
                this.showTrails = !this.showTrails;
                this.idleSeconds = 0.0;
            }
            const overlay = this.imgui && NriImgui.wantsMouse() != 0;
            if (this.camera.mouse(this.sample, !overlay)) {
                this.idleSeconds = 0.0;
            }

            // Left alone for a while, the camera drifts around the target, keeping its pitch and
            // distance, from wherever the user left it: speeding up so it doesn't start with a jerk.
            this.idleSeconds += elapsedSeconds;
            if (this.autoRotate && this.idleSeconds > IDLE_SECONDS) {
                const ramp = Math.min((this.idleSeconds - IDLE_SECONDS) / IDLE_RAMP_SECONDS, 1.0);
                this.camera.setRotation(this.camera.yaw + IDLE_ROTATION_SPEED * ramp * elapsedSeconds, this.camera.pitch);
            }
            this.camera.animate();

            this.simulationConstants[0] = elapsedSeconds < MAX_DELTA_T ? elapsedSeconds : MAX_DELTA_T;

            // Merged-away particles don't show: count the ones left now and then.
            this.framesSinceCount++;
            if ((this.simulationConstants[CONSTANT_MERGE_SPEED] > 0.0 || this.simulationConstants[CONSTANT_FRAGMENT_SPEED] > 0.0)
                && !this.paused && this.framesSinceCount >= ALIVE_COUNT_FRAMES) {
                this.framesSinceCount = 0;
                this.countAlive();
            }

            const collisionsInfo = (this.collisions ? "collisions on" : "collisions off")
                + (this.heating ? ", heating on" : ", heating off");
            this.sample.setWindowTitle(this.paused
                ? `${WINDOW_TITLE} - ${this.aliveCount} particles, ${collisionsInfo} (paused)`
                : `${WINDOW_TITLE} - ${this.aliveCount} particles, ${collisionsInfo}`);
        }

        // The view constants (the camera: 60 degrees vertically, as in the sample), the trails'
        // constants and the gizmo's, into the queued frame's part of the constant buffer.
        writeConstants(offset: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            const worldToView = this.camera.worldToView;
            const projection = perspProjD3DStyleReverse(radians(60.0), this.width / this.height, 0.1);
            for (let i = 0; i < 16; i++) {
                this.viewMatrix[i] = worldToView[i];
                this.projMatrix[i] = projection[i];
            }
            Nri.fillDonutPlanarViewConstants(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), this.width, this.height,
                Ref(this.viewConstants[0]));
            constantBuffer.write(offset, Ref(this.viewConstants[0]), this.viewSize);

            // The trails' constants and the balls' switches, read by both.
            this.trailConstants[0] = this.simulationConstants[CONSTANT_TIME_FACTOR] * this.trailSeconds;
            this.trailConstants[2] = this.litSpheres ? 1.0 : 0.0;
            this.trailConstants[3] = this.spinMarks ? 1.0 : 0.0;
            constantBuffer.write(offset + this.viewStride, Ref(this.trailConstants[0]), TRAIL_CONSTANTS_SIZE);

            this.buildGizmo(this.width, this.height);
            constantBuffer.write(offset + this.viewStride + this.trailStride, Ref(this.gizmoConstants[0]), GIZMO_FLOATS * 4);
        }

        // A barrier moving the particles to state, unless they're in it.
        setParticleState(commandBuffer: NriCommandBuffer, state: NriBufferState) {
            const particleBuffer = this.particleBuffer;
            if (!particleBuffer || this.particleState == state) {
                return;
            }
            commandBuffer.bufferBarrier(particleBuffer, this.particleState, state);
            this.particleState = state;
        }

        // Copies the particles to particleReadbackBuffer.
        recordParticleReadback(commandBuffer: NriCommandBuffer) {
            const particleBuffer = this.particleBuffer;
            const particleReadbackBuffer = this.particleReadbackBuffer;
            if (!particleBuffer || !particleReadbackBuffer) {
                return;
            }
            const state = this.particleState;
            this.setParticleState(commandBuffer, NriBufferState.CopySource);
            commandBuffer.copyBuffer(particleReadbackBuffer, particleBuffer, this.numParticles * PARTICLE_FLOATS * 4);
            this.setParticleState(commandBuffer, state);
        }

        // One simulation pass over the particles (rounded up: the shaders skip the threads past
        // particleCount), then the barriers NVRHI puts between passes on one binding set: what it
        // wrote, the next one sees.
        dispatch(commandBuffer: NriCommandBuffer, pipeline: NriPipeline | null) {
            const particleBuffer = this.particleBuffer;
            const contactBuffer = this.contactBuffer;
            const freeBuffer = this.freeBuffer;
            const pendingBuffer = this.pendingBuffer;
            const particlesStorage = this.particlesStorage;
            const contactsStorage = this.contactsStorage;
            const freeStorage = this.freeStorage;
            const pendingStorage = this.pendingStorage;
            const computeSet = this.computeSet;
            if (!pipeline || !particleBuffer || !contactBuffer || !freeBuffer || !pendingBuffer || !particlesStorage || !contactsStorage
                || !freeStorage || !pendingStorage) {
                return;
            }
            if (!computeSet) {
                return;
            }
            const groups: int = Math.floor((this.numParticles + WORKGROUP_SIZE - 1) / WORKGROUP_SIZE);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setComputeRootConstants(0, Ref(this.simulationConstants[0]), SIMULATION_CONSTANTS_SIZE);
            commandBuffer.setComputeDescriptorSet(0, computeSet);
            commandBuffer.dispatch(groups, 1, 1);
            commandBuffer.bufferBarrier(particleBuffer, NriBufferState.Storage, NriBufferState.Storage);
            commandBuffer.bufferBarrier(contactBuffer, NriBufferState.Storage, NriBufferState.Storage);
            commandBuffer.bufferBarrier(freeBuffer, NriBufferState.Storage, NriBufferState.Storage);
            commandBuffer.bufferBarrier(pendingBuffer, NriBufferState.Storage, NriBufferState.Storage);
        }

        // Gravity, collisions, integration. Paused, nothing moves: the collision pass would still
        // push overlapping particles apart.
        recordSimulation(commandBuffer: NriCommandBuffer) {
            const computeLayout = this.computeLayout;
            const freeBuffer = this.freeBuffer;
            if (this.paused || !computeLayout || !freeBuffer) {
                return;
            }
            this.setParticleState(commandBuffer, NriBufferState.Storage);
            commandBuffer.setComputePipelineLayout(computeLayout);
            this.dispatch(commandBuffer, this.calculatePipeline);
            const fragmenting = this.collisions && this.simulationConstants[CONSTANT_FRAGMENT_SPEED] > 0.0;
            if (fragmenting) {
                // The free slots' counts zeroed (the Donut example writes the two; the indices after
                // them are written before they're read).
                commandBuffer.bufferBarrier(freeBuffer, NriBufferState.Storage, NriBufferState.CopyDestination);
                commandBuffer.zeroBuffer(freeBuffer);
                commandBuffer.bufferBarrier(freeBuffer, NriBufferState.CopyDestination, NriBufferState.Storage);
            }
            if (this.collisions) {
                this.dispatch(commandBuffer, this.countPipeline);
                this.dispatch(commandBuffer, this.collidePipeline);
                if (this.simulationConstants[CONSTANT_MERGE_SPEED] > 0.0) {
                    // The survivors absorb the merging particles, which are then removed.
                    this.dispatch(commandBuffer, this.absorbPipeline);
                    this.dispatch(commandBuffer, this.killPipeline);
                }
            }
            if (fragmenting) {
                // The free slots (after the merges have freed theirs).
                this.dispatch(commandBuffer, this.collectFreePipeline);
            }
            this.dispatch(commandBuffer, this.integratePipeline);
            if (fragmenting) {
                this.dispatch(commandBuffer, this.fragmentPipeline);
                this.dispatch(commandBuffer, this.splitPipeline);
            }
        }

        // vertexNum vertices of a pipeline of the draw layout: the view, the particles, the trails'
        // constants, at the queued frame's offset.
        drawParticles(commandBuffer: NriCommandBuffer, pipeline: NriPipeline | null, offset: int, vertexNum: int) {
            const drawLayout = this.drawLayout;
            const viewConstantsView = this.viewConstantsView;
            const particlesView = this.particlesView;
            const trailView = this.trailView;
            if (!drawLayout || !pipeline || !viewConstantsView || !particlesView || !trailView) {
                return;
            }
            commandBuffer.setPipelineLayout(drawLayout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setRootDescriptor(0, viewConstantsView, offset);
            commandBuffer.setRootDescriptor(1, particlesView, 0);
            commandBuffer.setRootDescriptor(2, trailView, offset + this.viewStride);
            commandBuffer.draw(vertexNum, 1, 0, 0);
        }

        // A barrier moving the HDR target to state, unless it's in it.
        setHdrState(commandBuffer: NriCommandBuffer, state: NriTextureState) {
            const hdrTarget = this.hdrTarget;
            if (!hdrTarget) {
                return;
            }
            if (needsBarrier(this.hdrState, state)) {
                commandBuffer.textureBarrier(hdrTarget, this.hdrState, state);
            }
            this.hdrState = state;
        }

        // The HDR target cleared, the trails (as long as the time scale makes them, under the balls:
        // they add up to a haze in the pile), the balls; then it goes to the bloom and the composite.
        recordScene(commandBuffer: NriCommandBuffer, offset: int) {
            const hdrAttachment = this.hdrAttachment;
            if (!hdrAttachment) {
                return;
            }
            this.setParticleState(commandBuffer, NriBufferState.VertexShaderResource);
            this.setHdrState(commandBuffer, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(hdrAttachment);
            commandBuffer.clearColor(0.0, 0.0, 0.0, 1.0);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            if (this.showTrails && this.trailSeconds > 0.0) {
                this.drawParticles(commandBuffer, this.trailPipeline, offset, this.numParticles * VERTICES_PER_PARTICLE);
            }
            this.drawParticles(commandBuffer, this.graphicsPipeline, offset, this.numParticles * VERTICES_PER_PARTICLE);
            commandBuffer.endRendering();
            this.setHdrState(commandBuffer, NriTextureState.AllShaderResource);
        }

        // A barrier moving blur chain level index to state, unless it's in it.
        setBlurState(commandBuffer: NriCommandBuffer, index: int, state: NriTextureState) {
            if (needsBarrier(this.blurStates[index], state)) {
                commandBuffer.textureBarrier(this.blurChain[index], this.blurStates[index], state);
            }
            this.blurStates[index] = state;
        }

        // One bloom pass: its input (a blur level, or -1: the HDR target) read, its output written,
        // a thread per texel of the output.
        dispatchBlurPass(commandBuffer: NriCommandBuffer, pipeline: NriPipeline | null, set: NriDescriptorSet | null,
            input: int, output: int, width: int, height: int, inputWidth: int, inputHeight: int) {
            if (!pipeline || !set) {
                return;
            }
            if (input >= 0) {
                this.setBlurState(commandBuffer, input, NriTextureState.AllShaderResource);
            }
            this.setBlurState(commandBuffer, output, NriTextureState.Storage);
            const b = this.blurConstants;
            Nri.storeInt32(Ref(b[0]), width);
            Nri.storeInt32(Ref(b[1]), height);
            b[2] = 1.0 / width;
            b[3] = 1.0 / height;
            b[4] = 1.0 / inputWidth;
            b[5] = 1.0 / inputHeight;
            b[6] = this.bloomThreshold;
            b[7] = this.bloomOn ? this.bloomStrength : 0.0;
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setComputeDescriptorSet(0, set);
            commandBuffer.setComputeRootConstants(0, Ref(b[0]), BLUR_SIZE);
            commandBuffer.dispatch(Math.floor((width + BLUR_GROUP_SIZE - 1) / BLUR_GROUP_SIZE),
                Math.floor((height + BLUR_GROUP_SIZE - 1) / BLUR_GROUP_SIZE), 1);
        }

        // A threshold pass into the first blur level, then blurring down the levels and back up to
        // the second (async_compute's "very basic and dumb HDR Bloom pipeline"). With no strength, the
        // chain stays black: the passes still run, as the composite reads it.
        recordBloom(commandBuffer: NriCommandBuffer) {
            const blurLayout = this.blurLayout;
            if (!blurLayout) {
                return;
            }
            const w = this.width;
            const h = this.height;
            commandBuffer.setComputePipelineLayout(blurLayout);
            this.dispatchBlurPass(commandBuffer, this.thresholdPipeline, this.thresholdSet, -1, 0, levelSize(w, 1), levelSize(h, 1), w, h);
            for (let index = 1; index < BLUR_LEVELS; index++) {
                this.dispatchBlurPass(commandBuffer, this.blurDownPipeline, this.blurDownSets[index - 1], index - 1, index,
                    levelSize(w, index + 1), levelSize(h, index + 1), levelSize(w, index), levelSize(h, index));
            }
            for (let index = BLUR_LEVELS - 2; index >= 1; index--) {
                this.dispatchBlurPass(commandBuffer, this.blurUpPipeline, this.blurUpSets[BLUR_LEVELS - 2 - index], index + 1, index,
                    levelSize(w, index + 1), levelSize(h, index + 1), levelSize(w, index + 2), levelSize(h, index + 2));
            }
            this.setBlurState(commandBuffer, BLOOM_INDEX, NriTextureState.AllShaderResource);
        }

        // The scene and its bloom into the swap chain, the coordinate planes (under the gizmo), the
        // axes (over the particles, in the top left corner). Between NriCommandBuffer.beginRendering and
        // NriCommandBuffer.endRendering.
        recordComposite(commandBuffer: NriCommandBuffer, offset: int) {
            const compositeLayout = this.compositeLayout;
            const compositePipeline = this.compositePipeline;
            const compositeSet = this.compositeSet;
            const gizmoLayout = this.gizmoLayout;
            const gizmoPipeline = this.gizmoPipeline;
            const gizmoView = this.gizmoView;
            if (!compositeLayout || !compositePipeline || !compositeSet || !gizmoLayout || !gizmoPipeline || !gizmoView) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(compositeLayout);
            commandBuffer.setPipeline(compositePipeline);
            commandBuffer.setDescriptorSet(0, compositeSet);
            commandBuffer.draw(3, 1, 0, 0);

            if (this.showPlanes) {
                this.drawParticles(commandBuffer, this.planePipeline, offset, PLANE_LINE_COUNT * VERTICES_PER_PARTICLE);
            }

            if (this.showGizmo) {
                commandBuffer.setPipelineLayout(gizmoLayout);
                commandBuffer.setPipeline(gizmoPipeline);
                commandBuffer.setRootDescriptor(0, gizmoView, offset + this.viewStride + this.trailStride);
                commandBuffer.draw(this.gizmoSegments * VERTICES_PER_PARTICLE, 1, 0, 0);
            }
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.update();
            if (this.imgui) {
                this.buildUI();
            }

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                this.recordAndSubmit(frameIndex, queuedFrameIndex, queuedFrame, index);
            }

            // Signaled after the present, as NRISamples do
            this.frames.signal(frameIndex);
        }

        // Records the frame into the queued frame's command buffer, submits it and presents.
        recordAndSubmit(frameIndex: int, queuedFrameIndex: int, queuedFrame: QueuedFrame, index: int) {
            const descriptorPool = this.descriptorPool;
            if (!descriptorPool) {
                return;
            }
            const commandBuffer = queuedFrame.commandBuffer;
            const offset = queuedFrameIndex * this.frameStride;
            this.writeConstants(offset);

            // Record: the particles copied back for the alive count (as they are before this frame's
            // step, as the Donut example counts them); the simulation; the scene into the HDR target,
            // its bloom; the composite, the planes, the gizmo and the settings window into the swap
            // chain.
            commandBuffer.begin();
            commandBuffer.setDescriptorPool(descriptorPool);
            if (this.aliveCopyRequested) {
                this.aliveCopyRequested = false;
                this.recordParticleReadback(commandBuffer);
                this.aliveCopyPending = true;
            }
            // The simulation's set is in a pool of its own (D3D12: its heap bound while it's used).
            const computePool = this.computePool;
            if (computePool) {
                commandBuffer.setDescriptorPool(computePool);
                this.recordSimulation(commandBuffer);
                commandBuffer.setDescriptorPool(descriptorPool);
            }
            this.recordScene(commandBuffer, offset);
            this.recordBloom(commandBuffer);
            if (this.imgui) {
                this.sample.copyImguiData(commandBuffer);
            }
            commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.Undefined, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
            this.recordComposite(commandBuffer, offset);
            if (this.imgui) {
                this.sample.drawImgui(commandBuffer, this.viewFormat);
            }
            commandBuffer.endRendering();

            // The test's last frame: read back, and the particles after it
            let presentFrom = NriTextureState.ColorAttachment;
            const readbackBuffer = this.readbackBuffer;
            if (readbackBuffer) {
                if (frameIndex == TEST_FRAMES - 1) {
                    commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.ColorAttachment, NriTextureState.CopySource);
                    commandBuffer.readbackTextureToBuffer(readbackBuffer, this.rowPitch, this.swapChain.texture(index), this.width, this.height);
                    presentFrom = NriTextureState.CopySource;
                    this.recordParticleReadback(commandBuffer);
                }
            }
            commandBuffer.textureBarrier(this.swapChain.texture(index), presentFrom, NriTextureState.Present);
            commandBuffer.end();

            // Submit and present
            this.swapChain.submit(commandBuffer, index);
            if (this.imgui) {
                this.sample.imguiEndFrame();
            }
            this.swapChain.present(index);
        }

        // Adds a segment from (x0, y0) to (x1, y1), in pixels from the top left, to the gizmo.
        addGizmoSegment(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, a: number) {
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
        buildGizmo(width: number, height: number) {
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
        overlaps(particles: f32[], count: int, heavies: number[], x: number, y: number, z: number,
            radius: number) {
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
                const dx = x - heavies[i * 3 + 0];
                const dy = y - heavies[i * 3 + 1];
                const dz = z - heavies[i * 3 + 2];
                const reach = radius + this.uiHeavyRadius;
                if (dx * dx + dy * dy + dz * dz < reach * reach) {
                    return true;
                }
            }
            return false;
        }

        // Where the attractors' heavy centers go, per the UI's layout: three numbers each. The
        // preset's are compute_nbody's, whose clouds sit at 1/1.5 of them (the cloud centers, which
        // the other layouts put at the heavy centers). The random positions keep apart.
        layoutAttractors(clouds: number[], heavies: number[]) {
            const preset: number[] = [
                5.0, 0.0, 0.0,
                -5.0, 0.0, 0.0,
                0.0, 0.0, 5.0,
                0.0, 0.0, -5.0,
                0.0, 4.0, 0.0,
                0.0, -8.0, 0.0,
            ];
            const layout = this.uiAttractorLayout;
            const radius = this.uiLayoutRadius;
            const n = this.numAttractors;
            const minApart = 2.0 * this.uiHeavyRadius + 1.0;
            for (let i = 0; i < n; i++) {
                let x = 0.0;
                let y = 0.0;
                let z = 0.0;
                if (layout == AttractorLayout.Preset && i < 6) {
                    x = preset[i * 3 + 0] * 1.5;
                    y = preset[i * 3 + 1] * 1.5;
                    z = preset[i * 3 + 2] * 1.5;
                    clouds.push(preset[i * 3 + 0]);
                    clouds.push(preset[i * 3 + 1]);
                    clouds.push(preset[i * 3 + 2]);
                } else {
                    if (layout == AttractorLayout.Ring) {
                        const angle = 2.0 * Math.PI * i / n;
                        x = radius * Math.cos(angle);
                        z = radius * Math.sin(angle);
                    } else if (layout == AttractorLayout.Sphere) {
                        // A Fibonacci spiral over the sphere (one at the pole for a single attractor).
                        const sy = n > 1 ? 1.0 - 2.0 * (i + 0.5) / n : 0.0;
                        const ring = Math.sqrt(1.0 - sy * sy);
                        x = radius * ring * Math.cos(i * 2.399963);
                        y = radius * sy;
                        z = radius * ring * Math.sin(i * 2.399963);
                    } else if (layout == AttractorLayout.Line) {
                        x = n > 1 ? radius * (2.0 * i / (n - 1) - 1.0) : 0.0;
                    } else {
                        // Random in a ball (also the preset's attractors beyond the sixth), drawn
                        // again while too close to an earlier one.
                        for (let attempt = 0; attempt < MAX_PLACEMENT_ATTEMPTS; attempt++) {
                            const gx = randomNormal();
                            const gy = randomNormal();
                            const gz = randomNormal();
                            const length = Math.max(Math.sqrt(gx * gx + gy * gy + gz * gz), 1.0e-6);
                            const reach = radius * Math.pow(randomFloat(), 1.0 / 3.0) / length;
                            x = gx * reach;
                            y = gy * reach;
                            z = gz * reach;
                            let apart = true;
                            for (let k = 0; k < i; k++) {
                                const dx = x - heavies[k * 3 + 0];
                                const dy = y - heavies[k * 3 + 1];
                                const dz = z - heavies[k * 3 + 2];
                                if (dx * dx + dy * dy + dz * dz < minApart * minApart) {
                                    apart = false;
                                }
                            }
                            if (apart) {
                                break;
                            }
                        }
                    }
                    clouds.push(x);
                    clouds.push(y);
                    clouds.push(z);
                }
                heavies.push(x);
                heavies.push(y);
                heavies.push(z);
            }
        }

        // compute_nbody's particles around their attractors, uploaded once, with collision radii;
        // the contacts' and free slots' buffers (written before they're read), the views, the
        // particles' readback buffer. False on failure.
        createParticles(device: NriDevice): boolean {
            const clouds: number[] = [];
            const heavies: number[] = [];
            this.layoutAttractors(clouds, heavies);
            const heavyRadius = this.uiHeavyRadius;
            const lightMin = this.uiLightRadiusMin;
            const lightMax = Math.max(this.uiLightRadiusMax, lightMin);
            const layout = this.uiParticleLayout;
            // The particles placed, then the free slots left for fragments (a negative radius: gone).
            this.placedCount = this.numAttractors * this.particlesPerAttractor;
            this.numParticles = this.placedCount + Math.floor(this.placedCount * this.fragmentRoom);

            let particles: f32[] = zeros(this.numParticles * PARTICLE_FLOATS);

            for (let i = 0; i < this.numAttractors; i++) {
                const ax = clouds[i * 3 + 0];
                const ay = clouds[i * 3 + 1];
                const az = clouds[i * 3 + 2];

                for (let j = 0; j < this.particlesPerAttractor; j++) {
                    const p = (i * this.particlesPerAttractor + j) * PARTICLE_FLOATS;

                    if (j == 0) {
                        // First particle in group as heavy center of gravity
                        particles[p + 0] = heavies[i * 3 + 0];
                        particles[p + 1] = heavies[i * 3 + 1];
                        particles[p + 2] = heavies[i * 3 + 2];
                        const heavyRatio = heavyRadius / HEAVY_RADIUS;
                        particles[p + 3] = HEAVY_MASS * heavyRatio * heavyRatio * heavyRatio;
                        particles[p + 8] = heavyRadius;
                    } else {
                        // Positive masses, unlike compute_nbody's (normal around 37.5, some
                        // negative): a collision's impulse is shared in proportion to them.
                        const sizeRandom = randomFloat();
                        const radius = lightMin + (lightMax - lightMin) * sizeRandom * sizeRandom;
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
                            if (layout == ParticleLayout.Gaussian) {
                                px = ax + randomNormal() * this.spread;
                                py = ay + randomNormal() * this.spread;
                                pz = az + randomNormal() * this.spread;
                            } else if (layout == ParticleLayout.Disk) {
                                // In the XZ plane (thin), out from the heavy center's surface.
                                const angle = 2.0 * Math.PI * randomFloat();
                                const reach = heavyRadius + 2.0 * this.spread * Math.sqrt(randomFloat());
                                px = ax + reach * Math.cos(angle);
                                py = ay + randomNormal() * 0.05 * this.spread;
                                pz = az + reach * Math.sin(angle);
                            } else {
                                // A uniform ball, or a thin shell, of heavyRadius + 2 spread.
                                const gx = randomNormal();
                                const gy = randomNormal();
                                const gz = randomNormal();
                                const length = Math.max(Math.sqrt(gx * gx + gy * gy + gz * gz), 1.0e-6);
                                const outer = heavyRadius + 2.0 * this.spread;
                                const fill = layout == ParticleLayout.Ball ? Math.pow(randomFloat(), 1.0 / 3.0) : 1.0;
                                const reach = outer * fill / length;
                                px = ax + gx * reach;
                                py = ay + gy * reach;
                                pz = az + gz * reach;
                            }
                            if (!this.overlaps(particles, p / PARTICLE_FLOATS, heavies, px, py, pz, radius)) {
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
                    // A solid sphere's inertia over its mass (Particle.spin.w), and the true radius:
                    // the particle's own, until it merges.
                    particles[p + 15] = 0.4 * particles[p + 8] * particles[p + 8];
                    particles[p + 19] = particles[p + 8];
                }
            }

            for (let i = this.placedCount; i < this.numParticles; i++) {
                particles[i * PARTICLE_FLOATS + 8] = -1.0;
                particles[i * PARTICLE_FLOATS + 16] = 1.0;
            }

            this.initialMass = 0.0;
            this.initialVolume = 0.0;
            for (let i = 0; i < this.numParticles; i++) {
                const radius = particles[i * PARTICLE_FLOATS + 8];
                this.initialMass += particles[i * PARTICLE_FLOATS + 3];
                if (radius > 0.0) {
                    this.initialVolume += radius * radius * radius;
                }
            }
            this.initialAngular = this.angularMomentum(particles);
            this.initialMomentum = this.linearMomentum(particles);
            this.initialEnergy = this.totalEnergy(particles);

            const particleBuffer = device.createStorageBuffer(this.queue, Ref(particles[0]), this.numParticles * PARTICLE_FLOATS * 4,
                PARTICLE_FLOATS * 4);
            // The contacts, free slots and pending particles zeroed, as the Donut example's new buffers come.
            const zeros: int[] = [];
            for (let i = 0; i < Math.max(this.numParticles * PARTICLE_FLOATS, this.numParticles + 2); i++) {
                zeros.push(0);
            }
            const contactBuffer = device.createStorageBufferFromInts(this.queue, Ref(zeros[0]), this.numParticles * CONTACT_FLOATS * 4,
                CONTACT_FLOATS * 4, NriBufferState.Storage);
            const freeBuffer = device.createStorageBufferFromInts(this.queue, Ref(zeros[0]), (this.numParticles + 2) * 4, 4,
                NriBufferState.Storage);
            const pendingBuffer = device.createStorageBufferFromInts(this.queue, Ref(zeros[0]), this.numParticles * PARTICLE_FLOATS * 4,
                PARTICLE_FLOATS * 4, NriBufferState.Storage);
            this.particleBuffer = particleBuffer;
            this.contactBuffer = contactBuffer;
            this.freeBuffer = freeBuffer;
            this.pendingBuffer = pendingBuffer;
            this.particleState = NriBufferState.Storage;
            this.particleReadbackBuffer = device.createReadbackBuffer(this.numParticles * PARTICLE_FLOATS * 4);
            if (!particleBuffer || !contactBuffer || !freeBuffer || !pendingBuffer || !this.particleReadbackBuffer) {
                return false;
            }
            this.particlesStorage = particleBuffer.createStructuredView(1);
            this.particlesView = particleBuffer.createStructuredView(0);
            this.contactsStorage = contactBuffer.createStructuredView(1);
            this.freeStorage = freeBuffer.createStructuredView(1);
            this.pendingStorage = pendingBuffer.createStructuredView(1);
            const particlesStorage = this.particlesStorage;
            const contactsStorage = this.contactsStorage;
            const freeStorage = this.freeStorage;
            const pendingStorage = this.pendingStorage;
            const computeLayout = this.computeLayout;
            if (!particlesStorage || !this.particlesView || !contactsStorage || !freeStorage || !pendingStorage || !computeLayout) {
                return false;
            }
            // The simulation's set, in a pool of its own (made again with the buffers).
            const computePool = device.createDescriptorPoolWithBuffers(1, 0, 0, 0, 0, 0, 4, 0);
            this.computePool = computePool;
            const computeSet = computePool ? computePool.allocateDescriptorSet(computeLayout, 0, 0) : null;
            this.computeSet = computeSet;
            if (!computeSet) {
                return false;
            }
            computeSet.updateDescriptor(0, 0, particlesStorage);
            computeSet.updateDescriptor(0, 1, contactsStorage);
            computeSet.updateDescriptor(0, 2, freeStorage);
            computeSet.updateDescriptor(0, 3, pendingStorage);
            Nri.storeInt32(Ref(this.simulationConstants[1]), this.numParticles);
            this.aliveCount = this.placedCount;
            return true;
        }

        // The particle buffers, their views and the readback buffer destroyed (the GPU done with them).
        destroyParticles() {
            const computePool = this.computePool;
            if (computePool) {
                computePool.destroy();
            }
            this.computePool = null;
            this.computeSet = null;
            this.destroyDescriptor(this.particlesStorage);
            this.destroyDescriptor(this.particlesView);
            this.destroyDescriptor(this.contactsStorage);
            this.destroyDescriptor(this.freeStorage);
            this.destroyDescriptor(this.pendingStorage);
            this.destroyBuffer(this.particleBuffer);
            this.destroyBuffer(this.contactBuffer);
            this.destroyBuffer(this.freeBuffer);
            this.destroyBuffer(this.pendingBuffer);
            this.destroyBuffer(this.particleReadbackBuffer);
            this.particlesStorage = null;
            this.particlesView = null;
            this.contactsStorage = null;
            this.freeStorage = null;
            this.pendingStorage = null;
            this.particleBuffer = null;
            this.contactBuffer = null;
            this.freeBuffer = null;
            this.pendingBuffer = null;
            this.particleReadbackBuffer = null;
        }

        // The total linear momentum m v of the particles in `particles` (the PARTICLE_FLOATS layout)
        // that are left, and the sum of m |v|, what its drift is measured against.
        linearMomentum(particles: f32[]) {
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
        angularMomentum(particles: f32[]) {
            let total = [0.0, 0.0, 0.0, 0.0];
            for (let i = 0; i < this.numParticles; i++) {
                const q = i * PARTICLE_FLOATS;
                const radius = particles[q + 8];
                if (radius < 0.0) {
                    continue;
                }
                const mass = particles[q + 3];
                // The spin's inertia over the mass is in spin.w (a merged particle's isn't a sphere's).
                const inertia = mass * particles[q + 15];
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

        // The total energy of the particles in `particles`: kinetic (motion and spin), potential and
        // heat, and the contact springs' energy. The gravity pass pulls by G m m' r / (r^2 + s)^(3/4), which is the slope of
        // 2 G m m' ((r^2 + s)^(1/4) - s^(1/4)) per pair, s its softening (0 for a pair merged into one, as
        // in the shader's PairPotential); heat is energy over mass times heatFactor. Gravity between
        // all pairs only: the sampled one has no potential energy.
        totalEnergy(particles: f32[]) {
            const gravity = this.simulationConstants[CONSTANT_GRAVITY];
            const heatFactor = this.simulationConstants[CONSTANT_HEAT_FACTOR];
            const sizeSoftening = this.sizeSoftening;
            // The step the springs' stiffness is set for: -test's.
            const step = TEST_DELTA_T * this.simulationConstants[CONSTANT_TIME_FACTOR];
            let energy = 0.0;
            for (let i = 0; i < this.numParticles; i++) {
                const q = i * PARTICLE_FLOATS;
                const radius = particles[q + 8];
                if (radius < 0.0) {
                    continue;
                }
                const mass = particles[q + 3];
                energy += 0.5 * mass * (particles[q + 4] * particles[q + 4] + particles[q + 5] * particles[q + 5]
                    + particles[q + 6] * particles[q + 6]);
                energy += 0.5 * mass * particles[q + 15] * (particles[q + 12] * particles[q + 12]
                    + particles[q + 13] * particles[q + 13] + particles[q + 14] * particles[q + 14]);
                if (heatFactor > 0.0) {
                    energy += particles[q + 9] * mass / heatFactor;
                }
                for (let j = i + 1; j < this.numParticles; j++) {
                    const o = j * PARTICLE_FLOATS;
                    if (particles[o + 8] < 0.0) {
                        continue;
                    }
                    const dx = particles[q] - particles[o];
                    const dy = particles[q + 1] - particles[o + 1];
                    const dz = particles[q + 2] - particles[o + 2];
                    const distance2 = dx * dx + dy * dy + dz * dz;
                    // The shader's Softening: with sizeSoftening, at least the true radii's mean squared.
                    const meanRadius = 0.5 * (particles[q + 19] + particles[o + 19]);
                    const soften = sizeSoftening ? Math.max(GRAVITY_SOFTENING, meanRadius * meanRadius) : GRAVITY_SOFTENING;
                    energy += 2.0 * gravity * mass * particles[o + 3]
                        * (Math.sqrt(Math.sqrt(distance2 + soften)) - Math.sqrt(Math.sqrt(soften)));
                    // The contact springs' energy (the shader's SpringEnergy).
                    const reach = radius + particles[o + 8];
                    // Merging pairs (touching slowly) have no springs.
                    const vx = particles[q + 4] - particles[o + 4];
                    const vy = particles[q + 5] - particles[o + 5];
                    const vz = particles[q + 6] - particles[o + 6];
                    const mergeSpeed = this.mergeSpeedOf(particles[q + 9], particles[o + 9]);
                    const merging = mergeSpeed > 0.0 && vx * vx + vy * vy + vz * vz < mergeSpeed * mergeSpeed;
                    if (this.contactSprings && !merging && step > 0.0 && distance2 < reach * reach) {
                        const overlap = reach - Math.sqrt(distance2);
                        const stiffness = mass * particles[o + 3] / (mass + particles[o + 3]) * CONTACT_STIFFNESS / (step * step);
                        const inner = Math.min(overlap, CONTACT_OVERLAP_MAX * reach);
                        energy += 0.5 * stiffness * inner * inner + stiffness * CONTACT_OVERLAP_MAX * reach * (overlap - inner);
                    }
                }
            }
            return energy;
        }

        // The shader's MergeSpeed: below it two particles of these heats merge.
        mergeSpeedOf(heat: number, otherHeat: number) {
            const mergeSpeed = this.simulationConstants[CONSTANT_MERGE_SPEED];
            if (mergeSpeed <= 0.0) {
                return 0.0;
            }
            const glow = 1.0 - Math.exp(-0.5 * (Math.max(heat, 0.0) + Math.max(otherHeat, 0.0)));
            return mergeSpeed + this.simulationConstants[CONSTANT_HOT_MERGE_SPEED] * glow;
        }

        // The particles copied back into particleReadbackBuffer (the GPU idle), empty if they can't be
        // read.
        readParticles(): f32[] {
            const particleReadbackBuffer = this.particleReadbackBuffer;
            if (!particleReadbackBuffer) {
                return [];
            }
            const particles = zeros(this.numParticles * PARTICLE_FLOATS);
            if (particleReadbackBuffer.readFloats(Ref(particles[0]), particles.length) == 0) {
                return [];
            }
            return particles;
        }

        // How many particles are left (the others merged into them), from the copy the last count
        // asked for (the Donut example reads them back at once; here the GPU waited for, the copy a
        // frame recorded, ALIVE_COUNT_FRAMES frames ago); and a copy asked for, for the next count.
        // Only ever fewer than at the start: a failed read keeps the last count.
        countAlive() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (this.aliveCopyPending) {
                this.aliveCopyPending = false;
                device.waitIdle();
                const particles = this.readParticles();
                if (particles.length > 0) {
                    let alive = 0;
                    for (let i = 0; i < this.numParticles; i++) {
                        if (particles[i * PARTICLE_FLOATS + 8] >= 0.0) {
                            alive++;
                        }
                    }
                    this.aliveCount = alive;
                }
            }
            this.aliveCopyRequested = true;
        }

        setFullGravity(full: boolean) {
            this.fullGravity = full;
            Nri.storeInt32(Ref(this.simulationConstants[CONSTANT_FULL_GRAVITY]), full ? 1 : 0);
        }

        setCooling(seconds: number) {
            this.simulationConstants[CONSTANT_COOL_SECONDS] = seconds;
        }

        // -fragment and -merge: a speed above 0 turns the feature on, at that speed.
        setFragmentSpeed(speed: number) {
            if (speed > 0.0) {
                this.breakOn = true;
                this.breakValue = speed;
            }
            this.applySwitches();
        }

        setMergeSpeed(speed: number) {
            if (speed > 0.0) {
                this.mergeOn = true;
                this.mergeValue = speed;
            }
            this.applySwitches();
        }

        // The switches into the simulation's constants: a feature switched off gets 0 (friction,
        // merging and breaking all stop at 0), on gets its slider's value.
        applySwitches() {
            this.simulationConstants[CONSTANT_FRICTION] = this.frictionOn ? this.frictionValue : 0.0;
            this.simulationConstants[CONSTANT_MERGE_SPEED] = this.mergeOn ? this.mergeValue : 0.0;
            this.simulationConstants[CONSTANT_HOT_MERGE_SPEED] = this.hotStickOn ? this.hotStickValue : 0.0;
            this.simulationConstants[CONSTANT_FRAGMENT_SPEED] = this.breakOn ? this.breakValue : 0.0;
            Nri.storeInt32(Ref(this.simulationConstants[CONSTANT_CONTACT_SPRINGS]), this.contactSprings ? 1 : 0);
            this.simulationConstants[CONSTANT_RESTITUTION_SPEED] = this.restitutionSpeedOn ? this.restitutionSpeedValue : 0.0;
            this.simulationConstants[CONSTANT_ROLLING_RESISTANCE] = this.rollingOn ? this.rollingValue : 0.0;
            Nri.storeInt32(Ref(this.simulationConstants[CONSTANT_SIZE_SOFTENING]), this.sizeSoftening ? 1 : 0);
        }

        // The simulation's live settings back to their defaults (the UI's Defaults button); the
        // switches stay as they are.
        resetSimulationConstants() {
            this.simulationConstants[CONSTANT_TIME_FACTOR] = DEFAULT_TIME_FACTOR;
            this.simulationConstants[CONSTANT_GRAVITY] = DEFAULT_GRAVITY;
            this.simulationConstants[CONSTANT_RESTITUTION] = DEFAULT_RESTITUTION;
            this.simulationConstants[CONSTANT_HEAT_FACTOR] = DEFAULT_HEAT_FACTOR;
            this.simulationConstants[CONSTANT_COOL_SECONDS] = DEFAULT_COOL_SECONDS;
            this.frictionValue = DEFAULT_FRICTION;
            this.restitutionSpeedValue = DEFAULT_RESTITUTION_SPEED;
            this.rollingValue = DEFAULT_ROLLING_RESISTANCE;
            this.mergeValue = DEFAULT_MERGE_SLIDER;
            this.hotStickValue = DEFAULT_HOT_MERGE_SPEED;
            this.breakValue = DEFAULT_FRAGMENT_SLIDER;
            this.applySwitches();
        }

        // Starts again with the UI's attractors, particles, spread and seed: new particles, in
        // new buffers (the old ones destroyed once the GPU is done with them).
        restart() {
            const device = this.device;
            if (!device) {
                return;
            }
            device.waitIdle();
            this.destroyParticles();
            this.aliveCopyRequested = false;
            this.aliveCopyPending = false;

            this.numAttractors = this.uiAttractors;
            this.particlesPerAttractor = this.uiParticles;
            this.spread = this.uiSpread;
            this.fragmentRoom = this.uiFragmentRoom;
            g_RandomSeed = this.uiSeed * 1.0;
            if (!this.createParticles(device)) {
                console.log("Cannot create the particles");
            }
        }

        // -test, as the Donut example checks: the particles after the last frame. Every position and
        // velocity is finite (light particles slung out of the scene go far, legitimately), and none
        // is faster than MAX_TEST_SPEED, though the clouds have fallen into each other by then. Head
        // on (2 heavy centers alone), the two have bounced off each other once, symmetrically: equal
        // and opposite positions and velocities (the momentum kept), as far apart and as fast as a
        // CPU run of the shaders has them at frame 900. Then the frame: black corners, and particles
        // drawn.
        checkTest() {
            const device = this.device;
            if (!device) {
                return "cannot read the particles back";
            }
            device.waitIdle();
            const particles = this.readParticles();
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

            // Merging and breaking: the mass and the volume are kept; merging, some particles are gone
            // (negative radius); breaking, some are fragments (smaller than any placed at the start).
            const merging = this.simulationConstants[CONSTANT_MERGE_SPEED] > 0.0;
            const breaking = this.simulationConstants[CONSTANT_FRAGMENT_SPEED] > 0.0;
            if (merging || breaking) {
                let mass = 0.0;
                let volume = 0.0;
                let gone = 0;
                let fragments = 0;
                for (let i = 0; i < this.numParticles; i++) {
                    const radius = particles[i * PARTICLE_FLOATS + 8];
                    mass += particles[i * PARTICLE_FLOATS + 3];
                    // The true radius (marker.w): a merged particle grows to it as room allows.
                    const trueRadius = particles[i * PARTICLE_FLOATS + 19];
                    if (radius < 0.0) {
                        gone++;
                    } else {
                        volume += trueRadius * trueRadius * trueRadius;
                        if (radius < FRAGMENT_RADIUS * 1.001) {
                            fragments++;
                        }
                    }
                }
                console.log(`Fragments: ${fragments}, particles running ${this.numParticles - gone} (placed ${this.placedCount})`);
                if (breaking && fragments == 0) {
                    return "no particle broke";
                }
                const angular = this.angularMomentum(particles);
                console.log(`Angular momentum: ${angular[0]}, ${angular[1]}, ${angular[2]} of ${this.initialAngular[0]}, ${this.initialAngular[1]}, ${this.initialAngular[2]}`);
                console.log(`Gone (merged away or free): ${gone} of ${this.numParticles} slots, mass ${mass} of ${this.initialMass}, volume ${volume} of ${this.initialVolume}`);
                if (merging && !breaking && gone == 0) {
                    return "no particles merged";
                }
                if (Math.abs(mass - this.initialMass) > this.initialMass * 1.0e-4
                    || Math.abs(volume - this.initialVolume) > this.initialVolume * 1.0e-3) {
                    return `the merges or breaks did not keep the mass (${mass} of ${this.initialMass}) or the volume (${volume} of ${this.initialVolume})`;
                }
            }

            // Every pair pulling both ways: the collisions, the friction, the merges and the breaks keep
            // the linear and the angular momentum, measured against the larger of the sums of their
            // sizes at the start and now (the heavy centers start at rest). Some still drifts: the
            // swept contacts' position corrections, for one, move particles without a velocity change.
            if (this.fullGravity) {
                const heavyOnly = this.particlesPerAttractor == 1;
                const momentum = this.linearMomentum(particles);
                const angular = this.angularMomentum(particles);
                let momentumDrift = 0.0;
                let angularDrift = 0.0;
                for (let k = 0; k < 3; k++) {
                    momentumDrift = Math.max(momentumDrift, Math.abs(momentum[k] - this.initialMomentum[k]));
                    angularDrift = Math.max(angularDrift, Math.abs(angular[k] - this.initialAngular[k]));
                }
                const momentumLimit = Math.max(this.initialMomentum[3], momentum[3]) * MOMENTUM_DRIFT_LIMIT;
                const angularLimit = Math.max(this.initialAngular[3], angular[3])
                    * (heavyOnly ? ANGULAR_DRIFT_LIMIT_HEAVY
                        : this.simulationConstants[CONSTANT_MERGE_SPEED] > 0.0 ? ANGULAR_DRIFT_LIMIT_MERGE : ANGULAR_DRIFT_LIMIT);
                console.log(`Momentum drift ${momentumDrift} (limit ${momentumLimit}), angular momentum drift ${angularDrift} (limit ${angularLimit})`);
                if (momentumDrift > momentumLimit || angularDrift > angularLimit) {
                    return `momentum drifts by ${momentumDrift} (over ${momentumLimit}) or angular momentum by ${angularDrift} (over ${angularLimit})`;
                }
            }

            // Merged particles' size: grown back towards their true radius (marker.w).
            if (this.simulationConstants[CONSTANT_MERGE_SPEED] > 0.0 && this.simulationConstants[CONSTANT_FRAGMENT_SPEED] <= 0.0) {
                let mergedMass = 0.0;
                let sizedMass = 0.0;
                for (let i = 0; i < this.numParticles; i++) {
                    const q = i * PARTICLE_FLOATS;
                    if (particles[q + 8] < 0.0 || particles[q + 19] <= particles[q + 8]) {
                        continue;
                    }
                    mergedMass += particles[q + 3];
                    sizedMass += particles[q + 3] * particles[q + 8] / particles[q + 19];
                }
                const size = mergedMass > 0.0 ? sizedMass / mergedMass : 1.0;
                console.log(`Merged size: ${size} of the true radius (minimum ${MERGED_SIZE_MIN})`);
                if (size < MERGED_SIZE_MIN) {
                    return `the merged particles are ${size} of their true radius`;
                }
            }

            // Energy, with all-pairs gravity and the heat kept (-nocool): what the collisions, the
            // merges and the breaks lose is heat, so the total stays.
            if (this.fullGravity && this.simulationConstants[CONSTANT_COOL_SECONDS] >= NO_COOLING_SECONDS) {
                const energy = this.totalEnergy(particles);
                const drift = Math.abs(energy - this.initialEnergy) / this.initialEnergy;
                console.log(`Energy: ${energy} of ${this.initialEnergy}, drift ${drift} (limit ${ENERGY_DRIFT_LIMIT})`);
                if (drift > ENERGY_DRIFT_LIMIT) {
                    return `the total energy drifted by ${drift} of it (${energy} of ${this.initialEnergy})`;
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
                if (!isFinite32(spin) || !isFinite32(marker) || Math.abs(marker - 1.0) > 0.001) {
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
                if (Math.abs(x0 + x1) > 0.01 || Math.abs(v0 + v1) > 0.01) {
                    return `positions ${x0}, ${x1} and velocities ${v0}, ${v1} are not symmetric: momentum not kept`;
                }
                // The CPU run (the same steps: softened by their size, 0.5^2, and the hit's bounciness
                // falling with its speed): x 0.568, v 5.622 (3.773, 5.698 without either).
                if (Math.abs(x0 - 0.568) > 0.1 || Math.abs(v0 - 5.622) > 0.1) {
                    return `position ${x0}, velocity ${v0}: not the CPU run's 0.568, 5.622 after one bounce`;
                }
            }

            // The frame: black corners, and at least 100 pixels of particles drawn.
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
            console.log(`Particles: ${drawn} pixels`);
            if (drawn < 100) {
                return `Particles: ${drawn} pixels drawn, not 100 or more`;
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

        // --- UI -----------------------------------------------------------------------------

        // A checkbox for value; its new state.
        checkbox(label: string, value: boolean): boolean {
            return NriImgui.checkbox(label, value ? 1 : 0) != 0;
        }

        // The settings window, top right. Slider and checkbox values are written back to the
        // simulation as they change.
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPosPivot(this.width - 10.0, 10.0, 1.0, 0.0);
            NriImgui.begin("N-Body Collisions", 1);
            NriImgui.pushItemWidth(180.0);

            // Every feature has a switch; a slider beneath one sets how much, while it is on.
            if (NriImgui.collapsingHeader("Simulation", 1) != 0) {
                this.paused = this.checkbox("Paused (Space)", this.paused);
                const collisions = this.checkbox("Collisions (C)", this.collisions);
                if (collisions != this.collisions) {
                    this.collisions = collisions;
                    Nri.storeInt32(Ref(this.simulationConstants[2]), collisions ? 1 : 0);
                }
                const heating = this.checkbox("Heating (H)", this.heating);
                if (heating != this.heating) {
                    this.heating = heating;
                    Nri.storeInt32(Ref(this.simulationConstants[3]), heating ? 1 : 0);
                }
                const fullGravity = this.checkbox("Gravity between all pairs", this.fullGravity);
                if (fullGravity != this.fullGravity) {
                    this.setFullGravity(fullGravity);
                }
                this.contactSprings = this.checkbox("Contact springs (off: push-outs)", this.contactSprings);
                this.frictionOn = this.checkbox("Friction", this.frictionOn);
                if (this.frictionOn) {
                    this.frictionValue = NriImgui.sliderFloat("Friction mu", this.frictionValue, 0.0, 1.0);
                }
                this.rollingOn = this.checkbox("Rolling resistance", this.rollingOn);
                if (this.rollingOn) {
                    this.rollingValue = NriImgui.sliderFloat("Rolling mu_r", this.rollingValue, 0.0, ROLLING_RESISTANCE_MAX);
                }
                this.restitutionSpeedOn = this.checkbox("Hard hits bounce less", this.restitutionSpeedOn);
                if (this.restitutionSpeedOn) {
                    this.restitutionSpeedValue = NriImgui.sliderFloat("Above (u/s)", this.restitutionSpeedValue, 0.0, RESTITUTION_SPEED_MAX);
                }
                this.sizeSoftening = this.checkbox("Gravity softened by size", this.sizeSoftening);
                this.mergeOn = this.checkbox("Merging", this.mergeOn);
                if (this.mergeOn) {
                    this.mergeValue = NriImgui.sliderFloat("Merge below (u/s)", this.mergeValue, 0.0, MERGE_SPEED_MAX);
                    this.hotStickOn = this.checkbox("Hot particles stick", this.hotStickOn);
                    if (this.hotStickOn) {
                        this.hotStickValue = NriImgui.sliderFloat("Glowing: + (u/s)", this.hotStickValue, 0.0, HOT_MERGE_SPEED_MAX);
                    }
                }
                this.breakOn = this.checkbox("Breaking", this.breakOn);
                if (this.breakOn) {
                    this.breakValue = NriImgui.sliderFloat("Break above (u/s)", this.breakValue, 0.0, FRAGMENT_SPEED_MAX);
                }
                this.applySwitches();

                this.simulationConstants[CONSTANT_TIME_FACTOR] = NriImgui.sliderFloat("Time scale (sim s / s)",
                    this.simulationConstants[CONSTANT_TIME_FACTOR], 0.0, 0.2);
                this.simulationConstants[CONSTANT_GRAVITY] = NriImgui.sliderFloat("Gravity G",
                    this.simulationConstants[CONSTANT_GRAVITY], 0.0, 0.01);
                this.simulationConstants[CONSTANT_RESTITUTION] = NriImgui.sliderFloat("Bounciness e",
                    this.simulationConstants[CONSTANT_RESTITUTION], 0.0, 1.0);
                this.simulationConstants[CONSTANT_HEAT_FACTOR] = NriImgui.sliderFloat("Heat per energy",
                    this.simulationConstants[CONSTANT_HEAT_FACTOR], 0.0, 0.02);
                this.simulationConstants[CONSTANT_COOL_SECONDS] = NriImgui.sliderFloat("Cooling time (s)",
                    this.simulationConstants[CONSTANT_COOL_SECONDS], 0.5, 10.0);
                if (NriImgui.button("Defaults") != 0) {
                    this.resetSimulationConstants();
                }
            }

            if (NriImgui.collapsingHeader("Display", 1) != 0) {
                this.showPlanes = this.checkbox("Planes (P)", this.showPlanes);
                this.showGizmo = this.checkbox("Axis gizmo", this.showGizmo);
                this.autoRotate = this.checkbox("Orbit when idle", this.autoRotate);
                this.litSpheres = this.checkbox("Lit spheres", this.litSpheres);
                this.spinMarks = this.checkbox("Spin marks", this.spinMarks);
                this.showTrails = this.checkbox("Trails (T)", this.showTrails);
                if (this.showTrails) {
                    this.trailSeconds = NriImgui.sliderFloat("Trail length (s)", this.trailSeconds, 0.0, TRAIL_SECONDS_MAX);
                }
                this.bloomOn = this.checkbox("Bloom", this.bloomOn);
                if (this.bloomOn) {
                    this.bloomStrength = NriImgui.sliderFloat("Bloom strength", this.bloomStrength, 0.0, 2.0);
                    this.bloomThreshold = NriImgui.sliderFloat("Bloom threshold", this.bloomThreshold, 0.0, 2.0);
                }
            }

            // What the sliders' units are: the simulation's own (its scene units, simulated seconds,
            // the masses it places), and compute_nbody's softened gravity.
            if (NriImgui.collapsingHeader("Units", 0) != 0) {
                NriImgui.text("u: scene unit; the planes' grid lines are 2 u apart");
                NriImgui.text("s: second. Speeds are in u per simulated second;");
                NriImgui.text("  the time scale is simulated seconds per real one;");
                NriImgui.text("  trail length and cooling time are real seconds");
                NriImgui.text("Masses follow the volume: 20 at radius 0.04 (312 at 0.1),");
                NriImgui.text("  90000 at the attractors' radius 0.5");
                NriImgui.text("Gravity: a = G m r / (r^2 + s)^0.75 (not 1 / r^2), s = 0.05,");
                NriImgui.text("  softened by size: at least the two's mean radius^2");
                NriImgui.text("e: speed apart after a bounce over speed together before;");
                NriImgui.text("  hard hits: e (above / impact speed)^(1/4)");
                NriImgui.text("mu: friction impulse over the normal one, at most");
                NriImgui.text("Merging: below the merge speed, plus as much as");
                NriImgui.text("  'Glowing: +' times the pair's glow (1 - e^-heat)");
                NriImgui.text("mu_r: rolling couple over contact radius times the");
                NriImgui.text("  normal impulse, at most");
                NriImgui.text("Heat rises by heat per energy times the kinetic");
                NriImgui.text("  energy lost per unit of the particle's mass (u^2/s^2)");
                NriImgui.text("Cooling time: the heat falls to 1/e in it");
                NriImgui.text("Fragment room: free slots at the start, a share of");
                NriImgui.text("  the particles placed");
            }

            if (NriImgui.collapsingHeader("New simulation", 1) != 0) {
                this.uiAttractors = NriImgui.sliderInt("Attractors", this.uiAttractors, 1, MAX_ATTRACTORS);
                const choice = NriImgui.combo("Particles each", particleChoiceIndex(this.uiParticles), PARTICLE_CHOICES);
                if (choice >= 0 && choice != particleChoiceIndex(this.uiParticles)) {
                    this.uiParticles = particleChoice(choice);
                }
                this.uiAttractorLayout = NriImgui.combo("Attractor layout", this.uiAttractorLayout, ATTRACTOR_LAYOUTS);
                if (this.uiAttractorLayout != AttractorLayout.Preset) {
                    this.uiLayoutRadius = NriImgui.sliderFloat("Layout radius (u)", this.uiLayoutRadius, 1.0, LAYOUT_RADIUS_MAX);
                }
                this.uiHeavyRadius = NriImgui.sliderFloat("Attractor radius (u)", this.uiHeavyRadius, 0.1, HEAVY_RADIUS_MAX);
                this.uiParticleLayout = NriImgui.combo("Particle layout", this.uiParticleLayout, PARTICLE_LAYOUTS);
                this.uiLightRadiusMin = NriImgui.sliderFloat("Particle radius min (u)", this.uiLightRadiusMin,
                    LIGHT_RADIUS_SLIDER_MIN, LIGHT_RADIUS_SLIDER_MAX);
                this.uiLightRadiusMax = NriImgui.sliderFloat("Particle radius max (u)", this.uiLightRadiusMax,
                    LIGHT_RADIUS_SLIDER_MIN, LIGHT_RADIUS_SLIDER_MAX);
                if (this.uiLightRadiusMax < this.uiLightRadiusMin) {
                    this.uiLightRadiusMax = this.uiLightRadiusMin;
                }
                this.uiSpread = NriImgui.sliderFloat("Cloud spread (u)", this.uiSpread, 0.2, 3.0);
                this.uiFragmentRoom = 0.01 * NriImgui.sliderFloat("Fragment room (%)", 100.0 * this.uiFragmentRoom, 0.0, 100.0);
                this.uiSeed = NriImgui.sliderInt("Random seed", this.uiSeed, 1, 99999);
                if (NriImgui.button("Restart") != 0) {
                    this.restartRequested = true;
                }
                NriImgui.text(this.aliveCount == this.numParticles
                    ? `${this.numParticles} particles running`
                    : `${this.aliveCount} particles running, in ${this.numParticles} slots`);
            }

            NriImgui.popItemWidth();
            NriImgui.end();
            this.sample.imguiRender();
        }

        destroy() {
            const device = this.device;
            if (device) {
                device.waitIdle();
                if (this.imgui) {
                    this.sample.destroyImgui();
                }
                this.destroyBloomTargets();
                this.destroyParticles();
                this.destroyDescriptor(this.viewConstantsView);
                this.destroyDescriptor(this.trailView);
                this.destroyDescriptor(this.gizmoView);
                this.destroyDescriptor(this.linearClamp);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.calculatePipeline);
                this.destroyPipeline(this.countPipeline);
                this.destroyPipeline(this.collidePipeline);
                this.destroyPipeline(this.absorbPipeline);
                this.destroyPipeline(this.killPipeline);
                this.destroyPipeline(this.collectFreePipeline);
                this.destroyPipeline(this.fragmentPipeline);
                this.destroyPipeline(this.splitPipeline);
                this.destroyPipeline(this.integratePipeline);
                this.destroyPipeline(this.thresholdPipeline);
                this.destroyPipeline(this.blurDownPipeline);
                this.destroyPipeline(this.blurUpPipeline);
                this.destroyPipeline(this.graphicsPipeline);
                this.destroyPipeline(this.trailPipeline);
                this.destroyPipeline(this.planePipeline);
                this.destroyPipeline(this.gizmoPipeline);
                this.destroyPipeline(this.compositePipeline);
                this.destroyLayout(this.computeLayout);
                this.destroyLayout(this.drawLayout);
                this.destroyLayout(this.gizmoLayout);
                this.destroyLayout(this.compositeLayout);
                this.destroyLayout(this.blurLayout);
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

        destroyLayout(layout: NriPipelineLayout | null) {
            if (layout) {
                layout.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        const nbody = new NBodyCollisions(sample);
        // -attractors <n>: heavy centers, 1 to MAX_ATTRACTORS (6 by default), each with its group of
        // particles; -particles <n>: particles per attractor, the heavy center first (1024 by
        // default); -merge <speed>: particles touching slower than this merge (0, off, by default);
        // -fragment <speed>: particles hit harder than this break in two (0, off, by default); -room
        // <percent>: free slots left for fragments at the start, a share of the particles placed;
        // -nocool: the heat never cools off (for the energy check); -fullgravity: every pair pulls
        // both ways (see SimulationConstants.fullGravity); -noUI: no settings window.
        sample.addExampleOptionWithValues("-attractors", 1);
        sample.addExampleOptionWithValues("-particles", 1);
        sample.addExampleOptionWithValues("-merge", 1);
        sample.addExampleOptionWithValues("-fragment", 1);
        sample.addExampleOptionWithValues("-room", 1);
        sample.addExampleOption("-nocool");
        sample.addExampleOption("-fullgravity");
        sample.addExampleOption("-noUI");
        sample.useImgui();
        sample.useResizableWindow();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-attractors" && i + 1 < argc) {
                nbody.numAttractors = parseInt(Nri.getArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-particles" && i + 1 < argc) {
                nbody.particlesPerAttractor = parseInt(Nri.getArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-fragment" && i + 1 < argc) {
                nbody.argFragmentSpeed = parseFloat(Nri.getArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-room" && i + 1 < argc) {
                nbody.argFragmentRoom = parseFloat(Nri.getArg(argc, argv, i + 1)) / 100.0;
                i++;
            } else if (arg == "-nocool") {
                nbody.argNoCool = true;
            } else if (arg == "-fullgravity") {
                nbody.argFullGravity = true;
            } else if (arg == "-merge" && i + 1 < argc) {
                nbody.argMergeSpeed = parseFloat(Nri.getArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-noUI") {
                nbody.noUI = true;
            }
        }
        if (nbody.numAttractors < 1) {
            nbody.numAttractors = 1;
        }
        if (nbody.numAttractors > MAX_ATTRACTORS) {
            nbody.numAttractors = MAX_ATTRACTORS;
        }
        if (nbody.particlesPerAttractor < 1) {
            nbody.particlesPerAttractor = 1;
        }
        return nbody.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return ComputeNBodyCollisionsNri.main(argc, argv);
}

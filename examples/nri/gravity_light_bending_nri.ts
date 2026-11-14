/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { radians, perspProjD3DStyleReverse } from "../../core/matrix";
import { DonutThirdPersonCamera } from "../../core/donut_third_person_camera";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDevice, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample } from "../../core/nri";

namespace GravityLightBendingNri {
    // gravity_light_bending, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (gravity_light_bending.hlsl's), Donut's ThirdPersonCamera and
    // PlanarViewConstants as Donut computes them (core/donut_third_person_camera.ts,
    // Nri.fillDonutPlanarViewConstants), through the NRI calls core/nri/nri_interop.d.ts binds. This
    // example creates everything it runs, and does the rendering.

    const WINDOW_TITLE = "NRI Example: Gravity Light Bending";

    // Seconds without input before the camera starts to orbit the center by itself, the seconds it
    // takes to reach full speed, and that speed in radians per second (as compute_nbody_collisions').
    const IDLE_SECONDS = 5.0;
    const IDLE_RAMP_SECONDS = 2.0;
    const IDLE_ROTATION_SPEED = 0.09;

    // Test mode: the frames rendered (2 seconds). The rays are traced again every frame, through
    // the bodies as they are then: the frames only need to move the bodies a little.
    const TEST_FRAMES = 120;
    // Test mode: the deflections measured within this much of what the theory gives (see
    // checkDeflection), for rays passing at least DEFLECTION_MIN_IMPACT body radii from the mass.
    const DEFLECTION_TOLERANCE = 0.03;
    const DEFLECTION_MIN_IMPACT = 4.0;
    // Test mode, no gravity: a path's points within this distance of the line its ray started on.
    const STRAIGHT_TOLERANCE = 1.0e-3;
    // Test mode, one black hole: rays within this share of the critical impact parameter (either
    // way) aren't checked for falling in or escaping (see checkCapture).
    const CAPTURE_MARGIN = 0.05;

    // Must match gravity_light_bending.hlsl's MAX_BODIES and MAX_POINTS (the points of a ray's path).
    const MAX_BODIES = 16;
    const MAX_POINTS = 256;
    // The emitter's rays: up to this many across, and as many rows.
    const MAX_RAYS_ACROSS = 64;
    const MAX_RAYS = MAX_RAYS_ACROSS * MAX_RAYS_ACROSS;
    // rays_cs's threads per group.
    const RAYS_GROUP_SIZE = 64;
    // struct Ray: float4 origin, start, end, fate.
    const RAY_FLOATS = 16;
    // struct SceneConstants (c_Scene): 6 float4, then per body its position and mass, and its
    // radius and hue. The indices of the values in it.
    const SCENE_FLOATS = 24 + 8 * MAX_BODIES;
    const SCENE_BODIES = 24;
    const SCENE_BODY_INFO = 24 + 4 * MAX_BODIES;
    // The quad each body, line and segment is drawn as.
    const VERTICES_PER_QUAD = 6;
    // grid_vs: 2 * 21 lines.
    const GRID_LINE_COUNT = 42;
    // Constant buffer views' alignment (D3D12: their size a multiple of 256 bytes).
    const CONSTANTS_ALIGNMENT = 256;

    // The simulation's units: G = 1, and the speed of light c a setting (the speeds the bodies
    // orbit at are a few units per second, so the default keeps them well below it, as the light's
    // travel time through the scene, which the tracing leaves out, would want).
    const DEFAULT_GRAVITY = 1.0;
    const DEFAULT_LIGHT_SPEED = 15.0;
    const LIGHT_SPEED_MIN = 3.0;
    const LIGHT_SPEED_MAX = 100.0;
    const DEFAULT_TIME_SCALE = 1.0;
    // The bodies' steps: SUBSTEPS per frame, the frame's time at most MAX_DELTA_T (a stall would
    // otherwise throw them out of their orbits), and the softening of their pull (squared length).
    const SUBSTEPS = 16;
    const MAX_DELTA_T = 1.0 / 30.0;
    const BODY_SOFTENING = 0.01;
    // The sphere around the origin the sky's tracing works in: the bodies' extent, and this margin.
    const SKY_MARGIN = 4.0;
    // The seconds after which the pulses' clock starts again.
    const PULSE_CLOCK_WRAP = 3600.0;

    // The emitter's defaults: a sheet of 41 parallel rays across 16 units, from 20 units away,
    // along +x; each 50 units long.
    const DEFAULT_RAYS_ACROSS = 41;
    const DEFAULT_RAY_ROWS = 9;
    const DEFAULT_EMITTER_DISTANCE = 20.0;
    const DEFAULT_BEAM_HALF_WIDTH = 8.0;
    const DEFAULT_CONE_ANGLE = 25.0;
    const DEFAULT_RAY_LENGTH = 50.0;
    const RAY_LENGTH_MAX = 150.0;

    const SCENES = "Star and planets|Binary stars|Figure eight (3 bodies)|Black hole and star|Single mass|Random cluster";
    enum Scene {
        StarAndPlanets = 0,
        Binary = 1,
        FigureEight = 2,
        BlackHole = 3,
        Single = 4,
        Cluster = 5
    }
    const DEFAULT_CLUSTER_BODIES = 8;
    const BENDINGS = "Newtonian (light as a particle at c)|General relativity, weak field (twice)|Schwarzschild, exact per body";
    // The shader's bending modes; None when the light doesn't feel gravity.
    enum Bending {
        Newtonian = 0,
        WeakField = 1,
        Schwarzschild = 2,
        None = 3
    }
    const EMITTERS = "Sheet of parallel rays|Beam of parallel rays|Cone from a point|Point, every direction";
    enum Emitter {
        Sheet = 0,
        Beam = 1,
        Cone = 2,
        Sphere = 3
    }

    // GLFW's key codes (NriSample.isKeyToggled): the example's keys.
    const KEY_B = 66;
    const KEY_G = 71;
    const KEY_K = 75;
    const KEY_L = 76;
    const KEY_R = 82;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // std::default_random_engine replacement: a Park-Miller generator, from a seed so runs repeat.
    let g_RandomSeed = 12345.0;
    function randomFloat() {
        g_RandomSeed = (g_RandomSeed * 16807.0) % 2147483647.0;
        return g_RandomSeed / 2147483647.0;
    }

    // A float32 value is finite.
    function isFinite32(x: number): boolean {
        return x > -1.0e38 && x < 1.0e38;
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

    // The deflection theory gives a ray passing a mass m (Schwarzschild radius rs = 2 G m / c^2) at
    // distance b, from `before` before its closest approach to `after` after it, the force taken
    // along the straight line (the first order in rs / b). Across the ray, light as a particle at
    // speed c turns by G m b / (c^2 r^3) per unit length, which sums to G m / (c^2 b) (sin + sin)
    // of the angles the ends are seen at; general relativity's weak field twice that. The
    // Schwarzschild orbit equation's pull across the ray, 3/2 rs b^3 / r^5, sums to 3/2 rs b^3 (F(after)
    // + F(before)), F(x) = x (2 x^2 + 3 b^2) / (3 b^4 (x^2 + b^2)^(3/2)): 2 rs / b in all, as the weak
    // field's.
    function expectedDeflection(bending: int, rs: number, b: number, before: number, after: number) {
        if (bending == Bending.Schwarzschild) {
            return 1.5 * rs * b * b * b * (schwarzschildPart(before, b) + schwarzschildPart(after, b));
        }
        const factor = bending == Bending.WeakField ? 1.0 : 0.5;
        return factor * rs / b * (before / Math.sqrt(before * before + b * b) + after / Math.sqrt(after * after + b * b));
    }

    function schwarzschildPart(x: number, b: number) {
        const r2 = x * x + b * b;
        return x * (2.0 * x * x + 3.0 * b * b) / (3.0 * b * b * b * b * r2 * Math.sqrt(r2));
    }

    // A frame in flight's own data: its views of the constant buffer: its SceneConstants
    // and PlanarViewConstants.
    class QueuedFrame {
        constructor(public sceneView: NriDescriptor, public viewView: NriDescriptor) {
        }
    }

    // Port of examples/gravity_light_bending.ts to NRI. Light bent by gravity. A few massive bodies
    // (a scene to choose: a star and its planets, two stars, three bodies on a figure eight, a black
    // hole and a star...) move under each other's gravity, stepped here (leapfrog, merging those that
    // touch). Every frame a compute pass traces the light of an emitter (a sheet or a beam of parallel
    // rays, a cone or a point shining every way) through their field and the rays' paths are drawn,
    // with pulses running along them at the speed of light: where the field is zero a ray goes
    // straight, past a mass it bends towards it, the more the closer; it ends in a body it hits. The
    // same tracing from the camera, through every pixel, draws the sky behind the bodies as the bent
    // light shows it, and the bodies themselves: lensed, with Einstein rings around them and black
    // holes' shadows. The UI (top right, off with -noUI) sets the speed of light (lower: more bending;
    // a body inside its own Schwarzschild radius is a black hole), how the light bends (as a Newtonian
    // particle at c, general relativity's twice that, or the exact Schwarzschild path around each
    // body), and the emitter. Space pauses, L switches the bending off and on (the rays straight,
    // through the same bodies), K the lensed sky, G the grid, B the straight lines to compare, R
    // restarts. The compute pass and the draws go into the frame's command buffer, with the rays'
    // buffers' barriers between them.
    class LightBending {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        // The swap chain textures' format (their views': viewFormat).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private computeLayout: NriPipelineLayout | null = null;
        private raysPipeline: NriPipeline | null = null;
        private drawLayout: NriPipelineLayout | null = null;
        private pathPipeline: NriPipeline | null = null;
        private straightPipeline: NriPipeline | null = null;
        private gridPipeline: NriPipeline | null = null;
        private bodyPipeline: NriPipeline | null = null;
        private skyPipeline: NriPipeline | null = null;
        // The rays' paths, MAX_POINTS points each, and the rays; written by the compute pass, read by
        // the draws' vertex shaders (in VertexShaderResource between frames, once drawn).
        private pointBuffer: NriBuffer | null = null;
        private rayBuffer: NriBuffer | null = null;
        private pointsStorage: NriDescriptor | null = null;
        private pointsView: NriDescriptor | null = null;
        private raysStorage: NriDescriptor | null = null;
        private raysView: NriDescriptor | null = null;
        private raysDrawn: boolean = false;
        // A queued frame's SceneConstants and PlanarViewConstants each, frameStride bytes apart.
        private constantBuffer: NriBuffer | null = null;
        private constantViews: NriDescriptor[] = [];
        private sceneStride: int = 0;
        private viewSize: int = 0;
        private frameStride: int = 0;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        private camera: DonutThirdPersonCamera = new DonutThirdPersonCamera();
        private paused: boolean = false;
        // -test renders the same frames every run: no rotation.
        private autoRotate: boolean = true;
        private idleSeconds: number = 0.0;
        // Seconds of the pulses' clock (stops while paused).
        private pulseTime: number = 0.0;

        // The settings: the simulation's, the light's and the display's (-scene, -gravity, -c,
        // -bending, -emitter, -nosky set some before the run).
        scene: int = Scene.StarAndPlanets;
        private clusterBodies: int = DEFAULT_CLUSTER_BODIES;
        gravity: number = DEFAULT_GRAVITY;
        lightSpeed: number = DEFAULT_LIGHT_SPEED;
        private timeScale: number = DEFAULT_TIME_SCALE;
        bending: int = Bending.Schwarzschild;
        bendLight: boolean = true;
        emitter: int = Emitter.Sheet;
        private raysAcross: int = DEFAULT_RAYS_ACROSS;
        private rayRows: int = DEFAULT_RAY_ROWS;
        private emitterYaw: number = 0.0;
        private emitterPitch: number = 0.0;
        private emitterDistance: number = DEFAULT_EMITTER_DISTANCE;
        private emitterOffsetRight: number = 0.0;
        private emitterOffsetUp: number = 0.0;
        private beamHalfWidth: number = DEFAULT_BEAM_HALF_WIDTH;
        private coneAngle: number = DEFAULT_CONE_ANGLE;
        private rayLength: number = DEFAULT_RAY_LENGTH;
        showSky: boolean = true;
        private showGrid: boolean = true;
        private showStraight: boolean = false;
        private showPulses: boolean = true;
        private restartRequested: boolean = false;
        // -noUI: no settings window.
        noUI: boolean = false;

        // The bodies: position and velocity (3 numbers each), mass, radius and hue.
        private bodyCount: int = 0;
        private bodyPos: number[] = [];
        private bodyVel: number[] = [];
        private bodyAcc: number[] = [];
        private bodyMass: number[] = [];
        private bodyRadius: number[] = [];
        private bodyHue: number[] = [];

        // The SceneConstants, the PlanarViewConstants, and the matrices they're from (16 floats each).
        private sceneConstants: f32[] = zeros(SCENE_FLOATS);
        private viewConstants: f32[] = [];
        private viewMatrix: f32[] = zeros(16);
        private projMatrix: f32[] = zeros(16);

        // -test: the last frame, and the rays and their paths after it, are read back.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rayReadbackBuffer: NriBuffer | null = null;
        private pointReadbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < MAX_BODIES; i++) {
                for (let k = 0; k < 3; k++) {
                    this.bodyPos.push(0.0);
                    this.bodyVel.push(0.0);
                    this.bodyAcc.push(0.0);
                }
                this.bodyMass.push(0.0);
                this.bodyRadius.push(0.0);
                this.bodyHue.push(0.0);
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
            this.autoRotate = !this.test;

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;

            // The layouts, as the Donut example's binding layouts: the compute pass's scene (b0) and
            // points and rays (u0, u1); the draws' scene (b0) and view (b1), every stage (path_ps reads
            // the bodies and the camera too; the sky's pixel shader both), and the points and rays (t0,
            // t1) the vertex shaders read. All root descriptors.
            const computeLayoutDesc = NriPipelineLayoutDesc.create();
            computeLayoutDesc.addRootDescriptor(0, NriDescriptorType.ConstantBuffer, NriStage.Compute);
            computeLayoutDesc.addRootDescriptor(0, NriDescriptorType.StorageStructuredBuffer, NriStage.Compute);
            computeLayoutDesc.addRootDescriptor(1, NriDescriptorType.StorageStructuredBuffer, NriStage.Compute);
            this.computeLayout = device.createPipelineLayoutFromDesc(computeLayoutDesc);
            computeLayoutDesc.destroy();
            const drawLayoutDesc = NriPipelineLayoutDesc.create();
            drawLayoutDesc.addRootDescriptor(0, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel);
            drawLayoutDesc.addRootDescriptor(1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel);
            drawLayoutDesc.addRootDescriptor(0, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            drawLayoutDesc.addRootDescriptor(1, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            this.drawLayout = device.createPipelineLayoutFromDesc(drawLayoutDesc);
            drawLayoutDesc.destroy();
            const computeLayout = this.computeLayout;
            const drawLayout = this.drawLayout;
            if (!computeLayout || !drawLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: gravity_light_bending.hlsl's shaders, as compiled for the Donut example
            // (rays_cs with RAYS=1); the draws blended as the Donut example's (the paths and the
            // straight lines additively, the grid and the bodies alpha blended, the sky not), back
            // faces culled, no depth (Donut_CreateGraphicsPipelineWithBlend's state).
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/gravity_light_bending/${folder}/gravity_light_bending`;
            this.raysPipeline = device.createComputePipelinePermutation(computeLayout, `${shaders}_rays_cs.bin`, "rays_cs", "RAYS=1");
            this.pathPipeline = this.createPipeline(device, drawLayout, shaders, "path_vs", "path_ps", 1);
            this.straightPipeline = this.createPipeline(device, drawLayout, shaders, "straight_vs", "color_ps", 1);
            this.gridPipeline = this.createPipeline(device, drawLayout, shaders, "grid_vs", "color_ps", 2);
            this.bodyPipeline = this.createPipeline(device, drawLayout, shaders, "body_vs", "body_ps", 2);
            this.skyPipeline = this.createPipeline(device, drawLayout, shaders, "sky_vs", "sky_ps", 0);
            if (!this.raysPipeline || !this.pathPipeline || !this.straightPipeline || !this.gridPipeline || !this.bodyPipeline
                || !this.skyPipeline) {
                console.log("Cannot load the gravity light bending shaders");
                return 0;
            }

            this.createBodies();

            // The rays' paths, MAX_POINTS points each, and the rays (written before they're read).
            const pointBuffer = device.createUninitializedStorageBuffer(this.queue, MAX_RAYS * MAX_POINTS * 16, 16, NriBufferState.Storage);
            const rayBuffer = device.createUninitializedStorageBuffer(this.queue, MAX_RAYS * RAY_FLOATS * 4, RAY_FLOATS * 4,
                NriBufferState.Storage);
            this.pointBuffer = pointBuffer;
            this.rayBuffer = rayBuffer;
            // The constant buffer: a queued frame's SceneConstants, then its PlanarViewConstants.
            this.viewSize = Nri.getDonutConstantsSize(0);
            this.viewConstants = zeros(this.viewSize / 4);
            this.sceneStride = align(SCENE_FLOATS * 4);
            this.frameStride = this.sceneStride + align(this.viewSize);
            const constantBuffer = device.createHostBuffer(queuedFrameNum * this.frameStride, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            if (!pointBuffer || !rayBuffer || !constantBuffer) {
                console.log("Cannot create the buffers");
                return 0;
            }
            this.pointsStorage = pointBuffer.createStructuredView(1);
            this.pointsView = pointBuffer.createStructuredView(0);
            this.raysStorage = rayBuffer.createStructuredView(1);
            this.raysView = rayBuffer.createStructuredView(0);
            if (!this.pointsStorage || !this.pointsView || !this.raysStorage || !this.raysView) {
                console.log("Cannot create the buffer views");
                return 0;
            }

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const sceneView = constantBuffer.createConstantView(i * this.frameStride, this.sceneStride);
                const viewView = constantBuffer.createConstantView(i * this.frameStride + this.sceneStride, align(this.viewSize));
                if (!sceneView || !viewView) {
                    console.log("Cannot create the constant buffer views");
                    return 0;
                }
                // The frame's wrappers of its own (destroying nothing): constantViews keeps the views.
                this.queuedFrames.push(new QueuedFrame(new NriDescriptor(sceneView.handle), new NriDescriptor(viewView.handle)));
                this.constantViews.push(sceneView);
                this.constantViews.push(viewView);
            }

            // A look-at camera over the XZ plane, where the bodies orbit and the sheet of rays lies.
            this.camera.setTarget(0.0, 0.0, 0.0);
            this.camera.setDistance(32.0);
            this.camera.setRotation(radians(75.0), radians(40.0));

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
                this.rayReadbackBuffer = device.createReadbackBuffer(MAX_RAYS * RAY_FLOATS * 4);
                this.pointReadbackBuffer = device.createReadbackBuffer(MAX_RAYS * MAX_POINTS * 16);
                this.readbackFormat = format;
            }
            return 1;
        }

        // A draw's pipeline into the swap chain's sRGB view: blend 0 none, 1 Donut's additive (color
        // one + one, alpha srcAlpha + dstAlpha), 2 Donut's alpha blending (color srcAlpha +
        // invSrcAlpha, alpha invSrcAlpha + zero); back faces culled (NVRHI's default raster state).
        createPipeline(device: NriDevice, layout: NriPipelineLayout, shaders: string, vs: string, ps: string, blend: int) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_${vs}.bin`, vs) != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_${ps}.bin`, ps) != 0;
            }
            desc.setCullMode(NriCullMode.Back);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
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

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // 1 if the key (a GLFW key code) was pressed since the last frame.
        toggled(key: int) {
            return this.sample.isKeyToggled(key) != 0;
        }

        // The Donut example's input callbacks and onAnimate: a restart asked for; the keys; the
        // camera (its input, unless the settings window has the mouse; its idle orbit); the bodies'
        // steps and the pulses' clock (stopped while paused); the window title.
        update() {
            if (this.restartRequested) {
                this.restartRequested = false;
                this.createBodies();
            }

            // In test mode 1/60 second a frame in float32, as Donut's test mode passes it.
            const elapsedSeconds = Math.fround(this.test ? 1.0 / 60.0 : this.sample.getFrameTime());
            if (this.toggled(NriKey.Space)) {
                this.paused = !this.paused;
                this.idleSeconds = 0.0;
            }
            if (this.toggled(KEY_L)) {
                this.bendLight = !this.bendLight;
                this.idleSeconds = 0.0;
            }
            if (this.toggled(KEY_K)) {
                this.showSky = !this.showSky;
                this.idleSeconds = 0.0;
            }
            if (this.toggled(KEY_G)) {
                this.showGrid = !this.showGrid;
                this.idleSeconds = 0.0;
            }
            if (this.toggled(KEY_B)) {
                this.showStraight = !this.showStraight;
                this.idleSeconds = 0.0;
            }
            if (this.toggled(KEY_R)) {
                this.restartRequested = true;
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

            if (!this.paused) {
                const deltaT = elapsedSeconds < MAX_DELTA_T ? elapsedSeconds : MAX_DELTA_T;
                this.stepBodies(deltaT * this.timeScale);
                // Wrapped now and then, before the float the shader gets loses the frame's step
                // (the pulses jump once an hour).
                this.pulseTime += deltaT;
                if (this.pulseTime > PULSE_CLOCK_WRAP) {
                    this.pulseTime -= PULSE_CLOCK_WRAP;
                }
            }

            const light = this.bendLight ? `c = ${this.lightSpeed}` : "light not bent";
            const info = `${this.bodyCount} bodies, ${this.rayCount()} rays, ${light}`;
            this.sample.setWindowTitle(this.paused ? `${WINDOW_TITLE} - ${info} (paused)` : `${WINDOW_TITLE} - ${info}`);
        }

        // The rays the emitter sends: a sheet is one row of them.
        rayCount(): int {
            return this.emitter == Emitter.Sheet ? this.raysAcross : this.raysAcross * this.rayRows;
        }

        // The view constants (the camera: 60 degrees vertically) and the SceneConstants, into the
        // queued frame's part of the constant buffer.
        writeConstants(queuedFrameIndex: int) {
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
            const offset = queuedFrameIndex * this.frameStride;
            Nri.fillDonutPlanarViewConstants(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), this.width, this.height,
                Ref(this.viewConstants[0]));
            constantBuffer.write(offset + this.sceneStride, Ref(this.viewConstants[0]), this.viewSize);

            this.fillSceneConstants();
            constantBuffer.write(offset, Ref(this.sceneConstants[0]), SCENE_FLOATS * 4);
        }

        // The SceneConstants (c_Scene in the shader): the light, the tracing, the emitter and the bodies.
        fillSceneConstants() {
            const s = this.sceneConstants;
            s[0] = this.gravity;
            s[1] = this.lightSpeed;
            s[2] = this.bendLight ? this.bending : Bending.None;
            s[3] = this.bodyCount;

            // The sphere holding the bodies.
            let extent = 0.0;
            for (let i = 0; i < this.bodyCount; i++) {
                const x = this.bodyPos[i * 3 + 0];
                const y = this.bodyPos[i * 3 + 1];
                const z = this.bodyPos[i * 3 + 2];
                extent = Math.max(extent, Math.sqrt(x * x + y * y + z * z) + this.bodyRadius[i]);
            }
            s[4] = this.rayLength;
            s[5] = this.pulseTime;
            s[6] = this.showPulses ? this.lightSpeed * this.timeScale : 0.0;
            s[7] = extent + SKY_MARGIN;

            // The emitter's axes: forward from its yaw (about y, from +x towards +z) and pitch, right
            // across it in the horizontal plane, up across both.
            const yaw = radians(this.emitterYaw);
            const pitch = radians(this.emitterPitch);
            const fx = Math.cos(pitch) * Math.cos(yaw);
            const fy = Math.sin(pitch);
            const fz = Math.cos(pitch) * Math.sin(yaw);
            // right = normalize(forward x (0, 1, 0)), up = right x forward.
            const rLength = Math.sqrt(fz * fz + fx * fx);
            const rx = -fz / rLength;
            const rz = fx / rLength;
            const ux = -rz * fy;
            const uy = rz * fx - rx * fz;
            const uz = rx * fy;
            const pointSource = this.emitter == Emitter.Cone || this.emitter == Emitter.Sphere;
            s[8] = -fx * this.emitterDistance + rx * this.emitterOffsetRight + ux * this.emitterOffsetUp;
            s[9] = -fy * this.emitterDistance + uy * this.emitterOffsetUp;
            s[10] = -fz * this.emitterDistance + rz * this.emitterOffsetRight + uz * this.emitterOffsetUp;
            s[11] = this.emitter;
            s[12] = fx;
            s[13] = fy;
            s[14] = fz;
            s[15] = pointSource ? radians(this.coneAngle) : this.beamHalfWidth;
            s[16] = rx;
            s[17] = 0.0;
            s[18] = rz;
            s[19] = this.raysAcross;
            s[20] = ux;
            s[21] = uy;
            s[22] = uz;
            s[23] = this.rayRows;

            for (let i = 0; i < MAX_BODIES; i++) {
                const p = SCENE_BODIES + i * 4;
                const q = SCENE_BODY_INFO + i * 4;
                const present = i < this.bodyCount;
                s[p + 0] = present ? this.bodyPos[i * 3 + 0] : 0.0;
                s[p + 1] = present ? this.bodyPos[i * 3 + 1] : 0.0;
                s[p + 2] = present ? this.bodyPos[i * 3 + 2] : 0.0;
                s[p + 3] = present ? this.bodyMass[i] : 0.0;
                s[q + 0] = present ? this.bodyRadius[i] : 0.0;
                s[q + 1] = present ? this.bodyHue[i] : 0.0;
                s[q + 2] = this.showSky ? 1.0 : 0.0;
            }
        }

        // The rays through the bodies as they are now; the points and rays then go to the draws.
        recordRays(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const computeLayout = this.computeLayout;
            const raysPipeline = this.raysPipeline;
            const pointBuffer = this.pointBuffer;
            const rayBuffer = this.rayBuffer;
            const pointsStorage = this.pointsStorage;
            const raysStorage = this.raysStorage;
            if (!computeLayout || !raysPipeline || !pointBuffer || !rayBuffer || !pointsStorage || !raysStorage) {
                return;
            }
            if (this.raysDrawn) {
                commandBuffer.bufferBarrier(pointBuffer, NriBufferState.VertexShaderResource, NriBufferState.Storage);
                commandBuffer.bufferBarrier(rayBuffer, NriBufferState.VertexShaderResource, NriBufferState.Storage);
            }
            const rays = this.rayCount();
            commandBuffer.setComputePipelineLayout(computeLayout);
            commandBuffer.setPipeline(raysPipeline);
            commandBuffer.setComputeRootDescriptor(0, queuedFrame.sceneView);
            commandBuffer.setComputeRootDescriptor(1, pointsStorage);
            commandBuffer.setComputeRootDescriptor(2, raysStorage);
            commandBuffer.dispatch(Math.floor((rays + RAYS_GROUP_SIZE - 1) / RAYS_GROUP_SIZE), 1, 1);
            commandBuffer.bufferBarrier(pointBuffer, NriBufferState.Storage, NriBufferState.VertexShaderResource);
            commandBuffer.bufferBarrier(rayBuffer, NriBufferState.Storage, NriBufferState.VertexShaderResource);
            this.raysDrawn = true;
        }

        // vertexNum vertices of the pipeline, with the draws' root descriptors.
        draw(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame, pipeline: NriPipeline | null, vertexNum: int) {
            const drawLayout = this.drawLayout;
            const pointsView = this.pointsView;
            const raysView = this.raysView;
            if (!drawLayout || !pipeline || !pointsView || !raysView) {
                return;
            }
            commandBuffer.setPipelineLayout(drawLayout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setRootDescriptor(0, queuedFrame.sceneView, 0);
            commandBuffer.setRootDescriptor(1, queuedFrame.viewView, 0);
            commandBuffer.setRootDescriptor(2, pointsView, 0);
            commandBuffer.setRootDescriptor(3, raysView, 0);
            commandBuffer.draw(vertexNum, 1, 0, 0);
        }

        // The lensed sky with the bodies in it (or a black background and the bodies drawn over the
        // rays), the grid, the straight lines, the rays' paths; over the lensed sky, only the black
        // holes' horizons and photon spheres (body_vs). Between NriCommandBuffer.beginRendering and
        // NriCommandBuffer.endRendering.
        recordDraws(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            const rays = this.rayCount();
            if (this.showSky) {
                this.draw(commandBuffer, queuedFrame, this.skyPipeline, 3);
            } else {
                commandBuffer.clearColor(0.0, 0.0, 0.0, 1.0);
            }
            if (this.showGrid) {
                this.draw(commandBuffer, queuedFrame, this.gridPipeline, GRID_LINE_COUNT * VERTICES_PER_QUAD);
            }
            if (this.showStraight) {
                this.draw(commandBuffer, queuedFrame, this.straightPipeline, rays * VERTICES_PER_QUAD);
            }
            this.draw(commandBuffer, queuedFrame, this.pathPipeline, rays * (MAX_POINTS - 1) * VERTICES_PER_QUAD);
            this.draw(commandBuffer, queuedFrame, this.bodyPipeline, this.bodyCount * VERTICES_PER_QUAD);
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): once the GPU is done with it, the swap chain
        // made again at its size. The projection, the view constants and the settings window's place
        // read the size every frame.
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
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.update();
            if (this.imgui) {
                this.buildUI();
            }

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);
                this.writeConstants(queuedFrameIndex);

                // Record: the rays; the sky (or black), the lines and the bodies, the settings window.
                commandBuffer.begin();
                this.recordRays(commandBuffer, queuedFrame);
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                this.recordDraws(commandBuffer, queuedFrame);
                if (this.imgui) {
                    this.sample.drawImgui(commandBuffer, this.viewFormat);
                }
                commandBuffer.endRendering();

                // The test's last frame: read back, and the rays and their paths after it
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        commandBuffer.textureBarrier(texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                        commandBuffer.readbackTextureToBuffer(readbackBuffer, this.rowPitch, texture, this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                        this.recordRayReadback(commandBuffer);
                    }
                }
                commandBuffer.textureBarrier(texture, presentFrom, NriTextureState.Present);
                commandBuffer.end();

                // Submit and present
                this.swapChain.submit(commandBuffer, index);
                if (this.imgui) {
                    this.sample.imguiEndFrame();
                }
                this.swapChain.present(index);
            }

            // Signaled after the present, as NRISamples do
            this.frames.signal(frameIndex);
        }

        // Copies the rays and their paths (after the last frame's draws) to the readback buffers.
        recordRayReadback(commandBuffer: NriCommandBuffer) {
            const pointBuffer = this.pointBuffer;
            const rayBuffer = this.rayBuffer;
            const rayReadbackBuffer = this.rayReadbackBuffer;
            const pointReadbackBuffer = this.pointReadbackBuffer;
            if (!pointBuffer || !rayBuffer || !rayReadbackBuffer || !pointReadbackBuffer) {
                return;
            }
            const rays = this.rayCount();
            commandBuffer.bufferBarrier(rayBuffer, NriBufferState.VertexShaderResource, NriBufferState.CopySource);
            commandBuffer.bufferBarrier(pointBuffer, NriBufferState.VertexShaderResource, NriBufferState.CopySource);
            commandBuffer.copyBuffer(rayReadbackBuffer, rayBuffer, rays * RAY_FLOATS * 4);
            commandBuffer.copyBuffer(pointReadbackBuffer, pointBuffer, rays * MAX_POINTS * 16);
            commandBuffer.bufferBarrier(rayBuffer, NriBufferState.CopySource, NriBufferState.VertexShaderResource);
            commandBuffer.bufferBarrier(pointBuffer, NriBufferState.CopySource, NriBufferState.VertexShaderResource);
        }

        // --- The bodies ---------------------------------------------------------------------

        addBody(x: number, y: number, z: number, vx: number, vy: number, vz: number, mass: number, radius: number, hue: number) {
            if (this.bodyCount >= MAX_BODIES) {
                return;
            }
            const i = this.bodyCount;
            this.bodyPos[i * 3 + 0] = x;
            this.bodyPos[i * 3 + 1] = y;
            this.bodyPos[i * 3 + 2] = z;
            this.bodyVel[i * 3 + 0] = vx;
            this.bodyVel[i * 3 + 1] = vy;
            this.bodyVel[i * 3 + 2] = vz;
            this.bodyMass[i] = mass;
            this.bodyRadius[i] = radius;
            this.bodyHue[i] = hue;
            this.bodyCount++;
        }

        // A body on a circular orbit in the XZ plane around a mass `centralMass` at the origin, at
        // `distance` and `angle` (radians, from +x towards +z), going round counterclockwise seen
        // from above.
        addOrbiting(centralMass: number, distance: number, angle: number, mass: number, radius: number, hue: number) {
            const speed = Math.sqrt(this.gravity * (centralMass + mass) / distance);
            const c = Math.cos(angle);
            const s = Math.sin(angle);
            this.addBody(distance * c, 0.0, distance * s, speed * s, 0.0, -speed * c, mass, radius, hue);
        }

        // The scene's bodies, as at the start.
        createBodies() {
            this.bodyCount = 0;
            g_RandomSeed = 12345.0;
            const scene = this.scene;
            if (scene == Scene.StarAndPlanets) {
                const starMass = 30.0;
                this.addBody(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, starMass, 0.6, 0.13);
                this.addOrbiting(starMass, 4.0, 0.0, 0.3, 0.18, 0.55);
                this.addOrbiting(starMass, 7.0, 2.1, 1.5, 0.3, 0.0);
                this.addOrbiting(starMass, 11.0, 4.2, 4.0, 0.4, 0.33);
            } else if (scene == Scene.Binary) {
                // Two equal stars 6 apart, each going round their center at half their relative speed.
                const mass = 20.0;
                const speed = 0.5 * Math.sqrt(this.gravity * 2.0 * mass / 6.0);
                this.addBody(-3.0, 0.0, 0.0, 0.0, 0.0, speed, mass, 0.5, 0.08);
                this.addBody(3.0, 0.0, 0.0, 0.0, 0.0, -speed, mass, 0.5, 0.6);
            } else if (scene == Scene.FigureEight) {
                // Chenciner and Montgomery's figure eight (G = m = 1), scaled to masses of 15, 4 apart.
                const mass = 15.0;
                const length = 4.0;
                const speed = Math.sqrt(this.gravity * mass / length);
                const x = 0.97000436 * length;
                const z = -0.24308753 * length;
                const vx = -0.93240737 * speed;
                const vz = -0.86473146 * speed;
                this.addBody(x, 0.0, z, -0.5 * vx, 0.0, -0.5 * vz, mass, 0.35, 0.0);
                this.addBody(-x, 0.0, -z, -0.5 * vx, 0.0, -0.5 * vz, mass, 0.35, 0.33);
                this.addBody(0.0, 0.0, 0.0, vx, 0.0, vz, mass, 0.35, 0.66);
            } else if (scene == Scene.BlackHole) {
                // A black hole (its horizon, 2 G m / c^2 = 0.36 at the default c, outside its radius)
                // and a star going round it; both round their center of mass.
                const holeMass = 40.0;
                const starMass = 4.0;
                const distance = 7.0;
                const speed = Math.sqrt(this.gravity * (holeMass + starMass) / distance);
                const holeShare = starMass / (holeMass + starMass);
                this.addBody(-distance * holeShare, 0.0, 0.0, 0.0, 0.0, speed * holeShare, holeMass, 0.1, 0.0);
                this.addBody(distance * (1.0 - holeShare), 0.0, 0.0, 0.0, 0.0, -speed * (1.0 - holeShare), starMass, 0.45, 0.1);
            } else if (scene == Scene.Single) {
                this.addBody(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 20.0, 0.5, 0.13);
            } else {
                // Random masses in a ball, turning about y as a whole, with some random motion.
                for (let i = 0; i < this.clusterBodies; i++) {
                    let x = 0.0;
                    let y = 0.0;
                    let z = 0.0;
                    for (let attempt = 0; attempt < 100; attempt++) {
                        x = 14.0 * randomFloat() - 7.0;
                        y = 4.0 * randomFloat() - 2.0;
                        z = 14.0 * randomFloat() - 7.0;
                        let apart = x * x + z * z < 49.0;
                        for (let k = 0; k < i; k++) {
                            const dx = x - this.bodyPos[k * 3 + 0];
                            const dy = y - this.bodyPos[k * 3 + 1];
                            const dz = z - this.bodyPos[k * 3 + 2];
                            if (dx * dx + dy * dy + dz * dz < 4.0) {
                                apart = false;
                            }
                        }
                        if (apart) {
                            break;
                        }
                    }
                    const mass = 2.0 + 10.0 * randomFloat();
                    const radius = 0.15 * Math.pow(mass, 1.0 / 3.0);
                    const spin = 0.35;
                    this.addBody(x, y, z, z * spin + randomFloat() - 0.5, 0.2 * (randomFloat() - 0.5), -x * spin + randomFloat() - 0.5,
                        mass, radius, randomFloat());
                }
            }

            // The center of mass at rest at the origin, so the scene stays in view.
            let mass = 0.0;
            const center = [0.0, 0.0, 0.0];
            const momentum = [0.0, 0.0, 0.0];
            for (let i = 0; i < this.bodyCount; i++) {
                mass += this.bodyMass[i];
                for (let k = 0; k < 3; k++) {
                    center[k] += this.bodyMass[i] * this.bodyPos[i * 3 + k];
                    momentum[k] += this.bodyMass[i] * this.bodyVel[i * 3 + k];
                }
            }
            for (let i = 0; i < this.bodyCount; i++) {
                for (let k = 0; k < 3; k++) {
                    this.bodyPos[i * 3 + k] -= center[k] / mass;
                    this.bodyVel[i * 3 + k] -= momentum[k] / mass;
                }
            }
            this.computeAccelerations();
        }

        // Every body's acceleration from the others' gravity, softened a little.
        computeAccelerations() {
            for (let i = 0; i < this.bodyCount * 3; i++) {
                this.bodyAcc[i] = 0.0;
            }
            for (let i = 0; i < this.bodyCount; i++) {
                for (let j = i + 1; j < this.bodyCount; j++) {
                    const dx = this.bodyPos[j * 3 + 0] - this.bodyPos[i * 3 + 0];
                    const dy = this.bodyPos[j * 3 + 1] - this.bodyPos[i * 3 + 1];
                    const dz = this.bodyPos[j * 3 + 2] - this.bodyPos[i * 3 + 2];
                    const r2 = dx * dx + dy * dy + dz * dz + BODY_SOFTENING;
                    const inverse3 = this.gravity / (r2 * Math.sqrt(r2));
                    const mi = this.bodyMass[i] * inverse3;
                    const mj = this.bodyMass[j] * inverse3;
                    this.bodyAcc[i * 3 + 0] += mj * dx;
                    this.bodyAcc[i * 3 + 1] += mj * dy;
                    this.bodyAcc[i * 3 + 2] += mj * dz;
                    this.bodyAcc[j * 3 + 0] -= mi * dx;
                    this.bodyAcc[j * 3 + 1] -= mi * dy;
                    this.bodyAcc[j * 3 + 2] -= mi * dz;
                }
            }
        }

        // The bodies `deltaT` seconds on, in SUBSTEPS leapfrog steps (kick, drift, kick: it keeps
        // the orbits' energy over time, unlike Euler's).
        stepBodies(deltaT: number) {
            const h = deltaT / SUBSTEPS;
            for (let step = 0; step < SUBSTEPS; step++) {
                for (let i = 0; i < this.bodyCount * 3; i++) {
                    this.bodyVel[i] += 0.5 * h * this.bodyAcc[i];
                    this.bodyPos[i] += h * this.bodyVel[i];
                }
                this.mergeTouching();
                this.computeAccelerations();
                for (let i = 0; i < this.bodyCount * 3; i++) {
                    this.bodyVel[i] += 0.5 * h * this.bodyAcc[i];
                }
            }
        }

        // Bodies that touch merge: the lighter into the heavier, keeping the mass, the momentum and
        // the volume, at their center of mass.
        mergeTouching() {
            for (let i = 0; i < this.bodyCount; i++) {
                for (let j = i + 1; j < this.bodyCount; j++) {
                    const dx = this.bodyPos[j * 3 + 0] - this.bodyPos[i * 3 + 0];
                    const dy = this.bodyPos[j * 3 + 1] - this.bodyPos[i * 3 + 1];
                    const dz = this.bodyPos[j * 3 + 2] - this.bodyPos[i * 3 + 2];
                    const reach = this.bodyRadius[i] + this.bodyRadius[j];
                    if (dx * dx + dy * dy + dz * dz >= reach * reach) {
                        continue;
                    }
                    const keep = this.bodyMass[i] >= this.bodyMass[j] ? i : j;
                    const gone = keep == i ? j : i;
                    const mass = this.bodyMass[i] + this.bodyMass[j];
                    for (let k = 0; k < 3; k++) {
                        this.bodyPos[keep * 3 + k] = (this.bodyMass[i] * this.bodyPos[i * 3 + k] + this.bodyMass[j] * this.bodyPos[j * 3 + k]) / mass;
                        this.bodyVel[keep * 3 + k] = (this.bodyMass[i] * this.bodyVel[i * 3 + k] + this.bodyMass[j] * this.bodyVel[j * 3 + k]) / mass;
                    }
                    const ri = this.bodyRadius[i];
                    const rj = this.bodyRadius[j];
                    this.bodyRadius[keep] = Math.pow(ri * ri * ri + rj * rj * rj, 1.0 / 3.0);
                    this.bodyMass[keep] = mass;
                    this.removeBody(gone);
                    // Look again from the start: the merged body may touch others now.
                    i = -1;
                    break;
                }
            }
        }

        // Removes body `index`: the last one takes its place.
        removeBody(index: int) {
            const last = this.bodyCount - 1;
            for (let k = 0; k < 3; k++) {
                this.bodyPos[index * 3 + k] = this.bodyPos[last * 3 + k];
                this.bodyVel[index * 3 + k] = this.bodyVel[last * 3 + k];
                this.bodyAcc[index * 3 + k] = this.bodyAcc[last * 3 + k];
            }
            this.bodyMass[index] = this.bodyMass[last];
            this.bodyRadius[index] = this.bodyRadius[last];
            this.bodyHue[index] = this.bodyHue[last];
            this.bodyCount = last;
        }

        // --- Test ---------------------------------------------------------------------------

        // The first count floats of a readback buffer (the GPU idle), empty if it can't be read.
        readFloats(buffer: NriBuffer | null, count: int): f32[] {
            const values = zeros(count);
            if (!buffer || count == 0) {
                return [];
            }
            if (buffer.readFloats(Ref(values[0]), count) == 0) {
                return [];
            }
            return values;
        }

        // -test, as the Donut example checks: the rays traced in the last frame. Every path is finite
        // and has at least two points. Without gravity, every point of a path lies on the line its
        // ray started on. No path goes into a body and out again. With one mass (-scene single), each
        // ray passing it turns by what the theory gives (expectedDeflection); a black hole, with the
        // exact bending, takes the rays coming closer than the critical impact parameter, and no
        // others (checkCapture). Otherwise, some ray turned. Then the frame: drawn.
        checkTest() {
            const device = this.device;
            if (!device) {
                return "cannot read the rays back";
            }
            device.waitIdle();
            const rays = this.rayCount();
            const rayData = this.readFloats(this.rayReadbackBuffer, rays * RAY_FLOATS);
            const points = this.readFloats(this.pointReadbackBuffer, rays * MAX_POINTS * 4);
            if (rayData.length == 0 || points.length == 0) {
                return "cannot read the rays back";
            }

            let maxTurn = 0.0;
            let maxOffLine = 0.0;
            let stopped = 0;
            for (let i = 0; i < rays; i++) {
                const r = i * RAY_FLOATS;
                const count = Math.floor(rayData[r + 7]);
                if (count < 2 || count > MAX_POINTS) {
                    return `ray ${i}: ${count} points`;
                }
                for (let k = 0; k < count * 4; k++) {
                    if (!isFinite32(points[i * MAX_POINTS * 4 + k])) {
                        return `ray ${i}: point ${Math.floor(k / 4)} is not finite`;
                    }
                }
                if (rayData[r + 12] >= 0.0) {
                    stopped++;
                }
                maxTurn = Math.max(maxTurn, this.turnAngle(rayData, r));

                // Each point's distance from the starting line.
                for (let p = 0; p < count; p++) {
                    const q = (i * MAX_POINTS + p) * 4;
                    const wx = points[q + 0] - rayData[r + 0];
                    const wy = points[q + 1] - rayData[r + 1];
                    const wz = points[q + 2] - rayData[r + 2];
                    const cx = wy * rayData[r + 6] - wz * rayData[r + 5];
                    const cy = wz * rayData[r + 4] - wx * rayData[r + 6];
                    const cz = wx * rayData[r + 5] - wy * rayData[r + 4];
                    maxOffLine = Math.max(maxOffLine, Math.sqrt(cx * cx + cy * cy + cz * cz));
                }
            }
            console.log(`Rays: ${rays}, stopped by a body ${stopped}; largest turn ${maxTurn} rad, farthest off the starting line ${maxOffLine}`);

            // No path goes through a body (inside its surface or horizon) and on.
            let through = 0;
            for (let i = 0; i < rays; i++) {
                const depth = this.deepestInside(rayData, points, i);
                if (depth > 0.0) {
                    if (through == 0) {
                        console.log(`ray ${i}: ${depth} of a body's radius inside it, and went on (fate ${rayData[i * RAY_FLOATS + 12]})`);
                    }
                    through++;
                }
            }
            console.log(`Paths through a body: ${through}`);
            if (through > 0) {
                return `${through} rays went into a body and out again`;
            }

            if (this.gravity == 0.0 || !this.bendLight) {
                if (maxOffLine > STRAIGHT_TOLERANCE) {
                    return `without gravity, a ray's path is ${maxOffLine} off its straight line`;
                }
                // And those no body stopped went the whole length.
                for (let i = 0; i < rays; i++) {
                    const r = i * RAY_FLOATS;
                    if (rayData[r + 12] < 0.0 && Math.abs(rayData[r + 11] - this.rayLength) > this.rayLength * 1.0e-4) {
                        return `ray ${i} went ${rayData[r + 11]}, not ${this.rayLength}`;
                    }
                }
            } else if (this.scene == Scene.Single && this.bending == Bending.Schwarzschild && this.isBlackHole(0)) {
                const failure = this.checkCapture(rayData, rays);
                if (failure != "") {
                    return failure;
                }
            } else if (this.scene == Scene.Single) {
                const failure = this.checkDeflection(rayData, rays);
                if (failure != "") {
                    return failure;
                }
            } else if (maxTurn < 0.01) {
                return `no ray turned by more than ${maxTurn} rad`;
            }

            for (let i = 0; i < this.bodyCount * 3; i++) {
                if (!isFinite32(this.bodyPos[i]) || !isFinite32(this.bodyVel[i])) {
                    return `body ${Math.floor(i / 3)}: position or velocity not finite`;
                }
            }

            // The frame: at least 10000 pixels drawn over black.
            const pixels = this.readBack();
            if (pixels.length == 0) {
                return "cannot read the back buffer";
            }
            let drawn = 0;
            for (let i = 0; i < pixels.length; i++) {
                if ((pixels[i] & 0xFFFFFF) != 0) {
                    drawn++;
                }
            }
            console.log(`Frame: ${drawn} pixels`);
            if (drawn < 10000) {
                return `Frame: ${drawn} pixels drawn, not 10000 or more`;
            }
            return "";
        }

        // How far inside a body (its absorbing radius: the surface, or the horizon if larger) ray i's
        // path goes, as a share of that radius, the segments' closest points to the bodies' centers
        // taken; 0 if it stays out. The last segment of a ray a body stopped ends in it: not counted.
        deepestInside(rayData: f32[], points: f32[], i: int) {
            const r = i * RAY_FLOATS;
            const count = Math.floor(rayData[r + 7]);
            const segments = rayData[r + 12] >= 0.0 ? count - 2 : count - 1;
            let deepest = 0.0;
            for (let body = 0; body < this.bodyCount; body++) {
                const rs = 2.0 * this.gravity * this.bodyMass[body] / (this.lightSpeed * this.lightSpeed);
                const radius = Math.max(this.bodyRadius[body], rs);
                for (let p = 0; p < segments; p++) {
                    const a = (i * MAX_POINTS + p) * 4;
                    const b = a + 4;
                    const dx = points[b + 0] - points[a + 0];
                    const dy = points[b + 1] - points[a + 1];
                    const dz = points[b + 2] - points[a + 2];
                    const wx = this.bodyPos[body * 3 + 0] - points[a + 0];
                    const wy = this.bodyPos[body * 3 + 1] - points[a + 1];
                    const wz = this.bodyPos[body * 3 + 2] - points[a + 2];
                    const length2 = dx * dx + dy * dy + dz * dz;
                    let t = length2 > 0.0 ? (wx * dx + wy * dy + wz * dz) / length2 : 0.0;
                    t = t < 0.0 ? 0.0 : (t > 1.0 ? 1.0 : t);
                    const ox = wx - t * dx;
                    const oy = wy - t * dy;
                    const oz = wz - t * dz;
                    const inside = 1.0 - Math.sqrt(ox * ox + oy * oy + oz * oz) / radius;
                    if (inside > deepest) {
                        deepest = inside;
                    }
                }
            }
            return deepest;
        }

        // The angle between the direction a ray started in and the one it ended in (rayData[r..]):
        // from the cross product, precise for small angles, as the dot product's cosine isn't.
        turnAngle(rayData: f32[], r: int) {
            const sx = rayData[r + 4];
            const sy = rayData[r + 5];
            const sz = rayData[r + 6];
            const ex = rayData[r + 8];
            const ey = rayData[r + 9];
            const ez = rayData[r + 10];
            const cx = sy * ez - sz * ey;
            const cy = sz * ex - sx * ez;
            const cz = sx * ey - sy * ex;
            return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), sx * ex + sy * ey + sz * ez);
        }

        // Whether body i is inside its own Schwarzschild radius.
        isBlackHole(i: int) {
            return 2.0 * this.gravity * this.bodyMass[i] / (this.lightSpeed * this.lightSpeed) >= this.bodyRadius[i];
        }

        // One black hole at the origin, the exact (Schwarzschild) bending: a ray falls in when it
        // comes at it closer than the critical impact parameter 3 sqrt(3) / 2 r_s (it crosses the
        // photon sphere and spirals in), and escapes, however bent, when it comes farther; checked
        // outside CAPTURE_MARGIN of it either way (closer to it, a ray circles many times).
        checkCapture(rayData: f32[], rays: int) {
            const rs = 2.0 * this.gravity * this.bodyMass[0] / (this.lightSpeed * this.lightSpeed);
            const critical = 1.5 * Math.sqrt(3.0) * rs;
            let captured = 0;
            let escaped = 0;
            for (let i = 0; i < rays; i++) {
                const r = i * RAY_FLOATS;
                const wx = this.bodyPos[0] - rayData[r + 0];
                const wy = this.bodyPos[1] - rayData[r + 1];
                const wz = this.bodyPos[2] - rayData[r + 2];
                const before = wx * rayData[r + 4] + wy * rayData[r + 5] + wz * rayData[r + 6];
                const ax = wx - before * rayData[r + 4];
                const ay = wy - before * rayData[r + 5];
                const az = wz - before * rayData[r + 6];
                const b = Math.sqrt(ax * ax + ay * ay + az * az);
                const stopped = rayData[r + 12] >= 0.0;
                if (b < critical * (1.0 - CAPTURE_MARGIN)) {
                    if (!stopped) {
                        return `ray ${i} (b ${b}, under the critical ${critical}) escaped the black hole`;
                    }
                    captured++;
                } else if (b > critical * (1.0 + CAPTURE_MARGIN)) {
                    if (stopped) {
                        return `ray ${i} (b ${b}, over the critical ${critical}) fell into the black hole`;
                    }
                    escaped++;
                }
            }
            console.log(`Capture: critical b ${critical} (r_s ${rs}); ${captured} rays inside it fell in, ${escaped} outside escaped`);
            if (captured < 2 || escaped < 2) {
                return `too few rays on either side of the critical impact parameter (${captured} in, ${escaped} out)`;
            }
            return "";
        }

        // One mass at the origin: each ray it didn't stop, passing at least DEFLECTION_MIN_IMPACT
        // radii from it, turned towards it by expectedDeflection, within DEFLECTION_TOLERANCE of it.
        checkDeflection(rayData: f32[], rays: int) {
            const mass = this.bodyMass[0];
            const rs = 2.0 * this.gravity * mass / (this.lightSpeed * this.lightSpeed);
            let checked = 0;
            let worst = 0.0;
            for (let i = 0; i < rays; i++) {
                const r = i * RAY_FLOATS;
                if (rayData[r + 12] >= 0.0) {
                    continue;
                }
                // From the ray's start to the mass: `before` along the ray, b across it.
                const wx = this.bodyPos[0] - rayData[r + 0];
                const wy = this.bodyPos[1] - rayData[r + 1];
                const wz = this.bodyPos[2] - rayData[r + 2];
                const before = wx * rayData[r + 4] + wy * rayData[r + 5] + wz * rayData[r + 6];
                const ax = wx - before * rayData[r + 4];
                const ay = wy - before * rayData[r + 5];
                const az = wz - before * rayData[r + 6];
                const b = Math.sqrt(ax * ax + ay * ay + az * az);
                if (b < DEFLECTION_MIN_IMPACT * this.bodyRadius[0]) {
                    continue;
                }
                const after = rayData[r + 11] - before;
                const expected = expectedDeflection(this.bending, rs, b, before, after);
                const measured = this.turnAngle(rayData, r);
                // Towards the mass: the turn has the direction from the line to it.
                const towards = (rayData[r + 8] - rayData[r + 4]) * ax + (rayData[r + 9] - rayData[r + 5]) * ay
                    + (rayData[r + 10] - rayData[r + 6]) * az;
                const error = Math.abs(measured - expected) / expected;
                if (checked == 0 || error > worst) {
                    console.log(`b ${b}: turned ${measured} rad, expected ${expected} (error ${error})`);
                }
                if (towards <= 0.0) {
                    return `ray ${i} (b ${b}) turned away from the mass`;
                }
                worst = Math.max(worst, error);
                checked++;
            }
            console.log(`Deflection: ${checked} rays checked, worst error ${worst} (limit ${DEFLECTION_TOLERANCE})`);
            if (checked < 4) {
                return `only ${checked} rays passed the mass far enough to check`;
            }
            if (worst > DEFLECTION_TOLERANCE) {
                return `a ray's deflection is ${worst} off the theory's`;
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

        // The settings window, top right.
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPosPivot(this.width - 10.0, 10.0, 1.0, 0.0);
            NriImgui.begin("Gravity Light Bending", 1);
            NriImgui.pushItemWidth(180.0);

            if (NriImgui.collapsingHeader("Light", 1) != 0) {
                this.bendLight = this.checkbox("Gravity bends light (L)", this.bendLight);
                if (this.bendLight) {
                    this.bending = NriImgui.combo("Bending", this.bending, BENDINGS);
                }
                this.lightSpeed = NriImgui.sliderFloat("Speed of light c (u/s)", this.lightSpeed, LIGHT_SPEED_MIN, LIGHT_SPEED_MAX);
                this.emitter = NriImgui.combo("Emitter", this.emitter, EMITTERS);
                this.raysAcross = NriImgui.sliderInt(this.emitter == Emitter.Sheet ? "Rays" : "Rays across", this.raysAcross, 1, MAX_RAYS_ACROSS);
                if (this.emitter != Emitter.Sheet) {
                    this.rayRows = NriImgui.sliderInt("Rows", this.rayRows, 1, MAX_RAYS_ACROSS);
                }
                if (this.emitter == Emitter.Cone) {
                    this.coneAngle = NriImgui.sliderFloat("Cone half angle (deg)", this.coneAngle, 0.0, 89.0);
                } else if (this.emitter != Emitter.Sphere) {
                    this.beamHalfWidth = NriImgui.sliderFloat("Beam half width (u)", this.beamHalfWidth, 0.0, 30.0);
                }
                this.emitterYaw = NriImgui.sliderFloat("Direction yaw (deg)", this.emitterYaw, -180.0, 180.0);
                this.emitterPitch = NriImgui.sliderFloat("Direction pitch (deg)", this.emitterPitch, -85.0, 85.0);
                this.emitterDistance = NriImgui.sliderFloat("Emitter distance (u)", this.emitterDistance, 0.0, 60.0);
                this.emitterOffsetRight = NriImgui.sliderFloat("Emitter offset right (u)", this.emitterOffsetRight, -20.0, 20.0);
                this.emitterOffsetUp = NriImgui.sliderFloat("Emitter offset up (u)", this.emitterOffsetUp, -20.0, 20.0);
                this.rayLength = NriImgui.sliderFloat("Ray length (u)", this.rayLength, 1.0, RAY_LENGTH_MAX);
            }

            if (NriImgui.collapsingHeader("Simulation", 1) != 0) {
                this.paused = this.checkbox("Paused (Space)", this.paused);
                this.timeScale = NriImgui.sliderFloat("Time scale", this.timeScale, 0.0, 4.0);
                this.gravity = NriImgui.sliderFloat("Gravity G", this.gravity, 0.0, 4.0);
                this.scene = NriImgui.combo("Scene", this.scene, SCENES);
                if (this.scene == Scene.Cluster) {
                    this.clusterBodies = NriImgui.sliderInt("Bodies", this.clusterBodies, 1, MAX_BODIES);
                }
                if (NriImgui.button("Restart (R)") != 0) {
                    this.restartRequested = true;
                }
            }

            if (NriImgui.collapsingHeader("Display", 1) != 0) {
                this.showSky = this.checkbox("Lensed sky (K)", this.showSky);
                this.showGrid = this.checkbox("Grid (G)", this.showGrid);
                this.showStraight = this.checkbox("Straight lines to compare (B)", this.showStraight);
                this.showPulses = this.checkbox("Light pulses", this.showPulses);
                this.autoRotate = this.checkbox("Orbit when idle", this.autoRotate);
            }

            if (NriImgui.collapsingHeader("Units", 0) != 0) {
                NriImgui.text("u: scene unit; the grid's lines are 2 u apart");
                NriImgui.text("Gravity: a = G m / r^2; the rays are traced through it");
                NriImgui.text("  as the bodies are, the light's travel time left out");
                NriImgui.text("A ray passing a mass m at distance b turns by");
                NriImgui.text("  2 G m / (c^2 b) as a Newtonian particle at c,");
                NriImgui.text("  4 G m / (c^2 b) in general relativity");
                NriImgui.text("Schwarzschild radius r_s = 2 G m / c^2: a body");
                NriImgui.text("  inside its own is a black hole; light circles it");
                NriImgui.text("  at 1.5 r_s (the exact mode), and takes every ray");
                NriImgui.text("  aimed within 2.6 r_s of it");
                NriImgui.text("Black hole: orange ring = horizon, dashed = photon");
                NriImgui.text("  sphere; the dark disk in the sky is its shadow");
                NriImgui.text("The pulses run at c times the time scale");
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
                this.swapChain.destroy();
                for (const view of this.constantViews) {
                    view.destroy();
                }
                this.destroyDescriptor(this.pointsStorage);
                this.destroyDescriptor(this.pointsView);
                this.destroyDescriptor(this.raysStorage);
                this.destroyDescriptor(this.raysView);
                this.destroyBuffer(this.pointBuffer);
                this.destroyBuffer(this.rayBuffer);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyBuffer(this.rayReadbackBuffer);
                this.destroyBuffer(this.pointReadbackBuffer);
                this.destroyPipeline(this.raysPipeline);
                this.destroyPipeline(this.pathPipeline);
                this.destroyPipeline(this.straightPipeline);
                this.destroyPipeline(this.gridPipeline);
                this.destroyPipeline(this.bodyPipeline);
                this.destroyPipeline(this.skyPipeline);
                const computeLayout = this.computeLayout;
                if (computeLayout) {
                    computeLayout.destroy();
                }
                const drawLayout = this.drawLayout;
                if (drawLayout) {
                    drawLayout.destroy();
                }
                this.frames.destroy();
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
        const lightBending = new LightBending(sample);
        // -scene <planets|binary|eight|blackhole|single|cluster>: the bodies (a star and planets by
        // default); -gravity <G>: the gravitational constant (1 by default; 0: no gravity, the rays
        // straight); -c <speed>: the speed of light (15 by default); -bending <0..3>: Newtonian, weak
        // field, Schwarzschild (the default), none; -emitter <0..3>: a sheet of parallel rays (the
        // default), a beam, a cone, a point; -nosky: a black background and the bodies drawn over the
        // rays, not the lensed sky (which traces every pixel: the costly part on a slow GPU); -noUI:
        // no settings window.
        sample.addExampleOptionWithValues("-scene", 1);
        sample.addExampleOptionWithValues("-gravity", 1);
        sample.addExampleOptionWithValues("-c", 1);
        sample.addExampleOptionWithValues("-bending", 1);
        sample.addExampleOptionWithValues("-emitter", 1);
        sample.addExampleOption("-nosky");
        sample.addExampleOption("-noUI");
        sample.useImgui();
        let bending: int = Bending.Schwarzschild;
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-scene" && i + 1 < argc) {
                const name = Nri.getArg(argc, argv, i + 1);
                if (name == "planets") {
                    lightBending.scene = Scene.StarAndPlanets;
                } else if (name == "binary") {
                    lightBending.scene = Scene.Binary;
                } else if (name == "eight") {
                    lightBending.scene = Scene.FigureEight;
                } else if (name == "blackhole") {
                    lightBending.scene = Scene.BlackHole;
                } else if (name == "single") {
                    lightBending.scene = Scene.Single;
                } else if (name == "cluster") {
                    lightBending.scene = Scene.Cluster;
                }
                i++;
            } else if (arg == "-gravity" && i + 1 < argc) {
                lightBending.gravity = parseFloat(Nri.getArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-c" && i + 1 < argc) {
                lightBending.lightSpeed = parseFloat(Nri.getArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-bending" && i + 1 < argc) {
                bending = parseInt(Nri.getArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-nosky") {
                lightBending.showSky = false;
            } else if (arg == "-emitter" && i + 1 < argc) {
                lightBending.emitter = parseInt(Nri.getArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-noUI") {
                lightBending.noUI = true;
            }
        }
        if (lightBending.lightSpeed < LIGHT_SPEED_MIN) {
            lightBending.lightSpeed = LIGHT_SPEED_MIN;
        }
        if (bending < 0 || bending > Bending.None) {
            bending = Bending.Schwarzschild;
        }
        if (lightBending.emitter < 0 || lightBending.emitter > Emitter.Sphere) {
            lightBending.emitter = Emitter.Sheet;
        }
        // The Donut example's configure: Bending.None leaves the light unbent.
        if (bending == Bending.None) {
            lightBending.bendLight = false;
        } else {
            lightBending.bending = bending;
        }
        return lightBending.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return GravityLightBendingNri.main(argc, argv);
}

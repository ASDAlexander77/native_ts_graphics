// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, isFinite32 } from "../core/test_check";
import { radians, perspProjD3DStyleReverse } from "../core/matrix";

namespace GravityLightBending {
    const WINDOW_TITLE = "Donut Example: Gravity Light Bending";

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

    // std::default_random_engine replacement: a Park-Miller generator, from a seed so runs repeat.
    let g_RandomSeed = 12345.0;
    function randomFloat() {
        g_RandomSeed = (g_RandomSeed * 16807.0) % 2147483647.0;
        return g_RandomSeed / 2147483647.0;
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

    // --- Passes -------------------------------------------------------------------------------

    // Light bent by gravity. A few massive bodies (a scene to choose: a star and its planets, two
    // stars, three bodies on a figure eight, a black hole and a star...) move under each other's
    // gravity, stepped here (leapfrog, merging those that touch). Every frame a compute pass traces
    // the light of an emitter (a sheet or a beam of parallel rays, a cone or a point shining every
    // way) through their field and the rays' paths are drawn, with pulses running along them at the
    // speed of light: where the field is zero a ray goes straight, past a mass it bends towards it,
    // the more the closer; it ends in a body it hits. The same tracing from the camera, through
    // every pixel, draws the sky behind the bodies as the bent light shows it, and the bodies
    // themselves: lensed, with Einstein rings around them and black holes' shadows. The UI sets the
    // speed of light (lower: more bending; a body inside its own Schwarzschild radius is a black
    // hole), how the light bends (as a Newtonian particle at c, general relativity's twice that, or
    // the exact Schwarzschild path around each body), and the emitter. Space pauses, L switches the
    // bending off and on (the rays straight, through the same bodies), K the lensed sky, G the
    // grid, B the straight lines to compare, R restarts.
    class LightBendingPass {
        private app: App;
        private camera: Camera;
        private view: View;
        private paused: boolean;
        private autoRotate: boolean;
        private idleSeconds: number;
        private buttonsDown: int;
        private frameWidth: int;
        // Seconds of the pulses' clock (stops while paused).
        private pulseTime: number;

        // The settings: the simulation's, the light's and the display's.
        private scene: int;
        private clusterBodies: int;
        private gravity: number;
        private lightSpeed: number;
        private timeScale: number;
        private bending: int;
        private bendLight: boolean;
        private emitter: int;
        private raysAcross: int;
        private rayRows: int;
        private emitterYaw: number;
        private emitterPitch: number;
        private emitterDistance: number;
        private emitterOffsetRight: number;
        private emitterOffsetUp: number;
        private beamHalfWidth: number;
        private coneAngle: number;
        private rayLength: number;
        private showSky: boolean;
        private showGrid: boolean;
        private showStraight: boolean;
        private showPulses: boolean;
        private restartRequested: boolean;

        // The bodies: position and velocity (3 numbers each), mass, radius and hue.
        private bodyCount: int;
        private bodyPos: number[];
        private bodyVel: number[];
        private bodyAcc: number[];
        private bodyMass: number[];
        private bodyRadius: number[];
        private bodyHue: number[];

        private sceneConstants: f32[];
        private sceneBuffer: BufferHandle;
        private pointBuffer: BufferHandle;
        private rayBuffer: BufferHandle;
        private raysPipeline: ComputePipelineHandle;
        private computeBindingSet: BindingSet;
        private drawBindingLayout: BindingLayoutHandle;
        private drawBindingSet: BindingSet;
        private skyBindingLayout: BindingLayoutHandle;
        private skyBindingSet: BindingSet;
        private viewConstantBuffer: BufferHandle;
        private pathVertexShader: ShaderHandle;
        private pathPixelShader: ShaderHandle;
        private straightVertexShader: ShaderHandle;
        private gridVertexShader: ShaderHandle;
        private colorPixelShader: ShaderHandle;
        private bodyVertexShader: ShaderHandle;
        private bodyPixelShader: ShaderHandle;
        private skyVertexShader: ShaderHandle;
        private skyPixelShader: ShaderHandle;
        // Created on the first frame (they depend on the framebuffer layout), dropped on resize.
        private pathPipeline: GraphicsPipelineHandle | null;
        private straightPipeline: GraphicsPipelineHandle | null;
        private gridPipeline: GraphicsPipelineHandle | null;
        private bodyPipeline: GraphicsPipelineHandle | null;
        private skyPipeline: GraphicsPipelineHandle | null;

        // The PlanarViewConstants contents.
        private viewConstants: f32[];
        private viewConstantsSize: int;
        // Passed to Donut_SetPlanarView, 16 floats each.
        private viewMatrix: f32[];
        private projMatrix: f32[];

        constructor(app: App, autoRotate: boolean, private showUI: boolean) {
            this.app = app;
            this.autoRotate = autoRotate;
            this.paused = false;
            this.idleSeconds = 0.0;
            this.buttonsDown = 0;
            this.frameWidth = 1280;
            this.pulseTime = 0.0;

            this.scene = Scene.StarAndPlanets;
            this.clusterBodies = DEFAULT_CLUSTER_BODIES;
            this.gravity = DEFAULT_GRAVITY;
            this.lightSpeed = DEFAULT_LIGHT_SPEED;
            this.timeScale = DEFAULT_TIME_SCALE;
            this.bending = Bending.Schwarzschild;
            this.bendLight = true;
            this.emitter = Emitter.Sheet;
            this.raysAcross = DEFAULT_RAYS_ACROSS;
            this.rayRows = DEFAULT_RAY_ROWS;
            this.emitterYaw = 0.0;
            this.emitterPitch = 0.0;
            this.emitterDistance = DEFAULT_EMITTER_DISTANCE;
            this.emitterOffsetRight = 0.0;
            this.emitterOffsetUp = 0.0;
            this.beamHalfWidth = DEFAULT_BEAM_HALF_WIDTH;
            this.coneAngle = DEFAULT_CONE_ANGLE;
            this.rayLength = DEFAULT_RAY_LENGTH;
            this.showSky = true;
            this.showGrid = true;
            this.showStraight = false;
            this.showPulses = true;
            this.restartRequested = false;

            this.bodyCount = 0;
            this.bodyPos = [];
            this.bodyVel = [];
            this.bodyAcc = [];
            this.bodyMass = [];
            this.bodyRadius = [];
            this.bodyHue = [];
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

            this.sceneConstants = [];
            for (let i = 0; i < SCENE_FLOATS; i++) {
                this.sceneConstants.push(0.0);
            }
            this.pathPipeline = null;
            this.straightPipeline = null;
            this.gridPipeline = null;
            this.bodyPipeline = null;
            this.skyPipeline = null;
            this.viewConstantsSize = 0;
            this.viewConstants = [];
            this.viewMatrix = [];
            this.projMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
                this.projMatrix.push(0.0);
            }
        }

        // The command line's settings, before init.
        configure(scene: int, gravity: number, lightSpeed: number, bending: int, emitter: int, showSky: boolean) {
            this.scene = scene;
            this.emitter = emitter;
            this.showSky = showSky;
            this.gravity = gravity;
            this.lightSpeed = lightSpeed;
            if (bending == Bending.None) {
                this.bendLight = false;
            } else {
                this.bending = bending;
            }
        }

        init() {
            const shaderFile = "gravity_light_bending.hlsl";
            const raysShader = this.app.createShaderWithDefine(shaderFile, "rays_cs", ShaderType.Compute, "RAYS", "1");
            this.pathVertexShader = this.app.createShader(shaderFile, "path_vs", ShaderType.Vertex);
            this.pathPixelShader = this.app.createShader(shaderFile, "path_ps", ShaderType.Pixel);
            this.straightVertexShader = this.app.createShader(shaderFile, "straight_vs", ShaderType.Vertex);
            this.gridVertexShader = this.app.createShader(shaderFile, "grid_vs", ShaderType.Vertex);
            this.colorPixelShader = this.app.createShader(shaderFile, "color_ps", ShaderType.Pixel);
            this.bodyVertexShader = this.app.createShader(shaderFile, "body_vs", ShaderType.Vertex);
            this.bodyPixelShader = this.app.createShader(shaderFile, "body_ps", ShaderType.Pixel);
            this.skyVertexShader = this.app.createShader(shaderFile, "sky_vs", ShaderType.Vertex);
            this.skyPixelShader = this.app.createShader(shaderFile, "sky_ps", ShaderType.Pixel);
            if (!raysShader || !this.pathVertexShader || !this.pathPixelShader || !this.straightVertexShader
                || !this.gridVertexShader || !this.colorPixelShader || !this.bodyVertexShader || !this.bodyPixelShader
                || !this.skyVertexShader || !this.skyPixelShader) {
                return false;
            }

            this.createBodies();

            // Static, written in the command list every frame: a volatile one runs out of versions in
            // -test's unthrottled frames on Vulkan.
            this.sceneBuffer = this.app.createConstantBuffer(SCENE_FLOATS * 4, "Scene");
            this.viewConstantsSize = ConstantSizes.planarView();
            for (let i = 0; i < this.viewConstantsSize / 4; i++) {
                this.viewConstants.push(0.0);
            }
            this.viewConstantBuffer = this.app.createConstantBuffer(this.viewConstantsSize, "ViewConstants");

            // The rays' paths, MAX_POINTS points each, and the rays.
            this.pointBuffer = this.app.createRWStructuredBuffer(16, MAX_RAYS * MAX_POINTS, "Ray points");
            this.rayBuffer = this.app.createRWStructuredBuffer(RAY_FLOATS * 4, MAX_RAYS, "Rays");

            const computeLayoutDesc = BindingLayoutDesc.create();
            computeLayoutDesc.layoutConstantBuffer(0);
            computeLayoutDesc.layoutStructuredBufferUAV(0);
            computeLayoutDesc.layoutStructuredBufferUAV(1);
            const computeBindingLayout = this.app.createBindingLayout(computeLayoutDesc, ShaderType.Compute);
            this.raysPipeline = this.app.createComputePipelineWithLayout(raysShader, computeBindingLayout);
            const computeSetDesc = BindingSetDesc.create();
            computeSetDesc.bindEntireConstantBuffer(0, this.sceneBuffer);
            computeSetDesc.bindStructuredBufferUAV(0, this.pointBuffer);
            computeSetDesc.bindStructuredBufferUAV(1, this.rayBuffer);
            this.computeBindingSet = this.app.createBindingSetForLayout(computeSetDesc, computeBindingLayout);

            // Drawing: the vertex shaders read the scene, the view and the rays, the paths' pixel
            // shader the scene and the view; the sky's pixel shader the scene and the view.
            const drawLayoutDesc = BindingLayoutDesc.create();
            drawLayoutDesc.layoutConstantBuffer(0);
            drawLayoutDesc.layoutConstantBuffer(1);
            drawLayoutDesc.layoutStructuredBufferSRV(0);
            drawLayoutDesc.layoutStructuredBufferSRV(1);
            // Every stage: path_ps reads the bodies and the camera too.
            this.drawBindingLayout = this.app.createBindingLayout(drawLayoutDesc, ShaderType.All);
            const drawSetDesc = BindingSetDesc.create();
            drawSetDesc.bindEntireConstantBuffer(0, this.sceneBuffer);
            drawSetDesc.bindEntireConstantBuffer(1, this.viewConstantBuffer);
            drawSetDesc.bindStructuredBufferSRV(0, this.pointBuffer);
            drawSetDesc.bindStructuredBufferSRV(1, this.rayBuffer);
            this.drawBindingSet = this.app.createBindingSetForLayout(drawSetDesc, this.drawBindingLayout);

            const skyLayoutDesc = BindingLayoutDesc.create();
            skyLayoutDesc.layoutConstantBuffer(0);
            skyLayoutDesc.layoutConstantBuffer(1);
            this.skyBindingLayout = this.app.createBindingLayout(skyLayoutDesc, ShaderType.Pixel);
            const skySetDesc = BindingSetDesc.create();
            skySetDesc.bindEntireConstantBuffer(0, this.sceneBuffer);
            skySetDesc.bindEntireConstantBuffer(1, this.viewConstantBuffer);
            this.skyBindingSet = this.app.createBindingSetForLayout(skySetDesc, this.skyBindingLayout);

            // A look-at camera over the XZ plane, where the bodies orbit and the sheet of rays lies.
            this.camera = this.app.createThirdPersonCamera();
            this.camera.thirdPersonSetTarget(0.0, 0.0, 0.0);
            this.camera.thirdPersonSetDistance(32.0);
            this.camera.thirdPersonSetRotation(radians(75.0), radians(40.0));
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

        onKey(key: Key, scancode: ScanCode, action: Action, mods: KeyMods) {
            this.idleSeconds = 0.0;
            this.camera.keyboardUpdate(key, scancode, action, mods);
            if (action == Action.Press) {
                if (key == Key.Space) {
                    this.paused = !this.paused;
                } else if (key == Key.L) {
                    this.bendLight = !this.bendLight;
                } else if (key == Key.K) {
                    this.showSky = !this.showSky;
                } else if (key == Key.G) {
                    this.showGrid = !this.showGrid;
                } else if (key == Key.B) {
                    this.showStraight = !this.showStraight;
                } else if (key == Key.R) {
                    this.restartRequested = true;
                }
            }
            return 1;
        }

        onMousePos(x: number, y: number) {
            // The mouse moving over the window isn't input for the camera, dragging is.
            if (this.buttonsDown > 0) {
                this.idleSeconds = 0.0;
            }
            this.camera.mousePosUpdate(x, y);
            return 1;
        }

        onMouseButton(button: MouseButton, action: Action, mods: KeyMods) {
            this.idleSeconds = 0.0;
            if (action == Action.Press) {
                this.buttonsDown++;
            } else if (action == Action.Release && this.buttonsDown > 0) {
                this.buttonsDown--;
            }
            this.camera.mouseButtonUpdate(button, action, mods);
            return 1;
        }

        onMouseScroll(xOffset: number, yOffset: number) {
            this.idleSeconds = 0.0;
            this.camera.mouseScrollUpdate(xOffset, yOffset);
            return 1;
        }

        onAnimate(elapsedSeconds: number) {
            if (this.restartRequested) {
                this.restartRequested = false;
                this.createBodies();
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
            this.app.setInformativeWindowTitleWithInfo(WINDOW_TITLE, this.paused ? `${info} (paused)` : info);
        }

        onBackBufferResizing() {
            const pathPipeline = this.pathPipeline;
            if (pathPipeline) {
                this.app.releaseResource(pathPipeline);
                this.pathPipeline = null;
            }
            const straightPipeline = this.straightPipeline;
            if (straightPipeline) {
                this.app.releaseResource(straightPipeline);
                this.straightPipeline = null;
            }
            const gridPipeline = this.gridPipeline;
            if (gridPipeline) {
                this.app.releaseResource(gridPipeline);
                this.gridPipeline = null;
            }
            const bodyPipeline = this.bodyPipeline;
            if (bodyPipeline) {
                this.app.releaseResource(bodyPipeline);
                this.bodyPipeline = null;
            }
            const skyPipeline = this.skyPipeline;
            if (skyPipeline) {
                this.app.releaseResource(skyPipeline);
                this.skyPipeline = null;
            }
        }

        // The rays the emitter sends: a sheet is one row of them.
        rayCount(): int {
            return this.emitter == Emitter.Sheet ? this.raysAcross : this.raysAcross * this.rayRows;
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            this.frameWidth = width;
            const commandList = frame.getCommandList();

            let pathPipeline = this.pathPipeline;
            if (!pathPipeline) {
                pathPipeline = this.app.createGraphicsPipelineWithBlend(frame, this.pathVertexShader, this.pathPixelShader,
                    null, this.drawBindingLayout, PrimitiveType.TriangleList, BlendMode.Additive);
                this.pathPipeline = pathPipeline;
            }
            let straightPipeline = this.straightPipeline;
            if (!straightPipeline) {
                straightPipeline = this.app.createGraphicsPipelineWithBlend(frame, this.straightVertexShader, this.colorPixelShader,
                    null, this.drawBindingLayout, PrimitiveType.TriangleList, BlendMode.Additive);
                this.straightPipeline = straightPipeline;
            }
            let gridPipeline = this.gridPipeline;
            if (!gridPipeline) {
                gridPipeline = this.app.createGraphicsPipelineWithBlend(frame, this.gridVertexShader, this.colorPixelShader,
                    null, this.drawBindingLayout, PrimitiveType.TriangleList, BlendMode.AlphaBlend);
                this.gridPipeline = gridPipeline;
            }
            let bodyPipeline = this.bodyPipeline;
            if (!bodyPipeline) {
                bodyPipeline = this.app.createGraphicsPipelineWithBlend(frame, this.bodyVertexShader, this.bodyPixelShader,
                    null, this.drawBindingLayout, PrimitiveType.TriangleList, BlendMode.AlphaBlend);
                this.bodyPipeline = bodyPipeline;
            }
            let skyPipeline = this.skyPipeline;
            if (!skyPipeline) {
                skyPipeline = this.app.createGraphicsPipelineWithBlend(frame, this.skyVertexShader, this.skyPixelShader,
                    null, this.skyBindingLayout, PrimitiveType.TriangleList, BlendMode.None);
                this.skyPipeline = skyPipeline;
            }

            // The camera: 60 degrees vertically.
            this.camera.getWorldToView(Ref(this.viewMatrix[0]));
            const projection = perspProjD3DStyleReverse(radians(60.0), width / height, 0.1);
            for (let i = 0; i < 16; i++) {
                this.projMatrix[i] = projection[i];
            }
            this.view.setPlanarView(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);
            this.camera.thirdPersonSetView(this.view);
            this.view.fillPlanarViewConstants(Ref(this.viewConstants[0]));
            commandList.writeBuffer(this.viewConstantBuffer, Ref(this.viewConstants[0]), this.viewConstantsSize);

            this.fillSceneConstants();
            commandList.writeBuffer(this.sceneBuffer, Ref(this.sceneConstants[0]), SCENE_FLOATS * 4);

            // The rays through the bodies as they are now.
            const rays = this.rayCount();
            commandList.dispatch(this.raysPipeline, this.computeBindingSet,
                Math.floor((rays + RAYS_GROUP_SIZE - 1) / RAYS_GROUP_SIZE), 1, 1);

            // The lensed sky with the bodies in it, or a black background and the bodies drawn
            // over the rays.
            if (this.showSky) {
                frame.beginDraw(skyPipeline);
                frame.drawAddBindingSet(this.skyBindingSet);
                frame.drawVertices(3);
            } else {
                frame.clearColor(0.0, 0.0, 0.0, 1.0);
            }

            if (this.showGrid) {
                frame.beginDraw(gridPipeline);
                frame.drawAddBindingSet(this.drawBindingSet);
                frame.drawVertices(GRID_LINE_COUNT * VERTICES_PER_QUAD);
            }
            if (this.showStraight) {
                frame.beginDraw(straightPipeline);
                frame.drawAddBindingSet(this.drawBindingSet);
                frame.drawVertices(rays * VERTICES_PER_QUAD);
            }

            frame.beginDraw(pathPipeline);
            frame.drawAddBindingSet(this.drawBindingSet);
            frame.drawVertices(rays * (MAX_POINTS - 1) * VERTICES_PER_QUAD);

            // Over the lensed sky, only the black holes' horizons and photon spheres (body_vs).
            frame.beginDraw(bodyPipeline);
            frame.drawAddBindingSet(this.drawBindingSet);
            frame.drawVertices(this.bodyCount * VERTICES_PER_QUAD);
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

        // -test: checks the rays traced in the last frame. Every path is finite and has at least
        // two points. Without gravity, every point of a path lies on the line its ray started on.
        // No path goes into a body and out again. With one mass (-scene single), each ray passing it
        // turns by what the theory gives (expectedDeflection); a black hole, with the exact bending,
        // takes the rays coming closer than the critical impact parameter, and no others
        // (checkCapture). Otherwise, some ray turned. Then the frame: drawn.
        checkTest() {
            const check = new TestCheck(this.app);
            const rays = this.rayCount();
            const rayData = check.readFloats(this.rayBuffer, rays * RAY_FLOATS * 4);
            const points = check.readFloats(this.pointBuffer, rays * MAX_POINTS * 16);
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
            return check.drawn(0x000000, 10000, "Frame");
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

        // --- UI -----------------------------------------------------------------------------

        buildUI() {
            ImGui.setNextWindowPosPivot(this.frameWidth - 10.0, 10.0, 1.0, 0.0);
            ImGui.begin("Gravity Light Bending", true);
            ImGui.pushItemWidth(180.0);

            if (ImGui.collapsingHeaderDefaultOpen("Light")) {
                this.bendLight = ImGui.checkbox("Gravity bends light (L)", this.bendLight);
                if (this.bendLight) {
                    this.bending = ImGui.combo("Bending", this.bending, BENDINGS);
                }
                this.lightSpeed = ImGui.sliderFloat("Speed of light c (u/s)", this.lightSpeed, LIGHT_SPEED_MIN, LIGHT_SPEED_MAX);
                this.emitter = ImGui.combo("Emitter", this.emitter, EMITTERS);
                this.raysAcross = ImGui.sliderInt(this.emitter == Emitter.Sheet ? "Rays" : "Rays across", this.raysAcross, 1, MAX_RAYS_ACROSS);
                if (this.emitter != Emitter.Sheet) {
                    this.rayRows = ImGui.sliderInt("Rows", this.rayRows, 1, MAX_RAYS_ACROSS);
                }
                if (this.emitter == Emitter.Cone) {
                    this.coneAngle = ImGui.sliderFloat("Cone half angle (deg)", this.coneAngle, 0.0, 89.0);
                } else if (this.emitter != Emitter.Sphere) {
                    this.beamHalfWidth = ImGui.sliderFloat("Beam half width (u)", this.beamHalfWidth, 0.0, 30.0);
                }
                this.emitterYaw = ImGui.sliderFloat("Direction yaw (deg)", this.emitterYaw, -180.0, 180.0);
                this.emitterPitch = ImGui.sliderFloat("Direction pitch (deg)", this.emitterPitch, -85.0, 85.0);
                this.emitterDistance = ImGui.sliderFloat("Emitter distance (u)", this.emitterDistance, 0.0, 60.0);
                this.emitterOffsetRight = ImGui.sliderFloat("Emitter offset right (u)", this.emitterOffsetRight, -20.0, 20.0);
                this.emitterOffsetUp = ImGui.sliderFloat("Emitter offset up (u)", this.emitterOffsetUp, -20.0, 20.0);
                this.rayLength = ImGui.sliderFloat("Ray length (u)", this.rayLength, 1.0, RAY_LENGTH_MAX);
            }

            if (ImGui.collapsingHeaderDefaultOpen("Simulation")) {
                this.paused = ImGui.checkbox("Paused (Space)", this.paused);
                this.timeScale = ImGui.sliderFloat("Time scale", this.timeScale, 0.0, 4.0);
                this.gravity = ImGui.sliderFloat("Gravity G", this.gravity, 0.0, 4.0);
                this.scene = ImGui.combo("Scene", this.scene, SCENES);
                if (this.scene == Scene.Cluster) {
                    this.clusterBodies = ImGui.sliderInt("Bodies", this.clusterBodies, 1, MAX_BODIES);
                }
                if (ImGui.button("Restart (R)")) {
                    this.restartRequested = true;
                }
            }

            if (ImGui.collapsingHeaderDefaultOpen("Display")) {
                this.showSky = ImGui.checkbox("Lensed sky (K)", this.showSky);
                this.showGrid = ImGui.checkbox("Grid (G)", this.showGrid);
                this.showStraight = ImGui.checkbox("Straight lines to compare (B)", this.showStraight);
                this.showPulses = ImGui.checkbox("Light pulses", this.showPulses);
                this.autoRotate = ImGui.checkbox("Orbit when idle", this.autoRotate);
            }

            if (ImGui.collapsingHeader("Units")) {
                ImGui.text("u: scene unit; the grid's lines are 2 u apart");
                ImGui.text("Gravity: a = G m / r^2; the rays are traced through it");
                ImGui.text("  as the bodies are, the light's travel time left out");
                ImGui.text("A ray passing a mass m at distance b turns by");
                ImGui.text("  2 G m / (c^2 b) as a Newtonian particle at c,");
                ImGui.text("  4 G m / (c^2 b) in general relativity");
                ImGui.text("Schwarzschild radius r_s = 2 G m / c^2: a body");
                ImGui.text("  inside its own is a black hole; light circles it");
                ImGui.text("  at 1.5 r_s (the exact mode), and takes every ray");
                ImGui.text("  aimed within 2.6 r_s of it");
                ImGui.text("Black hole: orange ring = horizon, dashed = photon");
                ImGui.text("  sphere; the dark disk in the sky is its shadow");
                ImGui.text("The pulses run at c times the time scale");
            }

            ImGui.popItemWidth();
            ImGui.end();
        }
    }

    class LightBendingArgs extends Args {
        // -scene <planets|binary|eight|blackhole|single|cluster>: the bodies (a star and planets
        // by default).
        scene = Scene.StarAndPlanets;
        // -gravity <G>: the gravitational constant (1 by default; 0: no gravity, the rays straight).
        gravity = DEFAULT_GRAVITY;
        // -c <speed>: the speed of light (15 by default).
        lightSpeed = DEFAULT_LIGHT_SPEED;
        // -bending <0..3>: Newtonian, weak field, Schwarzschild (the default), none.
        bending = Bending.Schwarzschild;
        // -emitter <0..3>: a sheet of parallel rays (the default), a beam, a cone, a point.
        emitter = Emitter.Sheet;
        // -nosky: a black background and the bodies drawn over the rays, not the lensed sky (which
        // traces every pixel: the costly part on a slow GPU).
        noSky = false;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-scene" && i + 1 < this.argc) {
                    const name = this[i + 1];
                    if (name == "planets") {
                        this.scene = Scene.StarAndPlanets;
                    } else if (name == "binary") {
                        this.scene = Scene.Binary;
                    } else if (name == "eight") {
                        this.scene = Scene.FigureEight;
                    } else if (name == "blackhole") {
                        this.scene = Scene.BlackHole;
                    } else if (name == "single") {
                        this.scene = Scene.Single;
                    } else if (name == "cluster") {
                        this.scene = Scene.Cluster;
                    }
                    i++;
                } else if (arg == "-gravity" && i + 1 < this.argc) {
                    this.gravity = parseFloat(this[i + 1]);
                    i++;
                } else if (arg == "-c" && i + 1 < this.argc) {
                    this.lightSpeed = parseFloat(this[i + 1]);
                    i++;
                } else if (arg == "-bending" && i + 1 < this.argc) {
                    this.bending = parseInt(this[i + 1]);
                    i++;
                } else if (arg == "-nosky") {
                    this.noSky = true;
                } else if (arg == "-emitter" && i + 1 < this.argc) {
                    this.emitter = parseInt(this[i + 1]);
                    i++;
                }
            }
            if (this.lightSpeed < LIGHT_SPEED_MIN) {
                this.lightSpeed = LIGHT_SPEED_MIN;
            }
            if (this.bending < 0 || this.bending > Bending.None) {
                this.bending = Bending.Schwarzschild;
            }
            if (this.emitter < 0 || this.emitter > Emitter.Sphere) {
                this.emitter = Emitter.Sheet;
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Program.setAppName("gravity_light_bending");

        // -test [-testOutput <file>]: render TEST_FRAMES frames without a window and check the rays
        // and the last frame (see checkTest).
        const args = new LightBendingArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const lightBending = new LightBendingPass(app, !args.test, !args.noUI);
        lightBending.configure(args.scene, args.gravity, args.lightSpeed, args.bending, args.emitter, !args.noSky);
        if (!lightBending.init()) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(lightBending.checkTest());
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return GravityLightBending.main(argc, argv);
}

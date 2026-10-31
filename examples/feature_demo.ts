// Imported only for its declarations: input_pass.ts brings in donut.ts (the class wrappers over
// donut_interop.d.ts), whose code every example links from its object. Referencing donut.ts here
// would compile that code into this object too, defining its symbols twice.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck } from "../core/test_check";
import { formatFixed } from "../core/text_format";
import { radiansF32 } from "../core/matrix";
import { RtxptGame, GameWorld } from "../core/rtxpt_game";

namespace FeatureDemoExample {
    // Test mode: the frames rendered once the scene has loaded. The scene loads on a thread, slower
    // under a parallel ctest: the test renders splash screens until then, up to TEST_FRAMES_MAX
    // frames in all, each waiting TEST_LOADING_WAIT_MS for the thread.
    const TEST_FRAMES = 120;
    const TEST_FRAMES_MAX = 20000;
    const TEST_LOADING_WAIT_MS = 1;

    // -test: checks the last frame: Donut's renderer draws Sponza and its character all over it,
    // about 11% colored, the blue banners about 4%.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        const lit = check.share(total - check.countInRange(0, 20, 0, 20, 0, 20, 0, 0, check.width, check.height), total,
            95.0, 100.0, "Lit");
        if (lit != "") {
            return lit;
        }
        const colored = check.share(check.countSpread(61, false, 0, 0, 0, check.width, check.height), total,
            6.0, 18.0, "Colored");
        if (colored != "") {
            return colored;
        }
        return check.share(check.countInRange(0, 89, 0, 119, 121, 255, 0, 0, check.width, check.height), total,
            2.0, 6.0, "Blue");
    }

    // The SkyParameters colors the UI doesn't edit (donut::render::SkyParameters defaults), for the
    // ambient term.
    const SKY_COLOR_R = 0.17;
    const SKY_COLOR_G = 0.37;
    const SKY_COLOR_B = 0.65;
    const GROUND_COLOR_R = 0.62;
    const GROUND_COLOR_G = 0.59;
    const GROUND_COLOR_B = 0.55;

    // Loaded at startup unless a scene is given on the command line.
    const DEFAULT_SCENE = "sponza-plus.scene.json";

    // Stencil bit the G-buffer pass sets where it writes motion vectors, for TAA.
    const MOTION_VECTOR_STENCIL_MASK = 0x01;

    let g_PrintSceneGraph = false;
    let g_PrintFormats = false;
    // Not in the C++ sample: -screenshot <file> saves a frame of the loaded scene and exits, for
    // checking the port without a person at the window.
    let g_ScreenshotPath = "";
    const SCREENSHOT_FRAME = 120;
    // Not in the C++ sample: -propShowTags <tags>, -propCameraAttach <prop>: RTXPT's SampleGame's (see sceneLoaded).
    let g_PropShowTags = "";
    let g_PropCameraAttach = "";

    // RTXPT's Scene::GetGameSettingsNode: whether the scene file's graph has a node of type `type`.
    function hasNodeOfType(json: JsonDocument, type: string): boolean {
        // The node arrays to search: "graph", then the nodes' "children".
        const arrays = ["graph"];
        for (let a = 0; a < arrays.length; a++) {
            const count = json.jsonGetSize(arrays[a]);
            for (let i = 0; i < count; i++) {
                const node = `${arrays[a]}/${i}`;
                if (json.jsonGetString(`${node}/type`, "") == type) {
                    return true;
                }
                arrays.push(`${node}/children`);
            }
        }
        return false;
    }

    // The folder of a file's path (without the separator).
    function folderOf(path: string): string {
        const slash = path.lastIndexOf("/");
        const backslash = path.lastIndexOf("\\");
        const end = slash > backslash ? slash : backslash;
        return end < 0 ? "." : path.substring(0, end);
    }

    enum AntiAliasingMode {
        NONE = 0,
        TEMPORAL = 1,
        DLSS = 2,
        MSAA_2X = 3,
        MSAA_4X = 4,
        MSAA_8X = 5
    }

    // --- Math ---------------------------------------------------------------------------------

    // math::perspProjD3DStyleReverse(verticalFOV, aspect, zNear): reverse-Z, infinite far plane;
    // row-major, row-vector convention, into 16 floats.
    // In float32 as Donut's (computed in double, the scales differ in the last bit, which moves
    // edges by a pixel here and there).
    function perspProjD3DStyleReverse(dst: f32[], verticalFOV: number, aspect: number, zNear: number) {
        const yScale = Math.fround(1.0 / Math.fround(Math.tan(Math.fround(0.5 * Math.fround(verticalFOV)))));
        const xScale = Math.fround(yScale / Math.fround(aspect));
        for (let i = 0; i < 16; i++) {
            dst[i] = 0.0;
        }
        dst[0] = xScale;
        dst[5] = yScale;
        dst[11] = 1.0;
        dst[14] = zNear;
    }

    // --- UI state ---------------------------------------------------------------------------

    // The settings the UI edits, shared by the renderer and the UI (the sample's UIData).
    class UIData {
        public showUI: boolean;
        public showConsole: boolean;
        public useDeferredShading: boolean;
        public stereo: boolean;
        public enableSsao: boolean;
        public enableHistoryClamping: boolean;
        public skyBrightness: number;
        public skyGlowSize: number;
        public skyGlowSharpness: number;
        public skyGlowIntensity: number;
        public skyHorizonSize: number;
        public antiAliasingMode: int;
        public temporalAntiAliasingJitter: int;
        public enableVsync: boolean;
        public shaderReloadRequested: boolean;
        public enableProceduralSky: boolean;
        public enableBloom: boolean;
        public dlssAvailable: boolean;
        // DLSS 5 (DLSS 3D-Guided Neural Rendering) over the tone-mapped image: not in the C++ sample.
        public enableDlssNeuralRendering: boolean;
        public dlssNeuralRenderingAvailable: boolean;
        public dlssNeuralRenderingModel: int;
        public dlssNeuralRenderingIntensity: number;
        public dlssNeuralRenderingStructureStrength: number;
        public dlssNeuralRenderingToneStrength: number;
        public dlssNeuralRenderingUseAutoMask: boolean;
        public dlssNeuralRenderingSkinStrength: number;
        public bloomSigma: number;
        public bloomAlpha: number;
        public enableTranslucency: boolean;
        public enableMaterialEvents: boolean;
        public enableShadows: boolean;
        public ambientIntensity: number;
        public enableLightProbe: boolean;
        public lightProbeDiffuseScale: number;
        public lightProbeSpecularScale: number;
        public csmExponent: number;
        public displayShadowMap: boolean;
        public useThirdPersonCamera: boolean;
        public enableAnimations: boolean;
        public testMipMapGen: boolean;
        // Handles into the current scene; cleared when it unloads (the C++ sample's shared_ptrs keep
        // the old objects alive instead).
        public selectedMaterial: Material;
        public selectedNode: Node;
        public selectedLight: Light;
        public activeSceneCamera: SceneCamera;
        public screenshotFileName: string;

        constructor() {
            this.showUI = true;
            this.showConsole = false;
            this.useDeferredShading = true;
            this.stereo = false;
            this.enableSsao = true;
            this.enableHistoryClamping = true;
            this.skyBrightness = 0.1;
            this.skyGlowSize = 5.0;
            this.skyGlowSharpness = 4.0;
            this.skyGlowIntensity = 0.1;
            this.skyHorizonSize = 30.0;
            this.antiAliasingMode = AntiAliasingMode.TEMPORAL;
            this.temporalAntiAliasingJitter = TemporalJitter.MSAA;
            this.enableVsync = true;
            this.shaderReloadRequested = false;
            this.enableProceduralSky = true;
            this.enableBloom = true;
            // Set once DLSS initializes (built with DONUT_WITH_DLSS=ON, on an RTX GPU).
            this.dlssAvailable = false;
            // RTX Remix's defaults (rtx.dlssNeuralRendering.*). Available once DLSS-NR initializes (built
            // with DONUT_WITH_DLSS=ON, on Vulkan or D3D12, and an RTX GPU).
            this.enableDlssNeuralRendering = false;
            this.dlssNeuralRenderingAvailable = false;
            this.dlssNeuralRenderingModel = 0;
            this.dlssNeuralRenderingIntensity = 1.0;
            this.dlssNeuralRenderingStructureStrength = 0.7;
            this.dlssNeuralRenderingToneStrength = 0.3;
            this.dlssNeuralRenderingUseAutoMask = true;
            this.dlssNeuralRenderingSkinStrength = 0.5;
            this.bloomSigma = 32.0;
            this.bloomAlpha = 0.05;
            this.enableTranslucency = true;
            this.enableMaterialEvents = false;
            this.enableShadows = true;
            this.ambientIntensity = 1.0;
            this.enableLightProbe = true;
            this.lightProbeDiffuseScale = 1.0;
            this.lightProbeSpecularScale = 1.0;
            this.csmExponent = 4.0;
            this.displayShadowMap = false;
            this.useThirdPersonCamera = false;
            this.enableAnimations = false;
            this.testMipMapGen = false;
            this.selectedMaterial = new Material(null);
            this.selectedNode = new Node(null);
            this.selectedLight = new Light(null);
            this.activeSceneCamera = new SceneCamera(null);
            this.screenshotFileName = "";
        }
    }

    // --- Renderer ---------------------------------------------------------------------------

    // Port of Donut-Samples' FeatureDemo.cpp (the FeatureDemo class): loads a scene on a thread and
    // renders it with Donut's passes, as the UI configures them.
    class FeatureDemo {
        private app: App;
        private ui: UIData;

        public sceneFilesAvailable: StringList;
        public currentSceneName: string;
        public sceneDir: string;
        public sceneLoader: SceneLoader;
        // The loaded scene and its graph; null handles until the first one has loaded.
        public scene: Scene;
        public sceneGraph: SceneGraph;
        private sunLight: Light;
        private shadowMap: ShadowMap;
        private shadowDepthPass: DepthPass;
        private renderTargets: SceneRenderTargets;
        private renderTargetsWidth: int;
        private renderTargetsHeight: int;
        private renderTargetsSampleCount: int;
        private forwardPass: ForwardShadingPass;
        private forwardContext: ForwardShadingContextHandle;
        private gbufferPass: GBufferFillPass;
        private deferredLightingPass: DeferredLightingPass;
        private skyPass: SkyPassHandle | null;
        private temporalAntiAliasingPass: TemporalAntiAliasingPass;
        // A null handle without DLSS support.
        private dlss: Dlss;
        // A null handle without DLSS-NR support; whether it ran last frame (else it resets).
        private dlssNeuralRendering: DlssNeuralRendering;
        private dlssNeuralRenderingActive: boolean;
        private bloomPass: BloomPassHandle | null;
        private toneMappingPass: ToneMappingPass;
        private ssaoPass: SsaoPassHandle | null;
        private lightProbePass: LightProbeProcessingPass;
        private materialIdPass: MaterialIdPassHandle | null;
        private pixelReadbackPass: PixelReadbackPass;
        private mipMapGenPass: MipMapGenPassHandle | null;

        // The views of this frame and the previous one (swapped every frame), planar or stereo.
        private view: View;
        private viewPrevious: View;
        private viewIsStereo: boolean;

        private previousViewsValid: boolean;
        private firstPersonCamera: Camera;
        private thirdPersonCamera: Camera;

        private cameraVerticalFov: number;
        private ambientTop: number[];
        private ambientBottom: number[];
        private pickX: int;
        private pickY: int;
        private pick: boolean;

        public lightProbes: LightProbeSet;

        // RTXPT's SampleGame (core/rtxpt_game.ts), with a camera of its own; inactive without a GameSettings node.
        public game: RtxptGame;

        private wallclockTime: number;
        // Frames rendered with a loaded scene, for -screenshot and -test.
        private readyFrames: int;
        private testMode: boolean;

        // Storage passed to C++ by Ref: matrices (16 floats), vectors, box bounds, a readback pixel.
        private viewMatrix: f32[];
        private rightViewMatrix: f32[];
        private projMatrix: f32[];
        private vector1: f32[];
        private vector2: f32[];
        private vector3: f32[];
        private bounds: f32[];
        private pixel: int[];

        constructor(app: App, ui: UIData) {
            this.app = app;
            this.ui = ui;
            this.currentSceneName = "";
            this.sceneDir = "";
            this.scene = new Scene(null);
            this.sceneGraph = new SceneGraph(null);
            this.sunLight = new Light(null);
            this.renderTargets = new SceneRenderTargets(null);
            this.renderTargetsWidth = 0;
            this.renderTargetsHeight = 0;
            this.renderTargetsSampleCount = 0;
            this.forwardPass = new ForwardShadingPass(null);
            this.gbufferPass = new GBufferFillPass(null);
            this.deferredLightingPass = new DeferredLightingPass(null);
            this.skyPass = null;
            this.temporalAntiAliasingPass = new TemporalAntiAliasingPass(null);
            this.dlss = new Dlss(null);
            this.dlssNeuralRendering = new DlssNeuralRendering(null);
            this.dlssNeuralRenderingActive = false;
            this.bloomPass = null;
            this.toneMappingPass = new ToneMappingPass(null);
            this.ssaoPass = null;
            this.lightProbePass = new LightProbeProcessingPass(null);
            this.materialIdPass = null;
            this.pixelReadbackPass = new PixelReadbackPass(null);
            this.mipMapGenPass = null;
            this.view = new View(null);
            this.viewPrevious = new View(null);
            this.viewIsStereo = false;
            this.previousViewsValid = false;
            this.cameraVerticalFov = 60.0;
            this.ambientTop = [0.0, 0.0, 0.0];
            this.ambientBottom = [0.0, 0.0, 0.0];
            this.pickX = 0;
            this.pickY = 0;
            this.pick = false;
            this.wallclockTime = 0.0;
            this.readyFrames = 0;
            this.testMode = app.isTestMode();

            this.viewMatrix = [];
            this.rightViewMatrix = [];
            this.projMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
                this.rightViewMatrix.push(0.0);
                this.projMatrix.push(0.0);
            }
            this.vector1 = [];
            this.vector2 = [];
            this.vector3 = [];
            for (let i = 0; i < 3; i++) {
                this.vector1.push(0.0);
                this.vector2.push(0.0);
                this.vector3.push(0.0);
            }
            this.bounds = [];
            for (let i = 0; i < 6; i++) {
                this.bounds.push(0.0);
            }
            this.pixel = [];
            for (let i = 0; i < 4; i++) {
                this.pixel.push(0);
            }
        }

        init(sceneName: string) {
            const app = this.app;

            // The whole media folder (the C++ sample lists media/glTF-Sample-Assets/Models only), so
            // that the default scene, media/sponza-plus.scene.json, is in the list too.
            this.sceneDir = `${Program.getExecutableDirectory()}/media/`;
            this.sceneFilesAvailable = app.findScenes(this.sceneDir);

            const sceneCount = this.sceneFilesAvailable.getCount();
            if (sceneName == "" && sceneCount == 0) {
                console.log(`No scene file found in media folder '${this.sceneDir}'`);
                console.log("Please make sure that folder contains valid scene files.");
                return false;
            }

            this.shadowMap = app.createCascadedShadowMap(2048, 4);
            this.shadowDepthPass = app.createShadowDepthPass(100, 4.0);

            this.forwardContext = app.createForwardShadingContext();

            this.firstPersonCamera = app.createFirstPersonCamera();
            this.thirdPersonCamera = app.createThirdPersonCamera();
            this.firstPersonCamera.setMoveSpeed(3.0);
            this.thirdPersonCamera.setMoveSpeed(3.0);
            this.game = new RtxptGame(app.createFirstPersonCamera());

            this.sceneLoader = app.createSceneLoader();

            // DLSS doesn't need to be re-created when shaders reload, so it's created here and not in
            // createRenderPasses().
            this.dlss = app.createDlss();
            this.dlssNeuralRendering = app.createDlssNeuralRendering(this.dlss);

            this.lightProbes = app.createLightProbeSet(4);

            if (sceneName == "") {
                // app::FindPreferredScene(available, DEFAULT_SCENE): Sponza with two dancing
                // BrainStem robots, as in rt_bindless (the C++ sample prefers Sponza.gltf).
                let preferred = this.sceneFilesAvailable.getItem(0);
                for (let i = 0; i < sceneCount; i++) {
                    const scene = this.sceneFilesAvailable.getItem(i);
                    if (scene.indexOf(DEFAULT_SCENE) >= 0) {
                        preferred = scene;
                        break;
                    }
                }
                this.setCurrentSceneName(preferred);
            } else {
                this.setCurrentSceneName(sceneName);
            }

            const pass = app.addPass();
            pass.setKeyboardCallback(this.onKeyboard);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setMouseScrollCallback(this.onMouseScroll);
            pass.setAnimateCallback(this.onAnimate);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        getActiveCamera() {
            return this.ui.useThirdPersonCamera ? this.thirdPersonCamera : this.firstPersonCamera;
        }

        // Loads the node's world-space bounds into this.bounds.
        loadBounds(node: Node) {
            node.getBoundingBox(Ref(this.bounds[0]));
        }

        boundsDiagonalLength() {
            const dx = this.bounds[3] - this.bounds[0];
            const dy = this.bounds[4] - this.bounds[1];
            const dz = this.bounds[5] - this.bounds[2];
            return Math.sqrt(dx * dx + dy * dy + dz * dz);
        }

        sceneUnloading() {
            const forwardPass = this.forwardPass;
            if (!forwardPass.isNull()) {
                forwardPass.resetBindingCache();
            }
            const deferredLightingPass = this.deferredLightingPass;
            if (!deferredLightingPass.isNull()) {
                deferredLightingPass.resetBindingCache();
            }
            const gbufferPass = this.gbufferPass;
            if (!gbufferPass.isNull()) {
                gbufferPass.resetBindingCache();
            }
            const lightProbePass = this.lightProbePass;
            if (!lightProbePass.isNull()) {
                lightProbePass.resetCaches();
            }
            this.shadowDepthPass.resetBindingCache();
            this.app.clearBindingCache();
            this.sunLight = new Light(null);
            this.ui.selectedMaterial = new Material(null);
            this.ui.selectedNode = new Node(null);
            this.ui.selectedLight = new Light(null);
            this.ui.activeSceneCamera = new SceneCamera(null);

            const probeCount = this.lightProbes.getCount();
            for (let i = 0; i < probeCount; i++) {
                this.lightProbes.setEnabled(i, false);
            }
        }

        setCurrentSceneName(sceneName: string) {
            if (this.currentSceneName == sceneName) {
                return;
            }

            this.currentSceneName = sceneName;

            // BeginLoadingScene
            if (this.sceneLoader.isSceneLoaded()) {
                this.sceneUnloading();
            }
            this.game.deinitialize();
            this.scene = new Scene(null);
            this.sceneGraph = new SceneGraph(null);
            this.sceneLoader.beginLoadingScene(sceneName);
        }

        copyActiveCameraToFirstPerson() {
            const sceneCamera = this.ui.activeSceneCamera;
            if (!sceneCamera.isNull()) {
                // Rows of the view-to-world matrix: 1 = up, 2 = forward, 3 = the position.
                sceneCamera.getViewToWorld(Ref(this.viewMatrix[0]));
                const m = this.viewMatrix;
                this.firstPersonCamera.lookAtWithUp(m[12], m[13], m[14],
                    m[12] + m[8], m[13] + m[9], m[14] + m[10], m[4], m[5], m[6]);
            } else if (this.ui.useThirdPersonCamera) {
                this.thirdPersonCamera.getPosition(Ref(this.vector1[0]));
                this.thirdPersonCamera.getDirection(Ref(this.vector2[0]));
                this.thirdPersonCamera.getUp(Ref(this.vector3[0]));
                const p = this.vector1;
                const d = this.vector2;
                const u = this.vector3;
                this.firstPersonCamera.lookAtWithUp(p[0], p[1], p[2],
                    p[0] + d[0], p[1] + d[1], p[2] + d[2], u[0], u[1], u[2]);
            }
        }

        pointThirdPersonCameraAt(node: Node) {
            this.loadBounds(node);
            const b = this.bounds;
            this.thirdPersonCamera.thirdPersonSetTarget(
                (b[0] + b[3]) * 0.5, (b[1] + b[4]) * 0.5, (b[2] + b[5]) * 0.5);
            const radius = this.boundsDiagonalLength() * 0.5;
            const distance = radius / Math.sin(radiansF32(this.cameraVerticalFov * 0.5));
            this.thirdPersonCamera.thirdPersonSetDistance(distance);
            this.thirdPersonCamera.animate(0.0);
        }

        sceneLoaded() {
            const scene = this.sceneLoader.getLoadedScene();
            const sceneGraph = scene.getSceneGraph();
            this.scene = scene;
            this.sceneGraph = sceneGraph;

            this.wallclockTime = 0.0;
            this.previousViewsValid = false;

            const lightCount = sceneGraph.getLightCount();
            for (let i = 0; i < lightCount; i++) {
                const light = sceneGraph.getLight(i);
                if (light.getType() == LightType.Directional) {
                    this.sunLight = light;
                    if (light.getDirectionalIrradiance() <= 0.0) {
                        light.setDirectionalIrradiance(1.0);
                    }
                    break;
                }
            }

            if (this.sunLight.isNull()) {
                this.sunLight = sceneGraph.addDirectionalLight(sceneGraph.getRootNode(), "Sun",
                    0.1, -0.9, 0.1, 0.53, 1.0);
            }

            if (sceneGraph.getCameraCount() > 0) {
                this.ui.activeSceneCamera = sceneGraph.getCamera(0);
            } else {
                this.ui.activeSceneCamera = new SceneCamera(null);

                this.firstPersonCamera.lookAt(0.0, 1.8, 0.0, 1.0, 1.8, 0.0);
                this.cameraVerticalFov = 60.0;
            }

            this.thirdPersonCamera.thirdPersonSetRotation(radiansF32(135.0), radiansF32(20.0));
            this.pointThirdPersonCameraAt(sceneGraph.getRootNode());

            this.ui.useThirdPersonCamera = this.currentSceneName.endsWith(".gltf") || this.currentSceneName.endsWith(".glb");

            this.copyActiveCameraToFirstPerson();

            // RTXPT's SampleGame, in a scene with its GameSettings node: the props of
            // <scene folder>/SampleGame/<scene file name>, placed in the loaded scene. Donut's spot lights have
            // no minimum falloff past the outer angle (RTXPT's negative one).
            const world = new GameWorld(this.app.handle, scene.handle, this.hasGameSettingsNode(), false);
            this.game.sceneLoaded(world, this.currentSceneName, folderOf(this.currentSceneName), g_PropShowTags,
                g_PropCameraAttach);
            if (this.game.initialized) {
                // The game's world only moves with the animations (on in RTXPT).
                this.ui.enableAnimations = true;
            }

            if (g_PrintSceneGraph) {
                sceneGraph.print();
            }
        }

        hasGameSettingsNode(): boolean {
            if (!this.currentSceneName.endsWith(".json")) {
                return false;
            }
            const json = this.app.loadJsonDocument(this.currentSceneName);
            if (json.isNull()) {
                return false;
            }
            const found = hasNodeOfType(json, "GameSettings");
            this.app.releaseObject(json.handle);
            return found;
        }

        releaseViews() {
            const view = this.view;
            if (!view.isNull()) {
                this.app.releaseObject(view.handle);
                this.view = new View(null);
            }
            const viewPrevious = this.viewPrevious;
            if (!viewPrevious.isNull()) {
                this.app.releaseObject(viewPrevious.handle);
                this.viewPrevious = new View(null);
            }
        }

        releaseObject(handle: ObjectHandle | null) {
            if (handle) {
                this.app.releaseObject(handle);
            }
        }

        // Sets up this.view for the frame; true if it had to be created (then so do the passes).
        setupView() {
            const width = this.renderTargetsWidth;
            const height = this.renderTargetsHeight;

            const temporalAntiAliasingPass = this.temporalAntiAliasingPass;
            if (!temporalAntiAliasingPass.isNull()) {
                temporalAntiAliasingPass.setJitter(this.ui.temporalAntiAliasingJitter);
            }

            let pixelOffsetX = 0.0;
            let pixelOffsetY = 0.0;
            if ((this.ui.antiAliasingMode == AntiAliasingMode.TEMPORAL || this.ui.antiAliasingMode == AntiAliasingMode.DLSS)
                && !temporalAntiAliasingPass.isNull()) {
                temporalAntiAliasingPass.getPixelOffset(Ref(this.vector1[0]));
                pixelOffsetX = this.vector1[0];
                pixelOffsetY = this.vector1[1];
            }

            let verticalFov = radiansF32(this.cameraVerticalFov);
            let zNear = 0.01;
            const sceneCamera = this.ui.activeSceneCamera;
            if (!sceneCamera.isNull()) {
                const cameraFov = sceneCamera.getVerticalFov();
                if (cameraFov >= 0.0) {
                    zNear = sceneCamera.getZNear();
                    verticalFov = cameraFov;
                }

                sceneCamera.getWorldToView(Ref(this.viewMatrix[0]));
            } else {
                this.getActiveCamera().getWorldToView(Ref(this.viewMatrix[0]));
            }

            let topologyChanged = false;

            if (this.ui.stereo) {
                if (this.view.isNull() || !this.viewIsStereo) {
                    this.releaseViews();
                    this.view = this.app.createStereoView();
                    this.viewPrevious = this.app.createStereoView();
                    this.viewIsStereo = true;
                    topologyChanged = true;
                }
                const view = this.view;

                perspProjD3DStyleReverse(this.projMatrix, verticalFov, width / height * 0.5, zNear);

                for (let i = 0; i < 16; i++) {
                    this.rightViewMatrix[i] = this.viewMatrix[i];
                }
                this.rightViewMatrix[12] -= 0.2;

                view.setStereoView(Ref(this.viewMatrix[0]), Ref(this.rightViewMatrix[0]), Ref(this.projMatrix[0]),
                    width, height, pixelOffsetX, pixelOffsetY);

                this.thirdPersonCamera.thirdPersonSetView(view.getStereoLeftView());

                if (topologyChanged) {
                    this.viewPrevious.copyStereoView(view);
                }
            } else {
                if (this.view.isNull() || this.viewIsStereo) {
                    this.releaseViews();
                    this.view = this.app.createPlanarView();
                    this.viewPrevious = this.app.createPlanarView();
                    this.viewIsStereo = false;
                    topologyChanged = true;
                }
                const view = this.view;

                perspProjD3DStyleReverse(this.projMatrix, verticalFov, width / height, zNear);

                view.setPlanarViewJittered(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height,
                    pixelOffsetX, pixelOffsetY);

                this.thirdPersonCamera.thirdPersonSetView(view);

                if (topologyChanged) {
                    this.viewPrevious.copyPlanarView(view);
                }
            }

            return topologyChanged;
        }

        // Returns whether the exposure needs resetting (the first time there's a tone mapping pass).
        createRenderPasses() {
            const app = this.app;
            const targets = this.renderTargets;
            const view = this.view;
            let exposureResetRequired = false;

            this.releaseObject(this.forwardPass.handle);
            this.releaseObject(this.gbufferPass.handle);
            this.releaseObject(this.materialIdPass);
            this.releaseObject(this.pixelReadbackPass.handle);
            this.releaseObject(this.mipMapGenPass);
            this.releaseObject(this.deferredLightingPass.handle);
            this.releaseObject(this.skyPass);
            this.releaseObject(this.temporalAntiAliasingPass.handle);
            this.releaseObject(this.ssaoPass);
            this.releaseObject(this.lightProbePass.handle);
            this.releaseObject(this.bloomPass);

            this.forwardPass = app.createForwardShadingPassWithOptions(0, 0);
            this.gbufferPass = app.createGBufferFillPassWithOptions(1, MOTION_VECTOR_STENCIL_MASK);
            this.materialIdPass = app.createMaterialIDPass(MOTION_VECTOR_STENCIL_MASK);

            this.pixelReadbackPass = app.createPixelReadbackPass(targets.getTexture(SceneTexture.MaterialIDs));
            this.mipMapGenPass = app.createMipMapGenPass(targets.getTexture(SceneTexture.ResolvedColor));

            this.deferredLightingPass = app.createDeferredLightingPass();

            this.skyPass = app.createSkyPass(targets.getFramebuffer(SceneFramebuffer.Forward), view);

            this.temporalAntiAliasingPass = app.createSceneTemporalAntiAliasingPass(view, targets, MOTION_VECTOR_STENCIL_MASK);

            // Multisampled targets have no SSAO (nor deferred shading).
            this.ssaoPass = this.renderTargetsSampleCount == 1 ? app.createSsaoPass(targets) : null;

            this.lightProbePass = app.createLightProbeProcessingPass();

            // The new tone mapping pass takes over the old one's exposure buffer.
            const previousToneMappingPass = this.toneMappingPass;
            if (previousToneMappingPass.isNull()) {
                exposureResetRequired = true;
            }
            this.toneMappingPass = app.createToneMappingPass(targets.getFramebuffer(SceneFramebuffer.Ldr),
                view, previousToneMappingPass);
            this.releaseObject(previousToneMappingPass.handle);

            this.bloomPass = app.createBloomPass(targets.getFramebuffer(SceneFramebuffer.Resolved), view);

            const dlss = this.dlss;
            if (!dlss.isNull()) {
                const width = this.renderTargetsWidth;
                const height = this.renderTargetsHeight;
                dlss.init(width, height, width, height, 0);

                this.ui.dlssAvailable = dlss.isInitialized();
            }

            const dlssNeuralRendering = this.dlssNeuralRendering;
            if (!dlssNeuralRendering.isNull()) {
                this.ui.dlssNeuralRenderingAvailable = dlssNeuralRendering.init(this.renderTargetsWidth, this.renderTargetsHeight) != 0;
            }

            this.previousViewsValid = false;
            return exposureResetRequired;
        }

        renderSplashScreen(frame: Frame) {
            frame.clearColor(0.0, 0.0, 0.0, 0.0);
            this.app.setVsyncEnabled(true);
        }

        // After the frame's commands have been submitted: finds what the right mouse button clicked.
        finishPick() {
            const sceneGraph = this.sceneGraph;
            this.pixelReadbackPass.readPixelUInts(Ref(this.pixel[0]));
            this.ui.selectedMaterial = new Material(null);
            this.ui.selectedNode = new Node(null);

            const materialCount = sceneGraph.getMaterialCount();
            for (let i = 0; i < materialCount; i++) {
                const material = sceneGraph.getMaterial(i);
                if (material.getID() == this.pixel[0]) {
                    this.ui.selectedMaterial = material;
                    break;
                }
            }

            const instanceCount = sceneGraph.getMeshInstanceCount();
            for (let i = 0; i < instanceCount; i++) {
                if (sceneGraph.getMeshInstanceIndex(i) == this.pixel[1]) {
                    this.ui.selectedNode = sceneGraph.getMeshInstanceNode(i);
                    break;
                }
            }

            const selectedNode = this.ui.selectedNode;
            if (!selectedNode.isNull()) {
                console.log(`Picked node: ${selectedNode.getPath()}`);
                this.pointThirdPersonCameraAt(selectedNode);
            } else {
                this.pointThirdPersonCameraAt(sceneGraph.getRootNode());
            }
        }

        renderScene(frame: Frame) {
            const app = this.app;
            const ui = this.ui;
            const scene = this.scene;
            const sceneGraph = this.sceneGraph;
            const windowWidth = app.getWindowWidth();
            const windowHeight = app.getWindowHeight();

            // RefreshSceneGraph and RefreshBuffers.
            app.refreshScene(frame, scene);

            let exposureResetRequired = false;

            {
                let sampleCount = 1;
                if (ui.antiAliasingMode == AntiAliasingMode.MSAA_2X) {
                    sampleCount = 2;
                } else if (ui.antiAliasingMode == AntiAliasingMode.MSAA_4X) {
                    sampleCount = 4;
                } else if (ui.antiAliasingMode == AntiAliasingMode.MSAA_8X) {
                    sampleCount = 8;
                }

                let needNewPasses = false;

                if (this.renderTargets.isNull() || this.renderTargetsWidth != windowWidth || this.renderTargetsHeight != windowHeight
                    || this.renderTargetsSampleCount != sampleCount) {
                    this.releaseObject(this.renderTargets.handle);
                    this.renderTargets = new SceneRenderTargets(null);
                    app.clearBindingCache();
                    this.renderTargets = app.createSceneRenderTargets(windowWidth, windowHeight, sampleCount);
                    this.renderTargetsWidth = windowWidth;
                    this.renderTargetsHeight = windowHeight;
                    this.renderTargetsSampleCount = sampleCount;

                    needNewPasses = true;
                }

                if (this.setupView()) {
                    needNewPasses = true;
                }

                if (ui.shaderReloadRequested) {
                    app.clearShaderCache();
                    needNewPasses = true;
                }

                if (needNewPasses) {
                    exposureResetRequired = this.createRenderPasses();
                }

                ui.shaderReloadRequested = false;
            }

            const commandList = frame.getCommandList();
            const targets = this.renderTargets;
            const view = this.view;
            const viewPrevious = this.viewPrevious;
            const sunLight = this.sunLight;
            const forwardPass = this.forwardPass;
            const toneMappingPass = this.toneMappingPass;
            const temporalAntiAliasingPass = this.temporalAntiAliasingPass;
            const materialEvents = ui.enableMaterialEvents ? 1 : 0;

            frame.clearColor(0.0, 0.0, 0.0, 0.0);

            const ambientScale = ui.ambientIntensity * ui.skyBrightness;
            this.ambientTop[0] = ambientScale * SKY_COLOR_R;
            this.ambientTop[1] = ambientScale * SKY_COLOR_G;
            this.ambientTop[2] = ambientScale * SKY_COLOR_B;
            this.ambientBottom[0] = ambientScale * GROUND_COLOR_R;
            this.ambientBottom[1] = ambientScale * GROUND_COLOR_G;
            this.ambientBottom[2] = ambientScale * GROUND_COLOR_B;
            const top = this.ambientTop;
            const bottom = this.ambientBottom;

            if (ui.enableShadows) {
                sunLight.setShadowMap(this.shadowMap);
                this.loadBounds(sceneGraph.getRootNode());

                const maxShadowDistance = 100.0;
                const zRange = this.boundsDiagonalLength();
                this.shadowMap.setupForView(sunLight, view, maxShadowDistance, zRange, ui.csmExponent);

                commandList.clearShadowMap(this.shadowMap);

                commandList.renderShadowDepth(this.shadowDepthPass, this.shadowMap, sceneGraph, materialEvents);
            } else {
                sunLight.setShadowMap(null);
            }

            // The forward pass gets the enabled probes of the set.
            if (ui.enableLightProbe) {
                const probeCount = this.lightProbes.getCount();
                for (let i = 0; i < probeCount; i++) {
                    if (this.lightProbes.isEnabled(i)) {
                        this.lightProbes.setScales(i, ui.lightProbeDiffuseScale, ui.lightProbeSpecularScale);
                    }
                }
            }
            const lightProbes = ui.enableLightProbe ? this.lightProbes : null;

            commandList.clearSceneRenderTargets(targets);

            if (exposureResetRequired) {
                commandList.resetExposure(toneMappingPass, 0.5);
            }

            if (!ui.useDeferredShading || ui.enableTranslucency) {
                commandList.prepareForwardLights(forwardPass, this.forwardContext, sceneGraph,
                    top[0], top[1], top[2], bottom[0], bottom[1], bottom[2], lightProbes);
            }

            if (ui.useDeferredShading) {
                commandList.renderGBufferFill(this.gbufferPass, view, viewPrevious, targets, sceneGraph, materialEvents);

                const ssaoPass = this.ssaoPass;
                if (ui.enableSsao) {
                    if (ssaoPass) {
                        commandList.renderSsao(ssaoPass, view);
                    }
                }

                commandList.renderDeferredLightingToHdr(this.deferredLightingPass, view, targets, sceneGraph,
                    ui.enableSsao, top[0], top[1], top[2], bottom[0], bottom[1], bottom[2], lightProbes);
            } else {
                commandList.renderForward(forwardPass, this.forwardContext, view, viewPrevious,
                    targets.getFramebuffer(SceneFramebuffer.Forward), sceneGraph, 0, "ForwardOpaque", materialEvents);
            }

            if (this.pick) {
                commandList.clearTextureUInt(targets.getTexture(SceneTexture.MaterialIDs), 0xffff);

                commandList.renderMaterialIDs(this.materialIdPass as MaterialIdPassHandle, view, viewPrevious, targets, sceneGraph, 0);

                if (ui.enableTranslucency) {
                    commandList.renderMaterialIDs(this.materialIdPass as MaterialIdPassHandle, view, viewPrevious, targets, sceneGraph, 1);
                }

                commandList.capturePixel(this.pixelReadbackPass, this.pickX, this.pickY);
            }

            if (ui.enableProceduralSky) {
                commandList.renderSky(this.skyPass as SkyPassHandle, view, sunLight, ui.skyBrightness, ui.skyGlowSize,
                    ui.skyGlowSharpness, ui.skyGlowIntensity, ui.skyHorizonSize);
            }

            if (ui.enableTranslucency) {
                commandList.renderForward(forwardPass, this.forwardContext, view, viewPrevious,
                    targets.getFramebuffer(SceneFramebuffer.Forward), sceneGraph, 1, "ForwardTransparent", materialEvents);
            }

            let finalHdrColor = targets.getTexture(SceneTexture.HdrColor);
            // DLSS-NR's history: last frame's motion vectors (the temporal modes set this below).
            const historyValid = this.previousViewsValid;

            if (ui.antiAliasingMode == AntiAliasingMode.TEMPORAL || ui.antiAliasingMode == AntiAliasingMode.DLSS) {
                if (this.previousViewsValid) {
                    commandList.renderViewMotionVectors(temporalAntiAliasingPass, view, viewPrevious);
                }

                if (ui.antiAliasingMode == AntiAliasingMode.DLSS) {
                    let evaluated = false;
                    const dlss = this.dlss;
                    if (!dlss.isNull()) {
                        if (dlss.isInitialized() && !ui.stereo) {
                            commandList.evaluateDlss(dlss, view, targets, toneMappingPass);
                            evaluated = true;
                        }
                    }

                    if (!evaluated) {
                        // Fallback to TAA if DLSS is not available
                        ui.antiAliasingMode = AntiAliasingMode.TEMPORAL;
                    }
                }

                if (ui.antiAliasingMode == AntiAliasingMode.TEMPORAL) {
                    commandList.temporalResolveView(temporalAntiAliasingPass, view, this.previousViewsValid ? 1 : 0,
                        ui.enableHistoryClamping ? 1 : 0);
                }

                finalHdrColor = targets.getTexture(SceneTexture.ResolvedColor);

                if (ui.enableBloom) {
                    commandList.renderBloom(this.bloomPass as BloomPassHandle, targets.getFramebuffer(SceneFramebuffer.Resolved),
                        view, finalHdrColor, ui.bloomSigma, ui.bloomAlpha);
                }
                this.previousViewsValid = true;
            } else {
                let finalHdrFramebuffer = targets.getFramebuffer(SceneFramebuffer.Hdr);

                if (this.renderTargetsSampleCount > 1) {
                    const resolvedColor = targets.getTexture(SceneTexture.ResolvedColor);
                    commandList.resolveTexture(resolvedColor, finalHdrColor);
                    finalHdrColor = resolvedColor;
                    finalHdrFramebuffer = targets.getFramebuffer(SceneFramebuffer.Resolved);
                }

                if (ui.enableBloom) {
                    commandList.renderBloom(this.bloomPass as BloomPassHandle, finalHdrFramebuffer, view, finalHdrColor, ui.bloomSigma, ui.bloomAlpha);
                }

                this.previousViewsValid = false;
            }

            commandList.renderToneMapping(toneMappingPass, view, finalHdrColor, exposureResetRequired ? 1 : 0);

            // DLSS 5 over the tone-mapped image, guided by the depth and motion vectors that only the
            // temporal modes have (single-sample).
            const dlssNeuralRendering = this.dlssNeuralRendering;
            const runDlssNeuralRendering = ui.enableDlssNeuralRendering && !ui.stereo && !dlssNeuralRendering.isNull() &&
                (ui.antiAliasingMode == AntiAliasingMode.TEMPORAL || ui.antiAliasingMode == AntiAliasingMode.DLSS) &&
                dlssNeuralRendering.isInitialized();
            if (runDlssNeuralRendering) {
                const reset = !historyValid || !this.dlssNeuralRenderingActive;
                commandList.evaluateDlssNeuralRendering(dlssNeuralRendering, view, targets, ui.dlssNeuralRenderingIntensity,
                    ui.dlssNeuralRenderingToneStrength, ui.dlssNeuralRenderingStructureStrength, ui.dlssNeuralRenderingModel,
                    ui.dlssNeuralRenderingUseAutoMask ? 1 : 0, ui.dlssNeuralRenderingSkinStrength, reset ? 1 : 0);
            }
            this.dlssNeuralRenderingActive = runDlssNeuralRendering;

            app.blitTexture(frame, targets.getTexture(SceneTexture.LdrColor));

            if (ui.testMipMapGen) {
                commandList.dispatchMipMapGen(this.mipMapGenPass as MipMapGenPassHandle);
                app.displayMipMapGen(frame, this.mipMapGenPass as MipMapGenPassHandle);
            }

            if (ui.displayShadowMap) {
                const shadowMapTexture = this.shadowMap.getTexture();
                for (let cascade = 0; cascade < 4; cascade++) {
                    app.blitTextureSlice(frame, shadowMapTexture, cascade,
                        10.0 + 266.0 * cascade, windowHeight - 266.0, 256.0, 256.0);
                }
            }

            // The C++ sample executes its command list here; the rest needs the results.

            if (ui.screenshotFileName != "") {
                app.saveFrameToFile(frame, ui.screenshotFileName);
                ui.screenshotFileName = "";
            }

            if (this.pick) {
                this.pick = false;
                app.flushFrameCommandList(frame);
                this.finishPick();
            }

            temporalAntiAliasingPass.advanceFrame();
            const swappedView = this.view;
            this.view = this.viewPrevious;
            this.viewPrevious = swappedView;

            app.setVsyncEnabled(ui.enableVsync);
        }

        // Renders a light probe's cube maps from the camera position (the sample's RenderLightProbe).
        renderLightProbe(index: int) {
            const app = this.app;
            const sceneGraph = this.sceneGraph;
            const sunLight = this.sunLight;
            const lightProbePass = this.lightProbePass;
            if (sceneGraph.isNull() || lightProbePass.isNull()) {
                return;
            }

            const environmentMapSize = 1024;
            const environmentMapMipLevels = 8;
            const capture = app.createLightProbeCapture(environmentMapSize, environmentMapMipLevels);

            const nearPlane = 0.1;
            const cullDistance = 100.0;
            this.getActiveCamera().getPosition(Ref(this.vector1[0]));
            let probeX = this.vector1[0];
            let probeY = this.vector1[1];
            let probeZ = this.vector1[2];
            const sceneCamera = this.ui.activeSceneCamera;
            if (!sceneCamera.isNull()) {
                // As in the sample: the translation of the world-to-view matrix.
                sceneCamera.getWorldToView(Ref(this.viewMatrix[0]));
                probeX = this.viewMatrix[12];
                probeY = this.viewMatrix[13];
                probeZ = this.viewMatrix[14];
            }

            capture.setTransform(probeX, probeY, probeZ, nearPlane, cullDistance);
            const view = capture.getView();
            const framebuffer = capture.getFramebuffer();

            const skyPass = app.createSkyPass(framebuffer, view);

            const forwardPass = app.createForwardShadingPassWithOptions(
                app.isFeatureSupported(Feature.FastGeometryShader) ? 1 : 0, 1);
            const forwardContext = app.createForwardShadingContext();

            const commandList = app.createCommandList();
            commandList.open();
            commandList.clearLightProbeCapture(capture);

            this.loadBounds(sceneGraph.getRootNode());
            const zRange = this.boundsDiagonalLength() * 0.5;
            this.shadowMap.setupForLightProbeCapture(sunLight, capture, cullDistance, zRange, this.ui.csmExponent);
            commandList.clearShadowMap(this.shadowMap);

            commandList.renderShadowDepth(this.shadowDepthPass, this.shadowMap, sceneGraph, 0);

            const top = this.ambientTop;
            const bottom = this.ambientBottom;
            commandList.prepareForwardLights(forwardPass, forwardContext, sceneGraph,
                top[0], top[1], top[2], bottom[0], bottom[1], bottom[2], null);

            commandList.renderForward(forwardPass, forwardContext, view, null, framebuffer, sceneGraph, 0, "ForwardOpaque", 0);

            commandList.renderSky(skyPass, view, sunLight, this.ui.skyBrightness, this.ui.skyGlowSize,
                this.ui.skyGlowSharpness, this.ui.skyGlowIntensity, this.ui.skyHorizonSize);

            commandList.renderForward(forwardPass, forwardContext, view, null, framebuffer, sceneGraph, 1, "ForwardTransparent", 0);

            commandList.generateLightProbeCaptureMips(lightProbePass, capture);

            commandList.renderLightProbeDiffuse(lightProbePass, capture, this.lightProbes, index);

            const specularMapMipLevels = this.lightProbes.getSpecularMipLevels();
            for (let mipLevel = 0; mipLevel < specularMapMipLevels; mipLevel++) {
                const roughness = Math.pow(mipLevel / (specularMapMipLevels - 1), 2.0);
                commandList.renderLightProbeSpecular(lightProbePass, capture, this.lightProbes, index, roughness, mipLevel);
            }

            commandList.renderEnvironmentBrdf(lightProbePass);

            commandList.close();
            app.executeCommandList(commandList);
            app.waitForIdle();
            app.runGarbageCollection();

            this.lightProbes.finish(index, lightProbePass, probeX, probeY, probeZ);

            app.releaseResource(commandList.handle);
            app.releaseObject(forwardContext);
            app.releaseObject(forwardPass.handle);
            app.releaseObject(skyPass);
            app.releaseObject(capture.handle);
        }

        // --- Pass callbacks ---

        onKeyboard(key: Key, scancode: ScanCode, action: Action, mods: KeyMods) {
            if (key == Key.Escape && action == Action.Press) {
                this.ui.showUI = !this.ui.showUI;
                return 1;
            }

            if (key == Key.GraveAccent && action == Action.Press) {
                this.ui.showConsole = !this.ui.showConsole;
                return 1;
            }

            if (key == Key.Space && action == Action.Press) {
                this.ui.enableAnimations = !this.ui.enableAnimations;
                return 1;
            }

            // As in the other examples (not in the C++ sample): V toggles vertical sync, like the
            // VSync checkbox.
            if (key == Key.V && action == Action.Press) {
                this.ui.enableVsync = !this.ui.enableVsync;
                return 1;
            }

            if (key == Key.T && action == Action.Press) {
                this.copyActiveCameraToFirstPerson();
                if (!this.ui.activeSceneCamera.isNull()) {
                    this.ui.useThirdPersonCamera = false;
                    this.ui.activeSceneCamera = new SceneCamera(null);
                } else {
                    this.ui.useThirdPersonCamera = !this.ui.useThirdPersonCamera;
                }
                return 1;
            }

            // The camera's input, the game camera's while it is attached to a prop.
            if (this.game.cameraActive()) {
                this.game.gameCamera.keyboardUpdate(key, scancode, action, mods);
            } else if (this.ui.activeSceneCamera.isNull()) {
                this.getActiveCamera().keyboardUpdate(key, scancode, action, mods);
            }
            return 1;
        }

        onMousePos(x: number, y: number) {
            if (this.game.cameraActive()) {
                this.game.gameCamera.mousePosUpdate(x, y);
            } else if (this.ui.activeSceneCamera.isNull()) {
                this.getActiveCamera().mousePosUpdate(x, y);
            }

            this.pickX = Math.trunc(x);
            this.pickY = Math.trunc(y);

            return 1;
        }

        onMouseButton(button: MouseButton, action: Action, mods: KeyMods) {
            if (this.game.cameraActive()) {
                this.game.gameCamera.mouseButtonUpdate(button, action, mods);
            } else if (this.ui.activeSceneCamera.isNull()) {
                this.getActiveCamera().mouseButtonUpdate(button, action, mods);
            }

            if (action == Action.Press && button == MouseButton.Right) {
                this.pick = true;
            }

            return 1;
        }

        onMouseScroll(xOffset: number, yOffset: number) {
            if (!this.game.cameraActive() && this.ui.activeSceneCamera.isNull()) {
                this.getActiveCamera().mouseScrollUpdate(xOffset, yOffset);
            }

            return 1;
        }

        onAnimate(elapsedSeconds: number) {
            // The game camera, attached to a prop, moves the first-person camera.
            const game = this.game;
            if (game.cameraActive() && (!this.ui.activeSceneCamera.isNull() || this.ui.useThirdPersonCamera)) {
                this.copyActiveCameraToFirstPerson();
                this.ui.activeSceneCamera = new SceneCamera(null);
                this.ui.useThirdPersonCamera = false;
            }

            if (this.ui.activeSceneCamera.isNull()) {
                this.getActiveCamera().animate(elapsedSeconds);
            }

            const toneMappingPass = this.toneMappingPass;
            if (!toneMappingPass.isNull()) {
                toneMappingPass.advanceFrame(elapsedSeconds);
            }

            game.tick(elapsedSeconds, this.ui.enableAnimations);
            const scene = this.scene;
            if (!scene.isNull()) {
                if (this.ui.enableAnimations) {
                    this.wallclockTime += elapsedSeconds;
                    // The game's time is the scene's, as in RTXPT.
                    if (game.initialized) {
                        this.wallclockTime = game.gameTime;
                    }

                    const animationCount = scene.getAnimationCount();
                    for (let i = 0; i < animationCount; i++) {
                        const duration = scene.getAnimationDuration(i);
                        const cycles = this.wallclockTime / duration;
                        const animationTime = (cycles - Math.floor(cycles)) * duration;
                        scene.applyAnimation(i, animationTime);
                    }
                }
            }
            game.tickCamera(elapsedSeconds, this.firstPersonCamera);
        }

        // ApplicationBase::Render: a splash screen until the scene and its textures have loaded.
        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const state = this.sceneLoader.update(frame);
            if (state == SceneLoaderState.Loading) {
                this.renderSplashScreen(frame);
                if (this.testMode) {
                    Program.sleepMilliseconds(TEST_LOADING_WAIT_MS);
                }
                return;
            }

            if (state == SceneLoaderState.Loaded) {
                this.sceneLoaded();
            }

            this.renderScene(frame);

            this.readyFrames++;
            if (this.testMode && this.readyFrames == TEST_FRAMES) {
                this.app.closeWindow();
            }
            if (g_ScreenshotPath != "") {
                if (this.readyFrames == SCREENSHOT_FRAME) {
                    this.ui.screenshotFileName = g_ScreenshotPath;
                } else if (this.readyFrames > SCREENSHOT_FRAME) {
                    this.app.closeWindow();
                }
            }
        }
    }

    // --- UI ---------------------------------------------------------------------------------

    // The sample's UIRenderer: the settings window, the material editor for the picked material, and
    // a loading message while a scene loads.
    class UserInterface {
        private app: App;
        private demo: FeatureDemo;
        private ui: UIData;
        private imguiPass: ImGuiPass;
        private fontOpenSans: ImGuiFont;
        private fontDroidMono: ImGuiFont;
        private loadingStats: int[];

        constructor(app: App, demo: FeatureDemo, ui: UIData) {
            this.app = app;
            this.demo = demo;
            this.ui = ui;
            this.loadingStats = [];
            for (let i = 0; i < 4; i++) {
                this.loadingStats.push(0);
            }
        }

        init() {
            const imguiPass = this.app.addImGuiPass(this.buildUI);
            if (imguiPass.isNull()) {
                return false;
            }
            this.imguiPass = imguiPass;

            this.fontOpenSans = imguiPass.createFont("media/fonts/OpenSans/OpenSans-Regular.ttf", 17.0);
            this.fontDroidMono = imguiPass.createFont("media/fonts/DroidSans/DroidSans-Mono.ttf", 14.0);
            return !this.fontOpenSans.isNull() && !this.fontDroidMono.isNull();
        }

        checkbox(label: string, value: boolean) {
            return ImGui.checkbox(label, value);
        }

        // Scene paths are shown relative to the scene folder.
        getRelativePath(name: string) {
            const sceneDir = this.demo.sceneDir;
            return name.startsWith(sceneDir) ? name.substring(sceneDir.length) : name;
        }

        buildUI() {
            const ui = this.ui;
            const demo = this.demo;
            const app = this.app;

            if (!ui.showUI) {
                return;
            }

            const width = app.getWindowWidth();

            const sceneGraph = demo.sceneGraph;
            if (demo.sceneLoader.isSceneLoading() || sceneGraph.isNull()) {
                this.imguiPass.beginFullScreenWindow();
                this.fontOpenSans.push();

                demo.sceneLoader.getSceneLoadingStats(Ref(this.loadingStats[0]));
                const stats = this.loadingStats;
                this.imguiPass.drawScreenCenteredText(
                    `Loading scene ${demo.currentSceneName}, please wait...\nObjects: ${stats[0]}/${stats[1]}, Textures: ${stats[2]}/${stats[3]}`);

                ImGui.popFont();
                this.imguiPass.endFullScreenWindow();

                return;
            }

            this.fontOpenSans.push();

            // (The console is commented out in the sample too: `~` only toggles ui.showConsole.)

            const fontSize = ImGui.getFontSize();

            ImGui.setNextWindowPos(fontSize * 0.6, fontSize * 0.6);
            ImGui.begin("Settings", true);
            ImGui.text(`Renderer: ${app.getRendererString()}`);
            const frameTime = app.getAverageFrameTime();
            if (frameTime > 0.0) {
                ImGui.text(`${formatFixed(frameTime * 1e3, 3)} ms/frame (${formatFixed(1.0 / frameTime, 1)} FPS)`);
            }

            const currentScene = demo.currentSceneName;
            if (ImGui.beginCombo("Scene", this.getRelativePath(currentScene))) {
                const sceneCount = demo.sceneFilesAvailable.getCount();
                for (let i = 0; i < sceneCount; i++) {
                    const scene = demo.sceneFilesAvailable.getItem(i);
                    const isSelected = scene == currentScene;
                    if (ImGui.selectable(this.getRelativePath(scene), isSelected)) {
                        demo.setCurrentSceneName(scene);
                    }
                    if (isSelected) {
                        ImGui.setItemDefaultFocus();
                    }
                }
                ImGui.endCombo();
            }

            if (ImGui.button("Reload Shaders")) {
                ui.shaderReloadRequested = true;
            }

            ui.enableVsync = this.checkbox("VSync", ui.enableVsync);
            ui.useDeferredShading = this.checkbox("Deferred Shading", ui.useDeferredShading);
            if (ui.antiAliasingMode >= AntiAliasingMode.MSAA_2X) {
                // Deferred shading doesn't work with MSAA
                ui.useDeferredShading = false;
            }
            ui.stereo = this.checkbox("Stereo", ui.stereo);
            ui.enableAnimations = this.checkbox("Animations", ui.enableAnimations);

            const activeSceneCamera = ui.activeSceneCamera;
            const cameraPreview = !activeSceneCamera.isNull() ? activeSceneCamera.getName()
                : ui.useThirdPersonCamera ? "Third-Person" : "First-Person";
            if (ImGui.beginCombo("Camera (T)", cameraPreview)) {
                if (ImGui.selectable("First-Person", ui.activeSceneCamera.isNull() && !ui.useThirdPersonCamera)) {
                    ui.activeSceneCamera = new SceneCamera(null);
                    ui.useThirdPersonCamera = false;
                }
                if (ImGui.selectable("Third-Person", ui.activeSceneCamera.isNull() && ui.useThirdPersonCamera)) {
                    ui.activeSceneCamera = new SceneCamera(null);
                    ui.useThirdPersonCamera = true;
                    demo.copyActiveCameraToFirstPerson();
                }
                const cameraCount = sceneGraph.getCameraCount();
                for (let i = 0; i < cameraCount; i++) {
                    const camera = sceneGraph.getCamera(i);
                    // The handles: each call wraps the camera in a new object.
                    if (ImGui.selectable(camera.getName(), ui.activeSceneCamera.handle == camera.handle)) {
                        ui.activeSceneCamera = camera;
                        demo.copyActiveCameraToFirstPerson();
                    }
                }
                ImGui.endCombo();
            }

            if (ui.antiAliasingMode == AntiAliasingMode.DLSS && !ui.dlssAvailable) {
                // Fallback to TAA if DLSS is not available
                ui.antiAliasingMode = AntiAliasingMode.TEMPORAL;
            }

            const aaModes: string[] = ["None", "TemporalAA", "DLSS", "MSAA 2x", "MSAA 4x", "MSAA 8x"];
            const aaMode = ui.antiAliasingMode;
            if (ImGui.beginCombo("AA Mode", aaModes[aaMode])) {
                for (let n = 0; n < 6; n++) {
                    if (n == AntiAliasingMode.DLSS && !ui.dlssAvailable) {
                        // Skip DLSS if not available
                        continue;
                    }

                    const isSelected = aaMode == n;
                    if (ImGui.selectable(aaModes[n], isSelected)) {
                        ui.antiAliasingMode = n;
                    }
                    if (isSelected) {
                        ImGui.setItemDefaultFocus();
                    }
                }
                ImGui.endCombo();
            }

            ui.temporalAntiAliasingJitter = ImGui.combo("TAA Camera Jitter", ui.temporalAntiAliasingJitter, "MSAA|Halton|R2|White Noise");

            if (ui.dlssNeuralRenderingAvailable) {
                // As RTX Remix's DLSS 3D-Guided Neural Rendering settings.
                ui.enableDlssNeuralRendering = this.checkbox("DLSS 5 (Neural Rendering)", ui.enableDlssNeuralRendering);
                if (ui.enableDlssNeuralRendering) {
                    ImGui.indent();
                    if (ui.antiAliasingMode != AntiAliasingMode.TEMPORAL && ui.antiAliasingMode != AntiAliasingMode.DLSS) {
                        ImGui.text("Needs the TemporalAA or DLSS AA mode");
                    }
                    ui.dlssNeuralRenderingModel = ImGui.combo("Model", ui.dlssNeuralRenderingModel, "Model A|Model B|Model C");
                    ui.dlssNeuralRenderingIntensity = ImGui.sliderFloat("Intensity", ui.dlssNeuralRenderingIntensity, 0.0, 1.0);
                    ui.dlssNeuralRenderingStructureStrength = ImGui.sliderFloat("Structure Intensity",
                        ui.dlssNeuralRenderingStructureStrength, 0.0, 1.0);
                    ui.dlssNeuralRenderingToneStrength = ImGui.sliderFloat("Tone Intensity", ui.dlssNeuralRenderingToneStrength, 0.0, 1.0);
                    ui.dlssNeuralRenderingUseAutoMask = this.checkbox("Auto Mask", ui.dlssNeuralRenderingUseAutoMask);
                    if (ui.dlssNeuralRenderingUseAutoMask) {
                        ui.dlssNeuralRenderingSkinStrength = ImGui.sliderFloat("Character Intensity",
                            ui.dlssNeuralRenderingSkinStrength, 0.0, 1.0);
                    }
                    ImGui.unindent();
                }
            }

            ui.ambientIntensity = ImGui.sliderFloat("Ambient Intensity", ui.ambientIntensity, 0.0, 1.0);

            ui.enableLightProbe = this.checkbox("Enable Light Probe", ui.enableLightProbe);
            if (ui.enableLightProbe && ImGui.collapsingHeader("Light Probe")) {
                ui.lightProbeDiffuseScale = ImGui.dragFloat("Diffuse Scale", ui.lightProbeDiffuseScale, 0.01, 0.0, 10.0);
                ui.lightProbeSpecularScale = ImGui.dragFloat("Specular Scale", ui.lightProbeSpecularScale, 0.01, 0.0, 10.0);
            }

            ui.enableProceduralSky = this.checkbox("Enable Procedural Sky", ui.enableProceduralSky);
            if (ui.enableProceduralSky && ImGui.collapsingHeader("Sky Parameters")) {
                ui.skyBrightness = ImGui.sliderFloat("Brightness", ui.skyBrightness, 0.0, 1.0);
                ui.skyGlowSize = ImGui.sliderFloat("Glow Size", ui.skyGlowSize, 0.0, 90.0);
                ui.skyGlowSharpness = ImGui.sliderFloat("Glow Sharpness", ui.skyGlowSharpness, 1.0, 10.0);
                ui.skyGlowIntensity = ImGui.sliderFloat("Glow Intensity", ui.skyGlowIntensity, 0.0, 1.0);
                ui.skyHorizonSize = ImGui.sliderFloat("Horizon Size", ui.skyHorizonSize, 0.0, 90.0);
            }
            ui.enableSsao = this.checkbox("Enable SSAO", ui.enableSsao);
            ui.enableBloom = this.checkbox("Enable Bloom", ui.enableBloom);
            ui.bloomSigma = ImGui.dragFloat("Bloom Sigma", ui.bloomSigma, 0.01, 0.1, 100.0);
            ui.bloomAlpha = ImGui.dragFloat("Bloom Alpha", ui.bloomAlpha, 0.01, 0.01, 1.0);
            ui.enableShadows = this.checkbox("Enable Shadows", ui.enableShadows);
            ui.enableTranslucency = this.checkbox("Enable Translucency", ui.enableTranslucency);

            ImGui.separator();
            ui.enableHistoryClamping = this.checkbox("Temporal AA Clamping", ui.enableHistoryClamping);
            ui.enableMaterialEvents = this.checkbox("Material Events", ui.enableMaterialEvents);
            ImGui.separator();

            const lightCount = sceneGraph.getLightCount();
            if (lightCount > 0 && ImGui.collapsingHeader("Lights")) {
                const selectedLight = ui.selectedLight;
                if (ImGui.beginCombo("Select Light", !selectedLight.isNull() ? selectedLight.getName() : "(None)")) {
                    for (let i = 0; i < lightCount; i++) {
                        const light = sceneGraph.getLight(i);
                        // ImGui::Selectable(label, &selected): a click toggles `selected`.
                        let selected = ui.selectedLight.handle == light.handle;
                        if (ImGui.selectable(light.getName(), selected)) {
                            selected = !selected;
                        }
                        if (selected) {
                            ui.selectedLight = light;
                            ImGui.setItemDefaultFocus();
                        }
                    }
                    ImGui.endCombo();
                }

                const light = ui.selectedLight;
                if (!light.isNull()) {
                    light.imGuiEditor();
                }
            }

            // RTXPT's SampleGame (its SampleUI's header).
            const game = demo.game;
            if (game.initialized && ImGui.collapsingHeader("Interactive elements")) {
                ImGui.indent();
                game.debugGUI();
                ImGui.unindent();
            }

            ImGui.text("Render Light Probe: ");
            const probeCount = demo.lightProbes.getCount();
            for (let i = 0; i < probeCount; i++) {
                ImGui.sameLine();
                if (ImGui.button(demo.lightProbes.getName(i))) {
                    demo.renderLightProbe(i);
                }
            }

            if (ImGui.button("Screenshot")) {
                const fileName = Program.fileDialog(false, "BMP files|*.bmp|All files|*.*");
                if (fileName != "") {
                    // A copy: the dialog's result is overwritten by its next call.
                    ui.screenshotFileName = `${fileName}`;
                }
            }

            ImGui.separator();
            ui.testMipMapGen = this.checkbox("Test MipMapGen Pass", ui.testMipMapGen);
            ui.displayShadowMap = this.checkbox("Display Shadow Map", ui.displayShadowMap);

            ImGui.end();
            // The prop camera's "Exit prop camera" button.
            game.standaloneGUI(width, app.getWindowHeight());

            const material = ui.selectedMaterial;
            if (!material.isNull()) {
                ImGui.setNextWindowPosPivot(width - fontSize * 0.6, fontSize * 0.6, 1.0, 0.0);
                ImGui.begin("Material Editor", false);
                ImGui.text(`Material ${material.getID()}: ${material.getName()}`);

                const previousDomain = material.getDomain();
                material.setDirty(material.imGuiEditor(true));

                if (previousDomain != material.getDomain()) {
                    sceneGraph.getRootNode().invalidateContent();
                }

                ImGui.end();
            }

            if (ui.antiAliasingMode != AntiAliasingMode.NONE &&
                ui.antiAliasingMode != AntiAliasingMode.TEMPORAL &&
                ui.antiAliasingMode != AntiAliasingMode.DLSS) {
                ui.useDeferredShading = false;
            }

            if (!ui.useDeferredShading) {
                ui.enableSsao = false;
            }

            ImGui.popFont();
        }
    }

    // --- Main -------------------------------------------------------------------------------

    function printFormats(app: App) {
        const formatCount = Formats.count();
        for (let format = 0; format < formatCount; format++) {
            const support = app.queryFormatSupport(format);
            let name = Formats.name(format);
            while (name.length < 17) {
                name = " " + name;
            }

            // nvrhi::FormatSupport bits: Buffer, IndexBuffer, VertexBuffer, Texture, DepthStencil,
            // RenderTarget, Blendable, ShaderLoad, ShaderSample, ShaderUavLoad, ShaderUavStore, ShaderAtomic.
            const letters = "BIVTDRbLSlsA";
            let features = "";
            for (let bit = 0; bit < 12; bit++) {
                features += (support & (1 << bit)) != 0 ? letters.substring(bit, bit + 1) : ".";
            }

            console.log(`${name}: ${features}`);
        }
    }

    class FeatureDemoExampleArgs extends Args {
        // ProcessCommandLine
        // -width <pixels>, -height <pixels>: the window's size.
        width = 1920;
        height = 1080;
        // -fullscreen
        fullscreen = false;
        // -no-vsync
        noVsync = false;
        // -print-graph, -print-formats: print the scene graph / the formats' support.
        printSceneGraph = false;
        printFormats = false;
        // -screenshot <file>
        screenshotPath = "";
        // -dlss: start in the DLSS AA mode; -dlss5: with DLSS 5 on (where available). Not the C++ sample's.
        dlss = false;
        dlss5 = false;
        // -propShowTags <tags>, -propCameraAttach <prop>: RTXPT's SampleGame's, in its scenes. Not the C++ sample's.
        propShowTags = "";
        propCameraAttach = "";
        // The scene: the argument which is not an option.
        sceneName = "";

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-width") {
                    i++;
                    this.width = parseInt(this[i]);
                } else if (arg == "-height") {
                    i++;
                    this.height = parseInt(this[i]);
                } else if (arg == "-fullscreen") {
                    this.fullscreen = true;
                } else if (arg == "-no-vsync") {
                    this.noVsync = true;
                } else if (arg == "-print-graph") {
                    this.printSceneGraph = true;
                } else if (arg == "-print-formats") {
                    this.printFormats = true;
                } else if (arg == "-screenshot") {
                    i++;
                    this.screenshotPath = this[i];
                } else if (arg == "-dlss") {
                    this.dlss = true;
                } else if (arg == "-dlss5") {
                    this.dlss5 = true;
                } else if (arg == "-propShowTags") {
                    i++;
                    this.propShowTags = this[i];
                } else if (arg == "-propCameraAttach") {
                    i++;
                    this.propCameraAttach = this[i];
                } else if (arg == "-testOutput") {
                    // Args' (-test's frame file), not the scene.
                    i++;
                } else if (!arg.startsWith("-")) {
                    this.sceneName = arg;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Program.setAppName("feature_demo");

        const args = new FeatureDemoExampleArgs(argc, argv, TEST_FRAMES_MAX);
        args.parseArgs();

        g_PrintSceneGraph = args.printSceneGraph;
        g_PrintFormats = args.printFormats;
        g_ScreenshotPath = args.screenshotPath;
        g_PropShowTags = args.propShowTags;
        g_PropCameraAttach = args.propCameraAttach;

        // Dlss: the Vulkan extensions DLSS needs, if built with it.
        let options = AppOptions.PerMonitorDpi | AppOptions.Dlss | args.options;
        if (args.fullscreen) {
            options = options | AppOptions.Fullscreen;
        }
        if (args.noVsync) {
            options = options | AppOptions.NoVsync;
        }

        const apiString = Program.graphicsAPIToString(args.api);
        const windowTitle = `Donut Feature Demo (${apiString})`;

        const app = App.createWithOptions(args.api, windowTitle, args.width, args.height, options);
        if (app.isNull()) {
            console.log(`Cannot initialize a ${apiString} graphics device with the requested parameters`);
            return 1;
        }

        if (g_PrintFormats) {
            printFormats(app);
        }

        const uiData = new UIData();
        // The UI applies its VSync setting every frame; in the C++ sample that overrides -no-vsync.
        uiData.enableVsync = !args.noVsync;
        // Both fall back without support (to TAA; DLSS 5 off).
        if (args.dlss) {
            uiData.antiAliasingMode = AntiAliasingMode.DLSS;
        }
        uiData.enableDlssNeuralRendering = args.dlss5;

        const demo = new FeatureDemo(app, uiData);
        if (!demo.init(args.sceneName)) {
            app.destroy();
            return 1;
        }

        // Drawn after (over) the scene, and sees the input first.
        const gui = new UserInterface(app, demo, uiData);
        if (!gui.init()) {
            console.log("Cannot initialize the user interface");
            app.destroy();
            return 1;
        }

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(checkFrame(app));
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return FeatureDemoExample.main(argc, argv);
}

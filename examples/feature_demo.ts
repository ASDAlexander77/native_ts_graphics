// Imported only for its declarations: input_pass.ts brings in donut.ts (the class wrappers over
// donut_interop.d.ts), whose code every example links from its object. Referencing donut.ts here
// would compile that code into this object too, defining its symbols twice.
import { InputPass } from "../core/input_pass";

namespace FeatureDemoExample {
    // GLFW values, as passed to the input callbacks.
    const KEY_SPACE = 32;
    const KEY_T = 84;
    const KEY_V = 86;
    const KEY_GRAVE_ACCENT = 96;
    const KEY_ESCAPE = 256;
    const ACTION_PRESS = 1;
    const MOUSE_BUTTON_2 = 1;

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

    enum AntiAliasingMode {
        NONE = 0,
        TEMPORAL = 1,
        DLSS = 2,
        MSAA_2X = 3,
        MSAA_4X = 4,
        MSAA_8X = 5
    }

    // --- Math ---------------------------------------------------------------------------------

    // dm::radians(float): in float32, as every use in the sample is.
    function radians(degrees: number): number {
        return Math.fround(Math.fround(degrees) * Math.fround(Math.fround(Math.PI) / 180.0));
    }

    // math::perspProjD3DStyleReverse(verticalFOV, aspect, zNear): reverse-Z, infinite far plane;
    // row-major, row-vector convention, into 16 floats.
    // In float32 as Donut's (computed in double, the scales differ in the last bit, which moves
    // edges by a pixel here and there).
    function perspProjD3DStyleReverse(dst: f32[], verticalFOV: number, aspect: number, zNear: number): void {
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

    // A number with `digits` decimals, like printf's %.Nf (Number.toFixed is missing under the JIT).
    function formatFixed(value: number, digits: int): string {
        let scale = 1.0;
        for (let i = 0; i < digits; i++) {
            scale *= 10.0;
        }
        const scaled = Math.round(Math.abs(value) * scale);
        const whole: int = Math.floor(scaled / scale);
        const fraction: int = scaled - whole * scale;
        let fractionText = `${fraction}`;
        while (fractionText.length < digits) {
            fractionText = "0" + fractionText;
        }
        const sign = value < 0.0 && scaled > 0.0 ? "-" : "";
        return digits > 0 ? `${sign}${whole}.${fractionText}` : `${sign}${whole}`;
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
        private forwardContext: Opaque;
        private gbufferPass: GBufferFillPass;
        private deferredLightingPass: DeferredLightingPass;
        private skyPass: Opaque | null;
        private temporalAntiAliasingPass: TemporalAntiAliasingPass;
        // A null handle without DLSS support.
        private dlss: Dlss;
        private bloomPass: Opaque | null;
        private toneMappingPass: ToneMappingPass;
        private ssaoPass: Opaque | null;
        private lightProbePass: LightProbeProcessingPass;
        private materialIdPass: Opaque | null;
        private pixelReadbackPass: PixelReadbackPass;
        private mipMapGenPass: Opaque | null;

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

        private wallclockTime: number;
        // Frames rendered with a loaded scene, for -screenshot.
        private readyFrames: int;

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

        getActiveCamera(): Camera {
            return this.ui.useThirdPersonCamera ? this.thirdPersonCamera : this.firstPersonCamera;
        }

        // Loads the node's world-space bounds into this.bounds.
        loadBounds(node: Node): void {
            node.getBoundingBox(Ref(this.bounds[0]));
        }

        boundsDiagonalLength(): number {
            const dx = this.bounds[3] - this.bounds[0];
            const dy = this.bounds[4] - this.bounds[1];
            const dz = this.bounds[5] - this.bounds[2];
            return Math.sqrt(dx * dx + dy * dy + dz * dz);
        }

        sceneUnloading(): void {
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
                this.lightProbes.setEnabled(i, 0);
            }
        }

        setCurrentSceneName(sceneName: string): void {
            if (this.currentSceneName == sceneName) {
                return;
            }

            this.currentSceneName = sceneName;

            // BeginLoadingScene
            if (this.sceneLoader.isSceneLoaded() != 0) {
                this.sceneUnloading();
            }
            this.scene = new Scene(null);
            this.sceneGraph = new SceneGraph(null);
            this.sceneLoader.beginLoadingScene(sceneName);
        }

        copyActiveCameraToFirstPerson(): void {
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

        pointThirdPersonCameraAt(node: Node): void {
            this.loadBounds(node);
            const b = this.bounds;
            this.thirdPersonCamera.thirdPersonSetTarget(
                (b[0] + b[3]) * 0.5, (b[1] + b[4]) * 0.5, (b[2] + b[5]) * 0.5);
            const radius = this.boundsDiagonalLength() * 0.5;
            const distance = radius / Math.sin(radians(this.cameraVerticalFov * 0.5));
            this.thirdPersonCamera.thirdPersonSetDistance(distance);
            this.thirdPersonCamera.animate(0.0);
        }

        sceneLoaded(): void {
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

            this.thirdPersonCamera.thirdPersonSetRotation(radians(135.0), radians(20.0));
            this.pointThirdPersonCameraAt(sceneGraph.getRootNode());

            this.ui.useThirdPersonCamera = this.currentSceneName.endsWith(".gltf") || this.currentSceneName.endsWith(".glb");

            this.copyActiveCameraToFirstPerson();

            if (g_PrintSceneGraph) {
                sceneGraph.print();
            }
        }

        releaseViews(): void {
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

        releaseObject(object: Opaque | null): void {
            if (object) {
                this.app.releaseObject(object);
            }
        }

        // Sets up this.view for the frame; true if it had to be created (then so do the passes).
        setupView(): boolean {
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

            let verticalFov = radians(this.cameraVerticalFov);
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
        createRenderPasses(): boolean {
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
                dlss.init(width, height, width, height);

                this.ui.dlssAvailable = dlss.isInitialized() != 0;
            }

            this.previousViewsValid = false;
            return exposureResetRequired;
        }

        renderSplashScreen(frame: Frame): void {
            frame.clearColor(0.0, 0.0, 0.0, 0.0);
            this.app.setVsyncEnabled(1);
        }

        // After the frame's commands have been submitted: finds what the right mouse button clicked.
        finishPick(): void {
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

        renderScene(frame: Frame): void {
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
                    if (this.lightProbes.isEnabled(i) != 0) {
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
                    ui.enableSsao ? 1 : 0, top[0], top[1], top[2], bottom[0], bottom[1], bottom[2], lightProbes);
            } else {
                commandList.renderForward(forwardPass, this.forwardContext, view, viewPrevious,
                    targets.getFramebuffer(SceneFramebuffer.Forward), sceneGraph, 0, "ForwardOpaque", materialEvents);
            }

            if (this.pick) {
                commandList.clearTextureUInt(targets.getTexture(SceneTexture.MaterialIDs), 0xffff);

                commandList.renderMaterialIDs(this.materialIdPass, view, viewPrevious, targets, sceneGraph, 0);

                if (ui.enableTranslucency) {
                    commandList.renderMaterialIDs(this.materialIdPass, view, viewPrevious, targets, sceneGraph, 1);
                }

                commandList.capturePixel(this.pixelReadbackPass, this.pickX, this.pickY);
            }

            if (ui.enableProceduralSky) {
                commandList.renderSky(this.skyPass, view, sunLight, ui.skyBrightness, ui.skyGlowSize,
                    ui.skyGlowSharpness, ui.skyGlowIntensity, ui.skyHorizonSize);
            }

            if (ui.enableTranslucency) {
                commandList.renderForward(forwardPass, this.forwardContext, view, viewPrevious,
                    targets.getFramebuffer(SceneFramebuffer.Forward), sceneGraph, 1, "ForwardTransparent", materialEvents);
            }

            let finalHdrColor = targets.getTexture(SceneTexture.HdrColor);

            if (ui.antiAliasingMode == AntiAliasingMode.TEMPORAL || ui.antiAliasingMode == AntiAliasingMode.DLSS) {
                if (this.previousViewsValid) {
                    commandList.renderViewMotionVectors(temporalAntiAliasingPass, view, viewPrevious);
                }

                if (ui.antiAliasingMode == AntiAliasingMode.DLSS) {
                    let evaluated = false;
                    const dlss = this.dlss;
                    if (!dlss.isNull()) {
                        if (dlss.isInitialized() != 0 && !ui.stereo) {
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
                    commandList.renderBloom(this.bloomPass, targets.getFramebuffer(SceneFramebuffer.Resolved),
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
                    commandList.renderBloom(this.bloomPass, finalHdrFramebuffer, view, finalHdrColor, ui.bloomSigma, ui.bloomAlpha);
                }

                this.previousViewsValid = false;
            }

            commandList.renderToneMapping(toneMappingPass, view, finalHdrColor, exposureResetRequired ? 1 : 0);

            app.blitTexture(frame, targets.getTexture(SceneTexture.LdrColor));

            if (ui.testMipMapGen) {
                commandList.dispatchMipMapGen(this.mipMapGenPass);
                app.displayMipMapGen(frame, this.mipMapGenPass);
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

            app.setVsyncEnabled(ui.enableVsync ? 1 : 0);
        }

        // Renders a light probe's cube maps from the camera position (the sample's RenderLightProbe).
        renderLightProbe(index: int): void {
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
                app.isFeatureSupported(Feature.FastGeometryShader) != 0 ? 1 : 0, 1);
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

        onKeyboard(key: int, scancode: int, action: int, mods: int): int {
            if (key == KEY_ESCAPE && action == ACTION_PRESS) {
                this.ui.showUI = !this.ui.showUI;
                return 1;
            }

            if (key == KEY_GRAVE_ACCENT && action == ACTION_PRESS) {
                this.ui.showConsole = !this.ui.showConsole;
                return 1;
            }

            if (key == KEY_SPACE && action == ACTION_PRESS) {
                this.ui.enableAnimations = !this.ui.enableAnimations;
                return 1;
            }

            // As in the other examples (not in the C++ sample): V toggles vertical sync, like the
            // VSync checkbox.
            if (key == KEY_V && action == ACTION_PRESS) {
                this.ui.enableVsync = !this.ui.enableVsync;
                return 1;
            }

            if (key == KEY_T && action == ACTION_PRESS) {
                this.copyActiveCameraToFirstPerson();
                if (!this.ui.activeSceneCamera.isNull()) {
                    this.ui.useThirdPersonCamera = false;
                    this.ui.activeSceneCamera = new SceneCamera(null);
                } else {
                    this.ui.useThirdPersonCamera = !this.ui.useThirdPersonCamera;
                }
                return 1;
            }

            if (this.ui.activeSceneCamera.isNull()) {
                this.getActiveCamera().keyboardUpdate(key, scancode, action, mods);
            }
            return 1;
        }

        onMousePos(x: number, y: number): int {
            if (this.ui.activeSceneCamera.isNull()) {
                this.getActiveCamera().mousePosUpdate(x, y);
            }

            this.pickX = Math.trunc(x);
            this.pickY = Math.trunc(y);

            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            if (this.ui.activeSceneCamera.isNull()) {
                this.getActiveCamera().mouseButtonUpdate(button, action, mods);
            }

            if (action == ACTION_PRESS && button == MOUSE_BUTTON_2) {
                this.pick = true;
            }

            return 1;
        }

        onMouseScroll(xOffset: number, yOffset: number): int {
            if (this.ui.activeSceneCamera.isNull()) {
                this.getActiveCamera().mouseScrollUpdate(xOffset, yOffset);
            }

            return 1;
        }

        onAnimate(elapsedSeconds: number): void {
            if (this.ui.activeSceneCamera.isNull()) {
                this.getActiveCamera().animate(elapsedSeconds);
            }

            const toneMappingPass = this.toneMappingPass;
            if (!toneMappingPass.isNull()) {
                toneMappingPass.advanceFrame(elapsedSeconds);
            }

            const scene = this.scene;
            if (!scene.isNull()) {
                if (this.ui.enableAnimations) {
                    this.wallclockTime += elapsedSeconds;

                    const animationCount = scene.getAnimationCount();
                    for (let i = 0; i < animationCount; i++) {
                        const duration = scene.getAnimationDuration(i);
                        const cycles = this.wallclockTime / duration;
                        const animationTime = (cycles - Math.floor(cycles)) * duration;
                        scene.applyAnimation(i, animationTime);
                    }
                }
            }
        }

        // ApplicationBase::Render: a splash screen until the scene and its textures have loaded.
        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const state = this.sceneLoader.update(frame);
            if (state == SceneLoaderState.Loading) {
                this.renderSplashScreen(frame);
                return;
            }

            if (state == SceneLoaderState.Loaded) {
                this.sceneLoaded();
            }

            this.renderScene(frame);

            if (g_ScreenshotPath != "") {
                this.readyFrames++;
                if (this.readyFrames == SCREENSHOT_FRAME) {
                    this.ui.screenshotFileName = g_ScreenshotPath;
                } else if (this.readyFrames > SCREENSHOT_FRAME) {
                    this.app.closeWindow();
                }
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(sceneName: string): boolean {
            const app = this.app;

            // The whole media folder (the C++ sample lists media/glTF-Sample-Assets/Models only), so
            // that the default scene, media/sponza-plus.scene.json, is in the list too.
            this.sceneDir = `${Donut_GetExecutableDirectory()}/media/`;
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

            this.sceneLoader = app.createSceneLoader();

            // DLSS doesn't need to be re-created when shaders reload, so it's created here and not in
            // createRenderPasses().
            this.dlss = app.createDlss();

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

        checkbox(label: string, value: boolean): boolean {
            return Donut_ImGuiCheckbox(label, value ? 1 : 0) != 0;
        }

        // Scene paths are shown relative to the scene folder.
        getRelativePath(name: string): string {
            const sceneDir = this.demo.sceneDir;
            return name.startsWith(sceneDir) ? name.substring(sceneDir.length) : name;
        }

        buildUI(): void {
            const ui = this.ui;
            const demo = this.demo;
            const app = this.app;

            if (!ui.showUI) {
                return;
            }

            const width = app.getWindowWidth();

            const sceneGraph = demo.sceneGraph;
            if (demo.sceneLoader.isSceneLoading() != 0 || sceneGraph.isNull()) {
                this.imguiPass.beginFullScreenWindow();
                this.fontOpenSans.push();

                demo.sceneLoader.getSceneLoadingStats(Ref(this.loadingStats[0]));
                const stats = this.loadingStats;
                this.imguiPass.drawScreenCenteredText(
                    `Loading scene ${demo.currentSceneName}, please wait...\nObjects: ${stats[0]}/${stats[1]}, Textures: ${stats[2]}/${stats[3]}`);

                Donut_ImGuiPopFont();
                this.imguiPass.endFullScreenWindow();

                return;
            }

            this.fontOpenSans.push();

            // (The console is commented out in the sample too: `~` only toggles ui.showConsole.)

            const fontSize = Donut_ImGuiGetFontSize();

            Donut_ImGuiSetNextWindowPos(fontSize * 0.6, fontSize * 0.6);
            Donut_ImGuiBegin("Settings", 1);
            Donut_ImGuiText(`Renderer: ${app.getRendererString()}`);
            const frameTime = app.getAverageFrameTime();
            if (frameTime > 0.0) {
                Donut_ImGuiText(`${formatFixed(frameTime * 1e3, 3)} ms/frame (${formatFixed(1.0 / frameTime, 1)} FPS)`);
            }

            const currentScene = demo.currentSceneName;
            if (Donut_ImGuiBeginCombo("Scene", this.getRelativePath(currentScene)) != 0) {
                const sceneCount = demo.sceneFilesAvailable.getCount();
                for (let i = 0; i < sceneCount; i++) {
                    const scene = demo.sceneFilesAvailable.getItem(i);
                    const isSelected = scene == currentScene;
                    if (Donut_ImGuiSelectable(this.getRelativePath(scene), isSelected ? 1 : 0) != 0) {
                        demo.setCurrentSceneName(scene);
                    }
                    if (isSelected) {
                        Donut_ImGuiSetItemDefaultFocus();
                    }
                }
                Donut_ImGuiEndCombo();
            }

            if (Donut_ImGuiButton("Reload Shaders") != 0) {
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
            if (Donut_ImGuiBeginCombo("Camera (T)", cameraPreview) != 0) {
                if (Donut_ImGuiSelectable("First-Person", ui.activeSceneCamera.isNull() && !ui.useThirdPersonCamera ? 1 : 0) != 0) {
                    ui.activeSceneCamera = new SceneCamera(null);
                    ui.useThirdPersonCamera = false;
                }
                if (Donut_ImGuiSelectable("Third-Person", ui.activeSceneCamera.isNull() && ui.useThirdPersonCamera ? 1 : 0) != 0) {
                    ui.activeSceneCamera = new SceneCamera(null);
                    ui.useThirdPersonCamera = true;
                    demo.copyActiveCameraToFirstPerson();
                }
                const cameraCount = sceneGraph.getCameraCount();
                for (let i = 0; i < cameraCount; i++) {
                    const camera = sceneGraph.getCamera(i);
                    // The handles: each call wraps the camera in a new object.
                    if (Donut_ImGuiSelectable(camera.getName(), ui.activeSceneCamera.handle == camera.handle ? 1 : 0) != 0) {
                        ui.activeSceneCamera = camera;
                        demo.copyActiveCameraToFirstPerson();
                    }
                }
                Donut_ImGuiEndCombo();
            }

            if (ui.antiAliasingMode == AntiAliasingMode.DLSS && !ui.dlssAvailable) {
                // Fallback to TAA if DLSS is not available
                ui.antiAliasingMode = AntiAliasingMode.TEMPORAL;
            }

            const aaModes: string[] = ["None", "TemporalAA", "DLSS", "MSAA 2x", "MSAA 4x", "MSAA 8x"];
            const aaMode = ui.antiAliasingMode;
            if (Donut_ImGuiBeginCombo("AA Mode", aaModes[aaMode]) != 0) {
                for (let n = 0; n < 6; n++) {
                    if (n == AntiAliasingMode.DLSS && !ui.dlssAvailable) {
                        // Skip DLSS if not available
                        continue;
                    }

                    const isSelected = aaMode == n;
                    if (Donut_ImGuiSelectable(aaModes[n], isSelected ? 1 : 0) != 0) {
                        ui.antiAliasingMode = n;
                    }
                    if (isSelected) {
                        Donut_ImGuiSetItemDefaultFocus();
                    }
                }
                Donut_ImGuiEndCombo();
            }

            ui.temporalAntiAliasingJitter = Donut_ImGuiCombo("TAA Camera Jitter", ui.temporalAntiAliasingJitter, "MSAA|Halton|R2|White Noise");

            ui.ambientIntensity = Donut_ImGuiSliderFloat("Ambient Intensity", ui.ambientIntensity, 0.0, 1.0);

            ui.enableLightProbe = this.checkbox("Enable Light Probe", ui.enableLightProbe);
            if (ui.enableLightProbe && Donut_ImGuiCollapsingHeader("Light Probe") != 0) {
                ui.lightProbeDiffuseScale = Donut_ImGuiDragFloat("Diffuse Scale", ui.lightProbeDiffuseScale, 0.01, 0.0, 10.0);
                ui.lightProbeSpecularScale = Donut_ImGuiDragFloat("Specular Scale", ui.lightProbeSpecularScale, 0.01, 0.0, 10.0);
            }

            ui.enableProceduralSky = this.checkbox("Enable Procedural Sky", ui.enableProceduralSky);
            if (ui.enableProceduralSky && Donut_ImGuiCollapsingHeader("Sky Parameters") != 0) {
                ui.skyBrightness = Donut_ImGuiSliderFloat("Brightness", ui.skyBrightness, 0.0, 1.0);
                ui.skyGlowSize = Donut_ImGuiSliderFloat("Glow Size", ui.skyGlowSize, 0.0, 90.0);
                ui.skyGlowSharpness = Donut_ImGuiSliderFloat("Glow Sharpness", ui.skyGlowSharpness, 1.0, 10.0);
                ui.skyGlowIntensity = Donut_ImGuiSliderFloat("Glow Intensity", ui.skyGlowIntensity, 0.0, 1.0);
                ui.skyHorizonSize = Donut_ImGuiSliderFloat("Horizon Size", ui.skyHorizonSize, 0.0, 90.0);
            }
            ui.enableSsao = this.checkbox("Enable SSAO", ui.enableSsao);
            ui.enableBloom = this.checkbox("Enable Bloom", ui.enableBloom);
            ui.bloomSigma = Donut_ImGuiDragFloat("Bloom Sigma", ui.bloomSigma, 0.01, 0.1, 100.0);
            ui.bloomAlpha = Donut_ImGuiDragFloat("Bloom Alpha", ui.bloomAlpha, 0.01, 0.01, 1.0);
            ui.enableShadows = this.checkbox("Enable Shadows", ui.enableShadows);
            ui.enableTranslucency = this.checkbox("Enable Translucency", ui.enableTranslucency);

            Donut_ImGuiSeparator();
            ui.enableHistoryClamping = this.checkbox("Temporal AA Clamping", ui.enableHistoryClamping);
            ui.enableMaterialEvents = this.checkbox("Material Events", ui.enableMaterialEvents);
            Donut_ImGuiSeparator();

            const lightCount = sceneGraph.getLightCount();
            if (lightCount > 0 && Donut_ImGuiCollapsingHeader("Lights") != 0) {
                const selectedLight = ui.selectedLight;
                if (Donut_ImGuiBeginCombo("Select Light", !selectedLight.isNull() ? selectedLight.getName() : "(None)") != 0) {
                    for (let i = 0; i < lightCount; i++) {
                        const light = sceneGraph.getLight(i);
                        // ImGui::Selectable(label, &selected): a click toggles `selected`.
                        let selected = ui.selectedLight.handle == light.handle;
                        if (Donut_ImGuiSelectable(light.getName(), selected ? 1 : 0) != 0) {
                            selected = !selected;
                        }
                        if (selected) {
                            ui.selectedLight = light;
                            Donut_ImGuiSetItemDefaultFocus();
                        }
                    }
                    Donut_ImGuiEndCombo();
                }

                const light = ui.selectedLight;
                if (!light.isNull()) {
                    light.imGuiEditor();
                }
            }

            Donut_ImGuiText("Render Light Probe: ");
            const probeCount = demo.lightProbes.getCount();
            for (let i = 0; i < probeCount; i++) {
                Donut_ImGuiSameLine();
                if (Donut_ImGuiButton(demo.lightProbes.getName(i)) != 0) {
                    demo.renderLightProbe(i);
                }
            }

            if (Donut_ImGuiButton("Screenshot") != 0) {
                const fileName = Donut_FileDialog(0, "BMP files|*.bmp|All files|*.*");
                if (fileName != "") {
                    // A copy: the dialog's result is overwritten by its next call.
                    ui.screenshotFileName = `${fileName}`;
                }
            }

            Donut_ImGuiSeparator();
            ui.testMipMapGen = this.checkbox("Test MipMapGen Pass", ui.testMipMapGen);
            ui.displayShadowMap = this.checkbox("Display Shadow Map", ui.displayShadowMap);

            Donut_ImGuiEnd();

            const material = ui.selectedMaterial;
            if (!material.isNull()) {
                Donut_ImGuiSetNextWindowPosPivot(width - fontSize * 0.6, fontSize * 0.6, 1.0, 0.0);
                Donut_ImGuiBegin("Material Editor", 0);
                Donut_ImGuiText(`Material ${material.getID()}: ${material.getName()}`);

                const previousDomain = material.getDomain();
                material.setDirty(material.imGuiEditor(1));

                if (previousDomain != material.getDomain()) {
                    sceneGraph.getRootNode().invalidateContent();
                }

                Donut_ImGuiEnd();
            }

            if (ui.antiAliasingMode != AntiAliasingMode.NONE &&
                ui.antiAliasingMode != AntiAliasingMode.TEMPORAL &&
                ui.antiAliasingMode != AntiAliasingMode.DLSS) {
                ui.useDeferredShading = false;
            }

            if (!ui.useDeferredShading) {
                ui.enableSsao = false;
            }

            Donut_ImGuiPopFont();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(): boolean {
            const imguiPass = this.app.addImGuiPass(this.buildUI);
            if (imguiPass.isNull()) {
                return false;
            }
            this.imguiPass = imguiPass;

            this.fontOpenSans = imguiPass.createFont("media/fonts/OpenSans/OpenSans-Regular.ttf", 17.0);
            this.fontDroidMono = imguiPass.createFont("media/fonts/DroidSans/DroidSans-Mono.ttf", 14.0);
            return !this.fontOpenSans.isNull() && !this.fontDroidMono.isNull();
        }
    }

    // --- Main -------------------------------------------------------------------------------

    function printFormats(app: App): void {
        const formatCount = Donut_GetFormatCount();
        for (let format = 0; format < formatCount; format++) {
            const support = app.queryFormatSupport(format);
            let name = Donut_GetFormatName(format);
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

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("feature_demo");
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);

        // ProcessCommandLine
        let width = 1920;
        let height = 1080;
        // Dlss: the Vulkan extensions DLSS needs, if built with it.
        let options = AppOptions.PerMonitorDpi | AppOptions.Dlss;
        let vsync = true;
        let sceneName = "";
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-width") {
                i++;
                width = parseInt(Donut_GetArg(argv, i));
            } else if (arg == "-height") {
                i++;
                height = parseInt(Donut_GetArg(argv, i));
            } else if (arg == "-fullscreen") {
                options = options | AppOptions.Fullscreen;
            } else if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-no-vsync") {
                options = options | AppOptions.NoVsync;
                vsync = false;
            } else if (arg == "-print-graph") {
                g_PrintSceneGraph = true;
            } else if (arg == "-print-formats") {
                g_PrintFormats = true;
            } else if (arg == "-screenshot") {
                i++;
                g_ScreenshotPath = Donut_GetArg(argv, i);
            } else if (!arg.startsWith("-")) {
                sceneName = arg;
            }
        }

        const apiString = Donut_GraphicsAPIToString(api);
        const windowTitle = `Donut Feature Demo (${apiString})`;

        const app = App.createWithOptions(api, windowTitle, width, height, options);
        if (app.isNull()) {
            console.log(`Cannot initialize a ${apiString} graphics device with the requested parameters`);
            return 1;
        }

        if (g_PrintFormats) {
            printFormats(app);
        }

        const uiData = new UIData();
        // The UI applies its VSync setting every frame; in the C++ sample that overrides -no-vsync.
        uiData.enableVsync = vsync;

        const demo = new FeatureDemo(app, uiData);
        if (!demo.init(sceneName)) {
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
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return FeatureDemoExample.main(argc, argv);
}

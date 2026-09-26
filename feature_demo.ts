/// <reference path="donut_interop.d.ts" />

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

    function radians(degrees: number): number {
        return degrees * Math.PI / 180.0;
    }

    // math::perspProjD3DStyleReverse(verticalFOV, aspect, zNear): reverse-Z, infinite far plane;
    // row-major, row-vector convention, into 16 floats.
    function perspProjD3DStyleReverse(dst: f32[], verticalFOV: number, aspect: number, zNear: number): void {
        const yScale = 1.0 / Math.tan(0.5 * verticalFOV);
        const xScale = yScale / aspect;
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
        public selectedMaterial: Opaque | null;
        public selectedNode: Opaque | null;
        public selectedLight: Opaque | null;
        public activeSceneCamera: Opaque | null;
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
            this.selectedMaterial = null;
            this.selectedNode = null;
            this.selectedLight = null;
            this.activeSceneCamera = null;
            this.screenshotFileName = "";
        }
    }

    // --- Renderer ---------------------------------------------------------------------------

    // Port of Donut-Samples' FeatureDemo.cpp (the FeatureDemo class): loads a scene on a thread and
    // renders it with Donut's passes, as the UI configures them.
    class FeatureDemo {
        private app: Opaque;
        private ui: UIData;

        public sceneFilesAvailable: Opaque;
        public currentSceneName: string;
        public sceneDir: string;
        public sceneLoader: Opaque;
        // The loaded scene and its graph; null until the first one has loaded.
        public scene: Opaque | null;
        public sceneGraph: Opaque | null;
        private sunLight: Opaque | null;
        private shadowMap: Opaque;
        private shadowDepthPass: Opaque;
        private renderTargets: Opaque | null;
        private renderTargetsWidth: int;
        private renderTargetsHeight: int;
        private renderTargetsSampleCount: int;
        private forwardPass: Opaque | null;
        private forwardContext: Opaque;
        private gbufferPass: Opaque | null;
        private deferredLightingPass: Opaque | null;
        private skyPass: Opaque | null;
        private temporalAntiAliasingPass: Opaque | null;
        // Null without DLSS support.
        private dlss: Opaque | null;
        private bloomPass: Opaque | null;
        private toneMappingPass: Opaque | null;
        private ssaoPass: Opaque | null;
        private lightProbePass: Opaque | null;
        private materialIdPass: Opaque | null;
        private pixelReadbackPass: Opaque | null;
        private mipMapGenPass: Opaque | null;

        // The views of this frame and the previous one (swapped every frame), planar or stereo.
        private view: Opaque | null;
        private viewPrevious: Opaque | null;
        private viewIsStereo: boolean;

        private previousViewsValid: boolean;
        private firstPersonCamera: Opaque;
        private thirdPersonCamera: Opaque;

        private cameraVerticalFov: number;
        private ambientTop: number[];
        private ambientBottom: number[];
        private pickX: int;
        private pickY: int;
        private pick: boolean;

        public lightProbes: Opaque;

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

        constructor(app: Opaque, ui: UIData) {
            this.app = app;
            this.ui = ui;
            this.currentSceneName = "";
            this.sceneDir = "";
            this.scene = null;
            this.sceneGraph = null;
            this.sunLight = null;
            this.renderTargets = null;
            this.renderTargetsWidth = 0;
            this.renderTargetsHeight = 0;
            this.renderTargetsSampleCount = 0;
            this.forwardPass = null;
            this.gbufferPass = null;
            this.deferredLightingPass = null;
            this.skyPass = null;
            this.temporalAntiAliasingPass = null;
            this.dlss = null;
            this.bloomPass = null;
            this.toneMappingPass = null;
            this.ssaoPass = null;
            this.lightProbePass = null;
            this.materialIdPass = null;
            this.pixelReadbackPass = null;
            this.mipMapGenPass = null;
            this.view = null;
            this.viewPrevious = null;
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

        getActiveCamera(): Opaque {
            return this.ui.useThirdPersonCamera ? this.thirdPersonCamera : this.firstPersonCamera;
        }

        // Loads the node's world-space bounds into this.bounds.
        loadBounds(node: Opaque): void {
            Donut_GetNodeBoundingBox(node, Ref(this.bounds[0]));
        }

        boundsDiagonalLength(): number {
            const dx = this.bounds[3] - this.bounds[0];
            const dy = this.bounds[4] - this.bounds[1];
            const dz = this.bounds[5] - this.bounds[2];
            return Math.sqrt(dx * dx + dy * dy + dz * dz);
        }

        sceneUnloading(): void {
            const forwardPass = this.forwardPass;
            if (forwardPass) {
                Donut_ResetForwardShadingBindingCache(forwardPass);
            }
            const deferredLightingPass = this.deferredLightingPass;
            if (deferredLightingPass) {
                Donut_ResetDeferredLightingBindingCache(deferredLightingPass);
            }
            const gbufferPass = this.gbufferPass;
            if (gbufferPass) {
                Donut_ResetGBufferFillBindingCache(gbufferPass);
            }
            const lightProbePass = this.lightProbePass;
            if (lightProbePass) {
                Donut_ResetLightProbeProcessingCaches(lightProbePass);
            }
            Donut_ResetDepthPassBindingCache(this.shadowDepthPass);
            Donut_ClearBindingCache(this.app);
            this.sunLight = null;
            this.ui.selectedMaterial = null;
            this.ui.selectedNode = null;
            this.ui.selectedLight = null;
            this.ui.activeSceneCamera = null;

            const probeCount = Donut_GetLightProbeCount(this.lightProbes);
            for (let i = 0; i < probeCount; i++) {
                Donut_SetLightProbeEnabled(this.lightProbes, i, 0);
            }
        }

        setCurrentSceneName(sceneName: string): void {
            if (this.currentSceneName == sceneName) {
                return;
            }

            this.currentSceneName = sceneName;

            // BeginLoadingScene
            if (Donut_IsSceneLoaded(this.sceneLoader) != 0) {
                this.sceneUnloading();
            }
            this.scene = null;
            this.sceneGraph = null;
            Donut_BeginLoadingScene(this.sceneLoader, sceneName);
        }

        copyActiveCameraToFirstPerson(): void {
            const sceneCamera = this.ui.activeSceneCamera;
            if (sceneCamera) {
                // Rows of the view-to-world matrix: 1 = up, 2 = forward, 3 = the position.
                Donut_GetSceneCameraViewToWorld(sceneCamera, Ref(this.viewMatrix[0]));
                const m = this.viewMatrix;
                Donut_CameraLookAtWithUp(this.firstPersonCamera, m[12], m[13], m[14],
                    m[12] + m[8], m[13] + m[9], m[14] + m[10], m[4], m[5], m[6]);
            } else if (this.ui.useThirdPersonCamera) {
                Donut_GetCameraPosition(this.thirdPersonCamera, Ref(this.vector1[0]));
                Donut_GetCameraDirection(this.thirdPersonCamera, Ref(this.vector2[0]));
                Donut_GetCameraUp(this.thirdPersonCamera, Ref(this.vector3[0]));
                const p = this.vector1;
                const d = this.vector2;
                const u = this.vector3;
                Donut_CameraLookAtWithUp(this.firstPersonCamera, p[0], p[1], p[2],
                    p[0] + d[0], p[1] + d[1], p[2] + d[2], u[0], u[1], u[2]);
            }
        }

        pointThirdPersonCameraAt(node: Opaque): void {
            this.loadBounds(node);
            const b = this.bounds;
            Donut_ThirdPersonCameraSetTarget(this.thirdPersonCamera,
                (b[0] + b[3]) * 0.5, (b[1] + b[4]) * 0.5, (b[2] + b[5]) * 0.5);
            const radius = this.boundsDiagonalLength() * 0.5;
            const distance = radius / Math.sin(radians(this.cameraVerticalFov * 0.5));
            Donut_ThirdPersonCameraSetDistance(this.thirdPersonCamera, distance);
            Donut_CameraAnimate(this.thirdPersonCamera, 0.0);
        }

        sceneLoaded(): void {
            const scene = Donut_GetLoadedScene(this.sceneLoader);
            const sceneGraph = Donut_GetSceneGraph(scene);
            this.scene = scene;
            this.sceneGraph = sceneGraph;

            this.wallclockTime = 0.0;
            this.previousViewsValid = false;

            const lightCount = Donut_GetSceneGraphLightCount(sceneGraph);
            for (let i = 0; i < lightCount; i++) {
                const light = Donut_GetSceneGraphLight(sceneGraph, i);
                if (Donut_GetLightType(light) == LightType.Directional) {
                    this.sunLight = light;
                    if (Donut_GetDirectionalLightIrradiance(light) <= 0.0) {
                        Donut_SetDirectionalLightIrradiance(light, 1.0);
                    }
                    break;
                }
            }

            if (!this.sunLight) {
                this.sunLight = Donut_AddDirectionalLight(sceneGraph, Donut_GetRootNode(sceneGraph), "Sun",
                    0.1, -0.9, 0.1, 0.53, 1.0);
            }

            if (Donut_GetSceneGraphCameraCount(sceneGraph) > 0) {
                this.ui.activeSceneCamera = Donut_GetSceneGraphCamera(sceneGraph, 0);
            } else {
                this.ui.activeSceneCamera = null;

                Donut_CameraLookAt(this.firstPersonCamera, 0.0, 1.8, 0.0, 1.0, 1.8, 0.0);
                this.cameraVerticalFov = 60.0;
            }

            Donut_ThirdPersonCameraSetRotation(this.thirdPersonCamera, radians(135.0), radians(20.0));
            this.pointThirdPersonCameraAt(Donut_GetRootNode(sceneGraph));

            this.ui.useThirdPersonCamera = this.currentSceneName.endsWith(".gltf") || this.currentSceneName.endsWith(".glb");

            this.copyActiveCameraToFirstPerson();

            if (g_PrintSceneGraph) {
                Donut_PrintSceneGraph(sceneGraph);
            }
        }

        releaseViews(): void {
            const view = this.view;
            if (view) {
                Donut_ReleaseObject(this.app, view);
                this.view = null;
            }
            const viewPrevious = this.viewPrevious;
            if (viewPrevious) {
                Donut_ReleaseObject(this.app, viewPrevious);
                this.viewPrevious = null;
            }
        }

        releaseObject(object: Opaque | null): void {
            if (object) {
                Donut_ReleaseObject(this.app, object);
            }
        }

        // Sets up this.view for the frame; true if it had to be created (then so do the passes).
        setupView(): boolean {
            const width = this.renderTargetsWidth;
            const height = this.renderTargetsHeight;

            const temporalAntiAliasingPass = this.temporalAntiAliasingPass;
            if (temporalAntiAliasingPass) {
                Donut_SetTemporalJitter(temporalAntiAliasingPass, this.ui.temporalAntiAliasingJitter);
            }

            let pixelOffsetX = 0.0;
            let pixelOffsetY = 0.0;
            // (tslang can't mix a boolean and a handle in one condition, hence the nested ifs here.)
            if (this.ui.antiAliasingMode == AntiAliasingMode.TEMPORAL || this.ui.antiAliasingMode == AntiAliasingMode.DLSS) {
                if (temporalAntiAliasingPass) {
                    Donut_GetTemporalPixelOffset(temporalAntiAliasingPass, Ref(this.vector1[0]));
                    pixelOffsetX = this.vector1[0];
                    pixelOffsetY = this.vector1[1];
                }
            }

            let verticalFov = radians(this.cameraVerticalFov);
            let zNear = 0.01;
            const sceneCamera = this.ui.activeSceneCamera;
            if (sceneCamera) {
                const cameraFov = Donut_GetSceneCameraVerticalFov(sceneCamera);
                if (cameraFov >= 0.0) {
                    zNear = Donut_GetSceneCameraZNear(sceneCamera);
                    verticalFov = cameraFov;
                }

                Donut_GetSceneCameraWorldToView(sceneCamera, Ref(this.viewMatrix[0]));
            } else {
                Donut_GetCameraWorldToView(this.getActiveCamera(), Ref(this.viewMatrix[0]));
            }

            let topologyChanged = false;

            if (this.ui.stereo) {
                if (!this.view || !this.viewIsStereo) {
                    this.releaseViews();
                    this.view = Donut_CreateStereoView(this.app);
                    this.viewPrevious = Donut_CreateStereoView(this.app);
                    this.viewIsStereo = true;
                    topologyChanged = true;
                }
                const view = this.view;

                perspProjD3DStyleReverse(this.projMatrix, verticalFov, width / height * 0.5, zNear);

                for (let i = 0; i < 16; i++) {
                    this.rightViewMatrix[i] = this.viewMatrix[i];
                }
                this.rightViewMatrix[12] -= 0.2;

                Donut_SetStereoView(view, Ref(this.viewMatrix[0]), Ref(this.rightViewMatrix[0]), Ref(this.projMatrix[0]),
                    width, height, pixelOffsetX, pixelOffsetY);

                Donut_ThirdPersonCameraSetView(this.thirdPersonCamera, Donut_GetStereoLeftView(view));

                if (topologyChanged) {
                    Donut_CopyStereoView(this.viewPrevious, view);
                }
            } else {
                if (!this.view || this.viewIsStereo) {
                    this.releaseViews();
                    this.view = Donut_CreatePlanarView(this.app);
                    this.viewPrevious = Donut_CreatePlanarView(this.app);
                    this.viewIsStereo = false;
                    topologyChanged = true;
                }
                const view = this.view;

                perspProjD3DStyleReverse(this.projMatrix, verticalFov, width / height, zNear);

                Donut_SetPlanarViewJittered(view, Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height,
                    pixelOffsetX, pixelOffsetY);

                Donut_ThirdPersonCameraSetView(this.thirdPersonCamera, view);

                if (topologyChanged) {
                    Donut_CopyPlanarView(this.viewPrevious, view);
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

            this.releaseObject(this.forwardPass);
            this.releaseObject(this.gbufferPass);
            this.releaseObject(this.materialIdPass);
            this.releaseObject(this.pixelReadbackPass);
            this.releaseObject(this.mipMapGenPass);
            this.releaseObject(this.deferredLightingPass);
            this.releaseObject(this.skyPass);
            this.releaseObject(this.temporalAntiAliasingPass);
            this.releaseObject(this.ssaoPass);
            this.releaseObject(this.lightProbePass);
            this.releaseObject(this.bloomPass);

            this.forwardPass = Donut_CreateForwardShadingPassWithOptions(app, 0, 0);
            this.gbufferPass = Donut_CreateGBufferFillPassWithOptions(app, 1, MOTION_VECTOR_STENCIL_MASK);
            this.materialIdPass = Donut_CreateMaterialIDPass(app, MOTION_VECTOR_STENCIL_MASK);

            this.pixelReadbackPass = Donut_CreatePixelReadbackPass(app, Donut_GetSceneRenderTargetsTexture(targets, SceneTexture.MaterialIDs));
            this.mipMapGenPass = Donut_CreateMipMapGenPass(app, Donut_GetSceneRenderTargetsTexture(targets, SceneTexture.ResolvedColor));

            this.deferredLightingPass = Donut_CreateDeferredLightingPass(app);

            this.skyPass = Donut_CreateSkyPass(app, Donut_GetSceneRenderTargetsFramebuffer(targets, SceneFramebuffer.Forward), view);

            this.temporalAntiAliasingPass = Donut_CreateSceneTemporalAntiAliasingPass(app, view, targets, MOTION_VECTOR_STENCIL_MASK);

            // Multisampled targets have no SSAO (nor deferred shading).
            this.ssaoPass = this.renderTargetsSampleCount == 1 ? Donut_CreateSsaoPass(app, targets) : null;

            this.lightProbePass = Donut_CreateLightProbeProcessingPass(app);

            // The new tone mapping pass takes over the old one's exposure buffer.
            const previousToneMappingPass = this.toneMappingPass;
            if (!previousToneMappingPass) {
                exposureResetRequired = true;
            }
            this.toneMappingPass = Donut_CreateToneMappingPass(app, Donut_GetSceneRenderTargetsFramebuffer(targets, SceneFramebuffer.Ldr),
                view, previousToneMappingPass);
            this.releaseObject(previousToneMappingPass);

            this.bloomPass = Donut_CreateBloomPass(app, Donut_GetSceneRenderTargetsFramebuffer(targets, SceneFramebuffer.Resolved), view);

            const dlss = this.dlss;
            if (dlss) {
                const width = this.renderTargetsWidth;
                const height = this.renderTargetsHeight;
                Donut_InitDlss(dlss, width, height, width, height);

                this.ui.dlssAvailable = Donut_IsDlssInitialized(dlss) != 0;
            }

            this.previousViewsValid = false;
            return exposureResetRequired;
        }

        renderSplashScreen(frame: Opaque): void {
            Donut_ClearColor(frame, 0.0, 0.0, 0.0, 0.0);
            Donut_SetVsyncEnabled(this.app, 1);
        }

        // After the frame's commands have been submitted: finds what the right mouse button clicked.
        finishPick(): void {
            const sceneGraph = this.sceneGraph;
            Donut_ReadPixelUInts(this.pixelReadbackPass, Ref(this.pixel[0]));
            this.ui.selectedMaterial = null;
            this.ui.selectedNode = null;

            const materialCount = Donut_GetSceneGraphMaterialCount(sceneGraph);
            for (let i = 0; i < materialCount; i++) {
                const material = Donut_GetSceneGraphMaterial(sceneGraph, i);
                if (Donut_GetMaterialID(material) == this.pixel[0]) {
                    this.ui.selectedMaterial = material;
                    break;
                }
            }

            const instanceCount = Donut_GetSceneGraphMeshInstanceCount(sceneGraph);
            for (let i = 0; i < instanceCount; i++) {
                if (Donut_GetMeshInstanceIndex(sceneGraph, i) == this.pixel[1]) {
                    this.ui.selectedNode = Donut_GetMeshInstanceNode(sceneGraph, i);
                    break;
                }
            }

            const selectedNode = this.ui.selectedNode;
            if (selectedNode) {
                console.log(`Picked node: ${Donut_GetNodePath(selectedNode)}`);
                this.pointThirdPersonCameraAt(selectedNode);
            } else {
                this.pointThirdPersonCameraAt(Donut_GetRootNode(sceneGraph));
            }
        }

        renderScene(frame: Opaque): void {
            const app = this.app;
            const ui = this.ui;
            const scene = this.scene;
            const sceneGraph = this.sceneGraph;
            const windowWidth = Donut_GetWindowWidth(app);
            const windowHeight = Donut_GetWindowHeight(app);

            // RefreshSceneGraph and RefreshBuffers.
            Donut_RefreshScene(app, frame, scene);

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

                if (!this.renderTargets || this.renderTargetsWidth != windowWidth || this.renderTargetsHeight != windowHeight
                    || this.renderTargetsSampleCount != sampleCount) {
                    this.releaseObject(this.renderTargets);
                    this.renderTargets = null;
                    Donut_ClearBindingCache(app);
                    this.renderTargets = Donut_CreateSceneRenderTargets(app, windowWidth, windowHeight, sampleCount);
                    this.renderTargetsWidth = windowWidth;
                    this.renderTargetsHeight = windowHeight;
                    this.renderTargetsSampleCount = sampleCount;

                    needNewPasses = true;
                }

                if (this.setupView()) {
                    needNewPasses = true;
                }

                if (ui.shaderReloadRequested) {
                    Donut_ClearShaderCache(app);
                    needNewPasses = true;
                }

                if (needNewPasses) {
                    exposureResetRequired = this.createRenderPasses();
                }

                ui.shaderReloadRequested = false;
            }

            const commandList = Donut_GetFrameCommandList(frame);
            const targets = this.renderTargets;
            const view = this.view;
            const viewPrevious = this.viewPrevious;
            const sunLight = this.sunLight;
            const forwardPass = this.forwardPass;
            const toneMappingPass = this.toneMappingPass;
            const temporalAntiAliasingPass = this.temporalAntiAliasingPass;
            const materialEvents = ui.enableMaterialEvents ? 1 : 0;

            Donut_ClearColor(frame, 0.0, 0.0, 0.0, 0.0);

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
                Donut_SetLightShadowMap(sunLight, this.shadowMap);
                this.loadBounds(Donut_GetRootNode(sceneGraph));

                const maxShadowDistance = 100.0;
                const zRange = this.boundsDiagonalLength();
                Donut_SetupShadowMapForView(this.shadowMap, sunLight, view, maxShadowDistance, zRange, ui.csmExponent);

                Donut_ClearShadowMap(commandList, this.shadowMap);

                Donut_RenderShadowDepth(commandList, this.shadowDepthPass, this.shadowMap, sceneGraph, materialEvents);
            } else {
                Donut_SetLightShadowMap(sunLight, null);
            }

            // The forward pass gets the enabled probes of the set.
            if (ui.enableLightProbe) {
                const probeCount = Donut_GetLightProbeCount(this.lightProbes);
                for (let i = 0; i < probeCount; i++) {
                    if (Donut_IsLightProbeEnabled(this.lightProbes, i) != 0) {
                        Donut_SetLightProbeScales(this.lightProbes, i, ui.lightProbeDiffuseScale, ui.lightProbeSpecularScale);
                    }
                }
            }
            const lightProbes = ui.enableLightProbe ? this.lightProbes : null;

            Donut_ClearSceneRenderTargets(commandList, targets);

            if (exposureResetRequired) {
                Donut_ResetExposure(commandList, toneMappingPass, 0.5);
            }

            if (!ui.useDeferredShading || ui.enableTranslucency) {
                Donut_PrepareForwardLights(commandList, forwardPass, this.forwardContext, sceneGraph,
                    top[0], top[1], top[2], bottom[0], bottom[1], bottom[2], lightProbes);
            }

            if (ui.useDeferredShading) {
                Donut_RenderGBufferFill(commandList, this.gbufferPass, view, viewPrevious, targets, sceneGraph, materialEvents);

                const ssaoPass = this.ssaoPass;
                if (ui.enableSsao) {
                    if (ssaoPass) {
                        Donut_RenderSsao(commandList, ssaoPass, view);
                    }
                }

                Donut_RenderDeferredLightingToHdr(commandList, this.deferredLightingPass, view, targets, sceneGraph,
                    ui.enableSsao ? 1 : 0, top[0], top[1], top[2], bottom[0], bottom[1], bottom[2], lightProbes);
            } else {
                Donut_RenderForward(commandList, forwardPass, this.forwardContext, view, viewPrevious,
                    Donut_GetSceneRenderTargetsFramebuffer(targets, SceneFramebuffer.Forward), sceneGraph, 0, "ForwardOpaque", materialEvents);
            }

            if (this.pick) {
                Donut_ClearTextureUInt(commandList, Donut_GetSceneRenderTargetsTexture(targets, SceneTexture.MaterialIDs), 0xffff);

                Donut_RenderMaterialIDs(commandList, this.materialIdPass, view, viewPrevious, targets, sceneGraph, 0);

                if (ui.enableTranslucency) {
                    Donut_RenderMaterialIDs(commandList, this.materialIdPass, view, viewPrevious, targets, sceneGraph, 1);
                }

                Donut_CapturePixel(commandList, this.pixelReadbackPass, this.pickX, this.pickY);
            }

            if (ui.enableProceduralSky) {
                Donut_RenderSky(commandList, this.skyPass, view, sunLight, ui.skyBrightness, ui.skyGlowSize,
                    ui.skyGlowSharpness, ui.skyGlowIntensity, ui.skyHorizonSize);
            }

            if (ui.enableTranslucency) {
                Donut_RenderForward(commandList, forwardPass, this.forwardContext, view, viewPrevious,
                    Donut_GetSceneRenderTargetsFramebuffer(targets, SceneFramebuffer.Forward), sceneGraph, 1, "ForwardTransparent", materialEvents);
            }

            let finalHdrColor = Donut_GetSceneRenderTargetsTexture(targets, SceneTexture.HdrColor);

            if (ui.antiAliasingMode == AntiAliasingMode.TEMPORAL || ui.antiAliasingMode == AntiAliasingMode.DLSS) {
                if (this.previousViewsValid) {
                    Donut_RenderViewMotionVectors(commandList, temporalAntiAliasingPass, view, viewPrevious);
                }

                if (ui.antiAliasingMode == AntiAliasingMode.DLSS) {
                    let evaluated = false;
                    const dlss = this.dlss;
                    if (dlss) {
                        if (Donut_IsDlssInitialized(dlss) != 0 && !ui.stereo) {
                            Donut_EvaluateDlss(commandList, dlss, view, targets, toneMappingPass);
                            evaluated = true;
                        }
                    }

                    if (!evaluated) {
                        // Fallback to TAA if DLSS is not available
                        ui.antiAliasingMode = AntiAliasingMode.TEMPORAL;
                    }
                }

                if (ui.antiAliasingMode == AntiAliasingMode.TEMPORAL) {
                    Donut_TemporalResolveView(commandList, temporalAntiAliasingPass, view, this.previousViewsValid ? 1 : 0,
                        ui.enableHistoryClamping ? 1 : 0);
                }

                finalHdrColor = Donut_GetSceneRenderTargetsTexture(targets, SceneTexture.ResolvedColor);

                if (ui.enableBloom) {
                    Donut_RenderBloom(commandList, this.bloomPass, Donut_GetSceneRenderTargetsFramebuffer(targets, SceneFramebuffer.Resolved),
                        view, finalHdrColor, ui.bloomSigma, ui.bloomAlpha);
                }
                this.previousViewsValid = true;
            } else {
                let finalHdrFramebuffer = Donut_GetSceneRenderTargetsFramebuffer(targets, SceneFramebuffer.Hdr);

                if (this.renderTargetsSampleCount > 1) {
                    const resolvedColor = Donut_GetSceneRenderTargetsTexture(targets, SceneTexture.ResolvedColor);
                    Donut_ResolveTexture(commandList, resolvedColor, finalHdrColor);
                    finalHdrColor = resolvedColor;
                    finalHdrFramebuffer = Donut_GetSceneRenderTargetsFramebuffer(targets, SceneFramebuffer.Resolved);
                }

                if (ui.enableBloom) {
                    Donut_RenderBloom(commandList, this.bloomPass, finalHdrFramebuffer, view, finalHdrColor, ui.bloomSigma, ui.bloomAlpha);
                }

                this.previousViewsValid = false;
            }

            Donut_RenderToneMapping(commandList, toneMappingPass, view, finalHdrColor, exposureResetRequired ? 1 : 0);

            Donut_BlitTexture(app, frame, Donut_GetSceneRenderTargetsTexture(targets, SceneTexture.LdrColor));

            if (ui.testMipMapGen) {
                Donut_DispatchMipMapGen(commandList, this.mipMapGenPass);
                Donut_DisplayMipMapGen(app, frame, this.mipMapGenPass);
            }

            if (ui.displayShadowMap) {
                const shadowMapTexture = Donut_GetShadowMapTexture(this.shadowMap);
                for (let cascade = 0; cascade < 4; cascade++) {
                    Donut_BlitTextureSlice(app, frame, shadowMapTexture, cascade,
                        10.0 + 266.0 * cascade, windowHeight - 266.0, 256.0, 256.0);
                }
            }

            // The C++ sample executes its command list here; the rest needs the results.

            if (ui.screenshotFileName != "") {
                Donut_SaveFrameToFile(app, frame, ui.screenshotFileName);
                ui.screenshotFileName = "";
            }

            if (this.pick) {
                this.pick = false;
                Donut_FlushFrameCommandList(app, frame);
                this.finishPick();
            }

            Donut_AdvanceTemporalFrame(temporalAntiAliasingPass);
            const swappedView = this.view;
            this.view = this.viewPrevious;
            this.viewPrevious = swappedView;

            Donut_SetVsyncEnabled(app, ui.enableVsync ? 1 : 0);
        }

        // Renders a light probe's cube maps from the camera position (the sample's RenderLightProbe).
        renderLightProbe(index: int): void {
            const app = this.app;
            const sceneGraph = this.sceneGraph;
            const sunLight = this.sunLight;
            const lightProbePass = this.lightProbePass;
            if (!sceneGraph || !lightProbePass) {
                return;
            }

            const environmentMapSize = 1024;
            const environmentMapMipLevels = 8;
            const capture = Donut_CreateLightProbeCapture(app, environmentMapSize, environmentMapMipLevels);

            const nearPlane = 0.1;
            const cullDistance = 100.0;
            Donut_GetCameraPosition(this.getActiveCamera(), Ref(this.vector1[0]));
            let probeX = this.vector1[0];
            let probeY = this.vector1[1];
            let probeZ = this.vector1[2];
            const sceneCamera = this.ui.activeSceneCamera;
            if (sceneCamera) {
                // As in the sample: the translation of the world-to-view matrix.
                Donut_GetSceneCameraWorldToView(sceneCamera, Ref(this.viewMatrix[0]));
                probeX = this.viewMatrix[12];
                probeY = this.viewMatrix[13];
                probeZ = this.viewMatrix[14];
            }

            Donut_SetLightProbeCaptureTransform(capture, probeX, probeY, probeZ, nearPlane, cullDistance);
            const view = Donut_GetLightProbeCaptureView(capture);
            const framebuffer = Donut_GetLightProbeCaptureFramebuffer(capture);

            const skyPass = Donut_CreateSkyPass(app, framebuffer, view);

            const forwardPass = Donut_CreateForwardShadingPassWithOptions(app,
                Donut_IsFeatureSupported(app, Feature.FastGeometryShader) != 0 ? 1 : 0, 1);
            const forwardContext = Donut_CreateForwardShadingContext(app);

            const commandList = Donut_CreateCommandList(app);
            Donut_OpenCommandList(commandList);
            Donut_ClearLightProbeCapture(commandList, capture);

            this.loadBounds(Donut_GetRootNode(sceneGraph));
            const zRange = this.boundsDiagonalLength() * 0.5;
            Donut_SetupShadowMapForLightProbeCapture(this.shadowMap, sunLight, capture, cullDistance, zRange, this.ui.csmExponent);
            Donut_ClearShadowMap(commandList, this.shadowMap);

            Donut_RenderShadowDepth(commandList, this.shadowDepthPass, this.shadowMap, sceneGraph, 0);

            const top = this.ambientTop;
            const bottom = this.ambientBottom;
            Donut_PrepareForwardLights(commandList, forwardPass, forwardContext, sceneGraph,
                top[0], top[1], top[2], bottom[0], bottom[1], bottom[2], null);

            Donut_RenderForward(commandList, forwardPass, forwardContext, view, null, framebuffer, sceneGraph, 0, "ForwardOpaque", 0);

            Donut_RenderSky(commandList, skyPass, view, sunLight, this.ui.skyBrightness, this.ui.skyGlowSize,
                this.ui.skyGlowSharpness, this.ui.skyGlowIntensity, this.ui.skyHorizonSize);

            Donut_RenderForward(commandList, forwardPass, forwardContext, view, null, framebuffer, sceneGraph, 1, "ForwardTransparent", 0);

            Donut_GenerateLightProbeCaptureMips(commandList, lightProbePass, capture);

            Donut_RenderLightProbeDiffuse(commandList, lightProbePass, capture, this.lightProbes, index);

            const specularMapMipLevels = Donut_GetLightProbeSpecularMipLevels(this.lightProbes);
            for (let mipLevel = 0; mipLevel < specularMapMipLevels; mipLevel++) {
                const roughness = Math.pow(mipLevel / (specularMapMipLevels - 1), 2.0);
                Donut_RenderLightProbeSpecular(commandList, lightProbePass, capture, this.lightProbes, index, roughness, mipLevel);
            }

            Donut_RenderEnvironmentBrdf(commandList, lightProbePass);

            Donut_CloseCommandList(commandList);
            Donut_ExecuteCommandList(app, commandList);
            Donut_WaitForIdle(app);
            Donut_RunGarbageCollection(app);

            Donut_FinishLightProbe(this.lightProbes, index, lightProbePass, probeX, probeY, probeZ);

            Donut_ReleaseResource(app, commandList);
            Donut_ReleaseObject(app, forwardContext);
            Donut_ReleaseObject(app, forwardPass);
            Donut_ReleaseObject(app, skyPass);
            Donut_ReleaseObject(app, capture);
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
                if (this.ui.activeSceneCamera) {
                    this.ui.useThirdPersonCamera = false;
                    this.ui.activeSceneCamera = null;
                } else {
                    this.ui.useThirdPersonCamera = !this.ui.useThirdPersonCamera;
                }
                return 1;
            }

            if (!this.ui.activeSceneCamera) {
                Donut_CameraKeyboardUpdate(this.getActiveCamera(), key, scancode, action, mods);
            }
            return 1;
        }

        onMousePos(x: number, y: number): int {
            if (!this.ui.activeSceneCamera) {
                Donut_CameraMousePosUpdate(this.getActiveCamera(), x, y);
            }

            this.pickX = Math.trunc(x);
            this.pickY = Math.trunc(y);

            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            if (!this.ui.activeSceneCamera) {
                Donut_CameraMouseButtonUpdate(this.getActiveCamera(), button, action, mods);
            }

            if (action == ACTION_PRESS && button == MOUSE_BUTTON_2) {
                this.pick = true;
            }

            return 1;
        }

        onMouseScroll(xOffset: number, yOffset: number): int {
            if (!this.ui.activeSceneCamera) {
                Donut_CameraMouseScrollUpdate(this.getActiveCamera(), xOffset, yOffset);
            }

            return 1;
        }

        onAnimate(elapsedSeconds: number): void {
            if (!this.ui.activeSceneCamera) {
                Donut_CameraAnimate(this.getActiveCamera(), elapsedSeconds);
            }

            const toneMappingPass = this.toneMappingPass;
            if (toneMappingPass) {
                Donut_AdvanceToneMappingFrame(toneMappingPass, elapsedSeconds);
            }

            const scene = this.scene;
            if (scene) {
                if (this.ui.enableAnimations) {
                    this.wallclockTime += elapsedSeconds;

                    const animationCount = Donut_GetSceneAnimationCount(scene);
                    for (let i = 0; i < animationCount; i++) {
                        const duration = Donut_GetSceneAnimationDuration(scene, i);
                        const cycles = this.wallclockTime / duration;
                        const animationTime = (cycles - Math.floor(cycles)) * duration;
                        Donut_ApplySceneAnimation(scene, i, animationTime);
                    }
                }
            }
        }

        // ApplicationBase::Render: a splash screen until the scene and its textures have loaded.
        onRender(frame: Opaque): void {
            const state = Donut_UpdateSceneLoader(this.sceneLoader, frame);
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
                    Donut_CloseWindow(this.app);
                }
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(sceneName: string): boolean {
            const app = this.app;

            // The whole media folder (the C++ sample lists media/glTF-Sample-Assets/Models only), so
            // that the default scene, media/sponza-plus.scene.json, is in the list too.
            this.sceneDir = `${Donut_GetExecutableDirectory()}/media/`;
            this.sceneFilesAvailable = Donut_FindScenes(app, this.sceneDir);

            const sceneCount = Donut_GetStringListCount(this.sceneFilesAvailable);
            if (sceneName == "" && sceneCount == 0) {
                console.log(`No scene file found in media folder '${this.sceneDir}'`);
                console.log("Please make sure that folder contains valid scene files.");
                return false;
            }

            this.shadowMap = Donut_CreateCascadedShadowMap(app, 2048, 4);
            this.shadowDepthPass = Donut_CreateShadowDepthPass(app, 100, 4.0);

            this.forwardContext = Donut_CreateForwardShadingContext(app);

            this.firstPersonCamera = Donut_CreateFirstPersonCamera(app);
            this.thirdPersonCamera = Donut_CreateThirdPersonCamera(app);
            Donut_CameraSetMoveSpeed(this.firstPersonCamera, 3.0);
            Donut_CameraSetMoveSpeed(this.thirdPersonCamera, 3.0);

            this.sceneLoader = Donut_CreateSceneLoader(app);

            // DLSS doesn't need to be re-created when shaders reload, so it's created here and not in
            // createRenderPasses().
            this.dlss = Donut_CreateDlss(app);

            this.lightProbes = Donut_CreateLightProbeSet(app, 4);

            if (sceneName == "") {
                // app::FindPreferredScene(available, DEFAULT_SCENE): Sponza with two dancing
                // BrainStem robots, as in rt_bindless (the C++ sample prefers Sponza.gltf).
                let preferred = Donut_GetStringListItem(this.sceneFilesAvailable, 0);
                for (let i = 0; i < sceneCount; i++) {
                    const scene = Donut_GetStringListItem(this.sceneFilesAvailable, i);
                    if (scene.indexOf(DEFAULT_SCENE) >= 0) {
                        preferred = scene;
                        break;
                    }
                }
                this.setCurrentSceneName(preferred);
            } else {
                this.setCurrentSceneName(sceneName);
            }

            const pass = Donut_AddPass(app);
            Donut_SetKeyboardCallback(pass, this.onKeyboard);
            Donut_SetMousePosCallback(pass, this.onMousePos);
            Donut_SetMouseButtonCallback(pass, this.onMouseButton);
            Donut_SetMouseScrollCallback(pass, this.onMouseScroll);
            Donut_SetAnimateCallback(pass, this.onAnimate);
            Donut_SetRenderCallback(pass, this.onRender);
            return true;
        }
    }

    // --- UI ---------------------------------------------------------------------------------

    // The sample's UIRenderer: the settings window, the material editor for the picked material, and
    // a loading message while a scene loads.
    class UserInterface {
        private app: Opaque;
        private demo: FeatureDemo;
        private ui: UIData;
        private imguiPass: Opaque;
        private fontOpenSans: Opaque;
        private fontDroidMono: Opaque;
        private loadingStats: int[];

        constructor(app: Opaque, demo: FeatureDemo, ui: UIData) {
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

            const width = Donut_GetWindowWidth(app);

            const sceneGraph = demo.sceneGraph;
            if (Donut_IsSceneLoading(demo.sceneLoader) != 0 || !sceneGraph) {
                Donut_ImGuiBeginFullScreenWindow(this.imguiPass);
                Donut_ImGuiPushFont(this.fontOpenSans);

                Donut_GetSceneLoadingStats(demo.sceneLoader, Ref(this.loadingStats[0]));
                const stats = this.loadingStats;
                Donut_ImGuiDrawScreenCenteredText(this.imguiPass,
                    `Loading scene ${demo.currentSceneName}, please wait...\nObjects: ${stats[0]}/${stats[1]}, Textures: ${stats[2]}/${stats[3]}`);

                Donut_ImGuiPopFont();
                Donut_ImGuiEndFullScreenWindow(this.imguiPass);

                return;
            }

            Donut_ImGuiPushFont(this.fontOpenSans);

            // (The console is commented out in the sample too: `~` only toggles ui.showConsole.)

            const fontSize = Donut_ImGuiGetFontSize();

            Donut_ImGuiSetNextWindowPos(fontSize * 0.6, fontSize * 0.6);
            Donut_ImGuiBegin("Settings", 1);
            Donut_ImGuiText(`Renderer: ${Donut_GetRendererString(app)}`);
            const frameTime = Donut_GetAverageFrameTime(app);
            if (frameTime > 0.0) {
                Donut_ImGuiText(`${formatFixed(frameTime * 1e3, 3)} ms/frame (${formatFixed(1.0 / frameTime, 1)} FPS)`);
            }

            const currentScene = demo.currentSceneName;
            if (Donut_ImGuiBeginCombo("Scene", this.getRelativePath(currentScene)) != 0) {
                const sceneCount = Donut_GetStringListCount(demo.sceneFilesAvailable);
                for (let i = 0; i < sceneCount; i++) {
                    const scene = Donut_GetStringListItem(demo.sceneFilesAvailable, i);
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
            const cameraPreview = activeSceneCamera ? Donut_GetSceneCameraName(activeSceneCamera)
                : ui.useThirdPersonCamera ? "Third-Person" : "First-Person";
            if (Donut_ImGuiBeginCombo("Camera (T)", cameraPreview) != 0) {
                if (Donut_ImGuiSelectable("First-Person", !ui.activeSceneCamera && !ui.useThirdPersonCamera ? 1 : 0) != 0) {
                    ui.activeSceneCamera = null;
                    ui.useThirdPersonCamera = false;
                }
                if (Donut_ImGuiSelectable("Third-Person", !ui.activeSceneCamera && ui.useThirdPersonCamera ? 1 : 0) != 0) {
                    ui.activeSceneCamera = null;
                    ui.useThirdPersonCamera = true;
                    demo.copyActiveCameraToFirstPerson();
                }
                const cameraCount = Donut_GetSceneGraphCameraCount(sceneGraph);
                for (let i = 0; i < cameraCount; i++) {
                    const camera = Donut_GetSceneGraphCamera(sceneGraph, i);
                    if (Donut_ImGuiSelectable(Donut_GetSceneCameraName(camera), ui.activeSceneCamera == camera ? 1 : 0) != 0) {
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

            const lightCount = Donut_GetSceneGraphLightCount(sceneGraph);
            if (lightCount > 0 && Donut_ImGuiCollapsingHeader("Lights") != 0) {
                const selectedLight = ui.selectedLight;
                if (Donut_ImGuiBeginCombo("Select Light", selectedLight ? Donut_GetLightName(selectedLight) : "(None)") != 0) {
                    for (let i = 0; i < lightCount; i++) {
                        const light = Donut_GetSceneGraphLight(sceneGraph, i);
                        // ImGui::Selectable(label, &selected): a click toggles `selected`.
                        let selected = ui.selectedLight == light;
                        if (Donut_ImGuiSelectable(Donut_GetLightName(light), selected ? 1 : 0) != 0) {
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
                if (light) {
                    Donut_ImGuiLightEditor(light);
                }
            }

            Donut_ImGuiText("Render Light Probe: ");
            const probeCount = Donut_GetLightProbeCount(demo.lightProbes);
            for (let i = 0; i < probeCount; i++) {
                Donut_ImGuiSameLine();
                if (Donut_ImGuiButton(Donut_GetLightProbeName(demo.lightProbes, i)) != 0) {
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
            if (material) {
                Donut_ImGuiSetNextWindowPosPivot(width - fontSize * 0.6, fontSize * 0.6, 1.0, 0.0);
                Donut_ImGuiBegin("Material Editor", 0);
                Donut_ImGuiText(`Material ${Donut_GetMaterialID(material)}: ${Donut_GetMaterialName(material)}`);

                const previousDomain = Donut_GetMaterialDomain(material);
                Donut_SetMaterialDirty(material, Donut_ImGuiMaterialEditor(material, 1));

                if (previousDomain != Donut_GetMaterialDomain(material)) {
                    Donut_InvalidateNodeContent(Donut_GetRootNode(sceneGraph));
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
            const imguiPass = Donut_AddImGuiPass(this.app, this.buildUI);
            if (!imguiPass) {
                return false;
            }
            this.imguiPass = imguiPass;

            this.fontOpenSans = Donut_ImGuiCreateFont(imguiPass, "media/fonts/OpenSans/OpenSans-Regular.ttf", 17.0);
            this.fontDroidMono = Donut_ImGuiCreateFont(imguiPass, "media/fonts/DroidSans/DroidSans-Mono.ttf", 14.0);
            return this.fontOpenSans && this.fontDroidMono ? true : false;
        }
    }

    // --- Main -------------------------------------------------------------------------------

    function printFormats(app: Opaque): void {
        const formatCount = Donut_GetFormatCount();
        for (let format = 0; format < formatCount; format++) {
            const support = Donut_QueryFormatSupport(app, format);
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

        const app = Donut_CreateAppWithOptions(api, windowTitle, width, height, options);
        if (!app) {
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
            Donut_DestroyApp(app);
            return 1;
        }

        // Drawn after (over) the scene, and sees the input first.
        const gui = new UserInterface(app, demo, uiData);
        if (!gui.init()) {
            console.log("Cannot initialize the user interface");
            Donut_DestroyApp(app);
            return 1;
        }

        Donut_RunApp(app);
        Donut_DestroyApp(app);
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return FeatureDemoExample.main(argc, argv);
}

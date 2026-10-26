// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck } from "../core/test_check";
import { RtxcrScene } from "../core/rtxcr_scene";
import { perspProjD3DStyleReverse } from "../core/matrix";

// A rasterized rendering of NVIDIA's RTX Character Rendering sample scene (github.com/NVIDIA-RTX/RTXCR),
// beside examples/rtxcr_pathtracer.ts: build with RTXCR_DIR set to a checkout (CMakeLists.txt, the
// pathtracer's license applies) and run with --scene <RTXCR_DIR>/assets/claire.scene.json. This software
// contains source code provided by NVIDIA Corporation.
//
// Donut's forward shading pass draws the scene, the hair as the triangles the pathtracer's tessellation makes
// of the curves (core/rtxcr.cpp: polytubes or DOTS), with no ray tracing: a pixel shader of its own
// (shaders/rtxcr_raster_ps.hlsl, Donut's with hair added) shades the hair materials with RTXCR's far-field
// hair BCSDF under the scene's lights, and everything else is Donut's physically based shading. Each light
// casts shadows from two slices of a shadow map texture: one over the character, one over the hair in detail,
// through which its light falls off with the depth of hair it passes (strands shadow those behind them). The
// strands are thinner than a pixel, so the forward pass is multisampled, or anti-aliased over time instead:
// Donut's temporal anti-aliasing, or NVIDIA DLSS (-dlss, with DONUT_WITH_DLSS) in place of it, both from
// jittered views and motion vectors (single-sample targets). DLSS 5 (-dlss5, DLSS 3D-Guided Neural Rendering,
// DONUT_WITH_DLSS_NR) then enhances the tone-mapped image, guided by the depth and motion vectors. The
// environment map is the background, and the ambient light is a flat sky above and below (not the
// pathtracer's full environment lighting). No subsurface scattering: the skin is plain PBR here.
namespace RtxcrRaster {
    const WINDOW_TITLE = "RTX Character Rendering: Raster";

    // Test mode: the frames rendered.
    const TEST_FRAMES = 4;

    // The sample's TessellationType values that need no ray tracing hardware (LSS does).
    enum HairTessellation {
        Polytube = 0,
        Dots = 1
    }

    // The stencil bit Donut's passes mark the geometry that writes its own motion vectors with; none does here.
    const MOTION_VECTOR_STENCIL_MASK = 0x01;

    const SHADOW_MAP_RESOLUTION = 4096;
    const SHADOW_FADE_RANGE = 0.5;
    // A light's shadow map slices: one over the character, one over her hair in detail (the shader's light
    // through the hair).
    const SHADOW_SLICES_PER_LIGHT = 2;

    // MSAA is the multisampled forward pass; the others resolve single-sample targets over time.
    enum AntiAliasingMode {
        MSAA = 0,
        TEMPORAL = 1,
        DLSS = 2
    }

    // The scale of the lights' irradiances (the scene's: claire.scene.json's key, fill and rim lights), and the
    // sky's light from above and below.
    class Settings {
        enableShadows = true;
        exposure = 0.8;
        ambientTop = 0.15;
        ambientBottom = 0.06;
        lightScale = 0.45;
        frameSeconds = 0.0;
        antiAliasingMode: int = AntiAliasingMode.MSAA;
        // Set once DLSS, and DLSS-NR initialize (built with DONUT_WITH_DLSS(_NR), on an RTX GPU).
        dlssAvailable = false;
        dlssNeuralRenderingAvailable = false;
        // RTX Remix's defaults (rtx.dlssNeuralRendering.*), as examples/feature_demo.ts.
        enableDlssNeuralRendering = false;
        dlssNeuralRenderingModel: int = 0;
        dlssNeuralRenderingIntensity = 1.0;
        dlssNeuralRenderingStructureStrength = 0.7;
        dlssNeuralRenderingToneStrength = 0.3;
        dlssNeuralRenderingUseAutoMask = true;
        dlssNeuralRenderingSkinStrength = 0.5;
    }

    // -test: checks the last frame: the lit head and the environment around it, and the dark hair.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        const lit = check.share(total - check.countInRange(0, 3, 0, 3, 0, 3, 0, 0, check.width, check.height), total,
            50.0, 100.0, "Lit");
        if (lit != "") {
            return lit;
        }
        // The hair, the glasses and the eyes are dark against the sky, the skin and the shirt.
        return check.share(check.countInRange(0, 90, 0, 90, 0, 90, 0, 0, check.width, check.height), total,
            0.5, 25.0, "Dark");
    }

    function directoryOf(path: string): string {
        let end = path.lastIndexOf("/");
        const backslash = path.lastIndexOf("\\");
        if (backslash > end) {
            end = backslash;
        }
        return path.substring(0, end + 1);
    }

    // --- Settings window -----------------------------------------------------------------------

    class UserInterface {
        private settings: Settings;

        constructor(settings: Settings) {
            this.settings = settings;
        }

        init(app: App) {
            return !app.addImGuiPass(this.buildUI).isNull();
        }

        buildUI() {
            const s = this.settings;
            ImGui.setNextWindowPos(10.0, 10.0);
            ImGui.begin("RTX Character Rendering (raster)", true);
            const seconds = s.frameSeconds;
            ImGui.text(`${seconds > 0.0 ? Math.round(1.0 / seconds) : 0} FPS`);
            s.enableShadows = ImGui.checkbox("Shadows (Space)", s.enableShadows);
            s.exposure = ImGui.sliderFloat("Exposure", s.exposure, 0.05, 4.0);
            s.lightScale = ImGui.sliderFloat("Light intensity", s.lightScale, 0.0, 2.0);
            s.ambientTop = ImGui.sliderFloat("Sky light above", s.ambientTop, 0.0, 2.0);
            s.ambientBottom = ImGui.sliderFloat("Sky light below", s.ambientBottom, 0.0, 2.0);
            s.antiAliasingMode = ImGui.combo("Anti-aliasing", s.antiAliasingMode,
                s.dlssAvailable ? "MSAA|TemporalAA|DLSS" : "MSAA|TemporalAA");
            if (s.dlssNeuralRenderingAvailable) {
                // As RTX Remix's DLSS 3D-Guided Neural Rendering settings.
                s.enableDlssNeuralRendering = ImGui.checkbox("DLSS 5 (Neural Rendering)", s.enableDlssNeuralRendering);
                if (s.enableDlssNeuralRendering) {
                    if (s.antiAliasingMode == AntiAliasingMode.MSAA) {
                        ImGui.text("Needs the TemporalAA or DLSS anti-aliasing");
                    }
                    s.dlssNeuralRenderingModel = ImGui.combo("Model", s.dlssNeuralRenderingModel, "Model A|Model B|Model C");
                    s.dlssNeuralRenderingIntensity = ImGui.sliderFloat("Intensity", s.dlssNeuralRenderingIntensity, 0.0, 1.0);
                    s.dlssNeuralRenderingStructureStrength = ImGui.sliderFloat("Structure Intensity",
                        s.dlssNeuralRenderingStructureStrength, 0.0, 1.0);
                    s.dlssNeuralRenderingToneStrength = ImGui.sliderFloat("Tone Intensity",
                        s.dlssNeuralRenderingToneStrength, 0.0, 1.0);
                    s.dlssNeuralRenderingUseAutoMask = ImGui.checkbox("Auto Mask", s.dlssNeuralRenderingUseAutoMask);
                    if (s.dlssNeuralRenderingUseAutoMask) {
                        s.dlssNeuralRenderingSkinStrength = ImGui.sliderFloat("Character Intensity",
                            s.dlssNeuralRenderingSkinStrength, 0.0, 1.0);
                    }
                }
            }
            ImGui.end();
        }
    }

    // --- Renderer ----------------------------------------------------------------------------

    class Renderer {
        private app: App;
        private settings: Settings;
        private scenePath: string;
        private hairTessellationType: int;
        private hairRadiusScale: number;
        // The forward pass's samples per pixel: strands thinner than a pixel cover some of its samples. The
        // MSAA mode's (-msaa); the temporal modes render one.
        private msaaSamples: int;
        private sampleCount: int;
        private bindlessLayout: BindingLayoutHandle;
        private descriptorTableManager: DescriptorTableManager;
        private scene: Scene;
        private rtxcrScene: RtxcrScene;
        private sceneGraph: SceneGraph;
        // The directional lights, each with a shadow map in slices of one texture, and their scene irradiances.
        private lights: Light[];
        private lightIrradiances: number[];
        private shadowMaps: ShadowMap[];
        private camera: Camera;
        private view: View;
        private sceneCameraVerticalFov: number;
        private sceneCameraZNear: number;
        private environmentMap: TextureHandle;
        // What the shadow map's cascade and its per-object shadow cover: findMeshBounds.
        private characterBounds: f32[];
        private hairBounds: f32[];
        private shadowDepthPass: DepthPass;
        private shadowMapValid: boolean;
        private lastEnableShadows: boolean;
        private forwardPass: ForwardShadingPass;
        private forwardContext: ForwardShadingContextHandle;
        // Created on the first frame, again when the window's size changes.
        private renderTargets: SceneRenderTargets;
        private renderTargetsWidth: int;
        private renderTargetsHeight: int;
        private environmentMapPass: EnvironmentMapPassHandle | null;
        private toneMappingPass: ToneMappingPass;
        private lastExposure: number;
        // Passed to View.setPlanarView, 16 floats each.
        private viewMatrix: f32[];
        private projMatrix: f32[];
        // The temporal modes: last frame's view for the motion vectors, the jitter of this frame's, and the
        // passes that resolve over time. The DLSS handles are null without DLSS support.
        private viewPrevious: View;
        private previousViewValid: boolean;
        private temporalAntiAliasingPass: TemporalAntiAliasingPass;
        private pixelOffset: f32[];
        private dlss: Dlss;
        private dlssNeuralRendering: DlssNeuralRendering;
        // Whether DLSS-NR ran last frame (else it resets its history).
        private dlssNeuralRenderingActive: boolean;

        constructor(app: App, settings: Settings, scenePath: string, hairTessellationType: int, hairRadiusScale: number,
            msaaSamples: int) {
            this.app = app;
            this.settings = settings;
            this.scenePath = scenePath;
            this.hairTessellationType = hairTessellationType;
            this.hairRadiusScale = hairRadiusScale;
            this.msaaSamples = msaaSamples;
            this.sampleCount = msaaSamples;
            this.viewPrevious = new View(null);
            this.previousViewValid = false;
            this.temporalAntiAliasingPass = new TemporalAntiAliasingPass(null);
            this.pixelOffset = [0.0, 0.0];
            this.dlss = new Dlss(null);
            this.dlssNeuralRendering = new DlssNeuralRendering(null);
            this.dlssNeuralRenderingActive = false;
            this.shadowMapValid = false;
            this.lastEnableShadows = settings.enableShadows;
            this.lights = [];
            this.lightIrradiances = [];
            this.shadowMaps = [];
            this.characterBounds = [];
            this.hairBounds = [];
            this.renderTargets = new SceneRenderTargets(null);
            this.renderTargetsWidth = 0;
            this.renderTargetsHeight = 0;
            this.environmentMapPass = null;
            this.toneMappingPass = new ToneMappingPass(null);
            this.lastExposure = -1.0;
            this.viewMatrix = [];
            this.projMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
                this.projMatrix.push(0.0);
            }
        }

        init() {
            // The scene's buffers are uploaded by RtxcrScene after the hair curves are tessellated; the
            // bindless table is what the loader puts the scene's textures in.
            const bindlessLayoutDesc = BindlessLayoutDesc.create(0, 1024, ShaderType.All);
            bindlessLayoutDesc.addRawBuffers(2);
            bindlessLayoutDesc.addTextures(3);
            this.bindlessLayout = this.app.createBindlessLayout(bindlessLayoutDesc);
            this.descriptorTableManager = this.app.createDescriptorTableManager(this.bindlessLayout);

            const scene = this.app.loadSceneWithDescriptorTableDeferred(this.scenePath, this.descriptorTableManager);
            if (scene.isNull()) {
                console.log(`Cannot load the scene ${this.scenePath}`);
                return false;
            }
            this.scene = scene;
            this.rtxcrScene = RtxcrScene.create(this.app.getNvrhiDevice(), scene.handle, this.descriptorTableManager.handle,
                this.hairRadiusScale, this.hairTessellationType);
            this.sceneGraph = scene.getSceneGraph();

            // The scene's directional lights, else the pathtracer's default sun.
            const lightCount = this.sceneGraph.getLightCount();
            for (let i = 0; i < lightCount; i++) {
                const light = this.sceneGraph.getLight(i);
                if (light.getType() == LightType.Directional) {
                    this.lights.push(light);
                }
            }
            if (this.lights.length == 0) {
                this.lights.push(this.sceneGraph.addDirectionalLight(this.sceneGraph.getRootNode(), "Sun",
                    -0.791, -0.259, -0.554, 0.8, 20.0));
                this.app.refreshSceneGraph(this.sceneGraph);
            }
            for (const light of this.lights) {
                this.lightIrradiances.push(light.getDirectionalIrradiance());
            }

            // The camera: the scene's DefaultCamera, or the first one.
            this.camera = this.app.createFirstPersonCamera();
            this.camera.setMoveSpeed(50.0);
            const cameraCount = this.sceneGraph.getCameraCount();
            if (cameraCount > 0) {
                let sceneCamera = this.sceneGraph.getCamera(0);
                for (let i = 0; i < cameraCount; i++) {
                    if (this.sceneGraph.getCamera(i).getName() == "DefaultCamera") {
                        sceneCamera = this.sceneGraph.getCamera(i);
                    }
                }
                // The pathtracer's choice: the first camera's lens, whichever camera's pose.
                this.sceneCameraVerticalFov = this.sceneGraph.getCamera(0).getVerticalFov();
                this.sceneCameraZNear = this.sceneGraph.getCamera(0).getZNear();
                const viewToWorld: f32[] = [];
                for (let i = 0; i < 16; i++) {
                    viewToWorld.push(0.0);
                }
                sceneCamera.getViewToWorld(Ref(viewToWorld[0]));
                // The rows of the view-to-world matrix: right, up, forward, position.
                const px = viewToWorld[12];
                const py = viewToWorld[13];
                const pz = viewToWorld[14];
                this.camera.lookAtWithUp(px, py, pz, px + viewToWorld[8], py + viewToWorld[9], pz + viewToWorld[10],
                    viewToWorld[4], viewToWorld[5], viewToWorld[6]);
            } else {
                this.sceneCameraVerticalFov = 1.0;
                this.sceneCameraZNear = 0.1;
                this.camera.lookAt(0.0, 1.8, 0.0, 1.0, 1.8, 0.0);
            }
            this.view = this.app.createPlanarView();
            this.viewPrevious = this.app.createPlanarView();

            // Once: DLSS-NR shares the NGX instance of DLSS, and neither depends on the targets' passes.
            this.dlss = this.app.createDlss();
            this.dlssNeuralRendering = this.app.createDlssNeuralRendering(this.dlss);

            // The environment map beside the scene's assets.
            const envMap = this.app.loadBindlessTexture(this.descriptorTableManager,
                directoryOf(this.scenePath) + "EnvironmentMaps/venice_sunset_1k.exr", 0);
            if (envMap.isNull()) {
                console.log("Cannot load the environment map");
                return false;
            }
            this.environmentMap = envMap.getTexture();

            this.characterBounds = this.findMeshBounds(false);
            this.hairBounds = this.findMeshBounds(true);
            // All the lights' shadow maps in one texture: the forward pass binds one for all lights.
            const shadowSlices = this.lights.length * SHADOW_SLICES_PER_LIGHT;
            for (let i = 0; i < this.lights.length; i++) {
                this.shadowMaps.push(i == 0
                    ? this.app.createSlicedShadowMap(SHADOW_MAP_RESOLUTION, shadowSlices, SHADOW_SLICES_PER_LIGHT)
                    : this.app.createSlicedShadowMapSharing(this.shadowMaps[0], i * SHADOW_SLICES_PER_LIGHT,
                        SHADOW_SLICES_PER_LIGHT));
            }
            this.shadowDepthPass = this.app.createShadowDepthPass(100, 4.0);

            // Donut's forward pass with the pixel shader of shaders/rtxcr_raster.cfg.
            this.forwardPass = this.app.createForwardShadingPassWithPixelShader("rtxcr_raster_ps.hlsl", 16);
            this.forwardContext = this.app.createForwardShadingContext();

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

        // The world-space bounds of the character's meshes (all but the props around her: the reflection discs
        // below, the bounce card) or of her hair (the curves and the eyebrows).
        findMeshBounds(hair: boolean): f32[] {
            const bounds: f32[] = [1e30, 1e30, 1e30, -1e30, -1e30, -1e30];
            const nodeBounds: f32[] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
            const count = this.sceneGraph.getMeshInstanceCount();
            for (let i = 0; i < count; i++) {
                const node = this.sceneGraph.getMeshInstanceNode(i);
                const path = node.getPath();
                const isProp = path.indexOf("reflection_discs") >= 0 || path.indexOf("bounce_card") >= 0;
                const isHair = path.indexOf("ClaireHair") >= 0 || path.indexOf("eyebrows") >= 0;
                if (hair ? !isHair : isProp) {
                    continue;
                }
                node.getBoundingBox(Ref(nodeBounds[0]));
                for (let axis = 0; axis < 3; axis++) {
                    if (nodeBounds[axis] < bounds[axis]) {
                        bounds[axis] = nodeBounds[axis];
                    }
                    if (nodeBounds[axis + 3] > bounds[axis + 3]) {
                        bounds[axis + 3] = nodeBounds[axis + 3];
                    }
                }
            }
            return bounds;
        }

        shutdown() {
            this.app.waitForIdle();
            this.rtxcrScene.destroy();
        }

        onKey(key: Key, scancode: ScanCode, action: Action, mods: KeyMods) {
            this.camera.keyboardUpdate(key, scancode, action, mods);
            if (key == Key.Space && action == Action.Press) {
                this.settings.enableShadows = !this.settings.enableShadows;
            }
            return 1;
        }

        onMousePos(x: number, y: number) {
            this.camera.mousePosUpdate(x, y);
            return 1;
        }

        onMouseButton(button: MouseButton, action: Action, mods: KeyMods) {
            this.camera.mouseButtonUpdate(button, action, mods);
            return 1;
        }

        onMouseScroll(xOffset: number, yOffset: number) {
            this.camera.mouseScrollUpdate(xOffset, yOffset);
            return 1;
        }

        onAnimate(elapsedSeconds: number) {
            this.camera.animate(elapsedSeconds);
            this.settings.frameSeconds = this.app.getAverageFrameTime();
        }

        onBackBufferResizing() {
            // The blit's cached binding sets reference the old LDR color texture.
            this.app.clearBindingCache();
        }

        // The targets and the passes made for their framebuffers.
        createRenderTargets(width: int, height: int, sampleCount: int) {
            if (!this.renderTargets.isNull()) {
                this.app.releaseObject(this.renderTargets.handle);
            }
            const environmentMapPass = this.environmentMapPass;
            if (environmentMapPass) {
                this.app.releaseObject(environmentMapPass);
            }
            if (!this.temporalAntiAliasingPass.isNull()) {
                this.app.releaseObject(this.temporalAntiAliasingPass.handle);
            }
            // The blit's and the passes' cached binding sets reference the old textures.
            this.app.clearBindingCache();

            const targets = this.app.createSceneRenderTargets(width, height, sampleCount);
            this.renderTargets = targets;
            this.renderTargetsWidth = width;
            this.renderTargetsHeight = height;
            this.sampleCount = sampleCount;
            this.temporalAntiAliasingPass = this.app.createSceneTemporalAntiAliasingPass(this.view, targets,
                MOTION_VECTOR_STENCIL_MASK);
            this.previousViewValid = false;

            // DLSS as 1:1 anti-aliasing; DLSS-NR enhances the image of the same size.
            const dlss = this.dlss;
            if (!dlss.isNull()) {
                dlss.init(width, height, width, height);
                this.settings.dlssAvailable = dlss.isInitialized();
            }
            const dlssNeuralRendering = this.dlssNeuralRendering;
            if (!dlssNeuralRendering.isNull()) {
                this.settings.dlssNeuralRenderingAvailable = dlssNeuralRendering.init(width, height) != 0;
            }

            this.environmentMapPass = this.app.createEnvironmentMapPass(targets.getFramebuffer(SceneFramebuffer.Forward),
                this.view, this.environmentMap);

            // The new tone mapping pass takes over the old one's exposure.
            const previousToneMappingPass = this.toneMappingPass;
            this.toneMappingPass = this.app.createToneMappingPass(targets.getFramebuffer(SceneFramebuffer.Ldr),
                this.view, previousToneMappingPass.isNull() ? null : previousToneMappingPass);
            if (!previousToneMappingPass.isNull()) {
                this.app.releaseObject(previousToneMappingPass.handle);
            }
            this.lastExposure = -1.0;
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const settings = this.settings;

            this.camera.getWorldToView(Ref(this.viewMatrix[0]));
            const projection = perspProjD3DStyleReverse(this.sceneCameraVerticalFov, width / height, this.sceneCameraZNear);
            for (let i = 0; i < 16; i++) {
                this.projMatrix[i] = projection[i];
            }
            this.view.setPlanarView(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);

            // The targets say whether DLSS is available (when made): without it, TAA does the job.
            const sampleCount = settings.antiAliasingMode == AntiAliasingMode.MSAA ? this.msaaSamples : 1;
            if (this.renderTargets.isNull() || this.renderTargetsWidth != width || this.renderTargetsHeight != height ||
                this.sampleCount != sampleCount) {
                this.createRenderTargets(width, height, sampleCount);
            }
            if (settings.antiAliasingMode == AntiAliasingMode.DLSS && !settings.dlssAvailable) {
                settings.antiAliasingMode = AntiAliasingMode.TEMPORAL;
            }
            const temporal = settings.antiAliasingMode != AntiAliasingMode.MSAA;
            const taaPass = this.temporalAntiAliasingPass;
            if (temporal) {
                // This frame's sub-pixel offset of the projection: what the temporal passes integrate over.
                taaPass.setJitter(TemporalJitter.Halton);
                taaPass.getPixelOffset(Ref(this.pixelOffset[0]));
                this.view.setPlanarViewJittered(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height,
                    this.pixelOffset[0], this.pixelOffset[1]);
            }
            if (!this.previousViewValid) {
                this.viewPrevious.copyPlanarView(this.view);
            }

            const commandList = frame.getCommandList();
            const targets = this.renderTargets;
            const sceneGraph = this.sceneGraph;
            // Scaled to look as bright as the pathtracer's frame (its lighting is not Donut's irradiance).
            for (let i = 0; i < this.lights.length; i++) {
                this.lights[i].setDirectionalIrradiance(this.lightIrradiances[i] * settings.lightScale);
            }

            // The animated hair's vertex buffers are drawn from the state they rest in.
            this.rtxcrScene.beginMorphVertexBuffers(commandList.handle);

            // The scene and the lights don't move: one rendering of the shadow maps does.
            let shadowsChanged = !this.shadowMapValid;
            for (let i = 0; i < this.lights.length; i++) {
                const light = this.lights[i];
                const shadowMap = this.shadowMaps[i];
                // Always bound: its second slice is the light through the hair, which the hair's look needs.
                light.setShadowMap(shadowMap);
                if (shadowMap.setupViewForBounds(light, 0, Ref(this.characterBounds[0]), SHADOW_FADE_RANGE) != 0) {
                    shadowsChanged = true;
                }
                if (shadowMap.setupViewForBounds(light, 1, Ref(this.hairBounds[0]), SHADOW_FADE_RANGE) != 0) {
                    shadowsChanged = true;
                }
            }
            if (settings.enableShadows != this.lastEnableShadows) {
                shadowsChanged = true;
                this.lastEnableShadows = settings.enableShadows;
            }
            if (shadowsChanged) {
                // Shadows off leaves the first slice (the character's cast shadows) empty: only the strands
                // still shadow each other.
                for (const shadowMap of this.shadowMaps) {
                    commandList.clearShadowMap(shadowMap);
                    if (settings.enableShadows) {
                        commandList.renderShadowDepth(this.shadowDepthPass, shadowMap, sceneGraph, 0);
                    }
                    commandList.renderShadowDepthView(this.shadowDepthPass, shadowMap, 1, sceneGraph);
                }
                this.shadowMapValid = true;
            }

            commandList.clearSceneRenderTargets(targets);

            const top = settings.ambientTop;
            const bottom = settings.ambientBottom;
            commandList.prepareForwardLights(this.forwardPass, this.forwardContext, sceneGraph,
                top, top, top, bottom, bottom, bottom, null);
            const previousView = temporal ? this.viewPrevious : null;
            commandList.renderForward(this.forwardPass, this.forwardContext, this.view, previousView,
                targets.getFramebuffer(SceneFramebuffer.Forward), sceneGraph, 0, "ForwardOpaque", 0);

            // Behind everything opaque, before what is transparent.
            commandList.renderEnvironmentMap(this.environmentMapPass as EnvironmentMapPassHandle, this.view);

            commandList.renderForward(this.forwardPass, this.forwardContext, this.view, previousView,
                targets.getFramebuffer(SceneFramebuffer.Forward), sceneGraph, 1, "ForwardTransparent", 0);

            if (settings.exposure != this.lastExposure) {
                commandList.resetExposure(this.toneMappingPass, settings.exposure);
                this.lastExposure = settings.exposure;
            }
            let hdrColor = targets.getTexture(SceneTexture.HdrColor);
            // DLSS-NR's history: last frame's view (the temporal modes set it below).
            const historyValid = this.previousViewValid;
            if (temporal) {
                if (this.previousViewValid) {
                    commandList.renderViewMotionVectors(taaPass, this.view, this.viewPrevious);
                }
                if (settings.antiAliasingMode == AntiAliasingMode.DLSS) {
                    commandList.evaluateDlss(this.dlss, this.view, targets, this.toneMappingPass);
                } else {
                    commandList.temporalResolveView(taaPass, this.view, this.previousViewValid ? 1 : 0, 1);
                }
                hdrColor = targets.getTexture(SceneTexture.ResolvedColor);
            } else if (this.sampleCount > 1) {
                const resolvedColor = targets.getTexture(SceneTexture.ResolvedColor);
                commandList.resolveTexture(resolvedColor, hdrColor);
                hdrColor = resolvedColor;
            }
            // Adapting over a frame time of 0: the exposure stays what the window says.
            commandList.renderToneMapping(this.toneMappingPass, this.view, hdrColor, 0);

            // DLSS 5 over the tone-mapped image, guided by the depth and motion vectors that only the
            // temporal modes have (single-sample).
            const dlssNeuralRendering = this.dlssNeuralRendering;
            const runDlssNeuralRendering = settings.enableDlssNeuralRendering && temporal && !dlssNeuralRendering.isNull() &&
                dlssNeuralRendering.isInitialized();
            if (runDlssNeuralRendering) {
                const reset = !historyValid || !this.dlssNeuralRenderingActive;
                commandList.evaluateDlssNeuralRendering(dlssNeuralRendering, this.view, targets, settings.dlssNeuralRenderingIntensity,
                    settings.dlssNeuralRenderingToneStrength, settings.dlssNeuralRenderingStructureStrength,
                    settings.dlssNeuralRenderingModel, settings.dlssNeuralRenderingUseAutoMask ? 1 : 0,
                    settings.dlssNeuralRenderingSkinStrength, reset ? 1 : 0);
            }
            this.dlssNeuralRenderingActive = runDlssNeuralRendering;

            this.rtxcrScene.endMorphVertexBuffers(commandList.handle);

            this.app.blitTexture(frame, targets.getTexture(SceneTexture.LdrColor));

            // The next frame's motion vectors are relative to this frame's view.
            taaPass.advanceFrame();
            this.viewPrevious.copyPlanarView(this.view);
            this.previousViewValid = temporal;
        }
    }

    class RtxcrRasterArgs extends Args {
        // -hairTessellationType <0 polytubes, 1 DOTS>: DOTS' flat strips turn edge-on to the camera, and the
        // hair thins out where they do.
        hairTessellationType: int = HairTessellation.Polytube;
        // -hairRadiusScale <scale>: the sample's ui.hairRadiusScale.
        hairRadiusScale: number = 0.618;
        // -msaa <samples per pixel>
        msaa: int = 8;
        // -taa: temporal anti-aliasing instead of MSAA; -dlss: DLSS instead (TAA without it); -dlss5: with
        // DLSS 5 (DLSS-NR) on where available, over DLSS unless -taa is given.
        taa = false;
        dlss = false;
        dlss5 = false;
        // -nrModel <0-2>, -nrIntensity, -nrStructure, -nrTone, -nrSkin <0-1>, -noAutoMask: the DLSS 5 settings of the UI.
        nrModel: int = 0;
        nrIntensity = 1.0;
        nrStructure = 0.7;
        nrTone = 0.3;
        nrSkin = 0.5;
        noAutoMask = false;
        // -width / -height of the window.
        width: int = 1920;
        height: int = 1080;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-hairTessellationType") {
                    i++;
                    this.hairTessellationType = parseInt(this[i]);
                } else if (arg == "-hairRadiusScale") {
                    i++;
                    this.hairRadiusScale = parseFloat(this[i]);
                } else if (arg == "-msaa") {
                    i++;
                    this.msaa = parseInt(this[i]);
                } else if (arg == "-width") {
                    i++;
                    this.width = parseInt(this[i]);
                } else if (arg == "-height") {
                    i++;
                    this.height = parseInt(this[i]);
                } else if (arg == "-taa") {
                    this.taa = true;
                } else if (arg == "-dlss") {
                    this.dlss = true;
                } else if (arg == "-dlss5") {
                    this.dlss5 = true;
                } else if (arg == "-nrModel") {
                    i++;
                    this.nrModel = parseInt(this[i]);
                } else if (arg == "-nrIntensity") {
                    i++;
                    this.nrIntensity = parseFloat(this[i]);
                } else if (arg == "-nrStructure") {
                    i++;
                    this.nrStructure = parseFloat(this[i]);
                } else if (arg == "-nrTone") {
                    i++;
                    this.nrTone = parseFloat(this[i]);
                } else if (arg == "-nrSkin") {
                    i++;
                    this.nrSkin = parseFloat(this[i]);
                } else if (arg == "-noAutoMask") {
                    this.noAutoMask = true;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        Program.setAppName("rtxcr_raster");

        const args = new RtxcrRasterArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        if (args.scenePath == "") {
            console.log("Pass the scene with --scene <RTXCR_DIR>/assets/claire.scene.json");
            return 1;
        }
        if (args.hairTessellationType != HairTessellation.Polytube && args.hairTessellationType != HairTessellation.Dots) {
            console.log("The hair is polytubes (0) or DOTS (1) here: linear swept spheres need ray tracing");
            return 1;
        }

        // Dlss: the Vulkan extensions DLSS needs, if built with it.
        const app = App.createWithOptions(args.api, WINDOW_TITLE, args.width, args.height, AppOptions.Dlss | args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        console.log(`Renderer: ${app.getRendererString()}`);

        const settings = new Settings();
        // DLSS falls back to TAA, and DLSS 5 to off, without support.
        if (args.taa) {
            settings.antiAliasingMode = AntiAliasingMode.TEMPORAL;
        }
        if (args.dlss || (args.dlss5 && !args.taa)) {
            settings.antiAliasingMode = AntiAliasingMode.DLSS;
        }
        settings.enableDlssNeuralRendering = args.dlss5;
        settings.dlssNeuralRenderingModel = args.nrModel;
        settings.dlssNeuralRenderingIntensity = args.nrIntensity;
        settings.dlssNeuralRenderingStructureStrength = args.nrStructure;
        settings.dlssNeuralRenderingToneStrength = args.nrTone;
        settings.dlssNeuralRenderingSkinStrength = args.nrSkin;
        settings.dlssNeuralRenderingUseAutoMask = !args.noAutoMask;
        const renderer = new Renderer(app, settings, args.scenePath, args.hairTessellationType, args.hairRadiusScale,
            args.msaa);
        if (!renderer.init()) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);
        if (!args.noUI) {
            const ui = new UserInterface(settings);
            if (!ui.init(app)) {
                app.destroy();
                return 1;
            }
        }

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(checkFrame(app));
        }
        renderer.shutdown();
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RtxcrRaster.main(argc, argv);
}

// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace EnvironmentMap {
    // GLFW values, as passed to the keyboard callback.
    const KEY_SPACE = 32;
    const ACTION_PRESS = 1;

    const WINDOW_TITLE = "Donut Example: Environment Map";
    const DEFAULT_SCENE = "media/glTF-Sample-Assets/Models/Sponza/glTF/Sponza.gltf";
    // A lat-long BC7 environment map (Donut-Samples' rt_particles one), as DDS and as the KTX 2
    // file tools/dds_to_ktx2.py makes of it at build time: the same blocks, so the same picture.
    const ENVIRONMENT_MAP_DDS = "media/rt_particles/environment-map.dds";
    const ENVIRONMENT_MAP_KTX2 = "media/environment_map/environment-map.ktx2";

    // One shadow map over the whole scene; shadows fade out over the last FADE_RANGE world units at
    // its edges.
    const SHADOW_MAP_RESOLUTION = 4096;
    const SHADOW_FADE_RANGE = 0.5;

    // A fixed exposure (the adapted luminance tone mapping divides by; no eye adaptation), and the
    // ambient light from above and below.
    const EXPOSURE = 0.2;
    const AMBIENT_TOP = 0.15;
    const AMBIENT_BOTTOM = 0.05;

    // --- Math ---------------------------------------------------------------------------------
    // Row-major 4x4 matrices (16 numbers) with Donut's row-vector convention.

    // math::perspProjD3DStyleReverse(verticalFOV, aspect, zNear): reverse Z, infinite far plane,
    // in float32 as Donut's.
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

    // Donut's forward shading of a scene lit by a sun, under an environment map: the background is
    // Donut's EnvironmentMapPass (a lat-long texture here; cube maps work too) drawn where no
    // geometry is, and the sun's shadows come from a PlanarShadowMap fitted to the whole scene,
    // rendered again only when its view changes (here, once). The environment map loads from DDS,
    // or with -ktx2 from KTX 2 (Zstandard-supercompressed BC7 levels, through Donut's KTX 2 loader).
    // Space switches the shadows off and on.
    class EnvironmentMapExample {
        private app: App;
        private scene: Scene;
        private sceneGraph: SceneGraph;
        private sunLight: Light;
        private camera: Camera;
        private view: View;
        private environmentMap: Opaque;
        private shadowMap: ShadowMap;
        private shadowDepthPass: DepthPass;
        private shadowMapValid: boolean;
        private enableShadows: boolean;
        private forwardPass: ForwardShadingPass;
        private forwardContext: Opaque;
        // Created on the first frame, again when the window's size changes.
        private renderTargets: SceneRenderTargets;
        private renderTargetsWidth: int;
        private renderTargetsHeight: int;
        private environmentMapPass: Opaque | null;
        private toneMappingPass: ToneMappingPass;
        private exposureResetRequired: boolean;
        private useKtx2: boolean;
        // Passed to View.setPlanarView, 16 floats each.
        private viewMatrix: f32[];
        private projMatrix: f32[];

        constructor(app: App, useKtx2: boolean) {
            this.app = app;
            this.useKtx2 = useKtx2;
            this.shadowMapValid = false;
            this.enableShadows = true;
            this.renderTargets = new SceneRenderTargets(null);
            this.renderTargetsWidth = 0;
            this.renderTargetsHeight = 0;
            this.environmentMapPass = null;
            this.toneMappingPass = new ToneMappingPass(null);
            this.exposureResetRequired = true;
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
                this.enableShadows = !this.enableShadows;
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

            this.app.setInformativeWindowTitleWithInfo(WINDOW_TITLE,
                `- ${this.useKtx2 ? "KTX 2" : "DDS"} environment map, shadows ${this.enableShadows ? "on" : "off"}`);
        }

        onBackBufferResizing(): void {
            // The blit's cached binding sets reference the old LDR color texture.
            this.app.clearBindingCache();
        }

        // The targets and the passes made for their framebuffers.
        createRenderTargets(width: int, height: int): void {
            if (!this.renderTargets.isNull()) {
                this.app.releaseObject(this.renderTargets.handle);
            }
            const environmentMapPass = this.environmentMapPass;
            if (environmentMapPass) {
                this.app.releaseObject(environmentMapPass);
            }

            const targets = this.app.createSceneRenderTargets(width, height, 1);
            this.renderTargets = targets;
            this.renderTargetsWidth = width;
            this.renderTargetsHeight = height;

            this.environmentMapPass = this.app.createEnvironmentMapPass(targets.getFramebuffer(SceneFramebuffer.Forward),
                this.view, this.environmentMap);

            // The new tone mapping pass takes over the old one's exposure.
            const previousToneMappingPass = this.toneMappingPass;
            this.toneMappingPass = this.app.createToneMappingPass(targets.getFramebuffer(SceneFramebuffer.Ldr),
                this.view, previousToneMappingPass.isNull() ? null : previousToneMappingPass);
            if (!previousToneMappingPass.isNull()) {
                this.app.releaseObject(previousToneMappingPass.handle);
            }
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();

            this.camera.getWorldToView(Ref(this.viewMatrix[0]));
            const projection = perspProjD3DStyleReverse(Math.PI * 0.25, width / height, 0.1);
            for (let i = 0; i < 16; i++) {
                this.projMatrix[i] = projection[i];
            }
            this.view.setPlanarView(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);

            if (this.renderTargets.isNull() || this.renderTargetsWidth != width || this.renderTargetsHeight != height) {
                this.createRenderTargets(width, height);
            }

            const commandList = frame.getCommandList();
            const targets = this.renderTargets;
            const sceneGraph = this.sceneGraph;
            const sun = this.sunLight;

            if (this.enableShadows) {
                sun.setShadowMap(this.shadowMap);
                // The scene and the sun don't move: one rendering of the shadow map does.
                if (this.shadowMap.setupPlanarForScene(sun, sceneGraph, SHADOW_FADE_RANGE) != 0 || !this.shadowMapValid) {
                    commandList.clearShadowMap(this.shadowMap);
                    commandList.renderShadowDepth(this.shadowDepthPass, this.shadowMap, sceneGraph, 0);
                    this.shadowMapValid = true;
                }
            } else {
                sun.setShadowMap(null);
            }

            commandList.clearSceneRenderTargets(targets);

            commandList.prepareForwardLights(this.forwardPass, this.forwardContext, sceneGraph,
                AMBIENT_TOP, AMBIENT_TOP, AMBIENT_TOP, AMBIENT_BOTTOM, AMBIENT_BOTTOM, AMBIENT_BOTTOM, null);
            commandList.renderForward(this.forwardPass, this.forwardContext, this.view, null,
                targets.getFramebuffer(SceneFramebuffer.Forward), sceneGraph, 0, "ForwardOpaque", 0);

            // Behind everything opaque, before what is transparent.
            commandList.renderEnvironmentMap(this.environmentMapPass as Opaque, this.view);

            commandList.renderForward(this.forwardPass, this.forwardContext, this.view, null,
                targets.getFramebuffer(SceneFramebuffer.Forward), sceneGraph, 1, "ForwardTransparent", 0);

            if (this.exposureResetRequired) {
                commandList.resetExposure(this.toneMappingPass, EXPOSURE);
                this.exposureResetRequired = false;
            }
            // Adapting over a frame time of 0 (Donut_AdvanceToneMappingFrame is never called): the
            // exposure stays at EXPOSURE.
            commandList.renderToneMapping(this.toneMappingPass, this.view, targets.getTexture(SceneTexture.HdrColor), 0);

            this.app.blitTexture(frame, targets.getTexture(SceneTexture.LdrColor));
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(scenePath: string): boolean {
            const scene = this.app.loadScene(scenePath);
            if (scene.isNull()) {
                console.log(`Cannot load the scene ${scenePath}`);
                return false;
            }
            this.scene = scene;
            const sceneGraph = scene.getSceneGraph();
            this.sceneGraph = sceneGraph;

            this.sunLight = sceneGraph.addDirectionalLight(sceneGraph.getRootNode(), "Sun",
                0.35, -1.0, 0.2, 0.53, 2.0);
            this.app.refreshSceneGraph(sceneGraph);

            const commandList = this.app.createCommandList();
            commandList.open();
            const environmentMapPath = this.useKtx2 ? ENVIRONMENT_MAP_KTX2 : ENVIRONMENT_MAP_DDS;
            const environmentMap = this.app.loadTexture(commandList, environmentMapPath, 0);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!environmentMap) {
                console.log(`Cannot load the environment map ${environmentMapPath}`);
                return false;
            }
            this.environmentMap = environmentMap;

            this.shadowMap = this.app.createPlanarShadowMap(SHADOW_MAP_RESOLUTION);
            this.shadowDepthPass = this.app.createShadowDepthPass(100, 4.0);

            this.forwardPass = this.app.createForwardShadingPassWithOptions(0, 0);
            this.forwardContext = this.app.createForwardShadingContext();

            // Under the open roof, looking up past the arches at the sky.
            this.camera = this.app.createFirstPersonCamera();
            this.camera.lookAt(-6.0, 1.8, -0.5, 4.0, 7.0, 0.5);
            this.camera.setMoveSpeed(3.0);

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

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("environment_map");

        // -ktx2: the environment map from its KTX 2 file instead of the DDS one.
        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // --scene <path>: relative to the executable's directory, or absolute.
        let useKtx2 = false;
        let options = AppOptions.None;
        let scenePath = DEFAULT_SCENE;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-ktx2") {
                useKtx2 = true;
            } else if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "--scene" && i + 1 < argc) {
                scenePath = Donut_GetArg(argv, i + 1);
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        console.log(`Renderer: ${app.getRendererString()}`);

        const environmentMap = new EnvironmentMapExample(app, useKtx2);
        if (!environmentMap.init(scenePath)) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return EnvironmentMap.main(argc, argv);
}

// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace RtShadows {
    const WINDOW_TITLE = "Donut Example: Ray Traced Shadows";
    const DEFAULT_SCENE = "media/glTF-Sample-Assets/Models/Sponza/glTF/Sponza.gltf";

    // sizeof(float4): the ray tracing pipeline's payload size, as in the sample.
    const PAYLOAD_SIZE = 16;

    // struct LightingConstants in shaders/rt_shadows_lighting_cb.h, as f32 offsets:
    // float4 ambientColor; LightConstants light; PlanarViewConstants view. The sizes of the last two
    // come from Donut (see RayTracedShadowsPass.init).
    const AMBIENT_COLOR_OFFSET = 0;
    const LIGHT_OFFSET = 4;

    // --- Math ---------------------------------------------------------------------------------
    // Row-major 4x4 matrices (16 numbers) with Donut's row-vector convention.

    // math::perspProjD3DStyleReverse(verticalFOV, aspect, zNear): reverse Z, infinite far plane.
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

    // Port of Donut-Samples' rt_shadows.cpp: fills a G-buffer with the scene, then a ray generation
    // shader traces one ray per pixel towards the sun and shades the pixel, lit or in shadow.
    class RayTracedShadowsPass {
        private app: App;
        private scene: Scene;
        private sunLight: Light;
        private camera: Camera;
        private view: View;
        private bindingLayout: BindingLayoutHandle;
        private shaderTable: ShaderTable;
        private constantBuffer: BufferHandle;
        private accelStructs: SceneAccelStructs;
        // Created on the first frame, dropped on resize.
        private renderTargets: GBufferTargets;
        private bindingSet: BindingSet;
        private gbufferPass: GBufferFillPass;
        // The LightingConstants contents; `view` starts at viewOffset.
        private constants: f32[];
        private viewOffset: int;
        private constantsSize: int;
        // Passed to View.setPlanarView, 16 floats each.
        private viewMatrix: f32[];
        private projMatrix: f32[];

        constructor(app: App) {
            this.app = app;
            this.renderTargets = new GBufferTargets(null);
            this.bindingSet = new BindingSet(null);
            this.gbufferPass = new GBufferFillPass(null);
            this.constants = [];
            this.viewOffset = 0;
            this.constantsSize = 0;
            this.viewMatrix = [];
            this.projMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
                this.projMatrix.push(0.0);
            }
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            this.camera.keyboardUpdate(key, scancode, action, mods);
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

        onAnimate(elapsedSeconds: number): void {
            this.camera.animate(elapsedSeconds);
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        onBackBufferResizing(): void {
            const bindingSet = this.bindingSet;
            if (!bindingSet.isNull()) {
                this.app.releaseResource(bindingSet.handle);
                this.bindingSet = new BindingSet(null);
            }

            const renderTargets = this.renderTargets;
            if (!renderTargets.isNull()) {
                this.app.releaseObject(renderTargets.handle);
                this.renderTargets = new GBufferTargets(null);
            }

            // The blit's cached binding sets still reference the old render targets.
            this.app.clearBindingCache();

            const gbufferPass = this.gbufferPass;
            if (!gbufferPass.isNull()) {
                this.app.releaseObject(gbufferPass.handle);
                this.gbufferPass = new GBufferFillPass(null);
            }
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();

            let renderTargets = this.renderTargets;
            let bindingSet = this.bindingSet;
            if (renderTargets.isNull() || bindingSet.isNull()) {
                // Reverse Z: depth is cleared to 0.
                renderTargets = this.app.createGBufferTargets(width, height, 1);

                const bindingSetDesc = BindingSetDesc.create();
                bindingSetDesc.bindEntireConstantBuffer(0, this.constantBuffer);
                bindingSetDesc.bindAccelStruct(0, this.accelStructs.getTopLevelAS());
                bindingSetDesc.bindTextureSRV(1, renderTargets.getTexture(GBufferTexture.Depth));
                bindingSetDesc.bindTextureSRV(2, renderTargets.getTexture(GBufferTexture.Diffuse));
                bindingSetDesc.bindTextureSRV(3, renderTargets.getTexture(GBufferTexture.Specular));
                bindingSetDesc.bindTextureSRV(4, renderTargets.getTexture(GBufferTexture.Normals));
                bindingSetDesc.bindTextureSRV(5, renderTargets.getTexture(GBufferTexture.Emissive));
                bindingSetDesc.bindTextureUAV(0, renderTargets.getShadedColor());
                bindingSet = this.app.createBindingSetForLayout(bindingSetDesc, this.bindingLayout);

                this.renderTargets = renderTargets;
                this.bindingSet = bindingSet;
            }

            this.camera.getWorldToView(Ref(this.viewMatrix[0]));
            const projection = perspProjD3DStyleReverse(Math.PI * 0.25, width / height, 0.1);
            for (let i = 0; i < 16; i++) {
                this.projMatrix[i] = projection[i];
            }
            this.view.setPlanarView(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);

            let gbufferPass = this.gbufferPass;
            if (gbufferPass.isNull()) {
                gbufferPass = this.app.createGBufferFillPass();
                this.gbufferPass = gbufferPass;
            }

            frame.clearGBuffer(renderTargets);
            frame.renderSceneToGBuffer(gbufferPass, this.view, renderTargets, this.scene);

            for (let i = 0; i < 4; i++) {
                this.constants[AMBIENT_COLOR_OFFSET + i] = 0.05;
            }
            this.view.fillPlanarViewConstants(Ref(this.constants[this.viewOffset]));
            this.sunLight.fillConstants(Ref(this.constants[LIGHT_OFFSET]));
            frame.getCommandList().writeBuffer(this.constantBuffer, Ref(this.constants[0]), this.constantsSize);

            frame.dispatchRays(this.shaderTable, bindingSet, width, height);

            this.app.blitTexture(frame, renderTargets.getShadedColor());
        }

        createRayTracingPipeline(): boolean {
            const shaderLibrary = this.app.createShaderLibrary("rt_shadows.hlsl");
            if (!shaderLibrary) {
                return false;
            }

            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutVolatileConstantBuffer(0);
            layoutDesc.layoutAccelStruct(0);
            layoutDesc.layoutTextureSRV(1);
            layoutDesc.layoutTextureSRV(2);
            layoutDesc.layoutTextureSRV(3);
            layoutDesc.layoutTextureSRV(4);
            layoutDesc.layoutTextureSRV(5);
            layoutDesc.layoutTextureUAV(0);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);

            // The hit group has no shaders: a hit just leaves the payload's `missed` false.
            const pipeline = this.app.createRayTracingPipeline(shaderLibrary, this.bindingLayout,
                "RayGen", "Miss", "HitGroup", "", PAYLOAD_SIZE);
            if (!pipeline) {
                return false;
            }

            this.shaderTable = this.app.createShaderTable(pipeline, "RayGen", "HitGroup", "Miss");
            // The shader table keeps the pipeline alive.
            this.app.releaseResource(pipeline);
            return true;
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
            this.sunLight = sceneGraph.addDirectionalLight(sceneGraph.getRootNode(), "Sun",
                0.1, -1.0, 0.15, 0.53, 1.0);
            this.app.refreshSceneGraph(sceneGraph);

            this.camera = this.app.createFirstPersonCamera();
            this.camera.lookAt(0.0, 1.8, 0.0, 1.0, 1.8, 0.0);
            this.camera.setMoveSpeed(3.0);

            this.view = this.app.createPlanarView();

            this.viewOffset = LIGHT_OFFSET + Donut_GetLightConstantsSize() / 4;
            this.constantsSize = this.viewOffset * 4 + Donut_GetPlanarViewConstantsSize();
            for (let i = 0; i < this.constantsSize / 4; i++) {
                this.constants.push(0.0);
            }
            this.constantBuffer = this.app.createVolatileConstantBuffer(this.constantsSize, "LightingConstants");

            if (!this.createRayTracingPipeline()) {
                return false;
            }

            const commandList = this.app.createCommandList();
            commandList.open();

            this.accelStructs = this.app.buildSceneAccelStructs(commandList, scene);

            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("rt_shadows");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // --scene <path>: relative to the executable's directory, or absolute.
        let options = AppOptions.RayTracing;
        let scenePath = DEFAULT_SCENE;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.RayTracing | AppOptions.DebugRuntime;
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

        if (!app.isFeatureSupported(Feature.RayTracingPipeline)) {
            console.log("The graphics device does not support Ray Tracing Pipelines");
            app.destroy();
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const rayTracedShadows = new RayTracedShadowsPass(app);
        if (!rayTracedShadows.init(scenePath)) {
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
    return RtShadows.main(argc, argv);
}

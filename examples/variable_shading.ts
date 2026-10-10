// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace VariableShading {
    const WINDOW_TITLE = "Donut Example: Variable Rate Shading";
    const DEFAULT_SCENE = "media/glTF-Sample-Assets/Models/Sponza/glTF/Sponza.gltf";

    const AMBIENT_COLOR = 0.2;

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

    // Port of Donut-Samples' variable_shading.cpp (NVIDIA Variable Rate Shading sample): a compute
    // shader fills a shading rate surface from the previous frame (coarse 4x4 shading where it was
    // more green than red), the scene is forward-shaded with it, then TAA runs at full rate.
    //
    // With -raw on D3D12, the shading rate surface is bound through the D3D12 API directly instead
    // of through NVRHI.
    class VariableRateShadingPass {
        private app: App;
        private useRawD3D12: boolean;
        private scene: Scene;
        private camera: Camera;
        private view: View;
        private viewPrevious: View;
        private previousViewsValid: boolean;
        private shadingRateSurfaceShader: Opaque;
        private vrsTileSize: int;
        // Created on the first frame, dropped on resize.
        private renderTargets: TemporalTargets;
        private forwardPass: ForwardShadingPass;
        private temporalPass: TemporalAntiAliasingPass;
        private shadingRateSurface: Opaque | null;
        private bindingSet: BindingSet;
        private pipeline: Opaque | null;
        // Passed to View.setPlanarView, 16 floats each.
        private viewMatrix: f32[];
        private projMatrix: f32[];

        constructor(app: App, useRawD3D12: boolean) {
            this.app = app;
            this.useRawD3D12 = useRawD3D12;
            this.previousViewsValid = false;
            this.vrsTileSize = 0;
            this.renderTargets = new TemporalTargets(null);
            this.forwardPass = new ForwardShadingPass(null);
            this.temporalPass = new TemporalAntiAliasingPass(null);
            this.shadingRateSurface = null;
            this.bindingSet = new BindingSet(null);
            this.pipeline = null;
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
            const renderTargets = this.renderTargets;
            if (!renderTargets.isNull()) {
                this.app.releaseObject(renderTargets.handle);
                this.renderTargets = new TemporalTargets(null);
            }

            this.app.clearBindingCache();

            const forwardPass = this.forwardPass;
            if (!forwardPass.isNull()) {
                this.app.releaseObject(forwardPass.handle);
                this.forwardPass = new ForwardShadingPass(null);
            }

            const shadingRateSurface = this.shadingRateSurface;
            if (shadingRateSurface) {
                this.app.releaseResource(shadingRateSurface);
                this.shadingRateSurface = null;
            }

            const temporalPass = this.temporalPass;
            if (!temporalPass.isNull()) {
                this.app.releaseObject(temporalPass.handle);
                this.temporalPass = new TemporalAntiAliasingPass(null);
            }

            const pipeline = this.pipeline;
            if (pipeline) {
                this.app.releaseResource(pipeline);
                this.pipeline = null;
            }

            const bindingSet = this.bindingSet;
            if (!bindingSet.isNull()) {
                this.app.releaseResource(bindingSet.handle);
                this.bindingSet = new BindingSet(null);
            }
        }

        onRender(frameHandle: Opaque): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();

            let renderTargets = this.renderTargets;
            if (renderTargets.isNull()) {
                renderTargets = this.app.createTemporalTargets(width, height);
                this.renderTargets = renderTargets;
            }

            this.camera.getWorldToView(Ref(this.viewMatrix[0]));
            const projection = perspProjD3DStyleReverse(Math.PI * 0.25, width / height, 0.1);
            for (let i = 0; i < 16; i++) {
                this.projMatrix[i] = projection[i];
            }
            this.view.setPlanarView(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);

            // VRS-specific code starts here
            // Use the queried tile size to determine the size of the VRS surface; it will be
            // approximately 1/tileSize in both dimensions (with some rounding).
            const surfaceWidth: int = Math.floor((width + this.vrsTileSize - 1) / this.vrsTileSize);
            const surfaceHeight: int = Math.floor((height + this.vrsTileSize - 1) / this.vrsTileSize);
            let shadingRateSurface = this.shadingRateSurface;
            if (!shadingRateSurface) {
                shadingRateSurface = this.app.createShadingRateSurface(surfaceWidth, surfaceHeight);
                this.shadingRateSurface = shadingRateSurface;
            }

            let forwardPass = this.forwardPass;
            if (forwardPass.isNull()) {
                forwardPass = this.app.createForwardShadingPass(16);
                this.forwardPass = forwardPass;
                if (!this.useRawD3D12) {
                    renderTargets.setShadingRateSurface(shadingRateSurface);
                }
            }

            let temporalPass = this.temporalPass;
            if (temporalPass.isNull()) {
                temporalPass = this.app.createTemporalAntiAliasingPass(this.view, renderTargets);
                this.temporalPass = temporalPass;
            }

            // A pipeline state for the compute shader which will generate the VRS surface.
            let pipeline = this.pipeline;
            let bindingSet = this.bindingSet;
            if (!pipeline || bindingSet.isNull()) {
                const bindingSetDesc = BindingSetDesc.create();
                bindingSetDesc.bindTextureUAV(0, shadingRateSurface);
                bindingSetDesc.bindTextureSRV(0, renderTargets.getTexture(TemporalTexture.MotionVectors));
                bindingSetDesc.bindTextureSRV(1, renderTargets.getTexture(TemporalTexture.HdrColor));
                bindingSet = this.app.createBindingSet(bindingSetDesc, ShaderType.Compute);
                pipeline = this.app.createComputePipeline(this.shadingRateSurfaceShader, bindingSet);

                this.bindingSet = bindingSet;
                this.pipeline = pipeline;
            }

            if (this.previousViewsValid) {
                frame.renderMotionVectors(temporalPass, this.view, this.viewPrevious);
            }

            // Dispatch call to generate the VRS surface.
            frame.getCommandList().dispatch(pipeline, bindingSet, surfaceWidth, surfaceHeight, 1);

            frame.clearTemporalTargets(renderTargets);

            if (this.useRawD3D12) {
                frame.beginD3D12ShadingRateImage(shadingRateSurface);
            } else {
                // Enable VRS, with a per-draw shading rate of 1x1, and make the shading rate image
                // result always override all others.
                this.view.setVariableRateShading(1);
            }

            // Forward pass to draw the scene with the VRS surface set above.
            frame.renderSceneForward(forwardPass, this.view, renderTargets, this.scene,
                AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR);

            if (this.useRawD3D12) {
                frame.endD3D12ShadingRateImage(shadingRateSurface);
            } else {
                this.view.setVariableRateShading(0);
            }
            // VRS-specific code ends here

            // TAA pass (runs at full rate).
            frame.temporalResolve(temporalPass, this.view, this.previousViewsValid ? 1 : 0);
            this.viewPrevious.copyPlanarView(this.view);
            this.previousViewsValid = true;

            this.app.blitTexture(frame, renderTargets.getTexture(TemporalTexture.ResolvedColor));
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(scenePath: string): boolean {
            this.shadingRateSurfaceShader = this.app.createShader("variable_shading.hlsl", "main_cs", ShaderType.Compute);
            if (!this.shadingRateSurfaceShader) {
                return false;
            }

            const scene = this.app.loadScene(scenePath);
            if (scene.isNull()) {
                console.log(`Cannot load the scene ${scenePath}`);
                return false;
            }
            this.scene = scene;

            const sceneGraph = scene.getSceneGraph();
            sceneGraph.addDirectionalLight(sceneGraph.getRootNode(), "Sun", 0.1, -1.0, 0.15, 0.53, 2.0);
            this.app.refreshSceneGraph(sceneGraph);

            this.camera = this.app.createFirstPersonCamera();
            this.camera.lookAt(0.0, 1.8, 0.0, 1.0, 1.8, 0.0);
            this.camera.setMoveSpeed(3.0);

            this.view = this.app.createPlanarView();
            this.viewPrevious = this.app.createPlanarView();

            // Query VRS tile size (it can vary depending on hardware).
            this.vrsTileSize = this.useRawD3D12
                ? this.app.getD3D12ShadingRateTileSize()
                : this.app.getShadingRateTileSize();

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
        Donut_SetAppName("variable_shading");

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        if (api == GraphicsAPI.D3D11) {
            console.log("The Variable Rate Shading example does not support D3D11.");
            return 1;
        }

        // -raw: on D3D12, bind the shading rate surface through the D3D12 API directly.
        // --scene <path>: relative to the executable's directory, or absolute.
        let rawD3D12 = false;
        let scenePath = DEFAULT_SCENE;
        for (let i = 1; i < argc; i++) {
            if (Donut_GetArg(argv, i) == "-raw") {
                rawD3D12 = api == GraphicsAPI.D3D12;
            }
            if (Donut_GetArg(argv, i) == "--scene" && i + 1 < argc) {
                scenePath = Donut_GetArg(argv, i + 1);
            }
        }

        const app = App.createForAPI(api, WINDOW_TITLE, 1280, 720);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.VariableRateShading)) {
            console.log("The device does not support Variable Rate Shading");
            app.destroy();
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const variableRateShading = new VariableRateShadingPass(app, rawD3D12);
        if (!variableRateShading.init(scenePath)) {
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
    return VariableShading.main(argc, argv);
}

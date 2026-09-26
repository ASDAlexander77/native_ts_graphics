// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "./input_pass";

namespace RtBindless {
    // GLFW values, as passed to the keyboard callback.
    const KEY_SPACE = 32;
    const ACTION_PRESS = 1;

    const WINDOW_TITLE = "Donut Example: Bindless Ray Tracing";
    const DEFAULT_SCENE = "media/sponza-plus.scene.json";

    // sizeof(RayPayload) in rt_bindless.hlsl: 6 floats / uints.
    const PAYLOAD_SIZE = 6 * 4;
    // main in rt_bindless.hlsl (the ray query version) runs 16 x 16 threads per group.
    const COMPUTE_GROUP_SIZE = 16;

    // struct LightingConstants in shaders/rt_bindless_lighting_cb.h, as f32 offsets:
    // float4 ambientColor; LightConstants light; PlanarViewConstants view. The sizes of the last two
    // come from Donut (see BindlessRayTracingPass.init).
    const AMBIENT_COLOR_OFFSET = 0;
    const LIGHT_OFFSET = 4;

    // --- Math ---------------------------------------------------------------------------------
    // Row-major 4x4 matrices (16 numbers) with Donut's row-vector convention.

    // math::perspProjD3DStyleReverse(verticalFOV, aspect, zNear): reverse Z, infinite far plane.
    function perspProjD3DStyleReverse(verticalFOV: number, aspect: number, zNear: number): number[] {
        const yScale = 1.0 / Math.tan(0.5 * verticalFOV);
        const xScale = yScale / aspect;
        return [
            xScale, 0.0,    0.0,   0.0,
            0.0,    yScale, 0.0,   0.0,
            0.0,    0.0,    0.0,   1.0,
            0.0,    0.0,    zNear, 0.0,
        ];
    }

    // --- Passes -------------------------------------------------------------------------------

    // Port of Donut-Samples' rt_bindless.cpp: ray traces an animated scene (Sponza with two dancing
    // robots), primary rays and sun shadows, reading all geometry and textures through bindless
    // resource arrays. Uses a ray tracing pipeline, or with -rayQuery, inline ray queries in a
    // compute shader. Space pauses the animations.
    class BindlessRayTracingPass {
        private app: App;
        private useRayQuery: boolean;
        private scene: Scene;
        private sunLight: Light;
        private camera: Camera;
        private view: View;
        private bindlessLayout: Opaque;
        private bindingLayout: Opaque;
        private descriptorTable: Opaque;
        private constantBuffer: Opaque;
        private accelStructs: SceneAccelStructs;
        private shaderLibrary: Opaque;
        // One of these two, depending on useRayQuery.
        private shaderTable: ShaderTable;
        private computePipeline: Opaque;
        // Created on the first frame, dropped on resize.
        private colorBuffer: Opaque | null;
        private bindingSet: BindingSet;
        private enableAnimations: boolean;
        private wallclockTime: number;
        // The LightingConstants contents; `view` starts at viewOffset.
        private constants: f32[];
        private viewOffset: int;
        private constantsSize: int;
        // Passed to Donut_SetPlanarView, 16 floats each.
        private viewMatrix: f32[];
        private projMatrix: f32[];

        constructor(app: App, useRayQuery: boolean) {
            this.app = app;
            this.useRayQuery = useRayQuery;
            this.colorBuffer = null;
            this.bindingSet = new BindingSet(null);
            this.enableAnimations = true;
            this.wallclockTime = 0.0;
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

            if (key == KEY_SPACE && action == ACTION_PRESS) {
                this.enableAnimations = !this.enableAnimations;
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

            if (this.enableAnimations) {
                this.wallclockTime += elapsedSeconds;
                // Each animation starts a second after the previous one.
                let offset = 0.0;

                const animationCount = this.scene.getAnimationCount();
                for (let i = 0; i < animationCount; i++) {
                    const duration = this.scene.getAnimationDuration(i);
                    const cycles = (this.wallclockTime + offset) / duration;
                    const animationTime = (cycles - Math.floor(cycles)) * duration;
                    this.scene.applyAnimation(i, animationTime);
                    offset += 1.0;
                }
            }

            this.app.setInformativeWindowTitleWithInfo(WINDOW_TITLE,
                this.useRayQuery ? "- using RayQuery" : "- using RayPipeline");
        }

        onBackBufferResizing(): void {
            const bindingSet = this.bindingSet;
            if (!bindingSet.isNull()) {
                this.app.releaseResource(bindingSet.handle);
                this.bindingSet = new BindingSet(null);
            }

            const colorBuffer = this.colorBuffer;
            if (colorBuffer) {
                this.app.releaseResource(colorBuffer);
                this.colorBuffer = null;
            }

            // The blit's cached binding sets still reference the old color buffer.
            this.app.clearBindingCache();
        }

        onRender(frameHandle: Opaque): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();

            let colorBuffer = this.colorBuffer;
            let bindingSet = this.bindingSet;
            if (!colorBuffer || bindingSet.isNull()) {
                colorBuffer = this.app.createUAVTextureForFrameWithFormat(frame, "ColorBuffer", Format.RGBA16_FLOAT);

                const bindingSetDesc = BindingSetDesc.create();
                bindingSetDesc.bindEntireConstantBuffer(0, this.constantBuffer);
                bindingSetDesc.bindAccelStruct(0, this.accelStructs.getTopLevelAS());
                bindingSetDesc.bindStructuredBufferSRV(1, this.scene.getBuffer(SceneBuffer.Instances));
                bindingSetDesc.bindStructuredBufferSRV(2, this.scene.getBuffer(SceneBuffer.Geometries));
                bindingSetDesc.bindStructuredBufferSRV(3, this.scene.getBuffer(SceneBuffer.Materials));
                bindingSetDesc.bindSampler(0, this.app.getCommonSampler(CommonSampler.AnisotropicWrap));
                bindingSetDesc.bindTextureUAV(0, colorBuffer);
                bindingSet = this.app.createBindingSetForLayout(bindingSetDesc, this.bindingLayout);

                this.colorBuffer = colorBuffer;
                this.bindingSet = bindingSet;
            }

            this.camera.getWorldToView(Ref(this.viewMatrix[0]));
            const projection = perspProjD3DStyleReverse(Math.PI * 0.25, width / height, 0.1);
            for (let i = 0; i < 16; i++) {
                this.projMatrix[i] = projection[i];
            }
            this.view.setPlanarView(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);

            this.app.refreshScene(frame, this.scene);
            this.app.updateSceneAccelStructs(frame, this.accelStructs, this.scene);

            for (let i = 0; i < 4; i++) {
                this.constants[AMBIENT_COLOR_OFFSET + i] = 0.05;
            }
            this.view.fillPlanarViewConstants(Ref(this.constants[this.viewOffset]));
            this.sunLight.fillConstants(Ref(this.constants[LIGHT_OFFSET]));
            frame.getCommandList().writeBuffer(this.constantBuffer, Ref(this.constants[0]), this.constantsSize);

            if (this.useRayQuery) {
                const groupsX: int = Math.floor((width + COMPUTE_GROUP_SIZE - 1) / COMPUTE_GROUP_SIZE);
                const groupsY: int = Math.floor((height + COMPUTE_GROUP_SIZE - 1) / COMPUTE_GROUP_SIZE);
                frame.getCommandList().dispatchWithDescriptorTable(this.computePipeline, bindingSet,
                    this.descriptorTable, groupsX, groupsY, 1);
            } else {
                frame.dispatchRaysWithDescriptorTable(this.shaderTable, bindingSet, this.descriptorTable, width, height);
            }

            this.app.blitTexture(frame, colorBuffer);
        }

        createRayTracingPipeline(): boolean {
            const shaderLibrary = this.app.createShaderLibraryWithDefine("rt_bindless.hlsl", "USE_RAY_QUERY", "0");
            if (!shaderLibrary) {
                return false;
            }
            this.shaderLibrary = shaderLibrary;

            const pipeline = this.app.createRayTracingPipelineWithLayouts(shaderLibrary, this.bindingLayout, this.bindlessLayout,
                "RayGen", "Miss", "HitGroup", "ClosestHit", "AnyHit", PAYLOAD_SIZE);
            if (!pipeline) {
                return false;
            }

            const shaderTable = this.app.createCachedShaderTable(pipeline, "RayGen", "HitGroup", "Miss", 3, "Shader Table");
            // The shader table keeps the pipeline alive.
            this.app.releaseResource(pipeline);
            if (shaderTable.isNull()) {
                return false;
            }
            this.shaderTable = shaderTable;
            return true;
        }

        createComputePipeline(): boolean {
            const computeShader = this.app.createShaderWithDefine("rt_bindless.hlsl", "main", ShaderType.Compute,
                "USE_RAY_QUERY", "1");
            if (!computeShader) {
                return false;
            }

            const pipeline = this.app.createComputePipelineWithLayouts(computeShader, this.bindingLayout, this.bindlessLayout);
            if (!pipeline) {
                return false;
            }
            this.computePipeline = pipeline;
            return true;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(scenePath: string): boolean {
            const bindlessLayoutDesc = BindlessLayoutDesc.create(0, 1024, ShaderType.All);
            bindlessLayoutDesc.addRawBuffers(1);
            bindlessLayoutDesc.addTextures(2);
            this.bindlessLayout = this.app.createBindlessLayout(bindlessLayoutDesc);

            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutVolatileConstantBuffer(0);
            layoutDesc.layoutAccelStruct(0);
            layoutDesc.layoutStructuredBufferSRV(1);
            layoutDesc.layoutStructuredBufferSRV(2);
            layoutDesc.layoutStructuredBufferSRV(3);
            layoutDesc.layoutSampler(0);
            layoutDesc.layoutTextureUAV(0);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);

            const descriptorTableManager = this.app.createDescriptorTableManager(this.bindlessLayout);
            this.descriptorTable = descriptorTableManager.getDescriptorTable();

            const scene = this.app.loadSceneWithDescriptorTable(scenePath, descriptorTableManager);
            if (scene.isNull()) {
                console.log(`Cannot load the scene ${scenePath}`);
                return false;
            }
            this.scene = scene;

            const sceneGraph = scene.getSceneGraph();
            this.sunLight = sceneGraph.addDirectionalLight(sceneGraph.getRootNode(), "Sun",
                0.1, -1.0, -0.15, 0.53, 5.0);
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

            if (this.useRayQuery ? !this.createComputePipeline() : !this.createRayTracingPipeline()) {
                return false;
            }

            const commandList = this.app.createCommandList();
            commandList.open();

            this.accelStructs = this.app.createAnimatedSceneAccelStructs(commandList, scene);

            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);

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

        // -rayQuery: inline ray queries in a compute shader instead of a ray tracing pipeline.
        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // --scene <path>: relative to the executable's directory, or absolute.
        let useRayQuery = false;
        let options = AppOptions.RayTracing;
        let scenePath = DEFAULT_SCENE;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-rayQuery") {
                useRayQuery = true;
            } else if (arg == "-debug") {
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

        if (!useRayQuery && !app.isFeatureSupported(Feature.RayTracingPipeline)) {
            console.log("The graphics device does not support Ray Tracing Pipelines");
            app.destroy();
            return 1;
        }

        if (useRayQuery && !app.isFeatureSupported(Feature.RayQuery)) {
            console.log("The graphics device does not support Ray Queries");
            app.destroy();
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const rayTracing = new BindlessRayTracingPass(app, useRayQuery);
        if (!rayTracing.init(scenePath)) {
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
    return RtBindless.main(argc, argv);
}

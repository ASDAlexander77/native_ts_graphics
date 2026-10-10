// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace BindlessRendering {
    const WINDOW_TITLE = "Donut Example: Bindless Rendering";
    const DEFAULT_SCENE = "media/glTF-Sample-Assets/Models/Sponza/glTF/Sponza.gltf";

    // struct InstanceConstants in bindless_rendering.hlsl: the instance and its geometry, as push
    // constants.
    const INSTANCE_CONSTANTS_SIZE = 2 * 4;

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

    // Port of Donut-Samples' bindless_rendering.cpp: draws Sponza without binding any vertex or
    // index buffer. Each draw passes its instance and geometry as push constants; the vertex shader
    // reads the index and vertex data from the scene's bindless buffer array, and the pixel shader
    // the material's diffuse texture from its bindless texture array (alpha-tested materials clip).
    class BindlessRenderingPass {
        private app: App;
        private scene: Scene;
        private sceneGraph: SceneGraph;
        private camera: Camera;
        private view: View;
        private vertexShader: Opaque;
        private pixelShader: Opaque;
        private bindlessLayout: Opaque;
        private bindingLayout: Opaque;
        private bindingSet: BindingSet;
        private descriptorTable: Opaque;
        private viewConstants: BufferHandle;
        private viewConstantsData: f32[];
        private viewConstantsSize: int;
        private instanceConstants: int[];
        // The sample draws into the device manager's D24S8 depth buffer; here a depth texture and a
        // framebuffer per back buffer, created on the first frame and dropped on resize.
        private depth: TextureHandle | null;
        private framebuffers: Opaque[];
        // Created with the framebuffers (the sample drops it on resize too).
        private pipeline: Opaque | null;
        // Passed to View.setPlanarView, 16 floats each.
        private viewMatrix: f32[];
        private projMatrix: f32[];

        constructor(app: App) {
            this.app = app;
            this.bindingSet = new BindingSet(null);
            this.viewConstantsData = [];
            this.viewConstantsSize = 0;
            this.instanceConstants = [0, 0];
            this.depth = null;
            this.framebuffers = [];
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

        releaseTargets(): void {
            for (let i = 0; i < this.framebuffers.length; i++) {
                this.app.releaseResource(this.framebuffers[i]);
            }
            this.framebuffers = [];

            const depth = this.depth;
            if (depth) {
                this.app.releaseResource(depth);
                this.depth = null;
            }

            const pipeline = this.pipeline;
            if (pipeline) {
                this.app.releaseResource(pipeline);
                this.pipeline = null;
            }
        }

        onBackBufferResizing(): void {
            this.releaseTargets();
        }

        createTargets(width: int, height: int): void {
            // Reverse Z: cleared to 0, nearer is greater.
            const depth = this.app.createDepthTexture(width, height, Format.D24S8, 0.0, "Depth");
            this.depth = depth;
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), depth));
            }

            const pipelineDesc = GraphicsPipelineDesc.create(this.vertexShader, this.pixelShader);
            pipelineDesc.addBindingLayout(this.bindingLayout);
            pipelineDesc.addBindingLayout(this.bindlessLayout);
            pipelineDesc.setPrimitiveType(PrimitiveType.TriangleList);
            pipelineDesc.setDepthState(1, 1, ComparisonFunc.GreaterOrEqual);
            pipelineDesc.setRasterState(CullMode.Back, FillMode.Solid, 1);
            this.pipeline = this.app.createGraphicsPipelineFromDesc(pipelineDesc, this.framebuffers[0]);
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            if (this.framebuffers.length == 0) {
                this.createTargets(width, height);
            }

            this.camera.getWorldToView(Ref(this.viewMatrix[0]));
            const projection = perspProjD3DStyleReverse(Math.PI * 0.25, width / height, 0.1);
            for (let i = 0; i < 16; i++) {
                this.projMatrix[i] = projection[i];
            }
            this.view.setPlanarView(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);

            const commandList = frame.getCommandList();
            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), 0.0, 0.0, 0.0, 0.0);
            commandList.clearDepth(this.depth as TextureHandle, 0.0);

            this.view.fillPlanarViewConstants(Ref(this.viewConstantsData[0]));
            commandList.writeBuffer(this.viewConstants, Ref(this.viewConstantsData[0]), this.viewConstantsSize);

            const pipeline = this.pipeline as Opaque;
            const framebuffer = this.framebuffers[index];
            const constants = this.instanceConstants;
            const instanceCount = this.sceneGraph.getMeshInstanceCount();
            for (let i = 0; i < instanceCount; i++) {
                const geometryCount = this.sceneGraph.getMeshInstanceGeometryCount(i);
                for (let g = 0; g < geometryCount; g++) {
                    constants[0] = this.sceneGraph.getMeshInstanceIndex(i);
                    constants[1] = g;
                    frame.beginDrawToFramebuffer(pipeline, framebuffer);
                    frame.drawAddBindingSet(this.bindingSet);
                    frame.drawAddDescriptorTable(this.descriptorTable);
                    frame.drawVerticesWithPushConstants(this.sceneGraph.getMeshInstanceGeometryIndexCount(i, g),
                        Ref(constants[0]), INSTANCE_CONSTANTS_SIZE);
                }
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(scenePath: string): boolean {
            const vertexShader = this.app.createShader("bindless_rendering.hlsl", "vs_main", ShaderType.Vertex);
            const pixelShader = this.app.createShader("bindless_rendering.hlsl", "ps_main", ShaderType.Pixel);
            if (!vertexShader || !pixelShader) {
                return false;
            }
            this.vertexShader = vertexShader;
            this.pixelShader = pixelShader;

            // t_BindlessBuffers in space1, t_BindlessTextures in space2.
            const bindlessLayoutDesc = BindlessLayoutDesc.create(0, 1024, ShaderType.All);
            bindlessLayoutDesc.addRawBuffers(1);
            bindlessLayoutDesc.addTextures(2);
            this.bindlessLayout = this.app.createBindlessLayout(bindlessLayoutDesc);

            const descriptorTableManager = this.app.createDescriptorTableManager(this.bindlessLayout);
            this.descriptorTable = descriptorTableManager.getDescriptorTable();

            const scene = this.app.loadSceneWithDescriptorTable(scenePath, descriptorTableManager);
            if (scene.isNull()) {
                console.log(`Cannot load the scene ${scenePath}`);
                return false;
            }
            this.scene = scene;
            this.sceneGraph = scene.getSceneGraph();

            this.camera = this.app.createFirstPersonCamera();
            this.camera.lookAt(0.0, 1.8, 0.0, 1.0, 1.8, 0.0);
            this.camera.setMoveSpeed(3.0);

            this.view = this.app.createPlanarView();

            this.viewConstantsSize = Donut_GetPlanarViewConstantsSize();
            for (let i = 0; i < this.viewConstantsSize / 4; i++) {
                this.viewConstantsData.push(0.0);
            }
            this.viewConstants = this.app.createVolatileConstantBuffer(this.viewConstantsSize, "ViewConstants");

            this.app.waitForIdle();

            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutVolatileConstantBuffer(0);
            layoutDesc.layoutPushConstants(1, INSTANCE_CONSTANTS_SIZE);
            layoutDesc.layoutStructuredBufferSRV(0);
            layoutDesc.layoutStructuredBufferSRV(1);
            layoutDesc.layoutStructuredBufferSRV(2);
            layoutDesc.layoutSampler(0);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);

            const bindingSetDesc = BindingSetDesc.create();
            bindingSetDesc.bindEntireConstantBuffer(0, this.viewConstants);
            bindingSetDesc.bindPushConstants(1, INSTANCE_CONSTANTS_SIZE);
            bindingSetDesc.bindStructuredBufferSRV(0, scene.getBuffer(SceneBuffer.Instances));
            bindingSetDesc.bindStructuredBufferSRV(1, scene.getBuffer(SceneBuffer.Geometries));
            bindingSetDesc.bindStructuredBufferSRV(2, scene.getBuffer(SceneBuffer.Materials));
            bindingSetDesc.bindSampler(0, this.app.getCommonSampler(CommonSampler.AnisotropicWrap));
            this.bindingSet = this.app.createBindingSetForLayout(bindingSetDesc, this.bindingLayout);

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
        Donut_SetAppName("bindless_rendering");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // --scene <path>: relative to the executable's directory, or absolute.
        let options = AppOptions.None;
        let scenePath = DEFAULT_SCENE;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "--scene" && i + 1 < argc) {
                scenePath = Donut_GetArg(argv, i + 1);
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        if (api == GraphicsAPI.D3D11) {
            console.log("The Bindless Rendering example does not support D3D11.");
            return 1;
        }

        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        console.log(`Renderer: ${app.getRendererString()}`);

        const rendering = new BindlessRenderingPass(app);
        if (!rendering.init(scenePath)) {
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
    return BindlessRendering.main(argc, argv);
}

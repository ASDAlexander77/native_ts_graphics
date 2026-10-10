// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace RtReflections {
    const WINDOW_TITLE = "Donut Example: Ray Traced Reflections";
    const DEFAULT_SCENE = "media/glTF-Sample-Assets/Models/Sponza/glTF/Sponza.gltf";

    // sizeof(float4): the largest ray payload, as in the sample.
    const PAYLOAD_SIZE = 16;
    // Reflection closest-hit shaders trace shadow rays.
    const MAX_RECURSION_DEPTH = 2;
    // Shader table entries per scene geometry: the shadow hit group, then the reflection one (the
    // shaders' MultiplierForGeometryContributionToHitGroupIndex).
    const HIT_GROUPS_PER_GEOMETRY = 2;

    // Register spaces and slots from shaders/rt_reflections_lighting_cb.h.
    const REFLECTIONS_SPACE_GLOBAL = 0;
    const REFLECTIONS_BINDING_MATERIAL_SAMPLER = 0;
    const REFLECTIONS_BINDING_LIGHTING_CONSTANTS = 0;
    const REFLECTIONS_BINDING_OUTPUT_UAV = 0;
    const REFLECTIONS_BINDING_SCENE_BVH = 0;
    const REFLECTIONS_BINDING_GBUFFER_DEPTH_TEXTURE = 1;
    const REFLECTIONS_BINDING_GBUFFER_0_TEXTURE = 2;
    const REFLECTIONS_BINDING_GBUFFER_1_TEXTURE = 3;
    const REFLECTIONS_BINDING_GBUFFER_2_TEXTURE = 4;
    const REFLECTIONS_BINDING_GBUFFER_3_TEXTURE = 5;

    const REFLECTIONS_SPACE_LOCAL = 1;
    const REFLECTIONS_BINDING_MATERIAL_CONSTANTS = 0;
    const REFLECTIONS_BINDING_INDEX_BUFFER = 0;
    const REFLECTIONS_BINDING_TEX_COORD_BUFFER = 1;
    const REFLECTIONS_BINDING_NORMAL_BUFFER = 2;
    const REFLECTIONS_BINDING_DIFFUSE_TEXTURE = 3;
    const REFLECTIONS_BINDING_SPECULAR_TEXTURE = 4;
    const REFLECTIONS_BINDING_NORMAL_TEXTURE = 5;
    const REFLECTIONS_BINDING_EMISSIVE_TEXTURE = 6;
    const REFLECTIONS_BINDING_OCCLUSION_TEXTURE = 7;
    const REFLECTIONS_BINDING_TRANSMISSION_TEXTURE = 8;
    const REFLECTIONS_BINDING_OPACITY_TEXTURE = 9;

    // struct LightingConstants in shaders/rt_reflections_lighting_cb.h, as f32 offsets:
    // float4 ambientColor; LightConstants light; PlanarViewConstants view. The sizes of the last two
    // come from Donut (see RayTracedReflectionsPass.init).
    const AMBIENT_COLOR_OFFSET = 0;
    const LIGHT_OFFSET = 4;
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

    // Port of Donut-Samples' rt_reflections.cpp: fills a G-buffer with the scene, then a ray
    // generation shader shades each pixel with a ray traced sun shadow and a ray traced reflection,
    // whose closest-hit shader reads the hit geometry's vertices and material through a local
    // binding set per geometry (so D3D12 only); transparent meshes are forward-shaded on top.
    class RayTracedReflectionsPass {
        private app: App;
        private scene: Scene;
        private sunLight: Light;
        private camera: Camera;
        private view: View;
        private shaderLibrary: ShaderLibraryHandle;
        private globalBindingLayout: Opaque;
        private localBindingLayout: Opaque;
        private shaderTable: ShaderTable;
        private constantBuffer: BufferHandle;
        private accelStructs: SceneAccelStructs;
        // Created on the first frame, dropped on resize.
        private renderTargets: GBufferTargets;
        private bindingSet: BindingSet;
        private gbufferPass: GBufferFillPass;
        private forwardPass: ForwardShadingPass;
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
            this.forwardPass = new ForwardShadingPass(null);
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

            const forwardPass = this.forwardPass;
            if (!forwardPass.isNull()) {
                this.app.releaseObject(forwardPass.handle);
                this.forwardPass = new ForwardShadingPass(null);
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
                bindingSetDesc.bindEntireConstantBuffer(REFLECTIONS_BINDING_LIGHTING_CONSTANTS, this.constantBuffer);
                bindingSetDesc.bindAccelStruct(REFLECTIONS_BINDING_SCENE_BVH, this.accelStructs.getTopLevelAS());
                bindingSetDesc.bindTextureSRV(REFLECTIONS_BINDING_GBUFFER_DEPTH_TEXTURE, renderTargets.getTexture(GBufferTexture.Depth));
                bindingSetDesc.bindTextureSRV(REFLECTIONS_BINDING_GBUFFER_0_TEXTURE, renderTargets.getTexture(GBufferTexture.Diffuse));
                bindingSetDesc.bindTextureSRV(REFLECTIONS_BINDING_GBUFFER_1_TEXTURE, renderTargets.getTexture(GBufferTexture.Specular));
                bindingSetDesc.bindTextureSRV(REFLECTIONS_BINDING_GBUFFER_2_TEXTURE, renderTargets.getTexture(GBufferTexture.Normals));
                bindingSetDesc.bindTextureSRV(REFLECTIONS_BINDING_GBUFFER_3_TEXTURE, renderTargets.getTexture(GBufferTexture.Emissive));
                bindingSetDesc.bindTextureUAV(REFLECTIONS_BINDING_OUTPUT_UAV, renderTargets.getShadedColor());
                bindingSetDesc.bindSampler(REFLECTIONS_BINDING_MATERIAL_SAMPLER, this.app.getCommonSampler(CommonSampler.LinearWrap));
                bindingSet = this.app.createBindingSetForLayout(bindingSetDesc, this.globalBindingLayout);

                this.renderTargets = renderTargets;
                this.bindingSet = bindingSet;
            }

            let gbufferPass = this.gbufferPass;
            if (gbufferPass.isNull()) {
                gbufferPass = this.app.createGBufferFillPass();
                this.gbufferPass = gbufferPass;
            }

            let forwardPass = this.forwardPass;
            if (forwardPass.isNull()) {
                forwardPass = this.app.createForwardShadingPass(16);
                this.forwardPass = forwardPass;
            }

            this.camera.getWorldToView(Ref(this.viewMatrix[0]));
            const projection = perspProjD3DStyleReverse(Math.PI * 0.25, width / height, 0.1);
            for (let i = 0; i < 16; i++) {
                this.projMatrix[i] = projection[i];
            }
            this.view.setPlanarView(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);

            frame.clearGBuffer(renderTargets);
            frame.renderSceneToGBuffer(gbufferPass, this.view, renderTargets, this.scene);

            for (let i = 0; i < 4; i++) {
                this.constants[AMBIENT_COLOR_OFFSET + i] = AMBIENT_COLOR;
            }
            this.view.fillPlanarViewConstants(Ref(this.constants[this.viewOffset]));
            this.sunLight.fillConstants(Ref(this.constants[LIGHT_OFFSET]));
            frame.getCommandList().writeBuffer(this.constantBuffer, Ref(this.constants[0]), this.constantsSize);

            frame.dispatchRays(this.shaderTable, bindingSet, width, height);

            frame.renderSceneTransparentOverGBuffer(forwardPass, this.view, renderTargets, this.scene,
                AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR);

            this.app.blitTexture(frame, renderTargets.getShadedColor());
        }

        createRayTracingPipeline(): boolean {
            const shaderLibrary = this.app.createShaderLibrary("rt_reflections.hlsl");
            if (!shaderLibrary) {
                return false;
            }
            this.shaderLibrary = shaderLibrary;

            const globalLayoutDesc = BindingLayoutDesc.create();
            globalLayoutDesc.setRegisterSpace(REFLECTIONS_SPACE_GLOBAL);
            globalLayoutDesc.layoutVolatileConstantBuffer(REFLECTIONS_BINDING_LIGHTING_CONSTANTS);
            globalLayoutDesc.layoutAccelStruct(REFLECTIONS_BINDING_SCENE_BVH);
            globalLayoutDesc.layoutTextureSRV(REFLECTIONS_BINDING_GBUFFER_DEPTH_TEXTURE);
            globalLayoutDesc.layoutTextureSRV(REFLECTIONS_BINDING_GBUFFER_0_TEXTURE);
            globalLayoutDesc.layoutTextureSRV(REFLECTIONS_BINDING_GBUFFER_1_TEXTURE);
            globalLayoutDesc.layoutTextureSRV(REFLECTIONS_BINDING_GBUFFER_2_TEXTURE);
            globalLayoutDesc.layoutTextureSRV(REFLECTIONS_BINDING_GBUFFER_3_TEXTURE);
            globalLayoutDesc.layoutTextureUAV(REFLECTIONS_BINDING_OUTPUT_UAV);
            globalLayoutDesc.layoutSampler(REFLECTIONS_BINDING_MATERIAL_SAMPLER);
            this.globalBindingLayout = this.app.createBindingLayout(globalLayoutDesc, ShaderType.All);

            const localLayoutDesc = BindingLayoutDesc.create();
            localLayoutDesc.setRegisterSpace(REFLECTIONS_SPACE_LOCAL);
            localLayoutDesc.layoutTypedBufferSRV(REFLECTIONS_BINDING_INDEX_BUFFER);
            localLayoutDesc.layoutTypedBufferSRV(REFLECTIONS_BINDING_TEX_COORD_BUFFER);
            localLayoutDesc.layoutTypedBufferSRV(REFLECTIONS_BINDING_NORMAL_BUFFER);
            localLayoutDesc.layoutTextureSRV(REFLECTIONS_BINDING_DIFFUSE_TEXTURE);
            localLayoutDesc.layoutTextureSRV(REFLECTIONS_BINDING_SPECULAR_TEXTURE);
            localLayoutDesc.layoutTextureSRV(REFLECTIONS_BINDING_NORMAL_TEXTURE);
            localLayoutDesc.layoutTextureSRV(REFLECTIONS_BINDING_EMISSIVE_TEXTURE);
            localLayoutDesc.layoutTextureSRV(REFLECTIONS_BINDING_OCCLUSION_TEXTURE);
            localLayoutDesc.layoutTextureSRV(REFLECTIONS_BINDING_TRANSMISSION_TEXTURE);
            localLayoutDesc.layoutTextureSRV(REFLECTIONS_BINDING_OPACITY_TEXTURE);
            localLayoutDesc.layoutConstantBuffer(REFLECTIONS_BINDING_MATERIAL_CONSTANTS);
            this.localBindingLayout = this.app.createBindingLayout(localLayoutDesc, ShaderType.All);

            const pipelineDesc = RtPipelineDesc.create(PAYLOAD_SIZE, MAX_RECURSION_DEPTH);
            pipelineDesc.addGlobalBindingLayout(this.globalBindingLayout);
            pipelineDesc.addShader(shaderLibrary, "RayGen", ShaderType.RayGeneration);
            pipelineDesc.addShader(shaderLibrary, "ShadowMiss", ShaderType.Miss);
            pipelineDesc.addShader(shaderLibrary, "ReflectionMiss", ShaderType.Miss);
            // Shadow rays only need to know whether they hit anything.
            pipelineDesc.addHitGroup(shaderLibrary, "ShadowHitGroup", "", "", null);
            pipelineDesc.addHitGroup(shaderLibrary, "ReflectionHitGroup", "ReflectionClosestHit", "", this.localBindingLayout);

            const pipeline = this.app.createRayTracingPipelineFromDesc(pipelineDesc);
            if (!pipeline) {
                return false;
            }

            const shaderTable = this.app.createEmptyShaderTable(pipeline);
            // The shader table keeps the pipeline alive.
            this.app.releaseResource(pipeline);
            this.shaderTable = shaderTable;

            shaderTable.setRayGeneration("RayGen");
            shaderTable.addMiss("ShadowMiss");
            shaderTable.addMiss("ReflectionMiss");

            // Two entries per geometry, in global geometry index order (which the TLAS instances'
            // hit group offsets assume): shadow, then reflection with the geometry's resources.
            const geometryCount = this.scene.getGeometryCount();
            for (let geometry = 0; geometry < geometryCount; geometry++) {
                const desc = BindingSetDesc.create();
                desc.bindGeometryIndexBuffer(REFLECTIONS_BINDING_INDEX_BUFFER, this.scene, geometry);
                desc.bindGeometryVertexAttribute(REFLECTIONS_BINDING_TEX_COORD_BUFFER, this.scene, geometry, GeometryAttribute.TexCoord1);
                desc.bindGeometryVertexAttribute(REFLECTIONS_BINDING_NORMAL_BUFFER, this.scene, geometry, GeometryAttribute.Normal);
                this.app.bindGeometryMaterialTexture(desc, REFLECTIONS_BINDING_DIFFUSE_TEXTURE, this.scene, geometry,
                    MaterialTexture.BaseOrDiffuse, FallbackTexture.White);
                this.app.bindGeometryMaterialTexture(desc, REFLECTIONS_BINDING_SPECULAR_TEXTURE, this.scene, geometry,
                    MaterialTexture.MetalRoughOrSpecular, FallbackTexture.White);
                this.app.bindGeometryMaterialTexture(desc, REFLECTIONS_BINDING_NORMAL_TEXTURE, this.scene, geometry,
                    MaterialTexture.Normal, FallbackTexture.Black);
                this.app.bindGeometryMaterialTexture(desc, REFLECTIONS_BINDING_EMISSIVE_TEXTURE, this.scene, geometry,
                    MaterialTexture.Emissive, FallbackTexture.Black);
                this.app.bindGeometryMaterialTexture(desc, REFLECTIONS_BINDING_OCCLUSION_TEXTURE, this.scene, geometry,
                    MaterialTexture.Occlusion, FallbackTexture.White);
                this.app.bindGeometryMaterialTexture(desc, REFLECTIONS_BINDING_TRANSMISSION_TEXTURE, this.scene, geometry,
                    MaterialTexture.Transmission, FallbackTexture.Black);
                this.app.bindGeometryMaterialTexture(desc, REFLECTIONS_BINDING_OPACITY_TEXTURE, this.scene, geometry,
                    MaterialTexture.Opacity, FallbackTexture.White);
                desc.bindGeometryMaterialConstants(REFLECTIONS_BINDING_MATERIAL_CONSTANTS, this.scene, geometry);
                const localBindingSet = this.app.createBindingSetForLayout(desc, this.localBindingLayout);

                shaderTable.addHitGroup("ShadowHitGroup", null);
                shaderTable.addHitGroup("ReflectionHitGroup", localBindingSet);
            }

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

            this.accelStructs = this.app.buildSceneAccelStructsWithHitGroupStride(commandList, scene, HIT_GROUPS_PER_GEOMETRY);

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
        Donut_SetAppName("rt_reflections");

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

        // Always D3D12, as in the sample: the reflection hit group's local binding layout needs it.
        const app = App.createWithOptions(GraphicsAPI.D3D12, WINDOW_TITLE, 1280, 720, options);
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

        const reflections = new RayTracedReflectionsPass(app);
        if (!reflections.init(scenePath)) {
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
    return RtReflections.main(argc, argv);
}

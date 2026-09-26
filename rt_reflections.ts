/// <reference path="donut_interop.d.ts" />

// GLFW values, as passed to the keyboard callback.
const KEY_V = 86;
const KEY_ESCAPE = 256;
const ACTION_PRESS = 1;

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

// --- Math -------------------------------------------------------------------------------------
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

// --- Passes -----------------------------------------------------------------------------------

// Port of Donut-Samples' rt_reflections.cpp: fills a G-buffer with the scene, then a ray
// generation shader shades each pixel with a ray traced sun shadow and a ray traced reflection,
// whose closest-hit shader reads the hit geometry's vertices and material through a local
// binding set per geometry (so D3D12 only); transparent meshes are forward-shaded on top.
class RayTracedReflectionsPass {
    private app: Opaque;
    private scene: Opaque;
    private sunLight: Opaque;
    private camera: Opaque;
    private view: Opaque;
    private shaderLibrary: Opaque;
    private globalBindingLayout: Opaque;
    private localBindingLayout: Opaque;
    private shaderTable: Opaque;
    private constantBuffer: Opaque;
    private accelStructs: Opaque;
    // Created on the first frame, dropped on resize.
    private renderTargets: Opaque | null;
    private bindingSet: Opaque | null;
    private gbufferPass: Opaque | null;
    private forwardPass: Opaque | null;
    // The LightingConstants contents; `view` starts at viewOffset.
    private constants: f32[];
    private viewOffset: int;
    private constantsSize: int;
    // Passed to Donut_SetPlanarView, 16 floats each.
    private viewMatrix: f32[];
    private projMatrix: f32[];

    constructor(app: Opaque) {
        this.app = app;
        this.renderTargets = null;
        this.bindingSet = null;
        this.gbufferPass = null;
        this.forwardPass = null;
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
        Donut_CameraKeyboardUpdate(this.camera, key, scancode, action, mods);
        return 1;
    }

    onMousePos(x: number, y: number): int {
        Donut_CameraMousePosUpdate(this.camera, x, y);
        return 1;
    }

    onMouseButton(button: int, action: int, mods: int): int {
        Donut_CameraMouseButtonUpdate(this.camera, button, action, mods);
        return 1;
    }

    onAnimate(elapsedSeconds: number): void {
        Donut_CameraAnimate(this.camera, elapsedSeconds);
        Donut_SetInformativeWindowTitle(this.app, WINDOW_TITLE);
    }

    onBackBufferResizing(): void {
        const bindingSet = this.bindingSet;
        if (bindingSet) {
            Donut_ReleaseResource(this.app, bindingSet);
            this.bindingSet = null;
        }

        const renderTargets = this.renderTargets;
        if (renderTargets) {
            Donut_ReleaseObject(this.app, renderTargets);
            this.renderTargets = null;
        }

        // The blit's cached binding sets still reference the old render targets.
        Donut_ClearBindingCache(this.app);

        const gbufferPass = this.gbufferPass;
        if (gbufferPass) {
            Donut_ReleaseObject(this.app, gbufferPass);
            this.gbufferPass = null;
        }

        const forwardPass = this.forwardPass;
        if (forwardPass) {
            Donut_ReleaseObject(this.app, forwardPass);
            this.forwardPass = null;
        }
    }

    onRender(frame: Opaque): void {
        const width = Donut_GetFrameWidth(frame);
        const height = Donut_GetFrameHeight(frame);

        let renderTargets = this.renderTargets;
        let bindingSet = this.bindingSet;
        if (!renderTargets || !bindingSet) {
            // Reverse Z: depth is cleared to 0.
            renderTargets = Donut_CreateGBufferTargets(this.app, width, height, 1);

            const bindingSetDesc = Donut_CreateBindingSetDesc();
            Donut_BindEntireConstantBuffer(bindingSetDesc, REFLECTIONS_BINDING_LIGHTING_CONSTANTS, this.constantBuffer);
            Donut_BindAccelStruct(bindingSetDesc, REFLECTIONS_BINDING_SCENE_BVH, Donut_GetSceneTopLevelAS(this.accelStructs));
            Donut_BindTextureSRV(bindingSetDesc, REFLECTIONS_BINDING_GBUFFER_DEPTH_TEXTURE, Donut_GetGBufferTexture(renderTargets, GBufferTexture.Depth));
            Donut_BindTextureSRV(bindingSetDesc, REFLECTIONS_BINDING_GBUFFER_0_TEXTURE, Donut_GetGBufferTexture(renderTargets, GBufferTexture.Diffuse));
            Donut_BindTextureSRV(bindingSetDesc, REFLECTIONS_BINDING_GBUFFER_1_TEXTURE, Donut_GetGBufferTexture(renderTargets, GBufferTexture.Specular));
            Donut_BindTextureSRV(bindingSetDesc, REFLECTIONS_BINDING_GBUFFER_2_TEXTURE, Donut_GetGBufferTexture(renderTargets, GBufferTexture.Normals));
            Donut_BindTextureSRV(bindingSetDesc, REFLECTIONS_BINDING_GBUFFER_3_TEXTURE, Donut_GetGBufferTexture(renderTargets, GBufferTexture.Emissive));
            Donut_BindTextureUAV(bindingSetDesc, REFLECTIONS_BINDING_OUTPUT_UAV, Donut_GetGBufferShadedColor(renderTargets));
            Donut_BindSampler(bindingSetDesc, REFLECTIONS_BINDING_MATERIAL_SAMPLER, Donut_GetCommonSampler(this.app, CommonSampler.LinearWrap));
            bindingSet = Donut_CreateBindingSetForLayout(this.app, bindingSetDesc, this.globalBindingLayout);

            this.renderTargets = renderTargets;
            this.bindingSet = bindingSet;
        }

        let gbufferPass = this.gbufferPass;
        if (!gbufferPass) {
            gbufferPass = Donut_CreateGBufferFillPass(this.app);
            this.gbufferPass = gbufferPass;
        }

        let forwardPass = this.forwardPass;
        if (!forwardPass) {
            forwardPass = Donut_CreateForwardShadingPass(this.app, 16);
            this.forwardPass = forwardPass;
        }

        Donut_GetCameraWorldToView(this.camera, Ref(this.viewMatrix[0]));
        const projection = perspProjD3DStyleReverse(Math.PI * 0.25, width / height, 0.1);
        for (let i = 0; i < 16; i++) {
            this.projMatrix[i] = projection[i];
        }
        Donut_SetPlanarView(this.view, Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);

        Donut_ClearGBuffer(frame, renderTargets);
        Donut_RenderSceneToGBuffer(frame, gbufferPass, this.view, renderTargets, this.scene);

        for (let i = 0; i < 4; i++) {
            this.constants[AMBIENT_COLOR_OFFSET + i] = AMBIENT_COLOR;
        }
        Donut_FillPlanarViewConstants(this.view, Ref(this.constants[this.viewOffset]));
        Donut_FillLightConstants(this.sunLight, Ref(this.constants[LIGHT_OFFSET]));
        Donut_WriteBuffer(Donut_GetFrameCommandList(frame), this.constantBuffer, Ref(this.constants[0]), this.constantsSize);

        Donut_DispatchRays(frame, this.shaderTable, bindingSet, width, height);

        Donut_RenderSceneTransparentOverGBuffer(frame, forwardPass, this.view, renderTargets, this.scene,
            AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR);

        Donut_BlitTexture(this.app, frame, Donut_GetGBufferShadedColor(renderTargets));
    }

    createRayTracingPipeline(): boolean {
        const shaderLibrary = Donut_CreateShaderLibrary(this.app, "rt_reflections.hlsl");
        if (!shaderLibrary) {
            return false;
        }
        this.shaderLibrary = shaderLibrary;

        const globalLayoutDesc = Donut_CreateBindingLayoutDesc();
        Donut_SetBindingLayoutRegisterSpace(globalLayoutDesc, REFLECTIONS_SPACE_GLOBAL);
        Donut_LayoutVolatileConstantBuffer(globalLayoutDesc, REFLECTIONS_BINDING_LIGHTING_CONSTANTS);
        Donut_LayoutAccelStruct(globalLayoutDesc, REFLECTIONS_BINDING_SCENE_BVH);
        Donut_LayoutTextureSRV(globalLayoutDesc, REFLECTIONS_BINDING_GBUFFER_DEPTH_TEXTURE);
        Donut_LayoutTextureSRV(globalLayoutDesc, REFLECTIONS_BINDING_GBUFFER_0_TEXTURE);
        Donut_LayoutTextureSRV(globalLayoutDesc, REFLECTIONS_BINDING_GBUFFER_1_TEXTURE);
        Donut_LayoutTextureSRV(globalLayoutDesc, REFLECTIONS_BINDING_GBUFFER_2_TEXTURE);
        Donut_LayoutTextureSRV(globalLayoutDesc, REFLECTIONS_BINDING_GBUFFER_3_TEXTURE);
        Donut_LayoutTextureUAV(globalLayoutDesc, REFLECTIONS_BINDING_OUTPUT_UAV);
        Donut_LayoutSampler(globalLayoutDesc, REFLECTIONS_BINDING_MATERIAL_SAMPLER);
        this.globalBindingLayout = Donut_CreateBindingLayout(this.app, globalLayoutDesc, ShaderType.All);

        const localLayoutDesc = Donut_CreateBindingLayoutDesc();
        Donut_SetBindingLayoutRegisterSpace(localLayoutDesc, REFLECTIONS_SPACE_LOCAL);
        Donut_LayoutTypedBufferSRV(localLayoutDesc, REFLECTIONS_BINDING_INDEX_BUFFER);
        Donut_LayoutTypedBufferSRV(localLayoutDesc, REFLECTIONS_BINDING_TEX_COORD_BUFFER);
        Donut_LayoutTypedBufferSRV(localLayoutDesc, REFLECTIONS_BINDING_NORMAL_BUFFER);
        Donut_LayoutTextureSRV(localLayoutDesc, REFLECTIONS_BINDING_DIFFUSE_TEXTURE);
        Donut_LayoutTextureSRV(localLayoutDesc, REFLECTIONS_BINDING_SPECULAR_TEXTURE);
        Donut_LayoutTextureSRV(localLayoutDesc, REFLECTIONS_BINDING_NORMAL_TEXTURE);
        Donut_LayoutTextureSRV(localLayoutDesc, REFLECTIONS_BINDING_EMISSIVE_TEXTURE);
        Donut_LayoutTextureSRV(localLayoutDesc, REFLECTIONS_BINDING_OCCLUSION_TEXTURE);
        Donut_LayoutTextureSRV(localLayoutDesc, REFLECTIONS_BINDING_TRANSMISSION_TEXTURE);
        Donut_LayoutTextureSRV(localLayoutDesc, REFLECTIONS_BINDING_OPACITY_TEXTURE);
        Donut_LayoutConstantBuffer(localLayoutDesc, REFLECTIONS_BINDING_MATERIAL_CONSTANTS);
        this.localBindingLayout = Donut_CreateBindingLayout(this.app, localLayoutDesc, ShaderType.All);

        const pipelineDesc = Donut_CreateRayTracingPipelineDesc(PAYLOAD_SIZE, MAX_RECURSION_DEPTH);
        Donut_RtPipelineAddGlobalBindingLayout(pipelineDesc, this.globalBindingLayout);
        Donut_RtPipelineAddShader(pipelineDesc, shaderLibrary, "RayGen", ShaderType.RayGeneration);
        Donut_RtPipelineAddShader(pipelineDesc, shaderLibrary, "ShadowMiss", ShaderType.Miss);
        Donut_RtPipelineAddShader(pipelineDesc, shaderLibrary, "ReflectionMiss", ShaderType.Miss);
        // Shadow rays only need to know whether they hit anything.
        Donut_RtPipelineAddHitGroup(pipelineDesc, shaderLibrary, "ShadowHitGroup", "", "", null);
        Donut_RtPipelineAddHitGroup(pipelineDesc, shaderLibrary, "ReflectionHitGroup", "ReflectionClosestHit", "", this.localBindingLayout);

        const pipeline = Donut_CreateRayTracingPipelineFromDesc(this.app, pipelineDesc);
        if (!pipeline) {
            return false;
        }

        const shaderTable = Donut_CreateEmptyShaderTable(this.app, pipeline);
        // The shader table keeps the pipeline alive.
        Donut_ReleaseResource(this.app, pipeline);
        this.shaderTable = shaderTable;

        Donut_ShaderTableSetRayGeneration(shaderTable, "RayGen");
        Donut_ShaderTableAddMiss(shaderTable, "ShadowMiss");
        Donut_ShaderTableAddMiss(shaderTable, "ReflectionMiss");

        // Two entries per geometry, in global geometry index order (which the TLAS instances'
        // hit group offsets assume): shadow, then reflection with the geometry's resources.
        const geometryCount = Donut_GetSceneGeometryCount(this.scene);
        for (let geometry = 0; geometry < geometryCount; geometry++) {
            const desc = Donut_CreateBindingSetDesc();
            Donut_BindGeometryIndexBuffer(desc, REFLECTIONS_BINDING_INDEX_BUFFER, this.scene, geometry);
            Donut_BindGeometryVertexAttribute(desc, REFLECTIONS_BINDING_TEX_COORD_BUFFER, this.scene, geometry, GeometryAttribute.TexCoord1);
            Donut_BindGeometryVertexAttribute(desc, REFLECTIONS_BINDING_NORMAL_BUFFER, this.scene, geometry, GeometryAttribute.Normal);
            Donut_BindGeometryMaterialTexture(this.app, desc, REFLECTIONS_BINDING_DIFFUSE_TEXTURE, this.scene, geometry,
                MaterialTexture.BaseOrDiffuse, FallbackTexture.White);
            Donut_BindGeometryMaterialTexture(this.app, desc, REFLECTIONS_BINDING_SPECULAR_TEXTURE, this.scene, geometry,
                MaterialTexture.MetalRoughOrSpecular, FallbackTexture.White);
            Donut_BindGeometryMaterialTexture(this.app, desc, REFLECTIONS_BINDING_NORMAL_TEXTURE, this.scene, geometry,
                MaterialTexture.Normal, FallbackTexture.Black);
            Donut_BindGeometryMaterialTexture(this.app, desc, REFLECTIONS_BINDING_EMISSIVE_TEXTURE, this.scene, geometry,
                MaterialTexture.Emissive, FallbackTexture.Black);
            Donut_BindGeometryMaterialTexture(this.app, desc, REFLECTIONS_BINDING_OCCLUSION_TEXTURE, this.scene, geometry,
                MaterialTexture.Occlusion, FallbackTexture.White);
            Donut_BindGeometryMaterialTexture(this.app, desc, REFLECTIONS_BINDING_TRANSMISSION_TEXTURE, this.scene, geometry,
                MaterialTexture.Transmission, FallbackTexture.Black);
            Donut_BindGeometryMaterialTexture(this.app, desc, REFLECTIONS_BINDING_OPACITY_TEXTURE, this.scene, geometry,
                MaterialTexture.Opacity, FallbackTexture.White);
            Donut_BindGeometryMaterialConstants(desc, REFLECTIONS_BINDING_MATERIAL_CONSTANTS, this.scene, geometry);
            const localBindingSet = Donut_CreateBindingSetForLayout(this.app, desc, this.localBindingLayout);

            Donut_ShaderTableAddHitGroup(shaderTable, "ShadowHitGroup", null);
            Donut_ShaderTableAddHitGroup(shaderTable, "ReflectionHitGroup", localBindingSet);
        }

        return true;
    }

    // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
    init(scenePath: string): boolean {
        const scene = Donut_LoadScene(this.app, scenePath);
        if (!scene) {
            console.log(`Cannot load the scene ${scenePath}`);
            return false;
        }
        this.scene = scene;

        const sceneGraph = Donut_GetSceneGraph(scene);
        this.sunLight = Donut_AddDirectionalLight(sceneGraph, Donut_GetRootNode(sceneGraph), "Sun",
            0.1, -1.0, 0.15, 0.53, 1.0);
        Donut_RefreshSceneGraph(this.app, sceneGraph);

        this.camera = Donut_CreateFirstPersonCamera(this.app);
        Donut_CameraLookAt(this.camera, 0.0, 1.8, 0.0, 1.0, 1.8, 0.0);
        Donut_CameraSetMoveSpeed(this.camera, 3.0);

        this.view = Donut_CreatePlanarView(this.app);

        this.viewOffset = LIGHT_OFFSET + Donut_GetLightConstantsSize() / 4;
        this.constantsSize = this.viewOffset * 4 + Donut_GetPlanarViewConstantsSize();
        for (let i = 0; i < this.constantsSize / 4; i++) {
            this.constants.push(0.0);
        }
        this.constantBuffer = Donut_CreateVolatileConstantBuffer(this.app, this.constantsSize, "LightingConstants");

        if (!this.createRayTracingPipeline()) {
            return false;
        }

        const commandList = Donut_CreateCommandList(this.app);
        Donut_OpenCommandList(commandList);

        this.accelStructs = Donut_BuildSceneAccelStructsWithHitGroupStride(this.app, commandList, scene, HIT_GROUPS_PER_GEOMETRY);

        Donut_CloseCommandList(commandList);
        Donut_ExecuteCommandList(this.app, commandList);
        Donut_WaitForIdle(this.app);
        Donut_ReleaseResource(this.app, commandList);

        const pass = Donut_AddPass(this.app);
        Donut_SetKeyboardCallback(pass, this.onKey);
        Donut_SetMousePosCallback(pass, this.onMousePos);
        Donut_SetMouseButtonCallback(pass, this.onMouseButton);
        Donut_SetAnimateCallback(pass, this.onAnimate);
        Donut_SetBackBufferResizingCallback(pass, this.onBackBufferResizing);
        Donut_SetRenderCallback(pass, this.onRender);
        return true;
    }
}

class InputPass {
    private app: Opaque;

    constructor(app: Opaque) {
        this.app = app;

        const pass = Donut_AddPass(app);
        Donut_SetKeyboardCallback(pass, this.onKey);
    }

    onKey(key: int, scancode: int, action: int, mods: int): int {
        if (key == KEY_ESCAPE && action == ACTION_PRESS) {
            Donut_CloseWindow(this.app);
            return 1;
        }

        if (key == KEY_V && action == ACTION_PRESS) {
            Donut_SetVsyncEnabled(this.app, Donut_IsVsyncEnabled(this.app) != 0 ? 0 : 1);
            return 1;
        }

        return 0;
    }
}

function main(argc: int, argv: Ref<string>): int {

    // --scene <path>: relative to the executable's directory, or absolute.
    let scenePath = DEFAULT_SCENE;
    for (let i = 1; i + 1 < argc; i++) {
        if (Donut_GetArg(argv, i) == "--scene") {
            scenePath = Donut_GetArg(argv, i + 1);
        }
    }

    // Always D3D12, as in the sample: the reflection hit group's local binding layout needs it.
    const app = Donut_CreateAppForAPI(GraphicsAPI.D3D12, WINDOW_TITLE, 1280, 720);
    if (!app) {
        console.log("Cannot initialize a graphics device with the requested parameters");
        return 1;
    }

    if (!Donut_IsFeatureSupported(app, Feature.RayTracingPipeline)) {
        console.log("The graphics device does not support Ray Tracing Pipelines");
        Donut_DestroyApp(app);
        return 1;
    }

    console.log(`Renderer: ${Donut_GetRendererString(app)}`);

    const reflections = new RayTracedReflectionsPass(app);
    if (!reflections.init(scenePath)) {
        Donut_DestroyApp(app);
        return 1;
    }

    const input = new InputPass(app);

    Donut_RunApp(app);
    Donut_DestroyApp(app);
    return 0;
}

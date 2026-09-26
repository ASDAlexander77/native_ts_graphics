/// <reference path="donut_interop.d.ts" />

// GLFW values, as passed to the keyboard callback.
const KEY_V = 86;
const KEY_ESCAPE = 256;
const ACTION_PRESS = 1;

const WINDOW_TITLE = "Donut Example: Ray Traced Shadows";
const DEFAULT_SCENE = "media/glTF-Sample-Assets/Models/Sponza/glTF/Sponza.gltf";

// sizeof(float4): the ray tracing pipeline's payload size, as in the sample.
const PAYLOAD_SIZE = 16;

// struct LightingConstants in shaders/rt_shadows_lighting_cb.h, as f32 offsets:
// float4 ambientColor; LightConstants light; PlanarViewConstants view. The sizes of the last two
// come from Donut (see RayTracedShadowsPass.init).
const AMBIENT_COLOR_OFFSET = 0;
const LIGHT_OFFSET = 4;

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

// Port of Donut-Samples' rt_shadows.cpp: fills a G-buffer with the scene, then a ray generation
// shader traces one ray per pixel towards the sun and shades the pixel, lit or in shadow.
class RayTracedShadowsPass {
    private app: Opaque;
    private scene: Opaque;
    private sunLight: Opaque;
    private camera: Opaque;
    private view: Opaque;
    private bindingLayout: Opaque;
    private shaderTable: Opaque;
    private constantBuffer: Opaque;
    private accelStructs: Opaque;
    // Created on the first frame, dropped on resize.
    private renderTargets: Opaque | null;
    private bindingSet: Opaque | null;
    private gbufferPass: Opaque | null;
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
            Donut_BindEntireConstantBuffer(bindingSetDesc, 0, this.constantBuffer);
            Donut_BindAccelStruct(bindingSetDesc, 0, Donut_GetSceneTopLevelAS(this.accelStructs));
            Donut_BindTextureSRV(bindingSetDesc, 1, Donut_GetGBufferTexture(renderTargets, GBufferTexture.Depth));
            Donut_BindTextureSRV(bindingSetDesc, 2, Donut_GetGBufferTexture(renderTargets, GBufferTexture.Diffuse));
            Donut_BindTextureSRV(bindingSetDesc, 3, Donut_GetGBufferTexture(renderTargets, GBufferTexture.Specular));
            Donut_BindTextureSRV(bindingSetDesc, 4, Donut_GetGBufferTexture(renderTargets, GBufferTexture.Normals));
            Donut_BindTextureSRV(bindingSetDesc, 5, Donut_GetGBufferTexture(renderTargets, GBufferTexture.Emissive));
            Donut_BindTextureUAV(bindingSetDesc, 0, Donut_GetGBufferShadedColor(renderTargets));
            bindingSet = Donut_CreateBindingSetForLayout(this.app, bindingSetDesc, this.bindingLayout);

            this.renderTargets = renderTargets;
            this.bindingSet = bindingSet;
        }

        Donut_GetCameraWorldToView(this.camera, Ref(this.viewMatrix[0]));
        const projection = perspProjD3DStyleReverse(Math.PI * 0.25, width / height, 0.1);
        for (let i = 0; i < 16; i++) {
            this.projMatrix[i] = projection[i];
        }
        Donut_SetPlanarView(this.view, Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);

        let gbufferPass = this.gbufferPass;
        if (!gbufferPass) {
            gbufferPass = Donut_CreateGBufferFillPass(this.app);
            this.gbufferPass = gbufferPass;
        }

        Donut_ClearGBuffer(frame, renderTargets);
        Donut_RenderSceneToGBuffer(frame, gbufferPass, this.view, renderTargets, this.scene);

        for (let i = 0; i < 4; i++) {
            this.constants[AMBIENT_COLOR_OFFSET + i] = 0.05;
        }
        Donut_FillPlanarViewConstants(this.view, Ref(this.constants[this.viewOffset]));
        Donut_FillLightConstants(this.sunLight, Ref(this.constants[LIGHT_OFFSET]));
        Donut_WriteBuffer(Donut_GetFrameCommandList(frame), this.constantBuffer, Ref(this.constants[0]), this.constantsSize);

        Donut_DispatchRays(frame, this.shaderTable, bindingSet, width, height);

        Donut_BlitTexture(this.app, frame, Donut_GetGBufferShadedColor(renderTargets));
    }

    createRayTracingPipeline(): boolean {
        const shaderLibrary = Donut_CreateShaderLibrary(this.app, "rt_shadows.hlsl");
        if (!shaderLibrary) {
            return false;
        }

        const layoutDesc = Donut_CreateBindingLayoutDesc();
        Donut_LayoutVolatileConstantBuffer(layoutDesc, 0);
        Donut_LayoutAccelStruct(layoutDesc, 0);
        Donut_LayoutTextureSRV(layoutDesc, 1);
        Donut_LayoutTextureSRV(layoutDesc, 2);
        Donut_LayoutTextureSRV(layoutDesc, 3);
        Donut_LayoutTextureSRV(layoutDesc, 4);
        Donut_LayoutTextureSRV(layoutDesc, 5);
        Donut_LayoutTextureUAV(layoutDesc, 0);
        this.bindingLayout = Donut_CreateBindingLayout(this.app, layoutDesc, ShaderType.All);

        // The hit group has no shaders: a hit just leaves the payload's `missed` false.
        const pipeline = Donut_CreateRayTracingPipeline(this.app, shaderLibrary, this.bindingLayout,
            "RayGen", "Miss", "HitGroup", "", PAYLOAD_SIZE);
        if (!pipeline) {
            return false;
        }

        this.shaderTable = Donut_CreateShaderTable(this.app, pipeline, "RayGen", "HitGroup", "Miss");
        // The shader table keeps the pipeline alive.
        Donut_ReleaseResource(this.app, pipeline);
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

        this.accelStructs = Donut_BuildSceneAccelStructs(this.app, commandList, scene);

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

function main(argc: int, argv: Opaque): int {

    // --scene <path>: relative to the executable's directory, or absolute.
    let scenePath = DEFAULT_SCENE;
    for (let i = 1; i + 1 < argc; i++) {
        if (Donut_GetArg(argv, i) == "--scene") {
            scenePath = Donut_GetArg(argv, i + 1);
        }
    }

    const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
    const app = Donut_CreateAppWithOptions(api, WINDOW_TITLE, 1280, 720, AppOptions.RayTracing);
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

    const rayTracedShadows = new RayTracedShadowsPass(app);
    if (!rayTracedShadows.init(scenePath)) {
        Donut_DestroyApp(app);
        return 1;
    }

    const input = new InputPass(app);

    Donut_RunApp(app);
    Donut_DestroyApp(app);
    return 0;
}

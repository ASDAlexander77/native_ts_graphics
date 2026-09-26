/// <reference path="donut_interop.d.ts" />

// GLFW values, as passed to the keyboard callback.
const KEY_SPACE = 32;
const KEY_V = 86;
const KEY_ESCAPE = 256;
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

// Port of Donut-Samples' rt_bindless.cpp: ray traces an animated scene (Sponza with two dancing
// robots), primary rays and sun shadows, reading all geometry and textures through bindless
// resource arrays. Uses a ray tracing pipeline, or with -rayQuery, inline ray queries in a
// compute shader. Space pauses the animations.
class BindlessRayTracingPass {
    private app: Opaque;
    private useRayQuery: boolean;
    private scene: Opaque;
    private sunLight: Opaque;
    private camera: Opaque;
    private view: Opaque;
    private bindlessLayout: Opaque;
    private bindingLayout: Opaque;
    private descriptorTable: Opaque;
    private constantBuffer: Opaque;
    private accelStructs: Opaque;
    private shaderLibrary: Opaque;
    // One of these two, depending on useRayQuery.
    private shaderTable: Opaque;
    private computePipeline: Opaque;
    // Created on the first frame, dropped on resize.
    private colorBuffer: Opaque | null;
    private bindingSet: Opaque | null;
    private enableAnimations: boolean;
    private wallclockTime: number;
    // The LightingConstants contents; `view` starts at viewOffset.
    private constants: f32[];
    private viewOffset: int;
    private constantsSize: int;
    // Passed to Donut_SetPlanarView, 16 floats each.
    private viewMatrix: f32[];
    private projMatrix: f32[];

    constructor(app: Opaque, useRayQuery: boolean) {
        this.app = app;
        this.useRayQuery = useRayQuery;
        this.colorBuffer = null;
        this.bindingSet = null;
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
        Donut_CameraKeyboardUpdate(this.camera, key, scancode, action, mods);

        if (key == KEY_SPACE && action == ACTION_PRESS) {
            this.enableAnimations = !this.enableAnimations;
        }

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

    onMouseScroll(xOffset: number, yOffset: number): int {
        Donut_CameraMouseScrollUpdate(this.camera, xOffset, yOffset);
        return 1;
    }

    onAnimate(elapsedSeconds: number): void {
        Donut_CameraAnimate(this.camera, elapsedSeconds);

        if (this.enableAnimations) {
            this.wallclockTime += elapsedSeconds;
            // Each animation starts a second after the previous one.
            let offset = 0.0;

            const animationCount = Donut_GetSceneAnimationCount(this.scene);
            for (let i = 0; i < animationCount; i++) {
                const duration = Donut_GetSceneAnimationDuration(this.scene, i);
                const cycles = (this.wallclockTime + offset) / duration;
                const animationTime = (cycles - Math.floor(cycles)) * duration;
                Donut_ApplySceneAnimation(this.scene, i, animationTime);
                offset += 1.0;
            }
        }

        Donut_SetInformativeWindowTitleWithInfo(this.app, WINDOW_TITLE,
            this.useRayQuery ? "- using RayQuery" : "- using RayPipeline");
    }

    onBackBufferResizing(): void {
        const bindingSet = this.bindingSet;
        if (bindingSet) {
            Donut_ReleaseResource(this.app, bindingSet);
            this.bindingSet = null;
        }

        const colorBuffer = this.colorBuffer;
        if (colorBuffer) {
            Donut_ReleaseResource(this.app, colorBuffer);
            this.colorBuffer = null;
        }

        // The blit's cached binding sets still reference the old color buffer.
        Donut_ClearBindingCache(this.app);
    }

    onRender(frame: Opaque): void {
        const width = Donut_GetFrameWidth(frame);
        const height = Donut_GetFrameHeight(frame);

        let colorBuffer = this.colorBuffer;
        let bindingSet = this.bindingSet;
        if (!colorBuffer || !bindingSet) {
            colorBuffer = Donut_CreateUAVTextureForFrameWithFormat(this.app, frame, "ColorBuffer", Format.RGBA16_FLOAT);

            const bindingSetDesc = Donut_CreateBindingSetDesc();
            Donut_BindEntireConstantBuffer(bindingSetDesc, 0, this.constantBuffer);
            Donut_BindAccelStruct(bindingSetDesc, 0, Donut_GetSceneTopLevelAS(this.accelStructs));
            Donut_BindStructuredBufferSRV(bindingSetDesc, 1, Donut_GetSceneBuffer(this.scene, SceneBuffer.Instances));
            Donut_BindStructuredBufferSRV(bindingSetDesc, 2, Donut_GetSceneBuffer(this.scene, SceneBuffer.Geometries));
            Donut_BindStructuredBufferSRV(bindingSetDesc, 3, Donut_GetSceneBuffer(this.scene, SceneBuffer.Materials));
            Donut_BindSampler(bindingSetDesc, 0, Donut_GetCommonSampler(this.app, CommonSampler.AnisotropicWrap));
            Donut_BindTextureUAV(bindingSetDesc, 0, colorBuffer);
            bindingSet = Donut_CreateBindingSetForLayout(this.app, bindingSetDesc, this.bindingLayout);

            this.colorBuffer = colorBuffer;
            this.bindingSet = bindingSet;
        }

        Donut_GetCameraWorldToView(this.camera, Ref(this.viewMatrix[0]));
        const projection = perspProjD3DStyleReverse(Math.PI * 0.25, width / height, 0.1);
        for (let i = 0; i < 16; i++) {
            this.projMatrix[i] = projection[i];
        }
        Donut_SetPlanarView(this.view, Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);

        Donut_RefreshScene(this.app, frame, this.scene);
        Donut_UpdateSceneAccelStructs(this.app, frame, this.accelStructs, this.scene);

        for (let i = 0; i < 4; i++) {
            this.constants[AMBIENT_COLOR_OFFSET + i] = 0.05;
        }
        Donut_FillPlanarViewConstants(this.view, Ref(this.constants[this.viewOffset]));
        Donut_FillLightConstants(this.sunLight, Ref(this.constants[LIGHT_OFFSET]));
        Donut_WriteBuffer(Donut_GetFrameCommandList(frame), this.constantBuffer, Ref(this.constants[0]), this.constantsSize);

        if (this.useRayQuery) {
            const groupsX: int = Math.floor((width + COMPUTE_GROUP_SIZE - 1) / COMPUTE_GROUP_SIZE);
            const groupsY: int = Math.floor((height + COMPUTE_GROUP_SIZE - 1) / COMPUTE_GROUP_SIZE);
            Donut_DispatchWithDescriptorTable(Donut_GetFrameCommandList(frame), this.computePipeline, bindingSet,
                this.descriptorTable, groupsX, groupsY, 1);
        } else {
            Donut_DispatchRaysWithDescriptorTable(frame, this.shaderTable, bindingSet, this.descriptorTable, width, height);
        }

        Donut_BlitTexture(this.app, frame, colorBuffer);
    }

    createRayTracingPipeline(): boolean {
        const shaderLibrary = Donut_CreateShaderLibraryWithDefine(this.app, "rt_bindless.hlsl", "USE_RAY_QUERY", "0");
        if (!shaderLibrary) {
            return false;
        }
        this.shaderLibrary = shaderLibrary;

        const pipeline = Donut_CreateRayTracingPipelineWithLayouts(this.app, shaderLibrary, this.bindingLayout, this.bindlessLayout,
            "RayGen", "Miss", "HitGroup", "ClosestHit", "AnyHit", PAYLOAD_SIZE);
        if (!pipeline) {
            return false;
        }

        const shaderTable = Donut_CreateCachedShaderTable(this.app, pipeline, "RayGen", "HitGroup", "Miss", 3, "Shader Table");
        // The shader table keeps the pipeline alive.
        Donut_ReleaseResource(this.app, pipeline);
        if (!shaderTable) {
            return false;
        }
        this.shaderTable = shaderTable;
        return true;
    }

    createComputePipeline(): boolean {
        const computeShader = Donut_CreateShaderWithDefine(this.app, "rt_bindless.hlsl", "main", ShaderType.Compute,
            "USE_RAY_QUERY", "1");
        if (!computeShader) {
            return false;
        }

        const pipeline = Donut_CreateComputePipelineWithLayouts(this.app, computeShader, this.bindingLayout, this.bindlessLayout);
        if (!pipeline) {
            return false;
        }
        this.computePipeline = pipeline;
        return true;
    }

    // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
    init(scenePath: string): boolean {
        const bindlessLayoutDesc = Donut_CreateBindlessLayoutDesc(0, 1024, ShaderType.All);
        Donut_BindlessLayoutAddRawBuffers(bindlessLayoutDesc, 1);
        Donut_BindlessLayoutAddTextures(bindlessLayoutDesc, 2);
        this.bindlessLayout = Donut_CreateBindlessLayout(this.app, bindlessLayoutDesc);

        const layoutDesc = Donut_CreateBindingLayoutDesc();
        Donut_LayoutVolatileConstantBuffer(layoutDesc, 0);
        Donut_LayoutAccelStruct(layoutDesc, 0);
        Donut_LayoutStructuredBufferSRV(layoutDesc, 1);
        Donut_LayoutStructuredBufferSRV(layoutDesc, 2);
        Donut_LayoutStructuredBufferSRV(layoutDesc, 3);
        Donut_LayoutSampler(layoutDesc, 0);
        Donut_LayoutTextureUAV(layoutDesc, 0);
        this.bindingLayout = Donut_CreateBindingLayout(this.app, layoutDesc, ShaderType.All);

        const descriptorTableManager = Donut_CreateDescriptorTableManager(this.app, this.bindlessLayout);
        this.descriptorTable = Donut_GetDescriptorTable(descriptorTableManager);

        const scene = Donut_LoadSceneWithDescriptorTable(this.app, scenePath, descriptorTableManager);
        if (!scene) {
            console.log(`Cannot load the scene ${scenePath}`);
            return false;
        }
        this.scene = scene;

        const sceneGraph = Donut_GetSceneGraph(scene);
        this.sunLight = Donut_AddDirectionalLight(sceneGraph, Donut_GetRootNode(sceneGraph), "Sun",
            0.1, -1.0, -0.15, 0.53, 5.0);
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

        if (this.useRayQuery ? !this.createComputePipeline() : !this.createRayTracingPipeline()) {
            return false;
        }

        const commandList = Donut_CreateCommandList(this.app);
        Donut_OpenCommandList(commandList);

        this.accelStructs = Donut_CreateAnimatedSceneAccelStructs(this.app, commandList, scene);

        Donut_CloseCommandList(commandList);
        Donut_ExecuteCommandList(this.app, commandList);
        Donut_WaitForIdle(this.app);
        Donut_ReleaseResource(this.app, commandList);

        const pass = Donut_AddPass(this.app);
        Donut_SetKeyboardCallback(pass, this.onKey);
        Donut_SetMousePosCallback(pass, this.onMousePos);
        Donut_SetMouseButtonCallback(pass, this.onMouseButton);
        Donut_SetMouseScrollCallback(pass, this.onMouseScroll);
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
    const app = Donut_CreateAppWithOptions(api, WINDOW_TITLE, 1280, 720, options);
    if (!app) {
        console.log("Cannot initialize a graphics device with the requested parameters");
        return 1;
    }

    if (!useRayQuery && !Donut_IsFeatureSupported(app, Feature.RayTracingPipeline)) {
        console.log("The graphics device does not support Ray Tracing Pipelines");
        Donut_DestroyApp(app);
        return 1;
    }

    if (useRayQuery && !Donut_IsFeatureSupported(app, Feature.RayQuery)) {
        console.log("The graphics device does not support Ray Queries");
        Donut_DestroyApp(app);
        return 1;
    }

    console.log(`Renderer: ${Donut_GetRendererString(app)}`);

    const rayTracing = new BindlessRayTracingPass(app, useRayQuery);
    if (!rayTracing.init(scenePath)) {
        Donut_DestroyApp(app);
        return 1;
    }

    const input = new InputPass(app);

    Donut_RunApp(app);
    Donut_DestroyApp(app);
    return 0;
}

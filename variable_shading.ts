/// <reference path="donut_interop.d.ts" />

// GLFW values, as passed to the keyboard callback.
const KEY_V = 86;
const KEY_ESCAPE = 256;
const ACTION_PRESS = 1;

const WINDOW_TITLE = "Donut Example: Variable Rate Shading";
const DEFAULT_SCENE = "media/glTF-Sample-Assets/Models/Sponza/glTF/Sponza.gltf";

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

// Port of Donut-Samples' variable_shading.cpp (NVIDIA Variable Rate Shading sample): a compute
// shader fills a shading rate surface from the previous frame (coarse 4x4 shading where it was
// more green than red), the scene is forward-shaded with it, then TAA runs at full rate.
//
// With -raw on D3D12, the shading rate surface is bound through the D3D12 API directly instead
// of through NVRHI.
class VariableRateShadingPass {
    private app: Opaque;
    private useRawD3D12: boolean;
    private scene: Opaque;
    private camera: Opaque;
    private view: Opaque;
    private viewPrevious: Opaque;
    private previousViewsValid: boolean;
    private shadingRateSurfaceShader: Opaque;
    private vrsTileSize: int;
    // Created on the first frame, dropped on resize.
    private renderTargets: Opaque | null;
    private forwardPass: Opaque | null;
    private temporalPass: Opaque | null;
    private shadingRateSurface: Opaque | null;
    private bindingSet: Opaque | null;
    private pipeline: Opaque | null;
    // Passed to Donut_SetPlanarView, 16 floats each.
    private viewMatrix: f32[];
    private projMatrix: f32[];

    constructor(app: Opaque, useRawD3D12: boolean) {
        this.app = app;
        this.useRawD3D12 = useRawD3D12;
        this.previousViewsValid = false;
        this.vrsTileSize = 0;
        this.renderTargets = null;
        this.forwardPass = null;
        this.temporalPass = null;
        this.shadingRateSurface = null;
        this.bindingSet = null;
        this.pipeline = null;
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
        const renderTargets = this.renderTargets;
        if (renderTargets) {
            Donut_ReleaseObject(this.app, renderTargets);
            this.renderTargets = null;
        }

        Donut_ClearBindingCache(this.app);

        const forwardPass = this.forwardPass;
        if (forwardPass) {
            Donut_ReleaseObject(this.app, forwardPass);
            this.forwardPass = null;
        }

        const shadingRateSurface = this.shadingRateSurface;
        if (shadingRateSurface) {
            Donut_ReleaseResource(this.app, shadingRateSurface);
            this.shadingRateSurface = null;
        }

        const temporalPass = this.temporalPass;
        if (temporalPass) {
            Donut_ReleaseObject(this.app, temporalPass);
            this.temporalPass = null;
        }

        const pipeline = this.pipeline;
        if (pipeline) {
            Donut_ReleaseResource(this.app, pipeline);
            this.pipeline = null;
        }

        const bindingSet = this.bindingSet;
        if (bindingSet) {
            Donut_ReleaseResource(this.app, bindingSet);
            this.bindingSet = null;
        }
    }

    onRender(frame: Opaque): void {
        const width = Donut_GetFrameWidth(frame);
        const height = Donut_GetFrameHeight(frame);

        let renderTargets = this.renderTargets;
        if (!renderTargets) {
            renderTargets = Donut_CreateTemporalTargets(this.app, width, height);
            this.renderTargets = renderTargets;
        }

        Donut_GetCameraWorldToView(this.camera, Ref(this.viewMatrix[0]));
        const projection = perspProjD3DStyleReverse(Math.PI * 0.25, width / height, 0.1);
        for (let i = 0; i < 16; i++) {
            this.projMatrix[i] = projection[i];
        }
        Donut_SetPlanarView(this.view, Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);

        // VRS-specific code starts here
        // Use the queried tile size to determine the size of the VRS surface; it will be
        // approximately 1/tileSize in both dimensions (with some rounding).
        const surfaceWidth: int = Math.floor((width + this.vrsTileSize - 1) / this.vrsTileSize);
        const surfaceHeight: int = Math.floor((height + this.vrsTileSize - 1) / this.vrsTileSize);
        let shadingRateSurface = this.shadingRateSurface;
        if (!shadingRateSurface) {
            shadingRateSurface = Donut_CreateShadingRateSurface(this.app, surfaceWidth, surfaceHeight);
            this.shadingRateSurface = shadingRateSurface;
        }

        let forwardPass = this.forwardPass;
        if (!forwardPass) {
            forwardPass = Donut_CreateForwardShadingPass(this.app, 16);
            this.forwardPass = forwardPass;
            if (!this.useRawD3D12) {
                Donut_SetTemporalTargetsShadingRateSurface(renderTargets, shadingRateSurface);
            }
        }

        let temporalPass = this.temporalPass;
        if (!temporalPass) {
            temporalPass = Donut_CreateTemporalAntiAliasingPass(this.app, this.view, renderTargets);
            this.temporalPass = temporalPass;
        }

        // A pipeline state for the compute shader which will generate the VRS surface.
        let pipeline = this.pipeline;
        let bindingSet = this.bindingSet;
        if (!pipeline || !bindingSet) {
            const bindingSetDesc = Donut_CreateBindingSetDesc();
            Donut_BindTextureUAV(bindingSetDesc, 0, shadingRateSurface);
            Donut_BindTextureSRV(bindingSetDesc, 0, Donut_GetTemporalTargetsTexture(renderTargets, TemporalTexture.MotionVectors));
            Donut_BindTextureSRV(bindingSetDesc, 1, Donut_GetTemporalTargetsTexture(renderTargets, TemporalTexture.HdrColor));
            bindingSet = Donut_CreateBindingSet(this.app, bindingSetDesc, ShaderType.Compute);
            pipeline = Donut_CreateComputePipeline(this.app, this.shadingRateSurfaceShader, bindingSet);

            this.bindingSet = bindingSet;
            this.pipeline = pipeline;
        }

        if (this.previousViewsValid) {
            Donut_RenderMotionVectors(frame, temporalPass, this.view, this.viewPrevious);
        }

        // Dispatch call to generate the VRS surface.
        Donut_Dispatch(Donut_GetFrameCommandList(frame), pipeline, bindingSet, surfaceWidth, surfaceHeight, 1);

        Donut_ClearTemporalTargets(frame, renderTargets);

        if (this.useRawD3D12) {
            Donut_BeginD3D12ShadingRateImage(frame, shadingRateSurface);
        } else {
            // Enable VRS, with a per-draw shading rate of 1x1, and make the shading rate image
            // result always override all others.
            Donut_SetViewVariableRateShading(this.view, 1);
        }

        // Forward pass to draw the scene with the VRS surface set above.
        Donut_RenderSceneForward(frame, forwardPass, this.view, renderTargets, this.scene,
            AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR);

        if (this.useRawD3D12) {
            Donut_EndD3D12ShadingRateImage(frame, shadingRateSurface);
        } else {
            Donut_SetViewVariableRateShading(this.view, 0);
        }
        // VRS-specific code ends here

        // TAA pass (runs at full rate).
        Donut_TemporalResolve(frame, temporalPass, this.view, this.previousViewsValid ? 1 : 0);
        Donut_CopyPlanarView(this.viewPrevious, this.view);
        this.previousViewsValid = true;

        Donut_BlitTexture(this.app, frame, Donut_GetTemporalTargetsTexture(renderTargets, TemporalTexture.ResolvedColor));
    }

    // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
    init(scenePath: string): boolean {
        this.shadingRateSurfaceShader = Donut_CreateShader(this.app, "variable_shading.hlsl", "main_cs", ShaderType.Compute);
        if (!this.shadingRateSurfaceShader) {
            return false;
        }

        const scene = Donut_LoadScene(this.app, scenePath);
        if (!scene) {
            console.log(`Cannot load the scene ${scenePath}`);
            return false;
        }
        this.scene = scene;

        const sceneGraph = Donut_GetSceneGraph(scene);
        Donut_AddDirectionalLight(sceneGraph, Donut_GetRootNode(sceneGraph), "Sun", 0.1, -1.0, 0.15, 0.53, 2.0);
        Donut_RefreshSceneGraph(this.app, sceneGraph);

        this.camera = Donut_CreateFirstPersonCamera(this.app);
        Donut_CameraLookAt(this.camera, 0.0, 1.8, 0.0, 1.0, 1.8, 0.0);
        Donut_CameraSetMoveSpeed(this.camera, 3.0);

        this.view = Donut_CreatePlanarView(this.app);
        this.viewPrevious = Donut_CreatePlanarView(this.app);

        // Query VRS tile size (it can vary depending on hardware).
        this.vrsTileSize = this.useRawD3D12
            ? Donut_GetD3D12ShadingRateTileSize(this.app)
            : Donut_GetShadingRateTileSize(this.app);

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

    const app = Donut_CreateAppForAPI(api, WINDOW_TITLE, 1280, 720);
    if (!app) {
        console.log("Cannot initialize a graphics device with the requested parameters");
        return 1;
    }

    if (!Donut_IsFeatureSupported(app, Feature.VariableRateShading)) {
        console.log("The device does not support Variable Rate Shading");
        Donut_DestroyApp(app);
        return 1;
    }

    console.log(`Renderer: ${Donut_GetRendererString(app)}`);

    const variableRateShading = new VariableRateShadingPass(app, rawD3D12);
    if (!variableRateShading.init(scenePath)) {
        Donut_DestroyApp(app);
        return 1;
    }

    const input = new InputPass(app);

    Donut_RunApp(app);
    Donut_DestroyApp(app);
    return 0;
}

/// <reference path="donut_interop.d.ts" />

// GLFW values, as passed to the keyboard callback.
const KEY_ESCAPE = 256;
const ACTION_PRESS = 1;

const WINDOW_TITLE = "Donut Example: Ray Traced Triangle";

// sizeof(float4) of the HitInfo payload in rt_triangle.hlsl.
const PAYLOAD_SIZE = 16;
const UINT_SIZE = 4;
const FLOAT3_SIZE = 12;

// --- Passes ---------------------------------------------------------------------------------

// Port of Donut-Samples' rt_triangle.cpp.
class RayTracedTrianglePass {
    private app: Opaque;
    private shaderLibrary: Opaque;
    private bindingLayout: Opaque;
    private shaderTable: Opaque;
    // Kept alive for as long as the TLAS: only the D3D12 backend of NVRHI references it from there.
    private bottomLevelAS: Opaque;
    private topLevelAS: Opaque;
    // Created on the first frame (they depend on the framebuffer size), dropped on resize.
    private renderTarget: Opaque | null;
    private bindingSet: Opaque | null;

    constructor(app: Opaque) {
        this.app = app;
        this.renderTarget = null;
        this.bindingSet = null;
    }

    onBackBufferResizing(): void {
        const bindingSet = this.bindingSet;
        if (bindingSet) {
            Donut_ReleaseResource(this.app, bindingSet);
            this.bindingSet = null;
        }

        const renderTarget = this.renderTarget;
        if (renderTarget) {
            Donut_ReleaseResource(this.app, renderTarget);
            this.renderTarget = null;
        }

        // The blit's cached binding sets still reference the old render target.
        Donut_ClearBindingCache(this.app);
    }

    onAnimate(elapsedSeconds: number): void {
        Donut_SetInformativeWindowTitle(this.app, WINDOW_TITLE);
    }

    onRender(frame: Opaque): void {
        let renderTarget = this.renderTarget;
        let bindingSet = this.bindingSet;
        if (!renderTarget || !bindingSet) {
            renderTarget = Donut_CreateUAVTextureForFrame(this.app, frame, "RenderTarget");

            const bindingSetDesc = Donut_CreateBindingSetDesc();
            Donut_BindAccelStruct(bindingSetDesc, 0, this.topLevelAS);
            Donut_BindTextureUAV(bindingSetDesc, 0, renderTarget);
            bindingSet = Donut_CreateBindingSetForLayout(this.app, bindingSetDesc, this.bindingLayout);

            this.renderTarget = renderTarget;
            this.bindingSet = bindingSet;
        }

        Donut_DispatchRays(frame, this.shaderTable, bindingSet, Donut_GetFrameWidth(frame), Donut_GetFrameHeight(frame));
        Donut_BlitTexture(this.app, frame, renderTarget);
    }

    // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
    init(): boolean {
        this.shaderLibrary = Donut_CreateShaderLibrary(this.app, "rt_triangle.hlsl");
        if (!this.shaderLibrary) {
            return false;
        }

        const layoutDesc = Donut_CreateBindingLayoutDesc();
        Donut_LayoutAccelStruct(layoutDesc, 0);
        Donut_LayoutTextureUAV(layoutDesc, 0);
        this.bindingLayout = Donut_CreateBindingLayout(this.app, layoutDesc, ShaderType.All);

        const pipeline = Donut_CreateRayTracingPipeline(this.app, this.shaderLibrary, this.bindingLayout,
            "RayGen", "Miss", "HitGroup", "ClosestHit", PAYLOAD_SIZE);
        if (!pipeline) {
            return false;
        }

        this.shaderTable = Donut_CreateShaderTable(this.app, pipeline, "RayGen", "HitGroup", "Miss");
        // The shader table keeps the pipeline alive.
        Donut_ReleaseResource(this.app, pipeline);

        const commandList = Donut_CreateCommandList(this.app);
        Donut_OpenCommandList(commandList);

        const indexBuffer = Donut_CreateAccelStructInputBuffer(this.app, UINT_SIZE * 3, "IndexBuffer");
        const vertexBuffer = Donut_CreateAccelStructInputBuffer(this.app, FLOAT3_SIZE * 3, "VertexBuffer");

        // `let`, not `const`: tslang takes the address of the array's storage only for non-const arrays.
        let indices: int[] = [0, 1, 2];
        Donut_WriteBuffer(commandList, indexBuffer, Ref(indices[0]), UINT_SIZE * 3);
        let vertices: f32[] = [0.0, -1.0, 1.0,   -1.0, 1.0, 1.0,   1.0, 1.0, 1.0];
        Donut_WriteBuffer(commandList, vertexBuffer, Ref(vertices[0]), FLOAT3_SIZE * 3);

        this.bottomLevelAS = Donut_BuildTriangleBLAS(this.app, commandList, indexBuffer, 3, vertexBuffer, 3);
        this.topLevelAS = Donut_BuildSingleInstanceTLAS(this.app, commandList, this.bottomLevelAS);

        Donut_CloseCommandList(commandList);
        Donut_ExecuteCommandList(this.app, commandList);

        // Only needed for the builds: NVRHI keeps everything a submitted command list uses alive
        // until the GPU is done with it.
        Donut_ReleaseResource(this.app, indexBuffer);
        Donut_ReleaseResource(this.app, vertexBuffer);
        Donut_ReleaseResource(this.app, commandList);

        const pass = Donut_AddPass(this.app);
        Donut_SetBackBufferResizingCallback(pass, this.onBackBufferResizing);
        Donut_SetAnimateCallback(pass, this.onAnimate);
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

        return 0;
    }
}

function main(argc: int, argv: Opaque): int {

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

    const rayTracing = new RayTracedTrianglePass(app);
    if (!rayTracing.init()) {
        console.log("Cannot initialize the ray tracing pipeline");
        Donut_DestroyApp(app);
        return 1;
    }

    const input = new InputPass(app);

    Donut_RunApp(app);
    Donut_DestroyApp(app);
    return 0;
}

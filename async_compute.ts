/// <reference path="donut_interop.d.ts" />

// GLFW values, as passed to the keyboard callback.
const KEY_ESCAPE = 256;
const ACTION_PRESS = 1;

const WINDOW_TITLE = "Donut Example: Async Compute";

// Textures the compute queue writes and the render thread shows, in turns.
const NUM_TEXTURES = 2;
const TEXTURE_SIZE = 512;
// main_cs in async_compute.hlsl runs 8 x 8 threads per group.
const COMPUTE_GROUPS = TEXTURE_SIZE / 8;
// sizeof(uint32_t): the run counter, the compute shader's push constants.
const PUSH_CONSTANTS_SIZE = 4;
// 100Hz.
const COMPUTE_INTERVAL_MICROSECONDS = 10000;

// --- Passes -----------------------------------------------------------------------------------

// Port of Donut-Samples' async_compute.cpp: a worker thread animates simplex noise into textures
// on the compute queue at 100Hz, independently of the frame rate, and the render pass draws the
// newest finished one.
//
// The worker thread (Donut_CreateAsyncComputeLoop) is C++: tslang code can't run on threads its
// GC doesn't know about. This class creates everything it runs, and does the rendering.
class AsyncComputePass {
    private app: Opaque;
    private vertexShader: Opaque;
    private pixelShader: Opaque;
    private computeShader: Opaque;
    private drawBindingLayout: Opaque;
    private sampler: Opaque;
    private computeLoop: Opaque;
    // Created on the first frame (it depends on the framebuffer layout), dropped on resize.
    private graphicsPipeline: Opaque | null;

    constructor(app: Opaque) {
        this.app = app;
        this.graphicsPipeline = null;
    }

    onBackBufferResizing(): void {
        const graphicsPipeline = this.graphicsPipeline;
        if (graphicsPipeline) {
            Donut_ReleaseResource(this.app, graphicsPipeline);
            this.graphicsPipeline = null;
        }
    }

    onAnimate(elapsedSeconds: number): void {
        Donut_SetInformativeWindowTitle(this.app, WINDOW_TITLE);
    }

    onRender(frame: Opaque): void {
        let graphicsPipeline = this.graphicsPipeline;
        if (!graphicsPipeline) {
            graphicsPipeline = Donut_CreateGraphicsPipelineWithTopology(this.app, frame, this.vertexShader, this.pixelShader,
                null, this.drawBindingLayout, PrimitiveType.TriangleStrip);
            this.graphicsPipeline = graphicsPipeline;
        }

        const texture = Donut_AcquireAsyncComputeTexture(this.computeLoop, frame);

        Donut_ClearColor(frame, 0.0, 0.0, 0.0, 0.0);

        if (texture) {
            const bindingSetDesc = Donut_CreateBindingSetDesc();
            Donut_BindTextureSRV(bindingSetDesc, 0, texture);
            Donut_BindSampler(bindingSetDesc, 0, this.sampler);
            const bindingSet = Donut_GetCachedBindingSet(this.app, bindingSetDesc, this.drawBindingLayout);

            Donut_BeginDraw(frame, graphicsPipeline);
            Donut_DrawAddBindingSet(frame, bindingSet);
            Donut_DrawVertices(frame, 4);
        }
    }

    // Joins the worker thread; before Donut_DestroyApp.
    stop(): void {
        Donut_StopAsyncComputeLoop(this.computeLoop);
    }

    // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
    init(): boolean {
        this.vertexShader = Donut_CreateShader(this.app, "async_compute.hlsl", "main_vs", ShaderType.Vertex);
        this.pixelShader = Donut_CreateShader(this.app, "async_compute.hlsl", "main_ps", ShaderType.Pixel);
        this.computeShader = Donut_CreateShader(this.app, "async_compute.hlsl", "main_cs", ShaderType.Compute);

        if (!this.vertexShader || !this.pixelShader || !this.computeShader) {
            return false;
        }

        // Trilinear, clamped: nvrhi::SamplerDesc's defaults, as the sample creates it.
        this.sampler = Donut_GetCommonSampler(this.app, CommonSampler.LinearClamp);

        const drawLayoutDesc = Donut_CreateBindingLayoutDesc();
        Donut_LayoutTextureSRV(drawLayoutDesc, 0);
        Donut_LayoutSampler(drawLayoutDesc, 0);
        this.drawBindingLayout = Donut_CreateBindingLayout(this.app, drawLayoutDesc, ShaderType.Pixel);

        const computeLayoutDesc = Donut_CreateBindingLayoutDesc();
        Donut_LayoutPushConstants(computeLayoutDesc, 0, PUSH_CONSTANTS_SIZE);
        Donut_LayoutTextureUAV(computeLayoutDesc, 0);
        const computeBindingLayout = Donut_CreateBindingLayout(this.app, computeLayoutDesc, ShaderType.Compute);

        const computePipeline = Donut_CreateComputePipelineWithLayout(this.app, this.computeShader, computeBindingLayout);

        const computeLoop = Donut_CreateAsyncComputeLoop(this.app, computePipeline, computeBindingLayout,
            COMPUTE_GROUPS, COMPUTE_GROUPS, COMPUTE_INTERVAL_MICROSECONDS);
        if (!computeLoop) {
            console.log("The graphics device has no compute queue");
            return false;
        }
        this.computeLoop = computeLoop;

        for (let i = 0; i < NUM_TEXTURES; i++) {
            Donut_AddAsyncComputeTexture(computeLoop, Donut_CreateUAVTexture(this.app, TEXTURE_SIZE, TEXTURE_SIZE, "AsyncComputeTexture"));
        }

        Donut_StartAsyncComputeLoop(computeLoop);

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
    const app = Donut_CreateAppWithOptions(api, WINDOW_TITLE, 1280, 720, AppOptions.ComputeQueue);
    if (!app) {
        console.log("Cannot initialize a graphics device with the requested parameters");
        return 1;
    }

    console.log(`Renderer: ${Donut_GetRendererString(app)}`);

    const asyncCompute = new AsyncComputePass(app);
    if (!asyncCompute.init()) {
        Donut_DestroyApp(app);
        return 1;
    }

    const input = new InputPass(app);

    Donut_RunApp(app);
    asyncCompute.stop();
    Donut_DestroyApp(app);
    return 0;
}

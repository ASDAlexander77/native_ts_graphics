/// <reference path="donut_interop.d.ts" />

// GLFW values, as passed to the keyboard callback.
const KEY_V = 86;
const KEY_ESCAPE = 256;
const ACTION_PRESS = 1;

const WINDOW_TITLE = "Donut Example: Meshlets";

// --- Passes ---------------------------------------------------------------------------------

// Port of Donut-Samples' meshlets.cpp.
class MeshletPass {
    private app: Opaque;
    private amplificationShader: Opaque;
    private meshShader: Opaque;
    private pixelShader: Opaque;
    // Created on the first frame (it depends on the framebuffer layout), dropped on resize.
    private pipeline: Opaque | null;

    constructor(app: Opaque) {
        this.app = app;
        this.pipeline = null;
    }

    onBackBufferResizing(): void {
        const pipeline = this.pipeline;
        if (pipeline) {
            Donut_ReleaseResource(this.app, pipeline);
            this.pipeline = null;
        }
    }

    onAnimate(elapsedSeconds: number): void {
        Donut_SetInformativeWindowTitle(this.app, WINDOW_TITLE);
    }

    onRender(frame: Opaque): void {
        let pipeline = this.pipeline;
        if (!pipeline) {
            pipeline = Donut_CreateMeshletPipeline(this.app, frame, this.amplificationShader, this.meshShader, this.pixelShader);
            this.pipeline = pipeline;
        }

        Donut_ClearColor(frame, 0.0, 0.0, 0.0, 0.0);
        Donut_DispatchMesh(frame, pipeline, 1);
    }

    // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
    init(): boolean {
        this.amplificationShader = Donut_CreateShader(this.app, "meshlets.hlsl", "main_as", ShaderType.Amplification);
        this.meshShader = Donut_CreateShader(this.app, "meshlets.hlsl", "main_ms", ShaderType.Mesh);
        this.pixelShader = Donut_CreateShader(this.app, "meshlets.hlsl", "main_ps", ShaderType.Pixel);

        if (!this.amplificationShader || !this.meshShader || !this.pixelShader) {
            return false;
        }

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

        if (key == KEY_V && action == ACTION_PRESS) {
            Donut_SetVsyncEnabled(this.app, Donut_IsVsyncEnabled(this.app) != 0 ? 0 : 1);
            return 1;
        }

        return 0;
    }
}

function main(argc: int, argv: Ref<string>): int {

    const app = Donut_CreateApp(argc, argv, WINDOW_TITLE, 1280, 720);
    if (!app) {
        console.log("Cannot initialize a graphics device with the requested parameters");
        return 1;
    }

    if (!Donut_IsFeatureSupported(app, Feature.Meshlets)) {
        console.log("The graphics device does not support Meshlets");
        Donut_DestroyApp(app);
        return 1;
    }

    console.log(`Renderer: ${Donut_GetRendererString(app)}`);

    const meshlets = new MeshletPass(app);
    if (!meshlets.init()) {
        console.log("Cannot load the meshlet shaders");
        Donut_DestroyApp(app);
        return 1;
    }

    const input = new InputPass(app);

    Donut_RunApp(app);
    Donut_DestroyApp(app);
    return 0;
}

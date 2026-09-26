/// <reference path="donut_interop.d.ts" />

// GLFW values, as passed to the keyboard callback.
const KEY_V = 86;
const KEY_ESCAPE = 256;
const ACTION_PRESS = 1;

const WINDOW_TITLE = "Donut Example: Vulkan Shader Specializations";

// --- Passes ---------------------------------------------------------------------------------

// Port of Donut-Samples' shader_specializations.cpp.
class ShaderSpecializationsPass {
    private app: Opaque;
    private vertexShader: Opaque;
    private pixelShader: Opaque;
    // Created on the first frame (they depend on the framebuffer layout), dropped on resize.
    private pipelines: Opaque[];

    constructor(app: Opaque) {
        this.app = app;
        this.pipelines = [];
    }

    onBackBufferResizing(): void {
        for (const pipeline of this.pipelines) {
            Donut_ReleaseResource(this.app, pipeline);
        }
        this.pipelines = [];
    }

    onAnimate(elapsedSeconds: number): void {
        Donut_SetInformativeWindowTitle(this.app, WINDOW_TITLE);
    }

    onRender(frame: Opaque): void {
        if (this.pipelines.length == 0) {
            // Create pipelines with shader specializations.
            // The specializations could be created ahead of time, but they're cheap and it doesn't really matter.
            const colors: int[] = [0x0000ff, 0x00ff00, 0xff0000, 0xff00ff];

            for (let i = 0; i < 4; i++) {
                const vertexShader = Donut_SpecializeShaderFloat(this.app, this.vertexShader, 0, i * 0.5 - 0.75);
                const pixelShader = Donut_SpecializeShaderUInt(this.app, this.pixelShader, 1, colors[i]);

                this.pipelines.push(Donut_CreateGraphicsPipeline(this.app, frame, vertexShader, pixelShader));

                // The pipeline holds its own references to the specialized shaders.
                Donut_ReleaseResource(this.app, vertexShader);
                Donut_ReleaseResource(this.app, pixelShader);
            }
        }

        Donut_ClearColor(frame, 0.0, 0.0, 0.0, 0.0);

        // Render triangles, one with each pipeline.
        // Expected output: 4 triangles side-by-side; red, green, blue, magenta.
        for (const pipeline of this.pipelines) {
            Donut_Draw(frame, pipeline, 3);
        }
    }

    // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
    init(): boolean {
        this.vertexShader = Donut_CreateShader(this.app, "shader_specializations.hlsl", "main_vs", ShaderType.Vertex);
        this.pixelShader = Donut_CreateShader(this.app, "shader_specializations.hlsl", "main_ps", ShaderType.Pixel);

        if (!this.vertexShader || !this.pixelShader) {
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

function main(argc: int, argv: Opaque): int {

    const app = Donut_CreateAppForAPI(GraphicsAPI.VULKAN, WINDOW_TITLE, 1280, 720);
    if (!app) {
        console.log("Cannot initialize a graphics device with the requested parameters");
        return 1;
    }

    if (!Donut_IsFeatureSupported(app, Feature.ShaderSpecializations)) {
        console.log("The graphics device does not support shader specializations");
        Donut_DestroyApp(app);
        return 1;
    }

    console.log(`Renderer: ${Donut_GetRendererString(app)}`);

    const specializations = new ShaderSpecializationsPass(app);
    if (!specializations.init()) {
        console.log("Cannot load the shader specialization shaders");
        Donut_DestroyApp(app);
        return 1;
    }

    const input = new InputPass(app);

    Donut_RunApp(app);
    Donut_DestroyApp(app);
    return 0;
}

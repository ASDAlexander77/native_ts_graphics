/// <reference path="donut_interop.d.ts" />

// GLFW values, as passed to the keyboard callback.
const KEY_SPACE = 32;
const KEY_V = 86;
const KEY_ESCAPE = 256;
const ACTION_PRESS = 1;

const WINDOW_TITLE = "Donut Example: Threaded Rendering";
const DEFAULT_SCENE = "media/glTF-Sample-Assets/Models/Sponza/glTF/Sponza.gltf";

const NUM_FACES = 6;
const CUBEMAP_RESOLUTION = 1024;

// Where each cube face goes in the window, as (column, row) of a 4 x 3 grid.
const g_FaceLayout: int[] = [
    3, 1,
    1, 1,
    2, 0,
    2, 2,
    2, 1,
    0, 1,
];

// --- Passes -----------------------------------------------------------------------------------

// Port of Donut-Samples' threaded_rendering.cpp: renders the scene into the six faces of a cube
// map, each face into its own command list, either on worker threads or one after another
// (Space toggles), then shows the faces unfolded.
//
// The per-face recording (Donut_RenderCubemapFace*) is C++: tslang code must not run on the
// worker threads, which its garbage collector doesn't know about. This class drives it.
class ThreadedRenderingPass {
    private app: Opaque;
    private scene: Opaque;
    private camera: Opaque;
    private forwardShadingPass: Opaque;
    private cubemap: Opaque;
    private faceCommandLists: Opaque[];
    private useThreads: boolean;

    constructor(app: Opaque) {
        this.app = app;
        this.faceCommandLists = [];
        this.useThreads = true;
    }

    onKey(key: int, scancode: int, action: int, mods: int): int {
        Donut_CameraKeyboardUpdate(this.camera, key, scancode, action, mods);

        if (key == KEY_SPACE && action == ACTION_PRESS) {
            this.useThreads = !this.useThreads;
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

    onAnimate(elapsedSeconds: number): void {
        Donut_CameraAnimate(this.camera, elapsedSeconds);

        Donut_SetInformativeWindowTitleWithInfo(this.app, WINDOW_TITLE, this.useThreads ? "(With threads)" : "(No threads)");
    }

    onBackBufferResizing(): void {
        Donut_ClearBindingCache(this.app);
    }

    onRender(frame: Opaque): void {
        Donut_SetCubemapViewFromCamera(this.cubemap, this.camera, 0.1, 100.0);

        for (let face = 0; face < NUM_FACES; face++) {
            if (this.useThreads) {
                Donut_RenderCubemapFaceAsync(this.app, this.cubemap, face, this.faceCommandLists[face], this.scene, this.forwardShadingPass);
            } else {
                Donut_RenderCubemapFace(this.cubemap, face, this.faceCommandLists[face], this.scene, this.forwardShadingPass);
            }
        }

        // Meanwhile, record the blits of the faces into the frame's command list.
        const faceSize = Math.min(Math.floor(Donut_GetFrameWidth(frame) / 4), Math.floor(Donut_GetFrameHeight(frame) / 3));
        const colorBuffer = Donut_GetCubemapColorTexture(this.cubemap);

        for (let face = 0; face < NUM_FACES; face++) {
            Donut_BlitTextureSlice(this.app, frame, colorBuffer, face,
                g_FaceLayout[face * 2] * faceSize, g_FaceLayout[face * 2 + 1] * faceSize, faceSize, faceSize);
        }

        if (this.useThreads) {
            Donut_WaitForTasks(this.app);
        }

        // Before the frame's command list, which the pass executes after this callback returns.
        for (let face = 0; face < NUM_FACES; face++) {
            Donut_ExecuteCommandList(this.app, this.faceCommandLists[face]);
        }
    }

    // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
    init(scenePath: string): boolean {
        const scene = Donut_LoadScene(this.app, scenePath);
        if (!scene) {
            console.log(`Cannot load the scene ${scenePath}`);
            return false;
        }
        this.scene = scene;

        this.camera = Donut_CreateFirstPersonCamera(this.app);
        Donut_CameraLookAt(this.camera, 0.0, 1.8, 0.0, 1.0, 1.8, 0.0);
        Donut_CameraSetMoveSpeed(this.camera, 3.0);

        for (let face = 0; face < NUM_FACES; face++) {
            this.faceCommandLists.push(Donut_CreateDeferredCommandList(this.app));
        }

        this.forwardShadingPass = Donut_CreateForwardShadingPass(this.app, 128);
        this.cubemap = Donut_CreateCubemapTarget(this.app, CUBEMAP_RESOLUTION);

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

    if (Donut_GetGraphicsAPIFromCommandLine(argc, argv) == GraphicsAPI.D3D11) {
        console.log("The Threaded Rendering example does not support D3D11.");
        return 1;
    }

    // --scene <path>: relative to the executable's directory, or absolute.
    let scenePath = DEFAULT_SCENE;
    for (let i = 1; i + 1 < argc; i++) {
        if (Donut_GetArg(argv, i) == "--scene") {
            scenePath = Donut_GetArg(argv, i + 1);
        }
    }

    // The window size matches the layout of the rendered cube faces.
    const app = Donut_CreateApp(argc, argv, WINDOW_TITLE, 1024, 768);
    if (!app) {
        console.log("Cannot initialize a graphics device with the requested parameters");
        return 1;
    }

    console.log(`Renderer: ${Donut_GetRendererString(app)}`);

    const threadedRendering = new ThreadedRenderingPass(app);
    if (!threadedRendering.init(scenePath)) {
        Donut_DestroyApp(app);
        return 1;
    }

    const input = new InputPass(app);

    Donut_RunApp(app);
    Donut_DestroyApp(app);
    return 0;
}

// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace ThreadedRendering {
    // GLFW values, as passed to the keyboard callback.
    const KEY_SPACE = 32;
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

    // --- Passes -------------------------------------------------------------------------------

    // Port of Donut-Samples' threaded_rendering.cpp: renders the scene into the six faces of a cube
    // map, each face into its own command list, either on worker threads or one after another
    // (Space toggles), then shows the faces unfolded.
    //
    // The per-face recording (Donut_RenderCubemapFace*) is C++: tslang code must not run on the
    // worker threads, which its garbage collector doesn't know about. This class drives it.
    class ThreadedRenderingPass {
        private app: App;
        private scene: Scene;
        private camera: Camera;
        private forwardShadingPass: ForwardShadingPass;
        private cubemap: CubemapTarget;
        private faceCommandLists: CommandList[];
        private useThreads: boolean;

        constructor(app: App) {
            this.app = app;
            this.faceCommandLists = [];
            this.useThreads = true;
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            this.camera.keyboardUpdate(key, scancode, action, mods);

            if (key == KEY_SPACE && action == ACTION_PRESS) {
                this.useThreads = !this.useThreads;
            }

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

            this.app.setInformativeWindowTitleWithInfo(WINDOW_TITLE, this.useThreads ? "(With threads)" : "(No threads)");
        }

        onBackBufferResizing(): void {
            this.app.clearBindingCache();
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            this.cubemap.setViewFromCamera(this.camera, 0.1, 100.0);

            for (let face = 0; face < NUM_FACES; face++) {
                if (this.useThreads) {
                    this.app.renderCubemapFaceAsync(this.cubemap, face, this.faceCommandLists[face], this.scene, this.forwardShadingPass);
                } else {
                    this.cubemap.renderFace(face, this.faceCommandLists[face], this.scene, this.forwardShadingPass);
                }
            }

            // Meanwhile, record the blits of the faces into the frame's command list.
            const faceSize = Math.min(Math.floor(frame.getWidth() / 4), Math.floor(frame.getHeight() / 3));
            const colorBuffer = this.cubemap.getColorTexture();

            for (let face = 0; face < NUM_FACES; face++) {
                this.app.blitTextureSlice(frame, colorBuffer, face,
                    g_FaceLayout[face * 2] * faceSize, g_FaceLayout[face * 2 + 1] * faceSize, faceSize, faceSize);
            }

            if (this.useThreads) {
                this.app.waitForTasks();
            }

            // Before the frame's command list, which the pass executes after this callback returns.
            for (let face = 0; face < NUM_FACES; face++) {
                this.app.executeCommandList(this.faceCommandLists[face]);
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(scenePath: string): boolean {
            const scene = this.app.loadScene(scenePath);
            if (scene.isNull()) {
                console.log(`Cannot load the scene ${scenePath}`);
                return false;
            }
            this.scene = scene;

            this.camera = this.app.createFirstPersonCamera();
            this.camera.lookAt(0.0, 1.8, 0.0, 1.0, 1.8, 0.0);
            this.camera.setMoveSpeed(3.0);

            for (let face = 0; face < NUM_FACES; face++) {
                this.faceCommandLists.push(this.app.createDeferredCommandList());
            }

            this.forwardShadingPass = this.app.createForwardShadingPass(128);
            this.cubemap = this.app.createCubemapTarget(CUBEMAP_RESOLUTION);

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
        Donut_SetAppName("threaded_rendering");

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        if (api == GraphicsAPI.D3D11) {
            console.log("The Threaded Rendering example does not support D3D11.");
            return 1;
        }

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

        // The window size matches the layout of the rendered cube faces.
        const app = App.createWithOptions(api, WINDOW_TITLE, 1024, 768, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const threadedRendering = new ThreadedRenderingPass(app);
        if (!threadedRendering.init(scenePath)) {
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
    return ThreadedRendering.main(argc, argv);
}

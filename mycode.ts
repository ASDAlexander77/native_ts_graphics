// --- Donut interop (implemented in donut_interop.cpp) ---------------------------------------

// A method passed as one of these (e.g. `this.onRender`) reaches C++ as a function pointer
// plus its `this` value.
type RenderCallback = (frame: Opaque) => void;
type AnimateCallback = (elapsedSeconds: number) => void;
type KeyboardCallback = (key: int, scancode: int, action: int, mods: int) => int;

// Picks the graphics API from the command line (-d3d11, -d3d12, -vk). Returns null on failure.
declare function Donut_CreateApp(argc: int, argv: Opaque, title: string, width: int, height: int): Opaque;
// Blocks until the window is closed, then destroys the app and its passes.
declare function Donut_RunApp(app: Opaque): void;
declare function Donut_GetRendererString(app: Opaque): string;
declare function Donut_SetWindowTitle(app: Opaque, title: string): void;
declare function Donut_CloseWindow(app: Opaque): void;

// Passes are owned by the app; later passes draw on top and get input first.
declare function Donut_AddPass(app: Opaque): Opaque;
declare function Donut_SetRunWhenUnfocused(pass: Opaque, enabled: int): void;
declare function Donut_SetRenderCallback(pass: Opaque, handler: RenderCallback): void;
declare function Donut_SetAnimateCallback(pass: Opaque, handler: AnimateCallback): void;
declare function Donut_SetKeyboardCallback(pass: Opaque, handler: KeyboardCallback): void;

// Valid only inside a render callback.
declare function Donut_ClearColor(frame: Opaque, r: number, g: number, b: number, a: number): void;
declare function Donut_GetFrameWidth(frame: Opaque): int;
declare function Donut_GetFrameHeight(frame: Opaque): int;

// GLFW values, as passed to the keyboard callback.
const KEY_ESCAPE = 256;
const ACTION_PRESS = 1;

// --- Passes ---------------------------------------------------------------------------------

class BackgroundPass {
    private time: number;

    constructor(app: Opaque) {
        this.time = 0.0;

        const pass = Donut_AddPass(app);
        Donut_SetAnimateCallback(pass, this.onAnimate);
        Donut_SetRenderCallback(pass, this.onRender);
    }

    onAnimate(elapsedSeconds: number): void {
        this.time += elapsedSeconds;
    }

    onRender(frame: Opaque): void {
        const t = this.time;
        Donut_ClearColor(frame, 0.5 + 0.5 * Math.sin(t), 0.2, 0.5 + 0.5 * Math.cos(t), 1.0);
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

// Module-level so the GC keeps them alive: C++ only holds them from memory the GC doesn't scan.
let background: BackgroundPass;
let input: InputPass;

function main(argc: int, argv: Opaque): int {

    const app = Donut_CreateApp(argc, argv, "Powder Toy", 1280, 720);
    if (!app) {
        console.log("Cannot create the graphics device");
        return 1;
    }

    console.log(`Renderer: ${Donut_GetRendererString(app)}`);

    background = new BackgroundPass(app);
    input = new InputPass(app);

    Donut_RunApp(app);
    return 0;
}

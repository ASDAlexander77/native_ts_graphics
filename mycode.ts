// --- Donut interop (implemented in donut_interop.cpp) ---------------------------------------

enum GraphicsAPI {
    D3D11 = 0,
    D3D12,
    VULKAN
}

// A method passed as one of these (e.g. `this.onRender`) reaches C++ as a function pointer
// plus its `this` value.
type RenderCallback = (frame: Opaque) => void;
type AnimateCallback = (elapsedSeconds: number) => void;
type KeyboardCallback = (key: int, scancode: int, action: int, mods: int) => int;

declare function Donut_GetGraphicsAPIFromCommandLine(argc: int, argv: Opaque): GraphicsAPI;

declare function Donut_CreateDeviceManager(api: GraphicsAPI, width: int, height: int, title: string): Opaque;
declare function Donut_GetRendererString(deviceManager: Opaque): string;
declare function Donut_SetWindowTitle(deviceManager: Opaque, title: string): void;
declare function Donut_CloseWindow(deviceManager: Opaque): void;
declare function Donut_RunMessageLoop(deviceManager: Opaque): void;
declare function Donut_DestroyDeviceManager(deviceManager: Opaque): void;

declare function Donut_CreateRenderPass(deviceManager: Opaque): Opaque;
declare function Donut_DestroyRenderPass(deviceManager: Opaque, pass: Opaque): void;
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

// --- Game -----------------------------------------------------------------------------------

class Game {
    private deviceManager: Opaque;
    private time: number;

    constructor(deviceManager: Opaque, pass: Opaque) {
        this.deviceManager = deviceManager;
        this.time = 0.0;

        Donut_SetRenderCallback(pass, this.onRender);
        Donut_SetAnimateCallback(pass, this.onAnimate);
        Donut_SetKeyboardCallback(pass, this.onKey);
    }

    onAnimate(elapsedSeconds: number): void {
        this.time += elapsedSeconds;
    }

    onRender(frame: Opaque): void {
        const t = this.time;
        Donut_ClearColor(frame, 0.5 + 0.5 * Math.sin(t), 0.2, 0.5 + 0.5 * Math.cos(t), 1.0);
    }

    onKey(key: int, scancode: int, action: int, mods: int): int {
        if (key == KEY_ESCAPE && action == ACTION_PRESS) {
            Donut_CloseWindow(this.deviceManager);
            return 1;
        }

        return 0;
    }
}

// Module-level so the GC keeps it alive: C++ only holds it from memory the GC doesn't scan.
let game: Game;

function main(argc: int, argv: Opaque): int {

    const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);

    const deviceManager = Donut_CreateDeviceManager(api, 1280, 720, "Powder Toy");
    if (!deviceManager) {
        console.log("Cannot create the graphics device");
        return 1;
    }

    console.log(`Renderer: ${Donut_GetRendererString(deviceManager)}`);

    const pass = Donut_CreateRenderPass(deviceManager);
    game = new Game(deviceManager, pass);

    Donut_RunMessageLoop(deviceManager);

    Donut_DestroyRenderPass(deviceManager, pass);
    Donut_DestroyDeviceManager(deviceManager);
    return 0;
}

/// <reference path="../donut_handles.d.ts" />
/// <reference path="resources.d.ts" />
// The app: command line, creation and adapters, the run loop and its passes and callbacks,
// headless test mode, the window, input and the swap chain

// GLFW's input values (glfw3.h), as the input callbacks pass them: key codes, key and mouse
// button actions, mouse buttons, modifier bits.
enum Key {
    Space = 32,
    Comma = 44,
    Minus = 45,
    Period = 46,
    Slash = 47,
    Num0 = 48,
    Num1 = 49,
    Num2 = 50,
    Num3 = 51,
    Num4 = 52,
    Num5 = 53,
    Num6 = 54,
    Num7 = 55,
    Num8 = 56,
    Num9 = 57,
    Equal = 61,
    A = 65,
    B = 66,
    C = 67,
    D = 68,
    E = 69,
    F = 70,
    G = 71,
    H = 72,
    J = 74,
    K = 75,
    L = 76,
    M = 77,
    N = 78,
    O = 79,
    P = 80,
    Q = 81,
    R = 82,
    S = 83,
    T = 84,
    U = 85,
    V = 86,
    W = 87,
    X = 88,
    Y = 89,
    Z = 90,
    LeftBracket = 91,
    RightBracket = 93,
    GraveAccent = 96,
    Escape = 256,
    Enter = 257,
    Tab = 258,
    Right = 262,
    Left = 263,
    Down = 264,
    Up = 265,
    PageUp = 266,
    PageDown = 267,
    Home = 268,
    End = 269,
    F1 = 290,
    Kp1 = 321,
    Kp2 = 322,
    Kp3 = 323,
    Kp4 = 324,
    Kp6 = 326,
    Kp8 = 328,
    KpSubtract = 333,
    KpAdd = 334,
    KpEnter = 335,
    LeftShift = 340,
    RightShift = 344
}

enum Action {
    Release = 0,
    Press = 1,
    Repeat = 2
}

enum MouseButton {
    Left = 0,
    Right = 1,
    Middle = 2
}

// GLFW modifier bits.
enum KeyMods {
    Shift = 1,
    Control = 2,
    Alt = 4,
    Super = 8,
    CapsLock = 16,
    NumLock = 32
}

// A key's platform-specific scancode (GLFW: not stable across keyboards or systems), which the
// samples don't use.
type ScanCode = int;

// A method passed as one of these (e.g. `this.onRender`) reaches C++ as a function pointer
// plus its `this` value.
type VoidCallback = () => void;
type RenderCallback = (frame: FrameHandle) => void;
type AnimateCallback = (elapsedSeconds: number) => void;
type KeyboardCallback = (key: Key, scancode: ScanCode, action: Action, mods: KeyMods) => int;
type MousePosCallback = (x: number, y: number) => int;
type MouseButtonCallback = (button: MouseButton, action: Action, mods: KeyMods) => int;
type MouseScrollCallback = (xOffset: number, yOffset: number) => int;

// nvrhi::GraphicsAPI values.
enum GraphicsAPI {
    D3D11 = 0,
    D3D12 = 1,
    VULKAN = 2
}

// Bits of Donut_CreateAppWithOptions' and Donut_CreateHeadlessAppWithOptions' options.
enum AppOptions {
    None = 0,
    // Enables the Vulkan ray tracing extensions (D3D12 has them built in).
    RayTracing = 1,
    // Creates a separate compute queue, for Donut_CreateAsyncComputeLoop.
    ComputeQueue = 2,
    // Enables the graphics API's debug layer and NVRHI's validation layer.
    DebugRuntime = 4,
    // Starts in fullscreen at the monitor's native resolution.
    Fullscreen = 8,
    // Starts with vertical sync off.
    NoVsync = 16,
    // DPI aware, with ImGui scaled explicitly (as Donut's feature demo).
    PerMonitorDpi = 32,
    // With Vulkan, enables the extensions DLSS needs (when built with DONUT_WITH_DLSS).
    Dlss = 64,
    // UNORM back buffers instead of sRGB ones (RGBA8_UNORM with D3D, BGRA8_UNORM with Vulkan):
    // shader output stored as is.
    UnormBackBuffer = 128,
    // R10G10B10A2_UNORM back buffers, in sRGB until Donut_SetSwapChainColorSpace asks for HDR10.
    HdrBackBuffer = 256,
    // With Vulkan, shaders' printf through the validation layer (Donut_HasShaderPrintf).
    ShaderPrintf = 512,
    // With Vulkan, descriptor sets in buffers (Donut_HasDescriptorBuffers); not by default, as the
    // validation layer's shader instrumentation (GPU-AV, shader printf) is off with them.
    DescriptorBuffers = 1024,
    // With D3D12, shaders index ResourceDescriptorHeap[] (the root signatures of pipelines with a mutable
    // bindless layout get CBV_SRV_UAV_HEAP_DIRECTLY_INDEXED).
    HeapDirectlyIndexed = 2048,
    // The device made through Streamline (after Streamline_Init, core/streamline.cpp; nothing without it):
    // D3D12's by its interposer, Vulkan's with the interposer as the Vulkan loader.
    Streamline = 4096
}

// The color space of what the back buffers hold (donut::app::SwapChainColorSpace): sRGB (SDR),
// HDR10 (Rec.2020 primaries, ST.2084 curve; R10G10B10A2_UNORM back buffers), scRGB (linear Rec.709,
// 1.0 = 80 nits; RGBA16_FLOAT ones).
enum SwapChainColorSpace {
    SRGB = 0,
    HDR10 = 1,
    ScRGB = 2
}

// donut::log::Severity values.
enum LogSeverity {
    None = 0,
    Debug = 1,
    Info = 2,
    Warning = 3,
    Error = 4,
    Fatal = 5
}

// GLFW's cursor modes.
enum CursorMode {
    Normal = 0,
    Hidden = 1,
    // Hidden and captured: the mouse callback gets unbounded virtual positions (raw mouse motion
    // where the system has it), for camera controls.
    Disabled = 2
}

// Command line helpers: argv is main's argv.
@nodrops declare function Donut_GetArg(argv: Ref<string>, index: int): string;
// -d3d11 / -dx11, -d3d12 / -dx12, -vk / -vulkan; D3D12 by default on Windows.
@nodrops declare function Donut_GetGraphicsAPIFromCommandLine(argc: int, argv: Ref<string>): GraphicsAPI;
@nodrops declare function Donut_GraphicsAPIToString(api: GraphicsAPI): string;
// Shaders load from bin/shaders/<name>/<api>; the executable's name by default. Under the
// JIT the executable is donut_interop.dll, so name the example before creating the app.
@nodrops declare function Donut_SetAppName(name: string): void;
// Messages below the severity are dropped.
@nodrops declare function Donut_SetLogMinSeverity(severity: LogSeverity): void;

// Picks the graphics API from the command line (-d3d11, -d3d12, -vk). Returns null on failure.
@nodrops declare function Donut_CreateApp(argc: int, argv: Ref<string>, title: string, width: int, height: int): AppHandle;
// Same, for a fixed graphics API.
@nodrops declare function Donut_CreateAppForAPI(api: GraphicsAPI, title: string, width: int, height: int): AppHandle;
// Same, with AppOptions bits.
@nodrops declare function Donut_CreateAppWithOptions(api: GraphicsAPI, title: string, width: int, height: int, options: AppOptions): AppHandle;
// Device without a window, for compute work; adapterIndex -1 picks the default adapter. It has
// no passes: run work with the command list functions. Returns null on failure.
@nodrops declare function Donut_CreateHeadlessApp(api: GraphicsAPI, adapterIndex: int): AppHandle;
// Same, with AppOptions bits; the device's apply (RayTracing, ComputeQueue, DebugRuntime).
@nodrops declare function Donut_CreateHeadlessAppWithOptions(api: GraphicsAPI, adapterIndex: int, options: AppOptions): AppHandle;

// Adapters of one graphics API; null (after logging why) on failure.
@nodrops declare function Donut_EnumerateAdapters(api: GraphicsAPI): AdapterListHandle;
@nodrops declare function Donut_GetAdapterCount(adapterList: AdapterListHandle): int;
@nodrops declare function Donut_GetAdapterName(adapterList: AdapterListHandle, index: int): string;
@nodrops declare function Donut_GetAdapterMemoryMB(adapterList: AdapterListHandle, index: int): int;
@nodrops declare function Donut_DestroyAdapterList(adapterList: AdapterListHandle): void;
// Blocks until the window is closed; in test mode renders the test's frames and returns.
declare function Donut_RunApp(app: AppHandle): void;
// Test mode for the apps created after it: a headless device rendering frameCount frames, each
// frameSeconds long, into back buffers that can be read back; no window, input or title.
@nodrops declare function Donut_SetTestMode(frameCount: int, frameSeconds: number): void;
// Saves the current back buffer (in test mode after Donut_RunApp, the last frame's) as an image file,
// its format from the extension (.png, .bmp, .tga, .jpg). Not in a render callback.
@nodrops declare function Donut_SaveBackBufferToFile(app: AppHandle, path: string): int;
// The examples' test options: -test renders frameCount frames, frameSeconds each, without a window
// (Donut_SetTestMode, for the app created next); -testOutput <file> names an image file for the last
// one (Donut_FinishTest). Non-zero if -test is given. -hiddenWindow <frames> (without -test): the app
// created next has its window and swap chain, but the window is never shown and Donut_RunApp returns
// after that many frames.
@nodrops declare function Donut_ParseTestArgs(argc: int, argv: Ref<string>, frameCount: int, frameSeconds: number): int;
// The frames a -hiddenWindow run renders, 0 if it isn't one (or under -test).
@nodrops declare function Donut_HiddenWindowFrames(): int;
// The current back buffer's pixels (in test mode after Donut_RunApp, the last frame's), one int each
// with red in the low byte (0xAABBGGRR; BGRA back buffers swapped), row by row into dst (pixelCount
// ints; Ref of a `let` int array element). 0 on failure or for back buffers not 8-bit RGBA / BGRA.
@nodrops declare function Donut_ReadBackBufferRGBA8(app: AppHandle, dst: Ref<int>, pixelCount: int): int;
// Ends a test after Donut_RunApp: saves the last frame to -testOutput's file if given, prints "Test
// PASSED" if failure is "", else "Test FAILED: <failure>"; returns the exit code (0, 1).
@nodrops declare function Donut_FinishTest(app: AppHandle, failure: string): int;
// Non-zero for an app created in test mode.
@nodrops declare function Donut_IsTestMode(app: AppHandle): int;
// Destroys the app with all its passes and resources.
@nodrops declare function Donut_DestroyApp(app: AppHandle): void;
@nodrops declare function Donut_SetWindowTitle(app: AppHandle, title: string): void;
// Sets "<title> (<graphics API>, <fps> FPS)".
@nodrops declare function Donut_SetInformativeWindowTitle(app: AppHandle, title: string): void;
// Same, with extraInfo appended.
@nodrops declare function Donut_SetInformativeWindowTitleWithInfo(app: AppHandle, title: string, extraInfo: string): void;
// Apps start with vsync on; the change takes effect at the start of the next frame (on Vulkan it
// recreates the swap chain, so the passes get onBackBufferResizing).
@nodrops declare function Donut_SetVsyncEnabled(app: AppHandle, enabled: boolean): void;
// Lags Donut_SetVsyncEnabled by up to a frame.
@nodrops declare function Donut_IsVsyncEnabled(app: AppHandle): int;
// Makes Donut_RunApp return after the current frame, in test mode too (before the frames it was to
// render: a test waiting for something renders up to an upper bound and stops once it has the
// frames it checks).
@nodrops declare function Donut_CloseWindow(app: AppHandle): void;
// Blocks the calling thread for `milliseconds` (-test waiting on work that runs in real time, as a
// video's decoding).
@nodrops declare function Donut_SleepMilliseconds(milliseconds: int): void;

@nodrops declare function Donut_SetCursorMode(app: AppHandle, mode: CursorMode): void;
// Moves the mouse cursor to (x, y) in the mouse callback's coordinates.
@nodrops declare function Donut_SetCursorPosition(app: AppHandle, x: number, y: number): void;
// Non-zero while the window has the keyboard focus.
@nodrops declare function Donut_IsWindowFocused(app: AppHandle): int;

// Passes are owned by the app; later passes draw on top and get input first.
@nodrops declare function Donut_AddPass(app: AppHandle): PassHandle;
@nodrops declare function Donut_SetRunWhenUnfocused(pass: PassHandle, enabled: boolean): void;
@nodrops declare function Donut_SetRenderCallback(pass: PassHandle, handler: RenderCallback): void;
@nodrops declare function Donut_SetAnimateCallback(pass: PassHandle, handler: AnimateCallback): void;
// Called before the swap chain is resized; release framebuffer-dependent resources here.
@nodrops declare function Donut_SetBackBufferResizingCallback(pass: PassHandle, handler: VoidCallback): void;
@nodrops declare function Donut_SetKeyboardCallback(pass: PassHandle, handler: KeyboardCallback): void;
// Window pixels; same return convention as the keyboard callback.
@nodrops declare function Donut_SetMousePosCallback(pass: PassHandle, handler: MousePosCallback): void;
// GLFW button / action values; same return convention as the keyboard callback.
@nodrops declare function Donut_SetMouseButtonCallback(pass: PassHandle, handler: MouseButtonCallback): void;
// Scroll offsets; same return convention as the keyboard callback.
@nodrops declare function Donut_SetMouseScrollCallback(pass: PassHandle, handler: MouseScrollCallback): void;
// The system's open (open != 0) or save file dialog; filters as "BMP files|*.bmp|All files|*.*".
// The chosen path, or "" if cancelled; valid until the next call.
@nodrops declare function Donut_FileDialog(open: boolean, filters: string): string;

// The directory of the executable (of donut_interop.dll under the JIT), '/'-separated.
@nodrops declare function Donut_GetExecutableDirectory(): string;
// Seconds per frame, averaged; 0 until measured.
@nodrops declare function Donut_GetAverageFrameTime(app: AppHandle): number;
// The device manager's frame index (Donut's GetFrameIndex): the frames rendered so far.
@nodrops declare function Donut_GetFrameIndex(app: AppHandle): int;
@nodrops declare function Donut_GetWindowWidth(app: AppHandle): int;
@nodrops declare function Donut_GetWindowHeight(app: AppHandle): int;
// Destroys resources the GPU has finished with; after Donut_WaitForIdle.
@nodrops declare function Donut_RunGarbageCollection(app: AppHandle): void;
// The swap chain's back buffers (valid until they're resized: recreate what refers to them in the
// back buffer resizing callback), the one the current frame renders into, and their format
// (SRGBA8_UNORM with D3D, SBGRA8_UNORM with Vulkan).
@nodrops declare function Donut_GetBackBufferCount(app: AppHandle): int;
@nodrops declare function Donut_GetBackBuffer(app: AppHandle, index: int): TextureHandle;
@nodrops declare function Donut_GetCurrentBackBufferIndex(app: AppHandle): int;
@nodrops declare function Donut_GetBackBufferFormat(app: AppHandle): Format;
@nodrops declare function Donut_GetSwapChainColorSpace(app: AppHandle): SwapChainColorSpace;
// The LUID of the device's adapter into dst (Ref of a `let` int array of 2: low, high part), e.g. to
// make another API's device on the same GPU. 0 if the API doesn't give it.
@nodrops declare function Donut_GetAdapterLuid(app: AppHandle, dst: Ref<int>): int;
// Asks for another color space of the back buffers, from the next frame on (as a resize: back
// buffer resizing callbacks run). 0 (nothing changes) if the swap chain can't present it.
@nodrops declare function Donut_SetSwapChainColorSpace(app: AppHandle, colorSpace: SwapChainColorSpace): int;
// Changes the back buffers' format (RGBA8_UNORM, SRGBA8_UNORM, R10G10B10A2_UNORM or RGBA16_FLOAT; 8-bit
// ones BGRA on Vulkan) at once, as a resize; not within a frame. 0 where the swap chain can't have it.
declare function Donut_SetSwapChainFormat(app: AppHandle, format: Format): int;
// Non-zero if the display the window is mostly on is in HDR mode (Windows' HDR on: an HDR10
// output), as the ATG samples' UpdateColorSpace finds it; 0 elsewhere than on Windows.
@nodrops declare function Donut_IsDisplayHdr(app: AppHandle): int;

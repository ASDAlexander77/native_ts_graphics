/// <reference path="../donut_handles.d.ts" />
/// <reference path="app.d.ts" />
// Dear ImGui

// Donut's ImGui renderer as a pass drawn after the ones added before (on top) and seeing input
// before them; buildUI builds the UI every frame with the Donut_ImGui* functions (only valid in
// it). Null if the renderer can't be initialized.
@nodrops declare function Donut_AddImGuiPass(app: AppHandle, buildUI: VoidCallback): ImGuiPassHandle | null;
// Draws the UI into framebuffer (e.g. an HDR scene's, Donut_CreateFramebuffer) instead of the back
// buffer; null: the back buffer again. Passes added after the ImGui pass draw after it (e.g. one
// that takes that framebuffer's texture to the back buffer).
@nodrops declare function Donut_SetImGuiPassFramebuffer(imguiPass: ImGuiPassHandle, framebuffer: FramebufferHandle | null): void;
// Same, the UI drawn as a layer to put over the frame later: framebuffer cleared to 0 gets the UI's color
// premultiplied by its alpha and its coverage in alpha (Final = UI.rgb + (1 - UI.a) x frame, as Streamline's
// DLSS-G wants its UI color and alpha); null: the back buffer again, with Donut's blending.
@nodrops declare function Donut_SetImGuiPassLayerFramebuffer(imguiPass: ImGuiPassHandle, framebuffer: FramebufferHandle | null): void;
@nodrops declare function Donut_ImGuiSetNextWindowPos(x: number, y: number): void;
// autoResize != 0: the window fits its contents. Pair with Donut_ImGuiEnd.
@nodrops declare function Donut_ImGuiBegin(title: string, autoResize: boolean): void;
@nodrops declare function Donut_ImGuiEnd(): void;
@nodrops declare function Donut_ImGuiText(text: string): void;
@nodrops declare function Donut_ImGuiSeparator(): void;
@nodrops declare function Donut_ImGuiIndent(): void;
@nodrops declare function Donut_ImGuiUnindent(): void;
@nodrops declare function Donut_ImGuiPushItemWidth(width: number): void;
@nodrops declare function Donut_ImGuiPopItemWidth(): void;
// Value in, new value out.
@nodrops declare function Donut_ImGuiCheckbox(label: string, value: boolean): boolean;
// True if clicked.
@nodrops declare function Donut_ImGuiButton(label: string): boolean;
// items separated by '|'; returns the new selection.
@nodrops declare function Donut_ImGuiCombo(label: string, current: int, items: string): int;
// True while the list is open: then add Donut_ImGuiSelectable items and Donut_ImGuiEndCombo.
@nodrops declare function Donut_ImGuiBeginCombo(label: string, preview: string): boolean;
// True if clicked.
@nodrops declare function Donut_ImGuiSelectable(label: string, selected: boolean): boolean;
// Shown selected when active; true if clicked.
@nodrops declare function Donut_ImGuiRadioButton(label: string, active: boolean): boolean;
// 4 floats (RGBA) at values (Ref of a `let` f32 array element), width pixels wide (0: default);
// true if changed.
@nodrops declare function Donut_ImGuiColorEdit4(label: string, values: Ref<f32>, width: number): boolean;
// A color picker of 3 floats (Ref of a `let` f32 array; RGB, unbounded) without previews; non-zero
// when changed.
@nodrops declare function Donut_ImGuiColorPicker3(label: string, values: Ref<f32>, width: number): boolean;
// Scopes the IDs of the widgets that follow (same labels apart) until Donut_ImGuiPopID.
@nodrops declare function Donut_ImGuiPushID(id: int): void;
@nodrops declare function Donut_ImGuiPopID(): void;
@nodrops declare function Donut_ImGuiEndCombo(): void;
// 3 floats at values (Ref of a `let` f32 array element); true if changed.
@nodrops declare function Donut_ImGuiDragFloat3(label: string, values: Ref<f32>, speed: number): boolean;
// Places the next window with its pivot (0..1 of its size; 1, 0 = top right corner) at x, y.
@nodrops declare function Donut_ImGuiSetNextWindowPosPivot(x: number, y: number, pivotX: number, pivotY: number): void;
// Value in, new value out.
@nodrops declare function Donut_ImGuiSliderFloat(label: string, value: number, min: number, max: number): number;
// Keyboard navigation of the ImGui windows (Tab, arrows, Enter or Space, Escape); after
// Donut_AddImGuiPass. ImGui then takes the keyboard while one of its windows has the focus.
@nodrops declare function Donut_ImGuiSetKeyboardNavigation(enable: boolean): void;
// Value in, new value out.
@nodrops declare function Donut_ImGuiSliderInt(label: string, value: int, min: int, max: int): int;
// The next item on this line, offsetFromStartX pixels from the window's left (0: right after the
// previous item).
@nodrops declare function Donut_ImGuiSameLineAt(offsetFromStartX: number): void;
// The text color of the items that follow, until Donut_ImGuiPopStyleColor.
@nodrops declare function Donut_ImGuiPushTextColor(r: number, g: number, b: number, a: number): void;
@nodrops declare function Donut_ImGuiPopStyleColor(): void;
// A window drawn over the scene at (x, y), width x height: no title bar, background or scrollbars,
// not movable, ignoring the mouse (an overlay graph). Pair with Donut_ImGuiEnd.
@nodrops declare function Donut_ImGuiBeginOverlay(title: string, x: number, y: number, width: number, height: number): void;
// count values (Ref of a `let` f32 array element) as a line graph, starting at valuesOffset
// (wrapping around), scaleMin at the bottom and scaleMax at the top, width x height pixels;
// frameBackground 0: without the frame's background.
@nodrops declare function Donut_ImGuiPlotLines(label: string, values: Ref<f32>, count: int, valuesOffset: int, scaleMin: number,
    scaleMax: number, width: number, height: number, frameBackground: int): void;
// Value in, new value out: edited by dragging (speed per pixel), clamped to min .. max.
@nodrops declare function Donut_ImGuiDragFloat(label: string, value: number, speed: number, min: number, max: number): number;
// A number field with - and + buttons stepping it by step, shown with a printf format ("%.3f");
// returns the new value.
@nodrops declare function Donut_ImGuiInputFloat(label: string, value: number, step: number, format: string): number;
// True while expanded.
@nodrops declare function Donut_ImGuiCollapsingHeader(label: string): boolean;
// Same, expanded until the user collapses it.
@nodrops declare function Donut_ImGuiCollapsingHeaderDefaultOpen(label: string): boolean;
@nodrops declare function Donut_ImGuiSameLine(): void;
// Ends the line: the next item starts on a new one (after Donut_ImGuiSameLine, an empty line).
@nodrops declare function Donut_ImGuiNewLine(): void;
// A scrolling region of width x height pixels (0: the rest of the window); end it with
// Donut_ImGuiEndChild whatever this returns.
@nodrops declare function Donut_ImGuiBeginChild(id: string, width: number, height: number, border: boolean): boolean;
@nodrops declare function Donut_ImGuiEndChild(): void;
// Inside a combo box, after the selected item: scrolls to it when the list opens.
@nodrops declare function Donut_ImGuiSetItemDefaultFocus(): void;
@nodrops declare function Donut_ImGuiGetFontSize(): number;
// A TrueType font (path relative to the executable's directory) at a size in pixels; call right
// after Donut_AddImGuiPass (imguiPass is what it returned). Null if the file can't be read.
@nodrops declare function Donut_ImGuiCreateFont(imguiPass: ImGuiPassHandle, path: string, size: number): ImGuiFontHandle;
@nodrops declare function Donut_ImGuiPushFont(font: ImGuiFontHandle): void;
@nodrops declare function Donut_ImGuiPopFont(): void;
// Text at (x, y) in UI coordinates (its top-left corner, or with alignRight its top-right one) in
// the current font and color, behind the windows (no window needed).
@nodrops declare function Donut_ImGuiDrawText(x: number, y: number, text: string, r: number, g: number, b: number, a: number, alignRight: int): void;
// A filled rectangle from (x0, y0) to (x1, y1) in UI coordinates, behind the windows, over what was
// drawn behind them before (e.g. a box for Donut_ImGuiDrawText's text to go on).
@nodrops declare function Donut_ImGuiDrawRect(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, a: number): void;
// The width of a line of text in the current font, in UI coordinates.
@nodrops declare function Donut_ImGuiCalcTextWidth(text: string): number;
// A borderless window over the whole screen, with text centered on it (may span lines).
@nodrops declare function Donut_ImGuiBeginFullScreenWindow(imguiPass: ImGuiPassHandle): void;
@nodrops declare function Donut_ImGuiDrawScreenCenteredText(imguiPass: ImGuiPassHandle, text: string): void;
@nodrops declare function Donut_ImGuiEndFullScreenWindow(imguiPass: ImGuiPassHandle): void;
// Donut's material / light editor widgets, for a scene material / light; true if it changed.
@nodrops declare function Donut_ImGuiMaterialEditor(material: MaterialHandle, allowDomainChanges: boolean): boolean;
@nodrops declare function Donut_ImGuiLightEditor(light: LightHandle): boolean;

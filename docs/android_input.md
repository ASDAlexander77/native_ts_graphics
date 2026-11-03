# Android input: touch as a mouse

The examples read input as on a desktop: GLFW's cursor, mouse buttons, wheel and keys, through
NRIFramework (`Nri_GetMouseX`, `Nri_IsButtonPressed`, `Nri_GetMouseWheel`, `Nri_IsKeyPressed`, ...)
or Donut. On Android, the GLFW platform in `patches/glfw-android-platform.patch` turns touches into
those same events, so an example's input code runs unchanged. This page lists what each touch
becomes, and what an example has to do to work well with a finger.

## What each touch becomes

| On the phone | What the example sees |
|---|---|
| One finger down | Cursor moves to the finger; **left button** pressed |
| One finger moving | Cursor follows it (left button still down) |
| One finger lifted | **Left button** released (cursor at the lift point) |
| Second finger down | Left button released; **middle button** pressed; cursor jumps to the midpoint of the two fingers |
| Two fingers moving together | Cursor follows their midpoint (middle button held): a **middle-button drag** |
| Two fingers spreading or pinching | **Wheel** notches: +1 per 48 dp the distance between them grows, −1 per 48 dp it shrinks (fractional notches, sent as the fingers move) |
| Two fingers, far enough from where they began | **Keys held** (see below) |
| Either of the two fingers lifted | Middle button released, gesture keys released |
| Remaining finger after a gesture | Ignored (no left button) until every finger is lifted |
| Third finger | Ignored |
| Touch cancelled by the system | As a lift: buttons and gesture keys released |

dp is a density-independent pixel: 1/160 inch. The thresholds are scaled by the display's density
(`AConfiguration_getDensity` / 160), so they're the same physical distance on every phone.

### Gesture keys

While two fingers are down, the gesture also holds keys, for examples that move a camera with the
keyboard. Each is held while the gesture is past its dead zone, measured from where the gesture
began, and released when it comes back inside it:

| Gesture (from where the fingers began) | Key held |
|---|---|
| Spread apart by more than 40 dp | **W** |
| Pinched together by more than 40 dp | **S** |
| Midpoint moved right by more than 32 dp | **D** |
| Midpoint moved left by more than 32 dp | **A** |
| Midpoint moved up by more than 32 dp | **E** |
| Midpoint moved down by more than 32 dp | **Q** |

So a pinch is both wheel notches (as it moves) and W or S (while it's past 40 dp). An example that
uses the wheel for zoom should ignore W/S during a gesture, or the other way round.

### Not produced on Android

- **Right button**: nothing makes it. NRIFramework's built-in camera (`GetCameraDescFromInputDevices`)
  turns only while the right button is held, so it never turns from touch; an example that needs a
  camera on Android has to drive it itself (from the left or middle button, or the gesture keys).
- **Hover**: a finger only moves the cursor while it's down, so nothing can read "what's under the
  pointer" without pressing. (A mouse or a stylus hovering does move the cursor.)
- **Modifier keys** with a touch, unless a keyboard is attached.

## Physical mice, keyboards and styluses

| Device | What the example sees |
|---|---|
| Mouse moving (no button) | Cursor moves (hover) |
| Mouse button | **Left button**: Android reports a click as a touch going down, and the patch doesn't read which button it was |
| Mouse wheel | **Wheel** (vertical and horizontal) |
| Stylus | As a finger; a hovering stylus moves the cursor |
| Keyboard | GLFW keys: A–Z, 0–9, F1–F12, Space, Enter, Tab, Backspace, Delete, arrows, Home/End, Page Up/Down, Shift, Control, Alt (left and right) |
| Back button or gesture | **Escape** |

## The same input on a desktop

What a desktop user does to get each Android input, for testing an example's touch handling with a
mouse:

| Android | Desktop |
|---|---|
| One-finger tap, drag | Left click, left drag |
| Two-finger drag | Middle-button drag |
| Pinch out / in | Wheel up / down while holding the middle button |
| Long press | Left button held still |

To script it (as the sandbox's gesture test does), post the window messages a pinch produces, in
the same order: `WM_LBUTTONUP` then `WM_MBUTTONDOWN` when the second finger lands,
`WM_MOUSEWHEEL` with `MK_MBUTTON` as the fingers spread, `WM_MOUSEMOVE` with `MK_MBUTTON` as they
move, `WM_MBUTTONUP` when one lifts. Run the example with `--alwaysActive` (NRIFramework skips
frames while its window isn't focused) and post to its `GLFW30` window.

## In the examples

- **powder_sandbox_nri**:
  - **One finger:** paints with the selected tool, and taps the toolbar's tiles. Dragging along
    the toolbar scrolls it.
  - **Two fingers:** pinch to zoom around their midpoint (up to 8x), drag to pan. A second
    finger down within 0.3 s of the first undoes what the first had begun painting.
  - **Inspect tile:** with it selected, a touch paints nothing and the HUD reads the cell under
    the finger. This stands in for hover.
  - **Desktop:** Ctrl+wheel zooms, a middle-button drag pans, and the plain wheel sizes the
    brush.
- **conservative_rasterization_nri** and **dynamic_uniform_buffers_nri** (ApiVulkanSample's mouse
  controls): a left drag turns the camera, a middle drag pans. Their right-button zoom has no
  touch equivalent; dynamic_uniform_buffers_nri also zooms with the wheel, so it can be pinched.

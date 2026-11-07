// A pointer's gestures (a mouse, or touch: NRIFramework reports one finger as the left button, two
// as the middle one at their midpoint): the press (where and when it began), a drag past a
// threshold, a long press (held still), a recent press a second finger turns into a pinch, the
// two fingers' movement (a pan), and a two-finger tap (down and up again quickly, neither panning
// nor pinching; a middle click with a mouse). What each one does is the app's.
//
// Imported with `import { PointerGestures } from "../core/pointer_gestures";` (add_tslang_nri_example
// adds it to the app's sources). Each frame: update() with the pointer, then ask.

@final
export class PointerGestures {
    // How far (pixels) a press moves before it's a drag, and how long (seconds) it's held still
    // to be a long press.
    dragThreshold: number = 8.0;
    longPressTime: number = 0.45;

    // The pointer, and the one-finger press: down this frame (not while two fingers are), and
    // last frame.
    x: number = 0.0;
    y: number = 0.0;
    down: boolean = false;
    wasDown: boolean = false;
    // Two fingers (or the middle button) down, this frame and last.
    twoFingers: boolean = false;
    private twoFingersBefore: boolean = false;
    // Where and when the press began.
    pressX: number = 0.0;
    pressY: number = 0.0;
    private pressTime: number = 0.0;
    // Since it began: moved past dragThreshold across, or either way; its long press reported.
    private draggedAcross: boolean = false;
    private moved: boolean = false;
    private longPressed: boolean = false;
    // The two fingers' midpoint last frame, and its movement since.
    private panX: number = 0.0;
    private panY: number = 0.0;
    panDX: number = 0.0;
    panDY: number = 0.0;
    private forget: boolean = false;
    // Where (their midpoint) and when two fingers came down; since then, whether it moved past
    // dragThreshold, and how far they pinched (wheel notches, as zoomed() reports them).
    twoFingerX: number = 0.0;
    twoFingerY: number = 0.0;
    private twoFingerTime: number = 0.0;
    private twoFingerMoved: boolean = false;
    private twoFingerZoom: number = 0.0;

    // The pointer at (x, y), its button (one finger) and the second (two fingers) down, at time
    // (seconds).
    update(x: number, y: number, button: boolean, second: boolean, time: number) {
        this.x = x;
        this.y = y;
        this.wasDown = this.forget ? false : this.down;
        this.forget = false;
        this.down = button && !second;
        this.twoFingersBefore = this.twoFingers;
        this.twoFingers = second;
        if (this.down && !this.wasDown) {
            this.pressX = x;
            this.pressY = y;
            this.pressTime = time;
            this.draggedAcross = false;
            this.moved = false;
            this.longPressed = false;
        }
        if (this.down) {
            if (Math.abs(x - this.pressX) > this.dragThreshold) {
                this.draggedAcross = true;
            }
            if (Math.abs(x - this.pressX) > this.dragThreshold || Math.abs(y - this.pressY) > this.dragThreshold) {
                this.moved = true;
            }
        }
        if (second && !this.twoFingersBefore) {
            this.panX = x;
            this.panY = y;
            this.twoFingerX = x;
            this.twoFingerY = y;
            this.twoFingerTime = time;
            this.twoFingerMoved = false;
            this.twoFingerZoom = 0.0;
        }
        if (second && (Math.abs(x - this.twoFingerX) > this.dragThreshold || Math.abs(y - this.twoFingerY) > this.dragThreshold)) {
            this.twoFingerMoved = true;
        }
        this.panDX = second ? x - this.panX : 0.0;
        this.panDY = second ? y - this.panY : 0.0;
        if (second) {
            this.panX = x;
            this.panY = y;
        }
    }

    // A press began this frame, or ended.
    pressed(): boolean {
        return this.down && !this.wasDown;
    }

    released(): boolean {
        return !this.down && this.wasDown;
    }

    // Two fingers came down this frame.
    twoFingersStarted(): boolean {
        return this.twoFingers && !this.twoFingersBefore;
    }

    // The press has moved past dragThreshold across (a row's scroll), sticky till the next press.
    dragged(): boolean {
        return this.draggedAcross;
    }

    // The press has moved past dragThreshold either way (sticky till the next press).
    hasMoved(): boolean {
        return this.moved;
    }

    // True once, the frame a press held still reaches longPressTime (at time).
    longPress(time: number): boolean {
        if (!this.down || this.moved || this.longPressed || time - this.pressTime < this.longPressTime) {
            return false;
        }
        this.longPressed = true;
        return true;
    }

    // The two fingers pinched by notches (the wheel's, this frame): a pinch isn't a tap.
    zoomed(notches: number) {
        if (this.twoFingers) {
            this.twoFingerZoom += Math.abs(notches);
        }
    }

    // True the frame two fingers lift, if they came down under within seconds before time and
    // neither moved past dragThreshold nor pinched half a wheel notch: a two-finger tap.
    twoFingerTap(time: number, within: number): boolean {
        return !this.twoFingers && this.twoFingersBefore && !this.twoFingerMoved && this.twoFingerZoom < 0.5
            && time - this.twoFingerTime < within;
    }

    // The last press began under within seconds before time and hasn't moved: a second finger now
    // makes it a pinch's start, not a stroke.
    pressedRecently(time: number, within: number): boolean {
        return !this.moved && time - this.pressTime < within;
    }

    // The press in progress forgotten: the next frame's button down begins a new one.
    restart() {
        this.forget = true;
    }
}

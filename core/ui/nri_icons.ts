// Icons drawn with NRIFramework's ImGui draw list (lines, arcs, triangles, circles): vector shapes,
// sharp at any size, for buttons and tiles. Each is centered on (cx, cy) and fills a square s from
// the center each way (2s across), in the color (r, g, b, a); lines are a fraction of s thick (at
// least 2 pixels).
//
// Imported with `import { NriIcons } from "../core/ui/nri_icons";`, and listed in the app's
// add_tslang_nri_example sources. Drawn between the app's NriSample.imguiNewFrame and
// NriSample.imguiRender, behind any ImGui windows.

/// <reference path="../nri/nri_interop.d.ts" />
import { NriImgui } from "../nri";

const ICON_PI = 3.141592653589793;

@final
export class NriIcons {
    // The lines' thickness for an icon s from its center.
    static thickness(s: number): number {
        return Math.max(2.0, s * 0.16);
    }

    // A right-pointing triangle: play.
    static play(cx: number, cy: number, s: number, r: number, g: number, b: number, a: number) {
        NriImgui.drawTriangle(cx - 0.55 * s, cy - 0.75 * s, cx - 0.55 * s, cy + 0.75 * s, cx + 0.75 * s, cy, r, g, b, a);
    }

    // Two bars: pause.
    static pause(cx: number, cy: number, s: number, r: number, g: number, b: number, a: number) {
        NriImgui.drawRect(cx - 0.6 * s, cy - 0.7 * s, cx - 0.2 * s, cy + 0.7 * s, r, g, b, a);
        NriImgui.drawRect(cx + 0.2 * s, cy - 0.7 * s, cx + 0.6 * s, cy + 0.7 * s, r, g, b, a);
    }

    // An arrow from (x0, y0) to (x1, y1), its head at (x1, y1), lines t thick.
    static arrow(x0: number, y0: number, x1: number, y1: number, t: number, r: number, g: number, b: number, a: number) {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const length = Math.max(Math.sqrt(dx * dx + dy * dy), 0.001);
        const ux = dx / length;
        const uy = dy / length;
        const head = Math.max(t * 2.6, length * 0.4);
        const baseX = x1 - ux * head;
        const baseY = y1 - uy * head;
        NriImgui.drawLine(x0, y0, baseX + ux * t * 0.5, baseY + uy * t * 0.5, t, r, g, b, a);
        NriImgui.drawTriangle(x1, y1, baseX - uy * head * 0.6, baseY + ux * head * 0.6, baseX + uy * head * 0.6, baseY - ux * head * 0.6,
            r, g, b, a);
    }

    // A curved arrow turning back to the left: undo.
    static undo(cx: number, cy: number, s: number, r: number, g: number, b: number, a: number) {
        const t = NriIcons.thickness(s);
        const ox = cx + 0.1 * s;
        const oy = cy + 0.15 * s;
        const radius = 0.55 * s;
        // From the left, over the top, round to the lower right; the head at the left end, pointing down.
        NriImgui.drawArc(ox, oy, radius, ICON_PI, ICON_PI * 2.3, t, r, g, b, a);
        const tipX = ox - radius;
        NriImgui.drawTriangle(tipX - 0.38 * s, oy - 0.05 * s, tipX + 0.38 * s, oy - 0.05 * s, tipX, oy + 0.45 * s, r, g, b, a);
    }

    // A floppy disk: save.
    static save(cx: number, cy: number, s: number, r: number, g: number, b: number, a: number) {
        const t = NriIcons.thickness(s);
        NriImgui.drawRectOutline(cx - 0.75 * s, cy - 0.75 * s, cx + 0.75 * s, cy + 0.75 * s, 0.12 * s, t, r, g, b, a);
        // The shutter at the top, the label at the bottom.
        NriImgui.drawRect(cx - 0.4 * s, cy - 0.75 * s, cx + 0.3 * s, cy - 0.25 * s, r, g, b, a);
        NriImgui.drawRect(cx - 0.45 * s, cy + 0.15 * s, cx + 0.45 * s, cy + 0.75 * s, r, g, b, a);
    }

    // A folder: open (load).
    static folder(cx: number, cy: number, s: number, r: number, g: number, b: number, a: number) {
        NriImgui.drawRect(cx - 0.8 * s, cy - 0.65 * s, cx - 0.1 * s, cy - 0.35 * s, r, g, b, a);
        NriImgui.drawRect(cx - 0.8 * s, cy - 0.45 * s, cx + 0.8 * s, cy + 0.65 * s, r, g, b, a);
    }

    // A rubbish bin: clear.
    static trash(cx: number, cy: number, s: number, r: number, g: number, b: number, a: number) {
        const t = NriIcons.thickness(s);
        // The lid and its handle.
        NriImgui.drawLine(cx - 0.75 * s, cy - 0.55 * s, cx + 0.75 * s, cy - 0.55 * s, t, r, g, b, a);
        NriImgui.drawRectOutline(cx - 0.25 * s, cy - 0.8 * s, cx + 0.25 * s, cy - 0.55 * s, 0.0, t * 0.8, r, g, b, a);
        // The body and its ribs.
        NriImgui.drawRectOutline(cx - 0.55 * s, cy - 0.4 * s, cx + 0.55 * s, cy + 0.8 * s, 0.1 * s, t, r, g, b, a);
        NriImgui.drawLine(cx - 0.18 * s, cy - 0.2 * s, cx - 0.18 * s, cy + 0.6 * s, t * 0.8, r, g, b, a);
        NriImgui.drawLine(cx + 0.18 * s, cy - 0.2 * s, cx + 0.18 * s, cy + 0.6 * s, t * 0.8, r, g, b, a);
    }

    // An eye: view.
    static eye(cx: number, cy: number, s: number, r: number, g: number, b: number, a: number) {
        const t = NriIcons.thickness(s);
        // Two arcs meeting at (cx -+ 0.85 s, cy), their circles 0.5 s below and above.
        const c = 0.5 * s;
        const halfWidth = 0.85 * s;
        const radius = Math.sqrt(halfWidth * halfWidth + c * c);
        const corner = Math.atan2(c, halfWidth);
        NriImgui.drawArc(cx, cy + c, radius, ICON_PI + corner, ICON_PI * 2.0 - corner, t, r, g, b, a);
        NriImgui.drawArc(cx, cy - c, radius, corner, ICON_PI - corner, t, r, g, b, a);
        NriImgui.drawCircle(cx, cy, 0.28 * s, 0.0, r, g, b, a);
    }

    // A five-pointed star: levels, a rating.
    static star(cx: number, cy: number, s: number, r: number, g: number, b: number, a: number) {
        const outer = 0.85 * s;
        const inner = 0.36 * s;
        for (let i = 0; i < 10; i++) {
            const angle0 = -ICON_PI * 0.5 + i * ICON_PI / 5.0;
            const angle1 = -ICON_PI * 0.5 + (i + 1) * ICON_PI / 5.0;
            const r0 = i % 2 == 0 ? outer : inner;
            const r1 = i % 2 == 0 ? inner : outer;
            NriImgui.drawTriangle(cx, cy + 0.05 * s, cx + Math.cos(angle0) * r0, cy + 0.05 * s + Math.sin(angle0) * r0,
                cx + Math.cos(angle1) * r1, cy + 0.05 * s + Math.sin(angle1) * r1, r, g, b, a);
        }
    }

    // A plus sign, s from its center each way.
    static plus(cx: number, cy: number, s: number, r: number, g: number, b: number, a: number) {
        const t = NriIcons.thickness(s * 2.0);
        NriImgui.drawLine(cx - s, cy, cx + s, cy, t, r, g, b, a);
        NriImgui.drawLine(cx, cy - s, cx, cy + s, t, r, g, b, a);
    }

    // A minus sign, s from its center each way.
    static minus(cx: number, cy: number, s: number, r: number, g: number, b: number, a: number) {
        NriImgui.drawLine(cx - s, cy, cx + s, cy, NriIcons.thickness(s * 2.0), r, g, b, a);
    }
}

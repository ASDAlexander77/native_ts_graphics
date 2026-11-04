// A slider drawn with NRIFramework's ImGui: a label, a track and a knob along a row of the screen,
// and its hit test and value for the pointer, for touch as much as a mouse (the track takes
// presses a row's height past its ends).
//
// Imported with `import { NriSlider } from "../core/nri_slider";`, and listed in the app's
// add_tslang_nri_example sources. Each frame, place (where it is) and draw (between the app's
// Nri_ImguiNewFrame and Nri_ImguiRender); contains and fraction read where it was last placed.
// What the fraction means (a size, rounded, say) is the app's.

/// <reference path="nri/nri_interop.d.ts" />

@final
export class NriSlider {
    private left: number = 0.0;
    private x0: number = 0.0;
    private x1: number = 0.0;
    private top: number = 0.0;
    private height: number = 0.0;

    // A row from left (its label 8 pixels in), the track from x0 to x1, top to top + height.
    place(left: number, x0: number, x1: number, top: number, height: number) {
        this.left = left;
        this.x0 = x0;
        this.x1 = x1;
        this.top = top;
        this.height = height;
    }

    // Whether (x, y) is on the row, over the track or within a row's height of its ends.
    contains(x: number, y: number): boolean {
        return y >= this.top && y < this.top + this.height && x >= this.x0 - this.height && x <= this.x1 + this.height;
    }

    // Where x is along the track, 0 at its start to 1 at its end.
    fraction(x: number): number {
        return Math.min(Math.max((x - this.x0) / Math.max(this.x1 - this.x0, 1.0), 0.0), 1.0);
    }

    // Its backing, label (labelHeight: the font's line), track and knob at fraction (0 .. 1).
    draw(label: string, fraction: number, labelHeight: number) {
        const h = this.height;
        Nri_ImguiDrawRect(this.left, this.top - 2.0, this.x1 + h, this.top + h + 2.0, 0.08, 0.08, 0.1, 0.8);
        Nri_ImguiDrawText(this.left + 8.0, this.top + (h - labelHeight) * 0.5 + 2.0, label, 1.0, 1.0, 1.0, 1.0, 0);
        const mid = this.top + h * 0.5;
        Nri_ImguiDrawRect(this.x0, mid - 2.0, this.x1, mid + 2.0, 0.45, 0.45, 0.5, 1.0);
        const knobX = this.x0 + fraction * (this.x1 - this.x0);
        const knob = h * 0.3;
        Nri_ImguiDrawRect(this.x0, mid - 2.0, knobX, mid + 2.0, 0.95, 0.95, 0.95, 1.0);
        Nri_ImguiDrawRect(knobX - knob, mid - knob * 1.4, knobX + knob, mid + knob * 1.4, 0.95, 0.95, 0.95, 1.0);
    }
}

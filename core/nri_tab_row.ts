// A row of tabs drawn with NRIFramework's ImGui: each as wide as its label and a gap, spread over
// the row when they fit and scrolled sideways when they don't, the selected one lit, a colored mark
// under any the app marks, and a bar along the top showing the scrolled row's part in view.
//
// Imported with `import { NriTabRow } from "../core/nri_tab_row";`, and listed in the app's
// add_tslang_nri_example sources. Each frame, layout (it measures the labels: between the app's
// Nri_ImguiNewFrame and Nri_ImguiRender) and draw; tabAt, offset and scrollTo read where it was
// last laid out.

/// <reference path="nri/nri_interop.d.ts" />

@final
export class NriTabRow {
    private names: string[] = [];
    // The tabs' left edges and the row's right end (unscrolled), its width on screen, and how far
    // it's scrolled.
    private edges: number[] = [];
    private end: number = 0.0;
    private width: number = 0.0;
    private scroll: number = 0.0;
    // A mark's color for each tab (r < 0: none).
    private markR: number[] = [];
    private markG: number[] = [];
    private markB: number[] = [];

    // The tabs' names, laid out over width pixels; the scroll kept within the row.
    layout(names: string[], width: number) {
        this.names = [];
        for (const name of names) {
            this.names.push(name);
        }
        while (this.markR.length < this.names.length) {
            this.markR.push(-1.0);
            this.markG.push(0.0);
            this.markB.push(0.0);
        }
        this.width = width;
        const gap = Nri_ImguiCalcTextWidth("  ");
        let total = 0.0;
        for (const name of this.names) {
            total += Nri_ImguiCalcTextWidth(name) + gap;
        }
        const spread = total < width ? (width - total) / this.names.length : 0.0;
        this.edges = [];
        let edge = 0.0;
        for (const name of this.names) {
            this.edges.push(edge);
            edge += Nri_ImguiCalcTextWidth(name) + gap + spread;
        }
        this.end = edge;
        this.scrollTo(this.scroll);
    }

    // How far the row's scrolled (0 .. maxScroll()), and how far it can be.
    offset(): number {
        return this.scroll;
    }

    maxScroll(): number {
        return Math.max(this.end - this.width, 0.0);
    }

    scrollTo(scroll: number) {
        this.scroll = Math.min(Math.max(scroll, 0.0), this.maxScroll());
    }

    // The tab at x on screen, or -1.
    tabAt(x: number): int {
        const at = x + this.scroll;
        for (let k = 0; k < this.edges.length; k++) {
            if (at >= this.edges[k] && at < this.right(k) + this.scroll) {
                return k;
            }
        }
        return -1;
    }

    // Tab k's left and right edges on screen.
    left(k: int): number {
        return this.edges[k] - this.scroll;
    }

    right(k: int): number {
        return (k + 1 < this.edges.length ? this.edges[k + 1] : this.end) - this.scroll;
    }

    // Marks drawn under tabs (for one holding what's selected, say), till cleared.
    clearMarks() {
        for (let k = 0; k < this.markR.length; k++) {
            this.markR[k] = -1.0;
        }
    }

    mark(k: int, r: number, g: number, b: number) {
        while (this.markR.length <= k) {
            this.markR.push(-1.0);
            this.markG.push(0.0);
            this.markB.push(0.0);
        }
        this.markR[k] = r;
        this.markG[k] = g;
        this.markB[k] = b;
    }

    // The row from top, height tall: tab selected lit, the marks pad pixels in from a tab's sides
    // along its bottom, the labels (labelHeight: the font's line) centered; then the scroll bar.
    draw(top: number, height: number, selected: int, labelHeight: number, pad: number) {
        const bottom = top + height;
        for (let k = 0; k < this.names.length; k++) {
            const x0 = this.left(k);
            const x1 = this.right(k);
            if (x1 <= 0.0 || x0 >= this.width) {
                continue;
            }
            const lit = k == selected;
            if (lit) {
                Nri_ImguiDrawRect(x0 + 1.0, top + 1.0, x1 - 1.0, bottom, 0.95, 0.95, 0.95, 1.0);
            }
            if (this.markR[k] >= 0.0) {
                Nri_ImguiDrawRect(x0 + pad, bottom - 4.0, x1 - pad, bottom - 1.0, this.markR[k], this.markG[k], this.markB[k], 1.0);
            }
            const name = this.names[k];
            const gray = lit ? 0.0 : 0.65;
            Nri_ImguiDrawText((x0 + x1 - Nri_ImguiCalcTextWidth(name)) * 0.5, top + (height - labelHeight) * 0.5 + 2.0, name,
                gray, gray, gray, 1.0, 0);
        }
        if (this.maxScroll() > 0.0) {
            Nri_ImguiDrawRect(this.scroll / this.end * this.width, top, (this.scroll + this.width) / this.end * this.width,
                top + 3.0, 0.7, 0.7, 0.75, 1.0);
        }
    }
}

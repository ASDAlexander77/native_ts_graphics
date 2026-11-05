// A 2D view of content (a grid, an image, a map: contentW x contentH units) in an area of the
// window: at zoom 1 the whole content fits the area, centered; zoomed in, the point of the content
// in the area's middle (centerX, centerY) moves as it's panned, kept where the content still fills
// the area across, or down (centered where it doesn't).
//
// Imported with `import { PanZoom } from "../core/pan_zoom";` (add_tslang_nri_example adds it to the
// app's sources). setArea and setContent, then layout() (again after either changes): scale is a
// unit's size in pixels, (originX, originY) where the content's (0, 0) is on screen.

@final
export class PanZoom {
    // Zoom: 1 .. maxZoom, a notch of the wheel zooming zoomStep times.
    zoom: number = 1.0;
    maxZoom: number = 8.0;
    zoomStep: number = 1.15;
    // The content point (in units) in the area's middle.
    centerX: number = 0.0;
    centerY: number = 0.0;
    // As layout() left them: a unit's size in pixels, and the content's (0, 0) on screen.
    scale: number = 1.0;
    originX: number = 0.0;
    originY: number = 0.0;
    private contentW: number = 1.0;
    private contentH: number = 1.0;
    private areaX: number = 0.0;
    private areaY: number = 0.0;
    private areaW: number = 1.0;
    private areaH: number = 1.0;

    // The area of the window it's shown in (pixels).
    setArea(x: number, y: number, width: number, height: number) {
        this.areaX = x;
        this.areaY = y;
        this.areaW = width;
        this.areaH = height;
    }

    // The content's size (units).
    setContent(width: number, height: number) {
        this.contentW = width;
        this.contentH = height;
    }

    // The whole content in view (zoom 1, centered).
    reset() {
        this.zoom = 1.0;
        this.centerX = this.contentW * 0.5;
        this.centerY = this.contentH * 0.5;
    }

    // A unit's size, in pixels, when the whole content fits the area (zoom 1).
    fitScale(): number {
        return Math.min(this.areaW / this.contentW, this.areaH / this.contentH);
    }

    // scale and origin from the zoom and center, the center kept in bounds.
    layout() {
        this.scale = this.fitScale() * this.zoom;
        const halfW = this.areaW * 0.5 / this.scale;
        const halfH = this.areaH * 0.5 / this.scale;
        this.centerX = this.contentW <= 2.0 * halfW ? this.contentW * 0.5 : Math.min(Math.max(this.centerX, halfW), this.contentW - halfW);
        this.centerY = this.contentH <= 2.0 * halfH ? this.contentH * 0.5 : Math.min(Math.max(this.centerY, halfH), this.contentH - halfH);
        this.originX = this.areaX + this.areaW * 0.5 - this.centerX * this.scale;
        this.originY = this.areaY + this.areaH * 0.5 - this.centerY * this.scale;
    }

    // Zoomed in or out by notches (of zoomStep) around the pointer at (x, y): the content point
    // under it stays there. (layout() follows.)
    zoomAt(x: number, y: number, notches: number) {
        const cx = (x - this.originX) / this.scale;
        const cy = (y - this.originY) / this.scale;
        this.zoom = Math.min(Math.max(this.zoom * Math.pow(this.zoomStep, notches), 1.0), this.maxZoom);
        const scale = this.fitScale() * this.zoom;
        this.centerX = cx - (x - (this.areaX + this.areaW * 0.5)) / scale;
        this.centerY = cy - (y - (this.areaY + this.areaH * 0.5)) / scale;
    }

    // Moved by the pointer's (dx, dy) pixels: the content follows it. (layout() follows.)
    pan(dx: number, dy: number) {
        this.centerX -= dx / this.scale;
        this.centerY -= dy / this.scale;
    }

    // The content point (units) at screen (x, y).
    toContentX(x: number): number {
        return (x - this.originX) / this.scale;
    }

    toContentY(y: number): number {
        return (y - this.originY) / this.scale;
    }
}

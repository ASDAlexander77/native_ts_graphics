/// <reference path="../core/nri/nri_interop.d.ts" />
import {
    MAX_GRID_LONG, MIN_TILE_WIDTH
} from "./defs";
import { SandboxState } from "./state";

// The grid's size and its place on screen: the view (zoom and center), the toolbar's height, and
// the grid fitted to the window above it.
export class SandboxView extends SandboxState {
    // The grid's size changed from oldW x oldH (its contents follow in recordStateRequests): the
    // scene's strokes still to paint moved with them, and a press in progress begun again.
    reshaped(oldW: int, oldH: int) {
        const dx = this.regridOffsetX(oldW);
        const dy = this.gridH - oldH;
        for (const stroke of this.script) {
            stroke.x0 += dx;
            stroke.x1 += dx;
            stroke.y0 += dy;
            stroke.y1 += dy;
        }
        this.pointer.restart();
    }

    // Where a grid oldW wide lands across the new one: centered (whole cells).
    regridOffsetX(oldW: int): int {
        return Math.floor((this.gridW - oldW) / 2);
    }

    // (an undo or a load keeping the grid's size keeps the view)
    setGrid(gridW: int, gridH: int) {
        if (gridW != this.gridW || gridH != this.gridH) {
            this.gridW = gridW;
            this.gridH = gridH;
            this.stride = (gridW + 1) * (gridH + 1);
            this.resetView();
        }
        this.layout();
    }

    // The whole grid in view.
    resetView() {
        this.panZoom.setContent(this.gridW, this.gridH);
        this.panZoom.reset();
    }

    // Zoomed in or out by notches (of panZoom.zoomStep; a pinch on Android sends a notch per 48 dp
    // its fingers spread) around the pointer at (x, y): the grid point under it stays there.
    zoomAt(x: number, y: number, notches: number) {
        this.panZoom.zoomAt(x, y, notches);
        this.layout();
    }

    // A tile's height: a share of the window's shorter side, 56 .. 160 pixels.
    toolbarTileHeight(): number {
        return Math.floor(Math.min(Math.max(Math.min(this.width, this.height) * 0.12, 56.0), 160.0));
    }

    // The tabs' row's height: under half a tile's, but room for a line of text.
    toolbarTabHeight(): number {
        return Math.floor(Math.max(this.toolbarTileHeight() * 0.42, 28.0));
    }

    // The whole toolbar's: the tabs' row and the tiles'.
    toolbarFullHeight(): number {
        return this.toolbarTileHeight() + this.toolbarTabHeight();
    }

    // Whether the grid's wider than tall whatever the window's shape: a level's, and the test
    // scenes' from 4, are laid out on one (on a phone held upright, it's turned, drawn smaller).
    wantsWide(): boolean {
        const level = this.level;
        if (level) {
            return true;
        }
        return this.test && this.scene >= 4;
    }

    // The grid's size from the shape of the window above the toolbar: gridHeight cells along its
    // shorter side, up to MAX_GRID_LONG along the longer (a wider window shows margins).
    fitGrid() {
        const playHeight = this.height - this.toolbarFullHeight();
        let gridW: int = this.gridHeight;
        let gridH: int = this.gridHeight;
        if (this.width >= playHeight) {
            gridW = Math.floor(this.gridHeight * this.width / playHeight);
        } else {
            gridH = Math.floor(this.gridHeight * playHeight / this.width);
        }
        if (this.wantsWide() && gridH > gridW) {
            const turned = gridW;
            gridW = gridH;
            gridH = turned;
        }
        this.gridW = Math.min(gridW, MAX_GRID_LONG);
        this.gridH = Math.min(gridH, MAX_GRID_LONG);
        this.resetView();
        this.stride = (this.gridW + 1) * (this.gridH + 1);
        console.log(`Grid: ${this.gridW} x ${this.gridH} cells`);
    }

    // The toolbar: the tabs' row (laid out by buildUI, by their labels), and under it the group's
    // tiles, spread over the window's width, or MIN_TILE_WIDTH pixels each (no narrower than tall)
    // and scrolled sideways when they don't fit (a phone held upright); and
    // where the grid's drawn: zoom times as large as fits above it, around its view's center
    // (kept where the grid still fills the area across, or down; centered where it doesn't).
    layout() {
        this.tileHeight = this.toolbarTileHeight();
        this.tabHeight = this.toolbarTabHeight();
        this.tileWidth = Math.max(this.width / Math.max(this.groupTiles.length, 1), Math.max(MIN_TILE_WIDTH, this.tileHeight));
        this.toolbarHeight = this.tileHeight + this.tabHeight;
        this.panZoom.setArea(0.0, 0.0, this.width, this.height - this.toolbarHeight);
        this.panZoom.setContent(this.gridW, this.gridH);
        this.panZoom.layout();
    }
}

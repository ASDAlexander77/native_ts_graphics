/// <reference path="../core/nri/nri_interop.d.ts" />
import { formatFixed } from "../core/text_format";
import {
    CAPACITY, DRAG_THRESHOLD, STROKE_CANCEL_TIME, LONG_PRESS_TIME, MIN_BRUSH, MAX_BRUSH,
    MOUSE_MIDDLE, PARTICLE_TYPES, PROBE_INTS, PROBE_AIR, PROBE_GOAL, WATER, OIL, SAND, FIRE, LAVA,
    ACID, SALT, GUNPOWDER, HONEY, PETROL, WALL, EMITTER, BLOCK, HYDROGEN, OXYGEN, NEON, THERMITE,
    NITRO, SEED, INSPECT, Tile, ACTION_SMALLER, ACTION_LARGER, ACTION_PAUSE, ACTION_VIEW,
    ACTION_CLEAR, ACTION_SHAPE, ACTION_UNDO, ACTION_SAVE, ACTION_LOAD, ACTION_LEVEL, ACTION_GRAVITY,
    GRAVITY_POINT, GRAVITY_NAMES, GRAVITY_LABELS, GRAVITY_PLACE, KEY_Z, KEY_LEFT_CONTROL,
    KEY_RIGHT_CONTROL, VIEW_NAMES, SHAPE_CIRCLE, SHAPE_SQUARE, SHAPE_LINE, SHAPE_BOX, SHAPE_NAMES,
    fanDirectionOf, sectionMaterial, materialName, starText
} from "./defs";
import { SandboxSimulation } from "./simulation";

// The toolbar and input: the tabs and tiles, the brush's size slider and radial menu, the readout,
// and the mouse, touch and keys they're driven by.
export class SandboxUI extends SandboxSimulation {
    // A tile for a group's row (and the list of every tile).
    addTile(group: int, tile: Tile) {
        tile.group = group;
        this.tiles.push(tile);
    }

    // The group whose tiles the toolbar shows; its row scrolled back to its start.
    showGroup(group: int) {
        this.group = group;
        this.groupTiles = [];
        for (const tile of this.tiles) {
            if (tile.group == group) {
                this.groupTiles.push(tile);
            }
        }
        this.toolbarScroll = 0.0;
        this.layout();
    }

    // How far the tiles' row scrolls.
    maxScroll(): number {
        return Math.max(this.groupTiles.length * this.tileWidth - this.width, 0.0);
    }

    scrollToolbar(scroll: number) {
        this.toolbarScroll = Math.min(Math.max(scroll, 0.0), this.maxScroll());
    }

    // Whether y is on the tabs' row (else the tiles', on the toolbar).
    onTabRow(y: number): boolean {
        return y < this.height - this.tileHeight;
    }

    // The size slider shows while the brush is sized by its radius (a circle, a square, a line's
    // half width; not a box, the size it's stretched to), along the top, sliderHeight() tall.
    sliderShown(): boolean {
        return this.brushShape != SHAPE_BOX;
    }

    sliderTop(): number {
        return 6.0;
    }

    sliderHeight(): number {
        return this.tabHeight;
    }

    onSlider(x: number, y: number): boolean {
        return this.sliderShown() && this.slider.contains(x, y);
    }

    // The brush's radius from x along the slider's track (whole cells, or the smallest).
    slideBrush(x: number) {
        const t = this.slider.fraction(x);
        const radius = Math.round(MIN_BRUSH + t * (MAX_BRUSH - MIN_BRUSH));
        this.brushRadius = radius < 1.0 ? MIN_BRUSH : radius;
    }

    // The menu's icons: their half size, and how far their centers are from the menu's.
    menuIconHalf(): number {
        return Math.floor(this.tileHeight * 0.42);
    }

    menuRadius(): number {
        return Math.floor(this.tileHeight * 1.15);
    }

    // Icon k's center: around the menu's, up, right, down, left.
    menuIconX(k: int): number {
        return this.menuX + (k == 1 ? this.menuRadius() : (k == 3 ? -this.menuRadius() : 0.0));
    }

    menuIconY(k: int): number {
        return this.menuY + (k == 0 ? -this.menuRadius() : (k == 2 ? this.menuRadius() : 0.0));
    }

    // The icon at (x, y), or -1.
    menuIconAt(x: number, y: number): int {
        const half = this.menuIconHalf();
        for (let k = 0; k < SHAPE_NAMES.length; k++) {
            if (Math.abs(x - this.menuIconX(k)) <= half && Math.abs(y - this.menuIconY(k)) <= half) {
                return k;
            }
        }
        return -1;
    }

    // The menu, opened around (x, y), kept where its icons fit above the toolbar.
    openMenu(x: number, y: number) {
        const reach = this.menuRadius() + this.menuIconHalf() + 4.0;
        const playHeight = this.height - this.toolbarHeight;
        this.menuX = Math.min(Math.max(x, reach), Math.max(this.width - reach, reach));
        this.menuY = Math.min(Math.max(y, reach), Math.max(playHeight - reach, reach));
        this.menuOpen = true;
    }

    // A toolbar tile was tapped.
    onTile(tile: Tile) {
        const action = tile.tool;
        if (action == ACTION_SMALLER) {
            this.brushRadius = Math.max(this.brushRadius - 1.0, MIN_BRUSH);
        } else if (action == ACTION_LARGER) {
            this.brushRadius = Math.min(this.brushRadius + 1.0, MAX_BRUSH);
        } else if (action == ACTION_PAUSE) {
            this.paused = !this.paused;
        } else if (action == ACTION_VIEW) {
            this.overlay = (this.overlay + 1) % 3;
        } else if (action == ACTION_CLEAR) {
            this.snapshotRequested = true;
            this.needsInit = true;
        } else if (action == ACTION_UNDO) {
            this.undoRequested = true;
        } else if (action == ACTION_SAVE) {
            this.saveRequested = true;
        } else if (action == ACTION_LOAD) {
            this.loadRequested = true;
        } else if (action == ACTION_LEVEL) {
            this.nextLevel();
        } else if (action == ACTION_SHAPE) {
            this.brushShape = (this.brushShape + 1) % SHAPE_NAMES.length;
        } else if (action == ACTION_GRAVITY) {
            this.gravityMode = (this.gravityMode + 1) % GRAVITY_NAMES.length;
            // (toward a point: a tap on the grid moves it, till another tool's picked)
            if (this.gravityMode == GRAVITY_POINT) {
                this.toolBeforePlace = this.tool;
                this.tool = GRAVITY_PLACE;
            } else if (this.tool == GRAVITY_PLACE) {
                this.tool = this.toolBeforePlace;
            }
            this.showMessage(`Gravity: ${GRAVITY_NAMES[this.gravityMode]}`);
        } else {
            this.tool = action;
            // Emitters emit the liquid, powder or fire picked last.
            if (action == WATER || action == OIL || action == SAND || action == SALT || action == GUNPOWDER || action == LAVA
                || action == ACID || action == HONEY || action == PETROL || action == FIRE || action == NITRO || action == THERMITE
                || action == HYDROGEN || action == OXYGEN || action == NEON || action == SEED) {
                this.emitType = action;
            }
        }
    }

    // The pointer (mouse or touch): taps on the toolbar, strokes of the brush on the grid. The
    // brush's constants for this frame.
    handleInput(): int {
        const mx = Nri_GetMouseX(this.sample);
        const my = Nri_GetMouseY(this.sample);
        // The middle button (two fingers on Android) pans and zooms the view; the left one
        // doesn't paint meanwhile.
        const middle = Nri_IsButtonPressed(this.sample, MOUSE_MIDDLE) != 0;
        const down = Nri_IsButtonPressed(this.sample, 0) != 0 && !middle;
        const control = Nri_IsKeyPressed(this.sample, KEY_LEFT_CONTROL) != 0 || Nri_IsKeyPressed(this.sample, KEY_RIGHT_CONTROL) != 0;
        const overToolbar = my >= this.height - this.toolbarHeight;

        // Two fingers down (or the middle button): if the first finger has only just begun a
        // stroke, it was the start of a pinch, so what it painted is taken back. Then the view
        // follows the pointer (the fingers' midpoint).
        if (middle && !this.middleWasDown) {
            if (this.wasDown && !this.pressOnToolbar && this.tool != INSPECT && this.time - this.pressTime < STROKE_CANCEL_TIME) {
                this.undoRequested = true;
            }
            this.panX = mx;
            this.panY = my;
        }
        if (middle) {
            this.centerX -= (mx - this.panX) / this.cellPixels;
            this.centerY -= (my - this.panY) / this.cellPixels;
            this.panX = mx;
            this.panY = my;
            this.layout();
        }

        // The wheel over the toolbar scrolls it (half a tile a notch); over the grid it zooms
        // (with Control, or the middle button down: a pinch), or sizes the brush.
        const wheel = Nri_GetMouseWheel(this.sample);
        if (overToolbar && wheel != 0.0 && this.onTabRow(my)) {
            this.tabs.scrollTo(this.tabs.offset() + (wheel > 0.0 ? -0.5 : 0.5) * this.tileWidth);
        } else if (overToolbar && wheel != 0.0) {
            this.scrollToolbar(this.toolbarScroll + (wheel > 0.0 ? -0.5 : 0.5) * this.tileWidth);
        } else if (wheel != 0.0 && (middle || control)) {
            this.zoomAt(mx, my, wheel);
        } else if (wheel > 0.0) {
            this.brushRadius = Math.min(this.brushRadius + 1.0, MAX_BRUSH);
        } else if (wheel < 0.0) {
            this.brushRadius = Math.max(this.brushRadius - 1.0, MIN_BRUSH);
        }
        this.middleWasDown = middle;
        const gx = (mx - this.viewX) / this.cellPixels;
        const gy = (my - this.viewY) / this.cellPixels;
        this.mouseGridX = gx;
        this.mouseGridY = gy;
        if (Nri_IsKeyToggled(this.sample, NriKey.Space) != 0) {
            this.paused = !this.paused;
        }
        // Ctrl+Z (each press of Z while Control is down).
        const z = Nri_IsKeyPressed(this.sample, KEY_Z) != 0;
        if (control && z && !this.zWasDown) {
            this.undoRequested = true;
        }
        this.zWasDown = z;

        let brushMode = 0;
        // (placing the attraction point paints nothing either)
        const placing = this.tool == GRAVITY_PLACE;
        if (placing && down && !this.pressOnToolbar && !(down && !this.wasDown && overToolbar)) {
            this.gravityX = Math.min(Math.max(gx, 1.0), this.gridW - 1.0);
            this.gravityY = Math.min(Math.max(gy, 1.0), this.gridH - 1.0);
        }
        const inspecting = this.tool == INSPECT || placing;
        if (down && !this.wasDown) {
            this.pressOnToolbar = overToolbar;
            this.pressTime = this.time;
            // (a press while the menu's open picks from it, or closes it; one on the slider sizes
            // the brush)
            this.longPressed = false;
            this.pressOnSlider = !overToolbar && !this.menuOpen && this.onSlider(mx, my);
            this.pressOnUi = !overToolbar && (this.menuOpen || this.pressOnSlider);
            // A stroke begins: what it changes can be undone.
            if (!overToolbar && !this.pressOnUi && !inspecting) {
                this.snapshotRequested = true;
            }
            this.pressX = mx;
            this.pressY = my;
            this.pressScroll = this.onTabRow(my) ? this.tabs.offset() : this.toolbarScroll;
            this.dragging = false;
            this.lastGridX = gx;
            this.lastGridY = gy;
            this.anchorX = gx;
            this.anchorY = gy;
        }
        // On the toolbar: a drag scrolls the row pressed, a release that didn't drag taps the tab
        // or the tile there.
        if (this.pressOnToolbar) {
            const tabs = this.onTabRow(this.pressY);
            if (down) {
                if (Math.abs(mx - this.pressX) > DRAG_THRESHOLD) {
                    this.dragging = true;
                }
                if (this.dragging && tabs) {
                    this.tabs.scrollTo(this.pressScroll - (mx - this.pressX));
                } else if (this.dragging) {
                    this.scrollToolbar(this.pressScroll - (mx - this.pressX));
                }
            } else if (this.wasDown && !this.dragging && tabs) {
                const g = this.tabs.tabAt(this.pressX);
                if (g >= 0) {
                    this.showGroup(g);
                }
            } else if (this.wasDown && !this.dragging) {
                const index: int = Math.floor((this.pressX + this.toolbarScroll) / this.tileWidth);
                if (index >= 0 && index < this.groupTiles.length) {
                    this.onTile(this.groupTiles[index]);
                }
            }
        }
        // The slider: the brush's radius follows the pointer along it.
        if (down && this.pressOnSlider) {
            this.slideBrush(mx);
        }
        // A press held still on the grid opens the menu around it (and takes back what it
        // painted); it's then the menu's. Not while inspecting or placing the attraction point:
        // they have no brush, and holding still is how a cell is read.
        if (down && !this.pressOnToolbar && !this.pressOnUi && !inspecting) {
            if (Math.abs(mx - this.pressX) > DRAG_THRESHOLD || Math.abs(my - this.pressY) > DRAG_THRESHOLD) {
                this.pressTime = -1.0;
            }
            if (this.pressTime >= 0.0 && this.time - this.pressTime >= LONG_PRESS_TIME) {
                this.undoRequested = true;
                this.openMenu(this.pressX, this.pressY);
                this.longPressed = true;
                this.pressOnUi = true;
            }
        }
        // Released on an icon: its shape. The press that opened the menu leaves it open when
        // released elsewhere (to tap an icon next); another closes it.
        if (!down && this.wasDown && this.menuOpen && this.pressOnUi) {
            const icon = this.menuIconAt(mx, my);
            if (icon >= 0) {
                this.brushShape = icon;
                this.menuOpen = false;
            } else if (!this.longPressed) {
                this.menuOpen = false;
            }
        }
        const toGrid = !this.pressOnToolbar && !this.pressOnUi;

        // On the grid: circles and squares paint along the path; lines and boxes when released.
        // (a Block is always a box: a body of that size)
        const boxing = this.brushShape == SHAPE_BOX || this.tool == BLOCK;
        const stretches = this.brushShape == SHAPE_LINE || boxing;
        const pressOnGrid = this.wasDown && toGrid;
        if (inspecting) {
            // (nothing painted)
        } else if (down && toGrid && !stretches) {
            brushMode = 1;
            this.fanDirection = fanDirectionOf(gx - this.anchorX, gy - this.anchorY);
            this.kernels.setFloat(10, this.lastGridX);
            this.kernels.setFloat(11, this.lastGridY);
            this.kernels.setFloat(12, gx);
            this.kernels.setFloat(13, gy);
            this.lastGridX = gx;
            this.lastGridY = gy;
        } else if (!down && pressOnGrid && stretches && !middle) {
            brushMode = boxing ? 2 : 1;
            this.fanDirection = fanDirectionOf(gx - this.anchorX, gy - this.anchorY);
            this.kernels.setFloat(10, this.anchorX);
            this.kernels.setFloat(11, this.anchorY);
            this.kernels.setFloat(12, gx);
            this.kernels.setFloat(13, gy);
        }

        // The cursor: the brush at the pointer, or the line or box being stretched; none over
        // the toolbar or while dragging it.
        let cursorMode = 1;
        let cursorX = gx;
        let cursorY = gy;
        if (down && toGrid && stretches) {
            cursorMode = boxing ? 2 : 1;
            cursorX = this.anchorX;
            cursorY = this.anchorY;
        } else if (this.brushShape == SHAPE_BOX) {
            cursorMode = 2;
        }
        if (inspecting) {
            cursorMode = 3;
        }
        if (overToolbar || (down && !toGrid) || middle || this.menuOpen || this.onSlider(mx, my)) {
            cursorMode = 0;
        }
        const shape = this.brushShape == SHAPE_SQUARE ? 1 : 0;
        this.shapeWord = shape | (cursorMode << 4);
        this.kernels.setFloat(28, cursorX);
        this.kernels.setFloat(29, cursorY);
        this.wasDown = down;
        return brushMode;
    }

    // The toolbar and the readout.
    buildUI() {
        Nri_ImguiNewFrame(this.sample);
        const tileWidth = this.tileWidth;
        const pad = Math.max(2.0, Math.min(tileWidth, this.tileHeight) * 0.06);
        const labelHeight = Nri_ImguiGetFontSize() + 4.0;
        const tabTop = this.height - this.toolbarHeight;
        const top = tabTop + this.tabHeight;
        const bottom = this.height;
        Nri_ImguiDrawRect(0.0, tabTop, this.width, top, 0.13, 0.13, 0.16, 1.0);
        Nri_ImguiDrawRect(0.0, top, this.width, bottom, 0.08, 0.08, 0.1, 1.0);
        // The tabs: each as wide as its label and a gap, spread over the row when they fit; the
        // group shown lit as a selected tile is, and under a tab whose group holds the tool, a bar of the tool's color.
        this.tabs.layout(this.groups, this.width);
        this.tabs.clearMarks();
        for (const tile of this.tiles) {
            if (tile.tool == this.tool) {
                this.tabs.mark(tile.group, tile.r, tile.g, tile.b);
            }
        }
        this.tabs.draw(tabTop, this.tabHeight, this.group, labelHeight, pad);
        for (let i = 0; i < this.groupTiles.length; i++) {
            const tile = this.groupTiles[i];
            const x0 = i * tileWidth - this.toolbarScroll;
            if (x0 + tileWidth <= 0.0 || x0 >= this.width) {
                continue;
            }
            const selected = tile.tool == this.tool || (tile.tool == ACTION_PAUSE && this.paused)
                || (tile.tool == ACTION_GRAVITY && this.tool == GRAVITY_PLACE);
            if (selected) {
                Nri_ImguiDrawRect(x0 + 1.0, top + 1.0, x0 + tileWidth - 1.0, bottom - 1.0, 0.95, 0.95, 0.95, 1.0);
            }
            Nri_ImguiDrawRect(x0 + pad, top + pad, x0 + tileWidth - pad, bottom - pad - labelHeight, tile.r, tile.g, tile.b, 1.0);
            let label = tile.label;
            if (tile.tool == ACTION_PAUSE && this.paused) {
                label = "Play";
            } else if (tile.tool == ACTION_SHAPE) {
                label = SHAPE_NAMES[this.brushShape];
            } else if (tile.tool == ACTION_GRAVITY) {
                label = GRAVITY_LABELS[this.gravityMode];
            } else if (tile.tool == EMITTER) {
                // What it emits, in the middle of its swatch.
                let emitted = tile;
                for (const other of this.tiles) {
                    if (other.tool == this.emitType) {
                        emitted = other;
                    }
                }
                const cx = x0 + tileWidth * 0.5;
                const cy = (top + bottom - labelHeight) * 0.5;
                const half = tileWidth * 0.15;
                Nri_ImguiDrawRect(cx - half, cy - half, cx + half, cy + half, emitted.r, emitted.g, emitted.b, 1.0);
            }
            const textWidth = Nri_ImguiCalcTextWidth(label);
            Nri_ImguiDrawText(x0 + (tileWidth - textWidth) * 0.5, bottom - pad - labelHeight + 2.0, label,
                selected ? 0.0 : 1.0, selected ? 0.0 : 1.0, selected ? 0.0 : 1.0, 1.0, 0);
        }
        // When the tiles' row scrolls, a bar along its top: how much of it shows, and where (the
        // tabs draw theirs).
        if (this.maxScroll() > 0.0) {
            const total = this.groupTiles.length * tileWidth;
            const barX0 = this.toolbarScroll / total * this.width;
            const barX1 = (this.toolbarScroll + this.width) / total * this.width;
            Nri_ImguiDrawRect(barX0, top, barX1, top + 3.0, 0.7, 0.7, 0.75, 1.0);
        }

        // The size slider: "Size N", then its track and knob.
        let hudTop = 6.0;
        if (this.sliderShown()) {
            const sliderTop = this.sliderTop();
            const sliderHeight = this.sliderHeight();
            const sizeLabel = `Size ${formatFixed(this.brushRadius, this.brushRadius < 1.0 ? 1 : 0)}`;
            const x0 = 8.0 + Nri_ImguiCalcTextWidth("Size 30.0") + sliderHeight;
            const x1 = Math.min(this.width - 8.0 - sliderHeight * 0.5, x0 + this.width * 0.6);
            this.slider.place(0.0, x0, x1, sliderTop, sliderHeight);
            this.slider.draw(sizeLabel, (this.brushRadius - MIN_BRUSH) / (MAX_BRUSH - MIN_BRUSH), labelHeight);
            hudTop = sliderTop + sliderHeight + 6.0;
        }
        // The brushes' menu: an icon for each shape, the brush's lit.
        if (this.menuOpen) {
            const half = this.menuIconHalf();
            for (let k = 0; k < SHAPE_NAMES.length; k++) {
                const cx = this.menuIconX(k);
                const cy = this.menuIconY(k);
                const lit = k == this.brushShape;
                Nri_ImguiDrawRect(cx - half, cy - half, cx + half, cy + half, lit ? 0.95 : 0.12, lit ? 0.95 : 0.12, lit ? 0.95 : 0.15, 0.92);
                this.drawShapeIcon(k, cx, cy - labelHeight * 0.35, half * 0.5, lit ? 0.1 : 0.9);
                const name = SHAPE_NAMES[k];
                const shade = lit ? 0.0 : 1.0;
                Nri_ImguiDrawText(cx - Nri_ImguiCalcTextWidth(name) * 0.5, cy + half - labelHeight, name, shade, shade, shade, 1.0, 0);
            }
        }

        // Particles in use, the brush, the view; the cell under the pointer.
        const used = CAPACITY - this.probe[0];
        let y = this.drawWrapped([`${formatFixed(this.frameRate, 0)} fps`, `step ${formatFixed(this.stepMs, 2)} ms`,
            `particles ${used} / ${CAPACITY}`,
            `brush ${formatFixed(this.brushRadius, 0)} ${SHAPE_NAMES[this.brushShape]}`, `view: ${VIEW_NAMES[this.overlay]}`,
            this.zoom > 1.001 ? `zoom ${formatFixed(this.zoom, 1)}x` : "",
            this.paused ? "PAUSED" : ""], hudTop, labelHeight, 1.0);
        const cell = this.probe[3] & 0xFF;
        let contents = materialName(cell);
        if (cell < WALL) {
            contents = "";
            for (let k = 0; k < PARTICLE_TYPES; k++) {
                const n = (this.probe[4 + Math.floor(k / 4)] >> (8 * (k % 4))) & 0xFF;
                if (n > 0) {
                    contents = `${contents}${contents == "" ? "" : ", "}${n} ${materialName(sectionMaterial(k))}`;
                }
            }
            if (contents == "") {
                contents = "air";
            }
            // (probe_cs puts the water's salinity last)
            if ((this.probe[4] & 0xFF) > 0 && this.probeFloats[PROBE_INTS - 1] > 0.01) {
                contents = `${contents} (salinity ${formatFixed(100.0 * this.probeFloats[PROBE_INTS - 1], 0)}%)`;
            }
        }
        const windX = this.probeFloats[PROBE_AIR];
        const windY = this.probeFloats[PROBE_AIR + 1];
        const wind = Math.sqrt(windX * windX + windY * windY);
        y = this.drawWrapped([`${formatFixed(this.probeFloats[1], 1)} C`, `pressure ${formatFixed(this.probeFloats[2], 2)}`, contents,
            wind >= 0.5 ? `wind ${formatFixed(wind, 0)}` : ""], y, labelHeight, 0.85);
        const level = this.level;
        if (level && level.goalCount > 0) {
            const count = this.probe[PROBE_GOAL];
            const progress = level.goalAtMost ? `${count} (at most ${level.goalCount}${level.goalHold > 0.0 ? ` for ${formatFixed(level.goalHold, 0)} s` : ""})`
                : `${Math.min(count, level.goalCount)} / ${level.goalCount}`;
            const time = this.goalReached ? this.goalTime : Math.max(this.levelTime, 0.0);
            let stars = "";
            if (this.goalReached) {
                stars = this.goalStars > 0 ? `done ${starText(this.goalStars)}` : "done";
            } else if (level.stars.length >= 2) {
                stars = `*** in ${formatFixed(level.stars[0], 0)} s, ** in ${formatFixed(level.stars[1], 0)} s`;
            }
            y = this.drawWrapped([`${level.name}: ${level.goalText} ${progress}`, `${formatFixed(time, 1)} s`, stars], y, labelHeight, 1.0);
        }
        if (this.messageTime > 0.0) {
            Nri_ImguiDrawText(8.0, y, this.message, 1.0, 0.9, 0.4, 1.0, 0);
        }
        Nri_ImguiRender(this.sample);
    }

    // A shape's glyph (SHAPE_NAMES' k) at (cx, cy), r in size, in gray: a disc, a square, a
    // diagonal line, a box's outline (rectangles: ImGui's draw list here has only those).
    drawShapeIcon(k: int, cx: number, cy: number, r: number, gray: number) {
        if (k == SHAPE_CIRCLE) {
            const rows = Math.max(Math.floor(r), 4);
            for (let i = -rows; i < rows; i++) {
                const y = (i + 0.5) / rows;
                const w = r * Math.sqrt(Math.max(1.0 - y * y, 0.0));
                Nri_ImguiDrawRect(cx - w, cy + i * r / rows, cx + w, cy + (i + 1) * r / rows, gray, gray, gray, 1.0);
            }
        } else if (k == SHAPE_SQUARE) {
            Nri_ImguiDrawRect(cx - r * 0.85, cy - r * 0.85, cx + r * 0.85, cy + r * 0.85, gray, gray, gray, 1.0);
        } else if (k == SHAPE_LINE) {
            const steps = Math.max(Math.floor(r), 6);
            const t = Math.max(r * 0.12, 2.0);
            for (let i = 0; i <= steps; i++) {
                const f = -1.0 + 2.0 * i / steps;
                Nri_ImguiDrawRect(cx + f * r - t, cy - f * r - t, cx + f * r + t, cy - f * r + t, gray, gray, gray, 1.0);
            }
        } else {
            const t = Math.max(r * 0.14, 2.0);
            Nri_ImguiDrawRect(cx - r, cy - r, cx + r, cy - r + t, gray, gray, gray, 1.0);
            Nri_ImguiDrawRect(cx - r, cy + r - t, cx + r, cy + r, gray, gray, gray, 1.0);
            Nri_ImguiDrawRect(cx - r, cy - r, cx - r + t, cy + r, gray, gray, gray, 1.0);
            Nri_ImguiDrawRect(cx + r - t, cy - r, cx + r, cy + r, gray, gray, gray, 1.0);
        }
    }

    // The HUD's parts (empty ones left out) on a line from y, three spaces apart, wrapped onto
    // more lines where the window is too narrow (a phone held upright); the y under them.
    drawWrapped(parts: string[], y: number, lineHeight: number, gray: number): number {
        const gap = Nri_ImguiCalcTextWidth("   ");
        let x = 8.0;
        for (const part of parts) {
            if (part == "") {
                continue;
            }
            const width = Nri_ImguiCalcTextWidth(part);
            if (x > 8.0 && x + width > this.width - 8.0) {
                x = 8.0;
                y += lineHeight;
            }
            Nri_ImguiDrawText(x, y, part, gray, gray, gray, 1.0, 0);
            x += width + gap;
        }
        return y + lineHeight;
    }
}

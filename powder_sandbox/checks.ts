/// <reference path="../core/nri/nri_interop.d.ts" />
import { formatFixed } from "../core/text_format";
import {
    CAPACITY, DEFAULT_GRID_HEIGHT, STEP_BUDGET_MS, PARTICLE_TYPES, I_GLOW, GLOW_SCALE, I_SPARK,
    ALL_INT_SECTIONS, EVENT_COUNT, EVENT_NAMES, I_SALT, SALT_SCALE, FLOAT_SECTIONS, F_BODY,
    MAX_BODIES, BODY_FLOATS, I_COUNT, PROBE_WIND, PROBE_AIR, PROBE_GOAL, CLINGING_DROPS, WATER, OIL,
    SAND, SMOKE, EMBER, STEAM, ACID, SALT, GUNPOWDER, HONEY, PETROL, WALL, GLASS, WOOD, ICE, STONE,
    METAL, BLOCK, C4, COAL, FUSE, HYDROGEN, OXYGEN, NITRO, PLANT, HEATER, GRAVITY_OFF,
    GRAVITY_POINT, GRAVITY_TILT, GRAVITY_NAMES, ICE_BLOCK, BAR_PROBE, ACID_TUB, SALT_TANK,
    SALT_POUR, GUNPOWDER_PILE, GUNPOWDER_WALL, HONEY_DIVIDER, BEAD, BEAD_SHARE, WIND_SAND,
    WIND_DRIFT, BODY_POOL, TUBS, TUB_TOP, GAS_WOOD, GAS_CEILING, PLUME_WIND, SMOKE_SPREAD,
    GLOW_BESIDE, GLOW_NEAR, GLOW_FAR, BLOBS, BLOB_DRIFT, GATHERED, TILT_FALL, CIRCUITS, WIRE,
    SPARK_WIRE, SPARK_POWDER, CONTROL_POWDER, POWDER_LEFT, ELECTRO_TUBS, ELECTRO_Y, HYDROGEN_MADE,
    OXYGEN_MADE, GAS_LEAK, NEON_TUBES, H2_BOXES, H2_Y, HYDROGEN_LEFT, FUSES, FUSE_SPEED,
    BURN_BLOCKS, BURN_TOP, WOOD_LEFT, COAL_LEFT, PLATES, PLATE_Y, PLATE_LEFT, NITRO_TUBS, NITRO_TOP,
    NITRO_LEFT, C4_BLOCKS, C4_Y, C4_LEFT, CLONE_MORE, HOLE_XS, HOLE_Y, HOLE_W, HOLE_TOUCH,
    SWALLOWED, REPELLED, SPONGE_TUBS, SOAKED, SEED_POOL, SEED_LEDGE, PLANT_CELLS, PLANT_ABOVE,
    SWITCH_ROWS, LAMP_X, DETECTOR_ROWS, HEATERS, HEATED, COLD, countSection, materialName, Level
} from "./defs";
import { SandboxApp } from "./sandbox";

// The sandbox with its -test checks: the U-tube's levels, each test scene's own check, the
// sound events, a level's goal and the regrid's particles; "" if they pass, else what failed.
export class PowderSandbox extends SandboxApp {
    // -test: the U-tube's two sides hold water to the same level (its mean depth in cells over
    // each side's columns, at REST_COUNT particles a cell), and the water went under the divider.
    checkTest(): string {
        const device = this.device;
        const testReadback = this.testReadback;
        if (!device || !testReadback) {
            return "cannot read the grid back";
        }
        device.waitIdle();
        const grid: int[] = [];
        for (let i = 0; i < ALL_INT_SECTIONS * this.stride; i++) {
            grid.push(0);
        }
        if (testReadback.readInts(Ref(grid[0]), grid.length) == 0) {
            return "cannot read the grid back";
        }
        this.logResidual(grid);
        // The frame, read (and saved, with -testOutput) before any check can fail; checked last.
        const frameReadback = this.frameReadback;
        if (!frameReadback) {
            return "cannot read the frame back";
        }
        const pixels: int[] = [];
        for (let i = 0; i < this.width * this.height; i++) {
            pixels.push(0);
        }
        if (frameReadback.readRGBA8(this.rowPitch, this.width, this.height, this.viewFormat, Ref(pixels[0]), pixels.length) == 0) {
            return "cannot read the frame back";
        }

        const divider: int = Math.floor(this.gridW / 2);
        let left = 0;
        let right = 0;
        for (let y = 1; y < this.gridH - 1; y++) {
            for (let x = 1; x < this.gridW - 1; x++) {
                const n = grid[I_COUNT * this.stride + y * this.gridW + x];
                if (x < divider) {
                    left += n;
                } else if (x > divider) {
                    right += n;
                }
            }
        }
        if (this.scene == 3) {
            const error = this.checkLavaAndIce();
            if (error != "") {
                return error;
            }
        }
        if (this.scene == 4) {
            const error = this.checkMaterials(grid);
            if (error != "") {
                return error;
            }
        }
        if (this.scene == 5) {
            const error = this.checkGunpowder(grid);
            if (error != "") {
                return error;
            }
        }
        if (this.scene == 6) {
            const error = this.checkViscosity(grid);
            if (error != "") {
                return error;
            }
        }
        if (this.scene == 7) {
            const error = this.checkBead(grid);
            if (error != "") {
                return error;
            }
        }
        if (this.scene == 8) {
            const error = this.checkWind(grid);
            if (error != "") {
                return error;
            }
        }
        if (this.scene == 9) {
            const error = this.checkBodies(grid);
            if (error != "") {
                return error;
            }
        }
        if (this.scene == 10 || this.scene == 11) {
            const error = this.checkChemistry(grid);
            if (error != "") {
                return error;
            }
        }
        if (this.scene == 12) {
            const error = this.checkGases(grid);
            if (error != "") {
                return error;
            }
        }
        if (this.scene == 13) {
            const error = this.checkGravity(grid);
            if (error != "") {
                return error;
            }
        }
        if (this.scene == 14) {
            const error = this.checkCircuits(grid);
            if (error != "") {
                return error;
            }
        }
        if (this.scene >= 15 && this.scene <= 20) {
            const error = this.checkChemistryA(grid);
            if (error != "") {
                return error;
            }
        }
        if (this.scene >= 21 && this.scene <= 24) {
            const error = this.checkToolsB(grid);
            if (error != "") {
                return error;
            }
        }
        if (this.profile && this.profileReports == 0) {
            return "-profile reported nothing";
        }
        if (this.stepBudget != STEP_BUDGET_MS && Math.min(this.gridW, this.gridH) >= DEFAULT_GRID_HEIGHT) {
            return `the grid wasn't made smaller for a step budget of ${formatFixed(this.stepBudget, 2)} ms`;
        }
        let eventLog = "";
        for (let k = 0; k < EVENT_COUNT; k++) {
            eventLog = `${eventLog}${k > 0 ? ", " : ""}${EVENT_NAMES[k]} ${this.eventTotals[k]}`;
        }
        console.log(`Sound events: ${eventLog}`);
        // (the showcase's falling water and burning wood; the acid eating wood; the gunpowder.
        // Pushed, not a ternary of array literals: that crashed tslang's code at run time)
        const expected: int[] = [];
        if (this.scene == 2) {
            expected.push(0);
            expected.push(2);
        } else if (this.scene == 4) {
            expected.push(1);
        } else if (this.scene == 5) {
            expected.push(2);
            expected.push(3);
        } else if (this.scene == 10) {
            expected.push(1);
        } else if (this.scene == 11) {
            expected.push(2);
            expected.push(3);
        } else if (this.scene == 12) {
            expected.push(2);
        } else if (this.scene == 14 || this.scene == 18 || this.scene == 19) {
            expected.push(3);
        } else if (this.scene == 15) {
            expected.push(1);
        } else if (this.scene == 16 || this.scene == 17 || this.scene == 20) {
            expected.push(2);
        } else if (this.scene == 21) {
            expected.push(0);
        }
        for (const k of expected) {
            if (this.eventTotals[k] == 0) {
                return `no ${EVENT_NAMES[k]} events`;
            }
        }
        const level = this.level;
        if (this.sceneFile != "" && !level) {
            return `the level ${this.sceneFile} didn't load`;
        }
        if (level && level.goalCount > 0) {
            const count = this.probe[PROBE_GOAL];
            console.log(`Level: ${level.name}, ${level.goalText} ${count} of ${level.goalCount}${this.goalReached
                ? `, reached in ${formatFixed(this.goalTime, 2)} s (${this.goalStars} stars)` : ", not reached"}`);
            if (this.testStars == 0) {
                if (this.goalReached) {
                    return `the goal was reached unsolved, in ${formatFixed(this.goalTime, 2)} s`;
                }
            } else {
                if (!this.goalReached) {
                    return `the level's goal wasn't reached: ${count} of ${level.goalCount}`;
                }
                if (this.solveTime >= 0.0 && this.goalTime < this.solveTime) {
                    return `the goal was reached before the solution, in ${formatFixed(this.goalTime, 2)} s`;
                }
                if (this.testStars > 0 && this.goalStars != this.testStars) {
                    return `${this.goalStars} stars, not ${this.testStars}`;
                }
            }
        }
        if (this.regrid != 0) {
            const error = this.checkRegrid(grid);
            if (error != "") {
                return error;
            }
        }
        if (this.scene == 1) {
            const leftLevel = this.surfaceLevel(grid, 4, divider - 4);
            const rightLevel = this.surfaceLevel(grid, divider + 4, this.gridW - 5);
            console.log(`U-tube: left level ${formatFixed(leftLevel, 2)} cells (${left} particles), right ${formatFixed(rightLevel, 2)} cells (${right})`);
            if (rightLevel < 10.0) {
                return `the water didn't go under the divider: the right side's level is ${formatFixed(rightLevel, 2)} cells`;
            }
            if (Math.abs(leftLevel - rightLevel) > 1.5) {
                return `the levels differ by ${formatFixed(Math.abs(leftLevel - rightLevel), 2)} cells, more than 1.5`;
            }
        }


        // The frame: water drawn, blue, over about the bottom 40% of the grid in the U-tube; some
        // in the other scenes.
        let blue = 0;
        for (let i = 0; i < pixels.length; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (b > 150 && r < 80) {
                blue++;
            }
        }
        // (of the grid as drawn: a turned test scene's is a band across an upright phone)
        const gridPixels = Math.min(this.gridW * this.gridH * this.panZoom.scale * this.panZoom.scale, pixels.length);
        const share = 100.0 * blue / gridPixels;
        console.log(`Water: ${formatFixed(share, 1)}% of the grid`);
        // (a turned U-tube is a narrow grid between margins; scenes 8, 11 and 12 have no water, nor
        // need a level)
        const minShare = this.scene == 1 && this.regrid != 2 ? 20.0 : (this.scene == 8 || this.scene == 11 || this.scene == 12 || this.scene >= 16
            || this.sceneFile != "" ? 0.0 : 1.0);
        // (the overlays recolor it; zoomed in, only part of the grid shows)
        if (this.overlay == 0 && this.panZoom.zoom <= 1.001 && (share < minShare || share > 50.0)) {
            return `water covers ${formatFixed(share, 1)}% of the grid, not ${formatFixed(minShare, 0)} to 50%`;
        }
        return "";
    }

    // Scene 3: the lava that fell into the water set to stone, and the ice block melted (some of
    // it, at least: the cells painted ice minus those still ice).
    checkLavaAndIce(): string {
        const cellsReadback = this.cellsReadback;
        if (!cellsReadback) {
            return "cannot read the cells back";
        }
        const cells: int[] = [];
        for (let i = 0; i < this.gridW * this.gridH; i++) {
            cells.push(0);
        }
        if (cellsReadback.readInts(Ref(cells[0]), cells.length) == 0) {
            return "cannot read the cells back";
        }
        let stone = 0;
        let ice = 0;
        let wood = 0;
        let painted = 0;
        for (let y = 0; y < this.gridH; y++) {
            for (let x = 0; x < this.gridW; x++) {
                const m = cells[y * this.gridW + x] & 0xFF;
                if (m == STONE) {
                    stone++;
                } else if (m == ICE) {
                    ice++;
                } else if (m == WOOD) {
                    wood++;
                }
                // (spawn_cs paints the cells whose centers are inside the stroke)
                const cx = (x + 0.5) / this.gridW;
                const cy = (y + 0.5) / this.gridH;
                if (cx >= ICE_BLOCK[0] && cx <= ICE_BLOCK[2] && cy >= ICE_BLOCK[1] && cy <= ICE_BLOCK[3]) {
                    painted++;
                }
            }
        }
        console.log(`Lava and ice: ${stone} stone cells, ${ice} of ${painted} ice cells left, ${wood} wood cells`);
        if (stone == 0) {
            return "no lava set to stone";
        }
        if (ice >= painted) {
            return `the ice didn't melt: ${ice} ice cells, ${painted} painted`;
        }
        return "";
    }

    // -test: how far the last step's pressure is from solving its equation (pressure_cs's), over
    // the fluid cells: the largest and the mean residual, against the largest divergence.
    logResidual(grid: int[]) {
        const floatReadback = this.floatReadback;
        const cellsReadback = this.cellsReadback;
        if (!floatReadback || !cellsReadback) {
            return;
        }
        const floats: f32[] = [];
        for (let i = 0; i < FLOAT_SECTIONS * this.stride; i++) {
            floats.push(0.0);
        }
        const cells: int[] = [];
        for (let i = 0; i < this.gridW * this.gridH; i++) {
            cells.push(0);
        }
        if (floatReadback.readFloats(Ref(floats[0]), floats.length) == 0
            || cellsReadback.readInts(Ref(cells[0]), cells.length) == 0) {
            return;
        }
        const w = this.gridW;
        const h = this.gridH;
        const s = this.stride;
        let maxResidual = 0.0;
        let sumResidual = 0.0;
        let maxDiv = 0.0;
        let fluidCells = 0;
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                if (!this.fluidAt(grid, cells, x, y)) {
                    continue;
                }
                let diag = 0.0;
                let sum = 0.0;
                // (u faces' pitch w + 1, v faces' w; F_UA is section 4, F_VA 5, F_P 6, F_DIV 7)
                const nx = [x + 1, x - 1, x, x];
                const ny = [y, y, y + 1, y - 1];
                const faces = [4 * s + y * (w + 1) + x + 1, 4 * s + y * (w + 1) + x, 5 * s + (y + 1) * w + x, 5 * s + y * w + x];
                for (let k = 0; k < 4; k++) {
                    if ((cells[ny[k] * w + nx[k]] & 0xFF) >= WALL) {
                        continue;
                    }
                    const a = floats[faces[k]];
                    diag += a;
                    sum += a * floats[6 * s + ny[k] * w + nx[k]];
                }
                const div = floats[7 * s + y * w + x];
                const residual = Math.abs(diag * floats[6 * s + y * w + x] - sum + div);
                maxResidual = Math.max(maxResidual, residual);
                sumResidual += residual;
                maxDiv = Math.max(maxDiv, Math.abs(div));
                fluidCells++;
            }
        }
        console.log(`Pressure residual: max ${formatFixed(maxResidual, 5)}, mean ${formatFixed(sumResidual / Math.max(fluidCells, 1), 6)} (largest divergence ${formatFixed(maxDiv, 3)}, ${fluidCells} fluid cells)`);
    }

    // A fluid cell as divergence_cs saw it: not solid, with FLIP particles in it.
    fluidAt(grid: int[], cells: int[], x: int, y: int): boolean {
        const c = y * this.gridW + x;
        if ((cells[c] & 0xFF) >= WALL) {
            return false;
        }
        let n = 0;
        // WATER, OIL, SAND (counts 0 .. 2), LAVA (7), ACID (8), SALT (9), GUNPOWDER (10), HONEY (11) and
        // PETROL (12)
        for (const k of [0, 1, 2, 7, 8, 9, 10, 11, 12]) {
            n += grid[(I_COUNT + k) * this.stride + c];
        }
        return n > 0;
    }

    // -regrid: the grid has its wall all around and no particles in a solid cell; remade taller and
    // back, it kept every particle (the U-tube's water doesn't boil or burn); turned upright, it lost
    // some (the sides cropped) but not all; turned on its side, at most CLINGING_DROPS (only air
    // above the water, but for drops clinging under the ceiling).
    checkRegrid(grid: int[]): string {
        const cellsReadback = this.cellsReadback;
        if (!cellsReadback) {
            return "cannot read the cells back";
        }
        const cells: int[] = [];
        for (let i = 0; i < this.gridW * this.gridH; i++) {
            cells.push(0);
        }
        if (cellsReadback.readInts(Ref(cells[0]), cells.length) == 0) {
            return "cannot read the cells back";
        }
        let inSolid = 0;
        for (let y = 0; y < this.gridH; y++) {
            for (let x = 0; x < this.gridW; x++) {
                const m = cells[y * this.gridW + x] & 0xFF;
                const border = x == 0 || y == 0 || x == this.gridW - 1 || y == this.gridH - 1;
                if (border && m != WALL) {
                    return `the cell (${x}, ${y}) on the grid's edge isn't wall but ${materialName(m)}`;
                }
                if (m >= WALL) {
                    for (let k = 0; k < PARTICLE_TYPES; k++) {
                        inSolid += grid[(I_COUNT + k) * this.stride + y * this.gridW + x];
                    }
                }
            }
        }
        const used = CAPACITY - this.probe[0];
        console.log(`Regrid: ${this.gridW} x ${this.gridH} cells, particles ${this.regridCount} before, ${used} after, ${inSolid} in solid cells`);
        if (inSolid > 0) {
            return `${inSolid} particles in solid cells`;
        }
        if (this.regrid == 1 && used != this.regridCount) {
            return `the grid remade taller and back kept ${used} of ${this.regridCount} particles`;
        }
        // (turned upright, the sides are cropped; turned on its side, the top, the water under it
        // but for a drop or two the first surge left clinging under the ceiling: on the S23's
        // upright grid, 2 particles in its top corner)
        const croppedSides = this.gridW < this.gridH;
        const lost = this.regridCount - used;
        if (this.regrid == 2 && (croppedSides ? used == 0 || lost <= 0 : lost < 0 || lost > CLINGING_DROPS)) {
            return `the turned grid kept ${used} of ${this.regridCount} particles`;
        }
        return "";
    }

    // A particle type's count in a tub of TUBS (k), and its cells' mean temperature (where there's
    // liquid, from floats' F_TCELL) into this.tubTemp.
    tubCount(grid: int[], floats: f32[], k: int, material: int): int {
        const w = this.gridW;
        const h = this.gridH;
        const x0: int = Math.floor(TUBS[2 * k] * w) + 1;
        const x1: int = Math.floor(TUBS[2 * k + 1] * w);
        const y0: int = Math.floor(TUB_TOP * h);
        let n = 0;
        let tempSum = 0.0;
        let liquidCells = 0;
        for (let y = y0; y < h - 1; y++) {
            for (let x = x0; x < x1; x++) {
                const c = y * w + x;
                n += grid[countSection(material) * this.stride + c];
                if (grid[countSection(WATER) * this.stride + c] > 0) {
                    tempSum += floats[10 * this.stride + c];
                    liquidCells++;
                }
            }
        }
        this.tubTemp = liquidCells > 0 ? tempSum / liquidCells : 0.0;
        return n;
    }

    // Scene 10: the water diluted its acid (under half what the other tub holds) and was warmed by
    // it; scene 11: the petrol burned away (under a tenth of the sealed oil), the open oil burned
    // but slowly (between a third and 95% of the sealed oil). Without the reactions, each tub keeps
    // what was poured.
    checkChemistry(grid: int[]): string {
        const floatReadback = this.floatReadback;
        if (!floatReadback) {
            return "cannot read the grid back";
        }
        const floats: f32[] = [];
        for (let i = 0; i < FLOAT_SECTIONS * this.stride; i++) {
            floats.push(0.0);
        }
        if (floatReadback.readFloats(Ref(floats[0]), floats.length) == 0) {
            return "cannot read the grid back";
        }
        if (this.scene == 10) {
            const diluted = this.tubCount(grid, floats, 0, ACID);
            const waterTemp = this.tubTemp;
            const kept = this.tubCount(grid, floats, 1, ACID);
            console.log(`Chemistry: acid ${diluted} over water (the water at ${formatFixed(waterTemp, 1)} C), ${kept} alone`);
            if (kept == 0 || diluted >= 0.5 * kept) {
                return `the water didn't dilute the acid: ${diluted} left of the ${kept} alone`;
            }
            if (waterTemp < 23.0) {
                return `the acid didn't warm the water: ${formatFixed(waterTemp, 1)} C`;
            }
            return "";
        }
        const oil = this.tubCount(grid, floats, 0, OIL);
        const petrol = this.tubCount(grid, floats, 1, PETROL);
        const sealed = this.tubCount(grid, floats, 2, OIL);
        console.log(`Chemistry: oil ${oil} lit, petrol ${petrol} lit, oil ${sealed} sealed`);
        if (sealed == 0 || petrol >= 0.1 * sealed) {
            return `the petrol didn't burn away: ${petrol} left (the sealed oil ${sealed})`;
        }
        if (oil >= 0.95 * sealed || oil < sealed / 3) {
            return `the oil didn't burn slowly: ${oil} left of the sealed oil's ${sealed}`;
        }
        return "";
    }

    // Scene 12: the plume drove the air up through the probe; the smoke spread under the ceiling
    // (the columns with smoke in the cells just under it span SMOKE_SPREAD of the width).
    checkGases(grid: int[]): string {
        const w = this.gridW;
        const h = this.gridH;
        const windY = this.probeFloats[PROBE_AIR + 1];
        const y0: int = Math.floor(GAS_CEILING[1] * h) + 2;
        let left = w;
        let right = -1;
        let smoke = 0;
        for (let y = y0; y < y0 + 6; y++) {
            for (let x = 0; x < w; x++) {
                const n = grid[countSection(SMOKE) * this.stride + y * w + x];
                if (n > 0) {
                    smoke += n;
                    left = Math.min(left, x);
                    right = Math.max(right, x);
                }
            }
        }
        const spread = right >= left ? (right - left + 1) / w : 0.0;
        console.log(`Gases: the air ${formatFixed(-windY, 1)} cells a second up above the fire; ${smoke} smoke under the ceiling, over ${formatFixed(100.0 * spread, 0)}% of the width`);
        // The glow's red, beside the wood (a little above its top) and at the grid's side.
        const glowY: int = Math.floor(GAS_WOOD[1] * h) + 2;
        const nearX: int = Math.floor(GAS_WOOD[2] * w) + GLOW_BESIDE;
        const near = grid[I_GLOW * this.stride + glowY * w + nearX] / GLOW_SCALE;
        const far = grid[I_GLOW * this.stride + glowY * w + 1] / GLOW_SCALE;
        let embers = 0;
        for (let i = 0; i < w * h; i++) {
            embers += grid[countSection(EMBER) * this.stride + i];
        }
        console.log(`Glow: ${formatFixed(near, 3)} beside the fire, ${formatFixed(far, 4)} at the side; ${embers} embers`);
        if (near < GLOW_NEAR || far > GLOW_FAR) {
            return `the fire's glow: ${formatFixed(near, 3)} beside it (under ${formatFixed(GLOW_NEAR, 2)}?), ${formatFixed(far, 4)} at the side (over ${formatFixed(GLOW_FAR, 3)}?)`;
        }
        if (embers == 0) {
            return "the fire threw no embers";
        }
        if (-windY < PLUME_WIND) {
            return `the plume didn't drive the air: ${formatFixed(-windY, 1)} cells a second up, under ${formatFixed(PLUME_WIND, 0)}`;
        }
        if (spread < SMOKE_SPREAD) {
            return `the smoke didn't spread under the ceiling: over ${formatFixed(100.0 * spread, 0)}% of the width`;
        }
        return "";
    }


    // Scene 14: the lamps the battery reached shone (the bare wire's, the salt water's), the
    // fresh water's didn't; the gunpowder on the live wire went off, the ledge's didn't.
    checkCircuits(grid: int[]): string {
        const w = this.gridW;
        const h = this.gridH;
        const lit: int[] = [];
        for (let k = 0; k < 3; k++) {
            const x0: int = Math.floor(CIRCUITS[5 * k + 1] * w);
            const y0: int = Math.floor(CIRCUITS[5 * k + 2] * h);
            let light = 0;
            for (let y = y0; y < y0 + Math.floor(WIRE * h); y++) {
                for (let x = x0; x < x0 + Math.floor(0.04 * w); x++) {
                    light = Math.max(light, (grid[I_SPARK * this.stride + y * w + x] >> 8) & 0xFF);
                }
            }
            lit.push(light);
        }
        const wired = this.countIn(grid, GUNPOWDER, SPARK_POWDER[0] - 0.05, 0.0, SPARK_POWDER[2] + 0.05, SPARK_WIRE[2] + WIRE);
        const control = this.countIn(grid, GUNPOWDER, CONTROL_POWDER[0] - 0.03, 0.0, CONTROL_POWDER[2] + 0.03, CONTROL_POWDER[4] + WIRE);
        console.log(`Circuits: the lamps' light ${lit[0]}, ${lit[1]} (salt water), ${lit[2]} (fresh water); gunpowder on the live wire ${wired}, on the ledge ${control}`);
        if (lit[0] == 0 || lit[1] == 0) {
            return `a lamp the battery reaches didn't shine: ${lit[0]} (the bare wire), ${lit[1]} (through salt water)`;
        }
        if (lit[2] != 0) {
            return "the lamp beyond fresh water shone";
        }
        if (control == 0 || wired > POWDER_LEFT * control) {
            return `the gunpowder on the live wire didn't go off: ${wired} left (the ledge's ${control})`;
        }
        return "";
    }


    // The cells, read back (empty if they can't be).
    readCells(): int[] {
        const cells: int[] = [];
        const cellsReadback = this.cellsReadback;
        if (!cellsReadback) {
            return cells;
        }
        for (let i = 0; i < this.gridW * this.gridH; i++) {
            cells.push(0);
        }
        if (cellsReadback.readInts(Ref(cells[0]), cells.length) == 0) {
            return [];
        }
        return cells;
    }

    // The cells of a material in the box (in fractions of the grid); with burning, those alight.
    cellsIn(cells: int[], material: int, x0: number, y0: number, x1: number, y1: number, burning: boolean): int {
        const w = this.gridW;
        const h = this.gridH;
        let n = 0;
        for (let y = Math.max(Math.floor(y0 * h), 0); y < Math.min(Math.ceil(y1 * h), h); y++) {
            for (let x = Math.max(Math.floor(x0 * w), 0); x < Math.min(Math.ceil(x1 * w), w); x++) {
                const cell = cells[y * w + x];
                if ((cell & 0xFF) == material && (!burning || (cell & 0x10000) != 0)) {
                    n++;
                }
            }
        }
        return n;
    }

    // The brightest light (spark_cs's) in the box (in fractions of the grid).
    lightIn(grid: int[], x0: number, y0: number, x1: number, y1: number): int {
        const w = this.gridW;
        const h = this.gridH;
        let light = 0;
        for (let y = Math.max(Math.floor(y0 * h), 0); y < Math.min(Math.ceil(y1 * h), h); y++) {
            for (let x = Math.max(Math.floor(x0 * w), 0); x < Math.min(Math.ceil(x1 * w), w); x++) {
                light = Math.max(light, (grid[I_SPARK * this.stride + y * w + x] >> 8) & 0xFF);
            }
        }
        return light;
    }

    // The cells' temperatures (floats' F_TCELL), read back (empty if they can't be).
    readTemperatures(): f32[] {
        const temps: f32[] = [];
        const floatReadback = this.floatReadback;
        if (!floatReadback) {
            return temps;
        }
        const floats: f32[] = [];
        for (let i = 0; i < FLOAT_SECTIONS * this.stride; i++) {
            floats.push(0.0);
        }
        if (floatReadback.readFloats(Ref(floats[0]), floats.length) == 0) {
            return temps;
        }
        for (let i = 0; i < this.gridW * this.gridH; i++) {
            temps.push(floats[10 * this.stride + i]);
        }
        return temps;
    }

    // The hottest cell of a material in the box (in fractions of the grid); -1000 with none.
    hottestIn(cells: int[], temps: f32[], material: int, x0: number, y0: number, x1: number, y1: number): number {
        const w = this.gridW;
        const h = this.gridH;
        let hottest = -1000.0;
        for (let y = Math.max(Math.floor(y0 * h), 0); y < Math.min(Math.ceil(y1 * h), h); y++) {
            for (let x = Math.max(Math.floor(x0 * w), 0); x < Math.min(Math.ceil(x1 * w), w); x++) {
                if ((cells[y * w + x] & 0xFF) == material) {
                    hottest = Math.max(hottest, temps[y * w + x]);
                }
            }
        }
        return hottest;
    }

    // Scenes 21 to 24: group B's tools (see their constants).
    checkToolsB(grid: int[]): string {
        const cells = this.readCells();
        if (cells.length == 0) {
            return "cannot read the cells back";
        }
        if (this.scene == 21) {
            const cloned = this.countIn(grid, WATER, 0.0, 0.0, 0.5, 1.0);
            const plain = this.countIn(grid, WATER, 0.5, 0.0, 1.0, 1.0);
            console.log(`Clone: water ${cloned} on the clone's side, ${plain} on the wall's`);
            if (plain == 0 || cloned < CLONE_MORE * plain) {
                return `the clone didn't make more of the water: ${cloned} (the wall's side ${plain})`;
            }
        } else if (this.scene == 22) {
            const swallowed = this.countIn(grid, SAND, HOLE_XS[0] - 0.15, 0.0, HOLE_XS[0] + HOLE_W + 0.15, 1.0);
            const kept = this.countIn(grid, SAND, HOLE_XS[2] - 0.15, 0.0, HOLE_XS[2] + HOLE_W + 0.15, 1.0);
            const onWhite = this.countIn(grid, SAND, HOLE_XS[1] - 0.005, HOLE_Y[0] - HOLE_TOUCH, HOLE_XS[1] + HOLE_W + 0.005, HOLE_Y[0]);
            const onWall = this.countIn(grid, SAND, HOLE_XS[2] - 0.005, HOLE_Y[0] - HOLE_TOUCH, HOLE_XS[2] + HOLE_W + 0.005, HOLE_Y[0]);
            console.log(`Holes: sand ${swallowed} by the black hole, ${kept} by the wall; resting on the white hole ${onWhite}, on the wall ${onWall}`);
            if (kept == 0 || swallowed > SWALLOWED * kept) {
                return `the black hole didn't swallow the sand: ${swallowed} left (the wall's ${kept})`;
            }
            if (onWall == 0 || onWhite > REPELLED * onWall) {
                return `the white hole didn't push the sand away: ${onWhite} on it (on the wall ${onWall})`;
            }
        } else if (this.scene == 23) {
            const soaked = this.countIn(grid, WATER, SPONGE_TUBS[0], 0.0, SPONGE_TUBS[1], 1.0);
            const full = this.countIn(grid, WATER, SPONGE_TUBS[2], 0.0, SPONGE_TUBS[3], 1.0);
            const plants = this.cellsIn(cells, PLANT, SEED_POOL[0], 0.5, SEED_POOL[1], 1.0, false);
            const above = this.cellsIn(cells, PLANT, SEED_POOL[0], 0.5, SEED_POOL[1], SEED_POOL[3] - 0.03, false);
            const dry = this.cellsIn(cells, PLANT, SEED_LEDGE[0], 0.0, SEED_LEDGE[1], SEED_LEDGE[2] + 0.02, false);
            console.log(`Sponge and seeds: water ${soaked} in the sponge's tub, ${full} in the other; ${plants} plant cells from the wet seeds (${above} above the water), ${dry} from the dry`);
            if (full == 0 || soaked > SOAKED * full) {
                return `the sponge didn't soak up the water: ${soaked} left (the other tub ${full})`;
            }
            if (plants < PLANT_CELLS || above < PLANT_ABOVE || dry != 0) {
                return `the seeds: ${plants} plant cells from the wet ones (${above} above the water), ${dry} from the dry`;
            }
        } else if (this.scene == 24) {
            const temps = this.readTemperatures();
            if (temps.length == 0) {
                return "cannot read the grid back";
            }
            const lamps: int[] = [];
            for (let k = 0; k < 4; k++) {
                const y = k < 2 ? SWITCH_ROWS[k] : DETECTOR_ROWS[k - 2];
                lamps.push(this.lightIn(grid, LAMP_X, y, LAMP_X + 0.04, y + WIRE));
            }
            const warm = this.hottestIn(cells, temps, HEATER, HEATERS[0], HEATERS[2], HEATERS[1], HEATERS[3]);
            const cold = this.hottestIn(cells, temps, HEATER, HEATERS[0], HEATERS[4], HEATERS[1], HEATERS[5]);
            console.log(`Switches and detectors: lamps ${lamps[0]} (switched on), ${lamps[1]} (off), ${lamps[2]} (sand on the detector), ${lamps[3]} (none); heaters ${formatFixed(warm, 0)} C powered, ${formatFixed(cold, 0)} C not`);
            if (lamps[0] == 0 || lamps[1] != 0) {
                return `the switches: lamps ${lamps[0]} (on), ${lamps[1]} (off)`;
            }
            if (lamps[2] == 0 || lamps[3] != 0) {
                return `the detectors: lamps ${lamps[2]} (sand on it), ${lamps[3]} (none)`;
            }
            if (warm < HEATED || cold > COLD) {
                return `the heaters: ${formatFixed(warm, 0)} C powered, ${formatFixed(cold, 0)} C not`;
            }
        }
        return "";
    }

    // Scenes 15 to 20: group A's chemistry (see their constants).
    checkChemistryA(grid: int[]): string {
        const cells = this.readCells();
        if (cells.length == 0) {
            return "cannot read the cells back";
        }
        if (this.scene == 15) {
            const madeH = this.countIn(grid, HYDROGEN, ELECTRO_TUBS[0] - 0.05, 0.0, ELECTRO_TUBS[1] + 0.05, ELECTRO_Y[1]);
            const madeO = this.countIn(grid, OXYGEN, ELECTRO_TUBS[0] - 0.05, 0.0, ELECTRO_TUBS[1] + 0.05, ELECTRO_Y[1]);
            const leakH = this.countIn(grid, HYDROGEN, ELECTRO_TUBS[2] - 0.05, 0.0, ELECTRO_TUBS[3] + 0.05, ELECTRO_Y[1]);
            const leakO = this.countIn(grid, OXYGEN, ELECTRO_TUBS[2] - 0.05, 0.0, ELECTRO_TUBS[3] + 0.05, ELECTRO_Y[1]);
            const lit = this.lightIn(grid, NEON_TUBES[0], NEON_TUBES[2], NEON_TUBES[1], NEON_TUBES[3]);
            const dark = this.lightIn(grid, NEON_TUBES[0], NEON_TUBES[4], NEON_TUBES[1], NEON_TUBES[5]);
            console.log(`Electrolysis: ${madeH} hydrogen and ${madeO} oxygen from the wired tub, ${leakH} and ${leakO} by the other; neon's light ${lit} wired, ${dark} not`);
            if (madeH < HYDROGEN_MADE || madeO < OXYGEN_MADE) {
                return `the current didn't split the water: ${madeH} hydrogen, ${madeO} oxygen`;
            }
            if (leakH + leakO > GAS_LEAK * (madeH + madeO)) {
                return `the unwired tub made gas too: ${leakH} hydrogen, ${leakO} oxygen`;
            }
            if (lit == 0 || dark != 0) {
                return `the neon: light ${lit} wired, ${dark} not`;
            }
        } else if (this.scene == 16) {
            const burned = this.countIn(grid, HYDROGEN, H2_BOXES[0], H2_Y[0], H2_BOXES[1], H2_Y[1]);
            const kept = this.countIn(grid, HYDROGEN, H2_BOXES[2], H2_Y[0], H2_BOXES[3], H2_Y[1]);
            const steam = this.countIn(grid, STEAM, H2_BOXES[0], H2_Y[0], H2_BOXES[1], H2_Y[1]);
            const fuseCells = this.cellsIn(cells, FUSE, FUSES[0], FUSES[2], FUSES[1], FUSES[2] + 0.02, false);
            const unlitCells = this.cellsIn(cells, FUSE, FUSES[0], FUSES[3], FUSES[1], FUSES[3] + 0.02, false);
            const rows = Math.max(Math.round(0.02 * this.gridH), 1);
            const speed = (unlitCells - fuseCells) / rows / (this.testFrames / 60.0);
            console.log(`Combustion: hydrogen ${burned} left lit, ${kept} not (${steam} steam); the fuse burned at ${formatFixed(speed, 1)} cells a second (${unlitCells} cells unlit, ${fuseCells} left lit)`);
            if (kept == 0 || burned > HYDROGEN_LEFT * kept || steam == 0) {
                return `the hydrogen didn't burn into steam: ${burned} left (the unlit box's ${kept}), ${steam} steam`;
            }
            if (speed < FUSE_SPEED[0] || speed > FUSE_SPEED[1]) {
                return `the fuse burned at ${formatFixed(speed, 1)} cells a second, not ${formatFixed(FUSE_SPEED[0], 0)} to ${formatFixed(FUSE_SPEED[1], 0)}`;
            }
        } else if (this.scene == 20) {
            const coal = this.cellsIn(cells, COAL, BURN_BLOCKS[0], BURN_TOP, BURN_BLOCKS[1], 1.0, false);
            const coalLit = this.cellsIn(cells, COAL, BURN_BLOCKS[0], BURN_TOP, BURN_BLOCKS[1], 1.0, true);
            const wood = this.cellsIn(cells, WOOD, BURN_BLOCKS[2], BURN_TOP, BURN_BLOCKS[3], 1.0, false);
            // (the blocks' cells as painted: their boxes', less the grid's wall row at the floor)
            const painted = (Math.ceil(BURN_BLOCKS[1] * this.gridW) - Math.floor(BURN_BLOCKS[0] * this.gridW))
                * (this.gridH - 1 - Math.floor(BURN_TOP * this.gridH));
            console.log(`Coal and wood: coal ${coal} of ${painted} left (${coalLit} alight), wood ${wood}`);
            if (wood > WOOD_LEFT * painted || coal < COAL_LEFT * painted || coalLit == 0) {
                return `coal and wood: coal ${coal} of ${painted} left (${coalLit} alight), wood ${wood}`;
            }
        } else if (this.scene == 17) {
            const holed = this.cellsIn(cells, METAL, PLATES[0], PLATE_Y[0], PLATES[1], PLATE_Y[1], false);
            const whole = this.cellsIn(cells, METAL, PLATES[2], PLATE_Y[0], PLATES[3], PLATE_Y[1], false);
            console.log(`Thermite: the lit plate's metal ${holed}, the other's ${whole}`);
            if (whole == 0 || holed > PLATE_LEFT * whole) {
                return `the thermite didn't burn through its plate: ${holed} cells of metal left (the other's ${whole})`;
            }
        } else if (this.scene == 18) {
            const dropped = this.countIn(grid, NITRO, NITRO_TUBS[0] - 0.05, 0.0, NITRO_TUBS[1] + 0.05, 1.0);
            const resting = this.countIn(grid, NITRO, NITRO_TUBS[2], NITRO_TOP, NITRO_TUBS[3], 1.0);
            console.log(`Nitroglycerin: ${dropped} left of the dropped, ${resting} at rest`);
            if (resting == 0 || dropped > NITRO_LEFT * resting) {
                return `the dropped nitroglycerin didn't go off: ${dropped} left (${resting} at rest)`;
            }
        } else if (this.scene == 19) {
            const wired = this.cellsIn(cells, C4, C4_BLOCKS[0], C4_Y[0], C4_BLOCKS[1], C4_Y[1], false);
            const unwired = this.cellsIn(cells, C4, C4_BLOCKS[2], C4_Y[0], C4_BLOCKS[3], C4_Y[1], false);
            console.log(`C-4: ${wired} cells left wired, ${unwired} not`);
            if (unwired == 0 || wired > C4_LEFT * unwired) {
                return `the wired C-4 didn't go off: ${wired} cells left (${unwired} not wired)`;
            }
        }
        return "";
    }

    // A material's particles in the box (in fractions of the grid).
    countIn(grid: int[], material: int, x0: number, y0: number, x1: number, y1: number): int {
        const w = this.gridW;
        const h = this.gridH;
        let n = 0;
        for (let y = Math.max(Math.floor(y0 * h), 0); y < Math.min(Math.ceil(y1 * h), h); y++) {
            for (let x = Math.max(Math.floor(x0 * w), 0); x < Math.min(Math.ceil(x1 * w), w); x++) {
                n += grid[countSection(material) * this.stride + y * w + x];
            }
        }
        return n;
    }

    // Scene 13: with no gravity the blobs stayed put; toward the point they gathered round it.
    checkGravity(grid: int[]): string {
        const w = this.gridW;
        const h = this.gridH;
        const px = this.gravityPointX();
        const py = this.gravityPointY();
        for (let k = 0; k < 2; k++) {
            const material = k == 0 ? WATER : SAND;
            const startX = 0.5 * (BLOBS[4 * k] + BLOBS[4 * k + 2]) * w;
            const startY = 0.5 * (BLOBS[4 * k + 1] + BLOBS[4 * k + 3]) * h;
            let n = 0;
            let sumX = 0.0;
            let sumY = 0.0;
            let sumDistance = 0.0;
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const count = grid[countSection(material) * this.stride + y * w + x];
                    if (count > 0) {
                        n += count;
                        sumX += count * (x + 0.5);
                        sumY += count * (y + 0.5);
                        sumDistance += count * Math.sqrt((x + 0.5 - px) * (x + 0.5 - px) + (y + 0.5 - py) * (y + 0.5 - py));
                    }
                }
            }
            if (n == 0) {
                return `no ${materialName(material)} left`;
            }
            const drift = Math.sqrt((sumX / n - startX) * (sumX / n - startX) + (sumY / n - startY) * (sumY / n - startY));
            // (the blob's own mean distance from the point, as painted: about its center's)
            const startDistance = Math.sqrt((startX - px) * (startX - px) + (startY - py) * (startY - py));
            const distance = sumDistance / n;
            console.log(`Gravity ${GRAVITY_NAMES[this.gravityMode]}: the ${materialName(material)} (${n}) ${formatFixed(drift, 1)} cells from where it was, ${formatFixed(distance, 1)} from the point (it began ${formatFixed(startDistance, 1)})`);
            if (this.gravityMode == GRAVITY_OFF && drift > BLOB_DRIFT) {
                return `with no gravity the ${materialName(material)} moved ${formatFixed(drift, 1)} cells`;
            }
            if (this.gravityMode == GRAVITY_POINT && distance > GATHERED * startDistance) {
                return `the ${materialName(material)} didn't gather round the point: ${formatFixed(distance, 1)} cells from it (it began ${formatFixed(startDistance, 1)})`;
            }
            if (this.gravityMode == GRAVITY_TILT) {
                const dx = sumX / n - startX;
                const dy = sumY / n - startY;
                const along = dx * this.tiltX + dy * this.tiltY;
                const across = Math.abs(dy * this.tiltX - dx * this.tiltY);
                console.log(`Tilted (${formatFixed(this.tiltX, 2)}, ${formatFixed(this.tiltY, 2)}): the ${materialName(material)} fell ${formatFixed(along, 1)} cells that way, ${formatFixed(across, 1)} across`);
                if (along < TILT_FALL || across * 2.0 > along) {
                    return `the ${materialName(material)} didn't fall the way it's tilted: ${formatFixed(along, 1)} cells along it, ${formatFixed(across, 1)} across`;
                }
            }
        }
        return "";
    }

    // Scene 4: heat went further along the metal bar than the stone one; the acid ate wood and
    // left the glass; the salt dissolved, and the salt water sank (the tank's water saltier in
    // its bottom third than in its top third).
    checkMaterials(grid: int[]): string {
        const floatReadback = this.floatReadback;
        const cellsReadback = this.cellsReadback;
        if (!floatReadback || !cellsReadback) {
            return "cannot read the grid back";
        }
        const w = this.gridW;
        const h = this.gridH;
        const cells: int[] = [];
        for (let i = 0; i < w * h; i++) {
            cells.push(0);
        }
        const floats: f32[] = [];
        for (let i = 0; i < FLOAT_SECTIONS * this.stride; i++) {
            floats.push(0.0);
        }
        if (cellsReadback.readInts(Ref(cells[0]), cells.length) == 0
            || floatReadback.readFloats(Ref(floats[0]), floats.length) == 0) {
            return "cannot read the grid back";
        }
        // The bars' temperature (F_TCELL, section 10) in the column BAR_PROBE across.
        const probeX: int = Math.floor(BAR_PROBE * w);
        let metalSum = 0.0;
        let metalCells = 0;
        let stoneSum = 0.0;
        let stoneCells = 0;
        let wood = 0;
        let woodPainted = 0;
        let glass = 0;
        let glassPainted = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const m = cells[y * w + x] & 0xFF;
                const t = floats[10 * this.stride + y * w + x];
                if (x == probeX && m == METAL) {
                    metalSum += t;
                    metalCells++;
                } else if (x == probeX && m == STONE) {
                    stoneSum += t;
                    stoneCells++;
                }
                // (spawn_cs paints the cells whose centers are inside a stroke)
                const cx = (x + 0.5) / w;
                const cy = (y + 0.5) / h;
                const inTub = cx >= ACID_TUB[0] && cx <= ACID_TUB[2];
                if (inTub && cy >= ACID_TUB[3] && y < h - 1) {
                    woodPainted++;
                    if (m == WOOD) {
                        wood++;
                    }
                }
                const wall = (cx >= ACID_TUB[0] - 0.005 && cx <= ACID_TUB[0]) || (cx >= ACID_TUB[2] && cx <= ACID_TUB[2] + 0.005);
                if (wall && cy >= ACID_TUB[1] && y < h - 1) {
                    glassPainted++;
                    if (m == GLASS) {
                        glass++;
                    }
                }
            }
        }
        const metalT = metalSum / Math.max(metalCells, 1);
        const stoneT = stoneSum / Math.max(stoneCells, 1);
        console.log(`Materials: metal ${formatFixed(metalT, 1)} C, stone ${formatFixed(stoneT, 1)} C at ${probeX}; wood ${wood} of ${woodPainted}, glass ${glass} of ${glassPainted}`);
        if (metalCells == 0 || stoneCells == 0) {
            return "the bars aren't there";
        }
        if (metalT < stoneT + 30.0 || metalT < 60.0) {
            return `the metal bar (${formatFixed(metalT, 1)} C) isn't much hotter than the stone one (${formatFixed(stoneT, 1)} C)`;
        }
        if (wood > woodPainted * 0.9) {
            return `the acid ate little wood: ${wood} of ${woodPainted} cells left`;
        }
        if (glass != glassPainted) {
            return `the acid ate glass: ${glass} of ${glassPainted} cells left`;
        }
        let salt = 0;
        const layers = [0.0, 0.0, 0.0, 0.0];
        const x0: int = Math.ceil(SALT_TANK[0] * w);
        const x1: int = Math.floor(SALT_TANK[2] * w);
        const top: int = Math.floor(SALT_TANK[3] * h);
        const third = (h - 1 - top) / 3.0;
        for (let y = 1; y < h - 1; y++) {
            for (let x = x0; x < x1; x++) {
                const c = y * w + x;
                salt += grid[countSection(SALT) * this.stride + c];
                if (y >= top) {
                    // (0 the top third's salt and water, 2 the bottom third's)
                    let layer = -1;
                    if (y < top + third) {
                        layer = 0;
                    } else if (y >= h - 1 - third) {
                        layer = 2;
                    }
                    if (layer >= 0) {
                        layers[layer] += grid[I_SALT * this.stride + c] / SALT_SCALE;
                        layers[layer + 1] += grid[countSection(WATER) * this.stride + c];
                    }
                }
            }
        }
        const topSalinity = layers[0] / Math.max(layers[1], 1.0);
        const bottomSalinity = layers[2] / Math.max(layers[3], 1.0);
        const poured = Math.floor(SALT_POUR[1] * h) * Math.floor((SALT_TANK[2] - SALT_TANK[0] - 0.12) * w) * 4;
        console.log(`Salt: ${salt} grains left of about ${poured}; salinity ${formatFixed(100.0 * topSalinity, 2)}% at the top, ${formatFixed(100.0 * bottomSalinity, 2)}% at the bottom`);
        if (salt > poured / 2) {
            return `the salt didn't dissolve: ${salt} grains left of about ${poured}`;
        }
        if (bottomSalinity < 0.01 || bottomSalinity < topSalinity * 1.2) {
            return `the salt water didn't sink: salinity ${formatFixed(100.0 * topSalinity, 2)}% at the top, ${formatFixed(100.0 * bottomSalinity, 2)}% at the bottom`;
        }
        return "";
    }

    // Scene 9: the dropped block floats (its center within half its height of the pool's surface,
    // measured where no block is), and the one on the ledge tipped over (turned over 1 radian).
    checkBodies(grid: int[]): string {
        const floatReadback = this.floatReadback;
        const cellsReadback = this.cellsReadback;
        if (!floatReadback || !cellsReadback) {
            return "cannot read the grid back";
        }
        const w = this.gridW;
        const h = this.gridH;
        const floats: f32[] = [];
        for (let i = 0; i < FLOAT_SECTIONS * this.stride; i++) {
            floats.push(0.0);
        }
        const cells: int[] = [];
        for (let i = 0; i < w * h; i++) {
            cells.push(0);
        }
        if (floatReadback.readFloats(Ref(floats[0]), floats.length) == 0
            || cellsReadback.readInts(Ref(cells[0]), cells.length) == 0) {
            return "cannot read the grid back";
        }
        // (bodies 0 and 1: the strokes made them in that order)
        const body = F_BODY * this.stride;
        if (floats[body] == 0.0 || floats[body + BODY_FLOATS] == 0.0) {
            return "the blocks weren't made";
        }
        for (let k = 0; k < MAX_BODIES; k++) {
            const r = body + k * BODY_FLOATS;
            if (floats[r] != 0.0) {
                console.log(`Body ${k}: at (${formatFixed(floats[r + 1], 1)}, ${formatFixed(floats[r + 2], 1)}), ${formatFixed(2.0 * floats[r + 7], 1)} x ${formatFixed(2.0 * floats[r + 8], 1)}, turned ${formatFixed(floats[r + 3], 2)}`);
            }
        }
        const floaterHeight = h - 1 - floats[body + 2];
        const floaterHalf = floats[body + 8];
        const tipperAngle = floats[body + BODY_FLOATS + 3];
        // The pool's surface over its columns with no block cell in them.
        const x0: int = Math.ceil(BODY_POOL[0] * w);
        const x1: int = Math.floor(BODY_POOL[2] * w) - 1;
        let sum = 0.0;
        let columns = 0;
        for (let x = x0; x <= x1; x++) {
            let blocked = false;
            for (let y = 1; y < h - 1; y++) {
                if ((cells[y * w + x] & 0xFF) == BLOCK) {
                    blocked = true;
                }
            }
            if (!blocked) {
                sum += this.surfaceLevel(grid, x, x);
                columns++;
            }
        }
        const level = columns > 0 ? sum / columns : 0.0;
        console.log(`Bodies: the floating block's center ${formatFixed(floaterHeight, 1)} cells above the floor (half its height ${formatFixed(floaterHalf, 1)}), the water's surface at ${formatFixed(level, 1)}; the ledge's block turned ${formatFixed(tipperAngle, 2)} radians`);
        if (Math.abs(floaterHeight - level) > floaterHalf) {
            return `the block didn't float: its center ${formatFixed(floaterHeight, 1)} cells above the floor, the water's surface at ${formatFixed(level, 1)}`;
        }
        if (Math.abs(tipperAngle) < 1.0) {
            return `the block on the ledge didn't tip over: turned ${formatFixed(tipperAngle, 2)} radians`;
        }
        return "";
    }

    // Scene 8: the wind took the sand: its mean x at least WIND_DRIFT of the grid's width right of
    // the emitter (without air, it piles under it).
    checkWind(grid: int[]): string {
        const w = this.gridW;
        const h = this.gridH;
        let sand = 0;
        let sumX = 0.0;
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const c = y * w + x;
                const n = grid[countSection(SAND) * this.stride + c];
                sand += n;
                sumX += n * (x + 0.5);
            }
        }
        const emitterX = WIND_SAND[0] * w;
        const drift = sand > 0 ? sumX / sand - emitterX : 0.0;
        console.log(`Wind: ${sand} sand grains, ${formatFixed(drift, 1)} cells right of the emitter on average; the air at up to ${formatFixed(this.probeFloats[PROBE_WIND], 1)} cells a second, (${formatFixed(this.probeFloats[PROBE_AIR], 1)}, ${formatFixed(this.probeFloats[PROBE_AIR + 1], 1)}) beside the fan`);
        if (sand == 0) {
            return "no sand fell";
        }
        if (drift < WIND_DRIFT * w) {
            return `the wind didn't carry the sand: ${formatFixed(drift, 1)} cells right of the emitter, under ${formatFixed(WIND_DRIFT * w, 1)}`;
        }
        return "";
    }

    // Scene 7: the film beaded: it covers at most BEAD_SHARE of the columns it was painted over (a
    // column covered with 2 particles in a cell or more; without surface tension it stays a film,
    // or spreads).
    checkBead(grid: int[]): string {
        const w = this.gridW;
        const h = this.gridH;
        let columns = 0;
        let water = 0;
        for (let x = 1; x < w - 1; x++) {
            let covered = false;
            for (let y = 1; y < h - 1; y++) {
                const n = grid[countSection(WATER) * this.stride + y * w + x];
                water += n;
                if (n >= 2) {
                    covered = true;
                }
            }
            if (covered) {
                columns++;
            }
        }
        const painted: int = Math.floor((BEAD[2] - BEAD[0]) * w);
        console.log(`Surface tension: ${water} water particles over ${columns} columns, the film ${painted}`);
        if (columns > BEAD_SHARE * painted) {
            return `the film didn't bead: over ${columns} columns of its ${painted}`;
        }
        return "";
    }

    // Scene 6: the honey held up: its mean height (its particles', above the floor) over the
    // water's, and its front under 0.6 times as far as the water's (each from its own side's
    // left). Without viscosity, both are about the water's.
    checkViscosity(grid: int[]): string {
        const w = this.gridW;
        const h = this.gridH;
        const divider: int = Math.floor(HONEY_DIVIDER * w);
        let water = 0;
        let honey = 0;
        let waterHeight = 0.0;
        let honeyHeight = 0.0;
        let waterFront = 0;
        let honeyFront = 0;
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const c = y * w + x;
                const height = h - 1 - y;
                const nw = grid[countSection(WATER) * this.stride + c];
                const nh = grid[countSection(HONEY) * this.stride + c];
                if (x < divider) {
                    water += nw;
                    waterHeight += nw * (height + 0.5);
                    if (nw >= 2) {
                        waterFront = Math.max(waterFront, x);
                    }
                }
                if (x > divider) {
                    honey += nh;
                    honeyHeight += nh * (height + 0.5);
                    if (nh >= 2) {
                        honeyFront = Math.max(honeyFront, x - divider);
                    }
                }
            }
        }
        waterHeight /= Math.max(water, 1);
        honeyHeight /= Math.max(honey, 1);
        console.log(`Viscosity: water ${formatFixed(waterHeight, 1)} cells high on average, its front at ${waterFront}; honey ${formatFixed(honeyHeight, 1)}, its front at ${honeyFront}`);
        // (the water's height depends on how much of it piles at the far wall: the fronts tell more)
        if (honeyHeight <= waterHeight || honeyFront >= 0.6 * waterFront) {
            return `the honey ran like water: ${formatFixed(honeyHeight, 1)} cells high on average (the water ${formatFixed(waterHeight, 1)}), its front at ${honeyFront} (the water's ${waterFront})`;
        }
        return "";
    }

    // Scene 5: the gunpowder went off, all of it; its blast threw sand clear of the pile (a
    // twentieth of it, at least: runs throw 11 to 30%, the air slowing the grains, and burning
    // alone, none, the sand only falling into the pile's place); its glass wall held, and nothing
    // ended up in a solid cell.
    checkGunpowder(grid: int[]): string {
        const cellsReadback = this.cellsReadback;
        if (!cellsReadback) {
            return "cannot read the cells back";
        }
        const w = this.gridW;
        const h = this.gridH;
        const cells: int[] = [];
        for (let i = 0; i < w * h; i++) {
            cells.push(0);
        }
        if (cellsReadback.readInts(Ref(cells[0]), cells.length) == 0) {
            return "cannot read the cells back";
        }
        let gunpowder = 0;
        let sand = 0;
        let thrown = 0;
        let inSolid = 0;
        let wall = 0;
        let wallPainted = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const c = y * w + x;
                gunpowder += grid[countSection(GUNPOWDER) * this.stride + c];
                const n = grid[countSection(SAND) * this.stride + c];
                sand += n;
                const m = cells[c] & 0xFF;
                if (m >= WALL) {
                    for (let k = 0; k < PARTICLE_TYPES; k++) {
                        inSolid += grid[(I_COUNT + k) * this.stride + c];
                    }
                }
                const cx = (x + 0.5) / w;
                const cy = (y + 0.5) / h;
                if (cx < GUNPOWDER_PILE[0] - 0.02 || cx > GUNPOWDER_PILE[2]) {
                    thrown += n;
                }
                if (cx >= GUNPOWDER_PILE[2] && cx <= GUNPOWDER_PILE[2] + 0.005 && cy >= GUNPOWDER_WALL && y < h - 1) {
                    wallPainted++;
                    if (m == GLASS) {
                        wall++;
                    }
                }
            }
        }
        console.log(`Gunpowder: ${gunpowder} grains left; ${thrown} of ${sand} sand grains thrown clear; its wall ${wall} of ${wallPainted} cells; ${inSolid} particles in solid cells`);
        if (gunpowder > 0) {
            return `${gunpowder} grains of gunpowder didn't go off`;
        }
        if (thrown * 20 < sand) {
            return `the blast threw too little sand clear: ${thrown} of ${sand} grains`;
        }
        if (wall != wallPainted) {
            return `the gunpowder's glass wall lost cells: ${wall} of ${wallPainted} left`;
        }
        if (inSolid > 0) {
            return `${inSolid} particles in solid cells`;
        }
        return "";
    }

    // The water's surface over columns x0 .. x1: its mean height above the floor, in cells, a
    // column's surface the top of its highest cell of at least 2 water particles.
    surfaceLevel(grid: int[], x0: int, x1: int): number {
        let sum = 0.0;
        for (let x = x0; x <= x1; x++) {
            let level = 0.0;
            for (let y = 1; y < this.gridH - 1; y++) {
                if (grid[I_COUNT * this.stride + y * this.gridW + x] >= 2) {
                    level = this.gridH - 1 - y;
                    break;
                }
            }
            sum += level;
        }
        return sum / (x1 - x0 + 1);
    }
}

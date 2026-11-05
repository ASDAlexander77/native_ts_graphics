/// <reference path="../core/nri/nri_interop.d.ts" />
import { formatFixed } from "../core/text_format";
import { JsonReader } from "../core/json_reader";
import {
    PROBE_GOAL, WATER, OIL, SAND, FIRE, LAVA, ACID, SALT, GUNPOWDER, HONEY, PETROL, WALL, GLASS,
    WOOD, URANIUM, EMITTER, ICE, STONE, METAL, FAN, BLOCK, BATTERY, LAMP, HEAT, SALT_WATER, SPARK,
    C4, COAL, FUSE, HYDROGEN, NEON, THERMITE, NITRO, SEED, CLONE, BLACK_HOLE, WHITE_HOLE, SPONGE,
    SWITCH, DETECTOR, HEATER, LEVEL_DIRECTORY, BLOW_NAMES, STARS_PATH, STARS_MAGIC, ICE_BLOCK, BARS,
    HEAT_STROKES, ACID_TUB, SALT_TANK, SALT_POUR, GUNPOWDER_PILE, SAND_LAYER, GUNPOWDER_WALL, POOL,
    DAM, HONEY_DIVIDER, BEAD, WIND_FAN, WIND_SAND, BODY_POOL, FLOATER, LEDGE, TIPPER, TUBS, TUB_TOP,
    TUB_LIQUID, ACID_POUR, FIRE_BAND, GAS_WOOD, GAS_CEILING, GAS_PROBE, BLOBS, CIRCUITS, WIRE,
    SPARK_WIRE, SPARK_POWDER, CONTROL_POWDER, ELECTRO_TUBS, ELECTRO_Y, ELECTRO_WIRE, NEON_TUBES,
    H2_BOXES, H2_Y, FUSES, BURN_BLOCKS, BURN_TOP, PLATES, PLATE_Y, THERMITE_TOP, NITRO_TUBS,
    NITRO_TOP, NITRO_DROP, C4_BLOCKS, C4_Y, CLONED, CLONE_DROP, CLONE_TWIN, CLONE_TUBS,
    CLONE_TUB_TOP, HOLE_XS, HOLE_Y, HOLE_W, HOLE_SAND, SPONGE_BOX, SPONGE_TWIN, SPONGE_TUBS,
    SPONGE_TUB_TOP, SPONGE_WATER, SEED_POOL, SEED_WET, SEED_LEDGE, SWITCH_ROWS, SWITCH_X, LAMP_X,
    DETECTOR_ROWS, HEATERS, toolNamed, LevelStroke, Level, starText, Stroke
} from "./defs";
import { SandboxView } from "./view";
import { NriFile } from "../core/nri";

// The sandbox's scenes and levels: the test scenes' strokes, the levels read from their files
// (index.json's list, a level's goal, clock and stars) and the best stars kept.
export class SandboxLevels extends SandboxView {
    // A rectangle of grid fractions (0..1 across, 0..1 down) painted with tool.
    addStroke(tool: int, x0: number, y0: number, x1: number, y1: number, emit: int) {
        this.script.push(new Stroke(tool, x0 * this.gridW, y0 * this.gridH, x1 * this.gridW, y1 * this.gridH, emit));
    }

    // The next level of index.json's list (read when first wanted), the grid cleared for it.
    nextLevel() {
        if (this.levelNames.length == 0) {
            const reader = this.readJson("index");
            if (reader && reader.beginObject()) {
                while (reader.nextKey()) {
                    if (reader.readString() == "levels" && reader.beginArray()) {
                        while (reader.nextItem()) {
                            this.levelNames.push(reader.readString());
                        }
                    } else {
                        reader.skipValue();
                    }
                }
            }
            if (this.levelNames.length == 0) {
                this.showMessage("No levels");
                return;
            }
            this.readStars();
        }
        this.levelIndex = (this.levelIndex + 1) % this.levelNames.length;
        const level = this.readLevel(this.levelNames[this.levelIndex]);
        if (level) {
            this.startLevel(level);
            this.snapshotRequested = true;
            this.needsInit = true;
            // (on a grid wider than tall: turned, if the window's upright)
            if (this.gridW < this.gridH) {
                const oldW = this.gridW;
                const oldH = this.gridH;
                this.fitGrid();
                this.reshaped(oldW, oldH);
                this.layout();
            }
            const best = this.bestStars[this.levelIndex];
            this.showMessage(best > 0 ? `${level.name} (best ${starText(best)})` : level.name);
        }
    }

    startLevel(level: Level | null) {
        if (level) {
            this.level = level;
            this.scene = 0;
            this.sceneOnClear = true;
            this.goalReached = false;
        }
    }

    // The best stars from STARS_PATH, one for each of index.json's levels (0 for those it hasn't).
    readStars() {
        this.bestStars = [];
        for (let k = 0; k < this.levelNames.length; k++) {
            this.bestStars.push(0);
        }
        const file = NriFile.load(STARS_PATH);
        if (!file) {
            return;
        }
        const bytes: int[] = [];
        const size = file.getSize();
        for (let i = 0; i < size; i++) {
            bytes.push(0);
        }
        if (size > 0) {
            file.copyBytes(0, size, Ref(bytes[0]));
        }
        file.destroy();
        const ints: int[] = [];
        for (let i = 0; i + 3 < size; i += 4) {
            ints.push(bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24));
        }
        if (ints.length < 2 || ints[0] != STARS_MAGIC) {
            return;
        }
        for (let k = 0; k < this.levelNames.length && k < ints[1] && 2 + k < ints.length; k++) {
            this.bestStars[k] = Math.min(Math.max(ints[2 + k], 0), 3);
        }
    }

    // The best stars, into STARS_PATH (not in tests).
    saveStars() {
        if (this.test || this.queuedFrames.length == 0) {
            return;
        }
        const ints: int[] = [STARS_MAGIC, this.bestStars.length];
        for (const stars of this.bestStars) {
            ints.push(stars);
        }
        this.queuedFrames[0].probeReadback.saveToFile(0, Ref(ints[0]), ints.length, STARS_PATH);
    }

    // The level's goal against the count a frame's probe read (time: the level's time after that
    // frame, -1 before its strokes): reached once it's been met for its hold time, its stars
    // then (by that time), the best kept.
    checkGoal(time: number) {
        const level = this.level;
        if (!level || level.goalCount <= 0 || this.goalReached || time < 0.0) {
            return;
        }
        const count = this.probe[PROBE_GOAL];
        if (level.goalAtMost ? count > level.goalCount : count < level.goalCount) {
            this.goalSince = -1.0;
            return;
        }
        if (this.goalSince < 0.0) {
            this.goalSince = time;
        }
        if (time - this.goalSince < level.goalHold) {
            return;
        }
        this.goalReached = true;
        this.goalTime = time;
        this.goalStars = 0;
        if (level.stars.length >= 2) {
            this.goalStars = time <= level.stars[0] ? 3 : (time <= level.stars[1] ? 2 : 1);
        }
        let best = "";
        if (this.levelIndex >= 0 && this.levelIndex < this.bestStars.length) {
            if (this.goalStars > this.bestStars[this.levelIndex]) {
                this.bestStars[this.levelIndex] = this.goalStars;
                this.saveStars();
            } else if (this.bestStars[this.levelIndex] > 0) {
                best = ` (best ${starText(this.bestStars[this.levelIndex])})`;
            }
        }
        this.showMessage(`${level.name}: done in ${formatFixed(time, 1)} s! ${starText(this.goalStars)}${best}`);
    }

    // The level's clock, from when its strokes are painted, while it simulates (steps of step
    // seconds), till its goal's reached; -solve's solution painted at its time.
    advanceLevel(steps: int, step: number) {
        const level = this.level;
        if (!level || this.goalReached) {
            return;
        }
        if (this.levelTime < 0.0) {
            if (this.script.length == 0 && !this.needsInit) {
                this.levelTime = 0.0;
            }
        } else if (!this.paused) {
            this.levelTime += steps * step;
        }
        if (this.solveTime >= 0.0 && !this.solved && this.levelTime >= this.solveTime) {
            this.solved = true;
            for (const stroke of level.solution) {
                this.addStroke(stroke.tool, stroke.box[0], stroke.box[1], stroke.box[2], stroke.box[3], stroke.emit);
            }
        }
    }

    // A file of LEVEL_DIRECTORY (name.json) in a reader, or null (with a message).
    readJson(name: string): JsonReader | null {
        const file = NriFile.load(`${LEVEL_DIRECTORY}${name}.json`);
        if (!file) {
            this.showMessage(`No level file ${name}.json`);
            return null;
        }
        const reader = new JsonReader();
        if (reader.resize(file.getSize())) {
            file.copyBytes(0, reader.bytes.length, Ref(reader.bytes[0]));
        }
        file.destroy();
        return reader;
    }

    // A level from its file, or null (with a message: what didn't read).
    readLevel(name: string): Level | null {
        const reader = this.readJson(name);
        if (!reader) {
            return null;
        }
        const level = new Level();
        let unknown = "";
        if (reader.beginObject()) {
            while (reader.nextKey()) {
                const key = reader.readString();
                if (key == "name") {
                    level.name = reader.readString();
                } else if (key == "goal" && reader.beginObject()) {
                    while (reader.nextKey()) {
                        const goalKey = reader.readString();
                        if (goalKey == "text") {
                            level.goalText = reader.readString();
                        } else if (goalKey == "material") {
                            const material = reader.readString();
                            level.goalMaterial = toolNamed(material);
                            if (level.goalMaterial < 0) {
                                unknown = material;
                            }
                        } else if (goalKey == "box") {
                            level.goalBox = reader.readNumbers();
                        } else if (goalKey == "count") {
                            level.goalCount = Math.floor(reader.readNumber());
                        } else if (goalKey == "lit") {
                            level.goalLit = reader.readBool();
                        } else if (goalKey == "atMost") {
                            level.goalAtMost = reader.readBool();
                        } else if (goalKey == "hold") {
                            level.goalHold = Math.max(reader.readNumber(), 0.0);
                        } else {
                            reader.skipValue();
                        }
                    }
                } else if (key == "stars") {
                    level.stars = reader.readNumbers();
                } else if (key == "strokes" || key == "solution") {
                    const strokeUnknown = this.readStrokes(reader, key == "strokes" ? level.strokes : level.solution);
                    if (strokeUnknown != "") {
                        unknown = strokeUnknown;
                    }
                } else {
                    reader.skipValue();
                }
            }
        }
        if (reader.error != "" || unknown != "" || (level.goalCount > 0 && level.goalBox.length != 4)) {
            this.showMessage(`${name}.json: ${reader.error != "" ? reader.error : (unknown != "" ? `no tool or material "${unknown}"` : "the goal needs a box")}`);
            return null;
        }
        console.log(`Level ${name}: ${level.name}, ${level.strokes.length} strokes`);
        return level;
    }

    // A level's array of strokes, into strokes; the name of a tool or material it doesn't know,
    // or "".
    readStrokes(reader: JsonReader, strokes: LevelStroke[]): string {
        let unknown = "";
        if (reader.beginArray()) {
            while (reader.nextItem()) {
                let tool = -1;
                let box: number[] = [];
                let emit = WATER;
                let repeat = 1;
                if (reader.beginObject()) {
                    while (reader.nextKey()) {
                        const strokeKey = reader.readString();
                        if (strokeKey == "tool") {
                            const toolName = reader.readString();
                            tool = toolNamed(toolName);
                            if (tool < 0) {
                                unknown = toolName;
                            }
                        } else if (strokeKey == "box") {
                            box = reader.readNumbers();
                        } else if (strokeKey == "emit") {
                            const emitName = reader.readString();
                            emit = toolNamed(emitName);
                            if (emit < 0) {
                                unknown = emitName;
                            }
                        } else if (strokeKey == "blow") {
                            const blow = reader.readString();
                            emit = BLOW_NAMES.indexOf(blow);
                            if (emit < 0) {
                                unknown = blow;
                            }
                        } else if (strokeKey == "repeat") {
                            repeat = Math.max(Math.floor(reader.readNumber()), 1);
                        } else {
                            reader.skipValue();
                        }
                    }
                }
                if (tool >= 0 && box.length == 4) {
                    for (let k = 0; k < repeat; k++) {
                        strokes.push(new LevelStroke(tool, box, emit));
                    }
                }
            }
        }
        return unknown;
    }

    // The starting scene's strokes: 1 the U-tube's water (its divider is init_grid_cs's), 2 a
    // showcase of the materials, 3 lava poured into a pool with an ice block in it, and next to
    // a wood block.
    buildScene() {
        this.script = [];
        const level = this.level;
        if (level) {
            this.goalReached = false;
            this.levelTime = -1.0;
            this.goalSince = -1.0;
            this.solved = false;
            for (const stroke of level.strokes) {
                this.addStroke(stroke.tool, stroke.box[0], stroke.box[1], stroke.box[2], stroke.box[3], stroke.emit);
            }
            return;
        }
        if (this.scene == 1) {
            this.script.push(new Stroke(WATER, 1.0, this.gridH * 0.2, this.gridW / 2 - 0.01, this.gridH - 1.0, WATER));
        } else if (this.scene == 2) {
            // A glass tank of water with oil poured over it.
            this.addStroke(GLASS, 0.04, 0.4, 0.045, 1.0, WATER);
            this.addStroke(GLASS, 0.3, 0.4, 0.305, 1.0, WATER);
            this.addStroke(WATER, 0.05, 0.6, 0.295, 1.0, WATER);
            this.addStroke(OIL, 0.05, 0.45, 0.295, 0.58, WATER);
            // Sand poured into a pile.
            this.addStroke(SAND, 0.38, 0.1, 0.45, 0.35, WATER);
            // A wood block, lit.
            this.addStroke(WOOD, 0.55, 0.8, 0.68, 1.0, WATER);
            this.addStroke(FIRE, 0.57, 0.74, 0.66, 0.8, WATER);
            // Uranium in a pool, under a wall shelf an emitter drips water from.
            this.addStroke(WALL, 0.74, 0.55, 0.745, 1.0, WATER);
            this.addStroke(WATER, 0.75, 0.75, 0.995, 1.0, WATER);
            this.addStroke(URANIUM, 0.83, 0.86, 0.9, 1.0, WATER);
            this.addStroke(EMITTER, 0.86, 0.1, 0.87, 0.12, WATER);
        } else if (this.scene == 24) {
            // Switches (one toggled on), detectors (one under falling sand), heaters (one powered).
            for (let k = 0; k < 2; k++) {
                const y = SWITCH_ROWS[k];
                this.addStroke(BATTERY, 0.05, y, 0.09, y + WIRE, WATER);
                this.addStroke(METAL, 0.09, y, SWITCH_X, y + WIRE, WATER);
                this.addStroke(SWITCH, SWITCH_X, y, SWITCH_X + 0.04, y + WIRE, WATER);
                this.addStroke(METAL, SWITCH_X + 0.04, y, LAMP_X, y + WIRE, WATER);
                this.addStroke(LAMP, LAMP_X, y, LAMP_X + 0.04, y + WIRE, WATER);
                const d = DETECTOR_ROWS[k];
                this.addStroke(DETECTOR, 0.05, d, 0.09, d + WIRE, WATER);
                this.addStroke(METAL, 0.09, d, LAMP_X, d + WIRE, WATER);
                this.addStroke(LAMP, LAMP_X, d, LAMP_X + 0.04, d + WIRE, WATER);
                const hy = 0.5 * (HEATERS[2 + 2 * k] + HEATERS[3 + 2 * k]) - 0.5 * WIRE;
                this.addStroke(k == 0 ? BATTERY : WALL, 0.6, hy, 0.64, hy + WIRE, WATER);
                this.addStroke(METAL, 0.64, hy, HEATERS[0], hy + WIRE, WATER);
                this.addStroke(HEATER, HEATERS[0], HEATERS[2 + 2 * k], HEATERS[1], HEATERS[3 + 2 * k], WATER);
            }
            this.addStroke(SPARK, SWITCH_X, SWITCH_ROWS[0], SWITCH_X + 0.04, SWITCH_ROWS[0] + WIRE, WATER);
            this.addStroke(SAND, 0.05, DETECTOR_ROWS[0] - 0.1, 0.09, DETECTOR_ROWS[0] - 0.04, WATER);
        } else if (this.scene == 23) {
            // A sponge in a tub of water, a wall block in the other; seeds into a pool, and on a ledge.
            for (let k = 0; k < 2; k++) {
                const x0 = SPONGE_TUBS[2 * k];
                const x1 = SPONGE_TUBS[2 * k + 1];
                this.addStroke(GLASS, x0 - 0.005, SPONGE_TUB_TOP, x0, 1.0, WATER);
                this.addStroke(GLASS, x1, SPONGE_TUB_TOP, x1 + 0.005, 1.0, WATER);
                this.addStroke(WATER, x0, SPONGE_WATER, x1, 1.0, WATER);
                const dx = k == 0 ? 0.0 : SPONGE_TWIN;
                this.addStroke(k == 0 ? SPONGE : WALL, SPONGE_BOX[0] + dx, SPONGE_BOX[2], SPONGE_BOX[1] + dx, SPONGE_BOX[3], WATER);
            }
            this.addStroke(GLASS, SEED_POOL[0] - 0.005, SEED_POOL[2], SEED_POOL[0], 1.0, WATER);
            this.addStroke(GLASS, SEED_POOL[1], SEED_POOL[2], SEED_POOL[1] + 0.005, 1.0, WATER);
            this.addStroke(WATER, SEED_POOL[0], SEED_POOL[3], SEED_POOL[1], 1.0, WATER);
            this.addStroke(SEED, SEED_WET[0], SEED_WET[2], SEED_WET[1], SEED_WET[3], WATER);
            this.addStroke(WALL, SEED_LEDGE[0], SEED_LEDGE[2], SEED_LEDGE[1], SEED_LEDGE[2] + 0.02, WATER);
            this.addStroke(SEED, SEED_LEDGE[0] + 0.02, SEED_LEDGE[2] - 0.04, SEED_LEDGE[1] - 0.02, SEED_LEDGE[2] - 0.01, WATER);
        } else if (this.scene == 22) {
            // Sand dropped toward a black hole, a white hole and a wall block.
            const holes = [BLACK_HOLE, WHITE_HOLE, WALL];
            for (let k = 0; k < 3; k++) {
                this.addStroke(holes[k], HOLE_XS[k], HOLE_Y[0], HOLE_XS[k] + HOLE_W, HOLE_Y[1], WATER);
                this.addStroke(SAND, HOLE_XS[k] - 0.06, HOLE_SAND[0], HOLE_XS[k] + HOLE_W + 0.06, HOLE_SAND[1], WATER);
            }
        } else if (this.scene == 21) {
            // Water dropped on a clone, and on a wall block, each in a tub.
            for (let k = 0; k < 2; k++) {
                this.addStroke(GLASS, CLONE_TUBS[2 * k] - 0.005, CLONE_TUB_TOP, CLONE_TUBS[2 * k], 1.0, WATER);
                this.addStroke(GLASS, CLONE_TUBS[2 * k + 1], CLONE_TUB_TOP, CLONE_TUBS[2 * k + 1] + 0.005, 1.0, WATER);
                const dx = k == 0 ? 0.0 : CLONE_TWIN;
                this.addStroke(k == 0 ? CLONE : WALL, CLONED[0] + dx, CLONED[2], CLONED[1] + dx, CLONED[3], WATER);
                this.addStroke(WATER, CLONED[0] + CLONE_DROP[0] + dx, CLONED[2] + CLONE_DROP[2], CLONED[1] + CLONE_DROP[1] + dx,
                    CLONED[2] + CLONE_DROP[3], WATER);
            }
        } else if (this.scene == 18) {
            // Nitroglycerin dropped into a tub, and at rest in one.
            for (let k = 0; k < 2; k++) {
                this.addStroke(GLASS, NITRO_TUBS[2 * k] - 0.005, NITRO_TOP, NITRO_TUBS[2 * k], 1.0, WATER);
                this.addStroke(GLASS, NITRO_TUBS[2 * k + 1], NITRO_TOP, NITRO_TUBS[2 * k + 1] + 0.005, 1.0, WATER);
            }
            this.addStroke(NITRO, NITRO_DROP[0], NITRO_DROP[1], NITRO_DROP[2], NITRO_DROP[3], WATER);
            this.addStroke(NITRO, NITRO_TUBS[2], 0.92, NITRO_TUBS[3], 1.0, WATER);
            // (a wall between, from the blast)
            this.addStroke(WALL, 0.48, 0.25, 0.52, 1.0, WATER);
        } else if (this.scene == 19) {
            // C-4 wired to a battery, and not.
            for (let k = 0; k < 2; k++) {
                this.addStroke(C4, C4_BLOCKS[2 * k], C4_Y[0], C4_BLOCKS[2 * k + 1], C4_Y[1], WATER);
            }
            this.addStroke(BATTERY, C4_BLOCKS[0] - 0.15, 0.4, C4_BLOCKS[0] - 0.11, 0.4 + WIRE, WATER);
            this.addStroke(METAL, C4_BLOCKS[0] - 0.11, 0.4, C4_BLOCKS[0], 0.4 + WIRE, WATER);
            // (a wall between, from the blast)
            this.addStroke(WALL, 0.48, 0.1, 0.52, 1.0, WATER);
        } else if (this.scene == 17) {
            // Thermite on metal plates, one lit.
            for (let k = 0; k < 2; k++) {
                this.addStroke(METAL, PLATES[2 * k], PLATE_Y[0], PLATES[2 * k + 1], PLATE_Y[1], WATER);
                this.addStroke(THERMITE, PLATES[2 * k] + 0.05, THERMITE_TOP, PLATES[2 * k + 1] - 0.05, PLATE_Y[0], WATER);
            }
            for (let k = 0; k < 5; k++) {
                this.addStroke(FIRE, PLATES[0] + 0.06, THERMITE_TOP - 0.02, PLATES[1] - 0.06, THERMITE_TOP + 0.02, WATER);
            }
        } else if (this.scene == 16) {
            // Hydrogen in glass boxes, one lit; fuses, one lit; coal and wood lit on top.
            for (let k = 0; k < 2; k++) {
                this.addBox(GLASS, H2_BOXES[2 * k], H2_Y[0], H2_BOXES[2 * k + 1], H2_Y[1]);
                this.addStroke(FUSE, FUSES[0], FUSES[2 + k], FUSES[1], FUSES[2 + k] + 0.02, WATER);
            }
            for (let k = 0; k < 6; k++) {
                for (let b = 0; b < 2; b++) {
                    this.addStroke(HYDROGEN, H2_BOXES[2 * b] + 0.005, H2_Y[0] + 0.005, H2_BOXES[2 * b + 1] - 0.005, H2_Y[1] - 0.005, WATER);
                }
            }
            for (let k = 0; k < 5; k++) {
                this.addStroke(FIRE, H2_BOXES[0] + 0.01, H2_Y[1] - 0.04, H2_BOXES[1] - 0.01, H2_Y[1] - 0.01, WATER);
                this.addStroke(FIRE, FUSES[0] - 0.04, FUSES[2], FUSES[0], FUSES[2] + 0.02, WATER);
            }
        } else if (this.scene == 20) {
            // Coal and wood, lit on top.
            this.addStroke(COAL, BURN_BLOCKS[0], BURN_TOP, BURN_BLOCKS[1], 1.0, WATER);
            this.addStroke(WOOD, BURN_BLOCKS[2], BURN_TOP, BURN_BLOCKS[3], 1.0, WATER);
            // (fire for 10 frames: with 5, on some grids' widths no coal was still alight at the end)
            for (let k = 0; k < 10; k++) {
                this.addStroke(FIRE, BURN_BLOCKS[0], BURN_TOP - 0.04, BURN_BLOCKS[1], BURN_TOP, WATER);
                this.addStroke(FIRE, BURN_BLOCKS[2], BURN_TOP - 0.04, BURN_BLOCKS[3], BURN_TOP, WATER);
            }
        } else if (this.scene == 15) {
            // Salt water tubs, one wired to a battery; neon tubes, one wired.
            for (let k = 0; k < 2; k++) {
                const x0 = ELECTRO_TUBS[2 * k];
                const x1 = ELECTRO_TUBS[2 * k + 1];
                this.addStroke(GLASS, x0 - 0.005, ELECTRO_Y[0], x0, ELECTRO_Y[1], WATER);
                this.addStroke(GLASS, x1, ELECTRO_Y[0], x1 + 0.005, ELECTRO_Y[1], WATER);
                this.addStroke(GLASS, x0 - 0.005, ELECTRO_Y[1] - 0.005, x1 + 0.005, ELECTRO_Y[1], WATER);
                this.addStroke(k == 0 ? BATTERY : WALL, x0 - 0.05, ELECTRO_WIRE, x0 - 0.03, ELECTRO_WIRE + WIRE, WATER);
                this.addStroke(METAL, x0 - 0.03, ELECTRO_WIRE, x0 + 0.005, ELECTRO_WIRE + WIRE, WATER);
                this.addStroke(SALT_WATER, x0, ELECTRO_Y[0] + 0.02, x1, ELECTRO_Y[1] - 0.005, WATER);
                const y0 = NEON_TUBES[2 + 2 * k];
                const y1 = NEON_TUBES[3 + 2 * k];
                this.addBox(GLASS, NEON_TUBES[0], y0, NEON_TUBES[1], y1);
                const wireY = 0.5 * (y0 + y1) - 0.5 * WIRE;
                this.addStroke(k == 0 ? BATTERY : WALL, NEON_TUBES[0] - 0.07, wireY, NEON_TUBES[0] - 0.04, wireY + WIRE, WATER);
                this.addStroke(METAL, NEON_TUBES[0] - 0.04, wireY, NEON_TUBES[0] + 0.005, wireY + WIRE, WATER);
            }
            for (let k = 0; k < 8; k++) {
                for (let b = 0; b < 2; b++) {
                    this.addStroke(NEON, NEON_TUBES[0] + 0.005, NEON_TUBES[2 + 2 * b] + 0.005, NEON_TUBES[1] - 0.005, NEON_TUBES[3 + 2 * b] - 0.005, WATER);
                }
            }
        } else if (this.scene == 14) {
            // Circuits; gunpowder on a live wire and on a ledge.
            for (let k = 0; k < 3; k++) {
                this.addCircuit(CIRCUITS[5 * k], CIRCUITS[5 * k + 1], CIRCUITS[5 * k + 2], CIRCUITS[5 * k + 3],
                    CIRCUITS[5 * k + 4], k == 1 ? SALT_WATER : WATER);
            }
            this.addStroke(BATTERY, SPARK_WIRE[0], SPARK_WIRE[2], SPARK_WIRE[0] + 0.04, SPARK_WIRE[2] + WIRE, WATER);
            this.addStroke(METAL, SPARK_WIRE[0] + 0.04, SPARK_WIRE[2], SPARK_WIRE[1], SPARK_WIRE[2] + WIRE, WATER);
            this.addStroke(GUNPOWDER, SPARK_POWDER[0], SPARK_POWDER[1], SPARK_POWDER[2], SPARK_POWDER[3], WATER);
            this.addStroke(WALL, CONTROL_POWDER[0] - 0.02, CONTROL_POWDER[4], CONTROL_POWDER[2] + 0.02, CONTROL_POWDER[4] + WIRE, WATER);
            this.addStroke(GUNPOWDER, CONTROL_POWDER[0], CONTROL_POWDER[1], CONTROL_POWDER[2], CONTROL_POWDER[3], WATER);
        } else if (this.scene == 13) {
            // Water and sand in mid-air.
            this.addStroke(WATER, BLOBS[0], BLOBS[1], BLOBS[2], BLOBS[3], WATER);
            this.addStroke(SAND, BLOBS[4], BLOBS[5], BLOBS[6], BLOBS[7], WATER);
        } else if (this.scene == 12) {
            // A wood fire under a glass ceiling. (The probe above it, for the wind there.)
            this.mouseGridX = GAS_PROBE[0] * this.gridW;
            this.mouseGridY = GAS_PROBE[1] * this.gridH;
            this.addStroke(GLASS, GAS_CEILING[0], GAS_CEILING[1], GAS_CEILING[2], GAS_CEILING[1] + 0.01, WATER);
            this.addStroke(WOOD, GAS_WOOD[0], GAS_WOOD[1], GAS_WOOD[2], 1.0, WATER);
            for (let k = 0; k < 10; k++) {
                this.addStroke(FIRE, GAS_WOOD[0], GAS_WOOD[1] - 0.04, GAS_WOOD[2], GAS_WOOD[1], WATER);
            }
        } else if (this.scene == 11) {
            // Oil and petrol lit; oil sealed away from the air.
            this.addTubs(3);
            this.addStroke(OIL, TUBS[0] + 0.005, TUB_LIQUID, TUBS[1], 1.0, WATER);
            this.addStroke(PETROL, TUBS[2] + 0.005, TUB_LIQUID, TUBS[3], 1.0, WATER);
            this.addStroke(OIL, TUBS[4] + 0.005, TUB_LIQUID, TUBS[5], 1.0, WATER);
            this.addStroke(GLASS, TUBS[4], TUB_TOP - 0.01, TUBS[5] + 0.005, TUB_TOP, WATER);
            for (let k = 0; k < 10; k++) {
                this.addStroke(FIRE, TUBS[0] + 0.03, FIRE_BAND[0], TUBS[1] - 0.03, FIRE_BAND[1], WATER);
                this.addStroke(FIRE, TUBS[2] + 0.03, FIRE_BAND[0], TUBS[3] - 0.03, FIRE_BAND[1], WATER);
            }
        } else if (this.scene == 10) {
            // Acid poured over water, and into an empty tub.
            this.addTubs(2);
            this.addStroke(WATER, TUBS[0] + 0.005, TUB_LIQUID, TUBS[1], 1.0, WATER);
            this.addStroke(ACID, TUBS[0] + 0.005, ACID_POUR[0], TUBS[1], ACID_POUR[1], WATER);
            this.addStroke(ACID, TUBS[2] + 0.005, ACID_POUR[0], TUBS[3], ACID_POUR[1], WATER);
        } else if (this.scene == 9) {
            // A block dropped into a pool floats; one standing half over a ledge tips off it.
            this.addStroke(GLASS, BODY_POOL[0] - 0.005, BODY_POOL[1], BODY_POOL[0], 1.0, WATER);
            this.addStroke(GLASS, BODY_POOL[2], BODY_POOL[1], BODY_POOL[2] + 0.005, 1.0, WATER);
            this.addStroke(WATER, BODY_POOL[0], BODY_POOL[3], BODY_POOL[2], 1.0, WATER);
            this.addStroke(WALL, LEDGE[0], LEDGE[1], LEDGE[2], 1.0, WATER);
            this.addStroke(BLOCK, FLOATER[0], FLOATER[1], FLOATER[2], FLOATER[3], WATER);
            this.addStroke(BLOCK, TIPPER[0], TIPPER[1], TIPPER[2], LEDGE[1] - 0.005, WATER);
        } else if (this.scene == 8) {
            // A fan blowing across falling sand: the grains go with the wind. (The probe a little
            // right of the fan, for the log.)
            this.mouseGridX = WIND_SAND[0] * this.gridW;
            this.mouseGridY = 0.55 * this.gridH;
            this.addStroke(FAN, WIND_FAN[0], WIND_FAN[1], WIND_FAN[0] + 0.005, WIND_FAN[2], 0);
            // (one cell: a thicker stream packs its cells, and packed sand isn't airborne)
            const ex = (Math.floor(WIND_SAND[0] * this.gridW) + 0.05) / this.gridW;
            const ey = (Math.floor(WIND_SAND[1] * this.gridH) + 0.05) / this.gridH;
            this.addStroke(EMITTER, ex, ey, ex + 0.9 / this.gridW, ey + 0.9 / this.gridH, SAND);
        } else if (this.scene == 7) {
            // A film of water on the floor: it beads up.
            this.addStroke(WATER, BEAD[0], BEAD[1], BEAD[2], 1.0, WATER);
        } else if (this.scene == 6) {
            // Water and honey let go side by side: the water runs out, the honey slumps.
            this.addStroke(GLASS, HONEY_DIVIDER, 0.2, HONEY_DIVIDER + 0.005, 1.0, WATER);
            this.addStroke(WATER, DAM[0], DAM[2], DAM[1], 1.0, WATER);
            this.addStroke(HONEY, HONEY_DIVIDER + 0.005 + DAM[0], DAM[2], HONEY_DIVIDER + 0.005 + DAM[1], 1.0, WATER);
        } else if (this.scene == 5) {
            // Gunpowder under sand, next to a pool, lit from its side.
            const x0 = GUNPOWDER_PILE[0];
            const x1 = GUNPOWDER_PILE[2];
            this.addStroke(GLASS, x1, GUNPOWDER_WALL, x1 + 0.005, 1.0, WATER);
            this.addStroke(GLASS, POOL[0], GUNPOWDER_WALL, POOL[0] + 0.005, 1.0, WATER);
            this.addStroke(WATER, x1 + 0.005, POOL[1], POOL[0], 1.0, WATER);
            this.addStroke(GUNPOWDER, x0, GUNPOWDER_PILE[1], x1, 1.0, WATER);
            this.addStroke(SAND, x0, GUNPOWDER_PILE[1] - SAND_LAYER, x1, GUNPOWDER_PILE[1], WATER);
            for (let k = 0; k < 20; k++) {
                this.addStroke(FIRE, x0 - 0.03, 0.92, x0, 1.0, WATER);
            }
        } else if (this.scene == 4) {
            // A metal bar and a stone bar, their left ends heated.
            this.addStroke(METAL, BARS[0], BARS[1], BARS[2], BARS[1] + BARS[3], WATER);
            this.addStroke(STONE, BARS[0], BARS[4], BARS[2], BARS[4] + BARS[3], WATER);
            // Acid poured over wood in a glass tub.
            this.addStroke(GLASS, ACID_TUB[0] - 0.005, ACID_TUB[1], ACID_TUB[0], 1.0, WATER);
            this.addStroke(GLASS, ACID_TUB[2], ACID_TUB[1], ACID_TUB[2] + 0.005, 1.0, WATER);
            this.addStroke(WOOD, ACID_TUB[0], ACID_TUB[3], ACID_TUB[2], 1.0, WATER);
            this.addStroke(ACID, ACID_TUB[0], ACID_TUB[1] + 0.03, ACID_TUB[2], ACID_TUB[3] - 0.08, WATER);
            this.addStroke(GLASS, SALT_TANK[0] - 0.005, SALT_TANK[1], SALT_TANK[0], 1.0, WATER);
            this.addStroke(GLASS, SALT_TANK[2], SALT_TANK[1], SALT_TANK[2] + 0.005, 1.0, WATER);
            this.addStroke(WATER, SALT_TANK[0], SALT_TANK[3], SALT_TANK[2], 1.0, WATER);
            this.addStroke(SALT, SALT_TANK[0] + 0.06, SALT_TANK[3] - SALT_POUR[0], SALT_TANK[2] - 0.06,
                SALT_TANK[3] - SALT_POUR[0] + SALT_POUR[1], WATER);
            for (let k = 0; k < HEAT_STROKES; k++) {
                this.addStroke(HEAT, BARS[0] - 0.01, BARS[1] - 0.02, BARS[0] + 0.015, BARS[4] + BARS[3] + 0.02, WATER);
            }
        } else if (this.scene == 3) {
            this.addStroke(GLASS, 0.05, 0.5, 0.055, 1.0, WATER);
            this.addStroke(GLASS, 0.55, 0.5, 0.555, 1.0, WATER);
            this.addStroke(WATER, 0.06, 0.65, 0.545, 1.0, WATER);
            this.addStroke(ICE, ICE_BLOCK[0], ICE_BLOCK[1], ICE_BLOCK[2], ICE_BLOCK[3], WATER);
            this.addStroke(LAVA, 0.33, 0.2, 0.45, 0.32, WATER);
            this.addStroke(WOOD, 0.75, 0.85, 0.85, 1.0, WATER);
            this.addStroke(LAVA, 0.64, 0.55, 0.72, 0.7, WATER);
        }
    }

    // Scenes 10 and 11's glass tubs, the first n of TUBS.
    addTubs(n: int) {
        for (let k = 0; k < n; k++) {
            this.addStroke(GLASS, TUBS[2 * k], TUB_TOP, TUBS[2 * k] + 0.005, 1.0, WATER);
            this.addStroke(GLASS, TUBS[2 * k + 1], TUB_TOP, TUBS[2 * k + 1] + 0.005, 1.0, WATER);
        }
    }

    // A battery at x0 (WIRE high, from y), a metal wire to a lamp at x1; a glass tub of liquid
    // between tubX0 and tubX1 (none if under 0), the wire into it on each side.
    addCircuit(x0: number, x1: number, y: number, tubX0: number, tubX1: number, liquid: int) {
        this.addStroke(BATTERY, x0, y, x0 + 0.04, y + WIRE, WATER);
        this.addStroke(LAMP, x1, y, x1 + 0.04, y + WIRE, WATER);
        if (tubX0 < 0.0) {
            this.addStroke(METAL, x0 + 0.04, y, x1, y + WIRE, WATER);
            return;
        }
        this.addStroke(GLASS, tubX0 - 0.005, y - 0.08, tubX0, y + 0.085, WATER);
        this.addStroke(GLASS, tubX1, y - 0.08, tubX1 + 0.005, y + 0.085, WATER);
        this.addStroke(GLASS, tubX0 - 0.005, y + 0.08, tubX1 + 0.005, y + 0.085, WATER);
        this.addStroke(METAL, x0 + 0.04, y, tubX0 + 0.005, y + WIRE, WATER);
        this.addStroke(METAL, tubX1 - 0.005, y, x1, y + WIRE, WATER);
        this.addStroke(liquid, tubX0, y - 0.07, tubX1, y + 0.08, WATER);
    }

    // A box's outline (in fractions of the grid), a cell or so thick.
    addBox(material: int, x0: number, y0: number, x1: number, y1: number) {
        this.addStroke(material, x0, y0, x1, y0 + 0.01, WATER);
        this.addStroke(material, x0, y1 - 0.01, x1, y1, WATER);
        this.addStroke(material, x0, y0, x0 + 0.005, y1, WATER);
        this.addStroke(material, x1 - 0.005, y0, x1, y1, WATER);
    }
}

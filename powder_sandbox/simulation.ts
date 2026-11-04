/// <reference path="../core/nri/nri_interop.d.ts" />
import { formatFixed } from "../core/text_format";
import {
    CAPACITY, DEFAULT_GRID_HEIGHT, QUALITY_FRAMES, STEP_BUDGET_MS, MIN_GRID_HEIGHT, QUALITY_PATH,
    QUALITY_MAGIC, QUALITY_HEADER_INTS, GROUP_SIZE, SPARK_ITERATIONS, INT_SECTIONS, EVENT_COUNT,
    EVENT_MIN, EVENT_COOLDOWN, EVENTS_LOUD, MAX_BODIES, PROBE_INTS, PROBE_VISCOUS, GRAVITY,
    FLIP_RATIO, SOR_OMEGA, SOLVER_SOR, FAN, INIT_GRID, INIT_PARTICLES, CLEAR, P2G, GRID,
    HEAT_SOURCE, HEAT_DIFFUSE, DIVERGENCE, PRESSURE, PROJECT, G2P, SPAWN, MG_SETUP, MG_SMOOTH,
    MG_RESTRICT, MG_PROLONG, MG_COARSE, VISCOSITY, AIR, BODIES, GLOW_EMIT, GLOW_X, GLOW_Y, SPARKS,
    B_GRID_INT, B_GRID_FLOAT, B_MG, B_ALL, GRAVITY_TILT, TILT_FLAT, STANDARD_GRAVITY, levelSize,
    levelCount, QueuedFrame
} from "./defs";
import { SandboxSaves } from "./saves";

// The simulation's recording: the frame's constants (with the tilt sensor's gravity), its steps'
// dispatches (the pressure solve, the sparks and glow), the GPU profiler and step timer, auto
// quality, and the sounds the steps' events play.
export class SandboxSimulation extends SandboxSaves {
    // The constants every entry sees this frame (substep, parity and the brush are set per dispatch).
    fillConstants(dt: number) {
        this.setInt(0, this.gridW);
        this.setInt(1, this.gridH);
        this.setInt(2, this.stride);
        this.setInt(3, CAPACITY);
        this.setFloat(4, dt);
        this.setFloat(5, GRAVITY);
        this.setInt(6, this.frameIndex);
        this.setInt(8, this.tool);
        this.setFloat(14, this.brushRadius);
        this.setInt(15, this.tool == FAN ? this.fanDirection : this.emitType);
        this.setFloat(17, FLIP_RATIO);
        this.setInt(18, this.overlay);
        this.setFloat(19, this.time);
        this.setFloat(20, this.viewX);
        this.setFloat(21, this.viewY);
        this.setFloat(22, this.cellPixels);
        this.setInt(23, this.scene);
        // (multigrid smooths level 0 with pressure_cs too, not over-relaxed)
        this.setFloat(24, this.solver == SOLVER_SOR ? SOR_OMEGA : 1.0);
        this.setFloat(25, this.mouseGridX);
        this.setFloat(26, this.mouseGridY);
        this.setInt(27, this.shapeWord | (this.gravityMode << 8));
        // (tilted: the gravity's direction instead of the point)
        const tilted = this.gravityMode == GRAVITY_TILT;
        if (tilted && !this.tiltFixed) {
            this.readTilt();
        } else {
            Nri_GetGravity(0, Ref(this.sensed[0]));
        }
        this.setFloat(30, tilted ? this.tiltX : this.gravityPointX());
        this.setFloat(31, tilted ? this.tiltY : this.gravityPointY());
    }

    // Electricity, while running: spark_cs's iterations (each one's parity in the substep), with the
    // brush (the Spark tool's).
    recordSparks(commandBuffer: NriCommandBufferHandle, pointerBrush: int) {
        // (a scene's stroke this frame, or the pointer's)
        const brushMode = Math.max(pointerBrush, this.strokeBrush);
        if (!this.computeLayout || this.paused) {
            return;
        }
        const cells = this.gridW * this.gridH;
        this.setInt(9, brushMode);
        for (let k = 0; k < SPARK_ITERATIONS; k++) {
            this.setInt(7, k);
            this.dispatch(commandBuffer, SPARKS, cells, B_GRID_INT);
        }
        this.setInt(9, 0);
    }

    // The glow, from the frame's last step: the cells' light, blurred along x then y.
    recordGlow(commandBuffer: NriCommandBufferHandle) {
        if (!this.computeLayout) {
            return;
        }
        const cells = this.gridW * this.gridH;
        this.dispatch(commandBuffer, GLOW_EMIT, cells, B_GRID_INT);
        this.dispatch(commandBuffer, GLOW_X, cells, B_GRID_INT);
        this.dispatch(commandBuffer, GLOW_Y, cells, B_GRID_INT);
    }

    // steps: the simulation's fixed steps this frame (0 when the frame took less than one).
    recordSimulation(commandBuffer: NriCommandBufferHandle, brushMode: int, steps: int) {
        const computeLayout = this.computeLayout;
        if (!computeLayout) {
            return;
        }
        const cells = this.gridW * this.gridH;
        Nri_CmdSetDescriptorPool(commandBuffer, this.descriptorPool);
        Nri_CmdSetComputePipelineLayout(commandBuffer, computeLayout);
        if (this.needsInit) {
            this.dispatch(commandBuffer, INIT_GRID, this.stride, B_ALL);
            this.dispatch(commandBuffer, INIT_PARTICLES, CAPACITY, B_ALL);
            this.needsInit = false;
            if (this.sceneOnClear) {
                this.buildScene();
            } else {
                this.script = [];
            }
        }
        // The scene's strokes, one a frame while the pointer isn't painting.
        this.strokeBrush = 0;
        if (brushMode == 0 && this.script.length > 0) {
            const stroke = this.script[0];
            this.script.splice(0, 1);
            brushMode = 2;
            this.strokeBrush = 2;
            this.setInt(8, stroke.tool);
            this.setFloat(10, stroke.x0);
            this.setFloat(11, stroke.y0);
            this.setFloat(12, stroke.x1);
            this.setFloat(13, stroke.y1);
            this.setInt(15, stroke.emit);
        }

        if (this.paused || (steps == 0 && brushMode != 0)) {
            // Painting still works (paused, or between steps): the counts, then the brush.
            this.setInt(7, 0);
            this.setInt(9, brushMode);
            this.dispatch(commandBuffer, CLEAR, this.stride * INT_SECTIONS, B_ALL);
            this.dispatch(commandBuffer, P2G, CAPACITY, B_ALL);
            this.dispatch(commandBuffer, SPAWN, cells, B_ALL);
            return;
        }
        for (let s = 0; s < steps; s++) {
            this.setInt(7, s);
            this.setInt(9, s == 0 ? brushMode : 0);
            this.dispatch(commandBuffer, CLEAR, this.stride * INT_SECTIONS, B_ALL);
            this.dispatch(commandBuffer, P2G, CAPACITY, B_ALL);
            this.dispatch(commandBuffer, GRID, this.stride, B_ALL);
            // (only with viscous particles, as the readout a frame or two late says)
            const viscousSweeps = this.probe[PROBE_VISCOUS] != 0 ? this.viscositySweeps : 0;
            for (let k = 0; k < viscousSweeps; k++) {
                for (let parity = 0; parity < 2; parity++) {
                    this.setInt(16, parity);
                    this.dispatch(commandBuffer, VISCOSITY, this.stride, B_GRID_FLOAT);
                }
            }
            // The air once a frame, over its steps.
            if (this.air && s == steps - 1) {
                this.setInt(16, steps);
                this.dispatch(commandBuffer, AIR, 1, B_ALL);
            }
            this.dispatch(commandBuffer, HEAT_SOURCE, cells, B_ALL);
            this.dispatch(commandBuffer, HEAT_DIFFUSE, cells, B_ALL);
            this.dispatch(commandBuffer, DIVERGENCE, cells, B_ALL);
            this.recordPressure(commandBuffer);
            this.dispatch(commandBuffer, PROJECT, this.stride, B_ALL);
            if (this.bodies) {
                this.dispatch(commandBuffer, BODIES, MAX_BODIES * GROUP_SIZE, B_ALL);
            }
            this.dispatch(commandBuffer, G2P, CAPACITY, B_ALL);
            this.dispatch(commandBuffer, SPAWN, cells, B_ALL);
        }
    }

    // The pressure equation solved (F_P, from the last step's): SOR's sweeps, or multigrid's
    // V-cycles (its levels' types and faces set up from level 0's first).
    recordPressure(commandBuffer: NriCommandBufferHandle) {
        const cells = this.gridW * this.gridH;
        if (this.solver == SOLVER_SOR) {
            for (let i = 0; i < this.iterations; i++) {
                this.setInt(16, 0);
                this.dispatch(commandBuffer, PRESSURE, cells, B_GRID_FLOAT);
                this.setInt(16, 1);
                this.dispatch(commandBuffer, PRESSURE, cells, B_GRID_FLOAT);
            }
            return;
        }
        const levels = levelCount(this.gridW, this.gridH);
        for (let l = 1; l < levels; l++) {
            const w = levelSize(this.gridW, l);
            const h = levelSize(this.gridH, l);
            this.setInt(16, l << 8);
            this.dispatch(commandBuffer, MG_SETUP, (w + 1) * (h + 1), B_MG);
        }
        for (let v = 0; v < this.vcycles; v++) {
            for (let l = 0; l < levels - 1; l++) {
                this.recordSmooth(commandBuffer, l);
                this.setInt(16, l << 8);
                this.dispatch(commandBuffer, MG_RESTRICT, levelSize(this.gridW, l + 1) * levelSize(this.gridH, l + 1), B_MG);
            }
            this.setInt(16, (levels - 1) << 8);
            this.dispatch(commandBuffer, MG_COARSE, 1, B_MG);
            for (let l = levels - 2; l >= 0; l--) {
                this.setInt(16, l << 8);
                this.dispatch(commandBuffer, MG_PROLONG, levelSize(this.gridW, l) * levelSize(this.gridH, l),
                    l == 0 ? B_GRID_FLOAT : B_MG);
                this.recordSmooth(commandBuffer, l);
            }
        }
    }

    // -smooth red-black sweeps of a multigrid level (level 0's by pressure_cs).
    recordSmooth(commandBuffer: NriCommandBufferHandle, level: int) {
        const count = levelSize(this.gridW, level) * levelSize(this.gridH, level);
        for (let i = 0; i < this.smooth; i++) {
            for (let parity = 0; parity < 2; parity++) {
                this.setInt(16, parity | (level << 8));
                if (level == 0) {
                    this.dispatch(commandBuffer, PRESSURE, count, B_GRID_FLOAT);
                } else {
                    this.dispatch(commandBuffer, MG_SMOOTH, count, B_MG);
                }
            }
        }
    }

    // Auto quality, once (not in tests, but for -stepBudget): the GPU's step time measured on the
    // U-tube's water, the grid's size chosen from it and cached in QUALITY_PATH; or the cached size.
    startQuality() {
        // (unset: auto, but in a test fixed, unless it gives a budget to measure against)
        const mode = this.quality != "" ? this.quality : (this.test && this.stepBudget == STEP_BUDGET_MS ? "fixed" : "auto");
        if (mode == "fixed" || this.gridHeightSet) {
            return;
        }
        if (mode != "calibrate" && !(this.test && this.quality == "")) {
            const cached = this.readCachedHeight();
            if (cached > 0) {
                this.gridHeight = cached;
                console.log(`Auto quality: the grid's ${cached} cells high (${QUALITY_PATH})`);
                return;
            }
        }
        this.calibrating = true;
        this.calibrationScene = this.scene;
        this.calibrationLevel = this.level;
        this.level = null;
        this.scene = 1;
        this.showMessage("Measuring the GPU...");
    }

    // The grid height QUALITY_PATH holds, or 0.
    readCachedHeight(): int {
        const file = Nri_LoadFile(QUALITY_PATH);
        if (!file) {
            return 0;
        }
        const bytes: int[] = [];
        for (let i = 0; i < QUALITY_HEADER_INTS * 4; i++) {
            bytes.push(0);
        }
        Nri_CopyFileBytes(file, 0, bytes.length, Ref(bytes[0]));
        Nri_DestroyFile(file);
        const ints: int[] = [];
        for (let i = 0; i < QUALITY_HEADER_INTS; i++) {
            ints.push(bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24));
        }
        if (ints[0] != QUALITY_MAGIC || ints[1] < MIN_GRID_HEIGHT || ints[1] > DEFAULT_GRID_HEIGHT) {
            return 0;
        }
        return ints[1];
    }

    // While calibrating: the step time summed over QUALITY_FRAMES, then the grid's size from its mean
    // (smaller when over the budget), cached, and the session begun at it.
    qualityRequests(frameIndex: int) {
        if (!this.calibrating) {
            return;
        }
        if (frameIndex >= QUALITY_FRAMES[0] && this.stepMs > 0.0) {
            this.qualitySum += this.stepMs;
            this.qualityCount++;
        }
        if (frameIndex < QUALITY_FRAMES[1]) {
            return;
        }
        this.calibrating = false;
        const mean = this.qualityCount > 0 ? this.qualitySum / this.qualityCount : 0.0;
        if (mean > this.stepBudget) {
            this.gridHeight = Math.max(Math.min(Math.floor(this.gridHeight * Math.sqrt(this.stepBudget / mean) / 8) * 8,
                this.gridHeight), MIN_GRID_HEIGHT);
        }
        this.fitGrid();
        this.layout();
        console.log(`Auto quality: ${formatFixed(mean, 3)} ms a step (budget ${formatFixed(this.stepBudget, 2)}): the grid ${this.gridW} x ${this.gridH}`);
        // (a test's kept only when it asked for auto quality)
        if ((!this.test || this.quality != "") && this.queuedFrames.length > 0) {
            const header: int[] = [QUALITY_MAGIC, this.gridHeight];
            Nri_SaveBufferToFile(this.queuedFrames[0].probeReadback, 0, Ref(header[0]), QUALITY_HEADER_INTS, QUALITY_PATH);
        }
        // The session, begun at that size.
        this.scene = this.calibrationScene;
        this.level = this.calibrationLevel;
        this.script = [];
        this.sceneOnClear = true;
        this.needsInit = true;
        this.messageTime = 0.0;
    }

    // Sounds for the events the probe's readout carries (its frame's last step's, of steps): each
    // when there are enough, louder the more, then not again for its cooldown.
    playSounds(steps: int, frameTime: number) {
        if (steps <= 0) {
            return;
        }
        for (let k = 0; k < EVENT_COUNT; k++) {
            const events = this.probe[PROBE_INTS + k] * steps;
            this.eventTotals[k] += events;
            this.soundCooldowns[k] -= frameTime;
            // (nested: tslang's && can't take a @cpp handle, issue #23)
            const audio = this.audio;
            if (audio) {
                if (!this.test && events >= EVENT_MIN[k] && this.soundCooldowns[k] <= 0.0) {
                    const loudness = Math.min(0.25 + 0.75 * Math.log(1.0 + events) / Math.log(1.0 + EVENTS_LOUD[k]), 1.0);
                    // (bigger booms lower)
                    const pitch = k == 3 ? 1.2 - 0.5 * Math.min(events / EVENTS_LOUD[k], 1.0) : 0.85 + 0.3 * Math.random();
                    Nri_PlaySound(audio, k, loudness, pitch);
                    this.soundCooldowns[k] = EVENT_COOLDOWN[k] * (0.8 + 0.4 * Math.random());
                }
            }
        }
    }

    // -profile's report, every PROFILE_REPORT timed frames (read once the GPU's done with them).
    readProfile() {
        const profiler = this.profiler;
        if (profiler && profiler.read(this.frameIndex, this.queuedFrames.length)) {
            console.log(`Profile (${this.gridW} x ${this.gridH}, ${CAPACITY - this.probe[0]} particles): ${profiler.report()}`);
            this.profileReports++;
        }
    }

    // The simulation's GPU time per step, from the frame this slot last recorded (finished: latencySleep
    // waited for it), if it stepped.
    readTimestamps(queuedFrame: QueuedFrame) {
        const device = this.device;
        const timestampReadback = queuedFrame.timestampReadback;
        if (!device || !timestampReadback) {
            return;
        }
        const steps = queuedFrame.timedSteps;
        queuedFrame.timedSteps = -1;
        if (steps > 0) {
            const ms = Nri_ReadTimestampIntervalMs(device, timestampReadback, 0, this.querySize);
            if (ms >= 0.0) {
                this.stepMs = ms / steps;
            }
        }
    }

    // The phone's down across the screen (the grid's axes are the window's), from its gravity
    // sensor; kept while it lies flat (under TILT_FLAT g across the screen) or there's no reading.
    readTilt() {
        if (Nri_GetGravity(1, Ref(this.sensed[0])) == 0) {
            return;
        }
        const x = this.sensed[0];
        const y = this.sensed[1];
        const across = Math.sqrt(x * x + y * y);
        if (across > TILT_FLAT * STANDARD_GRAVITY) {
            this.tiltX = x / across;
            this.tiltY = y / across;
        }
    }

    // -tilt x y: the tilted gravity's direction, instead of the sensor's.
    setTilt(x: number, y: number) {
        const length = Math.sqrt(x * x + y * y);
        if (length > 0.0) {
            this.tiltX = x / length;
            this.tiltY = y / length;
            this.tiltFixed = true;
        }
    }
}

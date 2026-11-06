/// <reference path="../core/nri/nri_interop.d.ts" />
import { formatFixed } from "../core/text_format";
import {
    CAPACITY, DEFAULT_GRID_HEIGHT, QUALITY_FRAMES, STEP_BUDGET_MS, MIN_GRID_HEIGHT, QUALITY_PATH,
    QUALITY_MAGIC, GROUP_SIZE, SPARK_ITERATIONS, INT_SECTIONS, EVENT_COUNT,
    MAX_BODIES, PROBE_INTS, PROBE_VISCOUS, GRAVITY,
    FLIP_RATIO, SOR_OMEGA, SOLVER_SOR, FAN, INIT_GRID, INIT_PARTICLES, CLEAR, P2G, GRID,
    HEAT_SOURCE, HEAT_DIFFUSE, DIVERGENCE, PRESSURE, PROJECT, G2P, SPAWN, MG_SETUP, MG_SMOOTH,
    MG_RESTRICT, MG_PROLONG, MG_COARSE, VISCOSITY, AIR, BODIES, GLOW_EMIT, GLOW_X, GLOW_Y, SPARKS,
    B_GRID_INT, B_GRID_FLOAT, B_MG, B_ALL, GRAVITY_TILT, TILT_FLAT, STANDARD_GRAVITY, levelSize,
    levelCount, QueuedFrame
} from "./defs";
import { SandboxSaves } from "./saves";
import { Nri, NriCommandBuffer } from "../core/nri";
import { IntFile } from "../core/int_file";
import { AutoQuality } from "../core/auto_quality";

// The simulation's recording: the frame's constants (with the tilt sensor's gravity), its steps'
// dispatches (the pressure solve, the sparks and glow), the GPU profiler and step timer, auto
// quality, and the sounds the steps' events play.
export class SandboxSimulation extends SandboxSaves {
    // The constants every entry sees this frame (substep, parity and the brush are set per dispatch).
    fillConstants(dt: number) {
        this.kernels.setInt(0, this.gridW);
        this.kernels.setInt(1, this.gridH);
        this.kernels.setInt(2, this.stride);
        this.kernels.setInt(3, CAPACITY);
        this.kernels.setFloat(4, dt);
        this.kernels.setFloat(5, GRAVITY);
        this.kernels.setInt(6, this.frameIndex);
        this.kernels.setInt(8, this.tool);
        this.kernels.setFloat(14, this.brushRadius);
        this.kernels.setInt(15, this.tool == FAN ? this.fanDirection : this.emitType);
        this.kernels.setFloat(17, FLIP_RATIO);
        this.kernels.setInt(18, this.overlay);
        this.kernels.setFloat(19, this.time);
        this.kernels.setFloat(20, this.panZoom.originX);
        this.kernels.setFloat(21, this.panZoom.originY);
        this.kernels.setFloat(22, this.panZoom.scale);
        this.kernels.setInt(23, this.scene);
        // (multigrid smooths level 0 with pressure_cs too, not over-relaxed)
        this.kernels.setFloat(24, this.solver == SOLVER_SOR ? SOR_OMEGA : 1.0);
        this.kernels.setFloat(25, this.mouseGridX);
        this.kernels.setFloat(26, this.mouseGridY);
        this.kernels.setInt(27, this.shapeWord | (this.gravityMode << 8));
        // (tilted: the gravity's direction instead of the point)
        const tilted = this.gravityMode == GRAVITY_TILT;
        if (tilted && !this.tiltFixed) {
            this.readTilt();
        } else {
            Nri.getGravity(0, Ref(this.sensed[0]));
        }
        this.kernels.setFloat(30, tilted ? this.tiltX : this.gravityPointX());
        this.kernels.setFloat(31, tilted ? this.tiltY : this.gravityPointY());
    }

    // Electricity, while running: spark_cs's iterations (each one's parity in the substep), with the
    // brush (the Spark tool's).
    recordSparks(commandBuffer: NriCommandBuffer, pointerBrush: int) {
        // (a scene's stroke this frame, or the pointer's)
        const brushMode = Math.max(pointerBrush, this.strokeBrush);
        if (!this.computeLayout || this.paused) {
            return;
        }
        const cells = this.gridW * this.gridH;
        this.kernels.setInt(9, brushMode);
        for (let k = 0; k < SPARK_ITERATIONS; k++) {
            this.kernels.setInt(7, k);
            this.kernels.dispatch(commandBuffer, SPARKS, cells, B_GRID_INT);
        }
        this.kernels.setInt(9, 0);
    }

    // The glow, from the frame's last step: the cells' light, blurred along x then y.
    recordGlow(commandBuffer: NriCommandBuffer) {
        if (!this.computeLayout) {
            return;
        }
        const cells = this.gridW * this.gridH;
        this.kernels.dispatch(commandBuffer, GLOW_EMIT, cells, B_GRID_INT);
        this.kernels.dispatch(commandBuffer, GLOW_X, cells, B_GRID_INT);
        this.kernels.dispatch(commandBuffer, GLOW_Y, cells, B_GRID_INT);
    }

    // steps: the simulation's fixed steps this frame (0 when the frame took less than one).
    recordSimulation(commandBuffer: NriCommandBuffer, brushMode: int, steps: int) {
        const computeLayout = this.computeLayout;
        if (!computeLayout) {
            return;
        }
        const cells = this.gridW * this.gridH;
        commandBuffer.setDescriptorPool(this.descriptorPool);
        commandBuffer.setComputePipelineLayout(computeLayout);
        if (this.needsInit) {
            this.kernels.dispatch(commandBuffer, INIT_GRID, this.stride, B_ALL);
            this.kernels.dispatch(commandBuffer, INIT_PARTICLES, CAPACITY, B_ALL);
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
            this.kernels.setInt(8, stroke.tool);
            this.kernels.setFloat(10, stroke.x0);
            this.kernels.setFloat(11, stroke.y0);
            this.kernels.setFloat(12, stroke.x1);
            this.kernels.setFloat(13, stroke.y1);
            this.kernels.setInt(15, stroke.emit);
        }

        if (this.paused || (steps == 0 && brushMode != 0)) {
            // Painting still works (paused, or between steps): the counts, then the brush.
            this.kernels.setInt(7, 0);
            this.kernels.setInt(9, brushMode);
            this.kernels.dispatch(commandBuffer, CLEAR, this.stride * INT_SECTIONS, B_ALL);
            this.kernels.dispatch(commandBuffer, P2G, CAPACITY, B_ALL);
            this.kernels.dispatch(commandBuffer, SPAWN, cells, B_ALL);
            return;
        }
        for (let s = 0; s < steps; s++) {
            this.kernels.setInt(7, s);
            this.kernels.setInt(9, s == 0 ? brushMode : 0);
            this.kernels.dispatch(commandBuffer, CLEAR, this.stride * INT_SECTIONS, B_ALL);
            this.kernels.dispatch(commandBuffer, P2G, CAPACITY, B_ALL);
            this.kernels.dispatch(commandBuffer, GRID, this.stride, B_ALL);
            // (only with viscous particles, as the readout a frame or two late says)
            const viscousSweeps = this.probe[PROBE_VISCOUS] != 0 ? this.viscositySweeps : 0;
            for (let k = 0; k < viscousSweeps; k++) {
                for (let parity = 0; parity < 2; parity++) {
                    this.kernels.setInt(16, parity);
                    this.kernels.dispatch(commandBuffer, VISCOSITY, this.stride, B_GRID_FLOAT);
                }
            }
            // The air once a frame, over its steps.
            if (this.air && s == steps - 1) {
                this.kernels.setInt(16, steps);
                this.kernels.dispatch(commandBuffer, AIR, 1, B_ALL);
            }
            this.kernels.dispatch(commandBuffer, HEAT_SOURCE, cells, B_ALL);
            this.kernels.dispatch(commandBuffer, HEAT_DIFFUSE, cells, B_ALL);
            this.kernels.dispatch(commandBuffer, DIVERGENCE, cells, B_ALL);
            this.recordPressure(commandBuffer);
            this.kernels.dispatch(commandBuffer, PROJECT, this.stride, B_ALL);
            if (this.bodies) {
                this.kernels.dispatch(commandBuffer, BODIES, MAX_BODIES * GROUP_SIZE, B_ALL);
            }
            this.kernels.dispatch(commandBuffer, G2P, CAPACITY, B_ALL);
            this.kernels.dispatch(commandBuffer, SPAWN, cells, B_ALL);
        }
    }

    // The pressure equation solved (F_P, from the last step's): SOR's sweeps, or multigrid's
    // V-cycles (its levels' types and faces set up from level 0's first).
    recordPressure(commandBuffer: NriCommandBuffer) {
        const cells = this.gridW * this.gridH;
        if (this.solver == SOLVER_SOR) {
            for (let i = 0; i < this.iterations; i++) {
                this.kernels.setInt(16, 0);
                this.kernels.dispatch(commandBuffer, PRESSURE, cells, B_GRID_FLOAT);
                this.kernels.setInt(16, 1);
                this.kernels.dispatch(commandBuffer, PRESSURE, cells, B_GRID_FLOAT);
            }
            return;
        }
        const levels = levelCount(this.gridW, this.gridH);
        for (let l = 1; l < levels; l++) {
            const w = levelSize(this.gridW, l);
            const h = levelSize(this.gridH, l);
            this.kernels.setInt(16, l << 8);
            this.kernels.dispatch(commandBuffer, MG_SETUP, (w + 1) * (h + 1), B_MG);
        }
        for (let v = 0; v < this.vcycles; v++) {
            for (let l = 0; l < levels - 1; l++) {
                this.recordSmooth(commandBuffer, l);
                this.kernels.setInt(16, l << 8);
                this.kernels.dispatch(commandBuffer, MG_RESTRICT, levelSize(this.gridW, l + 1) * levelSize(this.gridH, l + 1), B_MG);
            }
            this.kernels.setInt(16, (levels - 1) << 8);
            this.kernels.dispatch(commandBuffer, MG_COARSE, 1, B_MG);
            for (let l = levels - 2; l >= 0; l--) {
                this.kernels.setInt(16, l << 8);
                this.kernels.dispatch(commandBuffer, MG_PROLONG, levelSize(this.gridW, l) * levelSize(this.gridH, l),
                    l == 0 ? B_GRID_FLOAT : B_MG);
                this.recordSmooth(commandBuffer, l);
            }
        }
    }

    // -smooth red-black sweeps of a multigrid level (level 0's by pressure_cs).
    recordSmooth(commandBuffer: NriCommandBuffer, level: int) {
        const count = levelSize(this.gridW, level) * levelSize(this.gridH, level);
        for (let i = 0; i < this.smooth; i++) {
            for (let parity = 0; parity < 2; parity++) {
                this.kernels.setInt(16, parity | (level << 8));
                if (level == 0) {
                    this.kernels.dispatch(commandBuffer, PRESSURE, count, B_GRID_FLOAT);
                } else {
                    this.kernels.dispatch(commandBuffer, MG_SMOOTH, count, B_MG);
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
        this.calibration.start(QUALITY_FRAMES[0], QUALITY_FRAMES[1]);
        this.calibrationScene = this.scene;
        this.calibrationLevel = this.level;
        this.level = null;
        this.scene = 1;
        this.showMessage("Measuring the GPU...");
    }

    // The grid height QUALITY_PATH holds, or 0.
    readCachedHeight(): int {
        const ints = IntFile.read(QUALITY_PATH, QUALITY_MAGIC, 1);
        if (!ints || ints.length < 1 || ints[0] < MIN_GRID_HEIGHT || ints[0] > DEFAULT_GRID_HEIGHT) {
            return 0;
        }
        return ints[0];
    }

    // While calibrating: the step time averaged over QUALITY_FRAMES, then the grid's size from its mean
    // (smaller when over the budget), cached, and the session begun at it.
    qualityRequests(frameIndex: int) {
        if (!this.calibration.sample(frameIndex, this.stepMs)) {
            return;
        }
        const mean = this.calibration.mean();
        this.gridHeight = AutoQuality.fit(this.gridHeight, mean, this.stepBudget, 8, MIN_GRID_HEIGHT);
        this.fitGrid();
        this.layout();
        console.log(`Auto quality: ${formatFixed(mean, 3)} ms a step (budget ${formatFixed(this.stepBudget, 2)}): the grid ${this.gridW} x ${this.gridH}`);
        // (a test's kept only when it asked for auto quality)
        if (!this.test || this.quality != "") {
            IntFile.write(QUALITY_PATH, QUALITY_MAGIC, [this.gridHeight]);
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
            this.sounds.update(k, this.probe[PROBE_INTS + k] * steps, frameTime, this.audio, !this.test);
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
        const steps = queuedFrame.timedSteps;
        queuedFrame.timedSteps = -1;
        const ms = this.gpuTimer.read(this.frameIndex);
        if (steps > 0 && ms >= 0.0) {
            this.stepMs = ms / steps;
        }
    }

    // The phone's down across the screen (the grid's axes are the window's), from its gravity
    // sensor; kept while it lies flat (under TILT_FLAT g across the screen) or there's no reading.
    readTilt() {
        if (Nri.getGravity(1, Ref(this.sensed[0])) == 0) {
            return;
        }
        const x: number = this.sensed[0];
        const y: number = this.sensed[1];
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

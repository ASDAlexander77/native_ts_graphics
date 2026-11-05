// A GPU profiler for NRI apps: every so many frames, a timestamp after each piece of work the frame
// records (a dispatch, say, by its id), read back once the GPU's done with that frame; the
// intervals summed per id, and every so many timed frames a report: the mean milliseconds a frame,
// then the costliest ids'.
//
// Imported with `import { NriGpuProfiler } from "../core/nri_gpu_profiler";`, and listed (with
// core/text_format.ts) in the app's add_tslang_nri_example sources. A frame: begin, a mark after each piece of work, end; then,
// each frame, read (true when a report's ready) and report.

/// <reference path="nri/nri_interop.d.ts" />
import { formatFixed } from "./text_format";
import { NriBuffer, NriCommandBuffer, NriDevice, NriQueryPool } from "./nri";

// The most ids a report names.
const REPORT_TOP = 12;

@final
export class NriGpuProfiler {
    private device: NriDevice | null = null;
    private pool: NriQueryPool | null = null;
    private readback: NriBuffer | null = null;
    private querySize: int = 0;
    private capacity: int = 0;
    private every: int = 1;
    private reportFrames: int = 1;
    private names: string[] = [];
    // The ids the frame being timed marked (one a timestamp after the first), whether one's being
    // recorded, the frame whose timestamps wait to be read (-1: none), and the sums since the report.
    private marks: int[] = [];
    private recording: boolean = false;
    private pendingFrame: int = -1;
    private sums: number[] = [];
    private frames: int = 0;

    // Timing every `every` frames, up to capacity timestamps a frame, ids named by names (an id is
    // its index); a report every reportFrames timed frames. False if timestamps can't be had.
    init(device: NriDevice, names: string[], capacity: int, every: int, reportFrames: int): boolean {
        const pool = device.createTimestampQueryPool(capacity);
        if (!pool) {
            return false;
        }
        this.pool = pool;
        this.querySize = pool.getQuerySize();
        if (this.querySize <= 0) {
            return false;
        }
        this.readback = device.createReadbackBuffer(capacity * this.querySize);
        if (!this.readback) {
            return false;
        }
        this.device = device;
        this.capacity = capacity;
        this.every = Math.max(every, 1);
        this.reportFrames = Math.max(reportFrames, 1);
        for (const name of names) {
            this.names.push(name);
            this.sums.push(0.0);
        }
        return true;
    }

    // Frame frameIndex timed, if it's one to time (and the last one's were read): its first timestamp.
    begin(commandBuffer: NriCommandBuffer, frameIndex: int) {
        const pool = this.pool;
        if (!pool || this.pendingFrame >= 0 || frameIndex % this.every != 0) {
            return;
        }
        commandBuffer.resetQueries(pool, 0, this.capacity);
        commandBuffer.writeTimestamp(pool, 0);
        this.marks = [];
        this.recording = true;
    }

    // A timestamp after the work id, if this frame's timed (and there's room).
    mark(commandBuffer: NriCommandBuffer, id: int) {
        const pool = this.pool;
        if (!pool || !this.recording || this.marks.length + 1 >= this.capacity) {
            return;
        }
        this.marks.push(id);
        commandBuffer.writeTimestamp(pool, this.marks.length);
    }

    // The timed frame's timestamps copied for reading.
    end(commandBuffer: NriCommandBuffer, frameIndex: int) {
        const pool = this.pool;
        const readback = this.readback;
        if (!this.recording || !pool || !readback) {
            return;
        }
        this.recording = false;
        commandBuffer.copyQueries(pool, 0, this.marks.length + 1, readback, 0);
        this.pendingFrame = frameIndex;
    }

    // The timed frame's intervals into the sums, once the GPU's done with it (framesInFlight frames
    // on); true when there are reportFrames of them, for report.
    read(frameIndex: int, framesInFlight: int): boolean {
        const device = this.device;
        const readback = this.readback;
        if (!device || !readback || this.pendingFrame < 0 || frameIndex - this.pendingFrame < framesInFlight) {
            return false;
        }
        this.pendingFrame = -1;
        for (let i = 0; i < this.marks.length; i++) {
            const ms = device.readTimestampIntervalMs(readback, i * this.querySize, (i + 1) * this.querySize);
            if (ms >= 0.0) {
                this.sums[this.marks[i]] += ms;
            }
        }
        this.frames++;
        return this.frames >= this.reportFrames;
    }

    // "T ms a frame; name ms name ms ...": the mean of the timed frames, then the costliest ids' (at
    // most REPORT_TOP); the sums start again.
    report(): string {
        let total = 0.0;
        for (const sum of this.sums) {
            total += sum;
        }
        let report = `${formatFixed(total / this.frames, 2)} ms a frame;`;
        const shown: boolean[] = [];
        for (let k = 0; k < this.names.length; k++) {
            shown.push(false);
        }
        for (let n = 0; n < REPORT_TOP; n++) {
            let best = -1;
            for (let k = 0; k < this.names.length; k++) {
                if (!shown[k] && (best < 0 || this.sums[k] > this.sums[best])) {
                    best = k;
                }
            }
            if (best < 0 || this.sums[best] <= 0.0) {
                break;
            }
            shown[best] = true;
            report = `${report} ${this.names[best]} ${formatFixed(this.sums[best] / this.frames, 2)}`;
        }
        for (let k = 0; k < this.sums.length; k++) {
            this.sums[k] = 0.0;
        }
        this.frames = 0;
        return report;
    }

    destroy() {
        const pool = this.pool;
        if (pool) {
            pool.destroy();
        }
        const readback = this.readback;
        if (readback) {
            readback.destroy();
        }
        this.pool = null;
        this.readback = null;
    }
}

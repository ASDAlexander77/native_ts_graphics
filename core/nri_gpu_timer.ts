// The GPU's time for a span of a frame's work: two timestamps around it, copied to a readback buffer
// of the frame's slot, read when the slot comes round again (once the frame ring's wait has seen it
// done). Without timestamp queries it times nothing: read gives -1.
//
// Imported with `import { NriGpuTimer } from "../core/nri_gpu_timer";` (add_tslang_nri_example
// adds it to the app's sources). Each frame: read(frameIndex) (the time the slot's last frame
// measured), then begin and end around the work recorded.

/// <reference path="nri/nri_interop.d.ts" />
import { NriBuffer, NriCommandBuffer, NriDevice, NriQueryPool } from "./nri";

@final
export class NriGpuTimer {
    private device: NriDevice | null = null;
    private queryPool: NriQueryPool | null = null;
    private querySize: int = 8;
    // Each slot's readback, and whether it holds a time not read yet.
    private readbacks: NriBuffer[] = [];
    private pending: boolean[] = [];

    // count slots (the frames in flight). Whether the GPU can time (else the timer does nothing).
    init(device: NriDevice, count: int): boolean {
        const queryPool = device.createTimestampQueryPool(2 * count);
        if (!queryPool) {
            return false;
        }
        this.device = device;
        this.queryPool = queryPool;
        this.querySize = queryPool.getQuerySize();
        for (let i = 0; i < count; i++) {
            const readback = device.createReadbackBuffer(2 * this.querySize);
            if (!readback) {
                this.destroy();
                return false;
            }
            this.readbacks.push(readback);
            this.pending.push(false);
        }
        return true;
    }

    // Whether it times (init found timestamp queries).
    active(): boolean {
        return this.readbacks.length > 0;
    }

    // The span's start, in frame frameIndex's command buffer.
    begin(commandBuffer: NriCommandBuffer, frameIndex: int) {
        const queryPool = this.queryPool;
        if (!queryPool || this.readbacks.length == 0) {
            return;
        }
        const base = (frameIndex % this.readbacks.length) * 2;
        commandBuffer.resetQueries(queryPool, base, 2);
        commandBuffer.writeTimestamp(queryPool, base);
    }

    // The span's end, and its timestamps copied for read. Whether it's timed.
    end(commandBuffer: NriCommandBuffer, frameIndex: int): boolean {
        const queryPool = this.queryPool;
        if (!queryPool || this.readbacks.length == 0) {
            return false;
        }
        const slot = frameIndex % this.readbacks.length;
        commandBuffer.writeTimestamp(queryPool, slot * 2 + 1);
        commandBuffer.copyQueries(queryPool, slot * 2, 2, this.readbacks[slot], 0);
        this.pending[slot] = true;
        return true;
    }

    // The span's time in ms, from the frame that last used frameIndex's slot (done: the frame ring
    // waited for it), or -1: none timed since the last read, or it can't be read.
    read(frameIndex: int): number {
        const device = this.device;
        if (!device || this.readbacks.length == 0) {
            return -1.0;
        }
        const slot = frameIndex % this.readbacks.length;
        if (!this.pending[slot]) {
            return -1.0;
        }
        this.pending[slot] = false;
        return device.readTimestampIntervalMs(this.readbacks[slot], 0, this.querySize);
    }

    // (after the device is idle)
    destroy() {
        for (const readback of this.readbacks) {
            readback.destroy();
        }
        this.readbacks = [];
        this.pending = [];
        const queryPool = this.queryPool;
        if (queryPool) {
            queryPool.destroy();
        }
        this.queryPool = null;
        this.device = null;
    }
}

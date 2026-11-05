// The frames in flight of an NRI app: a command allocator and buffer for each of the sample's queued
// frames, used in turn, and the fence that says when the GPU's done with one. Frame frameIndex uses
// slot frameIndex % size(); before it records, wait (the latency sleep's work) waits for the frame
// that used its slot last and resets its allocator, and once it's submitted, signal marks it.
//
// Imported with `import { NriFrameRing } from "../core/nri_frame_ring";` (add_tslang_nri_example
// adds it, and core/nri.ts, to the app's sources). What else an app keeps per frame (readbacks,
// say) it keeps in its own array, indexed by slot.

/// <reference path="nri/nri_interop.d.ts" />
import { NriCommandAllocator, NriCommandBuffer, NriDevice, NriFence, NriQueue } from "./nri";

@final
export class NriFrameRing {
    private queue: NriQueue;
    private frameFence: NriFence;
    private allocators: NriCommandAllocator[] = [];
    private commandBuffers: NriCommandBuffer[] = [];
    private created: boolean = false;

    // count frames in flight (NriSample.getQueuedFrameNum), submitted to queue.
    init(device: NriDevice, queue: NriQueue, count: int) {
        this.queue = queue;
        this.frameFence = device.createFence(0);
        for (let i = 0; i < count; i++) {
            const allocator = this.queue.createCommandAllocator();
            this.allocators.push(allocator);
            this.commandBuffers.push(allocator.createCommandBuffer());
        }
        this.created = true;
    }

    size(): int {
        return this.allocators.length;
    }

    slot(frameIndex: int): int {
        return frameIndex % this.allocators.length;
    }

    // Waits for the frame that last used frameIndex's slot (size() frames before), and resets the
    // slot's allocator for frameIndex to record with.
    wait(frameIndex: int) {
        const count = this.allocators.length;
        this.frameFence.wait(frameIndex >= count ? 1 + frameIndex - count : 0);
        this.allocators[frameIndex % count].reset();
    }

    commandBuffer(frameIndex: int): NriCommandBuffer {
        return this.commandBuffers[frameIndex % this.commandBuffers.length];
    }

    // The fence: frame frameIndex done at 1 + frameIndex (for other work to wait on, a compute
    // queue's, say).
    fence(): NriFence {
        return this.frameFence;
    }

    // Frame frameIndex's work submitted (and presented, as NRISamples signal after the present).
    signal(frameIndex: int) {
        this.queue.signal(this.frameFence, 1 + frameIndex);
    }

    // (after the device is idle)
    destroy() {
        if (!this.created) {
            return;
        }
        for (let i = 0; i < this.allocators.length; i++) {
            this.commandBuffers[i].destroy();
            this.allocators[i].destroy();
        }
        this.allocators = [];
        this.commandBuffers = [];
        this.frameFence.destroy();
        this.created = false;
    }
}

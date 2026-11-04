// The frames in flight of an NRI app: a command allocator and buffer for each of the sample's queued
// frames, used in turn, and the fence that says when the GPU's done with one. Frame frameIndex uses
// slot frameIndex % size(); before it records, wait (the latency sleep's work) waits for the frame
// that used its slot last and resets its allocator, and once it's submitted, signal marks it.
//
// Imported with `import { NriFrameRing } from "../core/nri_frame_ring";`, and listed in the app's
// add_tslang_nri_example sources. What else an app keeps per frame (readbacks, say) it keeps in its
// own array, indexed by slot.

/// <reference path="nri/nri_interop.d.ts" />

@final
export class NriFrameRing {
    private queue: NriQueueHandle;
    private fence: NriFenceHandle;
    private allocators: NriCommandAllocatorHandle[] = [];
    private commandBuffers: NriCommandBufferHandle[] = [];
    private created: boolean = false;

    // count frames in flight (Nri_GetQueuedFrameNum), submitted to queue.
    init(device: NriDeviceHandle, queue: NriQueueHandle, count: int) {
        this.queue = queue;
        this.fence = Nri_CreateFence(device, 0);
        for (let i = 0; i < count; i++) {
            const allocator = Nri_CreateCommandAllocator(queue);
            this.allocators.push(allocator);
            this.commandBuffers.push(Nri_CreateCommandBuffer(allocator));
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
        Nri_Wait(this.fence, frameIndex >= count ? 1 + frameIndex - count : 0);
        Nri_ResetCommandAllocator(this.allocators[frameIndex % count]);
    }

    commandBuffer(frameIndex: int): NriCommandBufferHandle {
        return this.commandBuffers[frameIndex % this.commandBuffers.length];
    }

    // Frame frameIndex's work submitted (and presented, as NRISamples signal after the present).
    signal(frameIndex: int) {
        Nri_QueueSignal(this.queue, this.fence, 1 + frameIndex);
    }

    // (after the device is idle)
    destroy() {
        if (!this.created) {
            return;
        }
        for (let i = 0; i < this.allocators.length; i++) {
            Nri_DestroyCommandBuffer(this.commandBuffers[i]);
            Nri_DestroyCommandAllocator(this.allocators[i]);
        }
        this.allocators = [];
        this.commandBuffers = [];
        Nri_DestroyFence(this.fence);
        this.created = false;
    }
}

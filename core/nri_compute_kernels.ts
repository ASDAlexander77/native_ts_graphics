// An NRI app's compute kernels: pipelines (a kernel is its index) that share one pipeline layout,
// one descriptor set and one block of root constants, dispatched over so many threads with a
// barrier after each on the storage buffers its mask names (bit i: the i-th buffer bound).
//
// Imported with `import { NriComputeKernels } from "../core/nri_compute_kernels";`, and listed (with
// core/nri_gpu_profiler.ts) in the app's add_tslang_nri_example sources. init sizes the constants
// (they can be set from then on); bind, once the pipelines, the set and the buffers are made, gives
// it them (the app still owns and destroys them). The app sets the layout and the descriptor pool
// on the command buffer before dispatching.

/// <reference path="nri/nri_interop.d.ts" />
import { NriGpuProfiler } from "./nri_gpu_profiler";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptorSet, NriPipeline } from "./nri";

@final
export class NriComputeKernels {
    private constants: f32[] = [];
    private constantsSize: int = 0;
    private groupSize: int = 64;
    private pipelines: NriPipeline[] = [];
    private set: NriDescriptorSet | null = null;
    private buffers: NriBuffer[] = [];
    private profiler: NriGpuProfiler | null = null;

    // constantFloats 32-bit root constants (zero), and kernels groupSize threads a group.
    init(constantFloats: int, groupSize: int) {
        this.constants = [];
        for (let i = 0; i < constantFloats; i++) {
            this.constants.push(0.0);
        }
        this.constantsSize = constantFloats * 4;
        this.groupSize = Math.max(groupSize, 1);
    }

    // The kernels' pipelines, their descriptor set, and the buffers barrier masks name, in order. It
    // keeps wrappers of its own of them (handles; the caller keeps theirs, and destroys the objects).
    bind(pipelines: NriPipeline[], set: NriDescriptorSet, buffers: NriBuffer[]) {
        this.pipelines = [];
        for (const pipeline of pipelines) {
            this.pipelines.push(new NriPipeline(pipeline.handle));
        }
        this.set = new NriDescriptorSet(set.handle);
        this.buffers = [];
        for (const buffer of buffers) {
            this.buffers.push(new NriBuffer(buffer.handle));
        }
    }

    // A timestamp after each dispatch, marked with its kernel (when the profiler's timing a frame).
    // The kernels keep the profiler (under -mm=own an object has one owner); the app reaches it
    // through getProfiler(), to begin, end, read and destroy it.
    @keeps("profiler")
    setProfiler(profiler: NriGpuProfiler | null) {
        this.profiler = profiler;
    }

    @lends("this")
    getProfiler(): NriGpuProfiler | null {
        return this.profiler;
    }

    // The profiler given up to the caller, who owns it then (and gives it back with setProfiler):
    // under -mm=own its begin, end and destroy, which overwrite its fields, can't run on a borrow
    // of it, as getProfiler's is.
    takeProfiler(): NriGpuProfiler | null {
        let profiler: NriGpuProfiler | null = null;
        [profiler, this.profiler] = [this.profiler, profiler];
        return profiler;
    }

    setFloat(index: int, value: number) {
        this.constants[index] = value;
    }

    setInt(index: int, value: int) {
        Nri.storeInt32(Ref(this.constants[index]), value);
    }

    // The same constants for a draw (root constants 0 of its layout).
    setGraphicsConstants(commandBuffer: NriCommandBuffer) {
        commandBuffer.setRootConstants(0, Ref(this.constants[0]), this.constantsSize);
    }

    // Barriers from before to after on the buffers in mask.
    barriers(commandBuffer: NriCommandBuffer, mask: int, before: NriBufferState, after: NriBufferState) {
        for (let i = 0; i < this.buffers.length; i++) {
            if ((mask & (1 << i)) != 0) {
                commandBuffer.bufferBarrier(this.buffers[i], before, after);
            }
        }
    }

    // kernel over threads threads (in groups), with the constants as they are, then a barrier on the
    // buffers in barrierMask (storage to storage).
    dispatch(commandBuffer: NriCommandBuffer, kernel: int, threads: int, barrierMask: int) {
        const set = this.set;
        if (!set) {
            return;
        }
        commandBuffer.setPipeline(this.pipelines[kernel]);
        commandBuffer.setComputeRootConstants(0, Ref(this.constants[0]), this.constantsSize);
        commandBuffer.setComputeDescriptorSet(0, set);
        commandBuffer.dispatch(Math.floor((threads + this.groupSize - 1) / this.groupSize), 1, 1);
        this.barriers(commandBuffer, barrierMask, NriBufferState.Storage, NriBufferState.Storage);
        const profiler = this.profiler;
        if (profiler) {
            profiler.mark(commandBuffer, kernel);
        }
    }
}

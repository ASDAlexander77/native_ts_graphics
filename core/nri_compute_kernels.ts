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

@final
export class NriComputeKernels {
    private constants: f32[] = [];
    private constantsSize: int = 0;
    private groupSize: int = 64;
    private pipelines: NriPipelineHandle[] = [];
    private set: NriDescriptorSetHandle | null = null;
    private buffers: NriBufferHandle[] = [];
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

    // The kernels' pipelines, their descriptor set, and the buffers barrier masks name, in order.
    bind(pipelines: NriPipelineHandle[], set: NriDescriptorSetHandle, buffers: NriBufferHandle[]) {
        this.pipelines = [];
        for (const pipeline of pipelines) {
            this.pipelines.push(pipeline);
        }
        this.set = set;
        this.buffers = [];
        for (const buffer of buffers) {
            this.buffers.push(buffer);
        }
    }

    // A timestamp after each dispatch, marked with its kernel (when the profiler's timing a frame).
    setProfiler(profiler: NriGpuProfiler | null) {
        this.profiler = profiler;
    }

    setFloat(index: int, value: number) {
        this.constants[index] = value;
    }

    setInt(index: int, value: int) {
        Nri_StoreInt32(Ref(this.constants[index]), value);
    }

    // The same constants for a draw (root constants 0 of its layout).
    setGraphicsConstants(commandBuffer: NriCommandBufferHandle) {
        Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.constants[0]), this.constantsSize);
    }

    // Barriers from before to after on the buffers in mask.
    barriers(commandBuffer: NriCommandBufferHandle, mask: int, before: NriBufferState, after: NriBufferState) {
        for (let i = 0; i < this.buffers.length; i++) {
            if ((mask & (1 << i)) != 0) {
                Nri_CmdBufferBarrier(commandBuffer, this.buffers[i], before, after);
            }
        }
    }

    // kernel over threads threads (in groups), with the constants as they are, then a barrier on the
    // buffers in barrierMask (storage to storage).
    dispatch(commandBuffer: NriCommandBufferHandle, kernel: int, threads: int, barrierMask: int) {
        const set = this.set;
        if (!set) {
            return;
        }
        Nri_CmdSetPipeline(commandBuffer, this.pipelines[kernel]);
        Nri_CmdSetComputeRootConstants(commandBuffer, 0, Ref(this.constants[0]), this.constantsSize);
        Nri_CmdSetComputeDescriptorSet(commandBuffer, 0, set);
        Nri_CmdDispatch(commandBuffer, Math.floor((threads + this.groupSize - 1) / this.groupSize), 1, 1);
        this.barriers(commandBuffer, barrierMask, NriBufferState.Storage, NriBufferState.Storage);
        const profiler = this.profiler;
        if (profiler) {
            profiler.mark(commandBuffer, kernel);
        }
    }
}

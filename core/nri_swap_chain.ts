// The swap chain of an NRI app: made at the window's size (Nri_GetQueuedFrameNum + 1 textures), a
// color attachment view and a pair of semaphores for each texture, made again when the window's
// resized, and the acquire, submit and present of a frame.
//
// Imported with `import { NriSwapChain } from "../core/nri_swap_chain";`, and listed in the app's
// add_tslang_nri_example sources. Each frame: resized() (and recreate() when it is), acquire, record
// into texture(i) through colorAttachment(i), submit, present. What the app keeps at the window's
// size (targets, a layout) it makes again itself when recreate() runs.

/// <reference path="nri/nri_interop.d.ts" />

@final
export class NriSwapChain {
    private sample: NriSampleHandle;
    private device: NriDeviceHandle;
    private queue: NriQueueHandle;
    private swapChain: NriSwapChainHandle;
    private srgb: boolean = false;
    private outputWidth: int = 0;
    private outputHeight: int = 0;
    private textureFormat: NriFormat = NriFormat.Unknown;
    private attachmentFormat: NriFormat = NriFormat.Unknown;
    private textures: NriTextureHandle[] = [];
    private views: NriDescriptorHandle[] = [];
    private acquireSemaphores: NriFenceHandle[] = [];
    private releaseSemaphores: NriFenceHandle[] = [];
    // The acquire semaphore of the frame acquired last (its submit waits on it).
    private acquired: int = 0;
    private created: boolean = false;

    // srgb: the views are the texture format's sRGB form (the GPU encodes the colors); else the
    // texture's own format (the app writes its colors as they are).
    init(sample: NriSampleHandle, device: NriDeviceHandle, queue: NriQueueHandle, srgb: boolean) {
        this.sample = sample;
        this.device = device;
        this.queue = queue;
        this.srgb = srgb;
        this.create();
    }

    private create() {
        this.outputWidth = Nri_GetOutputWidth(this.sample);
        this.outputHeight = Nri_GetOutputHeight(this.sample);
        this.swapChain = Nri_CreateSwapChain(this.sample, this.device, this.queue, Nri_GetQueuedFrameNum(this.sample) + 1);
        const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
        this.textureFormat = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
        this.attachmentFormat = this.srgb ? Nri_GetSrgbFormat(this.textureFormat) : this.textureFormat;
        for (let i = 0; i < textureNum; i++) {
            const texture = Nri_GetSwapChainTexture(this.swapChain, i);
            this.textures.push(texture);
            this.views.push(Nri_CreateColorAttachmentView(texture, this.attachmentFormat));
            this.acquireSemaphores.push(Nri_CreateSwapChainSemaphore(this.device));
            this.releaseSemaphores.push(Nri_CreateSwapChainSemaphore(this.device));
        }
        this.created = true;
    }

    // Its size (the window's when it was made), its textures' format, and its views'.
    width(): int {
        return this.outputWidth;
    }

    height(): int {
        return this.outputHeight;
    }

    format(): NriFormat {
        return this.textureFormat;
    }

    viewFormat(): NriFormat {
        return this.attachmentFormat;
    }

    // Whether the window's size is no longer the swap chain's.
    resized(): boolean {
        return Nri_GetOutputWidth(this.sample) != this.outputWidth || Nri_GetOutputHeight(this.sample) != this.outputHeight;
    }

    // Made again at the window's size, once the GPU's done with the old one.
    recreate() {
        Nri_DeviceWaitIdle(this.device);
        this.destroy();
        this.create();
    }

    // The texture to render frame frameIndex into, or -1 (none this frame: skip its recording).
    acquire(frameIndex: int): int {
        this.acquired = frameIndex % this.acquireSemaphores.length;
        return Nri_AcquireNextTexture(this.swapChain, this.acquireSemaphores[this.acquired]);
    }

    texture(index: int): NriTextureHandle {
        return this.textures[index];
    }

    colorAttachment(index: int): NriDescriptorHandle {
        return this.views[index];
    }

    // The command buffer submitted, waiting for the acquired texture and signaling its present.
    submit(commandBuffer: NriCommandBufferHandle, index: int) {
        Nri_QueueSubmit(this.queue, commandBuffer, this.acquireSemaphores[this.acquired], this.releaseSemaphores[index]);
    }

    present(index: int) {
        Nri_QueuePresent(this.swapChain, this.releaseSemaphores[index]);
    }

    // (after the device is idle)
    destroy() {
        if (!this.created) {
            return;
        }
        for (let i = 0; i < this.textures.length; i++) {
            Nri_DestroyFence(this.acquireSemaphores[i]);
            Nri_DestroyFence(this.releaseSemaphores[i]);
            Nri_DestroyDescriptor(this.views[i]);
        }
        this.textures = [];
        this.views = [];
        this.acquireSemaphores = [];
        this.releaseSemaphores = [];
        Nri_DestroySwapChain(this.swapChain);
        this.created = false;
    }
}

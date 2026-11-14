// The swap chain of an NRI app: made at the window's size (NriSample.getQueuedFrameNum + 1 textures), a
// color attachment view and a pair of semaphores for each texture, made again when the window's
// resized (or replaced: an Android activity's, after the background or a relaunch), and the
// acquire, submit and present of a frame.
//
// Imported with `import { NriSwapChain } from "../core/nri_swap_chain";` (add_tslang_nri_example
// adds it, and core/nri.ts, to the app's sources). Each frame: resized() (and recreate() when it
// is), acquire, record into texture(i) through colorAttachment(i), submit, present. What the app
// keeps at the window's size (targets, a layout) it makes again itself when recreate() runs.

/// <reference path="nri/nri_interop.d.ts" />
import { Nri, NriCommandBuffer, NriDescriptor, NriDevice, NriFence, NriQueue, NriSample, NriSwapChainObject, NriTexture } from "./nri";

@final
export class NriSwapChain {
    private sample: NriSample;
    private device: NriDevice;
    private queue: NriQueue;
    private swapChain: NriSwapChainObject;
    private srgb: boolean = false;
    private outputWidth: int = 0;
    private outputHeight: int = 0;
    // The window it was made over (NriSample.getWindowSerial).
    private windowSerial: int = 0;
    private textureFormat: NriFormat = NriFormat.Unknown;
    private attachmentFormat: NriFormat = NriFormat.Unknown;
    private textures: NriTexture[] = [];
    private views: NriDescriptor[] = [];
    private acquireSemaphores: NriFence[] = [];
    private releaseSemaphores: NriFence[] = [];
    // The acquire semaphore of the frame acquired last (its submit waits on it).
    private acquired: int = 0;
    private created: boolean = false;
    // The swap chain's format (NriSwapChainFormat, an HDR one, say), or -1: the framework's.
    private chainFormat: int = -1;

    // srgb: the views are the texture format's sRGB form (the GPU encodes the colors); else the
    // texture's own format (the app writes its colors as they are).
    init(sample: NriSample, device: NriDevice, queue: NriQueue, srgb: boolean) {
        this.keep(sample, device, queue);
        this.srgb = srgb;
        this.create();
    }

    // A swap chain of format (NriSwapChainFormat: BT709_G22_10BIT, BT2020_G2084_10BIT, ...), its
    // views in its textures' format.
    initWithFormat(sample: NriSample, device: NriDevice, queue: NriQueue, format: NriSwapChainFormat) {
        this.keep(sample, device, queue);
        this.srgb = false;
        this.chainFormat = format;
        this.create();
    }

    // Wrappers of its own of the caller's sample, device and queue (handles; the caller keeps theirs).
    private keep(sample: NriSample, device: NriDevice, queue: NriQueue) {
        this.sample = new NriSample(sample.handle);
        this.device = new NriDevice(device.handle);
        this.queue = new NriQueue(queue.handle);
    }

    private create() {
        this.outputWidth = this.sample.getOutputWidth();
        this.outputHeight = this.sample.getOutputHeight();
        this.windowSerial = this.sample.getWindowSerial();
        const wanted = this.sample.getQueuedFrameNum() + 1;
        this.swapChain = this.chainFormat >= 0
            ? this.sample.createSwapChainWithFormat(this.device, this.queue, wanted, this.chainFormat)
            : this.sample.createSwapChain(this.device, this.queue, wanted);
        const textureNum = this.swapChain.getTextureNum();
        this.textureFormat = this.swapChain.getTexture(0).getFormat();
        this.attachmentFormat = this.srgb ? Nri.getSrgbFormat(this.textureFormat) : this.textureFormat;
        for (let i = 0; i < textureNum; i++) {
            const texture = this.swapChain.getTexture(i);
            // The view before the texture is pushed: pushing it moves it into the array.
            this.views.push(texture.createColorAttachmentView(this.attachmentFormat));
            this.textures.push(texture);
            this.acquireSemaphores.push(this.device.createSwapChainSemaphore());
            this.releaseSemaphores.push(this.device.createSwapChainSemaphore());
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

    // How many textures it has.
    textureNum(): int {
        return this.textures.length;
    }

    // Whether it's made (and not destroyed since).
    exists(): boolean {
        return this.created;
    }

    // The NRI swap chain itself (for isDisplayHdr, say).
    @lends("this")
    object(): NriSwapChainObject {
        return this.swapChain;
    }

    // Whether the window's size is no longer the swap chain's, or the window isn't the one it was made
    // over (an Android activity's window, gone in the background or with the activity made again,
    // and back as another).
    resized(): boolean {
        return this.sample.getOutputWidth() != this.outputWidth || this.sample.getOutputHeight() != this.outputHeight
            || this.sample.getWindowSerial() != this.windowSerial;
    }

    // Made again in format (NriSwapChainFormat), at the window's size, once the GPU's done with the
    // old one (initWithFormat's).
    recreateWithFormat(format: NriSwapChainFormat) {
        this.chainFormat = format;
        this.recreate();
    }

    // Made again at the window's size, once the GPU's done with the old one.
    recreate() {
        this.device.waitIdle();
        this.destroy();
        this.create();
    }

    // The texture to render frame frameIndex into, or -1 (none this frame: skip its recording).
    acquire(frameIndex: int): int {
        this.acquired = frameIndex % this.acquireSemaphores.length;
        return this.swapChain.acquireNextTexture(this.acquireSemaphores[this.acquired]);
    }

    @lends("this")
    texture(index: int): NriTexture {
        return this.textures[index];
    }

    @lends("this")
    colorAttachment(index: int): NriDescriptor {
        return this.views[index];
    }

    // The command buffer submitted, waiting for the acquired texture and signaling its present.
    submit(commandBuffer: NriCommandBuffer, index: int) {
        this.queue.submit(commandBuffer, this.acquireSemaphores[this.acquired], this.releaseSemaphores[index]);
    }

    present(index: int) {
        this.swapChain.present(this.releaseSemaphores[index]);
    }

    // (after the device is idle)
    destroy() {
        if (!this.created) {
            return;
        }
        for (let i = 0; i < this.textures.length; i++) {
            this.acquireSemaphores[i].destroy();
            this.releaseSemaphores[i].destroy();
            this.views[i].destroy();
        }
        this.textures = [];
        this.views = [];
        this.acquireSemaphores = [];
        this.releaseSemaphores = [];
        this.swapChain.destroy();
        this.created = false;
    }
}

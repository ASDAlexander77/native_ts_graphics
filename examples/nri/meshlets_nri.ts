/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { Nri, NriBuffer, NriDevice, NriPipeline, NriPipelineLayout, NriQueue, NriSample } from "../../core/nri";

namespace MeshletsNri {
    // meshlets, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut and
    // NVRHI: the same shaders (meshlets.hlsl's: a task shader workgroup launches one mesh shader
    // workgroup, which outputs a triangle colored by its vertices), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws. D3D12 and Vulkan (mesh shaders).

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): the device lacks mesh shaders.
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Meshlets";

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // -test: checks the last frame, read back. The corners are the black clear color; the meshlet
    // triangle covers an eighth of the frame, colored in the middle, its apex at the top.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != 0) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 0, 0, 0`;
            }
        }
        if ((pixels[(height / 2) * width + width / 2] & 0xFFFFFF) == 0) {
            return "the middle of the triangle is black";
        }
        // Clip y up, as Donut's: the apex (0, 0.5) is at the top, so (0.4, -0.4) in clip space is in
        // the triangle and (0.4, 0.4) isn't.
        const inside = Math.floor(height * 0.7) * width + Math.floor(width * 0.7);
        const outside = Math.floor(height * 0.3) * width + Math.floor(width * 0.7);
        if ((pixels[inside] & 0xFFFFFF) == 0 || (pixels[outside] & 0xFFFFFF) != 0) {
            return "the triangle is flipped: its apex isn't at the top";
        }
        let count = 0;
        for (let i = 0; i < width * height; i++) {
            if ((pixels[i] & 0xFFFFFF) != 0) {
                count++;
            }
        }
        const percent = 100.0 * count / (width * height);
        console.log(`Triangle: ${percent}% (${count} of ${width * height} pixels)`);
        if (percent < 10.0 || percent > 15.0) {
            return `Triangle: ${percent}% of the pixels, not 10% to 15%`;
        }
        return "";
    }

    // Port of Donut-Samples' meshlets.cpp (as examples/meshlets.ts ports it) to NRI.
    class Meshlets {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private pipelineLayout: NriPipelineLayout;
        private pipeline: NriPipeline | null = null;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;
        // Set by initialize when the device lacks mesh shaders ("" otherwise).
        private unsupportedReason: string = "";

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = 0;

        constructor(private sample: NriSample) {
        }

        // Renders until the window is closed (in test mode, the test's frames); the exit code.
        run(argc: int, argv: Ref<string>): int {
            const initialize: NriInitializeCallback = this.initialize;
            const latencySleep: NriFrameCallback = this.latencySleep;
            const renderFrame: NriFrameCallback = this.renderFrame;
            retainedInitializeCallbacks.push(initialize);
            retainedFrameCallbacks.push(latencySleep);
            retainedFrameCallbacks.push(renderFrame);
            this.sample.setInitializeCallback(initialize);
            this.sample.setLatencySleepCallback(latencySleep);
            this.sample.setRenderFrameCallback(renderFrame);

            let result = this.sample.run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (this.unsupportedReason != "") {
                const test = this.sample.isTest() != 0;
                console.log(test ? `Test SKIPPED: ${this.unsupportedReason}` : this.unsupportedReason);
                result = test ? TEST_SKIPPED : 1;
            } else if (result == 0 && this.test) {
                const failure = checkFrame(this.readBack(), this.width, this.height);
                console.log(failure == "" ? "Test PASSED" : `Test FAILED: ${failure}`);
                result = failure == "" ? 0 : 1;
            }
            this.destroy();
            return result;
        }

        initialize(graphicsAPI: NriGraphicsAPI): int {
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);
            if (device.isFeatureSupported(NriFeature.MeshShader) == 0) {
                this.unsupportedReason = "The graphics device does not support mesh shaders";
                return 0;
            }

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // Swap chain
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);

            // Pipeline: meshlets.hlsl's shaders, as compiled for the Donut example.
            this.pipelineLayout = device.createPipelineLayout();
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/meshlets/${folder}/meshlets`;
            const pipeline = device.createTaskMeshPipeline(this.pipelineLayout, `${shaders}_main_as.bin`, "main_as",
                `${shaders}_main_ms.bin`, "main_ms", `${shaders}_main_ps.bin`, "main_ps", viewFormat);
            if (!pipeline) {
                console.log("Cannot load the meshlet shaders");
                return 0;
            }
            this.pipeline = pipeline;

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain (and what has the window's
        // size) made again at its size, once the GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            this.swapChain.recreate();
            this.sizeToSwapChain();
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const pipeline = this.pipeline;
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record
                commandBuffer.begin();
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
                if (pipeline) {
                    commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
                    commandBuffer.setScissor(0, 0, this.width, this.height);
                    commandBuffer.setPipelineLayout(this.pipelineLayout);
                    commandBuffer.setPipeline(pipeline);
                    commandBuffer.drawMeshTasks(1, 1, 1);
                }
                commandBuffer.endRendering();

                // The test's last frame: read back
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        commandBuffer.textureBarrier(texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                        commandBuffer.readbackTextureToBuffer(readbackBuffer, this.rowPitch, texture, this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                    }
                }
                commandBuffer.textureBarrier(texture, presentFrom, NriTextureState.Present);
                commandBuffer.end();

                // Submit and present
                this.swapChain.submit(commandBuffer, index);
                this.swapChain.present(index);
            }

            // Signaled after the present, as NRISamples do
            this.frames.signal(frameIndex);
        }

        // The last frame's pixels (0xAABBGGRR), empty if it can't be read.
        readBack(): int[] {
            const device = this.device;
            const readbackBuffer = this.readbackBuffer;
            if (!device || !readbackBuffer) {
                return [];
            }
            device.waitIdle();
            const pixels: int[] = [];
            for (let i = 0; i < this.width * this.height; i++) {
                pixels.push(0);
            }
            if (readbackBuffer.readRGBA8(this.rowPitch, this.width, this.height, this.readbackFormat,
                Ref(pixels[0]), pixels.length) == 0) {
                return [];
            }
            return pixels;
        }

        // What initialize made (it may have stopped part way: a device without mesh shaders).
        destroy() {
            const device = this.device;
            if (device) {
                device.waitIdle();
                const pipeline = this.pipeline;
                if (pipeline) {
                    pipeline.destroy();
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    readbackBuffer.destroy();
                }
                if (this.unsupportedReason == "") {
                    this.pipelineLayout.destroy();
                    this.frames.destroy();
                    this.swapChain.destroy();
                }
                device.destroy();
            }
            this.sample.destroy();
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const meshlets = new Meshlets(sample);
        return meshlets.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return MeshletsNri.main(argc, argv);
}

/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { DonutBlit } from "../../core/nri_donut_blit";
import { Nri, NriAccelerationStructure, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriPipeline, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriShaderTable, NriTexture } from "../../core/nri";

namespace RtTriangleNri {
    // rt_triangle, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut
    // and NVRHI: the same shaders (rt_triangle.hlsl's library, and Donut's blit shaders), through the
    // NRI calls core/nri/nri_interop.d.ts binds. This example creates everything it runs, and does the
    // rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no ray tracing, or no shaders for
    // the graphics API (D3D11).
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Ray Traced Triangle";

    // sizeof(float4) of the HitInfo payload in rt_triangle.hlsl, and of its float2 attributes.
    const PAYLOAD_SIZE = 16;
    const ATTRIBUTE_SIZE = 8;

    // The ray traced image's background, the miss shader's 0.2 gray in the sRGB back buffer.
    const CLEAR_GRAY = 0x7C7C7C;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // -test: checks the last frame, read back, as the Donut example does. The top corners are the
    // gray of the miss shader; the ray traced triangle covers half the frame, colored in the middle.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        if ((pixels[0] & 0xFFFFFF) != CLEAR_GRAY || (pixels[width - 1] & 0xFFFFFF) != CLEAR_GRAY) {
            return "the top corners aren't the clear color";
        }
        if ((pixels[Math.floor(height / 2) * width + Math.floor(width / 2)] & 0xFFFFFF) == CLEAR_GRAY) {
            return "no triangle in the middle";
        }
        let triangle = 0;
        for (let i = 0; i < width * height; i++) {
            if ((pixels[i] & 0xFFFFFF) != CLEAR_GRAY) {
                triangle++;
            }
        }
        const total = width * height;
        const percent = 100.0 * triangle / total;
        console.log(`Triangle: ${percent}% (${triangle} of ${total} pixels)`);
        if (percent < 40.0 || percent > 60.0) {
            return `Triangle: ${percent}% of the pixels, not 40% to 60%`;
        }
        return "";
    }

    // Port of Donut-Samples' rt_triangle (as examples/rt_triangle.ts ports it) to NRI: a ray
    // generation shader shoots a ray along +z from every pixel at a triangle, a single instance's
    // bottom level acceleration structure; hits are colored by their barycentrics, misses gray. The
    // image is written to a storage texture, then blitted into the back buffer.
    class RtTriangle {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private layout: NriPipelineLayout | null = null;
        private pipeline: NriPipeline | null = null;
        private shaderTable: NriShaderTable | null = null;
        private bottomLevelAS: NriAccelerationStructure | null = null;
        private topLevelAS: NriAccelerationStructure | null = null;
        private topLevelASView: NriDescriptor | null = null;
        private renderTarget: NriTexture | null = null;
        private renderTargetStorage: NriDescriptor | null = null;
        private renderTargetView: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private rayTracingSet: NriDescriptorSet | null = null;
        private blitSet: NriDescriptorSet | null = null;
        private blit: DonutBlit = new DonutBlit();
        // The render target is read by the blit (after the first frame).
        private renderTargetBlitted: boolean = false;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

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

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // Swap chain: blitted into through sRGB views, as the Donut example's sRGB back buffer.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);

            // Ray tracing pipelines: D3D12 or Vulkan (the Donut example's shaders have no DXBC).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (ray tracing needs D3D12 or Vulkan)";
                return 0;
            }
            if (device.isFeatureSupported(NriFeature.RayTracing) == 0) {
                this.unsupportedReason = "The graphics device does not support Ray Tracing Pipelines";
                return 0;
            }

            // The layout: the scene (t0) and the render target (u0), for the ray generation shader.
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.AccelerationStructure, NriStage.RayGen, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, NriStage.RayGen, NriRangeFlags.None);
            const layout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The pipeline: rt_triangle.hlsl's library, as compiled for the Donut example; its shader
            // table.
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const pipeline = device.createRayTracingPipeline(layout, `shaders/rt_triangle/${folder}/rt_triangle.bin`,
                "RayGen", "Miss", "ClosestHit", PAYLOAD_SIZE, ATTRIBUTE_SIZE);
            this.pipeline = pipeline;
            if (!pipeline) {
                console.log("Cannot initialize the ray tracing pipeline");
                return 0;
            }
            this.shaderTable = device.createShaderTable(this.queue, pipeline, 1, 1);
            if (!this.shaderTable) {
                console.log("Cannot create the shader table");
                return 0;
            }
            if (!this.blit.init(device, folder, viewFormat)) {
                return 0;
            }

            // The scene: one triangle (z = 1, in front of the rays' origins) in a bottom level
            // acceleration structure, its single instance in the top level one.
            const vertices: f32[] = [0.0, -1.0, 1.0,   -1.0, 1.0, 1.0,   1.0, 1.0, 1.0];
            const indices: int[] = [0, 1, 2];
            const bottomLevelAS = device.buildTriangleBLAS(this.queue, Ref(vertices[0]), 3, Ref(indices[0]), 3,
                NriAccelerationStructureFlags.None);
            this.bottomLevelAS = bottomLevelAS;
            if (!bottomLevelAS) {
                console.log("Cannot build the bottom level acceleration structure");
                return 0;
            }
            const topLevelAS = device.buildSingleInstanceTLAS(this.queue, bottomLevelAS, NriAccelerationStructureFlags.None);
            this.topLevelAS = topLevelAS;
            if (!topLevelAS) {
                console.log("Cannot build the top level acceleration structure");
                return 0;
            }
            const topLevelASView = topLevelAS.createDescriptor();
            this.topLevelASView = topLevelASView;

            // The render target the rays write (RGBA8_UNORM, as Donut's createUAVTextureForFrame), read
            // by the blit.
            const created = this.createRenderTarget(device);
            const descriptorPool = device.createDescriptorPoolWithAccelerationStructures(2, 1, 0, 1, 1, 0, 1);
            this.descriptorPool = descriptorPool;
            if (!created || !descriptorPool || !topLevelASView) {
                console.log("Cannot create the render target");
                return 0;
            }
            const renderTargetStorage = this.renderTargetStorage;
            const renderTargetView = this.renderTargetView;
            if (!renderTargetStorage || !renderTargetView) {
                console.log("Cannot create the render target");
                return 0;
            }
            const rayTracingSet = descriptorPool.allocateDescriptorSet(layout, 0, 0);
            this.rayTracingSet = rayTracingSet;
            this.blitSet = this.blit.createSet(descriptorPool, renderTargetView);
            if (!rayTracingSet || !this.blitSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            rayTracingSet.updateDescriptor(0, 0, topLevelASView);
            rayTracingSet.updateDescriptor(1, 0, renderTargetStorage);

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

        // The storage texture the rays write (at the swap chain's size), created in
        // NriTextureState.Storage, with its storage and shader resource views; false on failure.
        createRenderTarget(device: NriDevice): boolean {
            const renderTarget = device.createStorageTexture(this.queue, this.width, this.height, NriFormat.RGBA8_UNORM);
            this.renderTarget = renderTarget;
            if (!renderTarget) {
                return false;
            }
            this.renderTargetStorage = renderTarget.createStorageView(NriFormat.RGBA8_UNORM);
            this.renderTargetView = renderTarget.createView(NriFormat.RGBA8_UNORM);
            // Its first frame needs no barrier into the rays' state (D3D12 rejects same-state ones).
            this.renderTargetBlitted = false;
            return true;
        }

        destroyRenderTarget() {
            this.destroyDescriptor(this.renderTargetStorage);
            this.destroyDescriptor(this.renderTargetView);
            this.renderTargetStorage = null;
            this.renderTargetView = null;
            const renderTarget = this.renderTarget;
            if (renderTarget) {
                renderTarget.destroy();
            }
            this.renderTarget = null;
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
            device.waitIdle();
            this.destroyRenderTarget();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.createRenderTarget(device);
            // The sets point at the new render target's views.
            const rayTracingSet = this.rayTracingSet;
            const renderTargetStorage = this.renderTargetStorage;
            if (rayTracingSet) {
                if (renderTargetStorage) {
                    rayTracingSet.updateDescriptor(1, 0, renderTargetStorage);
                }
            }
            const blitSet = this.blitSet;
            const renderTargetView = this.renderTargetView;
            if (blitSet) {
                if (renderTargetView) {
                    blitSet.updateDescriptor(0, 0, renderTargetView);
                }
            }
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The rays, a width x height grid of them, into the render target; then it goes to the blit.
        recordRays(commandBuffer: NriCommandBuffer) {
            const layout = this.layout;
            const pipeline = this.pipeline;
            const shaderTable = this.shaderTable;
            const descriptorPool = this.descriptorPool;
            const rayTracingSet = this.rayTracingSet;
            const renderTarget = this.renderTarget;
            if (!layout || !pipeline || !shaderTable || !descriptorPool || !rayTracingSet || !renderTarget) {
                return;
            }
            if (this.renderTargetBlitted) {
                commandBuffer.textureBarrier(renderTarget, NriTextureState.ShaderResource, NriTextureState.RayTracingStorage);
            }
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setRayTracingPipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setRayTracingDescriptorSet(0, rayTracingSet);
            commandBuffer.dispatchRays(shaderTable, this.width, this.height);
            commandBuffer.textureBarrier(renderTarget, NriTextureState.RayTracingStorage, NriTextureState.ShaderResource);
            this.renderTargetBlitted = true;
        }

        // The render target over the frame (between NriCommandBuffer.beginRendering and NriCommandBuffer.endRendering).
        recordBlit(commandBuffer: NriCommandBuffer) {
            const blitSet = this.blitSet;
            if (blitSet) {
                this.blit.record(commandBuffer, blitSet, this.width, this.height);
            }
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the rays, then their image blitted into the frame.
                commandBuffer.begin();
                this.recordRays(commandBuffer);
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                this.recordBlit(commandBuffer);
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

        destroy() {
            const device = this.device;
            if (device) {
                device.waitIdle();
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.blit.destroy();
                this.destroyRenderTarget();
                this.destroyDescriptor(this.topLevelASView);
                const topLevelAS = this.topLevelAS;
                if (topLevelAS) {
                    topLevelAS.destroy();
                }
                const bottomLevelAS = this.bottomLevelAS;
                if (bottomLevelAS) {
                    bottomLevelAS.destroy();
                }
                const shaderTable = this.shaderTable;
                if (shaderTable) {
                    shaderTable.destroy();
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    readbackBuffer.destroy();
                }
                const pipeline = this.pipeline;
                if (pipeline) {
                    pipeline.destroy();
                }
                const layout = this.layout;
                if (layout) {
                    layout.destroy();
                }
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }

        destroyDescriptor(descriptor: NriDescriptor | null) {
            if (descriptor) {
                descriptor.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        return new RtTriangle(sample).run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RtTriangleNri.main(argc, argv);
}

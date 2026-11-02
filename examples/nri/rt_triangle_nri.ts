/// <reference path="../../core/nri/nri_interop.d.ts" />
import { DonutBlit } from "../../core/nri_donut_blit";

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

    // What a frame in flight records into.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

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
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private layout: NriPipelineLayoutHandle | null = null;
        private pipeline: NriPipelineHandle | null = null;
        private shaderTable: NriShaderTableHandle | null = null;
        private bottomLevelAS: NriAccelerationStructureHandle | null = null;
        private topLevelAS: NriAccelerationStructureHandle | null = null;
        private topLevelASView: NriDescriptorHandle | null = null;
        private renderTarget: NriTextureHandle | null = null;
        private renderTargetStorage: NriDescriptorHandle | null = null;
        private renderTargetView: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private rayTracingSet: NriDescriptorSetHandle | null = null;
        private blitSet: NriDescriptorSetHandle | null = null;
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
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
        }

        // Renders until the window is closed (in test mode, the test's frames); the exit code.
        run(argc: int, argv: Ref<string>): int {
            const initialize: NriInitializeCallback = this.initialize;
            const latencySleep: NriFrameCallback = this.latencySleep;
            const renderFrame: NriFrameCallback = this.renderFrame;
            retainedInitializeCallbacks.push(initialize);
            retainedFrameCallbacks.push(latencySleep);
            retainedFrameCallbacks.push(renderFrame);
            Nri_SetInitializeCallback(this.sample, initialize);
            Nri_SetLatencySleepCallback(this.sample, latencySleep);
            Nri_SetRenderFrameCallback(this.sample, renderFrame);

            let result = Nri_RunSample(this.sample, argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (this.unsupportedReason != "") {
                const test = Nri_IsTest(this.sample) != 0;
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
            const device = Nri_CreateDevice(this.sample, graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri_GetGraphicsAPIString(graphicsAPI)} (${Nri_GetAdapterName(device)})`);

            this.queue = Nri_GetGraphicsQueue(device);
            this.frameFence = Nri_CreateFence(device, 0);
            this.test = Nri_IsTest(this.sample) != 0;

            // Swap chain: blitted into through sRGB views, as the Donut example's sRGB back buffer.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.createSwapChain(device);
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;

            // Queued frames
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator)));
            }

            // Ray tracing pipelines: D3D12 or Vulkan (the Donut example's shaders have no DXBC).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (ray tracing needs D3D12 or Vulkan)";
                return 0;
            }
            if (Nri_IsFeatureSupported(device, NriFeature.RayTracing) == 0) {
                this.unsupportedReason = "The graphics device does not support Ray Tracing Pipelines";
                return 0;
            }

            // The layout: the scene (t0) and the render target (u0), for the ray generation shader.
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.AccelerationStructure, NriStage.RayGen, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.StorageTexture, NriStage.RayGen, NriRangeFlags.None);
            const layout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The pipeline: rt_triangle.hlsl's library, as compiled for the Donut example; its shader
            // table.
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const pipeline = Nri_CreateRayTracingPipeline(device, layout, `shaders/rt_triangle/${folder}/rt_triangle.bin`,
                "RayGen", "Miss", "ClosestHit", PAYLOAD_SIZE, ATTRIBUTE_SIZE);
            this.pipeline = pipeline;
            if (!pipeline) {
                console.log("Cannot initialize the ray tracing pipeline");
                return 0;
            }
            this.shaderTable = Nri_CreateShaderTable(device, this.queue, pipeline, 1, 1);
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
            const bottomLevelAS = Nri_BuildTriangleBLAS(device, this.queue, Ref(vertices[0]), 3, Ref(indices[0]), 3,
                NriAccelerationStructureFlags.None);
            this.bottomLevelAS = bottomLevelAS;
            if (!bottomLevelAS) {
                console.log("Cannot build the bottom level acceleration structure");
                return 0;
            }
            const topLevelAS = Nri_BuildSingleInstanceTLAS(device, this.queue, bottomLevelAS, NriAccelerationStructureFlags.None);
            this.topLevelAS = topLevelAS;
            if (!topLevelAS) {
                console.log("Cannot build the top level acceleration structure");
                return 0;
            }
            const topLevelASView = Nri_CreateAccelerationStructureDescriptor(topLevelAS);
            this.topLevelASView = topLevelASView;

            // The render target the rays write (RGBA8_UNORM, as Donut's createUAVTextureForFrame), read
            // by the blit.
            const created = this.createRenderTarget(device);
            const descriptorPool = Nri_CreateDescriptorPoolWithAccelerationStructures(device, 2, 1, 0, 1, 1, 0, 1);
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
            const rayTracingSet = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
            this.rayTracingSet = rayTracingSet;
            this.blitSet = this.blit.createSet(descriptorPool, renderTargetView);
            if (!rayTracingSet || !this.blitSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            Nri_UpdateDescriptor(rayTracingSet, 0, 0, topLevelASView);
            Nri_UpdateDescriptor(rayTracingSet, 1, 0, renderTargetStorage);

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The swap chain at the window's size, its textures' views and semaphores.
        createSwapChain(device: NriDeviceHandle) {
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, Nri_GetQueuedFrameNum(this.sample) + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            this.swapChainFormat = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            this.swapChainViewFormat = Nri_GetSrgbFormat(this.swapChainFormat);
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(this.swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, this.swapChainViewFormat),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }
        }

        destroySwapChain() {
            for (const swapChainTexture of this.swapChainTextures) {
                Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
            }
            this.swapChainTextures = [];
            Nri_DestroySwapChain(this.swapChain);
        }

        // The storage texture the rays write (at the swap chain's size), created in
        // NriTextureState.Storage, with its storage and shader resource views; false on failure.
        createRenderTarget(device: NriDeviceHandle): boolean {
            const renderTarget = Nri_CreateStorageTexture(device, this.queue, this.width, this.height, NriFormat.RGBA8_UNORM);
            this.renderTarget = renderTarget;
            if (!renderTarget) {
                return false;
            }
            this.renderTargetStorage = Nri_CreateStorageTextureView(renderTarget, NriFormat.RGBA8_UNORM);
            this.renderTargetView = Nri_CreateTextureView(renderTarget, NriFormat.RGBA8_UNORM);
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
                Nri_DestroyTexture(renderTarget);
            }
            this.renderTarget = null;
        }

        // The window was resized (Nri_UseResizableWindow): the swap chain (and what has the window's
        // size) made again at its size, once the GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (Nri_GetOutputWidth(this.sample) == this.width && Nri_GetOutputHeight(this.sample) == this.height) {
                return;
            }
            Nri_DeviceWaitIdle(device);
            this.destroySwapChain();
            this.destroyRenderTarget();
            this.createSwapChain(device);
            this.createRenderTarget(device);
            // The sets point at the new render target's views.
            const rayTracingSet = this.rayTracingSet;
            const renderTargetStorage = this.renderTargetStorage;
            if (rayTracingSet) {
                if (renderTargetStorage) {
                    Nri_UpdateDescriptor(rayTracingSet, 1, 0, renderTargetStorage);
                }
            }
            const blitSet = this.blitSet;
            const renderTargetView = this.renderTargetView;
            if (blitSet) {
                if (renderTargetView) {
                    Nri_UpdateDescriptor(blitSet, 0, 0, renderTargetView);
                }
            }
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The rays, a width x height grid of them, into the render target; then it goes to the blit.
        recordRays(commandBuffer: NriCommandBufferHandle) {
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
                Nri_CmdTextureBarrier(commandBuffer, renderTarget, NriTextureState.ShaderResource, NriTextureState.RayTracingStorage);
            }
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetRayTracingPipelineLayout(commandBuffer, layout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetRayTracingDescriptorSet(commandBuffer, 0, rayTracingSet);
            Nri_CmdDispatchRays(commandBuffer, shaderTable, this.width, this.height);
            Nri_CmdTextureBarrier(commandBuffer, renderTarget, NriTextureState.RayTracingStorage, NriTextureState.ShaderResource);
            this.renderTargetBlitted = true;
        }

        // The render target over the frame (between Nri_CmdBeginRendering and Nri_CmdEndRendering).
        recordBlit(commandBuffer: NriCommandBufferHandle) {
            const blitSet = this.blitSet;
            if (blitSet) {
                this.blit.record(commandBuffer, blitSet, this.width, this.height);
            }
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrame = this.queuedFrames[frameIndex % this.queuedFrames.length];

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the rays, then their image blitted into the frame.
                Nri_BeginCommandBuffer(commandBuffer);
                this.recordRays(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                this.recordBlit(commandBuffer);
                Nri_CmdEndRendering(commandBuffer);

                // The test's last frame: read back
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                        Nri_CmdReadbackTextureToBuffer(commandBuffer, readbackBuffer, this.rowPitch, swapChainTexture.texture, this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                    }
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, presentFrom, NriTextureState.Present);
                Nri_EndCommandBuffer(commandBuffer);

                // Submit and present
                Nri_QueueSubmit(this.queue, commandBuffer, acquireSemaphore, swapChainTexture.releaseSemaphore);
                Nri_QueuePresent(this.swapChain, swapChainTexture.releaseSemaphore);
            }

            // Signaled after the present, as NRISamples do
            Nri_QueueSignal(this.queue, this.frameFence, 1 + frameIndex);
        }

        // The last frame's pixels (0xAABBGGRR), empty if it can't be read.
        readBack(): int[] {
            const device = this.device;
            const readbackBuffer = this.readbackBuffer;
            if (!device || !readbackBuffer) {
                return [];
            }
            Nri_DeviceWaitIdle(device);
            const pixels: int[] = [];
            for (let i = 0; i < this.width * this.height; i++) {
                pixels.push(0);
            }
            if (Nri_ReadBufferRGBA8(readbackBuffer, this.rowPitch, this.width, this.height, this.readbackFormat,
                Ref(pixels[0]), pixels.length) == 0) {
                return [];
            }
            return pixels;
        }

        destroy() {
            const device = this.device;
            if (device) {
                Nri_DeviceWaitIdle(device);
                for (const queuedFrame of this.queuedFrames) {
                    Nri_DestroyCommandBuffer(queuedFrame.commandBuffer);
                    Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                this.blit.destroy();
                this.destroyRenderTarget();
                this.destroyDescriptor(this.topLevelASView);
                const topLevelAS = this.topLevelAS;
                if (topLevelAS) {
                    Nri_DestroyAccelerationStructure(topLevelAS);
                }
                const bottomLevelAS = this.bottomLevelAS;
                if (bottomLevelAS) {
                    Nri_DestroyAccelerationStructure(bottomLevelAS);
                }
                const shaderTable = this.shaderTable;
                if (shaderTable) {
                    Nri_DestroyShaderTable(shaderTable);
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
                }
                const pipeline = this.pipeline;
                if (pipeline) {
                    Nri_DestroyPipeline(pipeline);
                }
                const layout = this.layout;
                if (layout) {
                    Nri_DestroyPipelineLayout(layout);
                }
                Nri_DestroyFence(this.frameFence);
                this.destroySwapChain();
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }

        destroyDescriptor(descriptor: NriDescriptorHandle | null) {
            if (descriptor) {
                Nri_DestroyDescriptor(descriptor);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        Nri_UseResizableWindow(sample);
        return new RtTriangle(sample).run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RtTriangleNri.main(argc, argv);
}

/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";

namespace DepthBoundsTestNri {
    // depth_bounds_test, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (depth_bounds_test.hlsl's, the D3D12DepthBoundsTest
    // sample's), through the NRI calls core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws.
    // As the sample (and unlike the Donut example, which blits a color target), into the swap
    // chain's UNORM texture and a D32 depth buffer.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Depth Bounds Test";

    // The sample's vertex: float3 position, float4 color.
    const VERTEX_STRIDE = 28;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // -test: checks the last frame, read back. The corners are the cornflower clear color; the
    // triangle (the part of it within the depth bounds) covers about 5% of the frame, colored in the
    // middle.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const background = 0xED9564;
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != background) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 100, 149, 237`;
            }
        }
        if ((pixels[(height / 2) * width + width / 2] & 0xFFFFFF) == background) {
            return "no triangle in the middle";
        }
        let count = 0;
        for (let i = 0; i < width * height; i++) {
            if ((pixels[i] & 0xFFFFFF) != background) {
                count++;
            }
        }
        const percent = 100.0 * count / (width * height);
        console.log(`Triangle: ${percent}% (${count} of ${width * height} pixels)`);
        if (percent < 3.0 || percent > 8.0) {
            return `Triangle: ${percent}% of the pixels, not 3% to 8%`;
        }
        return "";
    }

    // Port of DirectX-Graphics-Samples' D3D12DepthBoundsTest (as examples/depth_bounds_test.ts ports
    // it) to NRI: a triangle whose corners lie at depths 0.1, 0.9 and 0.5 drawn into the depth buffer
    // alone, then again with depth testing off but the depth bounds test on: only where the depth
    // it drew first lies within the bounds, which close in and open up from [0, 1] to about
    // [0.23, 0.77] and back as the frames go by (one step a frame, as the sample's at 60 Hz).
    class DepthBoundsTest {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private vertexBuffer: NriBufferHandle | null = null;
        private pipelineLayout: NriPipelineLayoutHandle;
        private depthOnlyPipeline: NriPipelineHandle | null = null;
        private boundsPipeline: NriPipelineHandle | null = null;
        private depthBoundsTestSupported: boolean = false;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;

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
            if (result == 0 && this.test) {
                const failure = checkFrame(this.readBack(), this.width, this.height);
                console.log(failure == "" ? "Test PASSED" : `Test FAILED: ${failure}`);
                result = failure == "" ? 0 : 1;
            }
            this.destroy();
            return result;
        }

        // The sample's two pipeline states, for the swap chain's format and D32.
        createPipelines(graphicsAPI: NriGraphicsAPI, device: NriDeviceHandle, colorFormat: NriFormat) {
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/depth_bounds_test/${folder}/depth_bounds_test`;
            for (let i = 0; i < 2; i++) {
                const desc = Nri_CreatePipelineDesc();
                let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_VSMain.bin`, "VSMain") != 0;
                if (loaded) {
                    loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_PSMain.bin`, "PSMain") != 0;
                }
                Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
                Nri_PipelineDescAddVertexAttribute(desc, "COLOR", NriFormat.RGBA32_SFLOAT, 12);
                if (i == 0) {
                    // Depth only: the default depth state (less, writes), no color written.
                    Nri_PipelineDescSetColor(desc, colorFormat, NriColorWrite.None);
                    Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Less, 1, 0);
                } else {
                    // The triangle with depth testing off and, where the device has it, the depth
                    // bounds test.
                    Nri_PipelineDescSetColor(desc, colorFormat, NriColorWrite.RGBA);
                    Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.None, 0, this.depthBoundsTestSupported ? 1 : 0);
                }
                if (loaded) {
                    const pipeline = Nri_CreatePipelineFromDesc(device, this.pipelineLayout, desc);
                    if (i == 0) {
                        this.depthOnlyPipeline = pipeline;
                    } else {
                        this.boundsPipeline = pipeline;
                    }
                }
                Nri_DestroyPipelineDesc(desc);
            }
            if (!this.depthOnlyPipeline) {
                return false;
            }
            if (!this.boundsPipeline) {
                return false;
            }
            return true;
        }

        initialize(graphicsAPI: NriGraphicsAPI): int {
            const device = Nri_CreateDevice(this.sample, graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            // Without it the sample draws the whole triangle, as here.
            this.depthBoundsTestSupported = Nri_IsFeatureSupported(device, NriFeature.DepthBoundsTest) != 0;
            const support = this.depthBoundsTestSupported ? "supported" : "not supported";
            console.log(`Renderer: ${Nri_GetGraphicsAPIString(graphicsAPI)} (${Nri_GetAdapterName(device)}), depth bounds test: ${support}`);

            this.queue = Nri_GetGraphicsQueue(device);
            this.pipelineLayout = Nri_CreatePipelineLayout(device);
            this.test = Nri_IsTest(this.sample) != 0;

            // Swap chain: the sample's R8G8B8A8_UNORM back buffers, rendered into as they are.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain.init(this.sample, device, this.queue, false);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;

            // The depth buffer: D32, the window's size.
            if (!this.createDepth(device)) {
                console.log("Cannot create the depth buffer");
                return 0;
            }

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);

            // The triangle in clip space (the window's aspect ratio applied to y): top red at depth
            // 0.1, right green at 0.9, left blue at 0.5.
            const aspectRatio = Math.fround(1280.0 / 720.0);
            const y = Math.fround(0.25 * aspectRatio);
            const vertices: f32[] = [
                0.0, y, 0.1, 1.0, 0.0, 0.0, 1.0,
                0.25, -y, 0.9, 0.0, 1.0, 0.0, 1.0,
                -0.25, -y, 0.5, 0.0, 0.0, 1.0, 1.0,
            ];
            this.vertexBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            if (!this.vertexBuffer) {
                console.log("Cannot create the vertex buffer");
                return 0;
            }

            // Pipelines: depth_bounds_test.hlsl's shaders, as compiled for the Donut example.
            if (!this.createPipelines(graphicsAPI, device, format)) {
                console.log("Cannot load the depth bounds test shaders");
                return 0;
            }

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The swap chain's size and formats (its views in the textures' format).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
        }

        // The depth buffer at the swap chain's size; false if it can't be made.
        createDepth(device: NriDeviceHandle): boolean {
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            if (!depthTexture) {
                return false;
            }
            this.depthTexture = depthTexture;
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);
            return true;
        }

        destroyDepth() {
            const depthAttachment = this.depthAttachment;
            if (depthAttachment) {
                Nri_DestroyDescriptor(depthAttachment);
            }
            this.depthAttachment = null;
            const depthTexture = this.depthTexture;
            if (depthTexture) {
                Nri_DestroyTexture(depthTexture);
            }
            this.depthTexture = null;
        }

        // The window was resized (Nri_UseResizableWindow): the swap chain (and what has the window's
        // size) made again at its size, once the GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            Nri_DeviceWaitIdle(device);
            this.destroyDepth();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.createDepth(device);
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // PopulateCommandList.
        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                const depthTexture = this.depthTexture;
                const depthAttachment = this.depthAttachment;
                const vertexBuffer = this.vertexBuffer;
                const depthOnlyPipeline = this.depthOnlyPipeline;
                const boundsPipeline = this.boundsPipeline;
                if (depthTexture) {
                    if (depthAttachment) {
                        Nri_CmdBeginRenderingWithDepth(commandBuffer, this.swapChain.colorAttachment(index), depthAttachment);
                        Nri_CmdClearColor(commandBuffer, 0.392, 0.584, 0.929, 1.0);
                        Nri_CmdClearDepth(commandBuffer, 1.0);
                        if (vertexBuffer) {
                            if (depthOnlyPipeline) {
                                if (boundsPipeline) {
                                    Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
                                    Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
                                    Nri_CmdSetPipelineLayout(commandBuffer, this.pipelineLayout);
                                    Nri_CmdSetVertexBuffer(commandBuffer, 0, vertexBuffer, 0, VERTEX_STRIDE);

                                    // Render only the depth of the triangle to prime the depth value
                                    // of the triangle.
                                    Nri_CmdSetPipeline(commandBuffer, depthOnlyPipeline);
                                    Nri_CmdDraw(commandBuffer, 3, 1, 0, 0);

                                    // Move the depth bounds so we can see them move: [f, 1 - f], f in
                                    // [0.125, 0.25]. The test is against the depth primed above.
                                    // m_frameNumber: OnUpdate counts the frame before it's drawn.
                                    const frameNumber = frameIndex + 1;
                                    const f = Math.fround(0.125 + Math.fround(Math.fround(Math.sin(Math.fround((frameNumber & 0x7F) / 127.0))) * 0.125));
                                    Nri_CmdSetPipeline(commandBuffer, boundsPipeline);
                                    if (this.depthBoundsTestSupported) {
                                        Nri_CmdSetDepthBounds(commandBuffer, Math.fround(0.0 + f), Math.fround(1.0 - f));
                                    }
                                    Nri_CmdDraw(commandBuffer, 3, 1, 0, 0);
                                }
                            }
                        }
                        Nri_CmdEndRendering(commandBuffer);
                    }
                }

                // The test's last frame: read back
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        Nri_CmdTextureBarrier(commandBuffer, texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                        Nri_CmdReadbackTextureToBuffer(commandBuffer, readbackBuffer, this.rowPitch, texture, this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                    }
                }
                Nri_CmdTextureBarrier(commandBuffer, texture, presentFrom, NriTextureState.Present);
                Nri_EndCommandBuffer(commandBuffer);

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
                const depthOnlyPipeline = this.depthOnlyPipeline;
                if (depthOnlyPipeline) {
                    Nri_DestroyPipeline(depthOnlyPipeline);
                }
                const boundsPipeline = this.boundsPipeline;
                if (boundsPipeline) {
                    Nri_DestroyPipeline(boundsPipeline);
                }
                const vertexBuffer = this.vertexBuffer;
                if (vertexBuffer) {
                    Nri_DestroyBuffer(vertexBuffer);
                }
                this.destroyDepth();
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
                }
                Nri_DestroyPipelineLayout(this.pipelineLayout);
                this.frames.destroy();
                this.swapChain.destroy();
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        Nri_UseResizableWindow(sample);
        const depthBoundsTest = new DepthBoundsTest(sample);
        return depthBoundsTest.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return DepthBoundsTestNri.main(argc, argv);
}

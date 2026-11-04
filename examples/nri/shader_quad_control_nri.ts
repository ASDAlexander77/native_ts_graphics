/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";

namespace ShaderQuadControlNri {
    // shader_quad_control, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead
    // of Donut and NVRHI: the same shaders (shader_quad_control.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws, with NRIFramework's ImGui for the
    // options window. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no full quads, or no shaders for
    // the graphics API (D3D11).
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Shader Quad Control";

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // -test: checks the last frame, read back, as the Donut example does: the screen-space gradient
    // (red across, green down, blue 188), its corners at its ends: no red or green at the top left,
    // red at the top right, green at the bottom left, both at the bottom right; 45% to 70% of the
    // pixels colored (channels 61 or more apart).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const tl = pixels[0];
        const tr = pixels[width - 1];
        const bl = pixels[(height - 1) * width];
        const br = pixels[height * width - 1];
        if ((tl & 0xFF) > 10 || ((tl >> 8) & 0xFF) > 10 || (tr & 0xFF) < 245 || ((bl >> 8) & 0xFF) < 245
            || (br & 0xFF) < 245 || ((br >> 8) & 0xFF) < 245) {
            return "the corners aren't the gradient's ends";
        }
        let colored = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            const high = Math.max(r, Math.max(g, b));
            const low = Math.min(r, Math.min(g, b));
            if (high - low >= 61) {
                colored++;
            }
        }
        const total = width * height;
        const percent = 100.0 * colored / total;
        console.log(`Colored: ${percent}% (${colored} of ${total} pixels)`);
        if (percent < 45.0 || percent > 70.0) {
            return `Colored: ${percent}% of the pixels, not 45% to 70%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' shader_quad_control (as examples/shader_quad_control.ts ports it) to
    // NRI: a triangle over the screen showing its texture coordinates, its pixel shader run in full
    // quads (SPIR-V's RequireFullQuadsKHR, VK_KHR_shader_quad_control; D3D12 always runs whole
    // quads). With "Broadcast from the quad leader" (-broadcast), each pixel shows its quad's top left
    // pixel's coordinates instead (QuadReadLaneAt(uv, 0)), 2 x 2 blocks of one color.
    class ShaderQuadControl {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private viewFormat: NriFormat = NriFormat.Unknown;
        private pipelineLayout: NriPipelineLayoutHandle | null = null;
        private plainPipeline: NriPipelineHandle | null = null;
        private broadcastPipeline: NriPipelineHandle | null = null;
        private imgui: boolean = false;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // -broadcast: each quad shows its top left pixel's coordinates; -noUI: no options window.
        broadcast: boolean = false;
        noUI: boolean = false;

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
            this.test = Nri_IsTest(this.sample) != 0;

            // Swap chain: rendered through sRGB views, as the Donut example's sRGB back buffer.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;
            this.viewFormat = viewFormat;

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);

            // Shader model 6's quad operations (as the Donut example's), in full quads.
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (shader_quad_control.hlsl needs shader model 6)";
                return 0;
            }
            if (Nri_IsFeatureSupported(device, NriFeature.ShaderQuadControl) == 0) {
                this.unsupportedReason = "The graphics device has no shader quad control (Vulkan's VK_KHR_shader_quad_control, or D3D12)";
                return 0;
            }

            // The pipelines: the triangle over the screen (no culling, no depth), its pixel shader
            // plain or broadcasting (shader_quad_control.hlsl's BROADCAST permutations).
            const pipelineLayout = Nri_CreatePipelineLayout(device);
            this.pipelineLayout = pipelineLayout;
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/shader_quad_control/${folder}/shader_quad_control`;
            this.plainPipeline = this.createPipeline(device, pipelineLayout, shaders, "BROADCAST=0");
            this.broadcastPipeline = this.createPipeline(device, pipelineLayout, shaders, "BROADCAST=1");
            if (!this.plainPipeline || !this.broadcastPipeline) {
                console.log("Cannot load the shader quad control shaders");
                return 0;
            }

            // The options window.
            if (!this.noUI) {
                if (Nri_InitImgui(this.sample, device) == 0) {
                    console.log("Cannot initialize the user interface");
                    return 0;
                }
                this.imgui = true;
            }

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The pipeline with main_ps's permutation (its defines).
        createPipeline(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle, shaders: string, permutation: string) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_main_vs.bin`, "main_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShaderPermutation(desc, NriShaderStage.Pixel, `${shaders}_main_ps.bin`, "main_ps",
                    permutation) != 0;
            }
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, pipelineLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
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
            this.swapChain.recreate();
            this.sizeToSwapChain();
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The options window.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Options", 1);
            this.broadcast = Nri_ImguiCheckbox("Broadcast from the quad leader", this.broadcast ? 1 : 0) != 0;
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The sample's build_command_buffers: the triangle (between Nri_CmdBeginRendering and
        // Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle) {
            const pipelineLayout = this.pipelineLayout;
            const pipeline = this.broadcast ? this.broadcastPipeline : this.plainPipeline;
            if (!pipelineLayout || !pipeline) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, pipelineLayout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdDraw(commandBuffer, 3, 1, 0, 0);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            if (this.imgui) {
                this.buildUI();
            }

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: cleared to black, the triangle, the options window over it.
                Nri_BeginCommandBuffer(commandBuffer);
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                Nri_CmdTextureBarrier(commandBuffer, texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, this.swapChain.colorAttachment(index));
                Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 1.0);
                this.recordDraw(commandBuffer);
                if (this.imgui) {
                    Nri_CmdDrawImgui(this.sample, commandBuffer, this.viewFormat);
                }
                Nri_CmdEndRendering(commandBuffer);

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
                if (this.imgui) {
                    Nri_ImguiEndFrame(this.sample);
                }
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
                if (this.imgui) {
                    Nri_DestroyImgui(this.sample);
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
                }
                this.destroyPipeline(this.plainPipeline);
                this.destroyPipeline(this.broadcastPipeline);
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    Nri_DestroyPipelineLayout(pipelineLayout);
                }
                this.frames.destroy();
                this.swapChain.destroy();
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }

        destroyPipeline(pipeline: NriPipelineHandle | null) {
            if (pipeline) {
                Nri_DestroyPipeline(pipeline);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        Nri_UseResizableWindow(sample);
        const shaderQuadControl = new ShaderQuadControl(sample);
        // -broadcast: each quad shows its top left pixel's coordinates; -noUI: no options window.
        Nri_AddExampleOption(sample, "-broadcast");
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-broadcast") {
                shaderQuadControl.broadcast = true;
            } else if (arg == "-noUI") {
                shaderQuadControl.noUI = true;
            }
        }
        return shaderQuadControl.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return ShaderQuadControlNri.main(argc, argv);
}

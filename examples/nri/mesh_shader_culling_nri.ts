/// <reference path="../../core/nri/nri_interop.d.ts" />

namespace MeshShaderCullingNri {
    // mesh_shader_culling, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (mesh_shader_culling.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as meshlets_nri draws, with NRIFramework's ImGui for the
    // sample's overlay. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no task and mesh shaders.
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Mesh Shader Culling";

    // struct CullConstants { float cullCenterX, cullCenterY, cullRadius, meshletDensity; uint2
    // numWorkGroups; }, padded to 32 bytes; a queued frame's each CONSTANTS_STRIDE bytes apart (D3D12
    // constant buffer views' alignment).
    const CONST_CULL_CENTER_X = 0;
    const CONST_CULL_CENTER_Y = 1;
    const CONST_CULL_RADIUS = 2;
    const CONST_MESHLET_DENSITY = 3;
    const CONST_NUM_WORK_GROUPS_X = 4;
    const CONST_NUM_WORK_GROUPS_Y = 5;
    const CONST_FLOATS = 8;
    const CONSTANTS_STRIDE = 256;

    // The sample's camera: first person at (1, 0, 1), turned off for the mouse; WASD (GLFW key
    // codes) moves it one unit per second, and the square with it.
    const CAMERA_X = 1.0;
    const CAMERA_Z = 1.0;
    const TRANSLATION_SPEED = 1.0;
    const KEY_A = 65;
    const KEY_D = 68;
    const KEY_S = 83;
    const KEY_W = 87;

    // ApiVulkanSample's clear color.
    const CLEAR_COLOR = 0.002;

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

    // Task shader workgroups per side for each density level: 4 x 4, 6 x 6, 8 x 8.
    function workGroupsPerSide(densityLevel: int) {
        return densityLevel == 0 ? 4 : (densityLevel == 1 ? 6 : (densityLevel == 2 ? 8 : 2));
    }

    // -test: checks the last frame, read back, as the Donut example does. The corners are the dark
    // clear color; the meshlets the task shader kept (those within the cull radius) cover 55% to 80%
    // of the frame, 40% to 70% colored (channels 61 or more apart).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const clear = 0x070707;
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != clear) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 7, 7, 7`;
            }
        }
        let colored = 0;
        let meshlets = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            const high = Math.max(r, Math.max(g, b));
            const low = Math.min(r, Math.min(g, b));
            if (high - low >= 61) {
                colored++;
            }
            if (p != clear) {
                meshlets++;
            }
        }
        const total = width * height;
        const coloredPercent = 100.0 * colored / total;
        console.log(`Colored: ${coloredPercent}% (${colored} of ${total} pixels)`);
        if (coloredPercent < 40.0 || coloredPercent > 70.0) {
            return `Colored: ${coloredPercent}% of the pixels, not 40% to 70%`;
        }
        const meshletPercent = 100.0 * meshlets / total;
        console.log(`Meshlets: ${meshletPercent}% (${meshlets} of ${total} pixels)`);
        if (meshletPercent < 55.0 || meshletPercent > 80.0) {
            return `Meshlets: ${meshletPercent}% of the pixels, not 55% to 80%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' mesh_shader_culling (as examples/mesh_shader_culling.ts ports it) to
    // NRI: a square of N x N task shader workgroups of 2 x 2 invocations, each invocation a sub-rect,
    // in clip space. Task (amplification) shaders keep the sub-rects whose corners are all within a
    // circle around the center of the screen and launch a mesh shader workgroup for each, which
    // draws it as 2 x 2 colored quads. WASD moves the square. The Donut example's pipeline
    // statistics aren't shown: nri_interop has no queries.
    class MeshShaderCulling {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private pipelineLayout: NriPipelineLayoutHandle | null = null;
        private pipeline: NriPipelineHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private constantBufferView: NriDescriptorHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // The camera's x and z (the square's position is minus those).
        private cameraX: number = CAMERA_X;
        private cameraZ: number = CAMERA_Z;
        private constants: f32[] = [];

        // The sample's settings (its UBO and density level): -radius <0.5..2>, -density <0..2>;
        // -noUI: no overlay.
        cullRadius: number = 1.0;
        densityLevel: int = 2;
        noUI: boolean = false;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
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
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.test = Nri_IsTest(this.sample) != 0;

            // Swap chain: rendered through sRGB views, as the Donut example's sRGB back buffer.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, queuedFrameNum + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            const viewFormat = Nri_GetSrgbFormat(format);
            this.viewFormat = viewFormat;
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(this.swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, viewFormat),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }

            // Queued frames
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator)));
            }

            if (Nri_IsFeatureSupported(device, NriFeature.MeshShader) == 0) {
                this.unsupportedReason = "This example needs task and mesh shaders (D3D12 or Vulkan)";
                return 0;
            }

            // The layout: the task shader's constant buffer (b0), a root descriptor.
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootDescriptor(layoutDesc, 0, NriDescriptorType.ConstantBuffer, NriStage.Task);
            this.pipelineLayout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The pipeline: mesh_shader_culling.hlsl's shaders, as compiled for the Donut example; no
            // depth test, no culling.
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/mesh_shader_culling/${folder}/mesh_shader_culling`;
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Task, `${shaders}_cull_as.bin`, "cull_as") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Mesh, `${shaders}_cull_ms.bin`, "cull_ms") != 0;
            }
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_cull_ps.bin`, "cull_ps") != 0;
            }
            Nri_PipelineDescSetColor(desc, viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.pipeline = Nri_CreatePipelineFromDesc(device, pipelineLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            if (!this.pipeline) {
                console.log("Cannot load the mesh shader culling shaders");
                return 0;
            }

            // The constants, a queued frame's each.
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * CONSTANTS_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            if (!constantBuffer) {
                console.log("Cannot create the constant buffer");
                return 0;
            }
            this.constantBufferView = Nri_CreateConstantBufferView(constantBuffer, 0, CONSTANTS_STRIDE);

            // The sample's overlay.
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

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The framework's first person camera, never rotated: W and S along z, A and D along x
        // (none of them in the test).
        update() {
            if (this.test) {
                return;
            }
            const moveSpeed = Nri_GetFrameTime(this.sample) * TRANSLATION_SPEED;
            if (Nri_IsKeyPressed(this.sample, KEY_W) != 0) {
                this.cameraZ += moveSpeed;
            }
            if (Nri_IsKeyPressed(this.sample, KEY_S) != 0) {
                this.cameraZ -= moveSpeed;
            }
            if (Nri_IsKeyPressed(this.sample, KEY_A) != 0) {
                this.cameraX += moveSpeed;
            }
            if (Nri_IsKeyPressed(this.sample, KEY_D) != 0) {
                this.cameraX -= moveSpeed;
            }
        }

        // The sample's overlay (its title, ApiVulkanSample's default).
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Vulkan Example", 1);
            if (Nri_ImguiCollapsingHeader("Use WASD to move the square\n Configurations:\n", 1) != 0) {
                this.cullRadius = Nri_ImguiSliderFloat("Cull Radius: ", this.cullRadius, 0.5, 2.0);
                this.densityLevel = Nri_ImguiCombo("Meshlet Density Level: ", this.densityLevel, "4 x 4|6 x 6|8 x 8");
            }
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The square: N x N task shader workgroups (between Nri_CmdBeginRendering and
        // Nri_CmdEndRendering), their constants at constantsOffset.
        recordDraw(commandBuffer: NriCommandBufferHandle, constantsOffset: int) {
            const pipelineLayout = this.pipelineLayout;
            const pipeline = this.pipeline;
            const constantBuffer = this.constantBuffer;
            const constantBufferView = this.constantBufferView;
            if (!pipelineLayout || !pipeline || !constantBuffer || !constantBufferView) {
                return;
            }
            const groups = workGroupsPerSide(this.densityLevel);
            const c = this.constants;
            c[CONST_CULL_CENTER_X] = -this.cameraX;
            c[CONST_CULL_CENTER_Y] = -this.cameraZ;
            c[CONST_CULL_RADIUS] = this.cullRadius;
            c[CONST_MESHLET_DENSITY] = this.densityLevel;
            Nri_StoreInt32(Ref(c[CONST_NUM_WORK_GROUPS_X]), groups);
            Nri_StoreInt32(Ref(c[CONST_NUM_WORK_GROUPS_Y]), groups);
            Nri_WriteBuffer(constantBuffer, constantsOffset, Ref(c[0]), CONST_FLOATS * 4);

            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, pipelineLayout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetRootDescriptor(commandBuffer, 0, constantBufferView, constantsOffset);
            Nri_CmdDrawMeshTasks(commandBuffer, groups, groups, 1);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.update();
            if (this.imgui) {
                this.buildUI();
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: cleared, the square, the overlay over it.
                Nri_BeginCommandBuffer(commandBuffer);
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                Nri_CmdClearColor(commandBuffer, CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
                this.recordDraw(commandBuffer, queuedFrameIndex * CONSTANTS_STRIDE);
                if (this.imgui) {
                    Nri_CmdDrawImgui(this.sample, commandBuffer, this.viewFormat);
                }
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
                if (this.imgui) {
                    Nri_ImguiEndFrame(this.sample);
                }
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
                if (this.imgui) {
                    Nri_DestroyImgui(this.sample);
                }
                for (const queuedFrame of this.queuedFrames) {
                    Nri_DestroyCommandBuffer(queuedFrame.commandBuffer);
                    Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
                }
                for (const swapChainTexture of this.swapChainTextures) {
                    Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                    Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                    Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
                }
                const constantBufferView = this.constantBufferView;
                if (constantBufferView) {
                    Nri_DestroyDescriptor(constantBufferView);
                }
                const constantBuffer = this.constantBuffer;
                if (constantBuffer) {
                    Nri_DestroyBuffer(constantBuffer);
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
                }
                const pipeline = this.pipeline;
                if (pipeline) {
                    Nri_DestroyPipeline(pipeline);
                }
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    Nri_DestroyPipelineLayout(pipelineLayout);
                }
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const meshShaderCulling = new MeshShaderCulling(sample);
        // -radius <0.5..2>: the culling circle's radius; -density <0..2>: 4 x 4, 6 x 6 or 8 x 8;
        // -noUI: no overlay.
        Nri_AddExampleOptionWithValues(sample, "-radius", 1);
        Nri_AddExampleOptionWithValues(sample, "-density", 1);
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-radius" && i + 1 < argc) {
                i++;
                meshShaderCulling.cullRadius = Math.min(Math.max(parseFloat(Nri_GetArg(argc, argv, i)), 0.5), 2.0);
            } else if (arg == "-density" && i + 1 < argc) {
                i++;
                meshShaderCulling.densityLevel = Math.min(Math.max(parseInt(Nri_GetArg(argc, argv, i)), 0), 2);
            } else if (arg == "-noUI") {
                meshShaderCulling.noUI = true;
            }
        }
        return meshShaderCulling.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return MeshShaderCullingNri.main(argc, argv);
}

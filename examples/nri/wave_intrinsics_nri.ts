/// <reference path="../../core/nri/nri_interop.d.ts" />

namespace WaveIntrinsicsNri {
    // wave_intrinsics, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut
    // and NVRHI: the same shaders (wave_intrinsics.hlsl's and wave_intrinsics_magnify.hlsl's), through
    // the NRI calls core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui for the sample's UI layer.
    // This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no wave intrinsics, or no shaders
    // for the graphics API (D3D11).
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: D3D12 Shader Model 6 WaveIntrinsics Sample";
    // The sample's UI text lines, height / 720 * 20.7 apart (the Donut example's spacing for its 18
    // pixel Arial; ImGui's default font here, as the UI isn't compared).
    const LINE_SPACING_PER_HEIGHT = 20.7 / 720.0;

    // SceneConstantBuffer: orthProjMatrix, mousePosition, resolution, time, renderMode, laneSize,
    // padding to 256 bytes (a constant buffer view's multiple, too).
    const CB_SIZE = 256;

    // Pass 1's triangle: position, color.
    const TRIANGLE_VERTICES: f32[] = [
        0.0, 0.5, 0.0, 0.8, 0.8, 0.0, 1.0,
        0.5, -0.5, 0.0, 0.0, 0.8, 0.8, 1.0,
        -0.5, -0.5, 0.0, 0.8, 0.0, 0.8, 1.0,
    ];
    const TRIANGLE_STRIDE = 28;
    // Pass 2's rectangle: position, texture coordinates.
    const QUAD_STRIDE = 20;

    // GLFW's keys 1 to 9 (the render modes) and the left mouse button.
    const KEY_1 = 49;
    const MOUSE_LEFT = 0;

    // UILayer's labels, the selected one marked "[x]".
    const LABELS = [
        "Press 1~9 to switch render mode.",
        "1. Normal render.",
        "2. Color pixels by lane indices.",
        "3. Show first lane (white dot) in each wave.",
        "4. Show first(white dot) and last(red dot) lanes in each wave.",
        "5. Color pixels by active lane ratio (white = 100%; black = 0%).",
        "6. Broadcast the color of the first active lane to the wave.",
        "7. Average the color in a wave.",
        "8. Color pixels by prefix sum of distance between current and first lane.",
        "9. Color pixels by their quad id.",
    ];

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into, and its sets (its slice of the constant buffer).
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public constantView: NriDescriptorHandle, public sceneSet: NriDescriptorSetHandle, public composeSet: NriDescriptorSetHandle) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // One of the two layers: the texture, rendered into and read.
    class Target {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle, public view: NriDescriptorHandle) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does. The corners are black; the
    // triangle colored by the wave intrinsics, and the help text (unless -noUI), about 8% of the frame.
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
        let colored = 0;
        for (let i = 0; i < width * height; i++) {
            if ((pixels[i] & 0xFFFFFF) != 0) {
                colored++;
            }
        }
        const total = width * height;
        const percent = 100.0 * colored / total;
        console.log(`Triangle and text: ${percent}% (${colored} of ${total} pixels)`);
        if (percent < 6.0 || percent > 11.0) {
            return `Triangle and text: ${percent}% of the pixels, not 6% to 11%`;
        }
        return "";
    }

    // Port of DirectX-Graphics-Samples' D3D12SM6WaveIntrinsics (as examples/wave_intrinsics.ts ports
    // it) to NRI: a triangle drawn into a texture with its pixels colored by one of nine wave
    // intrinsics demonstrations (lane indices, first and last lanes, active lane ratios, broadcasts,
    // wave averages, prefix sums, quad ids), then that texture composed with a UI layer into the swap
    // chain, magnified around the mouse while its left button is held. Keys 1-9 pick the render mode.
    class WaveIntrinsics {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private format: NriFormat = NriFormat.Unknown;
        private sceneLayout: NriPipelineLayoutHandle | null = null;
        private composeLayout: NriPipelineLayoutHandle | null = null;
        private wavePipeline: NriPipelineHandle | null = null;
        private composePipeline: NriPipelineHandle | null = null;
        private triangleBuffer: NriBufferHandle | null = null;
        private quadBuffer: NriBufferHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private sampler: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        // Pass 1's texture and the UI layer's (RGBA8_UNORM).
        private sceneTarget: Target | null = null;
        private uiTarget: Target | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        renderMode: int = 1;
        // WaveLaneCountMin: the shaders' laneSize.
        private laneCount: int = 0;
        private mousePosition: number[] = [640.0, 360.0];
        // The number keys down in the frame before (a press switches the render mode once).
        private keysDown: boolean[] = [];
        private constants: f32[] = [];
        // -noUI: no UI layer text.
        noUI: boolean = false;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < CB_SIZE / 4; i++) {
                this.constants.push(0.0);
            }
            for (let i = 0; i < 9; i++) {
                this.keysDown.push(false);
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

            this.queue = Nri_GetGraphicsQueue(device);
            this.frameFence = Nri_CreateFence(device, 0);
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.test = Nri_IsTest(this.sample) != 0;

            // Swap chain: rendered in its own (UNORM) format, as the sample's R8G8B8A8_UNORM back
            // buffers (the Donut example's UnormBackBuffer).
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, queuedFrameNum + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            this.format = format;
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(this.swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, format),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }

            // Shader model 6 with wave intrinsics: D3D12 or Vulkan (the Donut example's shaders have
            // no DXBC).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (wave intrinsics need D3D12 or Vulkan)";
                return 0;
            }
            this.laneCount = Nri_GetWaveLaneCountMin(device);
            if (this.laneCount == 0) {
                this.unsupportedReason = "The graphics device does not support wave intrinsics (D3D12 or Vulkan)";
                return 0;
            }
            console.log(`Renderer: ${Nri_GetGraphicsAPIString(graphicsAPI)} (${Nri_GetAdapterName(device)}), wave lanes: ${this.laneCount} to ${Nri_GetWaveLaneCountMax(device)}`);

            // The layouts: pass 1's binds the constants (b0); pass 2's the constants, the two layers
            // (t0, t1) and the sampler (s0).
            const sceneLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(sceneLayoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            const sceneLayout = Nri_CreatePipelineLayoutFromDesc(device, sceneLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(sceneLayoutDesc);
            this.sceneLayout = sceneLayout;
            const composeLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(composeLayoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(composeLayoutDesc, 0, 0, 2, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(composeLayoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const composeLayout = Nri_CreatePipelineLayoutFromDesc(device, composeLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(composeLayoutDesc);
            this.composeLayout = composeLayout;
            if (!sceneLayout || !composeLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // Both passes: default rasterizer (back faces culled, clockwise front faces) and blend
            // states, no depth; pass 1 into its RGBA8_UNORM texture, pass 2 into the swap chain.
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/wave_intrinsics/${folder}/wave_intrinsics`;
            const waveDesc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(waveDesc, NriShaderStage.Vertex, `${shaders}_VSMain.bin`, "VSMain") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(waveDesc, NriShaderStage.Pixel, `${shaders}_PSMain.bin`, "PSMain") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(waveDesc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(waveDesc, "COLOR", NriFormat.RGBA32_SFLOAT, 12);
            Nri_PipelineDescSetCullMode(waveDesc, NriCullMode.Back);
            Nri_PipelineDescSetColor(waveDesc, NriFormat.RGBA8_UNORM, NriColorWrite.RGBA);
            if (loaded) {
                this.wavePipeline = Nri_CreatePipelineFromDesc(device, sceneLayout, waveDesc);
            }
            Nri_DestroyPipelineDesc(waveDesc);

            const composeDesc = Nri_CreatePipelineDesc();
            loaded = Nri_PipelineDescAddShader(composeDesc, NriShaderStage.Vertex, `${shaders}_magnify_VSMain.bin`, "VSMain") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(composeDesc, NriShaderStage.Pixel, `${shaders}_magnify_PSMain.bin`, "PSMain") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(composeDesc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(composeDesc, "TEXCOORD", NriFormat.RG32_SFLOAT, 12);
            Nri_PipelineDescSetCullMode(composeDesc, NriCullMode.Back);
            Nri_PipelineDescSetColor(composeDesc, format, NriColorWrite.RGBA);
            if (loaded) {
                this.composePipeline = Nri_CreatePipelineFromDesc(device, composeLayout, composeDesc);
            }
            Nri_DestroyPipelineDesc(composeDesc);
            if (!this.wavePipeline || !this.composePipeline) {
                console.log("Cannot load the wave intrinsics shaders");
                return 0;
            }

            // LoadSizeDependentResources: pass 1's texture and the UI layer's, and pass 2's rectangle,
            // its x scaled by the aspect ratio as the orthographic projection unscales it.
            const a = Math.fround(this.width / this.height);
            const quad: f32[] = [
                -a, -1.0, 0.0, 0.0, 1.0,
                -a, 1.0, 0.0, 0.0, 0.0,
                a, 1.0, 0.0, 1.0, 0.0,

                -a, -1.0, 0.0, 0.0, 1.0,
                a, 1.0, 0.0, 1.0, 0.0,
                a, -1.0, 0.0, 1.0, 1.0,
            ];
            this.triangleBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(TRIANGLE_VERTICES[0]), TRIANGLE_VERTICES.length * 4,
                NriBufferUsage.VertexBuffer);
            this.quadBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(quad[0]), quad.length * 4, NriBufferUsage.VertexBuffer);
            this.sceneTarget = this.createTarget(device);
            this.uiTarget = this.createTarget(device);
            const sceneTarget = this.sceneTarget;
            const uiTarget = this.uiTarget;
            if (!this.triangleBuffer || !this.quadBuffer || !sceneTarget || !uiTarget) {
                console.log("Cannot create the buffers and textures");
                return 0;
            }

            // The sample's static sampler: point filtering, wrapping.
            const sampler = Nri_CreateSamplerWithMipFilter(device, NriFilter.Nearest, NriFilter.Nearest, NriAddressMode.Repeat, 1);
            this.sampler = sampler;
            // The constants: a 256-byte slice per queued frame, in both passes' sets.
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * CB_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = Nri_CreateDescriptorPool(device, 2 * queuedFrameNum, queuedFrameNum, 2 * queuedFrameNum,
                2 * queuedFrameNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!sampler || !constantBuffer || !descriptorPool) {
                console.log("Cannot create the descriptors");
                return 0;
            }

            // Queued frames
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const constantView = Nri_CreateConstantBufferView(constantBuffer, i * CB_SIZE, CB_SIZE);
                const sceneSet = Nri_AllocateDescriptorSet(descriptorPool, sceneLayout, 0, 0);
                const composeSet = Nri_AllocateDescriptorSet(descriptorPool, composeLayout, 0, 0);
                if (!constantView || !sceneSet || !composeSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(sceneSet, 0, 0, constantView);
                Nri_UpdateDescriptor(composeSet, 0, 0, constantView);
                Nri_UpdateDescriptor(composeSet, 1, 0, sceneTarget.view);
                Nri_UpdateDescriptor(composeSet, 1, 1, uiTarget.view);
                Nri_UpdateDescriptor(composeSet, 2, 0, sampler);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), constantView, sceneSet,
                    composeSet));
            }

            // The UI layer's text.
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
            }
            return 1;
        }

        // A layer: an RGBA8_UNORM render target the swap chain's size, read by pass 2.
        createTarget(device: NriDeviceHandle): Target | null {
            const texture = Nri_CreateRenderTargetTexture(device, this.queue, this.width, this.height, NriFormat.RGBA8_UNORM);
            if (!texture) {
                return null;
            }
            return new Target(texture, Nri_CreateColorAttachmentView(texture, NriFormat.RGBA8_UNORM),
                Nri_CreateTextureView(texture, NriFormat.RGBA8_UNORM));
        }

        // Waits for the frame that last used this frame's command allocator (and constants).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The keys 1-9 pick the render mode; the magnified area follows the mouse while its left
        // button is down.
        handleInput() {
            for (let i = 0; i < 9; i++) {
                const down = Nri_IsKeyPressed(this.sample, KEY_1 + i) != 0;
                if (down && !this.keysDown[i]) {
                    this.renderMode = i + 1;
                }
                this.keysDown[i] = down;
            }
            if (Nri_IsButtonPressed(this.sample, MOUSE_LEFT) != 0) {
                this.mousePosition[0] = Math.fround(Nri_GetMouseX(this.sample));
                this.mousePosition[1] = Math.fround(Nri_GetMouseY(this.sample));
            }
        }

        // OnUpdate: the orthographic projection (2 * aspect wide, 2 high, depth 0 to 1; transposed for
        // HLSL's column-major matrices: it is diagonal, so as is), the mouse, the resolution, the
        // render mode and WaveLaneCountMin, into the queued frame's slice.
        writeConstants(queuedFrameIndex: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            const aspectRatio = Math.fround(this.width / this.height);
            for (let i = 0; i < 16; i++) {
                this.constants[i] = 0.0;
            }
            this.constants[0] = Math.fround(2.0 / Math.fround(2.0 * aspectRatio));
            this.constants[5] = 1.0;
            this.constants[10] = 1.0;
            this.constants[15] = 1.0;
            this.constants[16] = this.mousePosition[0];
            this.constants[17] = this.mousePosition[1];
            this.constants[18] = this.width;
            this.constants[19] = this.height;
            // time (unused: the sample never advances it).
            this.constants[20] = 0.0;
            // renderMode and laneSize after time: the constants' uints.
            Nri_StoreInt32(Ref(this.constants[21]), this.renderMode);
            Nri_StoreInt32(Ref(this.constants[22]), this.laneCount);
            Nri_WriteBuffer(constantBuffer, queuedFrameIndex * CB_SIZE, Ref(this.constants[0]), CB_SIZE);
        }

        // UILayer: its labels from the top left corner, one a line.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            const lineSpacing = LINE_SPACING_PER_HEIGHT * this.height;
            for (let i = 0; i < LABELS.length; i++) {
                let label = LABELS[i];
                if (i == this.renderMode) {
                    label = label + "[x]";
                }
                Nri_ImguiDrawText(0.0, i * lineSpacing, label, 1.0, 1.0, 1.0, 1.0, 0);
            }
            Nri_ImguiRender(this.sample);
        }

        // RenderScene's pass 1: the triangle into its texture, cleared to transparent black; then the
        // UI layer's texture, cleared, with the text drawn into it.
        recordLayers(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const sceneLayout = this.sceneLayout;
            const wavePipeline = this.wavePipeline;
            const triangleBuffer = this.triangleBuffer;
            const sceneTarget = this.sceneTarget;
            const uiTarget = this.uiTarget;
            if (!sceneLayout || !wavePipeline || !triangleBuffer || !sceneTarget || !uiTarget) {
                return;
            }
            Nri_CmdTextureBarrier(commandBuffer, sceneTarget.texture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            Nri_CmdBeginRendering(commandBuffer, sceneTarget.colorAttachment);
            Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, sceneLayout);
            Nri_CmdSetPipeline(commandBuffer, wavePipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, queuedFrame.sceneSet);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, triangleBuffer, 0, TRIANGLE_STRIDE);
            Nri_CmdDraw(commandBuffer, 3, 1, 0, 0);
            Nri_CmdEndRendering(commandBuffer);
            Nri_CmdTextureBarrier(commandBuffer, sceneTarget.texture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);

            if (this.imgui) {
                Nri_CmdCopyImguiData(this.sample, commandBuffer);
            }
            Nri_CmdTextureBarrier(commandBuffer, uiTarget.texture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            Nri_CmdBeginRendering(commandBuffer, uiTarget.colorAttachment);
            Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
            if (this.imgui) {
                Nri_CmdDrawImgui(this.sample, commandBuffer, NriFormat.RGBA8_UNORM);
            }
            Nri_CmdEndRendering(commandBuffer);
            Nri_CmdTextureBarrier(commandBuffer, uiTarget.texture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
        }

        // Pass 2: the layers composed, magnified around the mouse, into the swap chain texture
        // (cleared to black first; between Nri_CmdBeginRendering and Nri_CmdEndRendering). The sample
        // draws the rectangle twice (two instances of the same six vertices, without blending): once
        // is the same.
        recordCompose(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const composeLayout = this.composeLayout;
            const composePipeline = this.composePipeline;
            const quadBuffer = this.quadBuffer;
            if (!composeLayout || !composePipeline || !quadBuffer) {
                return;
            }
            Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, composeLayout);
            Nri_CmdSetPipeline(commandBuffer, composePipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, queuedFrame.composeSet);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, quadBuffer, 0, QUAD_STRIDE);
            Nri_CmdDraw(commandBuffer, 6, 1, 0, 0);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            const descriptorPool = this.descriptorPool;
            if (!descriptorPool) {
                return;
            }
            if (!this.test) {
                this.handleInput();
            }
            this.writeConstants(queuedFrameIndex);
            if (this.imgui) {
                this.buildUI();
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the layers, then their composition into the swap chain texture.
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
                this.recordLayers(commandBuffer, queuedFrame);
                // (The UI's draw sets ImGui's own descriptor pool: D3D12 wants the sets' heaps bound again.)
                Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                this.recordCompose(commandBuffer, queuedFrame);
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
            if (Nri_ReadBufferRGBA8(readbackBuffer, this.rowPitch, this.width, this.height, this.format,
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
                    Nri_DestroyDescriptor(queuedFrame.constantView);
                }
                for (const swapChainTexture of this.swapChainTextures) {
                    Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                    Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                    Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                const sampler = this.sampler;
                if (sampler) {
                    Nri_DestroyDescriptor(sampler);
                }
                this.destroyTarget(this.sceneTarget);
                this.destroyTarget(this.uiTarget);
                this.destroyBuffer(this.triangleBuffer);
                this.destroyBuffer(this.quadBuffer);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.wavePipeline);
                this.destroyPipeline(this.composePipeline);
                this.destroyLayout(this.sceneLayout);
                this.destroyLayout(this.composeLayout);
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }

        destroyTarget(target: Target | null) {
            if (target) {
                Nri_DestroyDescriptor(target.colorAttachment);
                Nri_DestroyDescriptor(target.view);
                Nri_DestroyTexture(target.texture);
            }
        }

        destroyBuffer(buffer: NriBufferHandle | null) {
            if (buffer) {
                Nri_DestroyBuffer(buffer);
            }
        }

        destroyPipeline(pipeline: NriPipelineHandle | null) {
            if (pipeline) {
                Nri_DestroyPipeline(pipeline);
            }
        }

        destroyLayout(layout: NriPipelineLayoutHandle | null) {
            if (layout) {
                Nri_DestroyPipelineLayout(layout);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const waveIntrinsics = new WaveIntrinsics(sample);
        // -noUI: no UI layer text.
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            if (Nri_GetArg(argc, argv, i) == "-noUI") {
                waveIntrinsics.noUI = true;
            }
        }
        return waveIntrinsics.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return WaveIntrinsicsNri.main(argc, argv);
}

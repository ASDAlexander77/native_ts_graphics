/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

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

    // A frame in flight's own data: its sets (its slice of the constant buffer).
    class QueuedFrame {
        constructor(public constantView: NriDescriptor, public sceneSet: NriDescriptorSet, public composeSet: NriDescriptorSet) {
        }
    }

    // One of the two layers: the texture, rendered into and read.
    class Target {
        constructor(public texture: NriTexture, public colorAttachment: NriDescriptor, public view: NriDescriptor) {
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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private format: NriFormat = NriFormat.Unknown;
        private sceneLayout: NriPipelineLayout | null = null;
        private composeLayout: NriPipelineLayout | null = null;
        private wavePipeline: NriPipeline | null = null;
        private composePipeline: NriPipeline | null = null;
        private triangleBuffer: NriBuffer | null = null;
        private quadBuffer: NriBuffer | null = null;
        private constantBuffer: NriBuffer | null = null;
        private sampler: NriDescriptor | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        // Pass 1's texture and the UI layer's (RGBA8_UNORM).
        private sceneTarget: Target | null = null;
        private uiTarget: Target | null = null;
        private imgui: boolean = false;
        // The swap chain's size: the window's when it was (re)created.
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
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;

        constructor(private sample: NriSample) {
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

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // Swap chain: rendered in its own (UNORM) format, as the sample's R8G8B8A8_UNORM back
            // buffers (the Donut example's UnormBackBuffer).
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, false);
            this.sizeToSwapChain();
            const format = this.format;

            // Shader model 6 with wave intrinsics: D3D12 or Vulkan (the Donut example's shaders have
            // no DXBC).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (wave intrinsics need D3D12 or Vulkan)";
                return 0;
            }
            this.laneCount = device.getWaveLaneCountMin();
            if (this.laneCount == 0) {
                this.unsupportedReason = "The graphics device does not support wave intrinsics (D3D12 or Vulkan)";
                return 0;
            }
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()}), wave lanes: ${this.laneCount} to ${device.getWaveLaneCountMax()}`);

            // The layouts: pass 1's binds the constants (b0); pass 2's the constants, the two layers
            // (t0, t1) and the sampler (s0).
            const sceneLayoutDesc = NriPipelineLayoutDesc.create();
            sceneLayoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            const sceneLayout = device.createPipelineLayoutFromDesc(sceneLayoutDesc);
            sceneLayoutDesc.destroy();
            this.sceneLayout = sceneLayout;
            const composeLayoutDesc = NriPipelineLayoutDesc.create();
            composeLayoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            composeLayoutDesc.addRange(0, 0, 2, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            composeLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const composeLayout = device.createPipelineLayoutFromDesc(composeLayoutDesc);
            composeLayoutDesc.destroy();
            this.composeLayout = composeLayout;
            if (!sceneLayout || !composeLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // Both passes: default rasterizer (back faces culled, clockwise front faces) and blend
            // states, no depth; pass 1 into its RGBA8_UNORM texture, pass 2 into the swap chain.
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/wave_intrinsics/${folder}/wave_intrinsics`;
            const waveDesc = NriPipelineDesc.create();
            let loaded = waveDesc.addShader(NriShaderStage.Vertex, `${shaders}_VSMain.bin`, "VSMain") != 0;
            if (loaded) {
                loaded = waveDesc.addShader(NriShaderStage.Pixel, `${shaders}_PSMain.bin`, "PSMain") != 0;
            }
            waveDesc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            waveDesc.addVertexAttribute("COLOR", NriFormat.RGBA32_SFLOAT, 12);
            waveDesc.setCullMode(NriCullMode.Back);
            waveDesc.setColor(NriFormat.RGBA8_UNORM, NriColorWrite.RGBA);
            if (loaded) {
                this.wavePipeline = device.createPipelineFromDesc(sceneLayout, waveDesc);
            }
            waveDesc.destroy();

            const composeDesc = NriPipelineDesc.create();
            loaded = composeDesc.addShader(NriShaderStage.Vertex, `${shaders}_magnify_VSMain.bin`, "VSMain") != 0;
            if (loaded) {
                loaded = composeDesc.addShader(NriShaderStage.Pixel, `${shaders}_magnify_PSMain.bin`, "PSMain") != 0;
            }
            composeDesc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            composeDesc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, 12);
            composeDesc.setCullMode(NriCullMode.Back);
            composeDesc.setColor(format, NriColorWrite.RGBA);
            if (loaded) {
                this.composePipeline = device.createPipelineFromDesc(composeLayout, composeDesc);
            }
            composeDesc.destroy();
            if (!this.wavePipeline || !this.composePipeline) {
                console.log("Cannot load the wave intrinsics shaders");
                return 0;
            }

            // LoadSizeDependentResources: pass 1's texture and the UI layer's, and pass 2's rectangle.
            this.triangleBuffer = device.createUploadedBuffer(this.queue, Ref(TRIANGLE_VERTICES[0]), TRIANGLE_VERTICES.length * 4,
                NriBufferUsage.VertexBuffer);
            this.createSizeDependentResources(device);
            const sceneTarget = this.sceneTarget;
            const uiTarget = this.uiTarget;
            if (!this.triangleBuffer || !this.quadBuffer || !sceneTarget || !uiTarget) {
                console.log("Cannot create the buffers and textures");
                return 0;
            }

            // The sample's static sampler: point filtering, wrapping.
            const sampler = device.createSamplerWithMipFilter(NriFilter.Nearest, NriFilter.Nearest, NriAddressMode.Repeat, 1);
            this.sampler = sampler;
            // The constants: a 256-byte slice per queued frame, in both passes' sets.
            const constantBuffer = device.createHostBuffer(queuedFrameNum * CB_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = device.createDescriptorPool(2 * queuedFrameNum, queuedFrameNum, 2 * queuedFrameNum,
                2 * queuedFrameNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!sampler || !constantBuffer || !descriptorPool) {
                console.log("Cannot create the descriptors");
                return 0;
            }

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const constantView = constantBuffer.createConstantView(i * CB_SIZE, CB_SIZE);
                const sceneSet = descriptorPool.allocateDescriptorSet(sceneLayout, 0, 0);
                const composeSet = descriptorPool.allocateDescriptorSet(composeLayout, 0, 0);
                if (!constantView || !sceneSet || !composeSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                sceneSet.updateDescriptor(0, 0, constantView);
                composeSet.updateDescriptor(0, 0, constantView);
                composeSet.updateDescriptor(2, 0, sampler);
                this.queuedFrames.push(new QueuedFrame(constantView, sceneSet,
                    composeSet));
            }
            this.updateTargetDescriptors();

            // The UI layer's text.
            if (!this.noUI) {
                if (this.sample.initImgui(device) == 0) {
                    console.log("Cannot initialize the user interface");
                    return 0;
                }
                this.imgui = true;
            }

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
            }
            return 1;
        }

        // The swap chain's size and formats (its views in the textures' format).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.format = this.swapChain.format();
        }

        // The resources of the swap chain's size: pass 2's rectangle (its x scaled by the aspect ratio,
        // as the orthographic projection unscales it), pass 1's texture and the UI layer's.
        createSizeDependentResources(device: NriDevice) {
            const a = Math.fround(this.width / this.height);
            const quad: f32[] = [
                -a, -1.0, 0.0, 0.0, 1.0,
                -a, 1.0, 0.0, 0.0, 0.0,
                a, 1.0, 0.0, 1.0, 0.0,

                -a, -1.0, 0.0, 0.0, 1.0,
                a, 1.0, 0.0, 1.0, 0.0,
                a, -1.0, 0.0, 1.0, 1.0,
            ];
            this.quadBuffer = device.createUploadedBuffer(this.queue, Ref(quad[0]), quad.length * 4, NriBufferUsage.VertexBuffer);
            this.sceneTarget = this.createTarget(device);
            this.uiTarget = this.createTarget(device);
        }

        destroySizeDependentResources() {
            this.destroyTarget(this.sceneTarget);
            this.destroyTarget(this.uiTarget);
            this.destroyBuffer(this.quadBuffer);
            this.sceneTarget = null;
            this.uiTarget = null;
            this.quadBuffer = null;
        }

        // Pass 2's sets read the two layers.
        updateTargetDescriptors() {
            const sceneTarget = this.sceneTarget;
            const uiTarget = this.uiTarget;
            if (!sceneTarget || !uiTarget) {
                return;
            }
            for (const queuedFrame of this.queuedFrames) {
                queuedFrame.composeSet.updateDescriptor(1, 0, sceneTarget.view);
                queuedFrame.composeSet.updateDescriptor(1, 1, uiTarget.view);
            }
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain, the layers and the rectangle made again at its size, once the
        // GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            device.waitIdle();
            this.destroySizeDependentResources();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.createSizeDependentResources(device);
            this.updateTargetDescriptors();
        }

        // A layer: an RGBA8_UNORM render target the swap chain's size, read by pass 2.
        createTarget(device: NriDevice): Target | null {
            const texture = device.createRenderTargetTexture(this.queue, this.width, this.height, NriFormat.RGBA8_UNORM);
            if (!texture) {
                return null;
            }
            return new Target(texture, texture.createColorAttachmentView(NriFormat.RGBA8_UNORM),
                texture.createView(NriFormat.RGBA8_UNORM));
        }

        // Waits for the frame that last used this frame's command allocator (and constants).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The keys 1-9 pick the render mode; the magnified area follows the mouse while its left
        // button is down.
        handleInput() {
            for (let i = 0; i < 9; i++) {
                const down = this.sample.isKeyPressed(KEY_1 + i) != 0;
                if (down && !this.keysDown[i]) {
                    this.renderMode = i + 1;
                }
                this.keysDown[i] = down;
            }
            if (this.sample.isButtonPressed(MOUSE_LEFT) != 0) {
                this.mousePosition[0] = Math.fround(this.sample.getMouseX());
                this.mousePosition[1] = Math.fround(this.sample.getMouseY());
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
            Nri.storeInt32(Ref(this.constants[21]), this.renderMode);
            Nri.storeInt32(Ref(this.constants[22]), this.laneCount);
            constantBuffer.write(queuedFrameIndex * CB_SIZE, Ref(this.constants[0]), CB_SIZE);
        }

        // UILayer: its labels from the top left corner, one a line.
        buildUI() {
            this.sample.imguiNewFrame();
            const lineSpacing = LINE_SPACING_PER_HEIGHT * this.height;
            for (let i = 0; i < LABELS.length; i++) {
                let label = LABELS[i];
                if (i == this.renderMode) {
                    label = label + "[x]";
                }
                NriImgui.drawText(0.0, i * lineSpacing, label, 1.0, 1.0, 1.0, 1.0, 0);
            }
            this.sample.imguiRender();
        }

        // RenderScene's pass 1: the triangle into its texture, cleared to transparent black; then the
        // UI layer's texture, cleared, with the text drawn into it.
        recordLayers(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const sceneLayout = this.sceneLayout;
            const wavePipeline = this.wavePipeline;
            const triangleBuffer = this.triangleBuffer;
            const sceneTarget = this.sceneTarget;
            const uiTarget = this.uiTarget;
            if (!sceneLayout || !wavePipeline || !triangleBuffer || !sceneTarget || !uiTarget) {
                return;
            }
            commandBuffer.textureBarrier(sceneTarget.texture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(sceneTarget.colorAttachment);
            commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(sceneLayout);
            commandBuffer.setPipeline(wavePipeline);
            commandBuffer.setDescriptorSet(0, queuedFrame.sceneSet);
            commandBuffer.setVertexBuffer(0, triangleBuffer, 0, TRIANGLE_STRIDE);
            commandBuffer.draw(3, 1, 0, 0);
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(sceneTarget.texture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);

            if (this.imgui) {
                this.sample.copyImguiData(commandBuffer);
            }
            commandBuffer.textureBarrier(uiTarget.texture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(uiTarget.colorAttachment);
            commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
            if (this.imgui) {
                this.sample.drawImgui(commandBuffer, NriFormat.RGBA8_UNORM);
            }
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(uiTarget.texture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
        }

        // Pass 2: the layers composed, magnified around the mouse, into the swap chain texture
        // (cleared to black first; between NriCommandBuffer.beginRendering and NriCommandBuffer.endRendering). The sample
        // draws the rectangle twice (two instances of the same six vertices, without blending): once
        // is the same.
        recordCompose(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const composeLayout = this.composeLayout;
            const composePipeline = this.composePipeline;
            const quadBuffer = this.quadBuffer;
            if (!composeLayout || !composePipeline || !quadBuffer) {
                return;
            }
            commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(composeLayout);
            commandBuffer.setPipeline(composePipeline);
            commandBuffer.setDescriptorSet(0, queuedFrame.composeSet);
            commandBuffer.setVertexBuffer(0, quadBuffer, 0, QUAD_STRIDE);
            commandBuffer.draw(6, 1, 0, 0);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
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
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the layers, then their composition into the swap chain texture.
                commandBuffer.begin();
                commandBuffer.setDescriptorPool(descriptorPool);
                this.recordLayers(commandBuffer, queuedFrame);
                // (The UI's draw sets ImGui's own descriptor pool: D3D12 wants the sets' heaps bound again.)
                commandBuffer.setDescriptorPool(descriptorPool);
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                this.recordCompose(commandBuffer, queuedFrame);
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
                if (this.imgui) {
                    this.sample.imguiEndFrame();
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
            device.waitIdle();
            const pixels: int[] = [];
            for (let i = 0; i < this.width * this.height; i++) {
                pixels.push(0);
            }
            if (readbackBuffer.readRGBA8(this.rowPitch, this.width, this.height, this.format,
                Ref(pixels[0]), pixels.length) == 0) {
                return [];
            }
            return pixels;
        }

        destroy() {
            const device = this.device;
            if (device) {
                device.waitIdle();
                if (this.imgui) {
                    this.sample.destroyImgui();
                }
                for (const queuedFrame of this.queuedFrames) {
                    queuedFrame.constantView.destroy();
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                const sampler = this.sampler;
                if (sampler) {
                    sampler.destroy();
                }
                this.destroySizeDependentResources();
                this.destroyBuffer(this.triangleBuffer);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.wavePipeline);
                this.destroyPipeline(this.composePipeline);
                this.destroyLayout(this.sceneLayout);
                this.destroyLayout(this.composeLayout);
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }

        destroyTarget(target: Target | null) {
            if (target) {
                target.colorAttachment.destroy();
                target.view.destroy();
                target.texture.destroy();
            }
        }

        destroyBuffer(buffer: NriBuffer | null) {
            if (buffer) {
                buffer.destroy();
            }
        }

        destroyPipeline(pipeline: NriPipeline | null) {
            if (pipeline) {
                pipeline.destroy();
            }
        }

        destroyLayout(layout: NriPipelineLayout | null) {
            if (layout) {
                layout.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const waveIntrinsics = new WaveIntrinsics(sample);
        // -noUI: no UI layer text.
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            if (Nri.getArg(argc, argv, i) == "-noUI") {
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

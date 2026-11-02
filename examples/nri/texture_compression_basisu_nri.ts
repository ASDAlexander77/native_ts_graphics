/// <reference path="../../core/nri/nri_interop.d.ts" />
import { TranscodedTexture } from "../../core/transcoded_texture";
import { radians, perspective } from "../../core/matrix";
import { formatFixed, comboItems } from "../../core/text_format";
import { SampleView } from "../../core/vulkan_samples_camera";

namespace TextureCompressionBasisuNri {
    // texture_compression_basisu, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework
    // instead of Donut and NVRHI: the same shaders (texture_compression_basisu.hlsl's), KTX 2 files
    // and Basis Universal transcoder (core/basis_transcoder.cpp, compiled into nri_interop), through
    // the NRI calls core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui for the sample's
    // overlay. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Basis Universal texture loading";

    // The sample's KTX 2 files (Vulkan-Samples' assets, copied at build time: see
    // VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt): Kodak images, Basis Universal UASTC (Zstandard
    // supercompressed) and ETC1S, sRGB, 10 levels each.
    const TEXTURE_DIR = "media/texture_compression_basisu/";
    const TEXTURE_FILE_NAMES = ["kodim23_UASTC.ktx2", "kodim23_ETC1S.ktx2", "kodim20_UASTC.ktx2", "kodim20_ETC1S.ktx2",
        "kodim05_UASTC.ktx2", "kodim05_ETC1S.ktx2", "kodim03_UASTC.ktx2", "kodim03_ETC1S.ktx2"];

    // The sample's transcode targets in its order of preference, those the device samples kept (its
    // get_available_target_formats; uncompressed RGBA always), as the Donut example has them: no ASTC
    // or ETC2 (NVRHI has no such formats; NRI's are left out to match). The files are sRGB, so the
    // transcoded formats are the sRGB ones (as ktxTexture2_TranscodeBasis picks them).
    const TARGET_TRANSCODE_FORMATS = [TranscodeFormat.BC7, TranscodeFormat.BC3, TranscodeFormat.ASTC4x4, TranscodeFormat.ETC2,
        TranscodeFormat.RGBA32];
    const TARGET_TEXTURE_FORMATS = [NriFormat.BC7_RGBA_SRGB, NriFormat.BC3_RGBA_SRGB, NriFormat.Unknown, NriFormat.Unknown,
        NriFormat.RGBA8_SRGB];
    const TARGET_NAMES = ["KTX_TTF_BC7_RGBA", "KTX_TTF_BC3_RGBA", "KTX_TTF_ASTC_4x4_RGBA", "KTX_TTF_ETC2_RGBA", "KTX_TTF_RGBA32"];

    // nri::FormatSupportBits::TEXTURE: sampled by shaders (NVRHI's Texture | ShaderSample).
    const SUPPORT_TEXTURE = 0x1;

    // The quad's vertices: float3 position, float2 uv.
    const VERTEX_FLOATS = 5;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const QUAD_VERTICES = [
        1.5, 1.0, 0.0, 1.0, 1.0,
        -1.5, 1.0, 0.0, 0.0, 1.0,
        -1.5, -1.0, 0.0, 0.0, 0.0,
        1.5, -1.0, 0.0, 1.0, 0.0,
    ];
    const QUAD_INDICES = [0, 1, 2, 2, 3, 0];

    // struct UBO { float4x4 projection, model; }, a queued frame's copy each, 256 bytes apart
    // (constant buffer views' alignment).
    const UBO_PROJECTION = 0;
    const UBO_MODEL = 16;
    const UBO_FLOATS = 32;
    const UBO_STRIDE = 256;

    // The sample's view: ApiVulkanSample's zoom and rotation (degrees), its projection.
    const ZOOM = -1.75;
    const ROTATION = [0.0, 0.0, 0.0];
    const FOV = 60.0;
    const Z_NEAR = 0.001;
    const Z_FAR = 256.0;

    // The render pass's clear color, and in the sRGB back buffer (0xBBGGRR).
    const CLEAR_COLOR = 0.05;
    const CLEAR_RGB = 0x3F3F3F;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into, and its descriptor set (its copy of the UBO).
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public descriptorSet: NriDescriptorSetHandle | null, public uboView: NriDescriptorHandle | null) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // The share of the pixels in [low, high], as the Donut example's TestCheck.share reports it.
    function share(count: int, total: int, low: number, high: number, name: string) {
        const percent = 100.0 * count / total;
        console.log(`${name}: ${percent}% (${count} of ${total} pixels)`);
        if (percent < low || percent > high) {
            return `${name}: ${percent}% of the pixels, not ${low}% to ${high}%`;
        }
        return "";
    }

    // -test: checks the last frame, read back, as the Donut example does. The corners are the gray
    // clear color; the transcoded parrots cover about 84% of the frame, about 6% the red parrot's red.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != CLEAR_RGB) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 63, 63, 63`;
            }
        }
        const total = width * height;
        let image = 0;
        let red = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            if ((p & 0xFFFFFF) != CLEAR_RGB) {
                image++;
            }
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r >= 151 && g <= 89 && b <= 89) {
                red++;
            }
        }
        const drawn = share(image, total, 75.0, 90.0, "Image");
        if (drawn != "") {
            return drawn;
        }
        return share(red, total, 4.0, 9.0, "Red");
    }

    // Port of Vulkan-Samples' texture_compression_basisu (as examples/texture_compression_basisu.ts
    // ports it) to NRI: a quad with a Kodak image loaded from a Basis Universal KTX 2 file and
    // transcoded on the CPU into a format the GPU samples (BC7, BC3 or uncompressed here), all its
    // levels uploaded; the UI picks the file and the format, and times the transcoding. The left
    // mouse button turns the quad, the right one zooms, the middle one pans (ApiVulkanSample's
    // controls).
    class TextureCompressionBasisu {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private layout: NriPipelineLayoutHandle | null = null;
        private pipeline: NriPipelineHandle | null = null;
        private vertexBuffer: NriBufferHandle | null = null;
        private indexBuffer: NriBufferHandle | null = null;
        private uniformBuffer: NriBufferHandle | null = null;
        private sampler: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        // The transcoded texture and its view.
        private texture: NriTextureHandle | null = null;
        private textureView: NriDescriptorHandle | null = null;

        // The device's targets (indices into TARGET_*), and the sample's choices.
        targets: int[] = [];
        selectedInputTexture: int = 0;
        selectedTranscodeTargetFormat: int = 0;
        // Set by the UI's Transcode button (and at first): transcode before the next draw.
        private transcodePending: boolean = true;
        private lastTranscodeTime: number = 0.0;
        private targetNames: string = "";
        private stats: f32[] = [0.0, 0.0];

        // The sample's view.
        private view: SampleView = new SampleView(ZOOM, ROTATION);
        // The mouse, as ApiVulkanSample sees it: its position (summed from its moves) and buttons.
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;
        private buttons: boolean[] = [false, false, false];
        // The options: -image <n>, -target <n>; -noUI: no overlay.
        requestedImage: int = 0;
        requestedTarget: int = 0;
        noUI: boolean = false;

        // Upload buffer.
        private ubo: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
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
            if (result == 0 && this.test) {
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

            // The device's transcode targets, as the Donut example asks NVRHI: sampled textures.
            for (let i = 0; i < TARGET_TEXTURE_FORMATS.length; i++) {
                const targetFormat = TARGET_TEXTURE_FORMATS[i];
                const support = targetFormat == NriFormat.Unknown ? 0 : Nri_GetFormatSupport(device, targetFormat);
                if ((support & SUPPORT_TEXTURE) != 0) {
                    this.targets.push(i);
                }
            }
            if (this.targets.length == 0) {
                console.log("The device samples none of the transcode targets");
                return 0;
            }
            this.targetNames = comboItems(this.targets.map((target): string => TARGET_NAMES[target]));
            this.selectedInputTexture = this.requestedImage;
            this.selectedTranscodeTargetFormat = Math.min(this.requestedTarget, this.targets.length - 1);

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
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

            // The depth buffer: D32, cleared to 0 (the sample's reversed depth).
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return 0;
            }
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            // The layout: the UBO (b0, both stages), the texture (t0) and the sampler (s0).
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const layout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The sample's pipeline: texture_compression_basisu.hlsl's shaders, as compiled for the
            // Donut example; no culling, depth tested (greater) and written.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/texture_compression_basisu/${folder}/texture_compression_basisu`;
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_texture_vs.bin`, "texture_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_texture_ps.bin`, "texture_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "TEXCOORD", NriFormat.RG32_SFLOAT, 12);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.None);
            Nri_PipelineDescSetColor(desc, viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            if (loaded) {
                this.pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            if (!this.pipeline) {
                console.log("Cannot load the texture compression basisu shaders");
                return 0;
            }

            // The quad.
            const vertices = QUAD_VERTICES.map((v): f32 => v);
            const indices = QUAD_INDICES.map((v): int => v);
            this.vertexBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            this.indexBuffer = Nri_CreateUploadedBufferFromInts(device, this.queue, Ref(indices[0]), indices.length * 4, NriBufferUsage.IndexBuffer);

            // The sample's sampler: trilinear, clamped, all the levels, the device's widest
            // anisotropic filtering.
            this.sampler = Nri_CreateSamplerWithLodRange(device, NriFilter.Linear, NriFilter.Linear, NriAddressMode.ClampToEdge,
                Nri_GetMaxSamplerAnisotropy(device), 0.0, 1000.0);

            // A queued frame's UBO copy each, in its own descriptor set (the texture's view set when
            // it's transcoded).
            const uniformBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * UBO_STRIDE, NriBufferUsage.ConstantBuffer);
            this.uniformBuffer = uniformBuffer;
            const descriptorPool = Nri_CreateDescriptorPool(device, queuedFrameNum, queuedFrameNum, queuedFrameNum, queuedFrameNum, 0, 0);
            this.descriptorPool = descriptorPool;
            const sampler = this.sampler;
            if (!uniformBuffer || !descriptorPool || !sampler) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const descriptorSet = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
                const uboView = Nri_CreateConstantBufferView(uniformBuffer, i * UBO_STRIDE, UBO_STRIDE);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), descriptorSet, uboView));
                if (!descriptorSet || !uboView) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(descriptorSet, 0, 0, uboView);
                Nri_UpdateDescriptor(descriptorSet, 2, 0, sampler);
            }

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

        // The sample's transcode_texture: the KTX 2 file transcoded into the target format, timed,
        // every level uploaded (on the queue, the GPU idle first: the previous texture goes, and the
        // sets take the new one). False if the file can't be read or transcoded.
        transcodeTexture() {
            const device = this.device;
            if (!device) {
                return false;
            }
            const target = this.targets[this.selectedTranscodeTargetFormat];
            const name = TEXTURE_FILE_NAMES[this.selectedInputTexture];
            const file = Nri_LoadFile(TEXTURE_DIR + name);
            if (!file) {
                return false;
            }
            const transcoded = TranscodedTexture.transcodeKtx2(Nri_GetFileData(file), Nri_GetFileSize(file), TARGET_TRANSCODE_FORMATS[target],
                Ref(this.stats[0]));
            Nri_DestroyFile(file);
            if (transcoded.isNull()) {
                return false;
            }
            const image = transcoded;
            this.lastTranscodeTime = this.stats[0];

            const levelNum = image.getLevelCount();
            const levels = Nri_CreateTextureLevels(image.getWidth(), image.getHeight(), levelNum, TARGET_TEXTURE_FORMATS[target]);
            for (let level = 0; level < levelNum; level++) {
                Nri_SetTextureLevel(levels, level, image.getLevelData(level), image.getLevelRowPitch(level));
            }
            image.destroy();

            Nri_DeviceWaitIdle(device);
            this.destroyTexture();
            const texture = Nri_CreateTextureFromLevels(device, this.queue, levels);
            Nri_DestroyTextureLevels(levels);
            if (!texture) {
                return false;
            }
            this.texture = texture;
            const textureView = Nri_CreateTextureView(texture, TARGET_TEXTURE_FORMATS[target]);
            this.textureView = textureView;
            for (const queuedFrame of this.queuedFrames) {
                const descriptorSet = queuedFrame.descriptorSet;
                if (descriptorSet) {
                    Nri_UpdateDescriptor(descriptorSet, 1, 0, textureView);
                }
            }
            return true;
        }

        destroyTexture() {
            const textureView = this.textureView;
            if (textureView) {
                Nri_DestroyDescriptor(textureView);
            }
            const texture = this.texture;
            if (texture) {
                Nri_DestroyTexture(texture);
            }
            this.textureView = null;
            this.texture = null;
        }

        // ApiVulkanSample's mouse handling, unless the overlay has the mouse: the buttons' changes,
        // then the move.
        handleMouse() {
            const overlay = this.imgui && Nri_ImguiWantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = Nri_IsButtonPressed(this.sample, button) != 0;
                if (pressed != this.buttons[button]) {
                    if (!pressed || !overlay) {
                        this.view.mouseButton(<MouseButton>button, <Action>(pressed ? 1 : 0));
                    }
                    this.buttons[button] = pressed;
                }
            }
            this.mouseX += Nri_GetMouseDeltaX(this.sample);
            this.mouseY += Nri_GetMouseDeltaY(this.sample);
            this.view.mouseMove(this.mouseX, this.mouseY);
        }

        // The sample's overlay.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Basis Universal texture loading", 1);
            if (Nri_ImguiCollapsingHeader("Input", 1) != 0) {
                Nri_ImguiText("Input image:");
                Nri_ImguiPushItemWidth(180.0);
                this.selectedInputTexture = Nri_ImguiCombo("##img", this.selectedInputTexture, comboItems(TEXTURE_FILE_NAMES));
                Nri_ImguiPopItemWidth();
                Nri_ImguiText("Transcode target:");
                Nri_ImguiPushItemWidth(180.0);
                this.selectedTranscodeTargetFormat = Nri_ImguiCombo("##tt", this.selectedTranscodeTargetFormat, this.targetNames);
                Nri_ImguiPopItemWidth();
                if (Nri_ImguiButton("Transcode") != 0) {
                    this.transcodePending = true;
                }
                Nri_ImguiText(`Transcoded in ${formatFixed(this.lastTranscodeTime, 2)} ms`);
            }
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The sample's update_uniform_buffers: its projection (clip y negated for Donut's shaders),
        // the quad's model view; into the queued frame's copy.
        writeUniforms(queuedFrameIndex: int) {
            const uniformBuffer = this.uniformBuffer;
            if (!uniformBuffer) {
                return;
            }
            const projection = perspective(radians(FOV), this.width / this.height, Z_NEAR, Z_FAR);
            const model = this.view.model();
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.ubo[UBO_MODEL + i] = model[i];
            }
            Nri_WriteBuffer(uniformBuffer, queuedFrameIndex * UBO_STRIDE, Ref(this.ubo[0]), UBO_FLOATS * 4);
        }

        // The quad (between Nri_CmdBeginRenderingWithDepth and Nri_CmdEndRendering), once there's a
        // texture.
        recordDraw(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const pipeline = this.pipeline;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = queuedFrame.descriptorSet;
            const vertexBuffer = this.vertexBuffer;
            const indexBuffer = this.indexBuffer;
            if (!this.texture || !layout || !pipeline || !descriptorPool || !descriptorSet || !vertexBuffer || !indexBuffer) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, layout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, descriptorSet);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, vertexBuffer, 0, VERTEX_SIZE);
            Nri_CmdSetIndexBuffer(commandBuffer, indexBuffer, 0, NriIndexType.UInt32);
            Nri_CmdDrawIndexed(commandBuffer, QUAD_INDICES.length, 1, 0, 0, 0);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();
            if (this.transcodePending) {
                this.transcodePending = false;
                if (!this.transcodeTexture()) {
                    console.log(`Cannot transcode ${TEXTURE_FILE_NAMES[this.selectedInputTexture]}: set VULKAN_SAMPLES_ASSETS_DIR when configuring`);
                }
            }
            this.writeUniforms(queuedFrameIndex);

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the scene (color cleared to dark gray, depth to 0), then the overlay over it.
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                    Nri_CmdClearColor(commandBuffer, CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
                    Nri_CmdClearDepth(commandBuffer, 0.0);
                    this.recordDraw(commandBuffer, queuedFrame);
                    Nri_CmdEndRendering(commandBuffer);
                }
                // (A pass of its own: the UI's pipeline has no depth attachment.)
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                    Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                    Nri_CmdDrawImgui(this.sample, commandBuffer, this.viewFormat);
                    Nri_CmdEndRendering(commandBuffer);
                }

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
                    this.destroyDescriptor(queuedFrame.uboView);
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
                this.destroyTexture();
                this.destroyDescriptor(this.sampler);
                this.destroyDescriptor(this.depthAttachment);
                const depthTexture = this.depthTexture;
                if (depthTexture) {
                    Nri_DestroyTexture(depthTexture);
                }
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.uniformBuffer);
                this.destroyBuffer(this.readbackBuffer);
                const pipeline = this.pipeline;
                if (pipeline) {
                    Nri_DestroyPipeline(pipeline);
                }
                const layout = this.layout;
                if (layout) {
                    Nri_DestroyPipelineLayout(layout);
                }
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }

        destroyDescriptor(descriptor: NriDescriptorHandle | null) {
            if (descriptor) {
                Nri_DestroyDescriptor(descriptor);
            }
        }

        destroyBuffer(buffer: NriBufferHandle | null) {
            if (buffer) {
                Nri_DestroyBuffer(buffer);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const basisu = new TextureCompressionBasisu(sample);
        // -image <n>: the input image (0-7, the sample's list), -target <n>: the transcode target (an
        // index into the device's list), both transcoded at start; -noUI: no overlay.
        Nri_AddExampleOptionWithValues(sample, "-image", 1);
        Nri_AddExampleOptionWithValues(sample, "-target", 1);
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-image" && i + 1 < argc) {
                i++;
                basisu.requestedImage = Math.min(Math.max(parseInt(Nri_GetArg(argc, argv, i)), 0), TEXTURE_FILE_NAMES.length - 1);
            } else if (arg == "-target" && i + 1 < argc) {
                i++;
                basisu.requestedTarget = Math.max(parseInt(Nri_GetArg(argc, argv, i)), 0);
            } else if (arg == "-noUI") {
                basisu.noUI = true;
            }
        }
        return basisu.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return TextureCompressionBasisuNri.main(argc, argv);
}

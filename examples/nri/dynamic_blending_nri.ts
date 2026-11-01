/// <reference path="../../core/nri/nri_interop.d.ts" />
import { multiply, inverseRigid, radians, perspective } from "../../core/matrix";
import { comboItems } from "../../core/text_format";
import { LookAtCamera } from "../../core/vulkan_samples_camera";

namespace DynamicBlendingNri {
    // dynamic_blending, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (dynamic_blending.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws, with NRIFramework's ImGui for the
    // sample's options. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Dynamic Blending";

    // The sample's two faces: float3 position, float2 texture coordinates per vertex.
    const VERTEX_FLOATS = 5;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const VERTICES = [
        -1.0, -1.0, 1.0, 0.0, 0.0,
        1.0, -1.0, 1.0, 1.0, 0.0,
        1.0, 1.0, 1.0, 1.0, 1.0,
        -1.0, 1.0, 1.0, 0.0, 1.0,

        -1.0, -1.0, -1.0, 0.0, 0.0,
        1.0, -1.0, -1.0, 1.0, 0.0,
        1.0, 1.0, -1.0, 1.0, 1.0,
        -1.0, 1.0, -1.0, 0.0, 1.0,
    ];
    // The face at z = -1 (6 indices from 0), then the one at z = 1 (6 from 6).
    const INDICES = [6, 5, 4, 4, 7, 6, 0, 1, 2, 2, 3, 0];
    const FACE_INDEX_COUNT = 6;

    // The sample's camera: a look-at camera at (0, 0, -5) turned by (-15, 15, 0) degrees, a 45
    // degree vertical field of view, depth reversed (near 256, far 0.1, as the sample passes them).
    const CAMERA_POSITION = [0.0, 0.0, -5.0];
    const CAMERA_ROTATION = [-15.0, 15.0, 0.0];
    const CAMERA_FOV = 45.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // Vulkan's blend operations (VK_BLEND_OP_ADD ... MAX) and blend factors (VK_BLEND_FACTOR_ZERO
    // ... SRC_ALPHA_SATURATE), as the sample names them; NRI's are in the same order. The factors
    // as the Donut example maps them, so the frames match: NVRHI has no constant alpha factors, and
    // uses the constant color's for them (the blend constants are zeros either way: the sample's);
    // a color factor's alpha is its alpha factor's (D3D takes only those for the alpha).
    const BLEND_OP_NAMES = ["ADD", "SUBTRACT", "REVERSE_SUBTRACT", "MIN", "MAX"];
    const BLEND_FACTOR_NAMES = ["ZERO", "ONE", "SRC_COLOR", "ONE_MINUS_SRC_COLOR", "DST_COLOR", "ONE_MINUS_DST_COLOR",
        "SRC_ALPHA", "ONE_MINUS_SRC_ALPHA", "DST_ALPHA", "ONE_MINUS_DST_ALPHA", "CONSTANT_COLOR",
        "ONE_MINUS_CONSTANT_COLOR", "CONSTANT_ALPHA", "ONE_MINUS_CONSTANT_ALPHA", "SRC_ALPHA_SATURATE"];
    const BLEND_FACTORS = [NriBlendFactor.Zero, NriBlendFactor.One, NriBlendFactor.SrcColor, NriBlendFactor.OneMinusSrcColor,
        NriBlendFactor.DstColor, NriBlendFactor.OneMinusDstColor, NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha,
        NriBlendFactor.DstAlpha, NriBlendFactor.OneMinusDstAlpha, NriBlendFactor.ConstantColor, NriBlendFactor.OneMinusConstantColor,
        NriBlendFactor.ConstantColor, NriBlendFactor.OneMinusConstantColor, NriBlendFactor.SrcAlphaSaturate];
    const ALPHA_BLEND_FACTORS = [NriBlendFactor.Zero, NriBlendFactor.One, NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha,
        NriBlendFactor.DstAlpha, NriBlendFactor.OneMinusDstAlpha, NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha,
        NriBlendFactor.DstAlpha, NriBlendFactor.OneMinusDstAlpha, NriBlendFactor.ConstantColor, NriBlendFactor.OneMinusConstantColor,
        NriBlendFactor.ConstantColor, NriBlendFactor.OneMinusConstantColor, NriBlendFactor.SrcAlphaSaturate];
    const BLEND_OPS = [NriBlendOp.Add, NriBlendOp.Subtract, NriBlendOp.ReverseSubtract, NriBlendOp.Min, NriBlendOp.Max];
    const VK_BLEND_FACTOR_ZERO = 0;
    const VK_BLEND_FACTOR_ONE = 1;
    const VK_BLEND_FACTOR_SRC_ALPHA = 6;
    const VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA = 7;

    // CameraUbo (a float4x4) and ColorUbo (8 float4 colors), each in a constant buffer view of 256
    // bytes (D3D12's alignment); a queued frame's pair each, FRAME_CONSTANTS_STRIDE bytes apart.
    const COLOR_FLOATS = 32;
    const CONSTANT_VIEW_SIZE = 256;
    const FRAME_CONSTANTS_STRIDE = 512;

    // The pipelines kept: past this many, they're all dropped (as the Donut example does).
    const MAX_PIPELINES = 32;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into, and its descriptor set (its copy of the constants).
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public descriptorSet: NriDescriptorSetHandle | null, public cameraView: NriDescriptorHandle | null,
            public colorView: NriDescriptorHandle | null) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // A pipeline made for a blend state (DynamicBlending.pipelineKey).
    class KeyedPipeline {
        constructor(public key: string, public pipeline: NriPipelineHandle) {
        }
    }

    // An NriColorWrite mask from the sample's red, green, blue, alpha switches.
    function colorMask(enabled: boolean[]) {
        let mask = 0;
        if (enabled[0]) {
            mask |= NriColorWrite.R;
        }
        if (enabled[1]) {
            mask |= NriColorWrite.G;
        }
        if (enabled[2]) {
            mask |= NriColorWrite.B;
        }
        if (enabled[3]) {
            mask |= NriColorWrite.A;
        }
        return mask;
    }

    // One face's settings: its corner colors (top left, top right, bottom left, bottom right; 4
    // floats each) and which channels it writes (red, green, blue, alpha).
    class FacePreferences {
        colors: f32[] = [];
        colorBitEnabled: boolean[] = [true, true, true, true];

        constructor(public indexOffset: int, colors: number[]) {
            for (let i = 0; i < 16; i++) {
                this.colors.push(colors[i]);
            }
        }
    }

    // -test: checks the last frame, read back, as the Donut example does. The corners are the gray
    // background; the two blended quads, right of the settings window, cover 12% to 35% of the
    // frame's right half and its middle.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const background = 0xBCBCBC;
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != background) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 188, 188, 188`;
            }
        }
        if ((pixels[Math.floor(height / 2) * width + Math.floor(width / 2)] & 0xFFFFFF) == background) {
            return "no quad in the middle";
        }
        const half: int = Math.floor(width / 2);
        let quads = 0;
        for (let y = 0; y < height; y++) {
            for (let x = half; x < width; x++) {
                if ((pixels[y * width + x] & 0xFFFFFF) != background) {
                    quads++;
                }
            }
        }
        const total = (width - half) * height;
        const percent = 100.0 * quads / total;
        console.log(`Quads, right half: ${percent}% (${quads} of ${total} pixels)`);
        if (percent < 12.0 || percent > 35.0) {
            return `Quads, right half: ${percent}% of the pixels, not 12% to 35%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' dynamic_blending (as examples/dynamic_blending.ts ports it) to NRI: two
    // overlapping faces, each with a color per corner, the far one drawn first, blended by the blend
    // state set in the UI: blending on or off, its equation (operations and factors of the color and
    // of the alpha), and each face's color write mask. The sample sets these as dynamic state
    // (VK_EXT_extended_dynamic_state3); here each combination in use is a pipeline of its own, made
    // when first drawn. NRI has no advanced blend operations (VK_EXT_blend_operation_advanced, which
    // the Donut example offers on Vulkan): the UI has the blend equation only. The left mouse button
    // turns the camera.
    class DynamicBlending {
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
        private shaders: string = "";
        private pipelines: KeyedPipeline[] = [];
        private vertexBuffer: NriBufferHandle | null = null;
        private indexBuffer: NriBufferHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        private camera: LookAtCamera = new LookAtCamera(CAMERA_POSITION, CAMERA_ROTATION);
        // The mouse, as the camera sees it: its position (summed from its moves) and buttons.
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;
        private buttons: boolean[] = [false, false, false];

        // The sample's settings, from its UI (-noblend: blending off); -noUI: no options window.
        clearColor: f32[] = [0.5, 0.5, 0.5, 1.0];
        faces: FacePreferences[] = [
            new FacePreferences(0, [
                1.0, 0.0, 0.0, 1.0,
                0.0, 1.0, 0.0, 1.0,
                0.0, 0.0, 1.0, 1.0,
                0.0, 0.0, 0.0, 1.0]),
            new FacePreferences(FACE_INDEX_COUNT, [
                0.0, 1.0, 1.0, 0.5,
                1.0, 0.0, 1.0, 0.5,
                1.0, 1.0, 0.0, 0.5,
                1.0, 1.0, 1.0, 0.5]),
        ];
        blendEnable: boolean = true;
        colorOperator: int = 0;
        alphaOperator: int = 0;
        srcColorBlendFactor: int = VK_BLEND_FACTOR_SRC_ALPHA;
        dstColorBlendFactor: int = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
        srcAlphaBlendFactor: int = VK_BLEND_FACTOR_ZERO;
        dstAlphaBlendFactor: int = VK_BLEND_FACTOR_ONE;
        noUI: boolean = false;

        // Upload buffers.
        private cameraConstants: f32[] = [];
        private colorConstants: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < 16; i++) {
                this.cameraConstants.push(0.0);
            }
            for (let i = 0; i < COLOR_FLOATS; i++) {
                this.colorConstants.push(0.0);
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

            // The layout: CameraUbo (b0, the vertex shader's) and ColorUbo (b1, the pixel shader's).
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 2, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            const layout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // dynamic_blending.hlsl's shaders, as compiled for the Donut example; the first pipeline
            // made now, to find them.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            this.shaders = `shaders/dynamic_blending/${folder}/dynamic_blending`;
            if (!this.facePipeline(this.faces[0])) {
                console.log("Cannot load the dynamic blending shaders");
                return 0;
            }

            // The faces.
            const vertices = VERTICES.map((v): f32 => v);
            const indices = INDICES.map((v): int => v);
            this.vertexBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            this.indexBuffer = Nri_CreateUploadedBufferFromInts(device, this.queue, Ref(indices[0]), indices.length * 4, NriBufferUsage.IndexBuffer);

            // A queued frame's constants each, in its own descriptor set.
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * FRAME_CONSTANTS_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = Nri_CreateDescriptorPool(device, queuedFrameNum, 0, 2 * queuedFrameNum, 0, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const descriptorSet = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
                const cameraView = Nri_CreateConstantBufferView(constantBuffer, i * FRAME_CONSTANTS_STRIDE, CONSTANT_VIEW_SIZE);
                const colorView = Nri_CreateConstantBufferView(constantBuffer, i * FRAME_CONSTANTS_STRIDE + CONSTANT_VIEW_SIZE, CONSTANT_VIEW_SIZE);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), descriptorSet,
                    cameraView, colorView));
                if (!descriptorSet || !cameraView || !colorView) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(descriptorSet, 0, 0, cameraView);
                Nri_UpdateDescriptor(descriptorSet, 0, 1, colorView);
            }

            // The sample's options.
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

        // What makes a face's pipeline differ: the blend state and the face's write mask.
        pipelineKey(face: FacePreferences) {
            const blend = this.blendEnable ? 1 : 0;
            return `${blend} ${this.colorOperator} ${this.srcColorBlendFactor} ${this.dstColorBlendFactor} `
                + `${this.alphaOperator} ${this.srcAlphaBlendFactor} ${this.dstAlphaBlendFactor} ${colorMask(face.colorBitEnabled)}`;
        }

        // The sample's pipeline with a face's dynamic state: depth test (greater: reversed) and
        // write, no culling, the blend state, the face's color write mask. Null if it can't be made.
        facePipeline(face: FacePreferences): NriPipelineHandle | null {
            const device = this.device;
            const layout = this.layout;
            if (!device || !layout) {
                return null;
            }
            const key = this.pipelineKey(face);
            for (const keyed of this.pipelines) {
                if (keyed.key == key) {
                    return keyed.pipeline;
                }
            }
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${this.shaders}_main_vs.bin`, "main_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${this.shaders}_main_ps.bin`, "main_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "TEXCOORD", NriFormat.RG32_SFLOAT, 12);
            Nri_PipelineDescSetFrontCounterClockwise(desc, 1);
            Nri_PipelineDescSetColor(desc, this.viewFormat, colorMask(face.colorBitEnabled));
            if (this.blendEnable) {
                Nri_PipelineDescSetBlend(desc,
                    BLEND_FACTORS[this.srcColorBlendFactor], BLEND_FACTORS[this.dstColorBlendFactor], BLEND_OPS[this.colorOperator],
                    ALPHA_BLEND_FACTORS[this.srcAlphaBlendFactor], ALPHA_BLEND_FACTORS[this.dstAlphaBlendFactor],
                    BLEND_OPS[this.alphaOperator]);
            }
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return this.keep(key, pipeline);
        }

        // Keeps the pipeline made for key (if made).
        keep(key: string, pipeline: NriPipelineHandle | null): NriPipelineHandle | null {
            if (!pipeline) {
                return null;
            }
            this.pipelines.push(new KeyedPipeline(key, pipeline));
            return pipeline;
        }

        // Keep a handful of pipelines: drop them all now and then (once the GPU is done with them).
        trimPipelines() {
            const device = this.device;
            if (!device || this.pipelines.length <= MAX_PIPELINES) {
                return;
            }
            Nri_DeviceWaitIdle(device);
            for (const keyed of this.pipelines) {
                Nri_DestroyPipeline(keyed.pipeline);
            }
            this.pipelines = [];
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The camera's mouse handling, unless the options window has the mouse: the buttons'
        // changes, then the move.
        handleMouse() {
            const overlay = this.imgui && Nri_ImguiWantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = Nri_IsButtonPressed(this.sample, button) != 0;
                if (pressed != this.buttons[button]) {
                    if (!pressed || !overlay) {
                        this.camera.mouseButton(<MouseButton>button, <Action>(pressed ? 1 : 0));
                    }
                    this.buttons[button] = pressed;
                }
            }
            this.mouseX += Nri_GetMouseDeltaX(this.sample);
            this.mouseY += Nri_GetMouseDeltaY(this.sample);
            this.camera.mouseMove(this.mouseX, this.mouseY);
        }

        // A color editor (as the sample's, 200 pixels wide).
        colorEdit(id: int, caption: string, colors: f32[], first: int) {
            Nri_ImguiPushID(id);
            Nri_ImguiColorEdit4(caption, Ref(colors[first]), 200.0);
            Nri_ImguiPopID();
        }

        // A "Next" button, then a combo of names; the new index.
        comboWithButton(id: int, caption: string, index: int, names: string[]) {
            let result = index;
            Nri_ImguiPushID(id);
            if (Nri_ImguiButton("Next") != 0) {
                result = (result + 1) % names.length;
            }
            Nri_ImguiPopID();
            Nri_ImguiSameLine();
            return Nri_ImguiCombo(caption, result, comboItems(names));
        }

        // The sample's random colors (alpha kept).
        randomize(colors: f32[]) {
            for (let corner = 0; corner < 4; corner++) {
                for (let i = 0; i < 3; i++) {
                    colors[corner * 4 + i] = Math.random();
                }
            }
        }

        // The sample's options.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            let id = 0;
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Options", 1);

            id++;
            this.colorEdit(id, "Background", this.clearColor, 0);

            // (The sample titles both headers "Second face", which ImGui then opens and closes
            // together.)
            for (let f = 0; f < 2; f++) {
                const face = this.faces[f];
                if (Nri_ImguiCollapsingHeader(f == 0 ? "First face" : "Second face", 1) != 0) {
                    const corners = ["Top left", "Top right", "Bottom left", "Bottom right"];
                    for (let c = 0; c < 4; c++) {
                        id++;
                        this.colorEdit(id, corners[c], face.colors, c * 4);
                    }
                    id++;
                    Nri_ImguiPushID(id);
                    if (Nri_ImguiButton("Random") != 0) {
                        this.randomize(face.colors);
                    }
                    Nri_ImguiPopID();

                    Nri_ImguiText("Color write mask");
                    const channels = ["Red", "Green", "Blue", "Alpha"];
                    for (let c = 0; c < 4; c++) {
                        id++;
                        Nri_ImguiPushID(id);
                        face.colorBitEnabled[c] = Nri_ImguiCheckbox(channels[c], face.colorBitEnabled[c] ? 1 : 0) != 0;
                        Nri_ImguiPopID();
                        if (c < 3) {
                            Nri_ImguiSameLine();
                        }
                    }
                } else {
                    id += 9;
                }
            }

            if (Nri_ImguiCollapsingHeader("Blending", 1) != 0) {
                this.blendEnable = Nri_ImguiCheckbox("Enabled", this.blendEnable ? 1 : 0) != 0;
                if (Nri_ImguiCollapsingHeader("BlendEquationEXT", 1) != 0) {
                    this.colorOperator = this.comboWithButton(++id, "Color operator", this.colorOperator, BLEND_OP_NAMES);
                    this.srcColorBlendFactor = this.comboWithButton(++id, "SrcColorBlendFactor", this.srcColorBlendFactor, BLEND_FACTOR_NAMES);
                    this.dstColorBlendFactor = this.comboWithButton(++id, "DstColorBlendFactor", this.dstColorBlendFactor, BLEND_FACTOR_NAMES);
                    this.alphaOperator = this.comboWithButton(++id, "Alpha operator", this.alphaOperator, BLEND_OP_NAMES);
                    this.srcAlphaBlendFactor = this.comboWithButton(++id, "SrcAlphaBlendFactor", this.srcAlphaBlendFactor, BLEND_FACTOR_NAMES);
                    this.dstAlphaBlendFactor = this.comboWithButton(++id, "DstAlphaBlendFactor", this.dstAlphaBlendFactor, BLEND_FACTOR_NAMES);
                }
            }
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The sample's update_uniform_buffers: projection * view * model (identity), into Donut's
        // clip space (y negated); and its update_color; into the queued frame's copies.
        writeConstants(queuedFrameIndex: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            const view = this.camera.view();
            const viewProj = multiply(perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR), view);
            for (let i = 0; i < 16; i++) {
                this.cameraConstants[i] = i % 4 == 1 ? -viewProj[i] : viewProj[i];
            }
            for (let face = 0; face < 2; face++) {
                for (let i = 0; i < 16; i++) {
                    this.colorConstants[face * 16 + i] = this.faces[face].colors[i];
                }
            }
            const offset = queuedFrameIndex * FRAME_CONSTANTS_STRIDE;
            Nri_WriteBuffer(constantBuffer, offset, Ref(this.cameraConstants[0]), 16 * 4);
            Nri_WriteBuffer(constantBuffer, offset + CONSTANT_VIEW_SIZE, Ref(this.colorConstants[0]), COLOR_FLOATS * 4);
        }

        // Which face is drawn first, as the sample decides it: the vertices 0 (on the z = 1 face) and
        // 4 (on the z = -1 one) through the inverse of the view, the one with the smaller z last.
        reversed() {
            const inverseView = inverseRigid(this.camera.view());
            const z0 = inverseView[2] * VERTICES[0] + inverseView[6] * VERTICES[1] + inverseView[10] * VERTICES[2] + inverseView[14];
            const z4 = inverseView[2] * VERTICES[20] + inverseView[6] * VERTICES[21] + inverseView[10] * VERTICES[22] + inverseView[14];
            return z0 < z4;
        }

        // The two faces (between Nri_CmdBeginRenderingWithDepth and Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = queuedFrame.descriptorSet;
            const vertexBuffer = this.vertexBuffer;
            const indexBuffer = this.indexBuffer;
            if (!layout || !descriptorPool || !descriptorSet || !vertexBuffer || !indexBuffer) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, layout);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, descriptorSet);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, vertexBuffer, 0, VERTEX_SIZE);
            Nri_CmdSetIndexBuffer(commandBuffer, indexBuffer, 0, NriIndexType.UInt32);
            // The sample's blend constants (zeros).
            Nri_CmdSetBlendConstants(commandBuffer, 0.0, 0.0, 0.0, 0.0);
            const reverse = this.reversed();
            for (let i = 0; i < 2; i++) {
                const face = this.faces[reverse ? 1 - i : i];
                const pipeline = this.facePipeline(face);
                if (pipeline) {
                    Nri_CmdSetPipeline(commandBuffer, pipeline);
                    Nri_CmdDrawIndexed(commandBuffer, FACE_INDEX_COUNT, 1, face.indexOffset, 0, 0);
                }
            }
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();
            this.trimPipelines();
            this.writeConstants(queuedFrameIndex);

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the background color, depth cleared to 0, the faces; then the options
                // window over them.
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                    Nri_CmdClearColor(commandBuffer, this.clearColor[0], this.clearColor[1], this.clearColor[2], this.clearColor[3]);
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
                    this.destroyDescriptor(queuedFrame.cameraView);
                    this.destroyDescriptor(queuedFrame.colorView);
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
                this.destroyDescriptor(this.depthAttachment);
                const depthTexture = this.depthTexture;
                if (depthTexture) {
                    Nri_DestroyTexture(depthTexture);
                }
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                for (const keyed of this.pipelines) {
                    Nri_DestroyPipeline(keyed.pipeline);
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
        const blending = new DynamicBlending(sample);
        // -noblend: blending off; -advanced <n>: the Donut example's advanced blend operation, which
        // NRI doesn't have (said so, then ignored); -noUI: no options window.
        Nri_AddExampleOption(sample, "-noblend");
        Nri_AddExampleOptionWithValues(sample, "-advanced", 1);
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-noblend") {
                blending.blendEnable = false;
            } else if (arg == "-advanced" && i + 1 < argc) {
                console.log("No advanced blend operations (NRI has no VK_EXT_blend_operation_advanced)");
                i++;
            } else if (arg == "-noUI") {
                blending.noUI = true;
            }
        }
        return blending.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return DynamicBlendingNri.main(argc, argv);
}

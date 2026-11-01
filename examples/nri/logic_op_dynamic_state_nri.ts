/// <reference path="../../core/nri/nri_interop.d.ts" />
import { multiply, rotation, translation, radians, samplePerspective } from "../../core/matrix";

namespace LogicOpDynamicStateNri {
    // logic_op_dynamic_state, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead
    // of Donut and NVRHI: the same shaders (logic_op_dynamic_state.hlsl's, and Donut's blit shaders),
    // model (read as Donut's loadGltfMesh reads it) and cube map, through the NRI calls
    // core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui for the sample's overlay. This
    // example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no logic operations.
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Logic Operations Dynamic State";

    // The sample's background model and HDR cube map (Vulkan-Samples' assets), the KTX cube map
    // converted to DDS at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const BACKGROUND_PATH = "media/logic_op_dynamic_state/cube.gltf";
    const ENVMAP_PATH = "media/logic_op_dynamic_state/uffizi_rgba16f_cube.dds";

    // Nri_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // struct UBOCOMM { float4x4 projection, view; } and struct UBOBAS, as f32 offsets; a queued
    // frame's each in a 256-byte slice of the constant buffer (D3D12 constant buffer views'
    // alignment).
    const CONST_PROJECTION = 0;
    const CONST_VIEW = 16;
    const CONST_FLOATS = 32;
    const BASELINE_FLOATS = 16;
    const CONST_STRIDE = 256;
    // The push constants: float4x4 model_matrix (identity: glm's, GLM_FORCE_CTOR_INIT); float4 color
    // (at b2: root constants).
    const PUSH_FLOATS = 20;
    const PUSH_REGISTER = 2;

    // Donut's blit (CommonRenderPasses::BlitTexture) of the color buffer into the swap chain
    // texture: struct BlitConstants { float2 sourceOrigin, sourceSize, targetOrigin, targetSize;
    // float sharpenFactor; }.
    const BLIT_CONSTANT_FLOATS = 9;

    // The logic operations, in Vulkan's VkLogicOp order (Nri_PipelineDescSetLogicOp's).
    const LOGIC_OP_NAMES = "CLEAR|AND|AND_REVERSE|COPY|AND_INVERTED|NO_OP|XOR|OR|NOR|EQUIVALENT|INVERT|OR_REVERSE|COPY_INVERTED|OR_INVERTED|NAND|SET";
    const LOGIC_OP_COUNT = 16;
    const LOGIC_OP_COPY = 3;

    // The sample's camera: a "look at" camera at (2, -4, -10), turned by (-15, 190, 0) degrees, 60
    // degrees vertically, reversed depth from 256 to 0.1 (glm::perspective with near and far swapped).
    const CAMERA_POSITION = [2.0, -4.0, -10.0];
    const CAMERA_ROTATION = [-15.0, 190.0, 0.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;
    // ApiVulkanSample's mouse controls: degrees per pixel dragged with the left button, zoom per
    // pixel with the right one, panning per pixel with the middle one.
    const ROTATION_SPEED = 1.0;
    const ZOOM_SPEED = 0.005;
    const PAN_SPEED = 0.01;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into: its command buffer, and its descriptor set (its slices of
    // the common and the lighting UBO, the cube map, the sampler) with the UBOs' views.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public descriptorSet: NriDescriptorSetHandle | null, public commonView: NriDescriptorHandle | null,
            public baselineView: NriDescriptorHandle | null) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    function normalize3(x: number, y: number, z: number) {
        const length = Math.sqrt(x * x + y * y + z * z);
        return [x / length, y / length, z / length];
    }

    // -test: checks the last frame, read back, as the Donut example does: the street around (75% to
    // 95% of the pixels not near black), and the dark teal cube in the middle (90% of its 20 x 20
    // pixels), drawn with the logic operation (copy by default).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        let dark = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            if ((p & 0xFF) <= 20 && ((p >> 8) & 0xFF) <= 20 && ((p >> 16) & 0xFF) <= 20) {
                dark++;
            }
        }
        const lit = 100.0 * (total - dark) / total;
        console.log(`Lit: ${lit}% (${total - dark} of ${total} pixels)`);
        if (lit < 75.0 || lit > 95.0) {
            return `Lit: ${lit}% of the pixels, not 75% to 95%`;
        }
        let cube = 0;
        for (let y = height / 2 - 10; y < height / 2 + 10; y++) {
            for (let x = width / 2 - 10; x < width / 2 + 10; x++) {
                const p = pixels[y * width + x];
                const r = p & 0xFF;
                const g = (p >> 8) & 0xFF;
                const b = (p >> 16) & 0xFF;
                if (r >= 5 && r <= 40 && g >= 10 && g <= 45 && b >= 10 && b <= 45) {
                    cube++;
                }
            }
        }
        const cubePercent = 100.0 * cube / (20 * 20);
        console.log(`Cube in the middle: ${cubePercent}% (${cube} of 400 pixels)`);
        if (cubePercent < 90.0) {
            return `Cube in the middle: ${cubePercent}% of the pixels, not 90% to 100%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' logic_op_dynamic_state (as examples/logic_op_dynamic_state.ts ports it)
    // to NRI: a lit cube in front of an HDR environment, the cube's pixels combined with what is
    // behind them by a logic operation on their bits (XOR, OR, INVERT...) instead of blending, picked
    // in the UI. The sample changes the operation as dynamic state of one pipeline; NRI has it in the
    // pipeline (as D3D), so here it is a pipeline per operation, created as the UI picks it. As in the
    // Donut example, one color texture takes the place of the sample's UNORM swapchain: the
    // background draws into it as RGBA8_UNORM, the cube too on Vulkan, as RGBA8_UINT on D3D (D3D12
    // has logic operations on UINT targets only: the cube's pixel shader, UINT_OUTPUT=1, converts its
    // color as UNORM would), and it's read as RGBA8_SRGB when blitted (Donut's blit shaders) into the
    // sRGB swap chain view, which stores the same bytes. (NRI's textures take views of other formats
    // of the same size: typeless on D3D, MUTABLE_FORMAT on Vulkan.)
    class LogicOpDynamicState {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private layout: NriPipelineLayoutHandle | null = null;
        private blitLayout: NriPipelineLayoutHandle | null = null;
        private backgroundPipeline: NriPipelineHandle | null = null;
        private blitPipeline: NriPipelineHandle | null = null;
        // A pipeline per logic operation, created when first drawn.
        private baselinePipelines: (NriPipelineHandle | null)[] = [];
        private shaders: string = "";
        private background: NriGltfMeshHandle | null = null;
        private envmap: NriTextureHandle | null = null;
        private envmapView: NriDescriptorHandle | null = null;
        private anisotropicWrap: NriDescriptorHandle | null = null;
        private linearClamp: NriDescriptorHandle | null = null;
        private cubePositions: NriBufferHandle | null = null;
        private cubeNormals: NriBufferHandle | null = null;
        private cubeIndices: NriBufferHandle | null = null;
        private cubeIndexCount: int = 0;
        // The color buffer, as UNORM, as the cube's logic operation takes it (UINT on D3D) and as
        // the blit reads it (sRGB); the depth buffer.
        private colorBuffer: NriTextureHandle | null = null;
        private colorAttachment: NriDescriptorHandle | null = null;
        private logicOpAttachment: NriDescriptorHandle | null = null;
        private colorView: NriDescriptorHandle | null = null;
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private blitSet: NriDescriptorSetHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // The sample's setting (-op <0..15>: a VkLogicOp value, COPY at start); -noUI: no overlay.
        selectedOperation: int = LOGIC_OP_COPY;
        noUI: boolean = false;
        // The cube's logic operation on a UINT view of the color buffer (D3D), not UNORM (Vulkan).
        private uintLogicOps: boolean = false;

        // The sample's camera: rotation (degrees about x, y, z) and position; the mouse as it last
        // saw it.
        private cameraRotation: number[] = [CAMERA_ROTATION[0], CAMERA_ROTATION[1], CAMERA_ROTATION[2]];
        private cameraPosition: number[] = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
        private buttons: boolean[] = [false, false, false];
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;

        // Upload buffers: the common UBO, the lighting UBO, the push constants; the blit's constants.
        private constants: f32[] = [];
        // struct UBOBAS: ambientLightColor, lightPosition, lightColor, lightIntensity.
        private baselineConstants: f32[] = [
            1.0, 1.0, 1.0, 0.1,
            -3.0, -8.0, 6.0, -1.0,
            1.0, 1.0, 1.0, 1.0,
            50.0, 0.0, 0.0, 0.0,
        ];
        // The model matrix (identity) and the cube's color.
        private pushConstants: f32[] = [
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0,
            0.75, 1.0, 1.0, 1.0,
        ];
        private blitConstants: f32[] = [0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
            for (let i = 0; i < LOGIC_OP_COUNT; i++) {
                this.baselinePipelines.push(null);
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
            this.uintLogicOps = graphicsAPI != NriGraphicsAPI.VK;

            // Swap chain: blitted into through sRGB views, as the Donut example's sRGB back buffer.
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

            if (Nri_IsFeatureSupported(device, NriFeature.LogicOp) == 0) {
                this.unsupportedReason = "This example needs logic operations in blend states (OutputMergerLogicOp, Vulkan's logicOp)";
                return 0;
            }

            // The background model and the cube map; the cube.
            this.background = Nri_LoadGltfMesh(device, this.queue, BACKGROUND_PATH);
            const envmap = Nri_LoadDdsTexture(device, this.queue, ENVMAP_PATH, 0);
            this.envmap = envmap;
            if (!this.background || !envmap) {
                console.log("Cannot load the model and the cube map: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const envmapView = Nri_CreateTextureCubeView(envmap, NriFormat.RGBA16_SFLOAT);
            this.envmapView = envmapView;
            if (!this.createCube(device)) {
                console.log("Cannot create the cube");
                return 0;
            }

            // Donut's common samplers: anisotropic and repeating for the cube map (the framework's:
            // trilinear, the device's maximum anisotropy), linear and clamped for the blit.
            const anisotropicWrap = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.Repeat,
                Math.min(16, Nri_GetMaxSamplerAnisotropy(device)));
            const linearClamp = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            this.anisotropicWrap = anisotropicWrap;
            this.linearClamp = linearClamp;

            // The color buffer (RGBA8, its views as above) and the depth buffer, the swap chain's size.
            const colorBuffer = Nri_CreateRenderTargetTexture(device, this.queue, this.width, this.height, NriFormat.RGBA8_UNORM);
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.colorBuffer = colorBuffer;
            this.depthTexture = depthTexture;
            if (!colorBuffer || !depthTexture || !anisotropicWrap || !linearClamp) {
                console.log("Cannot create the color and depth buffers");
                return 0;
            }
            this.colorAttachment = Nri_CreateColorAttachmentView(colorBuffer, NriFormat.RGBA8_UNORM);
            this.logicOpAttachment = Nri_CreateColorAttachmentView(colorBuffer,
                this.uintLogicOps ? NriFormat.RGBA8_UINT : NriFormat.RGBA8_UNORM);
            const colorView = Nri_CreateTextureView(colorBuffer, NriFormat.RGBA8_SRGB);
            this.colorView = colorView;
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            // The layouts: the sample's descriptor set, as one for both pipelines (the common UBO at
            // b0, the lighting UBO at b1, the cube map at t0 and its sampler at s0) and the cube's push
            // constants (b2: root constants); the blit's constants (b0) and its source (t0, s0).
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 2, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRootConstants(layoutDesc, PUSH_REGISTER, PUSH_FLOATS * 4, NriStage.VertexPixel);
            const layout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            this.layout = layout;
            const blitLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(blitLayoutDesc, 0, BLIT_CONSTANT_FLOATS * 4, NriStage.Vertex);
            Nri_PipelineLayoutDescAddRange(blitLayoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(blitLayoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const blitLayout = Nri_CreatePipelineLayoutFromDesc(device, blitLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(blitLayoutDesc);
            this.blitLayout = blitLayout;
            if (!layout || !blitLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: logic_op_dynamic_state.hlsl's shaders, as compiled for the Donut example
            // (the cube's, created as drawn); Donut's blit shaders (rect_vs, blit_ps).
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            this.shaders = `shaders/logic_op_dynamic_state/${folder}/logic_op_dynamic_state`;
            this.backgroundPipeline = this.createBackgroundPipeline(device, layout);
            this.blitPipeline = this.createBlitPipeline(device, blitLayout, `shaders/framework/${folder}`);
            if (!this.backgroundPipeline || !this.blitPipeline || !this.getBaselinePipeline(this.selectedOperation)) {
                console.log("Cannot load the logic operations shaders");
                return 0;
            }

            // The UBOs (a queued frame's each), the descriptor sets (a queued frame's, and the
            // blit's).
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * 2 * CONST_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = Nri_CreateDescriptorPool(device, queuedFrameNum + 1, queuedFrameNum + 1, 2 * queuedFrameNum,
                queuedFrameNum + 1, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool || !colorView) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const commonView = Nri_CreateConstantBufferView(constantBuffer, 2 * i * CONST_STRIDE, CONST_STRIDE);
                const baselineView = Nri_CreateConstantBufferView(constantBuffer, (2 * i + 1) * CONST_STRIDE, CONST_STRIDE);
                const descriptorSet = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), descriptorSet,
                    commonView, baselineView));
                if (!commonView || !baselineView || !descriptorSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(descriptorSet, 0, 0, commonView);
                Nri_UpdateDescriptor(descriptorSet, 0, 1, baselineView);
                Nri_UpdateDescriptor(descriptorSet, 1, 0, envmapView);
                Nri_UpdateDescriptor(descriptorSet, 2, 0, anisotropicWrap);
            }
            const blitSet = Nri_AllocateDescriptorSet(descriptorPool, blitLayout, 0, 0);
            this.blitSet = blitSet;
            if (!blitSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            Nri_UpdateDescriptor(blitSet, 0, 0, colorView);
            Nri_UpdateDescriptor(blitSet, 1, 0, linearClamp);

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

        // The sample's model_data_creation, as the Donut example builds it: a cube of 8 vertices,
        // each with the normalized sum of its three faces' normals, scaled by 8 and moved by
        // (0, 1, 5). The sample draws it as 6 triangle strips of 4 indices separated by primitive
        // restarts; here (as in the Donut example) they are unrolled into a triangle list: a strip's
        // odd triangles with their first two vertices swapped, which keeps their winding. False if
        // its buffers can't be created.
        createCube(device: NriDeviceHandle): boolean {
            const corners = [
                0.0, 0.0, 0.0,
                1.0, 0.0, 0.0,
                1.0, 1.0, 0.0,
                0.0, 1.0, 0.0,
                0.0, 0.0, 1.0,
                1.0, 0.0, 1.0,
                1.0, 1.0, 1.0,
                0.0, 1.0, 1.0,
            ];
            const positions: f32[] = [];
            const normals: f32[] = [];
            for (let i = 0; i < 8; i++) {
                const x = corners[i * 3];
                const y = corners[i * 3 + 1];
                const z = corners[i * 3 + 2];
                positions.push(x * 8.0 + 0.0);
                positions.push(y * 8.0 + 1.0);
                positions.push(z * 8.0 + 5.0);
                // Each corner's faces: +1 or -1 along each axis.
                const n = normalize3(x * 2.0 - 1.0, y * 2.0 - 1.0, z * 2.0 - 1.0);
                normals.push(n[0]);
                normals.push(n[1]);
                normals.push(n[2]);
            }

            const strips = [
                0, 4, 3, 7,
                1, 0, 2, 3,
                2, 6, 1, 5,
                1, 5, 0, 4,
                4, 5, 7, 6,
                2, 3, 6, 7,
            ];
            const indices: int[] = [];
            for (let strip = 0; strip < 6; strip++) {
                for (let t = 0; t < 2; t++) {
                    const v = strip * 4 + t;
                    const first = strips[t % 2 == 0 ? v : v + 1];
                    const second = strips[t % 2 == 0 ? v + 1 : v];
                    const third = strips[v + 2];
                    indices.push(first);
                    indices.push(second);
                    indices.push(third);
                }
            }
            this.cubeIndexCount = indices.length;

            this.cubePositions = Nri_CreateUploadedBuffer(device, this.queue, Ref(positions[0]), positions.length * 4,
                NriBufferUsage.VertexBuffer);
            this.cubeNormals = Nri_CreateUploadedBuffer(device, this.queue, Ref(normals[0]), normals.length * 4,
                NriBufferUsage.VertexBuffer);
            this.cubeIndices = Nri_CreateUploadedBufferFromInts(device, this.queue, Ref(indices[0]), indices.length * 4,
                NriBufferUsage.IndexBuffer);
            if (!this.cubePositions || !this.cubeNormals) {
                return false;
            }
            return this.cubeIndices ? true : false;
        }

        // The background: the glTF loader's positions, reversed depth (greater passes), back faces
        // culled, counter-clockwise front faces. (The sample blends it, alpha over; its alpha is 1,
        // so that's a copy.)
        createBackgroundPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${this.shaders}_background_vs.bin`, "background_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${this.shaders}_background_ps.bin`, "background_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            Nri_PipelineDescSetFrontCounterClockwise(desc, 1);
            Nri_PipelineDescSetColor(desc, NriFormat.RGBA8_UNORM, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // The cube's pipeline for a logic operation, for its view of the color buffer (UINT on D3D):
        // positions and normals in streams of their own, reversed depth, back faces culled (clockwise
        // front faces), the logic operation instead of blending. Created on first use; null on
        // failure.
        getBaselinePipeline(logicOp: int): NriPipelineHandle | null {
            const existing = this.baselinePipelines[logicOp];
            if (existing) {
                return existing;
            }
            const device = this.device;
            const layout = this.layout;
            if (!device || !layout) {
                return null;
            }
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${this.shaders}_baseline_vs.bin`, "baseline_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShaderPermutation(desc, NriShaderStage.Pixel, `${this.shaders}_baseline_ps.bin`, "baseline_ps",
                    this.uintLogicOps ? "UINT_OUTPUT=1" : "UINT_OUTPUT=0") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttributeFromStream(desc, "NORMAL", NriFormat.RGB32_SFLOAT, 0, 1);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            Nri_PipelineDescSetColor(desc, this.uintLogicOps ? NriFormat.RGBA8_UINT : NriFormat.RGBA8_UNORM, NriColorWrite.RGBA);
            // (After the color: NO_OP turns its writes off.)
            Nri_PipelineDescSetLogicOp(desc, logicOp);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            this.baselinePipelines[logicOp] = pipeline;
            return pipeline;
        }

        // Donut's blit pipeline: rect_vs's quad (a triangle strip), blit_ps without texture arrays,
        // no culling, no depth.
        createBlitPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, framework: string) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${framework}/rect_vs.bin`, "main") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShaderPermutation(desc, NriShaderStage.Pixel, `${framework}/blit_ps.bin`, "main",
                    "TEXTURE_ARRAY=0") != 0;
            }
            Nri_PipelineDescSetTopology(desc, NriTopology.TriangleStrip);
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // Waits for the frame that last used this frame's command allocator (and its UBOs).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // ApiVulkanSample's mouse handling, unless the overlay has the mouse: dragging with the left
        // button rotates the camera, with the right one zooms, with the middle one pans.
        handleMouse() {
            const overlay = this.imgui && Nri_ImguiWantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = Nri_IsButtonPressed(this.sample, button) != 0;
                if (!pressed || !overlay) {
                    this.buttons[button] = pressed;
                }
            }
            const x = Nri_GetMouseX(this.sample);
            const y = Nri_GetMouseY(this.sample);
            const dx = this.mouseX - x;
            const dy = this.mouseY - y;
            if (this.buttons[0]) {
                this.cameraRotation[0] += dy * ROTATION_SPEED;
                this.cameraRotation[1] -= dx * ROTATION_SPEED;
            }
            if (this.buttons[1]) {
                this.cameraPosition[2] += dy * ZOOM_SPEED;
            }
            if (this.buttons[2]) {
                this.cameraPosition[0] -= dx * PAN_SPEED;
                this.cameraPosition[1] -= dy * PAN_SPEED;
            }
            this.mouseX = x;
            this.mouseY = y;
        }

        // The sample's overlay (its title, ApiVulkanSample's default).
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Vulkan Example", 1);
            if (Nri_ImguiCollapsingHeader("Settings", 1) != 0) {
                this.selectedOperation = Nri_ImguiCombo("Logic operation", this.selectedOperation, LOGIC_OP_NAMES);
            }
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The sample's update_uniform_buffers: its camera's matrices; the lighting UBO; into this
        // frame's slices.
        writeConstants(constantBuffer: NriBufferHandle, queuedFrameIndex: int) {
            const c = this.constants;
            const projection = samplePerspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            // A "look at" camera: translation * rotation (about x, then y, then z).
            const r = this.cameraRotation;
            let rotationMatrix = multiply(rotation(radians(r[0]), 1.0, 0.0, 0.0), rotation(radians(r[1]), 0.0, 1.0, 0.0));
            rotationMatrix = multiply(rotationMatrix, rotation(radians(r[2]), 0.0, 0.0, 1.0));
            const p = this.cameraPosition;
            const view = multiply(translation(p[0], p[1], p[2]), rotationMatrix);
            for (let i = 0; i < 16; i++) {
                c[CONST_PROJECTION + i] = projection[i];
                c[CONST_VIEW + i] = view[i];
            }
            Nri_WriteBuffer(constantBuffer, 2 * queuedFrameIndex * CONST_STRIDE, Ref(c[0]), CONST_FLOATS * 4);
            Nri_WriteBuffer(constantBuffer, (2 * queuedFrameIndex + 1) * CONST_STRIDE, Ref(this.baselineConstants[0]),
                BASELINE_FLOATS * 4);
        }

        // The background (between Nri_CmdBeginRenderingWithDepth and Nri_CmdEndRendering, into the
        // UNORM view).
        recordBackground(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = queuedFrame.descriptorSet;
            const pipeline = this.backgroundPipeline;
            const background = this.background;
            if (!layout || !descriptorPool || !descriptorSet || !pipeline || !background) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, layout);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, descriptorSet);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, Nri_GetGltfMeshVertexBuffer(background), 0, VERTEX_SIZE);
            Nri_CmdSetIndexBuffer(commandBuffer, Nri_GetGltfMeshIndexBuffer(background), 0, NriIndexType.UInt32);
            Nri_CmdDrawIndexed(commandBuffer, Nri_GetGltfMeshIndexCount(background), 1, 0, 0, 0);
        }

        // The cube, with the logic operation chosen in the overlay (between
        // Nri_CmdBeginRenderingWithDepth and Nri_CmdEndRendering, into the logic operation's view).
        recordCube(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = queuedFrame.descriptorSet;
            const pipeline = this.getBaselinePipeline(this.selectedOperation);
            const cubePositions = this.cubePositions;
            const cubeNormals = this.cubeNormals;
            const cubeIndices = this.cubeIndices;
            if (!layout || !descriptorPool || !descriptorSet || !pipeline || !cubePositions || !cubeNormals || !cubeIndices) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, layout);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, descriptorSet);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.pushConstants[0]), PUSH_FLOATS * 4);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, cubePositions, 0, 12);
            Nri_CmdSetVertexBuffer(commandBuffer, 1, cubeNormals, 0, 12);
            Nri_CmdSetIndexBuffer(commandBuffer, cubeIndices, 0, NriIndexType.UInt32);
            Nri_CmdDrawIndexed(commandBuffer, this.cubeIndexCount, 1, 0, 0, 0);
        }

        // The color buffer over the whole swap chain texture (between Nri_CmdBeginRendering and
        // Nri_CmdEndRendering), as Donut's BlitTexture draws it.
        recordBlit(commandBuffer: NriCommandBufferHandle) {
            const blitLayout = this.blitLayout;
            const blitPipeline = this.blitPipeline;
            const descriptorPool = this.descriptorPool;
            const blitSet = this.blitSet;
            if (!blitLayout || !blitPipeline || !descriptorPool || !blitSet) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, blitLayout);
            Nri_CmdSetPipeline(commandBuffer, blitPipeline);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.blitConstants[0]), BLIT_CONSTANT_FLOATS * 4);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, blitSet);
            Nri_CmdDraw(commandBuffer, 4, 1, 0, 0);
        }

        // The scene into the color buffer: cleared to transparent black, depth to 0 (reversed); the
        // background through the UNORM view, the cube through the logic operation's.
        recordScene(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const colorAttachment = this.colorAttachment;
            const logicOpAttachment = this.logicOpAttachment;
            const depthAttachment = this.depthAttachment;
            if (!colorAttachment || !logicOpAttachment || !depthAttachment) {
                return;
            }
            Nri_CmdBeginRenderingWithDepth(commandBuffer, colorAttachment, depthAttachment);
            Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
            Nri_CmdClearDepth(commandBuffer, 0.0);
            this.recordBackground(commandBuffer, queuedFrame);
            Nri_CmdEndRendering(commandBuffer);
            Nri_CmdBeginRenderingWithDepth(commandBuffer, logicOpAttachment, depthAttachment);
            this.recordCube(commandBuffer, queuedFrame);
            Nri_CmdEndRendering(commandBuffer);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();
            const constantBuffer = this.constantBuffer;
            if (constantBuffer) {
                this.writeConstants(constantBuffer, queuedFrameIndex);
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const colorBuffer = this.colorBuffer;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the scene into the color buffer, the color buffer blitted into the swap
                // chain texture, the overlay over it.
                Nri_BeginCommandBuffer(commandBuffer);
                if (colorBuffer) {
                    Nri_CmdTextureBarrier(commandBuffer, colorBuffer, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
                    this.recordScene(commandBuffer, queuedFrame);
                    Nri_CmdTextureBarrier(commandBuffer, colorBuffer, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
                }
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                this.recordBlit(commandBuffer);
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
                    this.destroyDescriptor(queuedFrame.commonView);
                    this.destroyDescriptor(queuedFrame.baselineView);
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
                this.destroyDescriptor(this.envmapView);
                this.destroyDescriptor(this.anisotropicWrap);
                this.destroyDescriptor(this.linearClamp);
                this.destroyDescriptor(this.colorAttachment);
                this.destroyDescriptor(this.logicOpAttachment);
                this.destroyDescriptor(this.colorView);
                this.destroyDescriptor(this.depthAttachment);
                this.destroyTexture(this.envmap);
                this.destroyTexture(this.colorBuffer);
                this.destroyTexture(this.depthTexture);
                const background = this.background;
                if (background) {
                    Nri_DestroyGltfMesh(background);
                }
                this.destroyBuffer(this.cubePositions);
                this.destroyBuffer(this.cubeNormals);
                this.destroyBuffer(this.cubeIndices);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.backgroundPipeline);
                this.destroyPipeline(this.blitPipeline);
                for (const pipeline of this.baselinePipelines) {
                    this.destroyPipeline(pipeline);
                }
                this.destroyLayout(this.layout);
                this.destroyLayout(this.blitLayout);
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

        destroyTexture(texture: NriTextureHandle | null) {
            if (texture) {
                Nri_DestroyTexture(texture);
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
        const logicOp = new LogicOpDynamicState(sample);
        // -op <0..15>: the logic operation at start (Vulkan's order: 3 is COPY); -noUI: no overlay.
        Nri_AddExampleOptionWithValues(sample, "-op", 1);
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-op" && i + 1 < argc) {
                i++;
                logicOp.selectedOperation = Math.min(Math.max(parseInt(Nri_GetArg(argc, argv, i)), 0), LOGIC_OP_COUNT - 1);
            } else if (arg == "-noUI") {
                logicOp.noUI = true;
            }
        }
        return logicOp.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return LogicOpDynamicStateNri.main(argc, argv);
}

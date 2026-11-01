/// <reference path="../../core/nri/nri_interop.d.ts" />
import { identity, perspective, radians } from "../../core/matrix";
import { MlpReader, MobileNerfCamera } from "../../core/mobile_nerf_common";

namespace MobileNerfNri {
    // mobile_nerf, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut
    // and NVRHI: the same shaders (mobile_nerf.hlsl's), NeRF meshes (read as Donut's loadGltfMesh
    // reads them), feature textures and MLPs, through the NRI calls core/nri/nri_interop.d.ts binds.
    // This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Mobile NeRF";

    // The sample's default scene, lego_combo: four of Morpheus team's Lego NeRFs (Vulkan-Samples'
    // assets, copied at build time; see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt), each a mesh,
    // two feature textures and an MLP.
    const MEDIA_DIR = "media/mobile_nerf/";
    const MODELS = ["lego_ball_phone", "lego_boba_fett_phone", "lego_monster_truck_phone", "lego_tractor_phone"];
    // lego_combo's hard-coded model transforms: translations.
    const COMBO_TRANSLATIONS = [
        0.5, 0.75, 0.0,
        0.5, 0.25, 0.0,
        0.0, -0.25, 0.5,
        0.0, -0.75, -0.5,
    ];
    // Its instancing: 2 x 2 x 2 copies of each model, 1.5 apart.
    const INSTANCE_DIM = [2, 2, 2];
    const INSTANCE_INTERVAL = [1.5, 1.5, 1.5];
    const INSTANCE_SIZE = 12;
    // Its camera position (y flipped by the sample), looking at the origin.
    const CAMERA_POSITION = [-0.0381453, 1.84186, -1.51744];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 0.01;
    const Z_FAR = 256.0;

    // Nri_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;
    const TEXCOORD_OFFSET = 24;

    // struct GlobalUniform { float4x4 model, view, proj; float3 camera_position, camera_side,
    // camera_up, camera_lookat (each in 16 bytes); float2 img_dim; float tan_half_fov; }, padded; a
    // queued frame's copy per model, each in a constant buffer view of UBO_VIEW_SIZE bytes (a
    // multiple of 256, D3D12's).
    const UBO_MODEL = 0;
    const UBO_VIEW = 16;
    const UBO_PROJ = 32;
    const UBO_CAMERA_POSITION = 48;
    const UBO_CAMERA_SIDE = 52;
    const UBO_CAMERA_UP = 56;
    const UBO_CAMERA_LOOKAT = 60;
    const UBO_IMG_DIM = 64;
    const UBO_TAN_HALF_FOV = 66;
    const UBO_FLOATS = 68;
    const UBO_VIEW_SIZE = 512;

    // The MLP: three layers' weights (the third's padded from 48 to 64, a zero after every 3), then
    // their biases (the third's padded from 3 to 4); a model's each in a constant buffer view of
    // MLP_VIEW_SIZE bytes.
    const WEIGHTS_0_COUNT = 176;
    const WEIGHTS_1_COUNT = 256;
    const WEIGHTS_2_COUNT = 64;
    const BIAS_0_COUNT = 16;
    const BIAS_1_COUNT = 16;
    const BIAS_2_COUNT = 4;
    const MLP_FLOATS = WEIGHTS_0_COUNT + WEIGHTS_1_COUNT + WEIGHTS_2_COUNT + BIAS_0_COUNT + BIAS_1_COUNT + BIAS_2_COUNT;
    const MLP_VIEW_SIZE = 2304;
    const MLP_VIEW_FLOATS = 576;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // -test: checks the last frame, read back, as the Donut example does: the NeRF scenes' meshes
    // (their features decoded by the MLP in the shader) light about 43% of it (some channel over
    // 20), about 3.5% colored (channels 61 or more apart).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        let dark = 0;
        let colored = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r <= 20 && g <= 20 && b <= 20) {
                dark++;
            }
            const high = Math.max(r, Math.max(g, b));
            const low = Math.min(r, Math.min(g, b));
            if (high - low >= 61) {
                colored++;
            }
        }
        const lit = 100.0 * (total - dark) / total;
        console.log(`Lit: ${lit}% (${total - dark} of ${total} pixels)`);
        if (lit < 30.0 || lit > 55.0) {
            return `Lit: ${lit}% of the pixels, not 30% to 55%`;
        }
        const coloredPercent = 100.0 * colored / total;
        console.log(`Colored: ${coloredPercent}% (${colored} of ${total} pixels)`);
        if (coloredPercent < 1.5 || coloredPercent > 7.0) {
            return `Colored: ${coloredPercent}% of the pixels, not 1.5% to 7%`;
        }
        return "";
    }

    // --- mlp.json (core/mobile_nerf_common.ts' MlpReader, over Nri_LoadFile's bytes) -----------

    // The sample's initialize_mlp_uniform_buffers: the layers' weights and biases, padded, into dst
    // from offset (MLP_FLOATS of them).
    function loadMlp(path: string, dst: f32[], offset: int) {
        const file = Nri_LoadFile(path);
        if (!file) {
            return false;
        }
        const reader = new MlpReader();
        const size = Nri_GetFileSize(file);
        if (reader.resize(size)) {
            Nri_CopyFileBytes(file, 0, size, Ref(reader.bytes[0]));
        }
        Nri_DestroyFile(file);
        if (size == 0) {
            return false;
        }
        const weights0 = reader.array("0_weights");
        const weights1 = reader.array("1_weights");
        const weights2 = reader.array("2_weights");
        const bias0 = reader.array("0_bias");
        const bias1 = reader.array("1_bias");
        const bias2 = reader.array("2_bias");
        if (weights0.length != WEIGHTS_0_COUNT || weights1.length != WEIGHTS_1_COUNT || weights2.length != WEIGHTS_2_COUNT - 16
            || bias0.length != BIAS_0_COUNT || bias1.length != BIAS_1_COUNT || bias2.length != BIAS_2_COUNT - 1) {
            console.log(`Unexpected MLP data in ${path}`);
            return false;
        }
        let o = offset;
        for (let i = 0; i < WEIGHTS_0_COUNT; i++) {
            dst[o + i] = weights0[i];
        }
        o += WEIGHTS_0_COUNT;
        for (let i = 0; i < WEIGHTS_1_COUNT; i++) {
            dst[o + i] = weights1[i];
        }
        o += WEIGHTS_1_COUNT;
        let raw = 0;
        for (let i = 0; i < WEIGHTS_2_COUNT; i++) {
            dst[o + i] = (i + 1) % 4 == 0 ? 0.0 : weights2[raw++];
        }
        o += WEIGHTS_2_COUNT;
        for (let i = 0; i < BIAS_0_COUNT; i++) {
            dst[o + i] = bias0[i];
        }
        o += BIAS_0_COUNT;
        for (let i = 0; i < BIAS_1_COUNT; i++) {
            dst[o + i] = bias1[i];
        }
        o += BIAS_1_COUNT;
        for (let i = 0; i < BIAS_2_COUNT; i++) {
            dst[o + i] = (i + 1) % 4 == 0 ? 0.0 : bias2[i];
        }
        return true;
    }

    // --- The sample --------------------------------------------------------------------------

    // What a frame in flight records into, and its descriptor sets: a model's each (its copy of the
    // global UBO, the model's MLP, feature textures and sampler).
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public descriptorSets: NriDescriptorSetHandle[], public uboViews: NriDescriptorHandle[]) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // One NeRF: its mesh (Nri_LoadGltfMesh: like the framework's loader, it ignores the nodes), its
    // feature textures and their views, and its MLP's constant buffer view.
    class NerfModel {
        constructor(public mesh: NriGltfMeshHandle, public feature0: NriTextureHandle, public feature1: NriTextureHandle,
            public feature0View: NriDescriptorHandle, public feature1View: NriDescriptorHandle, public mlpView: NriDescriptorHandle | null) {
        }
    }

    // Port of Vulkan-Samples' mobile_nerf (after Google's MobileNeRF, as examples/mobile_nerf.ts
    // ports it) to NRI: neural radiance fields baked into textured meshes. Each mesh is rasterized
    // with two feature textures (8 channels per pixel); its pixel shader runs them and the view
    // direction through the model's small MLP for the color. As the sample by default: forward
    // rendering, four Lego models side by side, each instanced 2 x 2 x 2 times.
    class MobileNerf {
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
        private models: NerfModel[] = [];
        private instanceBuffer: NriBufferHandle | null = null;
        private instanceCount: int = 0;
        private sampler: NriDescriptorHandle | null = null;
        private uniformBuffer: NriBufferHandle | null = null;
        private mlpBuffer: NriBufferHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private width: int = 0;
        private height: int = 0;

        private camera: MobileNerfCamera = new MobileNerfCamera();

        // Upload buffer.
        private ubo: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            this.camera.setLookAt([CAMERA_POSITION[0], -CAMERA_POSITION[1], CAMERA_POSITION[2]], [0.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
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

            // The depth buffer: D32, cleared to 1.
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return 0;
            }
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            // The sample's prepare_instance_data: a grid of offsets around the origin.
            const offsets: f32[] = [];
            for (let x = 0; x < INSTANCE_DIM[0]; x++) {
                for (let y = 0; y < INSTANCE_DIM[1]; y++) {
                    for (let z = 0; z < INSTANCE_DIM[2]; z++) {
                        const index = [x, y, z];
                        for (let i = 0; i < 3; i++) {
                            offsets.push(-INSTANCE_INTERVAL[i] * 0.5 * (INSTANCE_DIM[i] - 1) + INSTANCE_INTERVAL[i] * index[i]);
                        }
                    }
                }
            }
            this.instanceCount = offsets.length / 3;
            this.instanceBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(offsets[0]), offsets.length * 4, NriBufferUsage.VertexBuffer);

            // The models: meshes, feature textures (linear: RGBA8_UNORM, one level, as the framework
            // uploads PNGs) and MLPs (a model's each at MLP_VIEW_SIZE bytes in one buffer).
            const mlp: f32[] = [];
            for (let i = 0; i < MODELS.length * MLP_VIEW_FLOATS; i++) {
                mlp.push(0.0);
            }
            for (let m = 0; m < MODELS.length; m++) {
                const dir = MEDIA_DIR + MODELS[m] + "/";
                const mesh = Nri_LoadGltfMesh(device, this.queue, dir + "shape0.gltf");
                const feature0 = Nri_LoadImageTexture(device, this.queue, dir + "shape0.pngfeat0.png", 0);
                const feature1 = Nri_LoadImageTexture(device, this.queue, dir + "shape0.pngfeat1.png", 0);
                const loaded = loadMlp(dir + "mlp.json", mlp, m * MLP_VIEW_FLOATS);
                if (!mesh || !feature0 || !feature1 || !loaded) {
                    console.log("Cannot load the NeRF models: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                    return 0;
                }
                this.models.push(new NerfModel(mesh, feature0, feature1, Nri_CreateTextureView(feature0, NriFormat.RGBA8_UNORM),
                    Nri_CreateTextureView(feature1, NriFormat.RGBA8_UNORM), null));
            }
            const mlpBuffer = Nri_CreateHostBuffer(device, MODELS.length * MLP_VIEW_SIZE, NriBufferUsage.ConstantBuffer);
            this.mlpBuffer = mlpBuffer;
            if (!mlpBuffer || !this.instanceBuffer) {
                console.log("Cannot create the buffers");
                return 0;
            }
            Nri_WriteBuffer(mlpBuffer, 0, Ref(mlp[0]), MODELS.length * MLP_VIEW_SIZE);
            for (let m = 0; m < this.models.length; m++) {
                this.models[m].mlpView = Nri_CreateConstantBufferView(mlpBuffer, m * MLP_VIEW_SIZE, MLP_VIEW_SIZE);
            }

            // Feature textures filtered bilinearly at their (only) level, clamped.
            const sampler = Nri_CreateSamplerWithMipFilter(device, NriFilter.Linear, NriFilter.Nearest, NriAddressMode.ClampToEdge, 1);
            this.sampler = sampler;
            if (!sampler) {
                console.log("Cannot create the sampler");
                return 0;
            }

            // The layout: the global UBO (b0) and the MLP (b1), both shaders'; the feature textures
            // (t0, t1) and their sampler (s0).
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 1, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 1, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const layout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            this.pipeline = this.createPipeline(device, layout, `shaders/mobile_nerf/${folder}/mobile_nerf`);
            if (!this.pipeline) {
                console.log("Cannot load the mobile NeRF shaders");
                return 0;
            }

            // A queued frame's global UBO per model, in a descriptor set per model.
            const setNum = queuedFrameNum * MODELS.length;
            const uniformBuffer = Nri_CreateHostBuffer(device, setNum * UBO_VIEW_SIZE, NriBufferUsage.ConstantBuffer);
            this.uniformBuffer = uniformBuffer;
            const descriptorPool = Nri_CreateDescriptorPool(device, setNum, setNum, 2 * setNum, 2 * setNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!uniformBuffer || !descriptorPool) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const queuedFrame = new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), [], []);
                this.queuedFrames.push(queuedFrame);
                for (let m = 0; m < this.models.length; m++) {
                    const model = this.models[m];
                    const descriptorSet = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
                    const uboView = Nri_CreateConstantBufferView(uniformBuffer, (i * MODELS.length + m) * UBO_VIEW_SIZE, UBO_VIEW_SIZE);
                    const mlpView = model.mlpView;
                    if (!descriptorSet || !uboView || !mlpView) {
                        console.log("Cannot create the descriptor sets");
                        return 0;
                    }
                    queuedFrame.descriptorSets.push(descriptorSet);
                    queuedFrame.uboViews.push(uboView);
                    Nri_UpdateDescriptor(descriptorSet, 0, 0, uboView);
                    Nri_UpdateDescriptor(descriptorSet, 1, 0, mlpView);
                    Nri_UpdateDescriptor(descriptorSet, 2, 0, model.feature0View);
                    Nri_UpdateDescriptor(descriptorSet, 3, 0, model.feature1View);
                    Nri_UpdateDescriptor(descriptorSet, 4, 0, sampler);
                }
            }

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The sample's pipeline: the mesh's position and texture coordinates, the instance's offset
        // (stream 1); depth tested (less) and written, no culling, no blending.
        createPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, shaders: string) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_raster_vs.bin`, "raster_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_merged_ps.bin`, "merged_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "TEXCOORD", NriFormat.RG32_SFLOAT, TEXCOORD_OFFSET);
            Nri_PipelineDescAddVertexAttributeFromStream(desc, "INSTANCE_OFFSET", NriFormat.RGB32_SFLOAT, 0, 1);
            Nri_PipelineDescSetInstanceStream(desc, 1);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.None);
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Less, 1, 0);
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

        // The camera's mouse handling: the buttons, then the cursor's position (as the Donut
        // example's mouse callbacks give them).
        handleMouse() {
            for (let button = 0; button < 3; button++) {
                this.camera.mouseButton(<MouseButton>button, <Action>Nri_IsButtonPressed(this.sample, button));
            }
            this.camera.mouseMove(Nri_GetMouseX(this.sample), Nri_GetMouseY(this.sample));
        }

        // The sample's update_uniform_buffers: its projection (clip y negated, as the Donut example
        // gives it), view, camera position (the view's translation, as the framework keeps it) and
        // axes; a model's transform each, into this frame's UBOs.
        writeUbos(queuedFrameIndex: int) {
            const uniformBuffer = this.uniformBuffer;
            if (!uniformBuffer) {
                return;
            }
            const projection = perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            const u = this.ubo;
            for (let i = 0; i < 16; i++) {
                u[UBO_VIEW + i] = view[i];
                u[UBO_PROJ + i] = i % 4 == 1 ? -projection[i] : projection[i];
            }
            for (let i = 0; i < 3; i++) {
                u[UBO_CAMERA_POSITION + i] = this.camera.position[i];
                u[UBO_CAMERA_SIDE + i] = view[i * 4];
                u[UBO_CAMERA_UP + i] = view[i * 4 + 1];
                u[UBO_CAMERA_LOOKAT + i] = -view[i * 4 + 2];
            }
            u[UBO_IMG_DIM] = this.width;
            u[UBO_IMG_DIM + 1] = this.height;
            u[UBO_TAN_HALF_FOV] = Math.tan(0.5 * radians(CAMERA_FOV));
            for (let m = 0; m < this.models.length; m++) {
                const transform = identity();
                transform[12] = COMBO_TRANSLATIONS[m * 3];
                transform[13] = COMBO_TRANSLATIONS[m * 3 + 1];
                transform[14] = COMBO_TRANSLATIONS[m * 3 + 2];
                for (let i = 0; i < 16; i++) {
                    u[UBO_MODEL + i] = transform[i];
                }
                Nri_WriteBuffer(uniformBuffer, (queuedFrameIndex * MODELS.length + m) * UBO_VIEW_SIZE, Ref(u[0]), UBO_FLOATS * 4);
            }
        }

        // Each model, with its UBO, MLP and features, instanced (between Nri_CmdBeginRenderingWithDepth
        // and Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const descriptorPool = this.descriptorPool;
            const pipeline = this.pipeline;
            const instanceBuffer = this.instanceBuffer;
            if (!layout || !descriptorPool || !pipeline || !instanceBuffer) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, layout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            for (let m = 0; m < this.models.length; m++) {
                const mesh = this.models[m].mesh;
                Nri_CmdSetDescriptorSet(commandBuffer, 0, queuedFrame.descriptorSets[m]);
                Nri_CmdSetIndexBuffer(commandBuffer, Nri_GetGltfMeshIndexBuffer(mesh), 0, NriIndexType.UInt32);
                Nri_CmdSetVertexBuffer(commandBuffer, 0, Nri_GetGltfMeshVertexBuffer(mesh), 0, VERTEX_SIZE);
                Nri_CmdSetVertexBuffer(commandBuffer, 1, instanceBuffer, 0, INSTANCE_SIZE);
                Nri_CmdDrawIndexed(commandBuffer, Nri_GetGltfMeshIndexCount(mesh), this.instanceCount, 0, 0, 0);
            }
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.handleMouse();
            this.writeUbos(queuedFrameIndex);

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: color cleared to black, depth to 1; the models.
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                    Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 1.0);
                    Nri_CmdClearDepth(commandBuffer, 1.0);
                    this.recordDraw(commandBuffer, queuedFrame);
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
                    for (const uboView of queuedFrame.uboViews) {
                        Nri_DestroyDescriptor(uboView);
                    }
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
                for (const model of this.models) {
                    Nri_DestroyDescriptor(model.feature0View);
                    Nri_DestroyDescriptor(model.feature1View);
                    this.destroyDescriptor(model.mlpView);
                    Nri_DestroyTexture(model.feature0);
                    Nri_DestroyTexture(model.feature1);
                    Nri_DestroyGltfMesh(model.mesh);
                }
                this.destroyDescriptor(this.depthAttachment);
                this.destroyDescriptor(this.sampler);
                this.destroyTexture(this.depthTexture);
                this.destroyBuffer(this.instanceBuffer);
                this.destroyBuffer(this.uniformBuffer);
                this.destroyBuffer(this.mlpBuffer);
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
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const mobileNerf = new MobileNerf(sample);
        return mobileNerf.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return MobileNerfNri.main(argc, argv);
}

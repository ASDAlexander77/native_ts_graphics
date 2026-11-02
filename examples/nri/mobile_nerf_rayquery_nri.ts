/// <reference path="../../core/nri/nri_interop.d.ts" />
import { radians, perspective, inverseGaussJordan } from "../../core/matrix";
import { MlpReader, MobileNerfCamera } from "../../core/mobile_nerf_common";

namespace MobileNerfRayQueryNri {
    // mobile_nerf_rayquery, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (mobile_nerf_rayquery.hlsl's), NeRF meshes (read as Donut's
    // loadGltfModel reads them), feature textures and MLPs, through the NRI calls
    // core/nri/nri_interop.d.ts binds. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no ray queries, or no shaders for
    // the graphics API (D3D11).
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Mobile NeRF Ray Query";

    // The sample's default scene, lego_combo: four of Morpheus team's Lego NeRFs (Vulkan-Samples'
    // assets, mobile_nerf's copy; see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt), each a mesh, two
    // feature textures and an MLP.
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
    // Its camera position (y flipped by the sample), looking at the origin.
    const CAMERA_POSITION = [-0.0381453, 1.84186, -1.51744];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 0.01;
    const Z_FAR = 200.0;
    // ApiVulkanSample's default_clear_color.
    const CLEAR_COLOR = 0.002;
    // The clear color in the sRGB back buffer, as test_check's rgb() reads it (0xBBGGRR).
    const CLEARED = 0x070707;

    // Nri_LoadGltfModel's vertices: float3 position, float3 normal, float2 texture coordinates.
    const GLTF_VERTEX_FLOATS = 8;
    // The sample's Vertex: float3 position, float2 texture coordinates.
    const VERTEX_FLOATS = 5;

    // struct GlobalUniform { float4x4 view_inverse, proj_inverse; float2 img_dim; float
    // tan_half_fov; } padded, then float4 model_offsets[4] (first vertex, first index: exact as
    // floats); a queued frame's in a UBO_STRIDE-byte slice of the constant buffer (D3D12 constant
    // buffer views' alignment).
    const UBO_VIEW_INVERSE = 0;
    const UBO_PROJ_INVERSE = 16;
    const UBO_IMG_DIM = 32;
    const UBO_TAN_HALF_FOV = 34;
    const UBO_MODEL_OFFSETS = 36;
    const UBO_FLOATS = 52;
    const UBO_STRIDE = 256;

    // The MLP: three layers' weights (the third's padded from 48 to 64, a zero after every 3), then
    // their biases (the third's padded from 3 to 4); the models' one after the other (4 x 2128 bytes,
    // in a buffer and view rounded up to 256 bytes: D3D12's constant buffer views are 256-byte
    // multiples, and creating another removes the device).
    const WEIGHTS_0_COUNT = 176;
    const WEIGHTS_1_COUNT = 256;
    const WEIGHTS_2_COUNT = 64;
    const BIAS_0_COUNT = 16;
    const BIAS_1_COUNT = 16;
    const BIAS_2_COUNT = 4;

    // nri::TopLevelInstanceBits::TRIANGLE_CULL_DISABLE (NVRHI's InstanceFlags::TriangleCullDisable).
    const INSTANCE_FLAGS_CULL_DISABLE = 1;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // -test: checks the last frame, read back, as the Donut example does. The corners are the dark
    // clear color; the NeRF meshes, found by ray queries, cover about 42% of the frame.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const corners = [0, width - 1, (height - 1) * width, height * width - 1];
        for (const corner of corners) {
            if ((pixels[corner] & 0xFFFFFF) != CLEARED) {
                return "the corners aren't the clear color";
            }
        }
        const total = width * height;
        let meshes = 0;
        for (let i = 0; i < total; i++) {
            if ((pixels[i] & 0xFFFFFF) != CLEARED) {
                meshes++;
            }
        }
        const percent = 100.0 * meshes / total;
        console.log(`Meshes: ${percent}% (${meshes} of ${total} pixels)`);
        if (percent < 32.0 || percent > 52.0) {
            return `Meshes: ${percent}% of the pixels, not 32% to 52%`;
        }
        return "";
    }

    // --- mlp.json (core/mobile_nerf_common.ts' MlpReader, over Nri_LoadFile's bytes) -----------

    // The sample's initialize_mlp_uniform_buffers: the layers' weights and biases, padded, appended
    // to dst.
    function loadMlp(path: string, dst: f32[]) {
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
        for (let i = 0; i < WEIGHTS_0_COUNT; i++) {
            dst.push(weights0[i]);
        }
        for (let i = 0; i < WEIGHTS_1_COUNT; i++) {
            dst.push(weights1[i]);
        }
        let raw = 0;
        for (let i = 0; i < WEIGHTS_2_COUNT; i++) {
            dst.push((i + 1) % 4 == 0 ? 0.0 : weights2[raw++]);
        }
        for (let i = 0; i < BIAS_0_COUNT; i++) {
            dst.push(bias0[i]);
        }
        for (let i = 0; i < BIAS_1_COUNT; i++) {
            dst.push(bias1[i]);
        }
        for (let i = 0; i < BIAS_2_COUNT; i++) {
            dst.push((i + 1) % 4 == 0 ? 0.0 : bias2[i]);
        }
        return true;
    }

    // --- The sample --------------------------------------------------------------------------

    // What a frame in flight records into, and its descriptor set (its UBO slice, the MLPs, the TLAS,
    // the models' buffers, feature textures and sampler).
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public uboView: NriDescriptorHandle | null, public set: NriDescriptorSetHandle | null) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // A model's feature textures and their views.
    class Features {
        constructor(public feature0: NriTextureHandle, public feature1: NriTextureHandle,
            public feature0View: NriDescriptorHandle, public feature1View: NriDescriptorHandle) {
        }
    }

    // Port of Vulkan-Samples' mobile_nerf_rayquery (after Google's MobileNeRF, as
    // examples/mobile_nerf_rayquery.ts ports it) to NRI: mobile_nerf's neural radiance fields (see
    // mobile_nerf_nri.ts), found by ray queries instead of rasterization. A triangle over the screen;
    // each pixel traces its ray inline through a TLAS of the NeRF meshes (one BLAS per model, 2 x 2 x 2
    // instances of each, the instance's ID the model's), reads the hit's texture coordinates from the
    // model's vertices and runs its feature textures through the model's MLP. Missed pixels keep the
    // clear color.
    class MobileNerfRayQuery {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private layout: NriPipelineLayoutHandle | null = null;
        private pipeline: NriPipelineHandle | null = null;
        private features: Features[] = [];
        private vertexBuffer: NriBufferHandle | null = null;
        private indexBuffer: NriBufferHandle | null = null;
        private vertexView: NriDescriptorHandle | null = null;
        private indexView: NriDescriptorHandle | null = null;
        private blases: NriAccelerationStructureHandle[] = [];
        private topLevelAS: NriTopLevelASHandle | null = null;
        private topLevelASView: NriDescriptorHandle | null = null;
        private sampler: NriDescriptorHandle | null = null;
        private uniformBuffer: NriBufferHandle | null = null;
        private weightsBuffer: NriBufferHandle | null = null;
        private weightsView: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        private camera: MobileNerfCamera = new MobileNerfCamera();
        // The models' MLPs, one after the other, and their first vertex and index.
        private weights: f32[] = [];
        private modelOffsets: int[] = [];

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

            // Ray queries: D3D12 or Vulkan (the Donut example's shaders have no DXBC).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (ray queries need D3D12 or Vulkan)";
                return 0;
            }
            if (Nri_IsFeatureSupported(device, NriFeature.RayQuery) == 0) {
                this.unsupportedReason = "The graphics device does not support Ray Queries";
                return 0;
            }

            // The models: MLPs, meshes (and their BLASes), feature textures (linear: RGBA8_UNORM, one
            // level, as the framework uploads PNGs).
            for (const modelName of MODELS) {
                if (!loadMlp(MEDIA_DIR + modelName + "/mlp.json", this.weights)) {
                    console.log("Cannot load the NeRF models: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                    return 0;
                }
            }
            let loaded = this.loadModels(device);
            for (let m = 0; m < MODELS.length && loaded; m++) {
                const dir = MEDIA_DIR + MODELS[m] + "/";
                const feature0 = Nri_LoadImageTexture(device, this.queue, dir + "shape0.pngfeat0.png", 0);
                const feature1 = Nri_LoadImageTexture(device, this.queue, dir + "shape0.pngfeat1.png", 0);
                if (!feature0 || !feature1) {
                    loaded = false;
                    break;
                }
                this.features.push(new Features(feature0, feature1, Nri_CreateTextureView(feature0, NriFormat.RGBA8_UNORM),
                    Nri_CreateTextureView(feature1, NriFormat.RGBA8_UNORM)));
            }
            if (!loaded) {
                console.log("Cannot load the NeRF models: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }

            // The sample's create_top_level_acceleration_structure: each model in each place of the
            // instancing grid, its instance ID the model's (for its buffers, textures and weights);
            // built before the first frame.
            const topLevelAS = Nri_CreateTopLevelAS(device, MODELS.length * INSTANCE_DIM[0] * INSTANCE_DIM[1] * INSTANCE_DIM[2],
                NriAccelerationStructureFlags.None, 1);
            this.topLevelAS = topLevelAS;
            if (!topLevelAS) {
                console.log("Cannot create the top level acceleration structure");
                return 0;
            }
            this.addInstances(topLevelAS);
            if (Nri_BuildTopLevelASOnQueue(this.queue, topLevelAS) == 0) {
                console.log("Cannot build the top level acceleration structure");
                return 0;
            }
            const topLevelASView = Nri_CreateAccelerationStructureDescriptor(Nri_GetTopLevelAccelerationStructure(topLevelAS));
            this.topLevelASView = topLevelASView;

            for (let m = 0; m < MODELS.length; m++) {
                const k = UBO_MODEL_OFFSETS + m * 4;
                this.ubo[k] = this.modelOffsets[m * 2];
                this.ubo[k + 1] = this.modelOffsets[m * 2 + 1];
            }

            // Feature textures filtered bilinearly at their (only) level, clamped.
            const sampler = Nri_CreateSamplerWithMipFilter(device, NriFilter.Linear, NriFilter.Nearest, NriAddressMode.ClampToEdge, 1);
            this.sampler = sampler;
            // The MLPs, written once (the Donut example writes the same every frame).
            const weightsSize = Math.ceil(this.weights.length * 4 / 256) * 256;
            const weightsBuffer = Nri_CreateHostBuffer(device, weightsSize, NriBufferUsage.ConstantBuffer);
            this.weightsBuffer = weightsBuffer;
            if (!sampler || !weightsBuffer) {
                console.log("Cannot create the sampler and the MLP buffer");
                return 0;
            }
            Nri_WriteBuffer(weightsBuffer, 0, Ref(this.weights[0]), this.weights.length * 4);
            const weightsView = Nri_CreateConstantBufferView(weightsBuffer, 0, weightsSize);
            this.weightsView = weightsView;

            // The layout, as the Donut example's binding layout: the global UBO (b0), the MLPs (b1),
            // the TLAS (t0), the vertices (t1) and indices (t2), the feature textures (t3 to t6, t7 to
            // t10: arrays) and their sampler (s0).
            const stages = NriStage.Pixel;
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, stages, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 1, 1, NriDescriptorType.ConstantBuffer, stages, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.AccelerationStructure, stages, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 1, 1, NriDescriptorType.StructuredBuffer, stages, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 2, 1, NriDescriptorType.StructuredBuffer, stages, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 3, MODELS.length, NriDescriptorType.Texture, stages, NriRangeFlags.Array);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 7, MODELS.length, NriDescriptorType.Texture, stages, NriRangeFlags.Array);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Sampler, stages, NriRangeFlags.None);
            const layout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            this.pipeline = this.createPipeline(device, layout, `shaders/mobile_nerf_rayquery/${folder}/mobile_nerf_rayquery`);
            if (!this.pipeline) {
                console.log("Cannot load the mobile NeRF ray query shaders");
                return 0;
            }

            // A queued frame's UBO slice, in its descriptor set with the rest.
            const uniformBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * UBO_STRIDE, NriBufferUsage.ConstantBuffer);
            this.uniformBuffer = uniformBuffer;
            const descriptorPool = Nri_CreateDescriptorPoolWithAccelerationStructures(device, queuedFrameNum, queuedFrameNum,
                2 * queuedFrameNum, 2 * MODELS.length * queuedFrameNum, 0, 2 * queuedFrameNum, queuedFrameNum);
            this.descriptorPool = descriptorPool;
            const vertexView = this.vertexView;
            const indexView = this.indexView;
            if (!uniformBuffer || !descriptorPool || !weightsView || !topLevelASView || !vertexView || !indexView) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const uboView = Nri_CreateConstantBufferView(uniformBuffer, i * UBO_STRIDE, UBO_STRIDE);
                const set = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), uboView, set));
                if (!uboView || !set) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(set, 0, 0, uboView);
                Nri_UpdateDescriptor(set, 1, 0, weightsView);
                Nri_UpdateDescriptor(set, 2, 0, topLevelASView);
                Nri_UpdateDescriptor(set, 3, 0, vertexView);
                Nri_UpdateDescriptor(set, 4, 0, indexView);
                for (let m = 0; m < MODELS.length; m++) {
                    Nri_UpdateDescriptor(set, 5, m, this.features[m].feature0View);
                    Nri_UpdateDescriptor(set, 6, m, this.features[m].feature1View);
                }
                Nri_UpdateDescriptor(set, 7, 0, sampler);
            }

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The sample's pipeline draws a triangle over the screen: no culling, nothing blended, no
        // depth (its depth test passes everywhere, the triangle's depth being 0).
        createPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, shaders: string) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_quad_vs.bin`, "quad_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_rayquery_ps.bin`, "rayquery_ps") != 0;
            }
            Nri_PipelineDescSetCullMode(desc, NriCullMode.None);
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // The sample's load_scene, create_static_object_buffers and
        // create_bottom_level_acceleration_structure for every model: its meshes' vertices (y flipped,
        // v flipped) and triangles, appended to one vertex and one index buffer (structured buffers the
        // shader reads), and a BLAS of them with the model's combo transform (y negated, as the
        // sample's vertices are). NRI's BLAS geometry has no transform: the translation is added to
        // the BLAS's positions, in float as the builder would. False on failure.
        loadModels(device: NriDeviceHandle) {
            const vertices: f32[] = [];
            const indices: int[] = [];
            const firstVertices: int[] = [];
            const firstIndices: int[] = [];
            const counts: int[] = [];
            for (const modelName of MODELS) {
                const model = Nri_LoadGltfModel(MEDIA_DIR + modelName + "/shape0.gltf");
                if (!model) {
                    return false;
                }
                const firstVertex = vertices.length / VERTEX_FLOATS;
                const firstIndex = indices.length;
                const primitiveCount = Nri_GetGltfModelPrimitiveCount(model);
                for (let p = 0; p < primitiveCount; p++) {
                    const vertexStart = vertices.length / VERTEX_FLOATS - firstVertex;
                    const vertexCount = Nri_GetGltfModelVertexCount(model, p);
                    const indexCount = Nri_GetGltfModelIndexCount(model, p);
                    const gltfVertices: f32[] = [];
                    for (let i = 0; i < vertexCount * GLTF_VERTEX_FLOATS; i++) {
                        gltfVertices.push(0.0);
                    }
                    const gltfIndices: int[] = [];
                    for (let i = 0; i < indexCount; i++) {
                        gltfIndices.push(0);
                    }
                    Nri_CopyGltfModelVertices(model, p, Ref(gltfVertices[0]));
                    Nri_CopyGltfModelIndices(model, p, Ref(gltfIndices[0]));
                    for (let v = 0; v < vertexCount; v++) {
                        const g = v * GLTF_VERTEX_FLOATS;
                        vertices.push(gltfVertices[g]);
                        vertices.push(-gltfVertices[g + 1]);
                        vertices.push(gltfVertices[g + 2]);
                        vertices.push(gltfVertices[g + 6]);
                        vertices.push(1.0 - gltfVertices[g + 7]);
                    }
                    for (let i = 0; i < indexCount; i++) {
                        indices.push(vertexStart + gltfIndices[i]);
                    }
                }
                Nri_DestroyGltfModel(model);
                firstVertices.push(firstVertex);
                firstIndices.push(firstIndex);
                counts.push(vertices.length / VERTEX_FLOATS - firstVertex);
                counts.push(indices.length - firstIndex);
                this.modelOffsets.push(firstVertex);
                this.modelOffsets.push(firstIndex);
            }
            if (vertices.length == 0) {
                return false;
            }

            const vertexBuffer = Nri_CreateUploadedStructuredBuffer(device, this.queue, Ref(vertices[0]), vertices.length * 4, 4);
            this.vertexBuffer = vertexBuffer;
            const indexBuffer = Nri_CreateUploadedStructuredBufferFromInts(device, this.queue, Ref(indices[0]), indices.length * 4, 4);
            this.indexBuffer = indexBuffer;
            if (!vertexBuffer || !indexBuffer) {
                return false;
            }
            this.vertexView = Nri_CreateStructuredBufferView(vertexBuffer, 0);
            this.indexView = Nri_CreateStructuredBufferView(indexBuffer, 0);

            for (let m = 0; m < MODELS.length; m++) {
                const translation = [
                    Math.fround(COMBO_TRANSLATIONS[m * 3]),
                    Math.fround(-COMBO_TRANSLATIONS[m * 3 + 1]),
                    Math.fround(COMBO_TRANSLATIONS[m * 3 + 2]),
                ];
                const vertexCount = counts[m * 2];
                const indexCount = counts[m * 2 + 1];
                const positions: f32[] = [];
                for (let v = 0; v < vertexCount; v++) {
                    const k = (firstVertices[m] + v) * VERTEX_FLOATS;
                    for (let i = 0; i < 3; i++) {
                        positions.push(Math.fround(vertices[k + i] + translation[i]));
                    }
                }
                const modelIndices: int[] = [];
                for (let i = 0; i < indexCount; i++) {
                    modelIndices.push(indices[firstIndices[m] + i]);
                }
                const desc = Nri_CreateBlasDesc();
                Nri_BlasDescAddTriangles(desc, Ref(positions[0]), vertexCount, Ref(modelIndices[0]), indexCount);
                const blas = Nri_BuildBlasFromDesc(device, this.queue, desc, NriAccelerationStructureFlags.PreferFastTrace);
                Nri_DestroyBlasDesc(desc);
                if (!blas) {
                    return false;
                }
                this.blases.push(blas);
            }
            return true;
        }

        // The instancing grid's instances, each model at each place (rows of a 3 x 4 matrix: identity,
        // translated), as the sample adds them.
        addInstances(topLevelAS: NriTopLevelASHandle) {
            const transform: f32[] = [];
            for (let i = 0; i < 12; i++) {
                transform.push(0.0);
            }
            const offset = [0.0, 0.0, 0.0];
            for (let x = 0; x < INSTANCE_DIM[0]; x++) {
                offset[0] = -INSTANCE_INTERVAL[0] * 0.5 * (INSTANCE_DIM[0] - 1) + INSTANCE_INTERVAL[0] * x;
                for (let y = 0; y < INSTANCE_DIM[1]; y++) {
                    offset[1] = -INSTANCE_INTERVAL[1] * 0.5 * (INSTANCE_DIM[1] - 1) + INSTANCE_INTERVAL[1] * y;
                    for (let z = 0; z < INSTANCE_DIM[2]; z++) {
                        offset[2] = -INSTANCE_INTERVAL[2] * 0.5 * (INSTANCE_DIM[2] - 1) + INSTANCE_INTERVAL[2] * z;
                        for (let i = 0; i < 12; i++) {
                            transform[i] = i % 5 == 0 ? 1.0 : 0.0;
                        }
                        transform[3] = offset[0];
                        transform[7] = offset[1];
                        transform[11] = offset[2];
                        for (let m = 0; m < this.blases.length; m++) {
                            Nri_TopLevelASAddInstance(topLevelAS, this.blases[m], Ref(transform[0]), m, 0xFF, 0, INSTANCE_FLAGS_CULL_DISABLE);
                        }
                    }
                }
            }
        }

        // Waits for the frame that last used this frame's command allocator (and its UBO slice).
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

        // The sample's update_uniform_buffer: the inverses of its view and projection (glm's, no y
        // flip: the shader takes SV_Position's y as the sample's gl_FragCoord's), the image size and
        // the field of view; into this frame's UBO slice (the model offsets written once).
        writeUbo(uniformBuffer: NriBufferHandle, queuedFrameIndex: int) {
            const viewInverse = inverseGaussJordan(this.camera.view());
            const projInverse = inverseGaussJordan(perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR));
            const u = this.ubo;
            for (let i = 0; i < 16; i++) {
                u[UBO_VIEW_INVERSE + i] = viewInverse[i];
                u[UBO_PROJ_INVERSE + i] = projInverse[i];
            }
            u[UBO_IMG_DIM] = this.width;
            u[UBO_IMG_DIM + 1] = this.height;
            u[UBO_TAN_HALF_FOV] = Math.tan(0.5 * radians(CAMERA_FOV));
            Nri_WriteBuffer(uniformBuffer, queuedFrameIndex * UBO_STRIDE, Ref(u[0]), UBO_FLOATS * 4);
        }

        // The triangle over the screen (between Nri_CmdBeginRendering and Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const pipeline = this.pipeline;
            const set = queuedFrame.set;
            if (!layout || !pipeline || !set) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, layout);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, set);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdDraw(commandBuffer, 3, 1, 0, 0);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.handleMouse();
            const uniformBuffer = this.uniformBuffer;
            if (uniformBuffer) {
                this.writeUbo(uniformBuffer, queuedFrameIndex);
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const descriptorPool = this.descriptorPool;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: color cleared to the sample's clear color; the triangle.
                Nri_BeginCommandBuffer(commandBuffer);
                if (descriptorPool) {
                    Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                Nri_CmdClearColor(commandBuffer, CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
                this.recordDraw(commandBuffer, queuedFrame);
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
                for (const features of this.features) {
                    Nri_DestroyDescriptor(features.feature0View);
                    Nri_DestroyDescriptor(features.feature1View);
                    Nri_DestroyTexture(features.feature0);
                    Nri_DestroyTexture(features.feature1);
                }
                this.destroyDescriptor(this.sampler);
                this.destroyDescriptor(this.weightsView);
                this.destroyDescriptor(this.vertexView);
                this.destroyDescriptor(this.indexView);
                this.destroyDescriptor(this.topLevelASView);
                const topLevelAS = this.topLevelAS;
                if (topLevelAS) {
                    Nri_DestroyTopLevelAS(topLevelAS);
                }
                for (const blas of this.blases) {
                    Nri_DestroyAccelerationStructure(blas);
                }
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.uniformBuffer);
                this.destroyBuffer(this.weightsBuffer);
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
        const mobileNerfRayQuery = new MobileNerfRayQuery(sample);
        return mobileNerfRayQuery.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return MobileNerfRayQueryNri.main(argc, argv);
}

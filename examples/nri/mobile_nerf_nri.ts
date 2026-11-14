/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { identity, perspective, radians } from "../../core/matrix";
import { MlpReader, MobileNerfCamera } from "../../core/mobile_nerf_common";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriFile, NriGltfMesh, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

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

    // NriDevice.loadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
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

    // --- mlp.json (core/mobile_nerf_common.ts' MlpReader, over NriFile.load's bytes) -----------

    // The sample's initialize_mlp_uniform_buffers: the layers' weights and biases, padded, into dst
    // from offset (MLP_FLOATS of them).
    function loadMlp(path: string, dst: f32[], offset: int) {
        const file = NriFile.load(path);
        if (!file) {
            return false;
        }
        const reader = new MlpReader();
        const size = file.getSize();
        if (reader.resize(size)) {
            file.copyBytes(0, size, Ref(reader.bytes[0]));
        }
        file.destroy();
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

    // A frame in flight's own data: its descriptor sets: a model's each (its copy of the
    // global UBO, the model's MLP, feature textures and sampler).
    class QueuedFrame {
        constructor(public descriptorSets: NriDescriptorSet[], public uboViews: NriDescriptor[]) {
        }
    }

    // One NeRF: its mesh (NriDevice.loadGltfMesh: like the framework's loader, it ignores the nodes), its
    // feature textures and their views, and its MLP's constant buffer view.
    class NerfModel {
        constructor(public mesh: NriGltfMesh, public feature0: NriTexture, public feature1: NriTexture,
            public feature0View: NriDescriptor, public feature1View: NriDescriptor, public mlpView: NriDescriptor | null) {
        }
    }

    // Port of Vulkan-Samples' mobile_nerf (after Google's MobileNeRF, as examples/mobile_nerf.ts
    // ports it) to NRI: neural radiance fields baked into textured meshes. Each mesh is rasterized
    // with two feature textures (8 channels per pixel); its pixel shader runs them and the view
    // direction through the model's small MLP for the color. As the sample by default: forward
    // rendering, four Lego models side by side, each instanced 2 x 2 x 2 times.
    class MobileNerf {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        // The swap chain textures' format and their views' (sRGB).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private viewFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private layout: NriPipelineLayout | null = null;
        private pipeline: NriPipeline | null = null;
        private models: NerfModel[] = [];
        private instanceBuffer: NriBuffer | null = null;
        private instanceCount: int = 0;
        private sampler: NriDescriptor | null = null;
        private uniformBuffer: NriBuffer | null = null;
        private mlpBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;

        private camera: MobileNerfCamera = new MobileNerfCamera();

        // Upload buffer.
        private ubo: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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
            this.sample.setInitializeCallback(initialize);
            this.sample.setLatencySleepCallback(latencySleep);
            this.sample.setRenderFrameCallback(renderFrame);

            // On a wrapper of its own: the callbacks Nri_RunSample runs may overwrite this.sample.
            let result = new NriSample(this.sample.handle).run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (result == 0 && this.test) {
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
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;

            // The depth buffer: D32, cleared to 1.
            if (!this.createDepth(device)) {
                console.log("Cannot create the depth buffer");
                return 0;
            }

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
            this.instanceBuffer = device.createUploadedBuffer(this.queue, Ref(offsets[0]), offsets.length * 4, NriBufferUsage.VertexBuffer);

            // The models: meshes, feature textures (linear: RGBA8_UNORM, one level, as the framework
            // uploads PNGs) and MLPs (a model's each at MLP_VIEW_SIZE bytes in one buffer).
            const mlp: f32[] = [];
            for (let i = 0; i < MODELS.length * MLP_VIEW_FLOATS; i++) {
                mlp.push(0.0);
            }
            for (let m = 0; m < MODELS.length; m++) {
                const dir = MEDIA_DIR + MODELS[m] + "/";
                const mesh = device.loadGltfMesh(this.queue, dir + "shape0.gltf");
                const feature0 = device.loadImageTexture(this.queue, dir + "shape0.pngfeat0.png", 0);
                const feature1 = device.loadImageTexture(this.queue, dir + "shape0.pngfeat1.png", 0);
                const loaded = loadMlp(dir + "mlp.json", mlp, m * MLP_VIEW_FLOATS);
                if (!mesh || !feature0 || !feature1 || !loaded) {
                    console.log("Cannot load the NeRF models: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                    return 0;
                }
                this.models.push(new NerfModel(mesh, feature0, feature1, feature0.createView(NriFormat.RGBA8_UNORM),
                    feature1.createView(NriFormat.RGBA8_UNORM), null));
            }
            const mlpBuffer = device.createHostBuffer(MODELS.length * MLP_VIEW_SIZE, NriBufferUsage.ConstantBuffer);
            this.mlpBuffer = mlpBuffer;
            if (!mlpBuffer || !this.instanceBuffer) {
                console.log("Cannot create the buffers");
                return 0;
            }
            mlpBuffer.write(0, Ref(mlp[0]), MODELS.length * MLP_VIEW_SIZE);
            for (let m = 0; m < this.models.length; m++) {
                this.models[m].mlpView = mlpBuffer.createConstantView(m * MLP_VIEW_SIZE, MLP_VIEW_SIZE);
            }

            // Feature textures filtered bilinearly at their (only) level, clamped.
            const sampler = device.createSamplerWithMipFilter(NriFilter.Linear, NriFilter.Nearest, NriAddressMode.ClampToEdge, 1);
            this.sampler = sampler;
            if (!sampler) {
                console.log("Cannot create the sampler");
                return 0;
            }

            // The layout: the global UBO (b0) and the MLP (b1), both shaders'; the feature textures
            // (t0, t1) and their sampler (s0).
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 1, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 1, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const layout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
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
            const uniformBuffer = device.createHostBuffer(setNum * UBO_VIEW_SIZE, NriBufferUsage.ConstantBuffer);
            this.uniformBuffer = uniformBuffer;
            const descriptorPool = device.createDescriptorPool(setNum, setNum, 2 * setNum, 2 * setNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!uniformBuffer || !descriptorPool) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const queuedFrame = new QueuedFrame([], []);
                this.queuedFrames.push(queuedFrame);
                for (let m = 0; m < this.models.length; m++) {
                    const model = this.models[m];
                    const descriptorSet = descriptorPool.allocateDescriptorSet(layout, 0, 0);
                    const uboView = uniformBuffer.createConstantView((i * MODELS.length + m) * UBO_VIEW_SIZE, UBO_VIEW_SIZE);
                    const mlpView = model.mlpView;
                    if (!descriptorSet || !uboView || !mlpView) {
                        console.log("Cannot create the descriptor sets");
                        return 0;
                    }
                    queuedFrame.descriptorSets.push(descriptorSet);
                    queuedFrame.uboViews.push(uboView);
                    descriptorSet.updateDescriptor(0, 0, uboView);
                    descriptorSet.updateDescriptor(1, 0, mlpView);
                    descriptorSet.updateDescriptor(2, 0, model.feature0View);
                    descriptorSet.updateDescriptor(3, 0, model.feature1View);
                    descriptorSet.updateDescriptor(4, 0, sampler);
                }
            }

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The sample's pipeline: the mesh's position and texture coordinates, the instance's offset
        // (stream 1); depth tested (less) and written, no culling, no blending.
        createPipeline(device: NriDevice, layout: NriPipelineLayout, shaders: string) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_raster_vs.bin`, "raster_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_merged_ps.bin`, "merged_ps") != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, TEXCOORD_OFFSET);
            desc.addVertexAttributeFromStream("INSTANCE_OFFSET", NriFormat.RGB32_SFLOAT, 0, 1);
            desc.setInstanceStream(1);
            desc.setCullMode(NriCullMode.None);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.Less, 1, 0);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // Waits for the frame that last used this frame's command allocator (and its UBOs).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The camera's mouse handling: the buttons, then the cursor's position (as the Donut
        // example's mouse callbacks give them).
        handleMouse() {
            for (let button = 0; button < 3; button++) {
                this.camera.mouseButton(<MouseButton>button, <Action>this.sample.isButtonPressed(button));
            }
            this.camera.mouseMove(this.sample.getMouseX(), this.sample.getMouseY());
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
                uniformBuffer.write((queuedFrameIndex * MODELS.length + m) * UBO_VIEW_SIZE, Ref(u[0]), UBO_FLOATS * 4);
            }
        }

        // Each model, with its UBO, MLP and features, instanced (between NriCommandBuffer.beginRenderingWithDepth
        // and NriCommandBuffer.endRendering).
        recordDraw(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const descriptorPool = this.descriptorPool;
            const pipeline = this.pipeline;
            const instanceBuffer = this.instanceBuffer;
            if (!layout || !descriptorPool || !pipeline || !instanceBuffer) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            for (let m = 0; m < this.models.length; m++) {
                const mesh = this.models[m].mesh;
                commandBuffer.setDescriptorSet(0, queuedFrame.descriptorSets[m]);
                commandBuffer.setIndexBuffer(mesh.getIndexBuffer(), 0, NriIndexType.UInt32);
                commandBuffer.setVertexBuffer(0, mesh.getVertexBuffer(), 0, VERTEX_SIZE);
                commandBuffer.setVertexBuffer(1, instanceBuffer, 0, INSTANCE_SIZE);
                commandBuffer.drawIndexed(mesh.getIndexCount(), this.instanceCount, 0, 0, 0);
            }
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The D32 depth buffer at the swap chain's size; false on failure.
        createDepth(device: NriDevice): boolean {
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                return false;
            }
            this.depthAttachment = depthTexture.createDepthAttachmentView(NriFormat.D32_SFLOAT);
            return true;
        }

        destroyDepth() {
            const depthAttachment = this.depthAttachment;
            if (depthAttachment) {
                depthAttachment.destroy();
            }
            this.depthAttachment = null;
            const depthTexture = this.depthTexture;
            if (depthTexture) {
                depthTexture.destroy();
            }
            this.depthTexture = null;
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain and the depth buffer made again at its size, once the
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
            this.destroyDepth();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.createDepth(device);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.handleMouse();
            this.writeUbos(queuedFrameIndex);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: color cleared to black, depth to 1; the models.
                commandBuffer.begin();
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
                    commandBuffer.clearColor(0.0, 0.0, 0.0, 1.0);
                    commandBuffer.clearDepth(1.0);
                    this.recordDraw(commandBuffer, queuedFrame);
                    commandBuffer.endRendering();
                }

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
            if (readbackBuffer.readRGBA8(this.rowPitch, this.width, this.height, this.readbackFormat,
                Ref(pixels[0]), pixels.length) == 0) {
                return [];
            }
            return pixels;
        }

        destroy() {
            const device = this.device;
            if (device) {
                device.waitIdle();
                for (const queuedFrame of this.queuedFrames) {
                    for (const uboView of queuedFrame.uboViews) {
                        uboView.destroy();
                    }
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                for (const model of this.models) {
                    model.feature0View.destroy();
                    model.feature1View.destroy();
                    this.destroyDescriptor(model.mlpView);
                    model.feature0.destroy();
                    model.feature1.destroy();
                    model.mesh.destroy();
                }
                this.destroyDepth();
                this.destroyDescriptor(this.sampler);
                this.destroyBuffer(this.instanceBuffer);
                this.destroyBuffer(this.uniformBuffer);
                this.destroyBuffer(this.mlpBuffer);
                this.destroyBuffer(this.readbackBuffer);
                const pipeline = this.pipeline;
                if (pipeline) {
                    pipeline.destroy();
                }
                const layout = this.layout;
                if (layout) {
                    layout.destroy();
                }
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }

        destroyDescriptor(descriptor: NriDescriptor | null) {
            if (descriptor) {
                descriptor.destroy();
            }
        }

        destroyTexture(texture: NriTexture | null) {
            if (texture) {
                texture.destroy();
            }
        }

        destroyBuffer(buffer: NriBuffer | null) {
            if (buffer) {
                buffer.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const mobileNerf = new MobileNerf(sample);
        return mobileNerf.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return MobileNerfNri.main(argc, argv);
}

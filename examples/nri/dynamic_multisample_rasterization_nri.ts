/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { identity, multiply, rotate, radians, perspective } from "../../core/matrix";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriGltfModel, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace DynamicMultisampleRasterizationNri {
    // dynamic_multisample_rasterization, rendered with NRI (NVIDIA Rendering Interface) and
    // NRIFramework instead of Donut and NVRHI: the same shaders (dynamic_multisample_rasterization.hlsl's),
    // scene (read as Donut's loadGltfModel reads it) and textures, through the NRI calls
    // core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui for the sample's overlay. This example
    // creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Dynamic Multisample Rasterization";

    // The sample's scene (Vulkan-Samples' assets): msaa's copy of the glTF file and of its base
    // color textures, and the Donut example's own of the others (normal and metallic-roughness
    // maps), all ASTC sRGB KTX files decoded to DDS at build time (see VULKAN_SAMPLES_ASSETS_DIR in
    // CMakeLists.txt).
    const SCENE_DIR = "media/msaa/space_module/";
    const SCENE_PATH = SCENE_DIR + "SpaceModule.gltf";
    const OWN_TEXTURE_DIR = "media/dynamic_multisample_rasterization/";
    const OWN_TEXTURES = ["PlaneCylinderRoom_M_CylinderRoom_Normal", "PlaneCylinderRoom_M_CylinderRoom_OcclusionRoughnessMetallic",
        "T_Metal_S", "T_Pedestal_N", "T_Pedestal_S", "phone_NORM", "phone_SPEC"];

    // NriGltfModel.load's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_FLOATS = 8;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const NORMAL_OFFSET = 12;
    const TEXCOORD_OFFSET = 24;

    // struct UBO { float4x4 projection, view; }, a queued frame's in a constant buffer view of
    // UBO_VIEW_SIZE bytes (a multiple of 256, D3D12's).
    const UBO_PROJECTION = 0;
    const UBO_VIEW = 16;
    const UBO_FLOATS = 32;
    const UBO_VIEW_SIZE = 256;
    // The push constants (b1: root constants): float4x4 model; float4 base_color_factor; float
    // metallic_factor, roughness_factor; uint baseTextureIndex, normalTextureIndex,
    // metallicRoughnessTextureIndex.
    const PUSH_MODEL = 0;
    const PUSH_BASE_COLOR_FACTOR = 16;
    const PUSH_METALLIC_FACTOR = 20;
    const PUSH_ROUGHNESS_FACTOR = 21;
    const PUSH_TEXTURE_INDICES = 22;
    const PUSH_FLOATS = 25;
    const PUSH_SIZE = PUSH_FLOATS * 4;
    // The shader's texture bindings (the sample's array of 15).
    const MAX_TEXTURES = 15;

    // The sample's look-at camera: at (1.9, 10, -18) (vkb::Camera's position, the view's
    // translation), turned -40 degrees around y, rotating at a tenth of the usual speed; reversed
    // depth from 0.1 to 256.
    const CAMERA_POSITION = [1.9, 10.0, -18.0];
    const CAMERA_ROTATION = [0.0, -40.0, 0.0];
    const CAMERA_ROTATION_SPEED = 0.1;
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    const DEPTH_FORMAT = NriFormat.D32_SFLOAT;

    // The sample counts in the sample's order (its first supported one is the default).
    const SAMPLE_COUNTS = [4, 2, 8, 16, 32, 64, 1];

    // The draws' groups, in drawing order: a pipeline each (per sample count).
    enum DrawGroup {
        Opaque = 0,
        OpaqueFlipped = 1,
        Transparent = 2,
        TransparentFlipped = 3
    }
    const GROUP_COUNT = 4;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    function sampleCountName(count: int) {
        return count == 1 ? "No MSAA" : `${count}X MSAA`;
    }

    // -test: checks the last frame, read back, as the Donut example does: the space station
    // interior fills it (85% to 99% of the pixels not near black).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        let dark = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r <= 20 && g <= 20 && b <= 20) {
                dark++;
            }
        }
        const lit = 100.0 * (total - dark) / total;
        console.log(`Lit: ${lit}% (${total - dark} of ${total} pixels)`);
        if (lit < 85.0 || lit > 99.0) {
            return `Lit: ${lit}% of the pixels, not 85% to 99%`;
        }
        return "";
    }

    // The sample's camera (the framework's vkb::Camera, look-at type), with ApiVulkanSample's mouse
    // controls: the left button turns it (at its rotation speed), the right one zooms, the middle
    // one pans.
    class SampleCamera {
        rotation: number[] = [CAMERA_ROTATION[0], CAMERA_ROTATION[1], CAMERA_ROTATION[2]];
        position: number[] = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
        buttons: boolean[] = [false, false, false];
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;

        // vkb::Camera::update_view_matrix: translate(position) * rotations around x, y, z.
        view() {
            let r = identity();
            r = rotate(r, radians(this.rotation[0]), 1.0, 0.0, 0.0);
            r = rotate(r, radians(this.rotation[1]), 0.0, 1.0, 0.0);
            r = rotate(r, radians(this.rotation[2]), 0.0, 0.0, 1.0);
            let t = identity();
            t[12] = this.position[0];
            t[13] = this.position[1];
            t[14] = this.position[2];
            return multiply(t, r);
        }

        // ApiVulkanSample::handle_mouse_move.
        mouseMove(x: number, y: number) {
            const dx = Math.floor(this.mouseX) - Math.floor(x);
            const dy = Math.floor(this.mouseY) - Math.floor(y);
            if (this.buttons[0]) {
                this.rotation[0] += dy * CAMERA_ROTATION_SPEED;
                this.rotation[1] -= dx * CAMERA_ROTATION_SPEED;
            }
            if (this.buttons[1]) {
                this.position[2] += dy * 0.005;
            }
            if (this.buttons[2]) {
                this.position[0] -= dx * 0.01;
                this.position[1] -= dy * 0.01;
            }
            this.mouseX = x;
            this.mouseY = y;
        }
    }

    // A frame in flight's own data: its descriptor set (its UBO slice, the textures and
    // the sampler).
    class QueuedFrame {
        constructor(public uboView: NriDescriptor | null, public descriptorSet: NriDescriptorSet | null) {
        }
    }

    // Port of Vulkan-Samples' dynamic_multisample_rasterization to NRI: the Space Module scene with
    // its normal and metallic-roughness maps, drawn multisampled (the sample count picked in the UI)
    // and resolved into the back buffer. The sample sets the count as dynamic state
    // (VK_EXT_extended_dynamic_state3); NRI has none, so here the pipelines (opaque, opaque of
    // flipped nodes, transparent, transparent of flipped nodes) are made per sample count when first
    // drawn with, and the targets again when the count changes. The multisampled color (sRGB) is
    // resolved by a shader into the swap chain texture's sRGB view, averaging in linear space as
    // Donut's resolves do (NRI's CmdResolveTexture averages encoded values on Vulkan:
    // shaders/nri_msaa_resolve.hlsl); without multisampling the scene is drawn straight into it.
    class DynamicMultisampleRasterization {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private layout: NriPipelineLayout | null = null;
        private sampler: NriDescriptor | null = null;
        private uniformBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private vertexBuffer: NriBuffer | null = null;
        private indexBuffer: NriBuffer | null = null;
        private textures: NriTexture[] = [];
        private textureViews: NriDescriptor[] = [];
        private shaders: string = "";
        private width: int = 0;
        private height: int = 0;

        // The sample count, the supported ones (NriDevice.getSupportedSampleCounts bits, in the sample's
        // order); -samples' (0: the default).
        sampleCount: int = 1;
        supportedCounts: int[] = [];
        requestedSampleCount: int = 0;

        // The pipelines made so far, by sample count * GROUP_COUNT + group.
        private pipelineKeys: int[] = [];
        private pipelines: NriPipeline[] = [];

        // The draws, a node's primitive each, by group in the sample's order (by mesh, node,
        // primitive): index range and base vertex, push constants (PUSH_FLOATS each).
        private drawGroup: int[] = [];
        private drawFirstIndex: int[] = [];
        private drawIndexCount: int[] = [];
        private drawBaseVertex: int[] = [];
        private drawPush: f32[] = [];

        // The targets, for builtSampleCount (0: none yet): the depth buffer and the multisampled
        // color (with multisampling), which the resolve shader reads through msColorView.
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private msColor: NriTexture | null = null;
        private msColorAttachment: NriDescriptor | null = null;
        private msColorView: NriDescriptor | null = null;
        private builtSampleCount: int = 0;

        // The resolve: its layout (the multisampled color at t0), pipeline and descriptor set.
        private resolveLayout: NriPipelineLayout | null = null;
        private resolvePipeline: NriPipeline | null = null;
        private resolveSet: NriDescriptorSet | null = null;

        // The overlay; -noUI: none.
        noUI: boolean = false;
        private imgui: boolean = false;
        private sampleCountNames: string = "";

        private camera: SampleCamera = new SampleCamera();

        // Upload buffer.
        private ubo: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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

            let result = this.sample.run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
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
            const viewFormat = this.viewFormat;

            // The sample's prepare_supported_sample_count_list, then -samples' if supported.
            const supported = device.getSupportedSampleCounts(viewFormat, DEPTH_FORMAT);
            for (let i = 0; i < SAMPLE_COUNTS.length; i++) {
                if ((supported & SAMPLE_COUNTS[i]) != 0) {
                    this.supportedCounts.push(SAMPLE_COUNTS[i]);
                }
            }
            this.sampleCount = this.supportedCounts.length > 0 ? this.supportedCounts[0] : 1;
            for (const supportedCount of this.supportedCounts) {
                if (supportedCount == this.requestedSampleCount) {
                    this.sampleCount = supportedCount;
                }
            }

            // The scene's sampler: trilinear, repeating (Donut's LinearWrap).
            const sampler = device.createSamplerWithMipFilter(NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat, 1);
            this.sampler = sampler;
            if (!sampler || !this.loadScene(device)) {
                console.log("Cannot load the scene: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }

            // The layout: the UBO (b0), the textures (t0 to t14) and the sampler (s0); the push
            // constants (b1: root constants), both shaders'.
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, MAX_TEXTURES, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRootConstants(1, PUSH_SIZE, NriStage.VertexPixel);
            const layout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The shaders, as compiled for the Donut example; a pipeline is made of them for the
            // first sample count now (to fail early), the others' when first drawn with.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            this.shaders = `shaders/dynamic_multisample_rasterization/${folder}/dynamic_multisample_rasterization`;
            if (!this.getPipeline(DrawGroup.Opaque, this.sampleCount)) {
                console.log("Cannot load the dynamic multisample rasterization shaders");
                return 0;
            }

            // The resolve's layout and pipeline: a full screen triangle averaging the samples.
            const resolveLayoutDesc = NriPipelineLayoutDesc.create();
            resolveLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            const resolveLayout = device.createPipelineLayoutFromDesc(resolveLayoutDesc);
            resolveLayoutDesc.destroy();
            this.resolveLayout = resolveLayout;
            if (!resolveLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }
            const resolveShaders = `shaders/nri_msaa_resolve/${folder}/nri_msaa_resolve`;
            const resolveDesc = NriPipelineDesc.create();
            let resolveLoaded = resolveDesc.addShader(NriShaderStage.Vertex, `${resolveShaders}_resolve_vs.bin`, "resolve_vs") != 0;
            if (resolveLoaded) {
                resolveLoaded = resolveDesc.addShader(NriShaderStage.Pixel, `${resolveShaders}_resolve_ps.bin`, "resolve_ps") != 0;
            }
            resolveDesc.setColor(viewFormat, NriColorWrite.RGBA);
            if (resolveLoaded) {
                this.resolvePipeline = device.createPipelineFromDesc(resolveLayout, resolveDesc);
            }
            resolveDesc.destroy();
            if (!this.resolvePipeline) {
                console.log("Cannot load the resolve shaders");
                return 0;
            }

            // The UBO, a queued frame's each; a queued frame's descriptor set, and the resolve's.
            const uniformBuffer = device.createHostBuffer(queuedFrameNum * UBO_VIEW_SIZE, NriBufferUsage.ConstantBuffer);
            this.uniformBuffer = uniformBuffer;
            const descriptorPool = device.createDescriptorPool(queuedFrameNum + 1, queuedFrameNum, queuedFrameNum,
                MAX_TEXTURES * queuedFrameNum + 1, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!uniformBuffer || !descriptorPool) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            this.resolveSet = descriptorPool.allocateDescriptorSet(resolveLayout, 0, 0);
            if (!this.resolveSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const uboView = uniformBuffer.createConstantView(i * UBO_VIEW_SIZE, UBO_VIEW_SIZE);
                const descriptorSet = descriptorPool.allocateDescriptorSet(layout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(uboView, descriptorSet));
                if (!uboView || !descriptorSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                descriptorSet.updateDescriptor(0, 0, uboView);
                // The file's textures, in its order (the shader's indices); the unused bindings the
                // last one (the sample's array is partly bound too).
                for (let t = 0; t < MAX_TEXTURES; t++) {
                    descriptorSet.updateDescriptor(1, t, this.textureViews[Math.min(t, this.textureViews.length - 1)]);
                }
                descriptorSet.updateDescriptor(2, 0, sampler);
            }

            // The sample's overlay.
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
                this.readbackFormat = this.swapChain.format();
            }
            return 1;
        }

        // The sample's load_assets: the scene's vertices and indices in one buffer each, its
        // textures (in the file's order: the shader's indices), and the draws, by group, in the
        // framework's order (by mesh, node, primitive); false on failure.
        loadScene(device: NriDevice): boolean {
            const scene = NriGltfModel.load(SCENE_PATH);
            if (!scene) {
                return false;
            }
            const loaded = this.loadSceneFrom(device, scene);
            scene.destroy();
            return loaded;
        }

        loadSceneFrom(device: NriDevice, scene: NriGltfModel): boolean {
            const textureCount = scene.getTextureCount();
            if (textureCount > MAX_TEXTURES) {
                console.log(`${SCENE_PATH} has more than ${MAX_TEXTURES} textures`);
                return false;
            }
            for (let t = 0; t < textureCount; t++) {
                const image = scene.getTextureImage(t);
                const dot = image.lastIndexOf(".");
                const name = dot >= 0 ? image.substring(0, dot) : image;
                let dir = SCENE_DIR;
                for (const ownTexture of OWN_TEXTURES) {
                    if (ownTexture == name) {
                        dir = OWN_TEXTURE_DIR;
                    }
                }
                // sRGB, as the Donut example loads them.
                const texture = device.loadDdsTexture(this.queue, dir + name + ".dds", 1);
                if (!texture) {
                    return false;
                }
                this.textures.push(texture);
                this.textureViews.push(texture.createView(texture.getFormat()));
            }
            if (textureCount == 0) {
                return false;
            }

            const primitiveCount = scene.getPrimitiveCount();
            const vertices: f32[] = [];
            const indices: int[] = [];
            const firstIndex: int[] = [];
            const baseVertex: int[] = [];
            let meshCount: int = 0;
            for (let p = 0; p < primitiveCount; p++) {
                const vertexCount = scene.getVertexCount(p);
                const indexCount = scene.getIndexCount(p);
                const primitiveVertices: f32[] = [];
                for (let i = 0; i < vertexCount * VERTEX_FLOATS; i++) {
                    primitiveVertices.push(0.0);
                }
                const primitiveIndices: int[] = [];
                for (let i = 0; i < indexCount; i++) {
                    primitiveIndices.push(0);
                }
                scene.copyVertices(p, Ref(primitiveVertices[0]));
                scene.copyIndices(p, Ref(primitiveIndices[0]));
                baseVertex.push(vertices.length / VERTEX_FLOATS);
                firstIndex.push(indices.length);
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v++) {
                    vertices.push(primitiveVertices[v]);
                }
                for (let i = 0; i < indexCount; i++) {
                    indices.push(primitiveIndices[i]);
                }
                meshCount = Math.max(meshCount, scene.getPrimitiveMesh(p) + 1);
            }

            const transform: f32[] = [];
            const factor: f32[] = [0.0, 0.0, 0.0, 0.0];
            for (let i = 0; i < 16; i++) {
                transform.push(0.0);
            }
            const nodeCount = scene.getNodeCount();
            for (let mesh = 0; mesh < meshCount; mesh++) {
                for (let node = 0; node < nodeCount; node++) {
                    if (scene.getNodeMesh(node) != mesh) {
                        continue;
                    }
                    scene.copyNodeTransform(node, Ref(transform[0]));
                    // Flipped: scaled by a negative factor (the determinant of its world transform).
                    const determinant = transform[0] * (transform[5] * transform[10] - transform[9] * transform[6])
                        - transform[4] * (transform[1] * transform[10] - transform[9] * transform[2])
                        + transform[8] * (transform[1] * transform[6] - transform[5] * transform[2]);
                    for (let p = 0; p < primitiveCount; p++) {
                        if (scene.getPrimitiveMesh(p) != mesh) {
                            continue;
                        }
                        // Alpha mode 2: blend.
                        const transparent = scene.getPrimitiveAlphaMode(p) == 2;
                        const flipped = determinant < 0.0;
                        this.drawGroup.push(transparent ? (flipped ? DrawGroup.TransparentFlipped : DrawGroup.Transparent)
                            : (flipped ? DrawGroup.OpaqueFlipped : DrawGroup.Opaque));
                        this.drawFirstIndex.push(firstIndex[p]);
                        this.drawIndexCount.push(scene.getIndexCount(p));
                        this.drawBaseVertex.push(baseVertex[p]);
                        // The sample's draw_node: the node's transform, the material's factors and
                        // texture indices (-1: none).
                        const pushStart = this.drawPush.length;
                        for (let i = 0; i < PUSH_FLOATS; i++) {
                            this.drawPush.push(0.0);
                        }
                        for (let i = 0; i < 16; i++) {
                            this.drawPush[pushStart + PUSH_MODEL + i] = transform[i];
                        }
                        scene.copyBaseColorFactor(p, Ref(factor[0]));
                        for (let i = 0; i < 4; i++) {
                            this.drawPush[pushStart + PUSH_BASE_COLOR_FACTOR + i] = factor[i];
                        }
                        this.drawPush[pushStart + PUSH_METALLIC_FACTOR] = scene.getMaterialFactor(p, 0);
                        this.drawPush[pushStart + PUSH_ROUGHNESS_FACTOR] = scene.getMaterialFactor(p, 1);
                        for (let k = 0; k < 3; k++) {
                            Nri.storeInt32(Ref(this.drawPush[pushStart + PUSH_TEXTURE_INDICES + k]), scene.getMaterialTexture(p, k));
                        }
                    }
                }
            }

            this.vertexBuffer = device.createUploadedBuffer(this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            this.indexBuffer = device.createUploadedBufferFromInts(this.queue, Ref(indices[0]), indices.length * 4,
                NriBufferUsage.IndexBuffer);
            return this.buffersCreated();
        }

        buffersCreated(): boolean {
            if (!this.vertexBuffer) {
                return false;
            }
            return this.indexBuffer ? true : false;
        }

        // The sample's pipeline of a group for a sample count, made when first asked for: the
        // scene's vertices; reversed depth (greater), tested and written; back faces culled,
        // counter-clockwise front faces (clockwise for flipped nodes); the transparent ones blended.
        // Null on failure.
        getPipeline(group: int, sampleCount: int): NriPipeline | null {
            const key = sampleCount * GROUP_COUNT + group;
            for (let i = 0; i < this.pipelineKeys.length; i++) {
                if (this.pipelineKeys[i] == key) {
                    return this.pipelines[i];
                }
            }
            const device = this.device;
            const layout = this.layout;
            if (!device || !layout) {
                return null;
            }
            const desc = NriPipelineDesc.create();
            const shaders = this.shaders;
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_model_vs.bin`, "model_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_model_ps.bin`, "model_ps") != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("NORMAL", NriFormat.RGB32_SFLOAT, NORMAL_OFFSET);
            desc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, TEXCOORD_OFFSET);
            desc.setCullMode(NriCullMode.Back);
            const flipped = group == DrawGroup.OpaqueFlipped || group == DrawGroup.TransparentFlipped;
            desc.setFrontCounterClockwise(flipped ? 0 : 1);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
            if (group == DrawGroup.Transparent || group == DrawGroup.TransparentFlipped) {
                desc.setBlend(NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha, NriBlendOp.Add,
                    NriBlendFactor.OneMinusSrcAlpha, NriBlendFactor.Zero, NriBlendOp.Add);
            }
            desc.setDepth(DEPTH_FORMAT, NriCompareOp.Greater, 1, 0);
            desc.setSampleCount(sampleCount);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            if (pipeline) {
                this.pipelineKeys.push(key);
                this.pipelines.push(pipeline);
            }
            return pipeline;
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): once the GPU is done with them, the swap
        // chain, the depth buffer and the multisampled color made again at its size (createTargets
        // points the resolve set at the new color).
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
            this.createTargets();
        }

        // The sample's attachments_setup: the depth buffer and (with multisampling) the
        // multisampled color, for the sample count; the GPU must not be using the old ones.
        createTargets() {
            const device = this.device;
            if (!device) {
                return;
            }
            device.waitIdle();
            this.destroyTargets();
            const sampleCount = this.sampleCount;
            const depthTexture = device.createMultisampledDepthTexture(this.queue, this.width, this.height, DEPTH_FORMAT, sampleCount);
            this.depthTexture = depthTexture;
            if (depthTexture) {
                this.depthAttachment = depthTexture.createDepthAttachmentView(DEPTH_FORMAT);
            }
            if (sampleCount > 1) {
                const msColor = device.createMultisampledRenderTarget(this.queue, this.width, this.height, this.viewFormat, sampleCount);
                this.msColor = msColor;
                const resolveSet = this.resolveSet;
                if (msColor) {
                    this.msColorAttachment = msColor.createColorAttachmentView(this.viewFormat);
                    const msColorView = msColor.createView(this.viewFormat);
                    this.msColorView = msColorView;
                    if (resolveSet) {
                        resolveSet.updateDescriptor(0, 0, msColorView);
                    }
                }
            }
            this.builtSampleCount = sampleCount;
        }

        destroyTargets() {
            this.destroyDescriptor(this.depthAttachment);
            this.destroyDescriptor(this.msColorAttachment);
            this.destroyDescriptor(this.msColorView);
            this.destroyTexture(this.depthTexture);
            this.destroyTexture(this.msColor);
            this.depthAttachment = null;
            this.msColorAttachment = null;
            this.msColorView = null;
            this.depthTexture = null;
            this.msColor = null;
        }

        // Waits for the frame that last used this frame's command allocator (and its UBO).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The camera's mouse handling (the buttons unless the overlay has the mouse, then the cursor's
        // position), as the Donut example's mouse callbacks give it.
        handleMouse() {
            const overlay = this.imgui && NriImgui.wantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = this.sample.isButtonPressed(button) != 0;
                if (!pressed || !overlay) {
                    this.camera.buttons[button] = pressed;
                }
            }
            this.camera.mouseMove(this.sample.getMouseX(), this.sample.getMouseY());
        }

        // The sample's overlay: the sample count.
        buildUI() {
            if (this.sampleCountNames.length == 0) {
                for (let i = 0; i < this.supportedCounts.length; i++) {
                    this.sampleCountNames += (i > 0 ? "|" : "") + sampleCountName(this.supportedCounts[i]);
                }
            }
            let current = 0;
            for (let i = 0; i < this.supportedCounts.length; i++) {
                if (this.supportedCounts[i] == this.sampleCount) {
                    current = i;
                }
            }
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Dynamic Multisample Rasterization", 1);
            NriImgui.pushItemWidth(110.0);
            if (NriImgui.collapsingHeader("Settings", 1) != 0) {
                if (this.supportedCounts.length > 0) {
                    current = NriImgui.combo("antialiasing", current, this.sampleCountNames);
                    this.sampleCount = this.supportedCounts[current];
                }
            }
            NriImgui.popItemWidth();
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The sample's update_uniform_buffers: its projection (clip y negated, as the Donut example
        // gives it), and its view scaled down (the model is pretty large) and flipped upside down,
        // into this frame's slice.
        writeUbo(queuedFrameIndex: int) {
            const uniformBuffer = this.uniformBuffer;
            if (!uniformBuffer) {
                return;
            }
            const projection = perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                const column = Math.floor(i / 4);
                this.ubo[UBO_VIEW + i] = view[i] * (column == 1 ? -0.1 : column == 3 ? 1.0 : 0.1);
            }
            uniformBuffer.write(queuedFrameIndex * UBO_VIEW_SIZE, Ref(this.ubo[0]), UBO_FLOATS * 4);
        }

        // The draws by group, each with its pipeline (for the targets' sample count) and push
        // constants (between NriCommandBuffer.beginRenderingWithDepth and NriCommandBuffer.endRendering).
        recordDraws(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = queuedFrame.descriptorSet;
            const vertexBuffer = this.vertexBuffer;
            const indexBuffer = this.indexBuffer;
            if (!layout || !descriptorPool || !descriptorSet || !vertexBuffer || !indexBuffer) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setDescriptorSet(0, descriptorSet);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
            commandBuffer.setVertexBuffer(0, vertexBuffer, 0, VERTEX_SIZE);
            for (let group = 0; group < GROUP_COUNT; group++) {
                const pipeline = this.getPipeline(group, this.builtSampleCount);
                if (!pipeline) {
                    continue;
                }
                commandBuffer.setPipeline(pipeline);
                for (let d = 0; d < this.drawGroup.length; d++) {
                    if (this.drawGroup[d] != group) {
                        continue;
                    }
                    commandBuffer.setRootConstants(0, Ref(this.drawPush[d * PUSH_FLOATS]), PUSH_SIZE);
                    commandBuffer.drawIndexed(this.drawIndexCount[d], 1, this.drawFirstIndex[d], this.drawBaseVertex[d], 0);
                }
            }
        }

        // The scene into the swap chain texture (left as a color attachment): drawn into it without
        // multisampling; else into the multisampled color, resolved into it.
        recordScene(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame, index: int) {
            const depthAttachment = this.depthAttachment;
            if (!depthAttachment) {
                return;
            }
            const msColor = this.msColor;
            const msColorAttachment = this.msColorAttachment;
            const resolveLayout = this.resolveLayout;
            const resolvePipeline = this.resolvePipeline;
            const resolveSet = this.resolveSet;
            if (!msColor || !msColorAttachment || !resolveLayout || !resolvePipeline || !resolveSet) {
                // No multisampling: the scene straight into the swap chain texture.
                commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
                commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
                commandBuffer.clearDepth(0.0);
                this.recordDraws(commandBuffer, queuedFrame);
                commandBuffer.endRendering();
                return;
            }

            // The render pass: color cleared to transparent black, depth to 0 (reversed).
            commandBuffer.beginRenderingWithDepth(msColorAttachment, depthAttachment);
            commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
            commandBuffer.clearDepth(0.0);
            this.recordDraws(commandBuffer, queuedFrame);
            commandBuffer.endRendering();

            // Resolved (averaged in linear space: read and written through sRGB views) into the swap
            // chain texture by a full screen triangle.
            commandBuffer.textureBarrier(msColor, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
            commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.Undefined, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(resolveLayout);
            commandBuffer.setPipeline(resolvePipeline);
            commandBuffer.setDescriptorSet(0, resolveSet);
            commandBuffer.draw(3, 1, 0, 0);
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(msColor, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();
            if (this.builtSampleCount != this.sampleCount) {
                this.createTargets();
            }
            this.writeUbo(queuedFrameIndex);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the scene, then the overlay over it (a pass of its own: without depth).
                commandBuffer.begin();
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                this.recordScene(commandBuffer, queuedFrame, index);
                if (this.imgui) {
                    commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                    this.sample.drawImgui(commandBuffer, this.viewFormat);
                    commandBuffer.endRendering();
                }

                // The test's last frame: read back
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.ColorAttachment, NriTextureState.CopySource);
                        commandBuffer.readbackTextureToBuffer(readbackBuffer, this.rowPitch, this.swapChain.texture(index), this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                    }
                }
                commandBuffer.textureBarrier(this.swapChain.texture(index), presentFrom, NriTextureState.Present);
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
                if (this.imgui) {
                    this.sample.destroyImgui();
                }
                for (const queuedFrame of this.queuedFrames) {
                    this.destroyDescriptor(queuedFrame.uboView);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                for (const pipeline of this.pipelines) {
                    pipeline.destroy();
                }
                const layout = this.layout;
                if (layout) {
                    layout.destroy();
                }
                for (const view of this.textureViews) {
                    view.destroy();
                }
                for (const texture of this.textures) {
                    texture.destroy();
                }
                this.destroyTargets();
                const resolvePipeline = this.resolvePipeline;
                if (resolvePipeline) {
                    resolvePipeline.destroy();
                }
                const resolveLayout = this.resolveLayout;
                if (resolveLayout) {
                    resolveLayout.destroy();
                }
                this.destroyDescriptor(this.sampler);
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.uniformBuffer);
                this.destroyBuffer(this.readbackBuffer);
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
        const multisample = new DynamicMultisampleRasterization(sample);
        // -samples <count>: the initial sample count (when supported); -noUI: no overlay.
        sample.addExampleOptionWithValues("-samples", 1);
        sample.addExampleOption("-noUI");
        sample.useImgui();
        sample.useResizableWindow();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-samples" && i + 1 < argc) {
                i++;
                multisample.requestedSampleCount = parseInt(Nri.getArg(argc, argv, i));
            } else if (arg == "-noUI") {
                multisample.noUI = true;
            }
        }
        return multisample.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return DynamicMultisampleRasterizationNri.main(argc, argv);
}

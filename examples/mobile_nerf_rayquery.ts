// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";
import { radians, perspective, inverseGaussJordan } from "../core/matrix";
import { MlpReader, MobileNerfCamera } from "../core/mobile_nerf_common";

namespace MobileNerfRayQuery {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame. The corners are the dark clear color; the NeRF meshes, found by
    // ray queries, cover about 42% of the frame.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        const corners = check.corners(0x070707);
        if (corners != "") {
            return corners;
        }
        return check.share(check.countOtherThan(0x070707, 0, 0, check.width, check.height), total,
            32.0, 52.0, "Meshes");
    }

    const WINDOW_TITLE = "Donut Example: Mobile NeRF Ray Query";

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

    // Donut_LoadGltfModel's vertices: float3 position, float3 normal, float2 texture coordinates.
    const GLTF_VERTEX_FLOATS = 8;
    // The sample's Vertex: float3 position, float2 texture coordinates.
    const VERTEX_FLOATS = 5;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;

    // struct GlobalUniform { float4x4 view_inverse, proj_inverse; float2 img_dim; float
    // tan_half_fov; } padded, then float4 model_offsets[4] (first vertex, first index: exact as floats).
    const UBO_VIEW_INVERSE = 0;
    const UBO_PROJ_INVERSE = 16;
    const UBO_IMG_DIM = 32;
    const UBO_TAN_HALF_FOV = 34;
    const UBO_MODEL_OFFSETS = 36;
    const UBO_FLOATS = 52;

    // The MLP: three layers' weights (the third's padded from 48 to 64, a zero after every 3), then
    // their biases (the third's padded from 3 to 4).
    const WEIGHTS_0_COUNT = 176;
    const WEIGHTS_1_COUNT = 256;
    const WEIGHTS_2_COUNT = 64;
    const BIAS_0_COUNT = 16;
    const BIAS_1_COUNT = 16;
    const BIAS_2_COUNT = 4;
    const MLP_FLOATS = WEIGHTS_0_COUNT + WEIGHTS_1_COUNT + WEIGHTS_2_COUNT + BIAS_0_COUNT + BIAS_1_COUNT + BIAS_2_COUNT;

    // nvrhi::rt::InstanceFlags::TriangleCullDisable.
    const INSTANCE_FLAGS_CULL_DISABLE = 1;

    // --- mlp.json -----------------------------------------------------------------------------

    // The sample's initialize_mlp_uniform_buffers: the layers' weights and biases, padded, appended
    // to dst.
    function loadMlp(app: App, path: string, dst: f32[]) {
        const file = app.loadBinaryFile(path);
        const reader = new MlpReader();
        if (file.isNull() || !reader.read(file)) {
            return false;
        }
        app.releaseObject(file.handle);
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

    // --- Math (glm's layout: 4 x 4 matrices by columns) ---------------------------------------

    // --- Pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' mobile_nerf_rayquery (after Google's MobileNeRF): mobile_nerf's
    // neural radiance fields (see mobile_nerf.ts), found by ray queries instead of rasterization.
    // A triangle over the screen; each pixel traces its ray inline through a TLAS of the NeRF
    // meshes (one BLAS per model, 2 x 2 x 2 instances of each, the instance's custom index the
    // model's), reads the hit's texture coordinates from the model's vertices and runs its feature
    // textures through the model's MLP. Missed pixels keep the clear color.
    class MobileNerfRayQueryPass {
        private app: App;
        private camera: MobileNerfCamera;

        private vs: ShaderHandle;
        private ps: ShaderHandle;
        private bindingLayout: BindingLayoutHandle;
        private bindingSet: BindingSet;
        private globalBuffer: BufferHandle;
        private weightsBuffer: BufferHandle;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        private blases: TriangleBlas[];
        private topLevelAS: SceneAccelStructs;
        private topLevelASBuilt: boolean;
        // The models' MLPs, one after the other, and their first vertex and index.
        private weights: f32[];
        private modelOffsets: int[];

        // A framebuffer per back buffer, for the back buffers' size, and the pipeline made for them.
        private framebuffers: FramebufferHandle[];
        private targetWidth: int;
        private targetHeight: int;
        private pipeline: GraphicsPipelineHandle;
        private pipelineCreated: boolean;

        // Upload buffers.
        private ubo: f32[];
        private transform: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new MobileNerfCamera();
            this.camera.setLookAt([CAMERA_POSITION[0], -CAMERA_POSITION[1], CAMERA_POSITION[2]], [0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0]);
            this.blases = [];
            this.topLevelASBuilt = false;
            this.weights = [];
            this.modelOffsets = [];
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.pipelineCreated = false;
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
            this.transform = [];
            for (let i = 0; i < 12; i++) {
                this.transform.push(0.0);
            }
        }

        init() {
            const shader = "mobile_nerf_rayquery.hlsl";
            this.vs = this.app.createShader(shader, "quad_vs", ShaderType.Vertex);
            this.ps = this.app.createShader(shader, "rayquery_ps", ShaderType.Pixel);
            if (!this.vs || !this.ps) {
                return false;
            }

            for (const modelName of MODELS) {
                if (!loadMlp(this.app, MEDIA_DIR + modelName + "/mlp.json", this.weights)) {
                    console.log("Cannot load the NeRF models: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                    return false;
                }
            }

            const commandList = this.app.createCommandList();
            commandList.open();
            let loaded = this.loadModels(commandList);
            const features0: TextureHandle[] = [];
            const features1: TextureHandle[] = [];
            for (let m = 0; m < MODELS.length && loaded; m++) {
                const dir = MEDIA_DIR + MODELS[m] + "/";
                const feature0 = this.app.loadTexture(commandList, dir + "shape0.pngfeat0.png", 0);
                const feature1 = this.app.loadTexture(commandList, dir + "shape0.pngfeat1.png", 0);
                if (!feature0 || !feature1) {
                    loaded = false;
                    break;
                }
                features0.push(feature0);
                features1.push(feature1);
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded) {
                console.log("Cannot load the NeRF models: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            this.topLevelAS = this.app.createTopLevelAS(MODELS.length * INSTANCE_DIM[0] * INSTANCE_DIM[1] * INSTANCE_DIM[2]);

            for (let m = 0; m < MODELS.length; m++) {
                const k = UBO_MODEL_OFFSETS + m * 4;
                this.ubo[k] = this.modelOffsets[m * 2];
                this.ubo[k + 1] = this.modelOffsets[m * 2 + 1];
            }

            // Feature textures: linear (UNORM), filtered bilinearly at their first level only (the
            // framework uploads PNGs without mip maps), clamped.
            const sampler = this.app.createSamplerWithDesc(1, 1, 0, SamplerAddressMode.Clamp, 0.0, 0.0, 0.0, 1.0);
            this.globalBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "GlobalUniform");
            this.weightsBuffer = this.app.createVolatileConstantBuffer(this.weights.length * 4, "MLP weights");
            const layout = BindingLayoutDesc.create();
            layout.layoutVolatileConstantBuffer(0);
            layout.layoutVolatileConstantBuffer(1);
            layout.layoutAccelStruct(0);
            layout.layoutStructuredBufferSRV(1);
            layout.layoutStructuredBufferSRV(2);
            layout.layoutTextureSRVArray(3, MODELS.length);
            layout.layoutTextureSRVArray(7, MODELS.length);
            layout.layoutSampler(0);
            this.bindingLayout = this.app.createBindingLayout(layout, ShaderType.All);

            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.globalBuffer);
            setDesc.bindEntireConstantBuffer(1, this.weightsBuffer);
            setDesc.bindAccelStruct(0, this.topLevelAS.getTopLevelAS());
            setDesc.bindStructuredBufferSRV(1, this.vertexBuffer);
            setDesc.bindStructuredBufferSRV(2, this.indexBuffer);
            for (let m = 0; m < MODELS.length; m++) {
                setDesc.bindTextureSRVArrayElement(3, m, features0[m]);
                setDesc.bindTextureSRVArrayElement(7, m, features1[m]);
            }
            setDesc.bindSampler(0, sampler);
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);

            const pass = this.app.addPass();
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        onMousePos(x: number, y: number) {
            this.camera.mouseMove(x, y);
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int) {
            this.camera.mouseButton(button, action);
            return 1;
        }

        onAnimate(elapsedSeconds: number) {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        // The framebuffers of the back buffers go before the back buffers do.
        onBackBufferResizing() {
            this.releaseTargets();
        }

        releaseTargets() {
            for (const framebuffer of this.framebuffers) {
                this.app.releaseResource(framebuffer);
            }
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
        }

        createTargets(width: int, height: int) {
            this.releaseTargets();
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), null));
            }
            // The sample's pipeline draws a triangle over the screen: no culling, nothing blended
            // (its depth test passes everywhere, the triangle's depth being 0).
            if (!this.pipelineCreated) {
                const desc = GraphicsPipelineDesc.create(this.vs, this.ps);
                desc.addBindingLayout(this.bindingLayout);
                desc.setDepthState(0, 0, ComparisonFunc.Always);
                desc.setRasterState(CullMode.None, FillMode.Solid, 1);
                this.pipeline = this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]);
                this.pipelineCreated = true;
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        // The sample's create_top_level_acceleration_structure: each model in each place of the
        // instancing grid, its custom index the model's (for its buffers, textures and weights).
        buildTopLevelAS(frame: Frame) {
            const tlas = this.topLevelAS;
            const offset = [0.0, 0.0, 0.0];
            for (let x = 0; x < INSTANCE_DIM[0]; x++) {
                offset[0] = -INSTANCE_INTERVAL[0] * 0.5 * (INSTANCE_DIM[0] - 1) + INSTANCE_INTERVAL[0] * x;
                for (let y = 0; y < INSTANCE_DIM[1]; y++) {
                    offset[1] = -INSTANCE_INTERVAL[1] * 0.5 * (INSTANCE_DIM[1] - 1) + INSTANCE_INTERVAL[1] * y;
                    for (let z = 0; z < INSTANCE_DIM[2]; z++) {
                        offset[2] = -INSTANCE_INTERVAL[2] * 0.5 * (INSTANCE_DIM[2] - 1) + INSTANCE_INTERVAL[2] * z;
                        // Rows of a 3 x 4 matrix: identity, translated.
                        for (let i = 0; i < 12; i++) {
                            this.transform[i] = i % 5 == 0 ? 1.0 : 0.0;
                        }
                        this.transform[3] = offset[0];
                        this.transform[7] = offset[1];
                        this.transform[11] = offset[2];
                        for (let m = 0; m < this.blases.length; m++) {
                            tlas.addInstanceWithTransform(this.blases[m].getAccelStruct(), 0xFF, m, INSTANCE_FLAGS_CULL_DISABLE,
                                Ref(this.transform[0]));
                        }
                    }
                }
            }
            frame.buildTopLevelAS(tlas);
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            if (!this.topLevelASBuilt) {
                this.buildTopLevelAS(frame);
                this.topLevelASBuilt = true;
            }

            // The sample's update_uniform_buffer: the inverses of its view and projection (glm's,
            // no y flip: the shader takes SV_Position's y as the sample's gl_FragCoord's).
            const viewInverse = inverseGaussJordan(this.camera.view());
            const projInverse = inverseGaussJordan(perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR));
            const u = this.ubo;
            for (let i = 0; i < 16; i++) {
                u[UBO_VIEW_INVERSE + i] = viewInverse[i];
                u[UBO_PROJ_INVERSE + i] = projInverse[i];
            }
            u[UBO_IMG_DIM] = width;
            u[UBO_IMG_DIM + 1] = height;
            u[UBO_TAN_HALF_FOV] = Math.tan(0.5 * radians(CAMERA_FOV));
            commandList.writeBuffer(this.globalBuffer, Ref(u[0]), UBO_FLOATS * 4);
            commandList.writeBuffer(this.weightsBuffer, Ref(this.weights[0]), this.weights.length * 4);

            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
            frame.beginDrawToFramebuffer(this.pipeline, this.framebuffers[index]);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawVertices(3);
        }

        // The sample's load_scene, create_static_object_buffers and
        // create_bottom_level_acceleration_structure for every model: its meshes' vertices (y
        // flipped, v flipped) and triangles, appended to one vertex and one index buffer, and a BLAS
        // of them with the model's combo transform (y negated, as the sample's vertices are).
        loadModels(commandList: CommandList) {
            const vertices: f32[] = [];
            const indices: int[] = [];
            const firstVertices: int[] = [];
            const firstIndices: int[] = [];
            const counts: int[] = [];
            for (const modelName of MODELS) {
                const path = MEDIA_DIR + modelName + "/shape0.gltf";
                const scene = this.app.loadGltfModel(path);
                if (scene.isNull()) {
                    return false;
                }
                const firstVertex = vertices.length / VERTEX_FLOATS;
                const firstIndex = indices.length;
                for (let p = 0; p < scene.getPrimitiveCount(); p++) {
                    const vertexStart = vertices.length / VERTEX_FLOATS - firstVertex;
                    const vertexCount = scene.getVertexCount(p);
                    const indexCount = scene.getIndexCount(p);
                    const gltfVertices: f32[] = [];
                    for (let i = 0; i < vertexCount * GLTF_VERTEX_FLOATS; i++) {
                        gltfVertices.push(0.0);
                    }
                    const gltfIndices: int[] = [];
                    for (let i = 0; i < indexCount; i++) {
                        gltfIndices.push(0);
                    }
                    scene.copyVertices(p, Ref(gltfVertices[0]));
                    scene.copyIndices(p, Ref(gltfIndices[0]));
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
                this.app.releaseObject(scene.handle);
                firstVertices.push(firstVertex);
                firstIndices.push(firstIndex);
                counts.push(vertices.length / VERTEX_FLOATS - firstVertex);
                counts.push(indices.length - firstIndex);
                this.modelOffsets.push(firstVertex);
                this.modelOffsets.push(firstIndex);
            }

            const vertexCount = vertices.length / VERTEX_FLOATS;
            this.vertexBuffer = this.app.createAccelStructInputStructuredBuffer(4, vertexCount * VERTEX_FLOATS, "Vertices");
            this.indexBuffer = this.app.createAccelStructInputStructuredBuffer(4, indices.length, "Indices");
            commandList.writeBuffer(this.vertexBuffer, Ref(vertices[0]), vertexCount * VERTEX_SIZE);
            commandList.writeBuffer(this.indexBuffer, Ref(indices[0]), indices.length * 4);

            const geometryTransform: f32[] = [];
            for (let i = 0; i < 12; i++) {
                geometryTransform.push(i % 5 == 0 ? 1.0 : 0.0);
            }
            for (let m = 0; m < MODELS.length; m++) {
                geometryTransform[3] = COMBO_TRANSLATIONS[m * 3];
                geometryTransform[7] = -COMBO_TRANSLATIONS[m * 3 + 1];
                geometryTransform[11] = COMBO_TRANSLATIONS[m * 3 + 2];
                const blas = this.app.createEmptyTriangleBlas(`Model #${m} BLAS`);
                blas.addGeometry(this.indexBuffer, firstIndices[m] * 4, counts[m * 2 + 1], this.vertexBuffer,
                    firstVertices[m] * VERTEX_SIZE, counts[m * 2], VERTEX_SIZE, Ref(geometryTransform[0]));
                if (blas.build(this.app, commandList, AccelStructBuildFlags.PreferFastTrace) == 0) {
                    return false;
                }
                this.blases.push(blas);
            }
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("mobile_nerf_rayquery");

        const args = new Args(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, AppOptions.RayTracing | args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.RayQuery)) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support Ray Queries");
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new MobileNerfRayQueryPass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(checkFrame(app));
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return MobileNerfRayQuery.main(argc, argv);
}

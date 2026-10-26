// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck } from "../core/test_check";
import { identity, radians, perspective } from "../core/matrix";
import { MlpReader, MobileNerfCamera } from "../core/mobile_nerf_common";

namespace MobileNerf {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame: the NeRF scenes' meshes (their features decoded by the MLP in
    // the shader) light about 43% of it, about 3.5% colored.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        const lit = check.share(total - check.countInRange(0, 20, 0, 20, 0, 20, 0, 0, check.width, check.height), total,
            30.0, 55.0, "Lit");
        if (lit != "") {
            return lit;
        }
        return check.share(check.countSpread(61, false, 0, 0, 0, check.width, check.height), total,
            1.5, 7.0, "Colored");
    }

    const WINDOW_TITLE = "Donut Example: Mobile NeRF";

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
    // Its camera position (y flipped by the sample), looking at the origin.
    const CAMERA_POSITION = [-0.0381453, 1.84186, -1.51744];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 0.01;
    const Z_FAR = 256.0;

    // Donut_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // struct GlobalUniform { float4x4 model, view, proj; float3 camera_position, camera_side,
    // camera_up, camera_lookat (each in 16 bytes); float2 img_dim; float tan_half_fov; }, padded.
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

    // The MLP: three layers' weights (the third's padded from 48 to 64, a zero after every 3), then
    // their biases (the third's padded from 3 to 4).
    const WEIGHTS_0_COUNT = 176;
    const WEIGHTS_1_COUNT = 256;
    const WEIGHTS_2_COUNT = 64;
    const BIAS_0_COUNT = 16;
    const BIAS_1_COUNT = 16;
    const BIAS_2_COUNT = 4;
    const MLP_FLOATS = WEIGHTS_0_COUNT + WEIGHTS_1_COUNT + WEIGHTS_2_COUNT + BIAS_0_COUNT + BIAS_1_COUNT + BIAS_2_COUNT;

    // --- mlp.json -----------------------------------------------------------------------------

    // The sample's initialize_mlp_uniform_buffers: the layers' weights and biases, padded.
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
        for (let i = 0; i < MLP_FLOATS; i++) {
            dst.push(0.0);
        }
        let o = 0;
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

    // --- Pass -------------------------------------------------------------------------------

    // One NeRF: its mesh (Donut_LoadGltfMesh: the framework's loader also ignores the nodes), its
    // feature textures and MLP, and the binding set for them.
    class NerfModel {
        mesh: GltfMesh;
        weights: f32[];
        weightsBuffer: BufferHandle;
        bindingSet: BindingSet;

        constructor(mesh: GltfMesh, weights: f32[]) {
            this.mesh = mesh;
            this.weights = weights;
        }
    }

    // Port of Vulkan-Samples' mobile_nerf (after Google's MobileNeRF): neural radiance fields baked
    // into textured meshes. Each mesh is rasterized with two feature textures (8 channels per
    // pixel); its pixel shader runs them and the view direction through the model's small MLP
    // (11 inputs, two hidden layers of 16) for the color. As the sample by default: forward
    // rendering (the MLP in the mesh's own pass), four Lego models side by side, each instanced 2 x
    // 2 x 2 times.
    class MobileNerfPass {
        private app: App;
        private camera: MobileNerfCamera;

        private vs: ShaderHandle;
        private ps: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private bindingLayout: BindingLayoutHandle;
        private globalBuffer: BufferHandle;
        private instanceBuffer: BufferHandle;
        private instanceCount: int;
        private models: NerfModel[];

        // The depth buffer and a framebuffer per back buffer, for the back buffers' size, and the
        // pipeline made for them.
        private depth: TextureHandle;
        private framebuffers: FramebufferHandle[];
        private targetWidth: int;
        private targetHeight: int;
        private pipeline: GraphicsPipelineHandle;
        private pipelineCreated: boolean;

        // Upload buffer.
        private ubo: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new MobileNerfCamera();
            this.camera.setLookAt([CAMERA_POSITION[0], -CAMERA_POSITION[1], CAMERA_POSITION[2]], [0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0]);
            this.models = [];
            this.instanceCount = 0;
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.pipelineCreated = false;
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
        }

        init() {
            const shader = "mobile_nerf.hlsl";
            this.vs = this.app.createShader(shader, "raster_vs", ShaderType.Vertex);
            this.ps = this.app.createShader(shader, "merged_ps", ShaderType.Pixel);
            if (!this.vs || !this.ps) {
                return false;
            }

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_SIZE);
            layoutDesc.addInstanceVertexAttribute("INSTANCE_OFFSET", Format.RGB32_FLOAT, 0, 1, 12);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vs);

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

            // Feature textures: linear (UNORM), filtered bilinearly at their first level only (the
            // framework uploads PNGs without mip maps), clamped.
            const sampler = this.app.createSamplerWithDesc(1, 1, 0, SamplerAddressMode.Clamp, 0.0, 0.0, 0.0, 1.0);
            this.globalBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "GlobalUniform");
            const layout = BindingLayoutDesc.create();
            layout.layoutVolatileConstantBuffer(0);
            layout.layoutVolatileConstantBuffer(1);
            layout.layoutTextureSRV(0);
            layout.layoutTextureSRV(1);
            layout.layoutSampler(0);
            this.bindingLayout = this.app.createBindingLayout(layout, ShaderType.All);

            const commandList = this.app.createCommandList();
            commandList.open();
            this.instanceBuffer = this.app.createStaticVertexBuffer(commandList, Ref(offsets[0]), offsets.length * 4, "Instances");
            let loaded = true;
            for (let m = 0; m < MODELS.length && loaded; m++) {
                const dir = MEDIA_DIR + MODELS[m] + "/";
                const weights: f32[] = [];
                const mesh = this.app.loadGltfMesh(commandList, dir + "shape0.gltf");
                const feature0 = this.app.loadTexture(commandList, dir + "shape0.pngfeat0.png", 0);
                const feature1 = this.app.loadTexture(commandList, dir + "shape0.pngfeat1.png", 0);
                if (mesh.isNull() || !feature0 || !feature1 || !loadMlp(this.app, dir + "mlp.json", weights)) {
                    loaded = false;
                    break;
                }
                const model = new NerfModel(mesh, weights);
                model.weightsBuffer = this.app.createVolatileConstantBuffer(MLP_FLOATS * 4, `MLP ${m}`);
                const setDesc = BindingSetDesc.create();
                setDesc.bindEntireConstantBuffer(0, this.globalBuffer);
                setDesc.bindEntireConstantBuffer(1, model.weightsBuffer);
                setDesc.bindTextureSRV(0, feature0);
                setDesc.bindTextureSRV(1, feature1);
                setDesc.bindSampler(0, sampler);
                model.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);
                this.models.push(model);
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded) {
                console.log("Cannot load the NeRF models: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

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

        onMouseButton(button: MouseButton, action: Action, mods: KeyMods) {
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
            if (this.framebuffers.length > 0) {
                this.app.releaseResource(this.depth);
            }
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
        }

        createTargets(width: int, height: int) {
            this.releaseTargets();
            this.depth = this.app.createDepthTexture(width, height, Format.D32, 1.0, "Depth");
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), this.depth));
            }
            // The sample's pipeline: depth tested (less) and written, no culling, no blending.
            if (!this.pipelineCreated) {
                const desc = GraphicsPipelineDesc.create(this.vs, this.ps);
                desc.setInputLayout(this.inputLayout);
                desc.addBindingLayout(this.bindingLayout);
                desc.setDepthState(1, 1, ComparisonFunc.Less);
                desc.setRasterState(CullMode.None, FillMode.Solid, 1);
                this.pipeline = this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]);
                this.pipelineCreated = true;
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            // The sample's update_uniform_buffers: its projection (clip y negated for Donut), view,
            // camera position (the view's translation, as the framework keeps it) and axes.
            const projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
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
            u[UBO_IMG_DIM] = width;
            u[UBO_IMG_DIM + 1] = height;
            u[UBO_TAN_HALF_FOV] = Math.tan(0.5 * radians(CAMERA_FOV));

            // The render pass: color cleared to black, depth to 1.
            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), 0.0, 0.0, 0.0, 1.0);
            commandList.clearDepth(this.depth, 1.0);
            const framebuffer = this.framebuffers[index];

            // Each model, with its transform and MLP, instanced.
            for (let m = 0; m < this.models.length; m++) {
                const model = this.models[m];
                const transform = identity();
                transform[12] = COMBO_TRANSLATIONS[m * 3];
                transform[13] = COMBO_TRANSLATIONS[m * 3 + 1];
                transform[14] = COMBO_TRANSLATIONS[m * 3 + 2];
                for (let i = 0; i < 16; i++) {
                    u[UBO_MODEL + i] = transform[i];
                }
                commandList.writeBuffer(this.globalBuffer, Ref(u[0]), UBO_FLOATS * 4);
                commandList.writeBuffer(model.weightsBuffer, Ref(model.weights[0]), MLP_FLOATS * 4);

                frame.beginDrawToFramebuffer(this.pipeline, framebuffer);
                frame.drawAddBindingSet(model.bindingSet);
                frame.drawSetIndexBuffer(model.mesh.getIndexBuffer());
                frame.drawAddVertexBuffer(model.mesh.getVertexBuffer(), 0, 0);
                frame.drawAddVertexBuffer(this.instanceBuffer, 1, 0);
                frame.drawIndexedInstanced(model.mesh.getIndexCount(), this.instanceCount);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Program.setAppName("mobile_nerf");

        const args = new Args(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new MobileNerfPass(app);
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
    return MobileNerf.main(argc, argv);
}

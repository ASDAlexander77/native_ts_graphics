// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck } from "../core/test_check";
import { inverseRigid, radians, perspective } from "../core/matrix";
import { LookAtCamera } from "../core/vulkan_samples_camera";

namespace DynamicRendering {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame: the street skybox fills it (about 97% lit), the reflective
    // sphere's highlights and the sky about 3% white.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        const lit = check.share(total - check.countInRange(0, 20, 0, 20, 0, 20, 0, 0, check.width, check.height), total,
            90.0, 100.0, "Lit");
        if (lit != "") {
            return lit;
        }
        return check.share(check.countInRange(221, 255, 221, 255, 221, 255, 0, 0, check.width, check.height), total,
            1.0, 6.0, "White");
    }

    const WINDOW_TITLE = "Donut Example: Dynamic Rendering";

    // The sample's models and HDR cube map (Vulkan-Samples' assets, hdr's copies: the KTX cube map
    // converted to DDS at build time, see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const CUBE_PATH = "media/hdr/cube.gltf";
    const OBJECT_PATH = "media/hdr/geosphere.gltf";
    const ENVMAP_PATH = "media/hdr/uffizi_rgba16f_cube.dds";

    // Donut_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;
    const NORMAL_OFFSET = 12;

    // struct UBO { float4x4 projection, modelview, skybox_modelview, inverse_modelview; float
    // modelscale; }, padded.
    const UBO_PROJECTION = 0;
    const UBO_MODELVIEW = 16;
    const UBO_SKYBOX_MODELVIEW = 32;
    const UBO_INVERSE_MODELVIEW = 48;
    const UBO_MODELSCALE = 64;
    const UBO_FLOATS = 68;
    const MODEL_SCALE = 0.05;

    // The sample's look-at camera at (0, 0, -4) (vkb::Camera's position, the view's translation),
    // turned 180 degrees around y; reversed depth from 0.1 to 256.
    const CAMERA_POSITION = [0.0, 0.0, -4.0];
    const CAMERA_ROTATION = [0.0, 180.0, 0.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // --- Pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' dynamic_rendering: hdr's skybox and a reflective geosphere (its
    // shaders are vertex_dynamic_state's). The sample renders with VK_KHR_dynamic_rendering (no
    // render pass or framebuffer objects; its UI switch picks it over a render pass); NVRHI's
    // Vulkan backend always renders that way, D3D has no render pass objects either: here it's an
    // ordinary draw into the back buffer.
    class DynamicRenderingPass {
        private app: App;
        private camera: LookAtCamera;

        private skyboxVS: ShaderHandle;
        private skyboxPS: ShaderHandle;
        private objectVS: ShaderHandle;
        private objectPS: ShaderHandle;
        private gltfLayout: InputLayoutHandle;
        private bindingLayout: BindingLayoutHandle;
        private bindingSet: BindingSet;
        private uniformBuffer: BufferHandle;
        private skybox: GltfMesh;
        private object: GltfMesh;

        // The depth buffer and a framebuffer per back buffer, for the back buffers' size, and the
        // pipelines made for them: the skybox's and the object's.
        private depth: TextureHandle;
        private framebuffers: FramebufferHandle[];
        private targetWidth: int;
        private targetHeight: int;
        private skyboxPipeline: GraphicsPipelineHandle;
        private modelPipeline: GraphicsPipelineHandle;
        private pipelinesCreated: boolean;

        // Upload buffer.
        private ubo: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new LookAtCamera(CAMERA_POSITION, CAMERA_ROTATION);
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.pipelinesCreated = false;
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
        }

        init() {
            const shader = "vertex_dynamic_state.hlsl";
            this.skyboxVS = this.app.createShaderWithDefine(shader, "gbuffer_vs", ShaderType.Vertex, "TYPE", "0");
            this.skyboxPS = this.app.createShaderWithDefine(shader, "gbuffer_ps", ShaderType.Pixel, "TYPE", "0");
            this.objectVS = this.app.createShaderWithDefine(shader, "gbuffer_vs", ShaderType.Vertex, "TYPE", "1");
            this.objectPS = this.app.createShaderWithDefine(shader, "gbuffer_ps", ShaderType.Pixel, "TYPE", "1");
            if (!this.skyboxVS || !this.skyboxPS || !this.objectVS || !this.objectPS) {
                return false;
            }

            // The vertex layout: position and normal.
            const gltfLayoutDesc = InputLayoutDesc.create();
            gltfLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            gltfLayoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, NORMAL_OFFSET, 0, VERTEX_SIZE);
            this.gltfLayout = this.app.createInputLayout(gltfLayoutDesc, this.skyboxVS);

            // The cube map's sampler, as the framework's load_texture_cubemap: trilinear, clamped,
            // the device's widest anisotropic filtering.
            const sampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Clamp, 0.0, 0.0, 1000.0,
                this.app.getMaxSamplerAnisotropy());

            const commandList = this.app.createCommandList();
            commandList.open();
            this.skybox = this.app.loadGltfMesh(commandList, CUBE_PATH);
            this.object = this.app.loadGltfMesh(commandList, OBJECT_PATH);
            const envmap = this.app.loadTexture(commandList, ENVMAP_PATH, 0);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (this.skybox.isNull() || this.object.isNull() || !envmap) {
                console.log("Cannot load the models and the cube map: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            this.uniformBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "UBO");
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutVolatileConstantBuffer(0);
            layoutDesc.layoutTextureSRV(0);
            layoutDesc.layoutSampler(0);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);
            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.uniformBuffer);
            setDesc.bindTextureSRV(0, envmap);
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

        // The sample's prepare_pipelines: the skybox without depth, back faces culled
        // (counter-clockwise front faces); the object with depth tested (greater: reversed) and
        // written, front faces culled.
        createPipeline(vs: ShaderHandle, ps: ShaderHandle, inputLayout: InputLayoutHandle, isObject: boolean) {
            const desc = GraphicsPipelineDesc.create(vs, ps);
            desc.setInputLayout(inputLayout);
            desc.addBindingLayout(this.bindingLayout);
            desc.setDepthState(isObject ? 1 : 0, isObject ? 1 : 0, ComparisonFunc.Greater);
            desc.setRasterState(isObject ? CullMode.Front : CullMode.Back, FillMode.Solid, 1);
            return this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]);
        }

        createTargets(width: int, height: int) {
            this.releaseTargets();
            this.depth = this.app.createDepthTexture(width, height, Format.D32, 0.0, "Depth");
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), this.depth));
            }
            if (!this.pipelinesCreated) {
                this.skyboxPipeline = this.createPipeline(this.skyboxVS, this.skyboxPS, this.gltfLayout, false);
                this.modelPipeline = this.createPipeline(this.objectVS, this.objectPS, this.gltfLayout, true);
                this.pipelinesCreated = true;
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        draw(frame: Frame, pipeline: GraphicsPipelineHandle, framebuffer: FramebufferHandle, vertexBuffer: BufferHandle, indexBuffer: BufferHandle, indexCount: int) {
            frame.beginDrawToFramebuffer(pipeline, framebuffer);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawSetIndexBuffer(indexBuffer);
            frame.drawAddVertexBuffer(vertexBuffer, 0, 0);
            frame.drawIndexed(indexCount);
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            // The sample's update_uniform_buffers: its projection (clip y negated for Donut), the
            // view (the object at the origin), its inverse.
            const projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            const inverseView = inverseRigid(view);
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.ubo[UBO_MODELVIEW + i] = view[i];
                this.ubo[UBO_SKYBOX_MODELVIEW + i] = view[i];
                this.ubo[UBO_INVERSE_MODELVIEW + i] = inverseView[i];
            }
            this.ubo[UBO_MODELSCALE] = MODEL_SCALE;
            commandList.writeBuffer(this.uniformBuffer, Ref(this.ubo[0]), UBO_FLOATS * 4);

            // The render pass: color cleared to transparent black, depth to 0 (reversed).
            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), 0.0, 0.0, 0.0, 0.0);
            commandList.clearDepth(this.depth, 0.0);
            const framebuffer = this.framebuffers[index];

            // The skybox, the object.
            this.draw(frame, this.skyboxPipeline, framebuffer, this.skybox.getVertexBuffer(), this.skybox.getIndexBuffer(),
                this.skybox.getIndexCount());
            this.draw(frame, this.modelPipeline, framebuffer, this.object.getVertexBuffer(), this.object.getIndexBuffer(),
                this.object.getIndexCount());
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Program.setAppName("dynamic_rendering");

        const args = new Args(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new DynamicRenderingPass(app);
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
    return DynamicRendering.main(argc, argv);
}

// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck } from "../core/test_check";
import { identity, radians, perspective } from "../core/matrix";
import { FirstPersonCamera } from "../core/vulkan_samples_camera";

namespace DynamicRenderingLocalRead {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame (the lights seeded with 0, as under -benchmark): the room lit by
    // the deferred lights (about 66% of the frame), its colored glass about 16%, blue about 3%
    // (6.7% on Android's emulator).
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        const lit = check.share(total - check.countInRange(0, 20, 0, 20, 0, 20, 0, 0, check.width, check.height), total,
            55.0, 80.0, "Lit");
        if (lit != "") {
            return lit;
        }
        const colored = check.share(check.countSpread(61, false, 0, 0, 0, check.width, check.height), total,
            10.0, 25.0, "Colored");
        if (colored != "") {
            return colored;
        }
        return check.share(check.countInRange(0, 89, 0, 119, 121, 255, 0, 0, check.width, check.height), total,
            1.5, 8.0, "Blue glass");
    }

    const WINDOW_TITLE = "Donut Example: Dynamic Rendering Local Read";

    // The sample's scenes and glass texture (Vulkan-Samples' assets, copied at build time, the KTX
    // texture converted to DDS: see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const MEDIA_DIR = "media/dynamic_rendering_local_read/";
    const OPAQUE_SCENE_PATH = MEDIA_DIR + "subpass_scene_opaque.gltf";
    const TRANSPARENT_SCENE_PATH = MEDIA_DIR + "subpass_scene_transparent.gltf";
    const GLASS_TEXTURE_PATH = MEDIA_DIR + "transparent_glass_rgba.dds";

    // Donut_LoadGltfModel's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_FLOATS = 8;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;

    // struct UBO { float4x4 projection, model, view; }.
    const UBO_PROJECTION = 0;
    const UBO_MODEL = 16;
    const UBO_VIEW = 32;
    const UBO_FLOATS = 48;
    // The push constants: float4x4 matrix; float4 color.
    const PUSH_FLOATS = 20;
    const PUSH_SIZE = PUSH_FLOATS * 4;
    // struct Light { float4 position; float3 color; float radius; }, 64 of them.
    const LIGHT_FLOATS = 8;
    const LIGHT_COUNT = 64;
    const LIGHT_RANGE = [8.0, 0.6, 8.0];

    // The sample's first person camera at (-3.2, 1, 5.9) (vkb::Camera's position, the view's
    // translation), turned 0.5 degrees around x and 210.05 around y; reversed depth from 0.1 to
    // 256.
    const CAMERA_POSITION = [-3.2, 1.0, 5.9];
    const CAMERA_ROTATION = [0.5, 210.05, 0.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // A scene's draws, a node's primitive each, in the framework's order (by mesh, node,
    // primitive): index range, base vertex, push constants (the node's world transform and the
    // material's base color factor).
    class Scene {
        vertexBuffer: BufferHandle;
        indexBuffer: BufferHandle;
        firstIndex: int[];
        indexCount: int[];
        baseVertex: int[];
        push: f32[];

        constructor() {
            this.firstIndex = [];
            this.indexCount = [];
            this.baseVertex = [];
            this.push = [];
        }

        load(app: App, commandList: CommandList, path: string) {
            const model = app.loadGltfModel(path);
            if (model.isNull()) {
                return false;
            }
            const primitiveCount = model.getPrimitiveCount();
            const vertices: f32[] = [];
            const indices: int[] = [];
            const firstIndex: int[] = [];
            const baseVertex: int[] = [];
            let meshCount: int = 0;
            for (let p = 0; p < primitiveCount; p++) {
                const vertexCount = model.getVertexCount(p);
                const indexCount = model.getIndexCount(p);
                const primitiveVertices: f32[] = [];
                for (let i = 0; i < vertexCount * VERTEX_FLOATS; i++) {
                    primitiveVertices.push(0.0);
                }
                const primitiveIndices: int[] = [];
                for (let i = 0; i < indexCount; i++) {
                    primitiveIndices.push(0);
                }
                model.copyVertices(p, Ref(primitiveVertices[0]));
                model.copyIndices(p, Ref(primitiveIndices[0]));
                baseVertex.push(vertices.length / VERTEX_FLOATS);
                firstIndex.push(indices.length);
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v++) {
                    vertices.push(primitiveVertices[v]);
                }
                for (let i = 0; i < indexCount; i++) {
                    indices.push(primitiveIndices[i]);
                }
                meshCount = Math.max(meshCount, model.getPrimitiveMesh(p) + 1);
            }

            const transform: f32[] = [];
            for (let i = 0; i < 16; i++) {
                transform.push(0.0);
            }
            const color: f32[] = [0.0, 0.0, 0.0, 0.0];
            const nodeCount = model.getNodeCount();
            for (let mesh = 0; mesh < meshCount; mesh++) {
                for (let node = 0; node < nodeCount; node++) {
                    if (model.getNodeMesh(node) != mesh) {
                        continue;
                    }
                    model.copyNodeTransform(node, Ref(transform[0]));
                    for (let p = 0; p < primitiveCount; p++) {
                        if (model.getPrimitiveMesh(p) != mesh) {
                            continue;
                        }
                        this.firstIndex.push(firstIndex[p]);
                        this.indexCount.push(model.getIndexCount(p));
                        this.baseVertex.push(baseVertex[p]);
                        model.copyBaseColorFactor(p, Ref(color[0]));
                        for (let i = 0; i < 16; i++) {
                            this.push.push(transform[i]);
                        }
                        for (let i = 0; i < 4; i++) {
                            this.push.push(color[i]);
                        }
                    }
                }
            }
            app.releaseObject(model.handle);

            this.vertexBuffer = app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Vertices");
            this.indexBuffer = app.createStaticIndexBuffer(commandList, Ref(indices[0]), indices.length * 4, "Indices");
            return true;
        }
    }

    // --- Pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' dynamic_rendering_local_read: deferred shading of a room lit by 64
    // random point lights, then glass drawn forward over it. The sample does it in one dynamic
    // render pass (VK_KHR_dynamic_rendering_local_read): the opaque scene into a G-buffer
    // (position and linear depth, normal, albedo), a barrier, the lights' composition reading the
    // G-buffer as input attachments in the same pass, the glass against the same depth. Reading a
    // render target in the pass that writes it isn't something NVRHI (or D3D) has: here the
    // G-buffer pass ends, and the composition and the glass are passes into the back buffer that
    // read the G-buffer as textures.
    class LocalReadPass {
        private app: App;
        private camera: FirstPersonCamera;

        private opaqueVS: ShaderHandle;
        private opaquePS: ShaderHandle;
        private compositionVS: ShaderHandle;
        private compositionPS: ShaderHandle;
        private transparentVS: ShaderHandle;
        private transparentPS: ShaderHandle;
        private opaqueInputLayout: InputLayoutHandle;
        private transparentInputLayout: InputLayoutHandle;
        private opaqueBindingLayout: BindingLayoutHandle;
        private compositionBindingLayout: BindingLayoutHandle;
        private transparentBindingLayout: BindingLayoutHandle;
        private opaqueBindingSet: BindingSet;
        private uniformBuffer: BufferHandle;
        private lightsBuffer: BufferHandle;
        private glassTexture: TextureHandle;
        private glassSampler: SamplerHandle;
        private opaqueScene: Scene;
        private transparentScene: Scene;
        // -benchmark: the lights' random engine seeded with 0 (the framework's
        // lock_simulation_speed), as vulkan_samples' --benchmark.
        benchmark: boolean;
        // The lights, rewritten when randomized.
        private lights: f32[];
        lightsDirty: boolean;

        // The G-buffer and depth, the framebuffers (the G-buffer's, and per back buffer with and
        // without the depth), the binding sets reading the G-buffer, for the back buffers' size;
        // the pipelines made for them.
        private resources: ResourceHandle[];
        private positionDepth: TextureHandle;
        private normal: TextureHandle;
        private albedo: TextureHandle;
        private depth: TextureHandle;
        private gbufferFramebuffer: FramebufferHandle;
        private compositionFramebuffers: FramebufferHandle[];
        private transparentFramebuffers: FramebufferHandle[];
        private compositionBindingSet: BindingSet;
        private transparentBindingSet: BindingSet;
        private targetWidth: int;
        private targetHeight: int;
        private opaquePipeline: GraphicsPipelineHandle;
        private compositionPipeline: GraphicsPipelineHandle;
        private transparentPipeline: GraphicsPipelineHandle;
        private pipelinesCreated: boolean;

        // Upload buffers.
        private ubo: f32[];
        private push: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new FirstPersonCamera(CAMERA_POSITION, CAMERA_ROTATION);
            this.opaqueScene = new Scene();
            this.transparentScene = new Scene();
            this.benchmark = false;
            this.lights = [];
            this.lightsDirty = true;
            this.resources = [];
            this.compositionFramebuffers = [];
            this.transparentFramebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.pipelinesCreated = false;
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
            this.push = [];
            for (let i = 0; i < PUSH_FLOATS; i++) {
                this.push.push(0.0);
            }
        }

        init() {
            const shader = "dynamic_rendering_local_read.hlsl";
            this.opaqueVS = this.app.createShader(shader, "opaque_vs", ShaderType.Vertex);
            this.opaquePS = this.app.createShader(shader, "opaque_ps", ShaderType.Pixel);
            this.compositionVS = this.app.createShader(shader, "composition_vs", ShaderType.Vertex);
            this.compositionPS = this.app.createShader(shader, "composition_ps", ShaderType.Pixel);
            this.transparentVS = this.app.createShader(shader, "transparent_vs", ShaderType.Vertex);
            this.transparentPS = this.app.createShader(shader, "transparent_ps", ShaderType.Pixel);
            if (!this.opaqueVS || !this.opaquePS || !this.compositionVS || !this.compositionPS || !this.transparentVS
                || !this.transparentPS) {
                return false;
            }

            // The opaque pipeline reads positions and normals, the transparent one positions and
            // texture coordinates.
            const opaqueLayoutDesc = InputLayoutDesc.create();
            opaqueLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            opaqueLayoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_SIZE);
            this.opaqueInputLayout = this.app.createInputLayout(opaqueLayoutDesc, this.opaqueVS);
            const transparentLayoutDesc = InputLayoutDesc.create();
            transparentLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            transparentLayoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_SIZE);
            this.transparentInputLayout = this.app.createInputLayout(transparentLayoutDesc, this.transparentVS);

            const commandList = this.app.createCommandList();
            commandList.open();
            const loaded = this.opaqueScene.load(this.app, commandList, OPAQUE_SCENE_PATH)
                && this.transparentScene.load(this.app, commandList, TRANSPARENT_SCENE_PATH);
            const glass = this.app.loadTexture(commandList, GLASS_TEXTURE_PATH, 1);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded || !glass) {
                console.log("Cannot load the scenes and the texture: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }
            this.glassTexture = glass;
            // The framework's load_texture sampler: trilinear, repeating, the device's widest
            // anisotropic filtering.
            this.glassSampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Wrap, 0.0, 0.0, 1000.0,
                this.app.getMaxSamplerAnisotropy());

            this.uniformBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "UBO");
            this.lightsBuffer = this.app.createStructuredBuffer(LIGHT_FLOATS * 4, LIGHT_COUNT, "Lights");
            this.randomizeLights();

            const opaqueLayoutDescB = BindingLayoutDesc.create();
            opaqueLayoutDescB.layoutVolatileConstantBuffer(0);
            opaqueLayoutDescB.layoutPushConstants(1, PUSH_SIZE);
            this.opaqueBindingLayout = this.app.createBindingLayout(opaqueLayoutDescB, ShaderType.All);
            const opaqueSetDesc = BindingSetDesc.create();
            opaqueSetDesc.bindEntireConstantBuffer(0, this.uniformBuffer);
            opaqueSetDesc.bindPushConstants(1, PUSH_SIZE);
            this.opaqueBindingSet = this.app.createBindingSetForLayout(opaqueSetDesc, this.opaqueBindingLayout);

            const compositionLayoutDesc = BindingLayoutDesc.create();
            compositionLayoutDesc.layoutTextureSRV(0);
            compositionLayoutDesc.layoutTextureSRV(1);
            compositionLayoutDesc.layoutTextureSRV(2);
            compositionLayoutDesc.layoutStructuredBufferSRV(3);
            this.compositionBindingLayout = this.app.createBindingLayout(compositionLayoutDesc, ShaderType.Pixel);

            const transparentLayoutDescB = BindingLayoutDesc.create();
            transparentLayoutDescB.layoutVolatileConstantBuffer(0);
            transparentLayoutDescB.layoutPushConstants(1, PUSH_SIZE);
            transparentLayoutDescB.layoutTextureSRV(0);
            transparentLayoutDescB.layoutTextureSRV(4);
            transparentLayoutDescB.layoutSampler(0);
            this.transparentBindingLayout = this.app.createBindingLayout(transparentLayoutDescB, ShaderType.All);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        onKey(key: Key, scancode: ScanCode, action: Action, mods: KeyMods) {
            this.camera.key(key, action);
            return 1;
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
            this.camera.update(elapsedSeconds);
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        // The framebuffers of the back buffers go before the back buffers do.
        onBackBufferResizing() {
            this.releaseTargets();
        }

        releaseTargets() {
            for (const resource of this.resources) {
                this.app.releaseResource(resource);
            }
            this.resources = [];
            this.compositionFramebuffers = [];
            this.transparentFramebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
        }

        own<T extends ResourceHandle>(resource: T) {
            this.resources.push(resource);
            return resource;
        }

        // The sample's create_attachments and prepare_pipelines.
        createTargets(width: int, height: int) {
            this.releaseTargets();
            this.positionDepth = this.own(this.app.createRenderTargetTexture(width, height, Format.RGBA16_FLOAT, "Position and depth"));
            this.normal = this.own(this.app.createRenderTargetTexture(width, height, Format.RGBA16_FLOAT, "Normal"));
            this.albedo = this.own(this.app.createRenderTargetTexture(width, height, Format.RGBA8_UNORM, "Albedo"));
            this.depth = this.own(this.app.createDepthTexture(width, height, Format.D32, 0.0, "Depth"));
            this.gbufferFramebuffer = this.own(this.app.createFramebufferWithThreeTargets(this.positionDepth, this.normal, this.albedo,
                this.depth));
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                const backBuffer = this.app.getBackBuffer(i);
                this.compositionFramebuffers.push(this.own(this.app.createFramebuffer(backBuffer, null)));
                this.transparentFramebuffers.push(this.own(this.app.createFramebuffer(backBuffer, this.depth)));
            }

            const compositionDesc = BindingSetDesc.create();
            compositionDesc.bindTextureSRV(0, this.positionDepth);
            compositionDesc.bindTextureSRV(1, this.normal);
            compositionDesc.bindTextureSRV(2, this.albedo);
            compositionDesc.bindStructuredBufferSRV(3, this.lightsBuffer);
            this.compositionBindingSet = this.app.createBindingSetForLayout(compositionDesc, this.compositionBindingLayout);
            this.own(this.compositionBindingSet.handle);
            const transparentDesc = BindingSetDesc.create();
            transparentDesc.bindEntireConstantBuffer(0, this.uniformBuffer);
            transparentDesc.bindPushConstants(1, PUSH_SIZE);
            transparentDesc.bindTextureSRV(0, this.positionDepth);
            transparentDesc.bindTextureSRV(4, this.glassTexture);
            transparentDesc.bindSampler(0, this.glassSampler);
            this.transparentBindingSet = this.app.createBindingSetForLayout(transparentDesc, this.transparentBindingLayout);
            this.own(this.transparentBindingSet.handle);

            if (!this.pipelinesCreated) {
                // The opaque scene: back faces culled (counter-clockwise front faces), depth tested
                // (greater: reversed) and written.
                const opaque = GraphicsPipelineDesc.create(this.opaqueVS, this.opaquePS);
                opaque.setInputLayout(this.opaqueInputLayout);
                opaque.addBindingLayout(this.opaqueBindingLayout);
                opaque.setDepthState(1, 1, ComparisonFunc.Greater);
                opaque.setRasterState(CullMode.Back, FillMode.Solid, 1);
                this.opaquePipeline = this.app.createGraphicsPipelineFromDesc(opaque, this.gbufferFramebuffer);
                // The composition: no culling, no depth.
                const composition = GraphicsPipelineDesc.create(this.compositionVS, this.compositionPS);
                composition.addBindingLayout(this.compositionBindingLayout);
                composition.setDepthState(0, 0, ComparisonFunc.Always);
                composition.setRasterState(CullMode.None, FillMode.Solid, 1);
                this.compositionPipeline = this.app.createGraphicsPipelineFromDesc(composition, this.compositionFramebuffers[0]);
                // The glass: no culling, depth tested and written, alpha blended (destination alpha
                // kept).
                const transparent = GraphicsPipelineDesc.create(this.transparentVS, this.transparentPS);
                transparent.setInputLayout(this.transparentInputLayout);
                transparent.addBindingLayout(this.transparentBindingLayout);
                transparent.setDepthState(1, 1, ComparisonFunc.Greater);
                transparent.setRasterState(CullMode.None, FillMode.Solid, 1);
                transparent.setBlendState(true, BlendFactor.SrcAlpha, BlendFactor.InvSrcAlpha, BlendOp.Add,
                    BlendFactor.Zero, BlendFactor.One, BlendOp.Add);
                this.transparentPipeline = this.app.createGraphicsPipelineFromDesc(transparent, this.transparentFramebuffers[0]);
                this.pipelinesCreated = true;
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        // The sample's update_lights_buffer: 64 lights at random over the room (a new engine each
        // time, seeded randomly, or with 0 under -benchmark). MSVC evaluates the sample's
        // vec4(x, y, z, 1) and vec3(r, g, b) from the last argument: z, y, x and b, g, r.
        randomizeLights() {
            const rng = this.app.createRandomEngine(this.benchmark ? 0 : -1);
            this.lights = [];
            for (let l = 0; l < LIGHT_COUNT; l++) {
                const z = Math.fround(rng.uniformFloat(-1.0, 1.0) * LIGHT_RANGE[2]);
                const y = Math.fround(1.0 + Math.fround(Math.abs(rng.uniformFloat(-1.0, 1.0)) * LIGHT_RANGE[1]));
                const x = Math.fround(rng.uniformFloat(-1.0, 1.0) * LIGHT_RANGE[0]);
                const radius = Math.fround(1.0 + Math.fround(Math.abs(rng.uniformFloat(-1.0, 1.0)) * 3.0));
                const b = rng.uniformFloat(0.0, 0.5);
                const g = rng.uniformFloat(0.0, 0.5);
                const r = rng.uniformFloat(0.0, 0.5);
                this.lights.push(x);
                this.lights.push(y);
                this.lights.push(z);
                this.lights.push(1.0);
                this.lights.push(r * 2.0);
                this.lights.push(g * 2.0);
                this.lights.push(b * 2.0);
                this.lights.push(radius);
            }
            this.lightsDirty = true;
        }

        drawScene(frame: Frame, scene: Scene, pipeline: GraphicsPipelineHandle, framebuffer: FramebufferHandle, bindingSet: BindingSet) {
            for (let d = 0; d < scene.indexCount.length; d++) {
                for (let i = 0; i < PUSH_FLOATS; i++) {
                    this.push[i] = scene.push[d * PUSH_FLOATS + i];
                }
                frame.beginDrawToFramebuffer(pipeline, framebuffer);
                frame.drawAddBindingSet(bindingSet);
                frame.drawSetIndexBuffer(scene.indexBuffer);
                frame.drawAddVertexBuffer(scene.vertexBuffer, 0, 0);
                frame.drawIndexedRangeWithPushConstants(scene.indexCount[d], scene.firstIndex[d], scene.baseVertex[d],
                    Ref(this.push[0]), PUSH_SIZE);
            }
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }
            if (this.lightsDirty) {
                commandList.writeBuffer(this.lightsBuffer, Ref(this.lights[0]), LIGHT_COUNT * LIGHT_FLOATS * 4);
                this.lightsDirty = false;
            }

            // The sample's update_uniform_buffer: its projection (clip y negated for Donut), the
            // scene's model (identity), the view.
            const projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            const model = identity();
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.ubo[UBO_MODEL + i] = model[i];
                this.ubo[UBO_VIEW + i] = view[i];
            }
            commandList.writeBuffer(this.uniformBuffer, Ref(this.ubo[0]), UBO_FLOATS * 4);

            // Everything cleared to zeros (depth too: reversed).
            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), 0.0, 0.0, 0.0, 0.0);
            commandList.clearTextureFloat(this.positionDepth, 0.0, 0.0, 0.0, 0.0);
            commandList.clearTextureFloat(this.normal, 0.0, 0.0, 0.0, 0.0);
            commandList.clearTextureFloat(this.albedo, 0.0, 0.0, 0.0, 0.0);
            commandList.clearDepth(this.depth, 0.0);

            // First draw: the G-buffer.
            this.drawScene(frame, this.opaqueScene, this.opaquePipeline, this.gbufferFramebuffer, this.opaqueBindingSet);

            // Second draw: the deferred composition, reading the G-buffer.
            frame.beginDrawToFramebuffer(this.compositionPipeline, this.compositionFramebuffers[index]);
            frame.drawAddBindingSet(this.compositionBindingSet);
            frame.drawVertices(3);

            // Third draw: the transparent geometry, forward, against the G-buffer's depth.
            this.drawScene(frame, this.transparentScene, this.transparentPipeline, this.transparentFramebuffers[index],
                this.transparentBindingSet);
        }
    }

    // The sample's overlay.
    class UserInterface {
        private sample: LocalReadPass;

        constructor(sample: LocalReadPass) {
            this.sample = sample;
        }

        init(app: App) {
            return !app.addImGuiPass(this.buildUI).isNull();
        }

        buildUI() {
            ImGui.setNextWindowPos(10.0, 10.0);
            ImGui.begin("Dynamic Rendering Local Read", true);
            ImGui.text("Using separate passes (no local read)");
            if (ImGui.button("Randomize lights")) {
                this.sample.randomizeLights();
            }
            ImGui.end();
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("dynamic_rendering_local_read");

        const args = new Args(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new LocalReadPass(app);
        // -benchmark: the lights' random engine seeded with 0 (as vulkan_samples' --benchmark); so
        // under -test, for the same lights every run.
        sample.benchmark = args.benchmark || args.test;
        if (!sample.init()) {
            app.destroy();
            return 1;
        }

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(sample);
        if (!args.noUI && !gui.init(app)) {
            console.log("Cannot initialize the user interface");
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
    return DynamicRenderingLocalRead.main(argc, argv);
}

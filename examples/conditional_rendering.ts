// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";
import { multiply, rotation, translation, scale, radians, samplePerspective } from "../core/matrix";

namespace ConditionalRendering {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame. The corners are black; the model's parts, each drawn under its
    // own condition (all on), cover about a third of the frame, green in the middle.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        const corners = check.corners(0x000000);
        if (corners != "") {
            return corners;
        }
        if (check.rgb(check.width / 2, check.height / 2) != 0x00FF00) {
            return "the middle isn't the model's green";
        }
        return check.share(check.countOtherThan(0x000000, 0, 0, check.width, check.height), total,
            25.0, 42.0, "Model");
    }

    const WINDOW_TITLE = "Donut Example: Conditional Rendering";

    // The sample's model (Vulkan-Samples' asset, copied at build time: see VULKAN_SAMPLES_ASSETS_DIR
    // in CMakeLists.txt).
    const MODEL_PATH = "media/conditional_rendering/Buggy.gltf";

    // Donut_LoadGltfModel's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_FLOATS = 8;

    // struct SceneConstants { float4x4 projection, view; }, as f32 offsets.
    const CONST_PROJECTION = 0;
    const CONST_VIEW = 16;
    const CONST_FLOATS = 32;
    // The push constants: float4x4 model; float4 color.
    const NODE_FLOATS = 20;

    // The sample's camera: a "look at" camera, 60 degrees vertically, reversed depth from 256 to
    // 0.1 (glm::perspective with near and far swapped); the view scaled down by 10 (the model is
    // large) and turned upside down.
    const CAMERA_POSITION = [1.9, 2.05, -18.0];
    const CAMERA_ROTATION = [-11.25, -38.0, 0.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;
    const VIEW_SCALE = 0.1;
    // ApiVulkanSample's mouse controls: degrees per pixel dragged with the left button, zoom per
    // pixel with the right one, panning per pixel with the middle one.
    const ROTATION_SPEED = 1.0;
    const ZOOM_SPEED = 0.005;
    const PAN_SPEED = 0.01;

    // Port of Vulkan-Samples' conditional_rendering: the nodes of a glTF model, each drawn in a
    // conditional block that reads a value of its own from a buffer as the GPU executes it (D3D12
    // predication, Vulkan conditional rendering): 0 skips the draw. The UI writes the values; the
    // draws themselves are always recorded.
    class ConditionalRenderingPass {
        private app: App;
        unsupportedReason: string;

        // The sample's linear_scene_nodes: per mesh, per node instancing it, per primitive.
        names: string[];
        visible: boolean[];
        predication: PredicationBuffer;
        private nodeTransform: f32[];
        private nodeColor: f32[];
        private nodeFirstIndex: int[];
        private nodeIndexCount: int[];
        private nodeBaseVertex: int[];

        // The sample's camera: rotation (degrees about x, y, z) and position.
        private cameraRotation: number[];
        private cameraPosition: number[];
        private leftButton: boolean;
        private rightButton: boolean;
        private middleButton: boolean;
        private mouseX: number;
        private mouseY: number;

        private vertexShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private bindingLayout: BindingLayoutHandle;
        private bindingSet: BindingSet;
        private constantBuffer: BufferHandle;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;

        // The back buffer's size: color (sRGB, as the sample's swapchain) and depth targets.
        private colorBuffer: TextureHandle | null;
        private depthBuffer: TextureHandle | null;
        private framebuffer: FramebufferHandle | null;
        private pipeline: GraphicsPipelineHandle | null;

        private constants: f32[];
        private nodeConstants: f32[];

        constructor(app: App) {
            this.app = app;
            this.unsupportedReason = "";
            this.names = [];
            this.visible = [];
            this.nodeTransform = [];
            this.nodeColor = [];
            this.nodeFirstIndex = [];
            this.nodeIndexCount = [];
            this.nodeBaseVertex = [];
            this.cameraRotation = [CAMERA_ROTATION[0], CAMERA_ROTATION[1], CAMERA_ROTATION[2]];
            this.cameraPosition = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
            this.leftButton = false;
            this.rightButton = false;
            this.middleButton = false;
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.colorBuffer = null;
            this.depthBuffer = null;
            this.framebuffer = null;
            this.pipeline = null;
            this.constants = [];
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
            this.nodeConstants = [];
            for (let i = 0; i < NODE_FLOATS; i++) {
                this.nodeConstants.push(0.0);
            }
        }

        init() {
            if (!this.app.hasConditionalRendering()) {
                this.unsupportedReason = "This example needs conditional rendering (D3D12 predication or Vulkan's VK_EXT_conditional_rendering)";
                return false;
            }

            const shader = "conditional_rendering.hlsl";
            this.vertexShader = this.app.createShader(shader, "model_vs", ShaderType.Vertex);
            this.pixelShader = this.app.createShader(shader, "model_ps", ShaderType.Pixel);
            if (!this.vertexShader || !this.pixelShader) {
                return false;
            }

            // Positions and normals.
            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_FLOATS * 4);
            layoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_FLOATS * 4);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vertexShader);

            // The sample's descriptor set (the UBO) and push constants.
            this.constantBuffer = this.app.createVolatileConstantBuffer(CONST_FLOATS * 4, "UBO");
            const layoutBindingDesc = BindingLayoutDesc.create();
            layoutBindingDesc.layoutVolatileConstantBuffer(0);
            layoutBindingDesc.layoutPushConstants(1, NODE_FLOATS * 4);
            this.bindingLayout = this.app.createBindingLayout(layoutBindingDesc, ShaderType.Vertex);
            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.constantBuffer);
            setDesc.bindPushConstants(1, NODE_FLOATS * 4);
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);

            // The blit's common passes, created on first use, upload their textures on a command
            // list of their own: create them before ours (or the frame's) is open.
            this.app.getCommonSampler(CommonSampler.PointClamp);

            const commandList = this.app.createCommandList();
            commandList.open();
            const loaded = this.loadModel(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded) {
                console.log("Cannot load the model: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            // One value per node, all 1 (visible).
            this.predication = this.app.createPredicationBuffer(this.names.length);
            if (this.predication.isNull()) {
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

        // A node's visibility: written to the predication buffer, read by the GPU.
        setVisible(index: int, visible: boolean) {
            this.visible[index] = visible;
            this.predication.setValue(index, visible ? 1 : 0);
        }

        // ApiVulkanSample's mouse handling: dragging with the left button rotates the camera, with
        // the right one zooms, with the middle one pans.
        onMousePos(x: number, y: number) {
            const dx = this.mouseX - x;
            const dy = this.mouseY - y;
            if (this.leftButton) {
                this.cameraRotation[0] += dy * ROTATION_SPEED;
                this.cameraRotation[1] -= dx * ROTATION_SPEED;
            }
            if (this.rightButton) {
                this.cameraPosition[2] += dy * ZOOM_SPEED;
            }
            if (this.middleButton) {
                this.cameraPosition[0] -= dx * PAN_SPEED;
                this.cameraPosition[1] -= dy * PAN_SPEED;
            }
            this.mouseX = x;
            this.mouseY = y;
            return 1;
        }

        onMouseButton(button: MouseButton, action: Action, mods: KeyMods) {
            const pressed = action == Action.Press;
            if (button == MouseButton.Left) {
                this.leftButton = pressed;
            } else if (button == MouseButton.Right) {
                this.rightButton = pressed;
            } else if (button == MouseButton.Middle) {
                this.middleButton = pressed;
            }
            return 1;
        }

        onAnimate(elapsedSeconds: number) {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        releaseTargets() {
            this.app.releaseResources([this.pipeline, this.framebuffer, this.colorBuffer, this.depthBuffer]);
            this.pipeline = null;
            this.framebuffer = null;
            this.colorBuffer = null;
            this.depthBuffer = null;
        }

        onBackBufferResizing() {
            this.releaseTargets();
            // The blit's cached binding sets still reference the old color buffer.
            this.app.clearBindingCache();
        }

        // The targets and the sample's pipeline: reversed depth (greater passes), back faces culled
        // (counter-clockwise triangles are front faces).
        createTargets(width: int, height: int) {
            const colorBuffer = this.app.createRenderTargetTexture(width, height, Format.SRGBA8_UNORM, "ColorBuffer");
            const depthBuffer = this.app.createRenderTargetTexture(width, height, Format.D32, "DepthBuffer");
            const framebuffer = this.app.createFramebuffer(colorBuffer, depthBuffer);
            this.colorBuffer = colorBuffer;
            this.depthBuffer = depthBuffer;
            this.framebuffer = framebuffer;

            const desc = GraphicsPipelineDesc.create(this.vertexShader, this.pixelShader);
            desc.setInputLayout(this.inputLayout);
            desc.addBindingLayout(this.bindingLayout);
            desc.setDepthState(1, 1, ComparisonFunc.Greater);
            desc.setRasterState(CullMode.Back, FillMode.Solid, 1);
            this.pipeline = this.app.createGraphicsPipelineFromDesc(desc, framebuffer);
        }

        // The sample's update_uniform_buffers: its camera's matrices, the view scaled down and
        // turned upside down.
        updateConstants(width: int, height: int) {
            const c = this.constants;
            const projection = samplePerspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            // A "look at" camera: translation * rotation (about x, then y, then z).
            const r = this.cameraRotation;
            let rotationMatrix = multiply(rotation(radians(r[0]), 1.0, 0.0, 0.0), rotation(radians(r[1]), 0.0, 1.0, 0.0));
            rotationMatrix = multiply(rotationMatrix, rotation(radians(r[2]), 0.0, 0.0, 1.0));
            const p = this.cameraPosition;
            let view = multiply(translation(p[0], p[1], p[2]), rotationMatrix);
            view = multiply(view, scale(VIEW_SCALE, -VIEW_SCALE, VIEW_SCALE));
            for (let i = 0; i < 16; i++) {
                c[CONST_PROJECTION + i] = projection[i];
                c[CONST_VIEW + i] = view[i];
            }
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (!this.framebuffer) {
                this.createTargets(width, height);
            }
            const framebuffer = this.framebuffer;
            const colorBuffer = this.colorBuffer;
            const depthBuffer = this.depthBuffer;
            const pipeline = this.pipeline;
            if (!framebuffer || !colorBuffer || !depthBuffer || !pipeline) {
                return;
            }

            this.updateConstants(width, height);
            commandList.writeBuffer(this.constantBuffer, Ref(this.constants[0]), CONST_FLOATS * 4);

            // Reversed depth: the far plane is 0.
            commandList.clearTextureFloat(colorBuffer, 0.0, 0.0, 0.0, 0.0);
            commandList.clearDepth(depthBuffer, 0.0);

            frame.beginDrawToFramebuffer(pipeline, framebuffer);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            frame.drawSetIndexBuffer(this.indexBuffer);
            const n = this.nodeConstants;
            for (let node = 0; node < this.names.length; node++) {
                for (let i = 0; i < 16; i++) {
                    n[i] = this.nodeTransform[node * 16 + i];
                }
                for (let i = 0; i < 4; i++) {
                    n[16 + i] = this.nodeColor[node * 4 + i];
                }
                // Drawn only if the node's value in the buffer isn't 0 when the GPU gets here.
                frame.drawIndexedRangeWithPushConstantsPredicated(this.nodeIndexCount[node], this.nodeFirstIndex[node],
                    this.nodeBaseVertex[node], Ref(n[0]), NODE_FLOATS * 4, this.predication, node);
            }

            this.app.blitTexture(frame, colorBuffer);
        }

        // The sample's load_assets: the model's primitives in one vertex and one index buffer, and
        // the nodes to draw, in the framework's order (meshes, the nodes instancing each, their
        // primitives).
        loadModel(commandList: CommandList) {
            const model = this.app.loadGltfModel(MODEL_PATH);
            if (model.isNull()) {
                return false;
            }
            const primitiveCount = model.getPrimitiveCount();

            const vertices: f32[] = [];
            const indices: int[] = [];
            const primitiveFirstIndex: int[] = [];
            const primitiveIndexCount: int[] = [];
            const primitiveBaseVertex: int[] = [];
            const primitiveColor: f32[] = [];
            const meshFirstPrimitive: int[] = [];
            const color: f32[] = [0.0, 0.0, 0.0, 0.0];
            for (let p = 0; p < primitiveCount; p++) {
                const mesh = model.getPrimitiveMesh(p);
                while (meshFirstPrimitive.length <= mesh) {
                    meshFirstPrimitive.push(p);
                }

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

                primitiveBaseVertex.push(vertices.length / VERTEX_FLOATS);
                primitiveFirstIndex.push(indices.length);
                primitiveIndexCount.push(indexCount);
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v++) {
                    vertices.push(primitiveVertices[v]);
                }
                for (let i = 0; i < indexCount; i++) {
                    indices.push(primitiveIndices[i]);
                }

                // The sample's color: the base color factor, opaque.
                model.copyBaseColorFactor(p, Ref(color[0]));
                primitiveColor.push(color[0]);
                primitiveColor.push(color[1]);
                primitiveColor.push(color[2]);
                primitiveColor.push(1.0);
            }
            const meshCount = meshFirstPrimitive.length;
            meshFirstPrimitive.push(primitiveCount);

            const nodeCount = model.getNodeCount();
            const transform: f32[] = [];
            for (let i = 0; i < 16; i++) {
                transform.push(0.0);
            }
            for (let mesh = 0; mesh < meshCount; mesh++) {
                for (let node = 0; node < nodeCount; node++) {
                    if (model.getNodeMesh(node) != mesh) {
                        continue;
                    }
                    model.copyNodeTransform(node, Ref(transform[0]));
                    for (let p = meshFirstPrimitive[mesh]; p < meshFirstPrimitive[mesh + 1]; p++) {
                        this.names.push(model.getMeshName(p));
                        this.visible.push(true);
                        for (let i = 0; i < 16; i++) {
                            this.nodeTransform.push(transform[i]);
                        }
                        for (let i = 0; i < 4; i++) {
                            this.nodeColor.push(primitiveColor[p * 4 + i]);
                        }
                        this.nodeFirstIndex.push(primitiveFirstIndex[p]);
                        this.nodeIndexCount.push(primitiveIndexCount[p]);
                        this.nodeBaseVertex.push(primitiveBaseVertex[p]);
                    }
                }
            }

            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "VertexBuffer");
            this.indexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), indices.length * 4, "IndexBuffer");
            return true;
        }
    }

    // The sample's overlay.
    class UserInterface {
        private sample: ConditionalRenderingPass;

        constructor(sample: ConditionalRenderingPass) {
            this.sample = sample;
        }

        init(app: App) {
            return !app.addImGuiPass(this.buildUI).isNull();
        }

        buildUI() {
            const sample = this.sample;
            ImGui.setNextWindowPos(10.0, 10.0);
            // The sample's title (ApiVulkanSample's default).
            ImGui.begin("Vulkan Example", true);
            if (ImGui.collapsingHeaderDefaultOpen("Visibility")) {
                if (ImGui.button("All")) {
                    for (let i = 0; i < sample.names.length; i++) {
                        sample.setVisible(i, true);
                    }
                }
                ImGui.sameLine();
                if (ImGui.button("None")) {
                    for (let i = 0; i < sample.names.length; i++) {
                        sample.setVisible(i, false);
                    }
                }
                ImGui.newLine();

                ImGui.beginChild("InnerRegion", 200.0, 400.0, false);
                for (let i = 0; i < sample.names.length; i++) {
                    const visible = ImGui.checkbox(`[${i}] ${sample.names[i]}`, sample.visible[i]);
                    if (visible != sample.visible[i]) {
                        sample.setVisible(i, visible);
                    }
                }
                ImGui.endChild();
            }
            ImGui.end();
        }
    }

    class ConditionalRenderingArgs extends Args {
        // -hide <first> <count>: start with those nodes hidden.
        hideFirst = 0;
        hideCount = 0;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-hide" && i + 2 < this.argc) {
                    this.hideFirst = parseInt(this[i + 1]);
                    this.hideCount = parseInt(this[i + 2]);
                    i += 2;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("conditional_rendering");

        const args = new ConditionalRenderingArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new ConditionalRenderingPass(app);
        if (!sample.init()) {
            app.destroy();
            return sample.unsupportedReason != "" ? unsupported(args.test, sample.unsupportedReason) : 1;
        }
        for (let i = args.hideFirst; i < args.hideFirst + args.hideCount && i < sample.names.length; i++) {
            sample.setVisible(i, false);
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
    return ConditionalRendering.main(argc, argv);
}

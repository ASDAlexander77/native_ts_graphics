// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck } from "../core/test_check";
import { identity, multiply, rotate, radians, perspective } from "../core/matrix";
import { KEY_A, KEY_D, KEY_S, KEY_W, ACTION_RELEASE } from "../core/glfw_input";

namespace PatchControlPoints {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame. The corners are black; the three tessellated terrains, red, blue
    // and green wireframes, color about 17% of the frame, each 2.5% to 8%.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        const corners = check.corners(0x000000);
        if (corners != "") {
            return corners;
        }
        const total = check.width * check.height;
        const red = check.share(check.countInRange(151, 255, 0, 89, 0, 89, 0, 0, check.width, check.height), total,
            2.5, 8.0, "Red");
        if (red != "") {
            return red;
        }
        const green = check.share(check.countInRange(0, 89, 121, 255, 0, 89, 0, 0, check.width, check.height), total,
            2.5, 8.0, "Green");
        if (green != "") {
            return green;
        }
        return check.share(check.countInRange(0, 89, 0, 119, 121, 255, 0, 0, check.width, check.height), total,
            2.5, 8.0, "Blue");
    }

    const WINDOW_TITLE = "Donut Example: Patch Control Points";

    // The sample's model (Vulkan-Samples' asset, copied at build time: see
    // VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const MODEL_PATH = "media/patch_control_points/terrain.gltf";

    // Donut_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // struct UBO { float4x4 projection, view; }.
    const UBO_PROJECTION = 0;
    const UBO_VIEW = 16;
    const UBO_FLOATS = 32;
    // struct UBOTessellation { float tessellationFactor; }, padded to 16 bytes.
    const TESS_FLOATS = 4;
    // The push constants: float3 direction.
    const PUSH_FLOATS = 3;

    // Where the sample draws the model, once with each pipeline.
    const DIRECTIONS = [
        2.5, -1.0, 3.0,        // first model
        0.0, -1.0, 3.0,        // second model
    ];

    // The sample's first person camera at (-1.25, -0.75, 1.5) (vkb::Camera's position, the view's
    // translation), not turned; reversed depth from 0.1 to 256.
    const CAMERA_POSITION = [-1.25, -0.75, 1.5];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // The sample's camera (the framework's vkb::Camera, first person type), with
    // ApiVulkanSample's controls: W, S, A, D move it (1 unit per second), the left mouse button
    // turns it, the right one moves it along its view, the middle one pans.
    class SampleCamera {
        rotation: number[];
        position: number[];
        private mouseX: number;
        private mouseY: number;
        private buttons: boolean[];
        // W, S, A, D held.
        private keys: boolean[];

        constructor() {
            this.rotation = [0.0, 0.0, 0.0];
            this.position = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.buttons = [false, false, false];
            this.keys = [false, false, false, false];
        }

        // vkb::Camera::update_view_matrix: rotations around x, y, z, then translate(position).
        view() {
            let r = identity();
            r = rotate(r, radians(this.rotation[0]), 1.0, 0.0, 0.0);
            r = rotate(r, radians(this.rotation[1]), 0.0, 1.0, 0.0);
            r = rotate(r, radians(this.rotation[2]), 0.0, 0.0, 1.0);
            let t = identity();
            t[12] = this.position[0];
            t[13] = this.position[1];
            t[14] = this.position[2];
            return multiply(r, t);
        }

        key(key: int, action: int) {
            const down = action != ACTION_RELEASE;
            if (key == KEY_W) {
                this.keys[0] = down;
            } else if (key == KEY_S) {
                this.keys[1] = down;
            } else if (key == KEY_A) {
                this.keys[2] = down;
            } else if (key == KEY_D) {
                this.keys[3] = down;
            }
        }

        // vkb::Camera::update: first person movement, 1 unit per second.
        update(deltaTime: number) {
            const rx = radians(this.rotation[0]);
            const ry = radians(this.rotation[1]);
            let front = [-Math.cos(rx) * Math.sin(ry), Math.sin(rx), Math.cos(rx) * Math.cos(ry)];
            const length = Math.sqrt(front[0] * front[0] + front[1] * front[1] + front[2] * front[2]);
            for (let i = 0; i < 3; i++) {
                front[i] /= length;
            }
            // normalize(cross(front, (0, 1, 0))).
            let right = [-front[2], 0.0, front[0]];
            const rightLength = Math.sqrt(right[0] * right[0] + right[2] * right[2]);
            for (let i = 0; i < 3; i++) {
                right[i] /= rightLength;
            }
            for (let i = 0; i < 3; i++) {
                if (this.keys[0]) {
                    this.position[i] += front[i] * deltaTime;
                }
                if (this.keys[1]) {
                    this.position[i] -= front[i] * deltaTime;
                }
                if (this.keys[2]) {
                    this.position[i] -= right[i] * deltaTime;
                }
                if (this.keys[3]) {
                    this.position[i] += right[i] * deltaTime;
                }
            }
        }

        // GLFW buttons: 0 left, 1 right, 2 middle; action 1 press, 0 release.
        mouseButton(button: int, action: int) {
            if (button >= 0 && button < 3) {
                this.buttons[button] = action == 1;
            }
        }

        // ApiVulkanSample::handle_mouse_move, with its speeds (1).
        mouseMove(x: number, y: number) {
            const dx = Math.floor(this.mouseX) - Math.floor(x);
            const dy = Math.floor(this.mouseY) - Math.floor(y);
            if (this.buttons[0]) {
                this.rotation[0] += dy;
                this.rotation[1] -= dx;
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

    // --- Passes -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' patch_control_points: a terrain mesh drawn twice as tessellated
    // triangle patches in wireframe, each patch's edges tessellated by their distance from the
    // camera (red: level 1, blue: 0.4 x the factor, green: the factor). The sample's first copy
    // uses a pipeline with 3 control points per patch, the second a pipeline whose count is
    // dynamic state (VK_EXT_extended_dynamic_state2), set to 3 when drawing. NVRHI has no dynamic
    // patch control points: here both pipelines are made with 3 (D3D's patch list topologies have
    // the count built in), and draw the same.
    class PatchControlPointsPass {
        private app: App;
        private camera: SampleCamera;

        // The sample's settings.
        tessellation: boolean;
        tessLevel: number;

        private vs: ShaderHandle;
        private hs: ShaderHandle;
        private ds: ShaderHandle;
        private ps: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private bindingLayout: BindingLayoutHandle;
        private commonBuffer: BufferHandle;
        private staticTessBuffer: BufferHandle;
        private dynamicTessBuffer: BufferHandle;
        private staticBindingSet: BindingSet;
        private dynamicBindingSet: BindingSet;
        private model: GltfMesh;

        // The depth buffer and a framebuffer per back buffer, for the back buffers' size, and the
        // pipelines made for them.
        private depth: TextureHandle;
        private framebuffers: FramebufferHandle[];
        private targetWidth: int;
        private targetHeight: int;
        private staticPipeline: GraphicsPipelineHandle;
        private dynamicPipeline: GraphicsPipelineHandle;
        private pipelinesCreated: boolean;

        // Upload buffers.
        private ubo: f32[];
        private tess: f32[];
        private push: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
            this.tessellation = true;
            this.tessLevel = 3.0;
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.pipelinesCreated = false;
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
            this.tess = [0.0, 0.0, 0.0, 0.0];
            this.push = [0.0, 0.0, 0.0];
        }

        onKey(key: int, scancode: int, action: int, mods: int) {
            this.camera.key(key, action);
            return 1;
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
            this.camera.update(elapsedSeconds);
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

        // The sample's create_pipelines: patches of 3 control points, wireframe, front faces
        // (counter-clockwise) culled, alpha blended, reversed depth (greater).
        createPipeline() {
            const desc = GraphicsPipelineDesc.create(this.vs, this.ps);
            desc.setTessellation(this.hs, this.ds, 3);
            desc.setInputLayout(this.inputLayout);
            desc.addBindingLayout(this.bindingLayout);
            desc.setDepthState(1, 1, ComparisonFunc.Greater);
            desc.setRasterState(CullMode.Front, FillMode.Wireframe, 1);
            desc.setBlendState(1, BlendFactor.SrcAlpha, BlendFactor.InvSrcAlpha, BlendOp.Add,
                BlendFactor.One, BlendFactor.Zero, BlendOp.Add);
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
                this.staticPipeline = this.createPipeline();
                this.dynamicPipeline = this.createPipeline();
                this.pipelinesCreated = true;
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        drawModel(frame: Frame, pipeline: GraphicsPipelineHandle, framebuffer: FramebufferHandle, bindingSet: BindingSet, model: int) {
            for (let i = 0; i < 3; i++) {
                this.push[i] = DIRECTIONS[model * 3 + i];
            }
            frame.beginDrawToFramebuffer(pipeline, framebuffer);
            frame.drawAddBindingSet(bindingSet);
            frame.drawSetIndexBuffer(this.model.getIndexBuffer());
            frame.drawAddVertexBuffer(this.model.getVertexBuffer(), 0, 0);
            frame.drawIndexedWithPushConstants(this.model.getIndexCount(), Ref(this.push[0]), PUSH_FLOATS * 4);
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            // The sample's update_uniform_buffers: its projection (clip y negated for Donut) and
            // view; the tessellation factor (1 when tessellation is off), for both pipelines.
            const projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.ubo[UBO_VIEW + i] = view[i];
            }
            this.tess[0] = this.tessellation ? this.tessLevel : 1.0;
            commandList.writeBuffer(this.commonBuffer, Ref(this.ubo[0]), UBO_FLOATS * 4);
            commandList.writeBuffer(this.staticTessBuffer, Ref(this.tess[0]), TESS_FLOATS * 4);
            commandList.writeBuffer(this.dynamicTessBuffer, Ref(this.tess[0]), TESS_FLOATS * 4);

            // The render pass: color cleared to transparent black, depth to 0 (reversed).
            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), 0.0, 0.0, 0.0, 0.0);
            commandList.clearDepth(this.depth, 0.0);
            const framebuffer = this.framebuffers[index];

            this.drawModel(frame, this.staticPipeline, framebuffer, this.staticBindingSet, 0);
            this.drawModel(frame, this.dynamicPipeline, framebuffer, this.dynamicBindingSet, 1);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init() {
            const shader = "patch_control_points.hlsl";
            this.vs = this.app.createShader(shader, "tess_vs", ShaderType.Vertex);
            this.hs = this.app.createShader(shader, "tess_hs", ShaderType.Hull);
            this.ds = this.app.createShader(shader, "tess_ds", ShaderType.Domain);
            this.ps = this.app.createShader(shader, "tess_ps", ShaderType.Pixel);
            if (!this.vs || !this.hs || !this.ds || !this.ps) {
                return false;
            }

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vs);

            const commandList = this.app.createCommandList();
            commandList.open();
            const model = this.app.loadGltfMesh(commandList, MODEL_PATH);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (model.isNull()) {
                console.log("Cannot load the model: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }
            this.model = model;

            // The sample's two descriptor sets: the common matrices, and each pipeline's own
            // tessellation buffer; the push constants.
            this.commonBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "UBO");
            this.staticTessBuffer = this.app.createVolatileConstantBuffer(TESS_FLOATS * 4, "Static UBOTessellation");
            this.dynamicTessBuffer = this.app.createVolatileConstantBuffer(TESS_FLOATS * 4, "Dynamic UBOTessellation");
            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutVolatileConstantBuffer(0);
            bindingLayoutDesc.layoutVolatileConstantBuffer(1);
            bindingLayoutDesc.layoutPushConstants(2, PUSH_FLOATS * 4);
            this.bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.All);
            const staticDesc = BindingSetDesc.create();
            staticDesc.bindEntireConstantBuffer(0, this.commonBuffer);
            staticDesc.bindEntireConstantBuffer(1, this.staticTessBuffer);
            staticDesc.bindPushConstants(2, PUSH_FLOATS * 4);
            this.staticBindingSet = this.app.createBindingSetForLayout(staticDesc, this.bindingLayout);
            const dynamicDesc = BindingSetDesc.create();
            dynamicDesc.bindEntireConstantBuffer(0, this.commonBuffer);
            dynamicDesc.bindEntireConstantBuffer(1, this.dynamicTessBuffer);
            dynamicDesc.bindPushConstants(2, PUSH_FLOATS * 4);
            this.dynamicBindingSet = this.app.createBindingSetForLayout(dynamicDesc, this.bindingLayout);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's overlay.
    class UserInterface {
        private sample: PatchControlPointsPass;

        constructor(sample: PatchControlPointsPass) {
            this.sample = sample;
        }

        buildUI() {
            const sample = this.sample;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Patch Control Points", 1);
            Donut_ImGuiPushItemWidth(110.0);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Settings") != 0) {
                sample.tessellation = Donut_ImGuiCheckbox("Tessellation Enable", sample.tessellation ? 1 : 0) != 0;
                // Maximum tessellation level is set to 7.0
                sample.tessLevel = Donut_ImGuiSliderFloat("Tessellation level", sample.tessLevel, 3.0, 7.0);
            }
            Donut_ImGuiPopItemWidth();
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App) {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    class PatchControlPointsArgs extends Args {
        // -notessellation, -level <3..7>: the settings' initial values.
        tessellation = true;
        tessLevel = 3.0;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-notessellation") {
                    this.tessellation = false;
                } else if (arg == "-level" && i + 1 < this.argc) {
                    i++;
                    this.tessLevel = Math.min(Math.max(parseFloat(this[i]), 3.0), 7.0);
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("patch_control_points");

        const args = new PatchControlPointsArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new PatchControlPointsPass(app);
        sample.tessellation = args.tessellation;
        sample.tessLevel = args.tessLevel;
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
    return PatchControlPoints.main(argc, argv);
}

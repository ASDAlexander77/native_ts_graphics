// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck } from "../core/test_check";

namespace DynamicPrimitiveClipping {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame. The corners are the gray background; the striped teapot colors
    // about 23% of the frame.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        const corners = check.corners(0x595959);
        if (corners != "") {
            return corners;
        }
        return check.share(check.countSpread(61, false, 0, 0, 0, check.width, check.height), check.width * check.height,
            15.0, 35.0, "Teapot");
    }

    const WINDOW_TITLE = "Donut Example: Dynamic Primitive Clipping";

    // The sample's models (Vulkan-Samples' assets, copied at build time; see
    // VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const MODEL_PATHS = ["media/dynamic_primitive_clipping/teapot.gltf", "media/dynamic_primitive_clipping/torusknot.gltf",
        "media/dynamic_primitive_clipping/geosphere.gltf"];
    const MODEL_NAMES = ["Teapot", "Torusknot", "Sphere"];
    const VISUALIZATION_NAMES = ["World space X", "World space Y", "Half-space in world space coordinates",
        "Half-space in clip space coordinates", "Clip space X", "Clip space Y", "Euclidean distance to center",
        "Manhattan distance to center", "Chebyshev distance to center"];

    // Donut_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // The sample's camera: a look-at camera at (0, 0, -50) turned by (0, 180, 0) degrees, a 60
    // degree vertical field of view; the near plane far from the eye (30) to show depth clipping.
    const CAMERA_POSITION = [0.0, 0.0, -50.0];
    const CAMERA_ROTATION = [0.0, 180.0, 0.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 30.0;
    const Z_FAR = 256.0;

    // struct UBOVS { float4x4 projection, view, model; float4 colorTransformation; int2
    // sceneTransformation; float usePrimitiveClipping; }, padded.
    const UBO_PROJECTION = 0;
    const UBO_VIEW = 16;
    const UBO_MODEL = 32;
    const UBO_COLOR_TRANSFORMATION = 48;
    const UBO_SCENE_TRANSFORMATION = 52;
    const UBO_USE_PRIMITIVE_CLIPPING = 54;
    const UBO_FLOATS = 56;

    // ImGui's combo items: names separated by '|'.
    function comboItems(names: string[]) {
        let items = "";
        for (let i = 0; i < names.length; i++) {
            items += (i > 0 ? "|" : "") + names[i];
        }
        return items;
    }

    // --- Math (glm's layout: 4 x 4 matrices by columns) ---------------------------------------

    function identity() {
        return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    }

    // a * b.
    function multiply(a: number[], b: number[]) {
        let result: number[] = [];
        for (let column = 0; column < 4; column++) {
            for (let row = 0; row < 4; row++) {
                let sum = 0.0;
                for (let k = 0; k < 4; k++) {
                    sum += a[k * 4 + row] * b[column * 4 + k];
                }
                result.push(sum);
            }
        }
        return result;
    }

    // glm::rotate(m, angle, axis) for a unit axis.
    function rotate(m: number[], angle: number, x: number, y: number, z: number) {
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const t = 1.0 - c;
        const r = [
            c + t * x * x,     t * x * y + s * z, t * x * z - s * y, 0.0,
            t * x * y - s * z, c + t * y * y,     t * y * z + s * x, 0.0,
            t * x * z + s * y, t * y * z - s * x, c + t * z * z,     0.0,
            0.0,               0.0,               0.0,               1.0,
        ];
        return multiply(m, r);
    }

    function radians(degrees: number) {
        return degrees * Math.PI / 180.0;
    }

    // glm::perspective (right-handed, depth from 0 to 1).
    function perspective(fov: number, aspect: number, zNear: number, zFar: number) {
        const tanHalfFovy = Math.tan(0.5 * fov);
        return [
            1.0 / (aspect * tanHalfFovy), 0.0,               0.0,                              0.0,
            0.0,                          1.0 / tanHalfFovy, 0.0,                              0.0,
            0.0,                          0.0,               zFar / (zNear - zFar),            -1.0,
            0.0,                          0.0,               -(zFar * zNear) / (zFar - zNear), 0.0,
        ];
    }

    // The sample's camera (the framework's vkb::Camera, look-at type), with ApiVulkanSample's mouse
    // controls: the left button turns it, the right one zooms, the middle one pans.
    class SampleCamera {
        rotation: number[];
        position: number[];
        private mouseX: number;
        private mouseY: number;
        private buttons: boolean[];

        constructor() {
            this.rotation = [CAMERA_ROTATION[0], CAMERA_ROTATION[1], CAMERA_ROTATION[2]];
            this.position = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.buttons = [false, false, false];
        }

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

    // --- Pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' dynamic_primitive_clipping: an object drawn twice with user clip
    // distances (SV_ClipDistance), the second time with them negated and its colors inverted, so
    // that each draw shows what the other clips away. The UI picks the function the vertex shader
    // computes the clip distance with (strips along world or clip space axes, half-spaces, distances
    // from the screen's center), and switches clipping at the near and far planes: the sample's
    // dynamic depth clip state (VK_EXT_depth_clip_enable) is a pipeline of its own here.
    class PrimitiveClippingPass {
        private app: App;
        private camera: SampleCamera;

        // The sample's settings, from its UI.
        objectIndex: int;
        usePrimitiveClipping: boolean;
        visualization: int;
        drawObject: boolean[];
        useDepthClipping: boolean;

        private vs: ShaderHandle;
        private ps: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private bindingLayout: BindingLayoutHandle;
        private models: GltfMesh[];
        private transforms: number[][];
        // The two draws' uniform buffers ("positive" and "negative") and binding sets.
        private uniformBuffers: BufferHandle[];
        private bindingSets: BindingSet[];

        // The depth buffer and a framebuffer per back buffer, for the back buffers' size, and the
        // pipelines without and with depth clipping, made for them.
        private depth: TextureHandle;
        private framebuffers: FramebufferHandle[];
        private targetWidth: int;
        private targetHeight: int;
        private pipelines: GraphicsPipelineHandle[];

        // Upload buffer.
        private ubo: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
            this.objectIndex = 0;
            this.usePrimitiveClipping = true;
            this.visualization = 0;
            this.drawObject = [true, true];
            this.useDepthClipping = false;
            this.models = [];
            // The teapot scaled by 10 and turned upside down (half a turn around x).
            const teapot = rotate([10.0, 0.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 0.0, 1.0],
                radians(180.0), 1.0, 0.0, 0.0);
            this.transforms = [teapot, identity(), identity()];
            this.uniformBuffers = [];
            this.bindingSets = [];
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.pipelines = [];
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
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
            if (this.framebuffers.length > 0) {
                this.app.releaseResource(this.depth);
            }
            for (const pipeline of this.pipelines) {
                this.app.releaseResource(pipeline);
            }
            this.framebuffers = [];
            this.pipelines = [];
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
            // The sample's pipeline: depth tested (less) and written, no culling, clockwise front
            // faces; without depth clipping, then with it.
            for (let clip = 0; clip < 2; clip++) {
                const desc = GraphicsPipelineDesc.create(this.vs, this.ps);
                desc.setInputLayout(this.inputLayout);
                desc.addBindingLayout(this.bindingLayout);
                desc.setDepthState(1, 1, ComparisonFunc.Less);
                desc.setRasterState(CullMode.None, FillMode.Solid, 0);
                desc.setDepthClip(clip);
                this.pipelines.push(this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]));
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        // The sample's update_uniform_buffers for one draw: its color transformation and clip
        // distance sign.
        writeUniforms(commandList: CommandList, buffer: BufferHandle, projection: number[], view: number[], colorScale: number,
            colorOffset: number, sign: int) {
            const u = this.ubo;
            const model = this.transforms[this.objectIndex];
            for (let i = 0; i < 16; i++) {
                u[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                u[UBO_VIEW + i] = view[i];
                u[UBO_MODEL + i] = model[i];
            }
            u[UBO_COLOR_TRANSFORMATION] = colorScale;
            u[UBO_COLOR_TRANSFORMATION + 1] = colorOffset;
            u[UBO_COLOR_TRANSFORMATION + 2] = 0.0;
            u[UBO_COLOR_TRANSFORMATION + 3] = 0.0;
            Donut_StoreInt32(Ref(u[UBO_SCENE_TRANSFORMATION]), this.visualization);
            Donut_StoreInt32(Ref(u[UBO_SCENE_TRANSFORMATION + 1]), sign);
            u[UBO_USE_PRIMITIVE_CLIPPING] = this.usePrimitiveClipping ? 1.0 : -1.0;
            commandList.writeBuffer(buffer, Ref(u[0]), UBO_FLOATS * 4);
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            const projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            this.writeUniforms(commandList, this.uniformBuffers[0], projection, view, 1.0, 0.0, 1);
            this.writeUniforms(commandList, this.uniformBuffers[1], projection, view, -1.0, 1.0, -1);

            // The render pass: color cleared to dark gray, depth to 1.
            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), 0.1, 0.1, 0.1, 0.0);
            commandList.clearDepth(this.depth, 1.0);
            const framebuffer = this.framebuffers[index];
            const pipeline = this.pipelines[this.useDepthClipping ? 1 : 0];
            const model = this.models[this.objectIndex];

            // The object, then (with primitive clipping) the same object with the clip distances
            // negated.
            for (let draw = 0; draw < 2; draw++) {
                if (!this.drawObject[draw] || (draw == 1 && !this.usePrimitiveClipping)) {
                    continue;
                }
                frame.beginDrawToFramebuffer(pipeline, framebuffer);
                frame.drawAddBindingSet(this.bindingSets[draw]);
                frame.drawSetIndexBuffer(model.getIndexBuffer());
                frame.drawAddVertexBuffer(model.getVertexBuffer(), 0, 0);
                frame.drawIndexed(model.getIndexCount());
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init() {
            const shader = "dynamic_primitive_clipping.hlsl";
            this.vs = this.app.createShader(shader, "main_vs", ShaderType.Vertex);
            this.ps = this.app.createShader(shader, "main_ps", ShaderType.Pixel);
            if (!this.vs || !this.ps) {
                return false;
            }

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vs);

            const commandList = this.app.createCommandList();
            commandList.open();
            let loaded = true;
            for (const modelPath of MODEL_PATHS) {
                const model = this.app.loadGltfMesh(commandList, modelPath);
                loaded = loaded && !model.isNull();
                this.models.push(model);
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded) {
                console.log("Cannot load the models: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            const layout = BindingLayoutDesc.create();
            layout.layoutVolatileConstantBuffer(0);
            this.bindingLayout = this.app.createBindingLayout(layout, ShaderType.All);
            for (let i = 0; i < 2; i++) {
                const buffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, i == 0 ? "UBO positive" : "UBO negative");
                this.uniformBuffers.push(buffer);
                const setDesc = BindingSetDesc.create();
                setDesc.bindEntireConstantBuffer(0, buffer);
                this.bindingSets.push(this.app.createBindingSetForLayout(setDesc, this.bindingLayout));
            }

            const pass = this.app.addPass();
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's settings.
    class UserInterface {
        private pass: PrimitiveClippingPass;

        constructor(pass: PrimitiveClippingPass) {
            this.pass = pass;
        }

        buildUI() {
            const p = this.pass;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Options", 1);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Settings") != 0) {
                p.objectIndex = Donut_ImGuiCombo("Object type", p.objectIndex, comboItems(MODEL_NAMES));
                p.usePrimitiveClipping = Donut_ImGuiCheckbox("Use primitive clipping", p.usePrimitiveClipping ? 1 : 0) != 0;
                p.visualization = Donut_ImGuiCombo("Visualization", p.visualization, comboItems(VISUALIZATION_NAMES));
                p.drawObject[0] = Donut_ImGuiCheckbox("Draw object 1", p.drawObject[0] ? 1 : 0) != 0;
                p.drawObject[1] = Donut_ImGuiCheckbox("Draw object 2", p.drawObject[1] ? 1 : 0) != 0;
                p.useDepthClipping = Donut_ImGuiCheckbox("Use depth clipping", p.useDepthClipping ? 1 : 0) != 0;
            }
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App) {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    class DynamicPrimitiveClippingArgs extends Args {
        // -object <n>: 0 teapot, 1 torus knot, 2 sphere.
        objectIndex = 0;
        // -visualization <n>: the clip distance function (0 ... 8, as the UI lists them).
        visualization = 0;
        // -noclipping: primitive clipping off.
        clipping = true;
        // -depthclip: depth clipping on.
        depthClip = false;
        // -only <n>: draw only object 1 or 2.
        only = 0;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-object" && i + 1 < this.argc) {
                    this.objectIndex = Math.min(MODEL_NAMES.length - 1, Math.max(0, parseInt(this[i + 1])));
                    i++;
                } else if (arg == "-visualization" && i + 1 < this.argc) {
                    this.visualization = Math.min(VISUALIZATION_NAMES.length - 1, Math.max(0, parseInt(this[i + 1])));
                    i++;
                } else if (arg == "-noclipping") {
                    this.clipping = false;
                } else if (arg == "-depthclip") {
                    this.depthClip = true;
                } else if (arg == "-only" && i + 1 < this.argc) {
                    this.only = parseInt(this[i + 1]);
                    i++;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("dynamic_primitive_clipping");

        const args = new DynamicPrimitiveClippingArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new PrimitiveClippingPass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }
        pass.objectIndex = args.objectIndex;
        pass.visualization = args.visualization;
        pass.usePrimitiveClipping = args.clipping;
        pass.useDepthClipping = args.depthClip;
        if (args.only == 1 || args.only == 2) {
            pass.drawObject[2 - args.only] = false;
        }

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(pass);
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
    return DynamicPrimitiveClipping.main(argc, argv);
}

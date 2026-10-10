// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace GraphicsPipelineLibrary {
    const WINDOW_TITLE = "Donut Example: Graphics Pipeline Library";

    // The sample's model (Vulkan-Samples' asset, hdr's copy: see VULKAN_SAMPLES_ASSETS_DIR in
    // CMakeLists.txt).
    const MODEL_PATH = "media/hdr/teapot.gltf";

    // Donut_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // struct UBO { float4x4 projection, model; float4 lightPos; }.
    const UBO_PROJECTION = 0;
    const UBO_MODEL = 16;
    const UBO_LIGHT_POS = 32;
    const UBO_FLOATS = 36;
    const LIGHT_POS = [-10.0, -5.0, 15.0, 0.0];
    // The push constants: float4 color.
    const PUSH_SIZE = 16;

    // The sample's random colors, one per cell (repeating after 16), in [0.2, 0.8).
    const COLOR_COUNT = 16;
    // Its lighting models: Phong, toon, no shading.
    const LIGHTING_MODELS = 3;

    // The sample's look-at camera at (0, 0, -7) (vkb::Camera's position, the view's translation),
    // turned -30 degrees around x; its perspective per cell.
    const CAMERA_POSITION = [0.0, 0.0, -7.0];
    const CAMERA_ROTATION = [-30.0, 0.0, 0.0];
    const CAMERA_FOV = 45.0;
    const Z_NEAR = 0.1;
    const Z_FAR = 256.0;

    // The render pass's clear color.
    const CLEAR_COLOR = [0.0, 0.0, 0.033, 0.0];

    // --- Math (glm's layout: 4 x 4 matrices by columns) ---------------------------------------

    function identity(): number[] {
        return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    }

    // a * b.
    function multiply(a: number[], b: number[]): number[] {
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
    function rotate(m: number[], angle: number, x: number, y: number, z: number): number[] {
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

    function radians(degrees: number): number {
        return degrees * Math.PI / 180.0;
    }

    // glm::perspective (right-handed, depth from 0 to 1).
    function perspective(fov: number, aspect: number, zNear: number, zFar: number): number[] {
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
        view(): number[] {
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
        mouseButton(button: int, action: int): void {
            if (button >= 0 && button < 3) {
                this.buttons[button] = action == 1;
            }
        }

        // ApiVulkanSample::handle_mouse_move, with its speeds (1).
        mouseMove(x: number, y: number): void {
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

    // Port of Vulkan-Samples' graphics_pipeline_library: a grid of spinning teapots, each drawn
    // with a pipeline of its own whose pixel shader uses a lighting model picked at random (Phong,
    // toon or none), in a random color; "Add pipeline" makes another (the grid grows when it's
    // full). The sample builds each pipeline by linking the libraries of its parts (vertex input,
    // pre-rasterization shaders, fragment output, made once) with a new fragment shader library,
    // on a background thread, optionally with link time optimization; NVRHI has no pipeline
    // libraries, so here each is an ordinary pipeline, made when asked for.
    class GraphicsPipelineLibraryPass {
        private app: App;
        private camera: SampleCamera;

        private vs: Opaque;
        private ps: Opaque[];
        private inputLayout: Opaque;
        private bindingLayout: Opaque;
        private bindingSet: BindingSet;
        private uniformBuffer: Opaque;
        private model: GltfMesh;
        private rng: Opaque;
        private colors: f32[];

        // The pipelines made so far (their lighting models), and the grid's size.
        private pipelines: Opaque[];
        lightingModels: int[];
        private splitX: int;
        private splitY: int;
        // Pipelines asked for and not made yet (made at the next frame, for the framebuffer).
        pendingPipelines: int;

        // The quarter-turns of the models: a fraction of a turn, 0.2 turns per second.
        private accumulatedTime: number;
        // -benchmark: 1/60 second per frame, as vulkan_samples' --benchmark.
        benchmark: boolean;

        // The depth buffer and a framebuffer per back buffer, for the back buffers' size.
        private depth: Opaque;
        private framebuffers: Opaque[];
        private targetWidth: int;
        private targetHeight: int;

        // Upload buffers.
        private ubo: f32[];
        private push: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
            this.ps = [];
            this.colors = [];
            this.pipelines = [];
            this.lightingModels = [];
            this.splitX = 3;
            this.splitY = 3;
            this.pendingPipelines = 0;
            this.accumulatedTime = 0.0;
            this.benchmark = false;
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
            this.push = [0.0, 0.0, 0.0, 0.0];
        }

        onMousePos(x: number, y: number): int {
            this.camera.mouseMove(x, y);
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            this.camera.mouseButton(button, action);
            return 1;
        }

        // The sample's render: the time accumulated in float, wrapped to [0, 1).
        onAnimate(elapsedSeconds: number): void {
            const deltaTime = Math.fround(this.benchmark ? 1.0 / 60.0 : elapsedSeconds);
            const time = Math.fround(this.accumulatedTime + Math.fround(Math.fround(0.2) * deltaTime));
            this.accumulatedTime = Math.fround(time - Math.floor(time));
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        // The framebuffers of the back buffers go before the back buffers do.
        onBackBufferResizing(): void {
            this.releaseTargets();
        }

        releaseTargets(): void {
            for (let i = 0; i < this.framebuffers.length; i++) {
                this.app.releaseResource(this.framebuffers[i]);
            }
            if (this.framebuffers.length > 0) {
                this.app.releaseResource(this.depth);
            }
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
        }

        createTargets(width: int, height: int): void {
            this.releaseTargets();
            this.depth = this.app.createDepthTexture(width, height, Format.D32, 1.0, "Depth");
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), this.depth));
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        // The sample's prepare_new_pipeline: a lighting model at random, the pipeline with it
        // (triangle lists, back faces culled with clockwise front faces, depth tested less or equal
        // and written, no blending); the grid grows by a row and a column when full.
        addPipeline(): void {
            const lightingModel = Math.min(Math.floor(Donut_RandomUniformFloat(this.rng, 0.0, LIGHTING_MODELS)), LIGHTING_MODELS - 1);
            const desc = GraphicsPipelineDesc.create(this.vs, this.ps[lightingModel]);
            desc.setInputLayout(this.inputLayout);
            desc.addBindingLayout(this.bindingLayout);
            desc.setDepthState(1, 1, ComparisonFunc.LessOrEqual);
            desc.setRasterState(CullMode.Back, FillMode.Solid, 0);
            this.pipelines.push(this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]));
            this.lightingModels.push(lightingModel);
            if (this.pipelines.length > this.splitX * this.splitY) {
                this.splitX++;
                this.splitY++;
            }
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }
            while (this.pendingPipelines > 0) {
                this.addPipeline();
                this.pendingPipelines--;
            }

            // The sample's update_uniform_buffers: a cell's projection (clip y negated for Donut),
            // the model turned around y by the time and half a turn around x.
            const w = width / this.splitX;
            const h = height / this.splitY;
            const projection = perspective(radians(CAMERA_FOV), w / h, Z_NEAR, Z_FAR);
            let modelview = rotate(this.camera.view(), radians(this.accumulatedTime * 360.0), 0.0, 1.0, 0.0);
            modelview = rotate(modelview, radians(180.0), 1.0, 0.0, 0.0);
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.ubo[UBO_MODEL + i] = modelview[i];
            }
            for (let i = 0; i < 4; i++) {
                this.ubo[UBO_LIGHT_POS + i] = LIGHT_POS[i];
            }
            commandList.writeBuffer(this.uniformBuffer, Ref(this.ubo[0]), UBO_FLOATS * 4);

            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), CLEAR_COLOR[0], CLEAR_COLOR[1], CLEAR_COLOR[2], CLEAR_COLOR[3]);
            commandList.clearDepth(this.depth, 1.0);
            const framebuffer = this.framebuffers[index];

            // The sample's build_command_buffers: a cell per pipeline, row by row, each drawn with
            // its color (the sample pushes a vec4 from its vec3 array: the next color's red as
            // alpha).
            let idx = 0;
            for (let y = 0; y < this.splitY; y++) {
                for (let x = 0; x < this.splitX; x++) {
                    if (idx < this.pipelines.length) {
                        const c = idx % COLOR_COUNT;
                        for (let k = 0; k < 4; k++) {
                            this.push[k] = this.colors[(c * 3 + k) % (COLOR_COUNT * 3)];
                        }
                        frame.beginDrawToFramebuffer(this.pipelines[idx], framebuffer);
                        frame.drawSetViewport(w * x, h * y, w, h);
                        frame.drawAddBindingSet(this.bindingSet);
                        frame.drawSetIndexBuffer(this.model.getIndexBuffer());
                        frame.drawAddVertexBuffer(this.model.getVertexBuffer(), 0, 0);
                        frame.drawIndexedWithPushConstants(this.model.getIndexCount(), Ref(this.push[0]), PUSH_SIZE);
                    }
                    idx++;
                }
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(seed: int): boolean {
            const shader = "graphics_pipeline_library.hlsl";
            this.vs = this.app.createShader(shader, "shared_vs", ShaderType.Vertex);
            if (!this.vs) {
                return false;
            }
            for (let m = 0; m < LIGHTING_MODELS; m++) {
                const ps = this.app.createShaderWithDefine(shader, "uber_ps", ShaderType.Pixel, "LIGHTING_MODEL", `${m}`);
                if (!ps) {
                    return false;
                }
                this.ps.push(ps);
            }

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vs);

            const commandList = this.app.createCommandList();
            commandList.open();
            this.model = this.app.loadGltfMesh(commandList, MODEL_PATH);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (this.model.isNull()) {
                console.log("Cannot load the model: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            this.uniformBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "UBO");
            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutVolatileConstantBuffer(0);
            bindingLayoutDesc.layoutPushConstants(1, PUSH_SIZE);
            this.bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.All);
            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.uniformBuffer);
            setDesc.bindPushConstants(1, PUSH_SIZE);
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);

            // The sample's random colors (its engine seeded from std::random_device unless -seed),
            // and its first pipeline.
            this.rng = this.app.createRandomEngine(seed);
            for (let i = 0; i < COLOR_COUNT * 3; i++) {
                this.colors.push(Donut_RandomUniformFloat(this.rng, 0.2, 0.8));
            }
            this.pendingPipelines++;

            const pass = this.app.addPass();
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
        private sample: GraphicsPipelineLibraryPass;

        constructor(sample: GraphicsPipelineLibraryPass) {
            this.sample = sample;
        }

        buildUI(): void {
            const sample = this.sample;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Graphics Pipeline Library", 1);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Settings") != 0) {
                if (Donut_ImGuiButton("Add pipeline") != 0) {
                    sample.pendingPipelines++;
                }
            }
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("graphics_pipeline_library");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the settings window.
        // -pipelines <n>: start with n pipelines (as if "Add pipeline" was pressed n - 1 times).
        // -seed <n>: the random colors' and lighting models' seed (random by default).
        // -benchmark: 1/60 second per frame (as vulkan_samples' --benchmark).
        let options = AppOptions.None;
        let withUI = true;
        let pipelines = 1;
        let seed = -1;
        let benchmark = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-benchmark") {
                benchmark = true;
            } else if (arg == "-pipelines" && i + 1 < argc) {
                i++;
                pipelines = Math.max(parseInt(Donut_GetArg(argv, i)), 1);
            } else if (arg == "-seed" && i + 1 < argc) {
                i++;
                seed = Math.max(parseInt(Donut_GetArg(argv, i)), 0);
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new GraphicsPipelineLibraryPass(app);
        sample.benchmark = benchmark;
        if (!sample.init(seed)) {
            app.destroy();
            return 1;
        }
        sample.pendingPipelines = pipelines;

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(sample);
        if (withUI && !gui.init(app)) {
            console.log("Cannot initialize the user interface");
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return GraphicsPipelineLibrary.main(argc, argv);
}

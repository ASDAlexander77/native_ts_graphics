// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace DynamicUniformBuffers {
    const WINDOW_TITLE = "Donut Example: Dynamic Uniform Buffers";

    // The cubes: a 5 x 5 x 5 grid, 5 units apart.
    const OBJECT_INSTANCES = 125;
    const DIM = 5;
    const OFFSET = 5.0;

    // Each cube's model matrix lives in its own slice of one constant buffer; D3D binds constant
    // buffers at multiples of 256 bytes (the sample's dynamic offsets are multiples of
    // minUniformBufferOffsetAlignment).
    const DYNAMIC_ALIGNMENT = 256;
    const DYNAMIC_FLOATS = DYNAMIC_ALIGNMENT / 4;

    // struct UboView { float4x4 projection, view; }.
    const UBO_PROJECTION = 0;
    const UBO_VIEW = 16;
    const UBO_FLOATS = 32;

    // The cube's vertices: float3 position, float3 color.
    const VERTEX_FLOATS = 6;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const CUBE_VERTICES = [
        -1.0, -1.0, 1.0, 1.0, 0.0, 0.0,
        1.0, -1.0, 1.0, 0.0, 1.0, 0.0,
        1.0, 1.0, 1.0, 0.0, 0.0, 1.0,
        -1.0, 1.0, 1.0, 0.0, 0.0, 0.0,
        -1.0, -1.0, -1.0, 1.0, 0.0, 0.0,
        1.0, -1.0, -1.0, 0.0, 1.0, 0.0,
        1.0, 1.0, -1.0, 0.0, 0.0, 1.0,
        -1.0, 1.0, -1.0, 0.0, 0.0, 0.0,
    ];
    const CUBE_INDICES = [
        0, 1, 2, 2, 3, 0, 1, 5, 6, 6, 2, 1, 7, 6, 5, 5, 4, 7,
        4, 0, 3, 3, 7, 4, 4, 5, 1, 1, 0, 4, 3, 2, 6, 6, 7, 3,
    ];

    // The sample's look-at camera at (0, 0, -30) (vkb::Camera's position, the view's translation),
    // not turned; reversed depth from 0.1 to 256.
    const CAMERA_POSITION = [0.0, 0.0, -30.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // ApiVulkanSample's default_clear_color.
    const CLEAR_COLOR = 0.002;

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

    // glm::perspective (right-handed, depth from 0 to 1); the sample swaps near and far for
    // reversed depth.
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
            this.rotation = [0.0, 0.0, 0.0];
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

    // Port of Vulkan-Samples' dynamic_uniform_buffers: 125 spinning colored cubes, one draw each,
    // all their model matrices in one uniform buffer. The sample binds one descriptor set with a
    // dynamic uniform buffer and passes each draw's offset into it; NVRHI has no dynamic offsets,
    // so here each cube has a binding set of its own slice of the buffer (the same buffer, written
    // once per update).
    class DynamicUniformBuffersPass {
        private app: App;
        private camera: SampleCamera;

        private vs: ShaderHandle;
        private ps: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private bindingLayout: BindingLayoutHandle;
        private bindingSets: BindingSet[];
        private viewBuffer: BufferHandle;
        private dynamicBuffer: BufferHandle;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;

        // The cubes' rotations and rotation speeds (x, y, z each), and the time since the last
        // update (the sample updates at 60 per second at most).
        private rotations: number[];
        private rotationSpeeds: number[];
        private animationTimer: number;
        private dynamicDirty: boolean;
        // -benchmark: 1/60 second per frame, and the random engine seeded with 0 (the framework's
        // lock_simulation_speed), as vulkan_samples' --benchmark.
        benchmark: boolean;
        // -pause: not animating (the sample's paused).
        paused: boolean;

        // The depth buffer and a framebuffer per back buffer, for the back buffers' size, and the
        // pipeline made for them.
        private depth: TextureHandle;
        private framebuffers: FramebufferHandle[];
        private targetWidth: int;
        private targetHeight: int;
        private pipeline: GraphicsPipelineHandle;
        private pipelineCreated: boolean;

        // Upload buffers.
        private ubo: f32[];
        private models: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
            this.bindingSets = [];
            this.rotations = [];
            this.rotationSpeeds = [];
            this.animationTimer = 0.0;
            this.dynamicDirty = true;
            this.benchmark = false;
            this.paused = false;
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.pipelineCreated = false;
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
            this.models = [];
            for (let i = 0; i < OBJECT_INSTANCES * DYNAMIC_FLOATS; i++) {
                this.models.push(0.0);
            }
        }

        onMousePos(x: number, y: number): int {
            this.camera.mouseMove(x, y);
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            this.camera.mouseButton(button, action);
            return 1;
        }

        // The sample's update_dynamic_uniform_buffer, at most 60 times a second: each cube's
        // rotations advanced by the time since the last update times its speeds (in float, as
        // the sample), its model matrix: moved to its place in the grid, turned around (1, 1, 0),
        // then y, then z.
        onAnimate(elapsedSeconds: number): void {
            if (!this.paused) {
                this.animationTimer = Math.fround(this.animationTimer + Math.fround(this.benchmark ? 1.0 / 60.0 : elapsedSeconds));
                if (this.animationTimer + 0.0025 >= Math.fround(1.0 / 60.0)) {
                    this.updateModels(this.animationTimer);
                    this.animationTimer = 0.0;
                }
            }
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        updateModels(time: number): void {
            const diagonal = 1.0 / Math.sqrt(2.0);
            for (let x = 0; x < DIM; x++) {
                for (let y = 0; y < DIM; y++) {
                    for (let z = 0; z < DIM; z++) {
                        const index = x * DIM * DIM + y * DIM + z;
                        for (let k = 0; k < 3; k++) {
                            this.rotations[index * 3 + k] = Math.fround(this.rotations[index * 3 + k]
                                + Math.fround(time * this.rotationSpeeds[index * 3 + k]));
                        }
                        let m = identity();
                        m[12] = -((DIM * OFFSET) / 2.0) + OFFSET / 2.0 + x * OFFSET;
                        m[13] = -((DIM * OFFSET) / 2.0) + OFFSET / 2.0 + y * OFFSET;
                        m[14] = -((DIM * OFFSET) / 2.0) + OFFSET / 2.0 + z * OFFSET;
                        m = rotate(m, this.rotations[index * 3], diagonal, diagonal, 0.0);
                        m = rotate(m, this.rotations[index * 3 + 1], 0.0, 1.0, 0.0);
                        m = rotate(m, this.rotations[index * 3 + 2], 0.0, 0.0, 1.0);
                        for (let i = 0; i < 16; i++) {
                            this.models[index * DYNAMIC_FLOATS + i] = m[i];
                        }
                    }
                }
            }
            this.dynamicDirty = true;
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
            this.depth = this.app.createDepthTexture(width, height, Format.D32, 0.0, "Depth");
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), this.depth));
            }
            // The sample's pipeline: no culling, depth tested (greater: reversed) and written.
            if (!this.pipelineCreated) {
                const desc = GraphicsPipelineDesc.create(this.vs, this.ps);
                desc.setInputLayout(this.inputLayout);
                desc.addBindingLayout(this.bindingLayout);
                desc.setDepthState(1, 1, ComparisonFunc.Greater);
                desc.setRasterState(CullMode.None, FillMode.Solid, 1);
                this.pipeline = this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]);
                this.pipelineCreated = true;
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            // The sample's update_uniform_buffers: its projection (clip y negated for Donut) and
            // view; the cubes' matrices when they changed.
            const projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.ubo[UBO_VIEW + i] = view[i];
            }
            commandList.writeBuffer(this.viewBuffer, Ref(this.ubo[0]), UBO_FLOATS * 4);
            if (this.dynamicDirty) {
                commandList.writeBuffer(this.dynamicBuffer, Ref(this.models[0]), OBJECT_INSTANCES * DYNAMIC_ALIGNMENT);
                this.dynamicDirty = false;
            }

            // The render pass: color cleared to the default clear color, depth to 0 (reversed).
            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
            commandList.clearDepth(this.depth, 0.0);
            const framebuffer = this.framebuffers[index];

            // One draw per cube, each with its slice of the buffer.
            for (let j = 0; j < OBJECT_INSTANCES; j++) {
                frame.beginDrawToFramebuffer(this.pipeline, framebuffer);
                frame.drawAddBindingSet(this.bindingSets[j]);
                frame.drawSetIndexBuffer(this.indexBuffer);
                frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
                frame.drawIndexed(CUBE_INDICES.length);
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "dynamic_uniform_buffers.hlsl";
            this.vs = this.app.createShader(shader, "base_vs", ShaderType.Vertex);
            this.ps = this.app.createShader(shader, "base_ps", ShaderType.Pixel);
            if (!this.vs || !this.ps) {
                return false;
            }

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("COLOR", Format.RGB32_FLOAT, 12, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vs);

            let vertices: f32[] = [];
            for (let i = 0; i < CUBE_VERTICES.length; i++) {
                vertices.push(CUBE_VERTICES[i]);
            }
            let indices: int[] = [];
            for (let i = 0; i < CUBE_INDICES.length; i++) {
                indices.push(CUBE_INDICES[i]);
            }
            const commandList = this.app.createCommandList();
            commandList.open();
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Vertices");
            this.indexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), indices.length * 4, "Indices");
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);

            // The view's buffer, and the cubes' (a slice each), with a binding set per cube.
            this.viewBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "UboView");
            this.dynamicBuffer = this.app.createConstantBuffer(OBJECT_INSTANCES * DYNAMIC_ALIGNMENT, "UboInstance");
            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutVolatileConstantBuffer(0);
            bindingLayoutDesc.layoutConstantBuffer(1);
            this.bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.Vertex);
            for (let j = 0; j < OBJECT_INSTANCES; j++) {
                const setDesc = BindingSetDesc.create();
                setDesc.bindEntireConstantBuffer(0, this.viewBuffer);
                setDesc.bindConstantBuffer(1, this.dynamicBuffer, j * DYNAMIC_ALIGNMENT, DYNAMIC_ALIGNMENT);
                this.bindingSets.push(this.app.createBindingSetForLayout(setDesc, this.bindingLayout));
            }

            // The sample's prepare_uniform_buffers: random rotations and speeds, from a normal
            // distribution of mean -1 and deviation 1 (the engine seeded with the time, or 0 with
            // -benchmark). MSVC evaluates the sample's vec3(rnd, rnd, rnd) from the last argument:
            // z, y, x.
            const rng = this.app.createRandomEngine(this.benchmark ? 0 : -1);
            let values: f32[] = [];
            for (let i = 0; i < OBJECT_INSTANCES * 6; i++) {
                values.push(0.0);
            }
            Donut_RandomNormalFloats(rng, -1.0, 1.0, values.length, Ref(values[0]));
            for (let i = 0; i < OBJECT_INSTANCES; i++) {
                for (let k = 0; k < 3; k++) {
                    this.rotations.push(Math.fround(Math.fround(values[i * 6 + 2 - k] * 2.0) * Math.fround(Math.PI)));
                    this.rotationSpeeds.push(values[i * 6 + 5 - k]);
                }
            }
            this.updateModels(0.0);

            const pass = this.app.addPass();
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("dynamic_uniform_buffers");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -benchmark: 1/60 second per frame and fixed random numbers (as vulkan_samples' --benchmark).
        // -pause: the cubes not turning.
        let options = AppOptions.None;
        let benchmark = false;
        let paused = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-benchmark") {
                benchmark = true;
            } else if (arg == "-pause") {
                paused = true;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new DynamicUniformBuffersPass(app);
        pass.benchmark = benchmark;
        pass.paused = paused;
        if (!pass.init()) {
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
    return DynamicUniformBuffers.main(argc, argv);
}

// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace RayQueries {
    const WINDOW_TITLE = "Donut Example: Ray Queries";

    // The sample's scene (Vulkan-Samples' assets, ray_tracing_extended's copy; see
    // VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt): only its geometry is used.
    const SCENE_PATH = "media/ray_tracing_extended/sponza/Sponza01.gltf";
    const SPONZA_SCALE = 0.01;

    // The sample's first person camera: turned 90 degrees around y, at (0, -2, 0) (vkb::Camera's
    // position, the view's translation).
    const CAMERA_ROTATION = [0.0, 90.0, 0.0];
    const CAMERA_POSITION = [0.0, -2.0, 0.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 0.1;
    const Z_FAR = 512.0;
    // ApiVulkanSample's default_clear_color.
    const CLEAR_COLOR = 0.002;

    // The light circles the scene: 100 units away, half a turn every 5 seconds.
    const PI = 3.14159;
    const LIGHT_RADIUS = 100.0;

    // Donut_LoadGltfModel's vertices: float3 position, float3 normal, float2 texture coordinates.
    const GLTF_VERTEX_FLOATS = 8;
    // The sample's vertices: float3 position, float3 normal.
    const VERTEX_FLOATS = 6;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;

    // struct GlobalUniform { float4x4 view, proj; float3 camera_position, light_position (16
    // bytes each); }.
    const UBO_VIEW = 0;
    const UBO_PROJ = 16;
    const UBO_CAMERA_POSITION = 32;
    const UBO_LIGHT_POSITION = 36;
    const UBO_FLOATS = 40;

    // nvrhi::rt::InstanceFlags::TriangleCullDisable.
    const INSTANCE_FLAGS_CULL_DISABLE = 1;

    const KEY_W = 87;
    const KEY_A = 65;
    const KEY_S = 83;
    const KEY_D = 68;
    const ACTION_RELEASE = 0;

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
            this.rotation = [CAMERA_ROTATION[0], CAMERA_ROTATION[1], CAMERA_ROTATION[2]];
            this.position = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.buttons = [false, false, false];
            this.keys = [false, false, false, false];
        }

        // vkb::Camera::update_view_matrix: rotations around x, y, z, then translate(position).
        view(): number[] {
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

        key(key: int, action: int): void {
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
        update(deltaTime: number): void {
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

    // Port of Vulkan-Samples' ray_queries: Sponza rasterized, each pixel shaded by ray queries
    // from its pixel shader (no ray tracing pipeline) against a TLAS of the scene: nine rays for
    // ambient occlusion, one towards a light circling the scene for a hard shadow. The scene's
    // vertices are in a vertex buffer for the rasterization and in acceleration structure input
    // buffers for the BLAS.
    class RayQueriesPass {
        private app: App;
        private camera: SampleCamera;

        private vs: ShaderHandle;
        private ps: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private bindingLayout: BindingLayoutHandle;
        private bindingSet: BindingSet;
        private globalBuffer: BufferHandle;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        private indexCount: int;
        private blas: TriangleBlas;
        private topLevelAS: SceneAccelStructs;
        private topLevelASBuilt: boolean;

        // The light's clock (milliseconds since the start), or a fixed time (-time).
        private timeMs: number;
        fixedTimeMs: number;

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
        private transform: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
            this.indexCount = 0;
            this.topLevelASBuilt = false;
            this.timeMs = 0.0;
            this.fixedTimeMs = -1.0;
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
                this.transform.push(i % 5 == 0 ? 1.0 : 0.0);
            }
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            this.camera.key(key, action);
            return 1;
        }

        onMousePos(x: number, y: number): int {
            this.camera.mouseMove(x, y);
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            this.camera.mouseButton(button, action);
            return 1;
        }

        onAnimate(elapsedSeconds: number): void {
            this.camera.update(elapsedSeconds);
            this.timeMs += elapsedSeconds * 1000.0;
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
            // The sample's pipeline: depth tested (less) and written, back faces culled
            // (counter-clockwise front faces), no blending.
            if (!this.pipelineCreated) {
                const desc = GraphicsPipelineDesc.create(this.vs, this.ps);
                desc.setInputLayout(this.inputLayout);
                desc.addBindingLayout(this.bindingLayout);
                desc.setDepthState(1, 1, ComparisonFunc.Less);
                desc.setRasterState(CullMode.Back, FillMode.Solid, 1);
                this.pipeline = this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]);
                this.pipelineCreated = true;
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        // The sample's update_uniform_buffers: the camera's view and projection (without the
        // Vulkan y flip: Donut's clip space is y-up), and the light: angle = mod(time * speed, pi)
        // with the time in whole milliseconds, in float as the sample computes it.
        updateUniforms(width: int, height: int): void {
            const u = this.ubo;
            const view = this.camera.view();
            const projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            for (let i = 0; i < 16; i++) {
                u[UBO_VIEW + i] = view[i];
                u[UBO_PROJ + i] = projection[i];
            }
            for (let i = 0; i < 3; i++) {
                u[UBO_CAMERA_POSITION + i] = this.camera.position[i];
            }
            const time = Math.fround(Math.floor(this.fixedTimeMs >= 0.0 ? this.fixedTimeMs : this.timeMs));
            const pi = Math.fround(PI);
            const speed = Math.fround(Math.fround(2.0 * pi) / 10000.0);
            const x = Math.fround(time * speed);
            const angle = Math.fround(x - Math.fround(pi * Math.floor(Math.fround(x / pi))));
            u[UBO_LIGHT_POSITION] = 0.0;
            u[UBO_LIGHT_POSITION + 1] = LIGHT_RADIUS * Math.fround(Math.sin(angle));
            u[UBO_LIGHT_POSITION + 2] = LIGHT_RADIUS * Math.fround(Math.cos(angle));
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            // The sample's create_top_level_acceleration_structure: the scene's BLAS once.
            if (!this.topLevelASBuilt) {
                this.topLevelAS.addInstanceWithTransform(this.blas.getAccelStruct(), 0xFF, 0, INSTANCE_FLAGS_CULL_DISABLE,
                    Ref(this.transform[0]));
                frame.buildTopLevelAS(this.topLevelAS);
                this.topLevelASBuilt = true;
            }

            this.updateUniforms(width, height);
            commandList.writeBuffer(this.globalBuffer, Ref(this.ubo[0]), UBO_FLOATS * 4);

            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
            commandList.clearDepth(this.depth, 1.0);
            frame.beginDrawToFramebuffer(this.pipeline, this.framebuffers[index]);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawSetIndexBuffer(this.indexBuffer);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            frame.drawIndexed(this.indexCount);
        }

        // The sample's load_scene: every node's meshes, positions pre-multiplied by the node's
        // world transform (and Sponza's scale, which also scales the translation: the sample
        // multiplies vec4(position, 1) by it), normals by its normal matrix (not normalized), into
        // one vertex and one index list; then create_bottom_level_acceleration_structure and
        // create_uniforms: a BLAS of them, and the buffers the rasterization reads.
        loadScene(commandList: CommandList): boolean {
            const scene = this.app.loadGltfModel(SCENE_PATH);
            if (scene.isNull()) {
                return false;
            }
            let vertices: f32[] = [];
            let indices: int[] = [];
            let m: f32[] = [];
            for (let i = 0; i < 16; i++) {
                m.push(0.0);
            }
            for (let node = 0; node < scene.getNodeCount(); node++) {
                const mesh = scene.getNodeMesh(node);
                scene.copyNodeTransform(node, Ref(m[0]));
                // transpose(inverse(mat3(m))): the cofactor matrix over the determinant.
                const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
                const c = [
                    a[4] * a[8] - a[5] * a[7], a[5] * a[6] - a[3] * a[8], a[3] * a[7] - a[4] * a[6],
                    a[2] * a[7] - a[1] * a[8], a[0] * a[8] - a[2] * a[6], a[1] * a[6] - a[0] * a[7],
                    a[1] * a[5] - a[2] * a[4], a[2] * a[3] - a[0] * a[5], a[0] * a[4] - a[1] * a[3],
                ];
                const det = a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
                for (let p = 0; p < scene.getPrimitiveCount(); p++) {
                    if (scene.getPrimitiveMesh(p) != mesh) {
                        continue;
                    }
                    const vertexStart = vertices.length / VERTEX_FLOATS;
                    const vertexCount = scene.getVertexCount(p);
                    const indexCount = scene.getIndexCount(p);
                    let gltfVertices: f32[] = [];
                    for (let i = 0; i < vertexCount * GLTF_VERTEX_FLOATS; i++) {
                        gltfVertices.push(0.0);
                    }
                    let gltfIndices: int[] = [];
                    for (let i = 0; i < indexCount; i++) {
                        gltfIndices.push(0);
                    }
                    scene.copyVertices(p, Ref(gltfVertices[0]));
                    scene.copyIndices(p, Ref(gltfIndices[0]));
                    for (let v = 0; v < vertexCount; v++) {
                        const g = v * GLTF_VERTEX_FLOATS;
                        const x = gltfVertices[g];
                        const y = gltfVertices[g + 1];
                        const z = gltfVertices[g + 2];
                        for (let row = 0; row < 3; row++) {
                            vertices.push(SPONZA_SCALE * (m[row] * x + m[4 + row] * y + m[8 + row] * z + m[12 + row]));
                        }
                        const nx = gltfVertices[g + 3];
                        const ny = gltfVertices[g + 4];
                        const nz = gltfVertices[g + 5];
                        // c holds the cofactors of mat3(m) transposed (it's read by rows from m's
                        // columns), so transpose(inverse) = cofactors / det has c[k * 3 + row] in row
                        // `row`, column k.
                        for (let row = 0; row < 3; row++) {
                            vertices.push((c[row] * nx + c[3 + row] * ny + c[6 + row] * nz) / det);
                        }
                    }
                    for (let i = 0; i < indexCount; i++) {
                        indices.push(vertexStart + gltfIndices[i]);
                    }
                }
            }
            this.app.releaseResource(scene.handle);

            const vertexCount = vertices.length / VERTEX_FLOATS;
            this.indexCount = indices.length;
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertexCount * VERTEX_SIZE, "Vertices");
            this.indexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), indices.length * 4, "Indices");

            const blasVertices = this.app.createAccelStructInputBuffer(vertexCount * VERTEX_SIZE, "BLAS Vertices");
            const blasIndices = this.app.createAccelStructInputBuffer(indices.length * 4, "BLAS Indices");
            commandList.writeBuffer(blasVertices, Ref(vertices[0]), vertexCount * VERTEX_SIZE);
            commandList.writeBuffer(blasIndices, Ref(indices[0]), indices.length * 4);
            this.blas = this.app.createEmptyTriangleBlas("BLAS");
            this.blas.addGeometry(blasIndices, 0, indices.length, blasVertices, 0, vertexCount, VERTEX_SIZE, null);
            return this.blas.build(this.app, commandList, AccelStructBuildFlags.PreferFastTrace) != 0;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "ray_queries.hlsl";
            this.vs = this.app.createShader(shader, "ray_shadow_vs", ShaderType.Vertex);
            this.ps = this.app.createShader(shader, "ray_shadow_ps", ShaderType.Pixel);
            if (!this.vs || !this.ps) {
                return false;
            }

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vs);

            const commandList = this.app.createCommandList();
            commandList.open();
            const loaded = this.loadScene(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded) {
                console.log("Cannot load the scene: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            this.topLevelAS = this.app.createTopLevelAS(1);
            this.globalBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "GlobalUniform");
            const layout = BindingLayoutDesc.create();
            layout.layoutVolatileConstantBuffer(0);
            layout.layoutAccelStruct(0);
            this.bindingLayout = this.app.createBindingLayout(layout, ShaderType.All);
            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.globalBuffer);
            setDesc.bindAccelStruct(0, this.topLevelAS.getTopLevelAS());
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);

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

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("ray_queries");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -time <ms>: the light where it is that many milliseconds after the start, not moving.
        let options = AppOptions.RayTracing;
        let fixedTimeMs = -1.0;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-time" && i + 1 < argc) {
                i++;
                fixedTimeMs = Math.max(parseFloat(Donut_GetArg(argv, i)), 0.0);
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.RayQuery)) {
            console.log("The graphics device does not support Ray Queries");
            app.destroy();
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new RayQueriesPass(app);
        pass.fixedTimeMs = fixedTimeMs;
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
    return RayQueries.main(argc, argv);
}

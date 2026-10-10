// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace VertexDynamicState {
    const WINDOW_TITLE = "Donut Example: Vertex Dynamic State";

    // The sample's models and HDR cube map (Vulkan-Samples' assets, hdr's copies: the KTX cube map
    // converted to DDS at build time, see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const CUBE_PATH = "media/hdr/cube.gltf";
    const ENVMAP_PATH = "media/hdr/uffizi_rgba16f_cube.dds";

    // Donut_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;
    const NORMAL_OFFSET = 12;
    // The sample's SampleVertex: float3 pos, float3 shaderUnusableData, float3 normal.
    const SAMPLE_VERTEX_FLOATS = 9;
    const SAMPLE_VERTEX_SIZE = SAMPLE_VERTEX_FLOATS * 4;
    const SAMPLE_NORMAL_OFFSET = 24;

    // struct UBO { float4x4 projection, modelview, skybox_modelview, inverse_modelview; float
    // modelscale; }, padded.
    const UBO_PROJECTION = 0;
    const UBO_MODELVIEW = 16;
    const UBO_SKYBOX_MODELVIEW = 32;
    const UBO_INVERSE_MODELVIEW = 48;
    const UBO_MODELSCALE = 64;
    const UBO_FLOATS = 68;
    const MODEL_SCALE = 0.15;

    // The sample's look-at camera at (0, 1, -6) (vkb::Camera's position, the view's translation),
    // not turned; reversed depth from 0.1 to 256.
    const CAMERA_POSITION = [0.0, 1.0, -6.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

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

    // The inverse of a rotation and translation (the view): the rotation transposed, the
    // translation turned back.
    function inverseRigid(m: number[]): number[] {
        let result = identity();
        for (let row = 0; row < 3; row++) {
            for (let column = 0; column < 3; column++) {
                result[column * 4 + row] = m[row * 4 + column];
            }
        }
        for (let row = 0; row < 3; row++) {
            let t = 0.0;
            for (let k = 0; k < 3; k++) {
                t -= m[row * 4 + k] * m[12 + k];
            }
            result[12 + row] = t;
        }
        return result;
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

    // Port of Vulkan-Samples' vertex_dynamic_state: hdr's skybox and a reflective cube, then a
    // second cube built in code whose vertices have a different layout (position, 12 unused bytes,
    // normal), drawn with the same shaders. The sample switches the vertex input layout as dynamic
    // state (VK_EXT_vertex_input_dynamic_state) between the draws; NVRHI's input layouts are part
    // of the pipelines, so here the object's pipeline exists once per layout.
    class VertexDynamicStatePass {
        private app: App;
        private camera: SampleCamera;

        private skyboxVS: ShaderHandle;
        private skyboxPS: ShaderHandle;
        private objectVS: ShaderHandle;
        private objectPS: ShaderHandle;
        private gltfLayout: InputLayoutHandle;
        private sampleLayout: InputLayoutHandle;
        private bindingLayout: BindingLayoutHandle;
        private bindingSet: BindingSet;
        private uniformBuffer: BufferHandle;
        private skybox: GltfMesh;
        private object: GltfMesh;
        private cubeVertexBuffer: BufferHandle;
        private cubeIndexBuffer: BufferHandle;
        private cubeIndexCount: int;

        // The depth buffer and a framebuffer per back buffer, for the back buffers' size, and the
        // pipelines made for them: the skybox's, and the object's for each vertex layout.
        private depth: TextureHandle;
        private framebuffers: Opaque[];
        private targetWidth: int;
        private targetHeight: int;
        private skyboxPipeline: Opaque;
        private modelPipeline: Opaque;
        private sampleModelPipeline: Opaque;
        private pipelinesCreated: boolean;

        // Upload buffer.
        private ubo: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
            this.cubeIndexCount = 0;
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.pipelinesCreated = false;
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
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

        onAnimate(elapsedSeconds: number): void {
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

        // The sample's create_pipeline: the skybox without depth, back faces culled
        // (counter-clockwise front faces); the object with depth tested (greater: reversed) and
        // written, front faces culled.
        createPipeline(vs: ShaderHandle, ps: ShaderHandle, inputLayout: InputLayoutHandle, object: boolean): Opaque {
            const desc = GraphicsPipelineDesc.create(vs, ps);
            desc.setInputLayout(inputLayout);
            desc.addBindingLayout(this.bindingLayout);
            desc.setDepthState(object ? 1 : 0, object ? 1 : 0, ComparisonFunc.Greater);
            desc.setRasterState(object ? CullMode.Front : CullMode.Back, FillMode.Solid, 1);
            return this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]);
        }

        createTargets(width: int, height: int): void {
            this.releaseTargets();
            this.depth = this.app.createDepthTexture(width, height, Format.D32, 0.0, "Depth");
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), this.depth));
            }
            if (!this.pipelinesCreated) {
                this.skyboxPipeline = this.createPipeline(this.skyboxVS, this.skyboxPS, this.gltfLayout, false);
                this.modelPipeline = this.createPipeline(this.objectVS, this.objectPS, this.gltfLayout, true);
                this.sampleModelPipeline = this.createPipeline(this.objectVS, this.objectPS, this.sampleLayout, true);
                this.pipelinesCreated = true;
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        draw(frame: Frame, pipeline: Opaque, framebuffer: Opaque, vertexBuffer: BufferHandle, indexBuffer: BufferHandle, indexCount: int): void {
            frame.beginDrawToFramebuffer(pipeline, framebuffer);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawSetIndexBuffer(indexBuffer);
            frame.drawAddVertexBuffer(vertexBuffer, 0, 0);
            frame.drawIndexed(indexCount);
        }

        onRender(frameHandle: FrameHandle): void {
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

            // The first vertex layout (the glTF loader's vertices): the skybox, the object.
            this.draw(frame, this.skyboxPipeline, framebuffer, this.skybox.getVertexBuffer(), this.skybox.getIndexBuffer(),
                this.skybox.getIndexCount());
            this.draw(frame, this.modelPipeline, framebuffer, this.object.getVertexBuffer(), this.object.getIndexBuffer(),
                this.object.getIndexCount());
            // The second (SampleVertex): the cube made in code.
            this.draw(frame, this.sampleModelPipeline, framebuffer, this.cubeVertexBuffer, this.cubeIndexBuffer, this.cubeIndexCount);
        }

        // The sample's model_data_creation: a cube of 8 corners, each with the normalized sum of its
        // faces' normals, scaled by 10 and moved by (-5, -20, -5).
        createCube(commandList: CommandList): void {
            const corners = [
                0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 1.0, 1.0,
            ];
            let vertices: f32[] = [];
            const invSqrt3 = 1.0 / Math.sqrt(3.0);
            for (let i = 0; i < 8; i++) {
                const x = corners[i * 3];
                const y = corners[i * 3 + 1];
                const z = corners[i * 3 + 2];
                vertices.push(x * 10.0 - 5.0);
                vertices.push(y * 10.0 - 20.0);
                vertices.push(z * 10.0 - 5.0);
                // shaderUnusableData
                vertices.push(0.0);
                vertices.push(0.0);
                vertices.push(0.0);
                vertices.push((x > 0.5 ? 1.0 : -1.0) * invSqrt3);
                vertices.push((y > 0.5 ? 1.0 : -1.0) * invSqrt3);
                vertices.push((z > 0.5 ? 1.0 : -1.0) * invSqrt3);
            }
            let indices: int[] = [
                0, 4, 3, 4, 7, 3,
                0, 3, 2, 0, 2, 1,
                1, 2, 6, 6, 5, 1,
                5, 6, 7, 7, 4, 5,
                0, 1, 5, 5, 4, 0,
                3, 7, 6, 6, 2, 3,
            ];
            this.cubeIndexCount = indices.length;
            this.cubeVertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Cube vertices");
            this.cubeIndexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), indices.length * 4, "Cube indices");
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "vertex_dynamic_state.hlsl";
            this.skyboxVS = this.app.createShaderWithDefine(shader, "gbuffer_vs", ShaderType.Vertex, "TYPE", "0");
            this.skyboxPS = this.app.createShaderWithDefine(shader, "gbuffer_ps", ShaderType.Pixel, "TYPE", "0");
            this.objectVS = this.app.createShaderWithDefine(shader, "gbuffer_vs", ShaderType.Vertex, "TYPE", "1");
            this.objectPS = this.app.createShaderWithDefine(shader, "gbuffer_ps", ShaderType.Pixel, "TYPE", "1");
            if (!this.skyboxVS || !this.skyboxPS || !this.objectVS || !this.objectPS) {
                return false;
            }

            // The two vertex layouts: position and normal, 32 or 36 bytes apart.
            const gltfLayoutDesc = InputLayoutDesc.create();
            gltfLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            gltfLayoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, NORMAL_OFFSET, 0, VERTEX_SIZE);
            this.gltfLayout = this.app.createInputLayout(gltfLayoutDesc, this.skyboxVS);
            const sampleLayoutDesc = InputLayoutDesc.create();
            sampleLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, SAMPLE_VERTEX_SIZE);
            sampleLayoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, SAMPLE_NORMAL_OFFSET, 0, SAMPLE_VERTEX_SIZE);
            this.sampleLayout = this.app.createInputLayout(sampleLayoutDesc, this.objectVS);

            // The cube map's sampler, as the framework's load_texture_cubemap: trilinear, clamped,
            // the device's widest anisotropic filtering.
            const sampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Clamp, 0.0, 0.0, 1000.0,
                this.app.getMaxSamplerAnisotropy());

            const commandList = this.app.createCommandList();
            commandList.open();
            this.skybox = this.app.loadGltfMesh(commandList, CUBE_PATH);
            this.object = this.app.loadGltfMesh(commandList, CUBE_PATH);
            const envmap = this.app.loadTexture(commandList, ENVMAP_PATH, 0);
            this.createCube(commandList);
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
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("vertex_dynamic_state");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        let options = AppOptions.None;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new VertexDynamicStatePass(app);
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
    return VertexDynamicState.main(argc, argv);
}

// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { unsupported } from "../core/test_check";

namespace DescriptorBufferBasic {
    const WINDOW_TITLE = "Donut Example: Descriptor Buffers";

    // The sample's cube and textures (Vulkan-Samples' assets: the cube fragment_shading_rate's
    // copy, the KTX textures push_descriptors' copies converted to DDS at build time, see
    // VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt), the textures as sRGB as the framework loads
    // color textures.
    const CUBE_PATH = "media/fragment_shading_rate/textured_unit_cube.gltf";
    const TEXTURE_PATHS = [
        "media/push_descriptors/crate01_color_height_rgba.dds",
        "media/push_descriptors/crate02_color_height_rgba.dds",
    ];

    // Donut_LoadGltfMesh's vertices: float3 position, float3 normal, float2 uv.
    const VERTEX_SIZE = 32;

    // The sets (one binding each): the scene's matrices, the cube's, its texture.
    const SET_SCENE = 0;
    const SET_MODEL = 1;
    const SET_TEXTURE = 2;
    // The descriptor buffers, as bound: the uniform buffers' (the scene's, then the cubes'), the
    // textures'.
    const BUFFER_UNIFORMS = 0;
    const BUFFER_IMAGES = 1;

    // struct UBOScene { float4x4 projection, view; }; struct UBOModel { float4x4 local; }.
    const SCENE_FLOATS = 32;
    const MODEL_FLOATS = 16;

    // The two cubes: their positions, the axis each turns around (x, then y) and how fast (degrees
    // a second).
    const CUBE_POSITIONS = [-2.0, 0.0, 0.0, 1.5, 0.5, 0.0];
    const CUBE_SPEEDS = [2.5, 2.0];

    // The sample's look-at camera, 5 units back, a 60 degree vertical field of view, depth reversed
    // (near 512, far 0.1, as the sample passes them).
    const CAMERA_POSITION = [0.0, 0.0, -5.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 512.0;
    const Z_FAR = 0.1;

    // ApiVulkanSample's default_clear_color.
    const CLEAR_COLOR = 0.002;

    // Test mode: the frames rendered, each 1/60 s.
    const TEST_FRAMES = 10;

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

    // glm::translate(identity, (x, y, z)).
    function translation(x: number, y: number, z: number): number[] {
        let m = identity();
        m[12] = x;
        m[13] = y;
        m[14] = z;
        return m;
    }

    function radians(degrees: number): number {
        return degrees * Math.PI / 180.0;
    }

    // glm::perspective (right-handed, depth from 0 to 1); with near > far, depth is reversed.
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

        // vkb::Camera::update_view_matrix: rotations around x, y, z; a look-at camera's view is
        // translate(position) * rotation.
        view(): number[] {
            let r = identity();
            r = rotate(r, radians(this.rotation[0]), 1.0, 0.0, 0.0);
            r = rotate(r, radians(this.rotation[1]), 0.0, 1.0, 0.0);
            r = rotate(r, radians(this.rotation[2]), 0.0, 0.0, 1.0);
            return multiply(translation(this.position[0], this.position[1], this.position[2]), r);
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

        // ApiVulkanSample's mouse wheel: zoom.
        mouseScroll(yoffset: number): void {
            this.position[2] += yoffset * 0.005;
        }
    }

    // --- Pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' descriptor_buffer_basic: two textured cubes drawn with one pipeline
    // whose descriptor sets (the scene's uniform buffer, the cube's, its texture: three sets of one
    // binding) live in two descriptor buffers (VK_EXT_descriptor_buffer) instead of pools: plain
    // buffers the CPU writes the descriptors into (vkGetDescriptorEXT), bound once
    // (vkCmdBindDescriptorBuffersEXT), each draw pointing its sets at offsets in them
    // (vkCmdSetDescriptorBufferOffsetsEXT). NVRHI has no descriptor buffers, so the buffers, the
    // pipeline and its draws are raw Vulkan in NVRHI's command list
    // (Donut_CreateDescriptorBufferPipeline). Vulkan only.
    class DescriptorBufferBasicPass {
        private app: App;
        private camera: SampleCamera;

        // The sample's setting, from its UI.
        animate: boolean;

        private vs: ShaderHandle;
        private ps: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private cube: GltfMesh;
        private sceneBuffer: BufferHandle;
        private modelBuffers: BufferHandle[];
        private textures: TextureHandle[];
        private sampler: SamplerHandle;
        // The cubes' turns (degrees), and the frame's time step.
        private rotations: number[];
        private deltaTime: number;

        // The depth buffer and a framebuffer per back buffer, for the back buffers' size, and the
        // pipeline made for them.
        private depth: TextureHandle;
        private framebuffers: FramebufferHandle[];
        private targetWidth: int;
        private targetHeight: int;
        private pipeline: DescriptorBufferPipeline;
        private pipelineCreated: boolean;
        // The descriptor buffers: the uniform buffers' descriptors (set 0's then set 1's
        // elements), the textures' (set 2's).
        private uniformDescriptors: DescriptorBuffer;
        private imageDescriptors: DescriptorBuffer;

        // Upload buffers.
        private scene: f32[];
        private model: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
            this.animate = true;
            this.modelBuffers = [];
            this.textures = [];
            this.rotations = [0.0, 0.0];
            this.deltaTime = 0.0;
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.pipelineCreated = false;
            this.scene = [];
            for (let i = 0; i < SCENE_FLOATS; i++) {
                this.scene.push(0.0);
            }
            this.model = [];
            for (let i = 0; i < MODEL_FLOATS; i++) {
                this.model.push(0.0);
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

        onMouseScroll(xoffset: number, yoffset: number): int {
            this.camera.mouseScroll(yoffset);
            return 1;
        }

        onAnimate(elapsedSeconds: number): void {
            this.deltaTime = elapsedSeconds;
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        // The framebuffers of the back buffers go before the back buffers do.
        onBackBufferResizing(): void {
            this.releaseTargets();
        }

        releaseTargets(): void {
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

        // The sample's setup_descriptor_set_layout, prepare_pipelines and
        // prepare_descriptor_buffer: three sets for descriptor buffers, two of a uniform buffer (the
        // vertex shader's), one of a combined image sampler (the pixel shader's); back faces
        // (counterclockwise ones) culled, depth tested (greater: reversed) and written. Then the
        // descriptor buffers, sized by the sets' sizes in them, and the descriptors written into
        // them: the scene's uniform buffer at element 0, each cube's at element 1 + its index; each
        // cube's texture at element its index.
        createTargets(width: int, height: int): boolean {
            this.releaseTargets();
            this.depth = this.app.createDepthTexture(width, height, Format.D32, 0.0, "Depth");
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), this.depth));
            }
            if (!this.pipelineCreated) {
                const pipeline = this.app.createDescriptorBufferPipeline(this.vs, this.ps, this.inputLayout, this.framebuffers[0],
                    CullMode.Back, 0, 1, 1, ComparisonFunc.Greater);
                if (pipeline.isNull()) {
                    return false;
                }
                pipeline.addSet(RawDescriptorType.ConstantBuffer, ShaderType.Vertex);
                pipeline.addSet(RawDescriptorType.ConstantBuffer, ShaderType.Vertex);
                pipeline.addSet(RawDescriptorType.TextureSampler, ShaderType.Pixel);
                if (pipeline.build() == 0) {
                    return false;
                }
                this.pipeline = pipeline;

                // Sets 0 and 1 have the same layout, so the same size: one stride for the buffer.
                const uniformDescriptors = this.app.createDescriptorBuffer(3 * pipeline.getSetSize(SET_SCENE), 0);
                const imageDescriptors = this.app.createDescriptorBuffer(2 * pipeline.getSetSize(SET_TEXTURE), 1);
                if (uniformDescriptors.isNull() || imageDescriptors.isNull()) {
                    return false;
                }
                uniformDescriptors.writeConstantBuffer(pipeline, SET_SCENE, 0, this.sceneBuffer);
                for (let i = 0; i < 2; i++) {
                    uniformDescriptors.writeConstantBuffer(pipeline, SET_MODEL, 1 + i, this.modelBuffers[i]);
                    imageDescriptors.writeTexture(pipeline, SET_TEXTURE, i, this.textures[i], this.sampler);
                }
                this.uniformDescriptors = uniformDescriptors;
                this.imageDescriptors = imageDescriptors;
                this.pipelineCreated = true;
            }
            this.targetWidth = width;
            this.targetHeight = height;
            return true;
        }

        // The sample's update_cube_uniform_buffers: each cube's model matrix, then (animated) its
        // turn advanced for the next frame.
        updateCubes(commandList: CommandList, deltaTime: number): void {
            for (let i = 0; i < 2; i++) {
                let m = translation(CUBE_POSITIONS[i * 3], CUBE_POSITIONS[i * 3 + 1], CUBE_POSITIONS[i * 3 + 2]);
                const rx = i == 0 ? this.rotations[0] : 0.0;
                const ry = i == 1 ? this.rotations[1] : 0.0;
                m = rotate(m, radians(rx), 1.0, 0.0, 0.0);
                m = rotate(m, radians(ry), 0.0, 1.0, 0.0);
                m = rotate(m, 0.0, 0.0, 0.0, 1.0);
                for (let k = 0; k < 16; k++) {
                    this.model[k] = m[k];
                }
                commandList.writeBuffer(this.modelBuffers[i], Ref(this.model[0]), MODEL_FLOATS * 4);
            }
            if (this.animate) {
                for (let i = 0; i < 2; i++) {
                    this.rotations[i] += CUBE_SPEEDS[i] * deltaTime;
                    if (this.rotations[i] > 360.0) {
                        this.rotations[i] -= 360.0;
                    }
                }
            }
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                if (!this.createTargets(width, height)) {
                    return;
                }
            }

            // The sample's update_uniform_buffers: its projection (clip y negated for Donut's
            // flipped viewport, which the descriptor buffer pass draws with too) and view.
            const projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            for (let i = 0; i < 16; i++) {
                this.scene[i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.scene[16 + i] = view[i];
            }
            commandList.writeBuffer(this.sceneBuffer, Ref(this.scene[0]), SCENE_FLOATS * 4);
            this.updateCubes(commandList, this.deltaTime);

            // The render pass: color cleared to the default clear color, depth to 0.
            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
            commandList.clearDepth(this.depth, 0.0);

            // The descriptor buffers bound once; the scene's set at the uniform buffer's element 0,
            // then per cube its uniform buffer's set and its texture's at their elements.
            const p = this.pipeline;
            p.begin(commandList, this.framebuffers[index]);
            p.bindBuffer(this.uniformDescriptors);
            p.bindBuffer(this.imageDescriptors);
            p.setOffset(SET_SCENE, BUFFER_UNIFORMS, 0);
            for (let i = 0; i < 2; i++) {
                p.setOffset(SET_MODEL, BUFFER_UNIFORMS, 1 + i);
                p.setOffset(SET_TEXTURE, BUFFER_IMAGES, i);
                p.drawIndexed(this.cube.getVertexBuffer(), this.cube.getIndexBuffer(), this.cube.getIndexCount());
            }
            p.end();
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "descriptor_buffer_basic.hlsl";
            this.vs = this.app.createShader(shader, "cube_vs", ShaderType.Vertex);
            this.ps = this.app.createShader(shader, "cube_ps", ShaderType.Pixel);
            if (!this.vs || !this.ps) {
                return false;
            }

            // The position and texture coordinates (locations 0 and 1).
            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vs);

            // load_assets.
            const commandList = this.app.createCommandList();
            commandList.open();
            this.cube = this.app.loadGltfMesh(commandList, CUBE_PATH);
            for (let i = 0; i < 2; i++) {
                this.textures.push(this.app.loadTexture(commandList, TEXTURE_PATHS[i], 1));
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (this.cube.isNull() || !this.textures[0] || !this.textures[1]) {
                console.log("Cannot load the cube and textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            // ApiVulkanSample::load_texture's sampler: trilinear, repeating, all the levels, the
            // device's widest anisotropic filtering.
            this.sampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Wrap, 0.0, 0.0, 1000.0,
                this.app.getMaxSamplerAnisotropy());

            // prepare_uniform_buffers: the scene's and each cube's (static: a descriptor in a
            // descriptor buffer holds a fixed address).
            this.sceneBuffer = this.app.createConstantBuffer(SCENE_FLOATS * 4, "UBOScene");
            for (let i = 0; i < 2; i++) {
                this.modelBuffers.push(this.app.createConstantBuffer(MODEL_FLOATS * 4, `UBOModel ${i}`));
            }

            if (!this.createTargets(this.app.getWindowWidth(), this.app.getWindowHeight())) {
                console.log("Cannot create the descriptor buffer pipeline");
                return false;
            }

            const pass = this.app.addPass();
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setMouseScrollCallback(this.onMouseScroll);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's overlay.
    class UserInterface {
        private sample: DescriptorBufferBasicPass;

        constructor(sample: DescriptorBufferBasicPass) {
            this.sample = sample;
        }

        buildUI(): void {
            const sample = this.sample;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Descriptor buffers", 1);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Settings") != 0) {
                sample.animate = Donut_ImGuiCheckbox("Animate", sample.animate ? 1 : 0) != 0;
            }
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    // -test: checks the last frame: the corners are the clear color; both cubes show their
    // textures (the left and right thirds of the frame's middle row differ from the background).
    function checkFrame(app: App): string {
        const width = app.getWindowWidth();
        const height = app.getWindowHeight();
        let pixels: int[] = [];
        for (let i = 0; i < width * height; i++) {
            pixels.push(0);
        }
        if (app.readBackBufferRGBA8(Ref(pixels[0]), pixels.length) == 0) {
            return "cannot read the back buffer";
        }
        const background = pixels[0] & 0xFFFFFF;
        const row = Math.floor(height / 2) * width;
        let left = 0;
        let right = 0;
        for (let x = 0; x < width; x++) {
            if ((pixels[row + x] & 0xFFFFFF) != background) {
                if (x < width / 2) {
                    left++;
                } else {
                    right++;
                }
            }
        }
        console.log(`Cube pixels on the middle row: left ${left}, right ${right}`);
        if (left < width / 20 || right < width / 20) {
            return "a cube is missing";
        }
        return "";
    }

    class DescriptorBufferBasicArgs extends Args {
        // -noanimate: the cubes don't turn.
        animate = true;

        protected parseOptions(): void {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-noanimate") {
                    this.animate = false;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("descriptor_buffer_basic");

        // -test [-testOutput <file>]: render a few frames without a window and check the last one
        // (see checkFrame).
        const args = new DescriptorBufferBasicArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // Descriptor buffers are asked for (the validation layer's shader instrumentation is off
        // with them).
        const options = AppOptions.DescriptorBuffers | args.options;

        // Descriptor buffers are Vulkan's.
        if (args.api != GraphicsAPI.VULKAN) {
            console.log("The Descriptor Buffers example can only run on Vulkan API.");
            return 1;
        }
        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        console.log(`Renderer: ${app.getRendererString()}`);
        if (app.hasDescriptorBuffers() == 0) {
            app.destroy();
            return unsupported(args.test, "The device doesn't support descriptor buffers (VK_EXT_descriptor_buffer).");
        }
        // Two descriptor buffers with resource descriptors are bound at once.
        if (app.getMaxResourceDescriptorBufferBindings() < 2) {
            console.log("The device can't bind two descriptor buffers (maxResourceDescriptorBufferBindings).");
            app.destroy();
            return 1;
        }

        const sample = new DescriptorBufferBasicPass(app);
        sample.animate = args.animate;
        if (!sample.init()) {
            app.destroy();
            return 1;
        }

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(sample);
        if (!args.noUI &&!gui.init(app)) {
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
function main(argc: int, argv: Ref<string>): int {
    return DescriptorBufferBasic.main(argc, argv);
}

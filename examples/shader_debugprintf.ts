// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { unsupported } from "../core/test_check";

namespace ShaderDebugPrintf {
    const WINDOW_TITLE = "Donut Example: Shader debugprintf";

    // The sample's model and texture (Vulkan-Samples' assets, fragment_shading_rate_dynamic's
    // copies: the KTX texture converted to DDS at build time, see VULKAN_SAMPLES_ASSETS_DIR in
    // CMakeLists.txt). The sky sphere and the spheres are the same geosphere.
    const MEDIA_DIR = "media/fragment_shading_rate_dynamic/";
    const GEOSPHERE_PATH = MEDIA_DIR + "geosphere.gltf";
    const SKYSPHERE_TEXTURE_PATH = MEDIA_DIR + "skysphere_rgba.dds";

    // Donut_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 8 * 4;

    // struct UBO { float4x4 projection, modelview, skybox_modelview; float modelscale; }, padded.
    const UBO_PROJECTION = 0;
    const UBO_MODELVIEW = 16;
    const UBO_SKYBOX_MODELVIEW = 32;
    const UBO_MODELSCALE = 48;
    const UBO_FLOATS = 52;
    const MODEL_SCALE = 0.05;
    // The push constants: float4 offset; float4 color; int object_type.
    const PUSH_FLOATS = 9;
    const PUSH_SIZE = PUSH_FLOATS * 4;
    const OBJECT_SKYSPHERE = 0;
    const OBJECT_SPHERE = 1;

    // The three spheres' offsets and colors.
    const MESH_OFFSETS = [-2.5, 0.0, 0.0, 0.0, 0.0, 0.0, 2.5, 0.0, 0.0];
    const MESH_COLORS = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

    // The sample's look-at camera at (0, 0, -6) turned 180 degrees around y, a 60 degree vertical
    // field of view, depth reversed (near 256, far 0.1, as the sample passes them).
    const CAMERA_POSITION = [0.0, 0.0, -6.0];
    const CAMERA_ROTATION = [0.0, 180.0, 0.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // What the sample keeps of the validation layer's messages: from the shader's text on.
    const PRINTF_PREFIX = "Position";

    // Test mode: the frames rendered, each 1/60 s; the layer reads a frame's output back once the
    // GPU has finished it, a frame or two later.
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
            this.rotation = [CAMERA_ROTATION[0], CAMERA_ROTATION[1], CAMERA_ROTATION[2]];
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

        // ApiVulkanSample's mouse wheel: zoom.
        mouseScroll(yoffset: number): void {
            this.position[2] += yoffset * 0.005;
        }
    }

    // --- Pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' shader_debugprintf: a sky sphere and three Phong-lit spheres, the
    // vertex shader printing (printf) the view space position of each draw's vertex 0. The
    // validation layer, its printf setting on, instruments the shaders to write the values to a
    // buffer, reads it back once the GPU has finished, and delivers the formatted text as
    // messages (VK_EXT_debug_utils), which the UI shows: AppOptions.ShaderPrintf and
    // Donut_UpdateShaderPrintfOutput. Vulkan only (D3D shaders have no printf).
    class ShaderDebugPrintfPass {
        private app: App;
        private camera: SampleCamera;

        // The sample's setting, from its UI.
        displaySkysphere: boolean;

        // The shader's text from the messages the last frame took (the sample's debug_output);
        // in test mode, every frame's.
        output: string[];
        allOutput: string[];
        keepAllOutput: boolean;

        private vs: ShaderHandle;
        private ps: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private bindingLayout: BindingLayoutHandle;
        private bindingSet: BindingSet;
        private uniformBuffer: BufferHandle;
        private geosphere: GltfMesh;

        // The depth buffer and a framebuffer per back buffer, for the back buffers' size, and the
        // pipelines made for them.
        private depth: TextureHandle;
        private framebuffers: FramebufferHandle[];
        private targetWidth: int;
        private targetHeight: int;
        private skyspherePipeline: GraphicsPipelineHandle;
        private spherePipeline: GraphicsPipelineHandle;
        private pipelinesCreated: boolean;

        // Upload buffers.
        private ubo: f32[];
        private push: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
            this.displaySkysphere = true;
            this.output = [];
            this.allOutput = [];
            this.keepAllOutput = false;
            this.framebuffers = [];
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

        // The messages the layer has delivered since the last call, cut to the shader's text as
        // the sample's debug_utils_message_callback does (copies: the layer's text goes with the
        // next update).
        takeOutput(): void {
            const count = this.app.updateShaderPrintfOutput();
            this.output = [];
            for (let i = 0; i < count; i++) {
                const message = this.app.getShaderPrintfLine(i);
                const start = message.indexOf(PRINTF_PREFIX);
                const text = start >= 0 ? message.substring(start, message.length) : message.substring(0, message.length);
                this.output.push(text);
                if (this.keepAllOutput) {
                    this.allOutput.push(text);
                }
            }
        }

        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            this.takeOutput();
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

        createTargets(width: int, height: int): void {
            this.releaseTargets();
            this.depth = this.app.createDepthTexture(width, height, Format.D32, 0.0, "Depth");
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), this.depth));
            }
            // The sample's pipelines: the sky sphere with back faces culled, not depth tested; the
            // spheres with front faces culled, depth tested (greater: reversed) and written.
            if (!this.pipelinesCreated) {
                const skyDesc = GraphicsPipelineDesc.create(this.vs, this.ps);
                skyDesc.setInputLayout(this.inputLayout);
                skyDesc.addBindingLayout(this.bindingLayout);
                skyDesc.setDepthState(0, 0, ComparisonFunc.Greater);
                skyDesc.setRasterState(CullMode.Back, FillMode.Solid, 1);
                this.skyspherePipeline = this.app.createGraphicsPipelineFromDesc(skyDesc, this.framebuffers[0]);
                const sphereDesc = GraphicsPipelineDesc.create(this.vs, this.ps);
                sphereDesc.setInputLayout(this.inputLayout);
                sphereDesc.addBindingLayout(this.bindingLayout);
                sphereDesc.setDepthState(1, 1, ComparisonFunc.Greater);
                sphereDesc.setRasterState(CullMode.Front, FillMode.Solid, 1);
                this.spherePipeline = this.app.createGraphicsPipelineFromDesc(sphereDesc, this.framebuffers[0]);
                this.pipelinesCreated = true;
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

            // The sample's update_uniform_buffers: its projection (clip y negated for Donut), the
            // view for the model view and the sky sphere's.
            const projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            const u = this.ubo;
            for (let i = 0; i < 16; i++) {
                u[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                u[UBO_MODELVIEW + i] = view[i];
                u[UBO_SKYBOX_MODELVIEW + i] = view[i];
            }
            u[UBO_MODELSCALE] = MODEL_SCALE;
            commandList.writeBuffer(this.uniformBuffer, Ref(u[0]), UBO_FLOATS * 4);

            // The render pass: color and depth cleared to 0.
            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), 0.0, 0.0, 0.0, 0.0);
            commandList.clearDepth(this.depth, 0.0);

            if (this.displaySkysphere) {
                frame.beginDrawToFramebuffer(this.skyspherePipeline, this.framebuffers[index]);
                frame.drawAddBindingSet(this.bindingSet);
                frame.drawSetIndexBuffer(this.geosphere.getIndexBuffer());
                frame.drawAddVertexBuffer(this.geosphere.getVertexBuffer(), 0, 0);
                for (let i = 0; i < 8; i++) {
                    this.push[i] = 0.0;
                }
                Donut_StoreInt32(Ref(this.push[8]), OBJECT_SKYSPHERE);
                frame.drawIndexedWithPushConstants(this.geosphere.getIndexCount(), Ref(this.push[0]), PUSH_SIZE);
            }

            frame.beginDrawToFramebuffer(this.spherePipeline, this.framebuffers[index]);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawSetIndexBuffer(this.geosphere.getIndexBuffer());
            frame.drawAddVertexBuffer(this.geosphere.getVertexBuffer(), 0, 0);
            for (let j = 0; j < 3; j++) {
                for (let k = 0; k < 3; k++) {
                    this.push[k] = MESH_OFFSETS[j * 3 + k];
                    this.push[4 + k] = MESH_COLORS[j * 3 + k];
                }
                this.push[3] = 0.0;
                this.push[7] = 0.0;
                Donut_StoreInt32(Ref(this.push[8]), OBJECT_SPHERE);
                frame.drawIndexedWithPushConstants(this.geosphere.getIndexCount(), Ref(this.push[0]), PUSH_SIZE);
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "shader_debugprintf.hlsl";
            this.vs = this.app.createShader(shader, "scene_vs", ShaderType.Vertex);
            this.ps = this.app.createShader(shader, "scene_ps", ShaderType.Pixel);
            if (!this.vs || !this.ps) {
                return false;
            }

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vs);

            const commandList = this.app.createCommandList();
            commandList.open();
            this.geosphere = this.app.loadGltfMesh(commandList, GEOSPHERE_PATH);
            // As the framework loads KTX 1 color textures: as sRGB.
            const texture = this.app.loadTexture(commandList, SKYSPHERE_TEXTURE_PATH, 1);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (this.geosphere.isNull() || !texture) {
                console.log("Cannot load the model and texture: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            // ApiVulkanSample::load_texture's sampler: linear, repeating, anisotropic at the device's
            // most.
            const sampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Wrap, 0.0, 0.0, 1000.0,
                this.app.getMaxSamplerAnisotropy());
            this.uniformBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "UBO");
            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutVolatileConstantBuffer(0);
            bindingLayoutDesc.layoutTextureSRV(0);
            bindingLayoutDesc.layoutSampler(0);
            bindingLayoutDesc.layoutPushConstants(1, PUSH_SIZE);
            this.bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.All);
            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.uniformBuffer);
            setDesc.bindTextureSRV(0, texture);
            setDesc.bindSampler(0, sampler);
            setDesc.bindPushConstants(1, PUSH_SIZE);
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);

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

    // The sample's overlay: its setting and the shader's output of the last frame.
    class UserInterface {
        private sample: ShaderDebugPrintfPass;

        constructor(sample: ShaderDebugPrintfPass) {
            this.sample = sample;
        }

        buildUI(): void {
            const sample = this.sample;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Shader debugprintf", 1);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Settings") != 0) {
                sample.displaySkysphere = Donut_ImGuiCheckbox("skysphere", sample.displaySkysphere ? 1 : 0) != 0;
            }
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Debug output") != 0) {
                for (let i = 0; i < sample.output.length; i++) {
                    Donut_ImGuiText(sample.output[i]);
                }
            }
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    // -test: checks the shader's output over the frames: printf's messages arrived, and every one
    // is the shader's text.
    function checkOutput(sample: ShaderDebugPrintfPass): string {
        const output = sample.allOutput;
        console.log(`${output.length} printf messages`);
        for (let i = 0; i < output.length && i < 8; i++) {
            console.log(output[i]);
        }
        if (output.length == 0) {
            return "no printf output arrived";
        }
        for (let i = 0; i < output.length; i++) {
            if (output[i].indexOf(PRINTF_PREFIX) != 0) {
                return `unexpected message: ${output[i]}`;
            }
        }
        return "";
    }

    class ShaderDebugPrintfArgs extends Args {
        // -nosky: without the sky sphere.
        noSky = false;

        protected parseOptions(): void {
            for (let i = 1; i < this.argc; i++) {
                if (this[i] == "-nosky") {
                    this.noSky = true;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("shader_debugprintf");

        // -test [-testOutput <file>]: render a few frames without a window and check the shader's
        // output (see checkOutput).
        const args = new ShaderDebugPrintfArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // printf in shaders is the Vulkan validation layer's.
        if (args.api != GraphicsAPI.VULKAN) {
            console.log("The Shader debugprintf example can only run on Vulkan API.");
            return 1;
        }
        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, AppOptions.ShaderPrintf | args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        console.log(`Renderer: ${app.getRendererString()}`);
        if (app.hasShaderPrintf() == 0) {
            app.destroy();
            return unsupported(args.test, "Shader printf needs the Vulkan validation layer (VK_LAYER_KHRONOS_validation, from the Vulkan SDK).");
        }

        const sample = new ShaderDebugPrintfPass(app);
        sample.displaySkysphere = !args.noSky;
        sample.keepAllOutput = args.test;
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
            // The last frames' output, which the layer delivers once they're finished.
            app.waitForIdle();
            sample.takeOutput();
            result = app.finishTest(checkOutput(sample));
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return ShaderDebugPrintf.main(argc, argv);
}

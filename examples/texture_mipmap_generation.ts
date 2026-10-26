// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck } from "../core/test_check";
import { identity, multiply, rotate, radians, perspective } from "../core/matrix";

namespace TextureMipmapGeneration {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame: the checkered tunnel, about 45% white; in the distance, around
    // the middle, the generated mip levels blur the checks to mid gray (about a fifth of a 300x200
    // rectangle there; without mipmaps it's black and white).
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        const white = check.share(check.countInRange(221, 255, 221, 255, 221, 255, 0, 0, check.width, check.height), total,
            38.0, 52.0, "White");
        if (white != "") {
            return white;
        }
        return check.share(check.countInRange(60, 200, 60, 200, 60, 200, check.width / 2 - 150, check.height / 2 - 100,
            300, 200), 300 * 200, 12.0, 40.0, "Mid gray in the distance");
    }

    const WINDOW_TITLE = "Donut Example: Texture MipMap Generation";

    // The sample's model and texture (Vulkan-Samples' assets): a tunnel, and a checkerboard whose
    // first level only is used (the KTX texture converted to DDS at build time, see
    // VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const MODEL_PATH = "media/texture_mipmap_generation/tunnel_cylinder.gltf";
    const TEXTURE_PATH = "media/texture_mipmap_generation/checkerboard_rgba.dds";

    // Donut_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 8 * 4;

    // The sample's UBO: float4x4 projection, modelview; float lodBias; int samplerIndex; padded.
    const UBO_PROJECTION = 0;
    const UBO_MODELVIEW = 16;
    const UBO_LOD_BIAS = 32;
    const UBO_SAMPLER_INDEX = 33;
    const UBO_FLOATS = 36;

    // The sample's first person camera at (0, 0, -12.5) (as the view's translation), a 60 degree
    // vertical field of view, depth from 0.1 to 1024.
    const CAMERA_TRANSLATION = [0.0, 0.0, -12.5];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 0.1;
    const Z_FAR = 1024.0;

    // The sample's samplers, as its UI names them.
    const SAMPLER_NAMES = "No mip maps|Mip maps (bilinear)|Mip maps (anisotropic)";

    // The framework's default clear color.
    const CLEAR_COLOR = 0.002;

    // The sample's camera (the framework's vkb::Camera, first person type), with ApiVulkanSample's
    // controls: the left mouse button turns it, the right one zooms, the middle one pans; W, A, S, D
    // move it.
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
            this.position = [CAMERA_TRANSLATION[0], CAMERA_TRANSLATION[1], CAMERA_TRANSLATION[2]];
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

        key(key: Key, action: Action) {
            const down = action != Action.Release;
            if (key == Key.W) {
                this.keys[0] = down;
            } else if (key == Key.S) {
                this.keys[1] = down;
            } else if (key == Key.A) {
                this.keys[2] = down;
            } else if (key == Key.D) {
                this.keys[3] = down;
            }
        }

        // vkb::Camera::update: first person movement, 1 unit per second.
        update(deltaTime: number) {
            const rx = radians(this.rotation[0]);
            const ry = radians(this.rotation[1]);
            const front = [-Math.cos(rx) * Math.sin(ry), Math.sin(rx), Math.cos(rx) * Math.cos(ry)];
            const length = Math.sqrt(front[0] * front[0] + front[1] * front[1] + front[2] * front[2]);
            for (let i = 0; i < 3; i++) {
                front[i] /= length;
            }
            // normalize(cross(front, (0, 1, 0))).
            const right = [-front[2], 0.0, front[0]];
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
        mouseButton(button: MouseButton, action: Action) {
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

    // Port of Vulkan-Samples' texture_mipmap_generation: a texture's first level loaded, its whole
    // mip chain generated on the GPU (each level from the one above, filtered linearly), and a
    // tunnel textured with it through three samplers: without mip maps (levels of detail clamped to
    // 0), with mip maps, and with mip maps and anisotropic filtering; a level of detail bias from
    // the UI.
    class TextureMipmapGenerationPass {
        private app: App;
        private camera: SampleCamera;

        // The sample's settings, from its UI.
        rotateScene: boolean;
        lodBias: number;
        samplerIndex: int;
        mipLevels: int;
        private timer: number;

        private pipeline: GraphicsPipelineHandle;
        private bindingSet: BindingSet;
        private uniformBuffer: BufferHandle;
        private mesh: GltfMesh;

        // The depth buffer and a framebuffer per back buffer, for the back buffers' size.
        private depth: TextureHandle;
        private framebuffers: FramebufferHandle[];
        private targetWidth: int;
        private targetHeight: int;

        // Upload buffer.
        private ubo: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
            this.rotateScene = false;
            this.lodBias = 0.0;
            this.samplerIndex = 2;
            this.mipLevels = 1;
            this.timer = 0.0;
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
        }

        init() {
            const shader = "texture_mipmap_generation.hlsl";
            const vs = this.app.createShader(shader, "main_vs", ShaderType.Vertex);
            const ps = this.app.createShader(shader, "main_ps", ShaderType.Pixel);
            if (!vs || !ps) {
                return false;
            }

            const commandList = this.app.createCommandList();
            commandList.open();
            const texture = this.loadTextureGenerateMipmaps(commandList);
            this.mesh = this.app.loadGltfMesh(commandList, MODEL_PATH);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!texture || this.mesh.isNull()) {
                console.log("Cannot load the model and texture: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            // The sample's samplers: linear, repeating; without mip maps (levels of detail up to 0),
            // with mip maps (up to the mip level count), and with anisotropic filtering too, at the
            // device's most.
            const maxLod = this.mipLevels;
            const noMipMaps = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Wrap, 0.0, 0.0, 0.0, 1.0);
            const mipMaps = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Wrap, 0.0, 0.0, maxLod, 1.0);
            const anisotropic = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Wrap, 0.0, 0.0, maxLod,
                this.app.getMaxSamplerAnisotropy());

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_SIZE);
            const inputLayout = this.app.createInputLayout(layoutDesc, vs);

            this.uniformBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "UBO");
            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutVolatileConstantBuffer(0);
            bindingLayoutDesc.layoutTextureSRV(0);
            bindingLayoutDesc.layoutSampler(0);
            bindingLayoutDesc.layoutSampler(1);
            bindingLayoutDesc.layoutSampler(2);
            const bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.All);
            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.uniformBuffer);
            setDesc.bindTextureSRV(0, texture as TextureHandle);
            setDesc.bindSampler(0, noMipMaps);
            setDesc.bindSampler(1, mipMaps);
            setDesc.bindSampler(2, anisotropic);
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, bindingLayout);

            // The sample's pipeline: depth test (less or equal) and write, no culling.
            this.createTargets(this.app.getWindowWidth(), this.app.getWindowHeight());
            const desc = GraphicsPipelineDesc.create(vs, ps);
            desc.setInputLayout(inputLayout);
            desc.addBindingLayout(bindingLayout);
            desc.setDepthState(1, 1, ComparisonFunc.LessOrEqual);
            desc.setRasterState(CullMode.None, FillMode.Solid, 1);
            this.pipeline = this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]);

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

        // The sample's render: the rotation advances while the scene rotates.
        onAnimate(elapsedSeconds: number) {
            this.camera.update(elapsedSeconds);
            if (this.rotateScene) {
                this.timer += elapsedSeconds * 0.005;
                if (this.timer > 1.0) {
                    this.timer -= 1.0;
                }
            }
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

        createTargets(width: int, height: int) {
            this.releaseTargets();
            this.depth = this.app.createDepthTexture(width, height, Format.D32, 1.0, "Depth");
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), this.depth));
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            // The sample's update_uniform_buffers: its projection (clip y negated for Donut), the
            // view turned by 90 degrees (and the timer) around z and scaled by 0.5.
            const projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            let model = rotate(this.camera.view(), radians(90.0 + this.timer * 360.0), 0.0, 0.0, 1.0);
            for (let i = 0; i < 12; i++) {
                model[i] *= 0.5;
            }
            const u = this.ubo;
            for (let i = 0; i < 16; i++) {
                u[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                u[UBO_MODELVIEW + i] = model[i];
            }
            u[UBO_LOD_BIAS] = this.lodBias;
            RawMemory.storeInt32(Ref(u[UBO_SAMPLER_INDEX]), this.samplerIndex);
            commandList.writeBuffer(this.uniformBuffer, Ref(u[0]), UBO_FLOATS * 4);

            // The render pass: the framework's clear color, depth cleared to 1.
            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
            commandList.clearDepth(this.depth, 1.0);
            frame.beginDrawToFramebuffer(this.pipeline, this.framebuffers[index]);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawSetIndexBuffer(this.mesh.getIndexBuffer());
            frame.drawAddVertexBuffer(this.mesh.getVertexBuffer(), 0, 0);
            frame.drawIndexed(this.mesh.getIndexCount());
        }

        // The sample's load_texture_generate_mipmaps: the texture's first level copied into a
        // texture with the whole chain (1 + floor(log2(max(width, height))) levels), in sRGB as the
        // sample takes KTX 1 files; then each level drawn from the one above, recorded into an open
        // command list.
        loadTextureGenerateMipmaps(commandList: CommandList) {
            const staging = this.app.loadStagingTexture(TEXTURE_PATH);
            if (staging.isNull()) {
                return null;
            }
            const width = staging.getWidth();
            const height = staging.getHeight();
            // 1 + floor(log2(max(width, height))).
            this.mipLevels = 1;
            while ((Math.max(width, height) >> this.mipLevels) > 0) {
                this.mipLevels++;
            }
            const texture = this.app.createMipmappedRenderTarget(width, height, this.mipLevels, Format.SRGBA8_UNORM, "Checkerboard");
            commandList.copyStagingTextureRegion(texture, 0, 0, 0, staging, 0, 0, width, height);

            const shader = "texture_mipmap_generation.hlsl";
            const vs = this.app.createShader(shader, "downsample_vs", ShaderType.Vertex);
            const ps = this.app.createShader(shader, "downsample_ps", ShaderType.Pixel);
            if (!vs || !ps) {
                return null;
            }
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutTextureSRV(0);
            layoutDesc.layoutSampler(0);
            const bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.Pixel);
            const linearClamp = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Clamp, 0.0, 0.0, 0.0, 1.0);

            // The sample's blits: each level from the one above, in order.
            if (this.mipLevels > 1) {
                const desc = GraphicsPipelineDesc.create(vs, ps);
                desc.addBindingLayout(bindingLayout);
                desc.setDepthState(0, 0, ComparisonFunc.Always);
                desc.setRasterState(CullMode.None, FillMode.Solid, 0);
                const pipeline = this.app.createGraphicsPipelineFromDesc(desc, this.app.createFramebufferForMip(texture, 1));
                for (let level = 1; level < this.mipLevels; level++) {
                    const setDesc = BindingSetDesc.create();
                    setDesc.bindTextureSRVMip(0, texture, level - 1);
                    setDesc.bindSampler(0, linearClamp);
                    const bindingSet = this.app.createBindingSetForLayout(setDesc, bindingLayout);
                    commandList.draw(pipeline, this.app.createFramebufferForMip(texture, level), bindingSet, 3);
                }
            }
            return texture;
        }
    }

    // The sample's settings.
    class UserInterface {
        private pass: TextureMipmapGenerationPass;

        constructor(pass: TextureMipmapGenerationPass) {
            this.pass = pass;
        }

        init(app: App) {
            return !app.addImGuiPass(this.buildUI).isNull();
        }

        buildUI() {
            const p = this.pass;
            ImGui.setNextWindowPos(10.0, 10.0);
            ImGui.begin("Options", true);
            if (ImGui.collapsingHeaderDefaultOpen("Settings")) {
                p.rotateScene = ImGui.checkbox("Rotate", p.rotateScene);
                p.lodBias = ImGui.sliderFloat("LOD bias", p.lodBias, 0.0, p.mipLevels);
                p.samplerIndex = ImGui.combo("Sampler type", p.samplerIndex, SAMPLER_NAMES);
            }
            ImGui.end();
        }
    }

    class TextureMipmapGenerationArgs extends Args {
        // -sampler <n>: sampler 0 (no mip maps), 1 (mip maps) or 2 (anisotropic, the default).
        samplerIndex = 2;
        // -lodbias <x>: the level of detail bias.
        lodBias = 0.0;
        // -rotate: the scene rotating.
        rotateScene = false;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-sampler" && i + 1 < this.argc) {
                    this.samplerIndex = Math.min(2, Math.max(0, parseInt(this[i + 1])));
                    i++;
                } else if (arg == "-lodbias" && i + 1 < this.argc) {
                    this.lodBias = parseFloat(this[i + 1]);
                    i++;
                } else if (arg == "-rotate") {
                    this.rotateScene = true;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Program.setAppName("texture_mipmap_generation");

        const args = new TextureMipmapGenerationArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new TextureMipmapGenerationPass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }
        pass.samplerIndex = args.samplerIndex;
        pass.lodBias = args.lodBias;
        pass.rotateScene = args.rotateScene;

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
    return TextureMipmapGeneration.main(argc, argv);
}

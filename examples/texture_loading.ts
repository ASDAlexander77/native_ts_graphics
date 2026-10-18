// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck } from "../core/test_check";
import { radians, perspective } from "../core/matrix";
import { SampleView } from "../core/vulkan_samples_camera";

namespace TextureLoading {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame. The corners are the dark clear color; the textured quad covers
    // about 28% of the frame, with the texture's glowing cyan center in the middle.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        const corners = check.corners(0x070707);
        if (corners != "") {
            return corners;
        }
        const middle = check.rgb(check.width / 2, check.height / 2);
        if (((middle >> 16) & 0xFF) < 200 || ((middle >> 8) & 0xFF) < 200) {
            return "the middle of the texture isn't its cyan glow";
        }
        return check.share(check.countOtherThan(0x070707, 0, 0, check.width, check.height), check.width * check.height,
            20.0, 35.0, "Quad");
    }

    const WINDOW_TITLE = "Donut Example: Texture Loading";

    // The sample's texture (Vulkan-Samples' asset, fragment_shading_rate's copy: the KTX file and
    // its mip levels converted to DDS at build time, see VULKAN_SAMPLES_ASSETS_DIR in
    // CMakeLists.txt), loaded as sRGB as the sample forces.
    const TEXTURE_PATH = "media/fragment_shading_rate/metalplate01_rgba.dds";
    const MIP_LEVELS = 10;

    // The quad's vertices: float3 position, float2 uv, float3 normal.
    const VERTEX_FLOATS = 8;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const QUAD_VERTICES = [
        1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0,
        -1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0,
        -1.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        1.0, -1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0,
    ];
    const QUAD_INDICES = [0, 1, 2, 2, 3, 0];

    // struct UBO { float4x4 projection, model; float4 viewPos; float lodBias; }, padded.
    const UBO_PROJECTION = 0;
    const UBO_MODEL = 16;
    const UBO_VIEW_POS = 32;
    const UBO_LOD_BIAS = 36;
    const UBO_FLOATS = 40;

    // The sample's view: ApiVulkanSample's zoom and rotation (degrees), its projection.
    const ZOOM = -2.5;
    const ROTATION = [0.0, 15.0, 0.0];
    const FOV = 60.0;
    const Z_NEAR = 0.001;
    const Z_FAR = 256.0;

    // ApiVulkanSample's default_clear_color.
    const CLEAR_COLOR = 0.002;

    // --- Pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' texture_loading: a quad with a texture loaded with all its mip levels
    // (the sample uploads a KTX file's levels through a staging buffer), lit by a light at the eye,
    // sampled trilinearly with anisotropic filtering and a level of detail bias set in the UI.
    class TextureLoadingPass {
        private app: App;
        private view: SampleView;

        // The sample's setting.
        lodBias: number;

        private vs: ShaderHandle;
        private ps: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private bindingLayout: BindingLayoutHandle;
        private bindingSet: BindingSet;
        private uniformBuffer: BufferHandle;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;

        // The depth buffer and a framebuffer per back buffer, for the back buffers' size, and the
        // pipeline made for them.
        private depth: TextureHandle;
        private framebuffers: FramebufferHandle[];
        private targetWidth: int;
        private targetHeight: int;
        private pipeline: GraphicsPipelineHandle;
        private pipelineCreated: boolean;

        // Upload buffer.
        private ubo: f32[];

        constructor(app: App) {
            this.app = app;
            this.view = new SampleView(ZOOM, ROTATION);
            this.lodBias = 0.0;
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.pipelineCreated = false;
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
        }

        init() {
            const shader = "texture_loading.hlsl";
            this.vs = this.app.createShader(shader, "texture_vs", ShaderType.Vertex);
            this.ps = this.app.createShader(shader, "texture_ps", ShaderType.Pixel);
            if (!this.vs || !this.ps) {
                return false;
            }

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 12, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 20, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vs);

            let vertices = QUAD_VERTICES.map((v): f32 => v);
            let indices = QUAD_INDICES.map((v): int => v);
            const commandList = this.app.createCommandList();
            commandList.open();
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Vertices");
            this.indexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), indices.length * 4, "Indices");
            const texture = this.app.loadTexture(commandList, TEXTURE_PATH, 1);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!texture) {
                console.log("Cannot load the texture: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            // The sample's sampler: trilinear, repeating, all the levels, the device's widest
            // anisotropic filtering.
            const sampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Wrap, 0.0, 0.0, MIP_LEVELS,
                this.app.getMaxSamplerAnisotropy());
            this.uniformBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "UBO");
            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutVolatileConstantBuffer(0);
            bindingLayoutDesc.layoutTextureSRV(0);
            bindingLayoutDesc.layoutSampler(0);
            this.bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.All);
            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.uniformBuffer);
            setDesc.bindTextureSRV(0, texture);
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

        onMousePos(x: number, y: number) {
            this.view.mouseMove(x, y);
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int) {
            this.view.mouseButton(button, action);
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
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
        }

        createTargets(width: int, height: int) {
            this.releaseTargets();
            this.depth = this.app.createDepthTexture(width, height, Format.D32, 0.0, "Depth");
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), this.depth));
            }
            // The sample's pipeline: no culling, depth tested (greater) and written.
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

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            // The sample's update_uniform_buffers: its projection (clip y negated for Donut), the
            // quad's model view, the eye.
            const projection = perspective(radians(FOV), width / height, Z_NEAR, Z_FAR);
            const model = this.view.model();
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.ubo[UBO_MODEL + i] = model[i];
            }
            this.ubo[UBO_VIEW_POS] = 0.0;
            this.ubo[UBO_VIEW_POS + 1] = 0.0;
            this.ubo[UBO_VIEW_POS + 2] = -this.view.zoom;
            this.ubo[UBO_LOD_BIAS] = this.lodBias;
            commandList.writeBuffer(this.uniformBuffer, Ref(this.ubo[0]), UBO_FLOATS * 4);

            // The render pass: color cleared to the default clear color, depth to 0.
            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
            commandList.clearDepth(this.depth, 0.0);

            frame.beginDrawToFramebuffer(this.pipeline, this.framebuffers[index]);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawSetIndexBuffer(this.indexBuffer);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            frame.drawIndexed(QUAD_INDICES.length);
        }
    }

    // The sample's overlay.
    class UserInterface {
        private sample: TextureLoadingPass;

        constructor(sample: TextureLoadingPass) {
            this.sample = sample;
        }

        init(app: App) {
            return !app.addImGuiPass(this.buildUI).isNull();
        }

        buildUI() {
            const sample = this.sample;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Texture Loading", 1);
            Donut_ImGuiPushItemWidth(110.0);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Settings") != 0) {
                sample.lodBias = Donut_ImGuiSliderFloat("LOD bias", sample.lodBias, 0.0, MIP_LEVELS);
            }
            Donut_ImGuiPopItemWidth();
            Donut_ImGuiEnd();
        }
    }

    class TextureLoadingArgs extends Args {
        // -lodbias <value>: the initial level of detail bias.
        lodBias = 0.0;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-lodbias" && i + 1 < this.argc) {
                    i++;
                    this.lodBias = Math.min(Math.max(parseFloat(this[i]), 0.0), MIP_LEVELS);
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("texture_loading");

        const args = new TextureLoadingArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new TextureLoadingPass(app);
        sample.lodBias = args.lodBias;
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
    return TextureLoading.main(argc, argv);
}

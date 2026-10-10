// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace TextureCompressionBasisu {
    const WINDOW_TITLE = "Donut Example: Basis Universal texture loading";

    // The sample's KTX 2 files (Vulkan-Samples' assets, copied at build time: see
    // VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt): Kodak images, Basis Universal UASTC (Zstandard
    // supercompressed) and ETC1S, sRGB, 10 levels each.
    const TEXTURE_DIR = "media/texture_compression_basisu/";
    const TEXTURE_FILE_NAMES = ["kodim23_UASTC.ktx2", "kodim23_ETC1S.ktx2", "kodim20_UASTC.ktx2", "kodim20_ETC1S.ktx2",
        "kodim05_UASTC.ktx2", "kodim05_ETC1S.ktx2", "kodim03_UASTC.ktx2", "kodim03_ETC1S.ktx2"];

    // The sample's transcode targets in its order of preference, those the device samples kept (its
    // get_available_target_formats; uncompressed RGBA always). NVRHI has no ASTC or ETC2 formats.
    // The files are sRGB, so the transcoded formats are the sRGB ones (as ktxTexture2_TranscodeBasis
    // picks them).
    const TARGET_TRANSCODE_FORMATS = [TranscodeFormat.BC7, TranscodeFormat.BC3, TranscodeFormat.ASTC4x4, TranscodeFormat.ETC2,
        TranscodeFormat.RGBA32];
    const TARGET_TEXTURE_FORMATS = [Format.BC7_UNORM_SRGB, Format.BC3_UNORM_SRGB, Format.UNKNOWN, Format.UNKNOWN,
        Format.SRGBA8_UNORM];
    const TARGET_NAMES = ["KTX_TTF_BC7_RGBA", "KTX_TTF_BC3_RGBA", "KTX_TTF_ASTC_4x4_RGBA", "KTX_TTF_ETC2_RGBA", "KTX_TTF_RGBA32"];

    // nvrhi::FormatSupport bits.
    const SUPPORT_TEXTURE = 0x8;
    const SUPPORT_SHADER_SAMPLE = 0x100;

    // The quad's vertices: float3 position, float2 uv.
    const VERTEX_FLOATS = 5;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const QUAD_VERTICES = [
        1.5, 1.0, 0.0, 1.0, 1.0,
        -1.5, 1.0, 0.0, 0.0, 1.0,
        -1.5, -1.0, 0.0, 0.0, 0.0,
        1.5, -1.0, 0.0, 1.0, 0.0,
    ];
    const QUAD_INDICES = [0, 1, 2, 2, 3, 0];

    // struct UBO { float4x4 projection, model; }.
    const UBO_PROJECTION = 0;
    const UBO_MODEL = 16;
    const UBO_FLOATS = 32;

    // The sample's view: ApiVulkanSample's zoom and rotation (degrees), its projection.
    const ZOOM = -1.75;
    const ROTATION = [0.0, 0.0, 0.0];
    const FOV = 60.0;
    const Z_NEAR = 0.001;
    const Z_FAR = 256.0;

    // The render pass's clear color.
    const CLEAR_COLOR = 0.05;

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

    // A number with `digits` decimals, like printf's %.Nf (Number.toFixed is missing under the JIT).
    function formatFixed(value: number, digits: int): string {
        let scale = 1.0;
        for (let i = 0; i < digits; i++) {
            scale *= 10.0;
        }
        const scaled = Math.round(Math.abs(value) * scale);
        const whole: int = Math.floor(scaled / scale);
        const fraction: int = scaled - whole * scale;
        let fractionText = `${fraction}`;
        while (fractionText.length < digits) {
            fractionText = "0" + fractionText;
        }
        const sign = value < 0.0 && scaled > 0.0 ? "-" : "";
        return digits > 0 ? `${sign}${whole}.${fractionText}` : `${sign}${whole}`;
    }

    // ImGui combo items: the names separated by '|'.
    function comboItems(names: string[]): string {
        let items = "";
        for (let i = 0; i < names.length; i++) {
            items += (i > 0 ? "|" : "") + names[i];
        }
        return items;
    }

    // ApiVulkanSample's own view (not its camera): zoom, rotation and camera_pos, with its mouse
    // controls: the left button turns (1.25 degrees per pixel), the right one zooms, the middle one
    // pans.
    class SampleView {
        zoom: number;
        rotation: number[];
        position: number[];
        private mouseX: number;
        private mouseY: number;
        private buttons: boolean[];

        constructor(zoom: number, rotation: number[]) {
            this.zoom = zoom;
            this.rotation = [rotation[0], rotation[1], rotation[2]];
            this.position = [0.0, 0.0, 0.0];
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.buttons = [false, false, false];
        }

        // The samples' update_uniform_buffers: translate(0, 0, zoom) * translate(camera_pos) *
        // rotations around x, y, z.
        model(): number[] {
            let m = identity();
            m[12] = this.position[0];
            m[13] = this.position[1];
            m[14] = this.zoom + this.position[2];
            m = rotate(m, radians(this.rotation[0]), 1.0, 0.0, 0.0);
            m = rotate(m, radians(this.rotation[1]), 0.0, 1.0, 0.0);
            m = rotate(m, radians(this.rotation[2]), 0.0, 0.0, 1.0);
            return m;
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
                this.rotation[0] += dy * 1.25;
                this.rotation[1] -= dx * 1.25;
            }
            if (this.buttons[1]) {
                this.zoom += dy * 0.005;
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

    // Port of Vulkan-Samples' texture_compression_basisu: a quad with a Kodak image loaded from a
    // Basis Universal KTX 2 file and transcoded on the CPU into a format the GPU samples (BC7, BC3
    // or uncompressed here), all its levels uploaded; the UI picks the file and the format, and times
    // the transcoding. The sample transcodes with libktx (ktxTexture2_TranscodeBasis), the port with
    // Basis Universal's own transcoder (core/basis_transcoder.cpp), libktx's underneath.
    class TextureCompressionBasisuPass {
        private app: App;
        private view: SampleView;

        // The device's targets (indices into TARGET_*), and the sample's choices.
        targets: int[];
        selectedInputTexture: int;
        selectedTranscodeTargetFormat: int;
        // Set by the UI's Transcode button (and at first): transcode before the next draw.
        transcodePending: boolean;
        lastTranscodeTime: number;
        transcodeFailed: boolean;

        private vs: Opaque;
        private ps: Opaque;
        private inputLayout: Opaque;
        private bindingLayout: Opaque;
        private sampler: SamplerHandle;
        private uniformBuffer: BufferHandle;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        private stats: f32[];

        // The transcoded texture and its binding set.
        private texture: TextureHandle;
        private bindingSet: BindingSet;
        private textureCreated: boolean;

        // The depth buffer and a framebuffer per back buffer, for the back buffers' size, and the
        // pipeline made for them.
        private depth: TextureHandle;
        private framebuffers: Opaque[];
        private targetWidth: int;
        private targetHeight: int;
        private pipeline: Opaque;
        private pipelineCreated: boolean;

        // Upload buffer.
        private ubo: f32[];

        constructor(app: App) {
            this.app = app;
            this.view = new SampleView(ZOOM, ROTATION);
            this.targets = [];
            this.selectedInputTexture = 0;
            this.selectedTranscodeTargetFormat = 0;
            this.transcodePending = true;
            this.lastTranscodeTime = 0.0;
            this.transcodeFailed = false;
            this.stats = [0.0, 0.0];
            this.textureCreated = false;
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.pipelineCreated = false;
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
        }

        onMousePos(x: number, y: number): int {
            this.view.mouseMove(x, y);
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            this.view.mouseButton(button, action);
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

        createTargets(width: int, height: int): void {
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

        // The sample's transcode_texture: the KTX 2 file transcoded into the target format, timed,
        // every level uploaded (recorded into the frame's command list: the previous texture stays
        // alive until the GPU is done with it). False if the file can't be read or transcoded.
        transcodeTexture(commandList: CommandList): boolean {
            const target = this.targets[this.selectedTranscodeTargetFormat];
            const name = TEXTURE_FILE_NAMES[this.selectedInputTexture];
            const file = this.app.loadBinaryFile(TEXTURE_DIR + name);
            if (file.isNull()) {
                return false;
            }
            const transcoded = Donut_TranscodeKtx2(file.getData(), file.getSize(), TARGET_TRANSCODE_FORMATS[target], Ref(this.stats[0]));
            this.app.releaseObject(file.handle);
            if (!transcoded) {
                return false;
            }
            const image = transcoded as Opaque;
            this.lastTranscodeTime = this.stats[0];

            if (this.textureCreated) {
                this.app.releaseResource(this.bindingSet.handle);
                this.app.releaseResource(this.texture);
            }
            const levels = Donut_GetTranscodedLevelCount(image);
            this.texture = this.app.createTextureWithLevels(Donut_GetTranscodedWidth(image), Donut_GetTranscodedHeight(image),
                levels, TARGET_TEXTURE_FORMATS[target], name);
            for (let level = 0; level < levels; level++) {
                commandList.writeTextureLevel(this.texture, level, Donut_GetTranscodedLevelData(image, level),
                    Donut_GetTranscodedLevelRowPitch(image, level));
            }
            Donut_DestroyTranscodedTexture(image);

            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.uniformBuffer);
            setDesc.bindTextureSRV(0, this.texture);
            setDesc.bindSampler(0, this.sampler);
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);
            this.textureCreated = true;
            return true;
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            if (this.transcodePending) {
                this.transcodePending = false;
                this.transcodeFailed = !this.transcodeTexture(commandList);
                if (this.transcodeFailed) {
                    console.log(`Cannot transcode ${TEXTURE_FILE_NAMES[this.selectedInputTexture]}: set VULKAN_SAMPLES_ASSETS_DIR when configuring`);
                }
            }

            // The sample's update_uniform_buffers: its projection (clip y negated for Donut), the
            // quad's model view.
            const projection = perspective(radians(FOV), width / height, Z_NEAR, Z_FAR);
            const model = this.view.model();
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.ubo[UBO_MODEL + i] = model[i];
            }
            commandList.writeBuffer(this.uniformBuffer, Ref(this.ubo[0]), UBO_FLOATS * 4);

            // The render pass: color cleared to dark gray, depth to 0.
            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
            commandList.clearDepth(this.depth, 0.0);
            if (!this.textureCreated) {
                return;
            }

            frame.beginDrawToFramebuffer(this.pipeline, this.framebuffers[index]);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawSetIndexBuffer(this.indexBuffer);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            frame.drawIndexed(QUAD_INDICES.length);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            for (let i = 0; i < TARGET_TEXTURE_FORMATS.length; i++) {
                const format = TARGET_TEXTURE_FORMATS[i];
                const support = format == Format.UNKNOWN ? 0 : this.app.queryFormatSupport(format);
                if ((support & SUPPORT_TEXTURE) != 0 && (support & SUPPORT_SHADER_SAMPLE) != 0) {
                    this.targets.push(i);
                }
            }
            if (this.targets.length == 0) {
                console.log("The device samples none of the transcode targets");
                return false;
            }

            const shader = "texture_compression_basisu.hlsl";
            this.vs = this.app.createShader(shader, "texture_vs", ShaderType.Vertex);
            this.ps = this.app.createShader(shader, "texture_ps", ShaderType.Pixel);
            if (!this.vs || !this.ps) {
                return false;
            }

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 12, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vs);

            let vertices: f32[] = [];
            for (let i = 0; i < QUAD_VERTICES.length; i++) {
                vertices.push(QUAD_VERTICES[i]);
            }
            let indices: int[] = [];
            for (let i = 0; i < QUAD_INDICES.length; i++) {
                indices.push(QUAD_INDICES[i]);
            }
            const commandList = this.app.createCommandList();
            commandList.open();
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Vertices");
            this.indexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), indices.length * 4, "Indices");
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);

            // The sample's sampler: trilinear, clamped, all the levels, the device's widest
            // anisotropic filtering.
            this.sampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Clamp, 0.0, 0.0, 1000.0,
                this.app.getMaxSamplerAnisotropy());
            this.uniformBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "UBO");
            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutVolatileConstantBuffer(0);
            bindingLayoutDesc.layoutTextureSRV(0);
            bindingLayoutDesc.layoutSampler(0);
            this.bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.All);

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
        private sample: TextureCompressionBasisuPass;
        private targetNames: string;

        constructor(sample: TextureCompressionBasisuPass) {
            this.sample = sample;
            let names: string[] = [];
            for (let i = 0; i < sample.targets.length; i++) {
                names.push(TARGET_NAMES[sample.targets[i]]);
            }
            this.targetNames = comboItems(names);
        }

        buildUI(): void {
            const sample = this.sample;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Basis Universal texture loading", 1);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Input") != 0) {
                Donut_ImGuiText("Input image:");
                Donut_ImGuiPushItemWidth(180.0);
                sample.selectedInputTexture = Donut_ImGuiCombo("##img", sample.selectedInputTexture, comboItems(TEXTURE_FILE_NAMES));
                Donut_ImGuiPopItemWidth();
                Donut_ImGuiText("Transcode target:");
                Donut_ImGuiPushItemWidth(180.0);
                sample.selectedTranscodeTargetFormat = Donut_ImGuiCombo("##tt", sample.selectedTranscodeTargetFormat, this.targetNames);
                Donut_ImGuiPopItemWidth();
                if (Donut_ImGuiButton("Transcode") != 0) {
                    sample.transcodePending = true;
                }
                Donut_ImGuiText(`Transcoded in ${formatFixed(sample.lastTranscodeTime, 2)} ms`);
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
        Donut_SetAppName("texture_compression_basisu");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the settings window.
        // -image <n>: the input image (0-7, the sample's list), -target <n>: the transcode target
        // (an index into the device's list), both transcoded at start.
        let options = AppOptions.None;
        let withUI = true;
        let image = 0;
        let target = 0;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-image" && i + 1 < argc) {
                i++;
                image = Math.min(Math.max(parseInt(Donut_GetArg(argv, i)), 0), TEXTURE_FILE_NAMES.length - 1);
            } else if (arg == "-target" && i + 1 < argc) {
                i++;
                target = Math.max(parseInt(Donut_GetArg(argv, i)), 0);
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new TextureCompressionBasisuPass(app);
        if (!sample.init()) {
            app.destroy();
            return 1;
        }
        sample.selectedInputTexture = image;
        sample.selectedTranscodeTargetFormat = Math.min(target, sample.targets.length - 1);

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
    return TextureCompressionBasisu.main(argc, argv);
}

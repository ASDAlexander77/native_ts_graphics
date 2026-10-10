// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace FragmentShadingRate {
    const WINDOW_TITLE = "Donut Example: Fragment Shading Rate";

    // The sample's models and textures (Vulkan-Samples' assets), the KTX textures converted to DDS
    // at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const MEDIA_DIR = "media/fragment_shading_rate/";
    const SKYSPHERE_PATH = MEDIA_DIR + "geosphere.gltf";
    const SCENE_PATH = MEDIA_DIR + "textured_unit_cube.gltf";
    const SKYSPHERE_TEXTURE_PATH = MEDIA_DIR + "skysphere_rgba.dds";
    const SCENE_TEXTURE_PATH = MEDIA_DIR + "metalplate01_rgba.dds";

    // Donut_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 8 * 4;

    // struct UBOScene { float4x4 projection, modelview, skysphere_modelview; int color_shading_rate; },
    // padded.
    const UBO_PROJECTION = 0;
    const UBO_MODELVIEW = 16;
    const UBO_SKYSPHERE_MODELVIEW = 32;
    const UBO_COLOR_SHADING_RATE = 48;
    const UBO_FLOATS = 52;
    // The push constants: float4 offset; int object_type.
    const PUSH_FLOATS = 5;
    const PUSH_SIZE = PUSH_FLOATS * 4;
    const OBJECT_SKYSPHERE = 0;
    const OBJECT_CUBE = 1;

    // The three cubes' offsets.
    const MESH_OFFSETS = [-2.5, 0.0, 0.0, 0.0, 0.0, 0.0, 2.5, 0.0, 0.0];

    // The sample's first person camera at (0, 0, -4) (the view's translation), a 60 degree vertical
    // field of view, depth reversed (near 256, far 0.1, as the sample passes them).
    const CAMERA_POSITION = [0.0, 0.0, -4.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // The shading rate image's rings: from 8% of the image's size out, 25% split between the
    // device's rates (the finest innermost); 4 x 4 beyond.
    const RING_START = 8.0;
    const RING_SPAN = 25.0;
    const OUTER_RATE = (4 >> 1) | (4 << 1);

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

    // The sample's camera (the framework's vkb::Camera, first person type), with ApiVulkanSample's
    // mouse controls: the left button turns it, the right one zooms, the middle one pans.
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

    // Port of Vulkan-Samples' fragment_shading_rate: a sky sphere and three textured, lit cubes drawn
    // with a shading rate image (a texel per tile of pixels) made once on the CPU: rings around the
    // center, from the full rate in the middle to coarser rates outwards. The UI switches the image
    // off (the full rate everywhere) and shows the rates as shades of the color's red. D3D12 (tier
    // 2) or Vulkan (VK_KHR_fragment_shading_rate).
    class FragmentShadingRatePass {
        private app: App;
        private camera: SampleCamera;

        // The sample's settings, from its UI.
        enableAttachmentShadingRate: boolean;
        colorShadingRate: boolean;
        displaySkySphere: boolean;

        // The device's shading rates (width, height pairs, largest first) and the shading rate
        // image's tile size.
        private rates: int[];
        private rateCount: int;
        private tileSize: int;
        private scratch: f32[];

        private sceneVS: Opaque;
        private scenePS: Opaque;
        private inputLayout: Opaque;
        private skysphereMesh: GltfMesh;
        private sceneMesh: GltfMesh;
        private bindingLayout: Opaque;
        private bindingSet: BindingSet;
        private uniformBuffer: BufferHandle;

        // The targets, for the back buffers' size (width 0: none yet): the shading rate image, the
        // depth buffer, a framebuffer per back buffer, and the pipelines made for them.
        private targetWidth: int;
        private targetHeight: int;
        private shadingRateImage: Opaque;
        private depth: Opaque;
        private framebuffers: Opaque[];
        private skyspherePipeline: Opaque;
        private cubePipeline: Opaque;
        private pipelinesCreated: boolean;

        // Upload buffers.
        private ubo: f32[];
        private push: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
            this.enableAttachmentShadingRate = true;
            this.colorShadingRate = false;
            this.displaySkySphere = true;
            this.rates = [];
            for (let i = 0; i < 32; i++) {
                this.rates.push(0);
            }
            this.rateCount = 0;
            this.tileSize = 1;
            this.scratch = [0.0];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.framebuffers = [];
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

        // x rounded to float, as the sample computes.
        fround(x: number): number {
            this.scratch[0] = x;
            return this.scratch[0];
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
                this.app.releaseResource(this.shadingRateImage);
            }
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
        }

        // The sample's create_shading_rate_attachment: per texel, the rate of the first ring (by
        // distance from the center, in percent of the image's size) it lies in. The rings take the
        // device's rates but its first (largest), finest innermost; the rate codes are the sample's,
        // (width >> 1) | (height << 1).
        shadingRatePattern(width: int, height: int): int[] {
            let keys: number[] = [];
            let codes: int[] = [];
            const range = this.fround(RING_SPAN / this.rateCount);
            let current = this.fround(RING_START);
            for (let i = this.rateCount - 1; i > 0; i--) {
                const w = this.rates[i * 2];
                const h = this.rates[i * 2 + 1];
                const rateV = w == 1 ? 0 : (w >> 1);
                const rateH = h == 1 ? 0 : (h << 1);
                keys.push(current);
                codes.push(rateV | rateH);
                current = this.fround(current + range);
            }
            // The texels, 4 to an int (little-endian bytes).
            let packed: int[] = [];
            for (let i = 0; i < Math.floor((width * height + 3) / 4); i++) {
                packed.push(0);
            }
            const halfWidth = this.fround(width / 2.0);
            const halfHeight = this.fround(height / 2.0);
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const deltaX = this.fround(this.fround(this.fround(halfWidth - x) / width) * 100.0);
                    const deltaY = this.fround(this.fround(this.fround(halfHeight - y) / height) * 100.0);
                    const dist = this.fround(Math.sqrt(this.fround(this.fround(deltaX * deltaX) + this.fround(deltaY * deltaY))));
                    let code = OUTER_RATE;
                    for (let k = 0; k < keys.length; k++) {
                        if (dist < keys[k]) {
                            code = codes[k];
                            break;
                        }
                    }
                    const index = y * width + x;
                    packed[index >> 2] |= code << ((index & 3) * 8);
                }
            }
            return packed;
        }

        // The sample's setup_framebuffer, recorded into an open command list.
        createTargets(commandList: CommandList, width: int, height: int): void {
            this.releaseTargets();
            const rateWidth = Math.ceil(width / this.tileSize);
            const rateHeight = Math.ceil(height / this.tileSize);
            this.shadingRateImage = this.app.createShadingRateSurface(rateWidth, rateHeight);
            let pattern = this.shadingRatePattern(rateWidth, rateHeight);
            commandList.writeTextureLevel(this.shadingRateImage, 0, Ref(pattern[0]), rateWidth);

            this.depth = this.app.createDepthTexture(width, height, Format.D32, 0.0, "Depth");
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebufferWithShadingRate(this.app.getBackBuffer(i), null, this.depth,
                    this.shadingRateImage));
            }

            // The pipelines (their framebuffers' layout is the same after a resize).
            if (!this.pipelinesCreated) {
                for (let cube = 0; cube < 2; cube++) {
                    const desc = GraphicsPipelineDesc.create(this.sceneVS, this.scenePS);
                    desc.setInputLayout(this.inputLayout);
                    desc.addBindingLayout(this.bindingLayout);
                    desc.setVariableRateShading(1);
                    if (cube == 1) {
                        // Depth tested (greater: reversed) and written, front faces culled.
                        desc.setDepthState(1, 1, ComparisonFunc.Greater);
                        desc.setRasterState(CullMode.Front, FillMode.Solid, 1);
                    } else {
                        desc.setDepthState(0, 0, ComparisonFunc.Greater);
                        desc.setRasterState(CullMode.Back, FillMode.Solid, 1);
                    }
                    const pipeline = this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]);
                    if (cube == 1) {
                        this.cubePipeline = pipeline;
                    } else {
                        this.skyspherePipeline = pipeline;
                    }
                }
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
                this.createTargets(commandList, width, height);
            }

            // The sample's update_uniform_buffers: its projection (clip y negated for Donut) and
            // view.
            const projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            const u = this.ubo;
            for (let i = 0; i < 16; i++) {
                u[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                u[UBO_MODELVIEW + i] = view[i];
                u[UBO_SKYSPHERE_MODELVIEW + i] = view[i];
            }
            Donut_StoreInt32(Ref(u[UBO_COLOR_SHADING_RATE]), this.colorShadingRate ? 1 : 0);
            commandList.writeBuffer(this.uniformBuffer, Ref(u[0]), UBO_FLOATS * 4);

            // The render pass: color cleared to transparent black, depth to 0.
            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), 0.0, 0.0, 0.0, 0.0);
            commandList.clearDepth(this.depth, 0.0);
            const framebuffer = this.framebuffers[index];

            // The sample's build_command_buffers: each draw's rate is 1 x 1, then the attachment's
            // (REPLACE: Override) or kept (KEEP: Passthrough).
            const imageCombiner = this.enableAttachmentShadingRate ? ShadingRateCombiner.Override : ShadingRateCombiner.Passthrough;
            if (this.displaySkySphere) {
                frame.beginDrawToFramebuffer(this.skyspherePipeline, framebuffer);
                frame.drawSetVariableRateShading(1, VariableShadingRate.Rate1x1, ShadingRateCombiner.Passthrough, imageCombiner);
                frame.drawAddBindingSet(this.bindingSet);
                frame.drawSetIndexBuffer(this.skysphereMesh.getIndexBuffer());
                frame.drawAddVertexBuffer(this.skysphereMesh.getVertexBuffer(), 0, 0);
                this.push[0] = 0.0;
                this.push[1] = 0.0;
                this.push[2] = 0.0;
                this.push[3] = 0.0;
                Donut_StoreInt32(Ref(this.push[4]), OBJECT_SKYSPHERE);
                frame.drawIndexedWithPushConstants(this.skysphereMesh.getIndexCount(), Ref(this.push[0]), PUSH_SIZE);
            }
            frame.beginDrawToFramebuffer(this.cubePipeline, framebuffer);
            frame.drawSetVariableRateShading(1, VariableShadingRate.Rate1x1, ShadingRateCombiner.Passthrough, imageCombiner);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawSetIndexBuffer(this.sceneMesh.getIndexBuffer());
            frame.drawAddVertexBuffer(this.sceneMesh.getVertexBuffer(), 0, 0);
            for (let j = 0; j < 3; j++) {
                this.push[0] = MESH_OFFSETS[j * 3];
                this.push[1] = MESH_OFFSETS[j * 3 + 1];
                this.push[2] = MESH_OFFSETS[j * 3 + 2];
                this.push[3] = 0.0;
                Donut_StoreInt32(Ref(this.push[4]), OBJECT_CUBE);
                frame.drawIndexedWithPushConstants(this.sceneMesh.getIndexCount(), Ref(this.push[0]), PUSH_SIZE);
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.rateCount = this.app.getFragmentShadingRates(Ref(this.rates[0]));
            this.tileSize = this.app.getShadingRateTileSize();
            if (this.rateCount == 0 || this.tileSize == 0) {
                console.log("The graphics device has no variable rate shading with shading rate images");
                return false;
            }

            const shader = "fragment_shading_rate.hlsl";
            this.sceneVS = this.app.createShader(shader, "scene_vs", ShaderType.Vertex);
            this.scenePS = this.app.createShader(shader, "scene_ps", ShaderType.Pixel);
            if (!this.sceneVS || !this.scenePS) {
                return false;
            }

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.sceneVS);

            // ApiVulkanSample::load_texture's sampler: linear, repeating, anisotropic at the device's
            // most.
            const sampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Wrap, 0.0, 0.0, 1000.0,
                this.app.getMaxSamplerAnisotropy());

            const commandList = this.app.createCommandList();
            commandList.open();
            this.skysphereMesh = this.app.loadGltfMesh(commandList, SKYSPHERE_PATH);
            this.sceneMesh = this.app.loadGltfMesh(commandList, SCENE_PATH);
            // As the framework loads KTX 1 color textures: as sRGB.
            const skysphereTexture = this.app.loadTexture(commandList, SKYSPHERE_TEXTURE_PATH, 1);
            const sceneTexture = this.app.loadTexture(commandList, SCENE_TEXTURE_PATH, 1);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (this.skysphereMesh.isNull() || this.sceneMesh.isNull() || !skysphereTexture || !sceneTexture) {
                console.log("Cannot load the models and textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            this.uniformBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "UBOScene");
            const layout = BindingLayoutDesc.create();
            layout.layoutVolatileConstantBuffer(0);
            layout.layoutTextureSRV(0);
            layout.layoutSampler(0);
            layout.layoutTextureSRV(1);
            layout.layoutSampler(1);
            layout.layoutPushConstants(1, PUSH_SIZE);
            this.bindingLayout = this.app.createBindingLayout(layout, ShaderType.All);
            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.uniformBuffer);
            setDesc.bindTextureSRV(0, skysphereTexture);
            setDesc.bindSampler(0, sampler);
            setDesc.bindTextureSRV(1, sceneTexture);
            setDesc.bindSampler(1, sampler);
            setDesc.bindPushConstants(1, PUSH_SIZE);
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

    // The sample's settings.
    class UserInterface {
        private pass: FragmentShadingRatePass;

        constructor(pass: FragmentShadingRatePass) {
            this.pass = pass;
        }

        buildUI(): void {
            const p = this.pass;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Options", 1);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Settings") != 0) {
                p.enableAttachmentShadingRate = Donut_ImGuiCheckbox("Enable attachment shading rate",
                    p.enableAttachmentShadingRate ? 1 : 0) != 0;
                p.colorShadingRate = Donut_ImGuiCheckbox("Color shading rates", p.colorShadingRate ? 1 : 0) != 0;
                p.displaySkySphere = Donut_ImGuiCheckbox("skysphere", p.displaySkySphere ? 1 : 0) != 0;
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
        Donut_SetAppName("fragment_shading_rate");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the options window. -color: the shading rates shown. -noattachment: the
        // full rate everywhere. -nosky: without the sky sphere.
        let options = AppOptions.None;
        let withUI = true;
        let color = false;
        let noAttachment = false;
        let noSky = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-color") {
                color = true;
            } else if (arg == "-noattachment") {
                noAttachment = true;
            } else if (arg == "-nosky") {
                noSky = true;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        if (app.isFeatureSupported(Feature.VariableRateShading) == 0) {
            console.log("The graphics device has no variable rate shading (D3D12 tier 2 or Vulkan's VK_KHR_fragment_shading_rate)");
            app.destroy();
            return 1;
        }

        const pass = new FragmentShadingRatePass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }
        pass.colorShadingRate = color;
        pass.enableAttachmentShadingRate = !noAttachment;
        pass.displaySkySphere = !noSky;

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(pass);
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
    return FragmentShadingRate.main(argc, argv);
}

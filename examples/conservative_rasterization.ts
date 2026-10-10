// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace ConservativeRasterization {
    const WINDOW_TITLE = "Donut Example: Conservative Rasterization";

    // The low resolution target is the screen's size divided by this.
    const ZOOM_FACTOR = 16;

    // struct SceneConstants { float4x4 projection, model; float2 viewportSize; float lineWidth,
    // padding; }, as f32 offsets.
    const CONST_PROJECTION = 0;
    const CONST_MODEL = 16;
    const CONST_VIEWPORT_SIZE = 32;
    const CONST_LINE_WIDTH = 34;
    const CONST_FLOATS = 36;

    // The outline's width (the sample's lineWidth).
    const LINE_WIDTH = 2.0;

    // The triangle: float3 position, float3 color per vertex.
    const VERTEX_SIZE = 24;

    // The sample's camera: a "look at" camera 2 units back, 60 degrees vertically, reversed depth
    // from 512 to 0.1 (glm::perspective with near and far swapped).
    const CAMERA_POSITION = [0.0, 0.0, -2.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 512.0;
    const Z_FAR = 0.1;
    // ApiVulkanSample's mouse controls: degrees per pixel dragged with the left button, zoom per
    // pixel with the right one, panning per pixel with the middle one.
    const ROTATION_SPEED = 1.0;
    const ZOOM_SPEED = 0.005;
    const PAN_SPEED = 0.01;

    // The clear colors of the low resolution target and of the screen.
    const CLEAR_COLOR = 0.05;

    // GLFW mouse buttons and actions.
    const MOUSE_BUTTON_LEFT = 0;
    const MOUSE_BUTTON_RIGHT = 1;
    const MOUSE_BUTTON_MIDDLE = 2;
    const ACTION_PRESS = 1;

    // --- Math (glm's layout: 4 x 4 matrices by columns) ---------------------------------------

    function radians(degrees: number): number {
        return degrees * Math.PI / 180.0;
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

    // glm::rotate(mat4(1), angle, axis) about a unit axis.
    function rotation(angle: number, x: number, y: number, z: number): number[] {
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const t = 1.0 - c;
        return [
            c + t * x * x,     t * x * y + s * z, t * x * z - s * y, 0.0,
            t * x * y - s * z, c + t * y * y,     t * y * z + s * x, 0.0,
            t * x * z + s * y, t * y * z - s * x, c + t * z * z,     0.0,
            0.0,               0.0,               0.0,               1.0,
        ];
    }

    function translation(x: number, y: number, z: number): number[] {
        return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, y, z, 1.0];
    }

    // glm::perspective(fov, aspect, near, far) (right-handed, depth from 0 to 1), with clip y
    // negated: the sample's clip space has y down on the screen (Vulkan's), Donut's y up.
    function samplePerspective(fov: number, aspect: number, zNear: number, zFar: number): number[] {
        const tanHalfFovy = Math.tan(0.5 * fov);
        return [
            1.0 / (aspect * tanHalfFovy), 0.0,                0.0,                              0.0,
            0.0,                          -1.0 / tanHalfFovy, 0.0,                              0.0,
            0.0,                          0.0,                zFar / (zNear - zFar),            -1.0,
            0.0,                          0.0,                -(zFar * zNear) / (zFar - zNear), 0.0,
        ];
    }

    // printf's %f: 6 decimals.
    function formatFloat(value: number): string {
        const scaled = Math.round(value * 1000000.0);
        const whole = Math.floor(scaled / 1000000);
        let fraction = `${scaled - whole * 1000000}`;
        while (fraction.length < 6) {
            fraction = "0" + fraction;
        }
        return `${whole}.${fraction}`;
    }

    // Port of Vulkan-Samples' conservative_rasterization: a triangle drawn into a target 16 times
    // smaller than the screen, with or without conservative rasterization (every pixel the triangle
    // touches at all, the sample enlarging it further by the device's maximum extra size), then
    // stretched over the screen without filtering, with the triangle's real outline drawn over it.
    class ConservativeRasterizationPass {
        private app: App;

        // The sample's settings.
        conservativeRasterEnabled: boolean;
        // The device's properties, for the overlay: Vulkan's (9 values, see
        // Donut_GetVulkanConservativeRasterizationProperties), or D3D12's tier.
        hasVulkanProperties: boolean;
        vulkanProperties: f32[];
        d3d12Tier: int;

        // The sample's camera: rotation (degrees about x, y, z) and position.
        private cameraRotation: number[];
        private cameraPosition: number[];
        private leftButton: boolean;
        private rightButton: boolean;
        private middleButton: boolean;
        private mouseX: number;
        private mouseY: number;

        private triangleVS: ShaderHandle;
        private trianglePS: ShaderHandle;
        private overlayGS: ShaderHandle;
        private overlayPS: ShaderHandle;
        private fullscreenVS: ShaderHandle;
        private fullscreenPS: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private sceneBindingLayout: Opaque;
        private fullscreenBindingLayout: Opaque;
        private constantBuffer: BufferHandle;
        private sceneBindingSet: BindingSet;
        private sampler: SamplerHandle;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;

        // Created on the first frame: the low resolution target (the screen's size then, as the
        // sample's offscreen pass, which a resize leaves as it is) and the pipelines.
        private created: boolean;
        private offscreenColor: TextureHandle;
        private offscreenFramebuffer: Opaque;
        private fullscreenBindingSet: BindingSet;
        private trianglePipeline: Opaque;
        private triangleConservativePipeline: Opaque;
        private overlayPipeline: Opaque;
        private fullscreenPipeline: Opaque;

        private constants: f32[];

        constructor(app: App) {
            this.app = app;
            this.conservativeRasterEnabled = true;
            this.hasVulkanProperties = false;
            this.vulkanProperties = [];
            for (let i = 0; i < 9; i++) {
                this.vulkanProperties.push(0.0);
            }
            this.d3d12Tier = 0;
            this.cameraRotation = [0.0, 0.0, 0.0];
            this.cameraPosition = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
            this.leftButton = false;
            this.rightButton = false;
            this.middleButton = false;
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.created = false;
            this.constants = [];
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
        }

        // ApiVulkanSample's mouse handling: dragging with the left button rotates the camera, with
        // the right one zooms, with the middle one pans.
        onMousePos(x: number, y: number): int {
            const dx = this.mouseX - x;
            const dy = this.mouseY - y;
            if (this.leftButton) {
                this.cameraRotation[0] += dy * ROTATION_SPEED;
                this.cameraRotation[1] -= dx * ROTATION_SPEED;
            }
            if (this.rightButton) {
                this.cameraPosition[2] += dy * ZOOM_SPEED;
            }
            if (this.middleButton) {
                this.cameraPosition[0] -= dx * PAN_SPEED;
                this.cameraPosition[1] -= dy * PAN_SPEED;
            }
            this.mouseX = x;
            this.mouseY = y;
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            const pressed = action == ACTION_PRESS;
            if (button == MOUSE_BUTTON_LEFT) {
                this.leftButton = pressed;
            } else if (button == MOUSE_BUTTON_RIGHT) {
                this.rightButton = pressed;
            } else if (button == MOUSE_BUTTON_MIDDLE) {
                this.middleButton = pressed;
            }
            return 1;
        }

        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        // The triangle's pipelines: back faces culled (clockwise triangles are front faces), no
        // depth test; for the low resolution target, without and with conservative rasterization.
        createTrianglePipeline(conservative: boolean): Opaque {
            const desc = GraphicsPipelineDesc.create(this.triangleVS, this.trianglePS);
            desc.setInputLayout(this.inputLayout);
            desc.addBindingLayout(this.sceneBindingLayout);
            desc.setDepthState(0, 0, ComparisonFunc.Greater);
            desc.setRasterState(CullMode.Back, FillMode.Solid, 0);
            if (conservative) {
                // The sample enlarges the triangle by the device's maximum extra size (Vulkan only).
                desc.setConservativeRaster(1, this.hasVulkanProperties ? this.vulkanProperties[1] : 0.0);
            }
            return this.app.createGraphicsPipelineFromDesc(desc, this.offscreenFramebuffer);
        }

        createResources(frame: Frame): void {
            const width = Math.floor(frame.getWidth() / ZOOM_FACTOR);
            const height = Math.floor(frame.getHeight() / ZOOM_FACTOR);
            this.offscreenColor = this.app.createRenderTargetTexture(width, height, Format.RGBA8_UNORM, "OffscreenColor");
            this.offscreenFramebuffer = this.app.createFramebuffer(this.offscreenColor, null);

            this.trianglePipeline = this.createTrianglePipeline(false);
            this.triangleConservativePipeline = this.createTrianglePipeline(true);

            // The outline over the screen: the edges widened by the geometry shader.
            const overlayDesc = GraphicsPipelineDesc.create(this.triangleVS, this.overlayPS);
            overlayDesc.setGeometryShader(this.overlayGS);
            overlayDesc.setInputLayout(this.inputLayout);
            overlayDesc.addBindingLayout(this.sceneBindingLayout);
            overlayDesc.setDepthState(0, 0, ComparisonFunc.Greater);
            overlayDesc.setRasterState(CullMode.None, FillMode.Solid, 0);
            this.overlayPipeline = this.app.createGraphicsPipelineFromDescForFrame(overlayDesc, frame);

            // The low resolution image over the screen.
            const fullscreenDesc = GraphicsPipelineDesc.create(this.fullscreenVS, this.fullscreenPS);
            fullscreenDesc.addBindingLayout(this.fullscreenBindingLayout);
            fullscreenDesc.setDepthState(0, 0, ComparisonFunc.Greater);
            fullscreenDesc.setRasterState(CullMode.Back, FillMode.Solid, 0);
            this.fullscreenPipeline = this.app.createGraphicsPipelineFromDescForFrame(fullscreenDesc, frame);

            const fullscreenSetDesc = BindingSetDesc.create();
            fullscreenSetDesc.bindTextureSRV(0, this.offscreenColor);
            fullscreenSetDesc.bindSampler(0, this.sampler);
            this.fullscreenBindingSet = this.app.createBindingSetForLayout(fullscreenSetDesc, this.fullscreenBindingLayout);
            this.created = true;
        }

        // The sample's update_uniform_buffers_scene: its camera's matrices.
        updateConstants(width: int, height: int): void {
            const c = this.constants;
            const projection = samplePerspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            // A "look at" camera: translation * rotation (about x, then y, then z).
            const r = this.cameraRotation;
            let rotationMatrix = multiply(rotation(radians(r[0]), 1.0, 0.0, 0.0), rotation(radians(r[1]), 0.0, 1.0, 0.0));
            rotationMatrix = multiply(rotationMatrix, rotation(radians(r[2]), 0.0, 0.0, 1.0));
            const p = this.cameraPosition;
            const view = multiply(translation(p[0], p[1], p[2]), rotationMatrix);
            for (let i = 0; i < 16; i++) {
                c[CONST_PROJECTION + i] = projection[i];
                c[CONST_MODEL + i] = view[i];
            }
            c[CONST_VIEWPORT_SIZE] = width;
            c[CONST_VIEWPORT_SIZE + 1] = height;
            c[CONST_LINE_WIDTH] = LINE_WIDTH;
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            if (!this.created) {
                this.createResources(frame);
            }

            this.updateConstants(frame.getWidth(), frame.getHeight());
            commandList.writeBuffer(this.constantBuffer, Ref(this.constants[0]), CONST_FLOATS * 4);

            // First pass: the triangle at low resolution.
            commandList.clearTextureFloat(this.offscreenColor, CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 0.0);
            frame.beginDrawToFramebuffer(this.conservativeRasterEnabled ? this.triangleConservativePipeline : this.trianglePipeline,
                this.offscreenFramebuffer);
            frame.drawAddBindingSet(this.sceneBindingSet);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            frame.drawSetIndexBuffer(this.indexBuffer);
            frame.drawIndexed(3);

            // Second pass: the low resolution image over the screen, the real triangle's outline
            // over it.
            frame.clearColor(CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 0.25);
            frame.beginDraw(this.fullscreenPipeline);
            frame.drawAddBindingSet(this.fullscreenBindingSet);
            frame.drawVertices(3);

            frame.beginDraw(this.overlayPipeline);
            frame.drawAddBindingSet(this.sceneBindingSet);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            frame.drawVertices(3);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            if (this.app.isFeatureSupported(Feature.ConservativeRasterization) == 0) {
                console.log("This example needs conservative rasterization");
                return false;
            }
            this.hasVulkanProperties = this.app.getVulkanConservativeRasterizationProperties(Ref(this.vulkanProperties[0])) != 0;
            this.d3d12Tier = this.app.getD3D12ConservativeRasterizationTier();

            const shader = "conservative_rasterization.hlsl";
            this.triangleVS = this.app.createShader(shader, "triangle_vs", ShaderType.Vertex);
            this.trianglePS = this.app.createShader(shader, "triangle_ps", ShaderType.Pixel);
            this.overlayGS = this.app.createShader(shader, "overlay_gs", ShaderType.Geometry);
            this.overlayPS = this.app.createShader(shader, "overlay_ps", ShaderType.Pixel);
            this.fullscreenVS = this.app.createShader(shader, "fullscreen_vs", ShaderType.Vertex);
            this.fullscreenPS = this.app.createShader(shader, "fullscreen_ps", ShaderType.Pixel);
            if (!this.triangleVS || !this.trianglePS || !this.overlayGS || !this.overlayPS || !this.fullscreenVS || !this.fullscreenPS) {
                return false;
            }

            // The triangle's vertex input: positions and colors.
            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("COLOR", Format.RGB32_FLOAT, 12, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.triangleVS);

            this.constantBuffer = this.app.createVolatileConstantBuffer(CONST_FLOATS * 4, "UboScene");
            const sceneLayoutDesc = BindingLayoutDesc.create();
            sceneLayoutDesc.layoutVolatileConstantBuffer(0);
            this.sceneBindingLayout = this.app.createBindingLayout(sceneLayoutDesc, ShaderType.All);
            const sceneSetDesc = BindingSetDesc.create();
            sceneSetDesc.bindEntireConstantBuffer(0, this.constantBuffer);
            this.sceneBindingSet = this.app.createBindingSetForLayout(sceneSetDesc, this.sceneBindingLayout);

            // The low resolution image's texels as they are: nearest, clamped to the edges.
            const fullscreenLayoutDesc = BindingLayoutDesc.create();
            fullscreenLayoutDesc.layoutTextureSRV(0);
            fullscreenLayoutDesc.layoutSampler(0);
            this.fullscreenBindingLayout = this.app.createBindingLayout(fullscreenLayoutDesc, ShaderType.Pixel);
            this.sampler = this.app.createSampler(0, 1, 0);

            // A single triangle.
            let vertices: f32[] = [
                1.0, 1.0, 0.0, 1.0, 0.0, 0.0,
                -1.0, 1.0, 0.0, 0.0, 1.0, 0.0,
                0.0, -1.0, 0.0, 0.0, 0.0, 1.0,
            ];
            let indices: int[] = [0, 1, 2];
            const commandList = this.app.createCommandList();
            commandList.open();
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), 3 * VERTEX_SIZE, "Vertices");
            this.indexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), 3 * 4, "Indices");
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);

            const pass = this.app.addPass();
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's overlay.
    class UserInterface {
        private sample: ConservativeRasterizationPass;

        constructor(sample: ConservativeRasterizationPass) {
            this.sample = sample;
        }

        yesNo(value: number): string {
            return value != 0.0 ? "yes" : "no";
        }

        buildUI(): void {
            const sample = this.sample;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            // The sample's title (ApiVulkanSample's default).
            Donut_ImGuiBegin("Vulkan Example", 1);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Settings") != 0) {
                sample.conservativeRasterEnabled = Donut_ImGuiCheckbox("Conservative rasterization", sample.conservativeRasterEnabled ? 1 : 0) != 0;
            }
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Device properties") != 0) {
                if (sample.hasVulkanProperties) {
                    const p = sample.vulkanProperties;
                    Donut_ImGuiText(`maxExtraPrimitiveOverestimationSize: ${formatFloat(p[1])}`);
                    Donut_ImGuiText(`extraPrimitiveOverestimationSizeGranularity: ${formatFloat(p[2])}`);
                    Donut_ImGuiText(`primitiveUnderestimation:  ${this.yesNo(p[3])}`);
                    Donut_ImGuiText(`conservativePointAndLineRasterization:  ${this.yesNo(p[4])}`);
                    Donut_ImGuiText(`degenerateTrianglesRasterized: ${this.yesNo(p[5])}`);
                    Donut_ImGuiText(`degenerateLinesRasterized: ${this.yesNo(p[6])}`);
                    Donut_ImGuiText(`fullyCoveredFragmentShaderInputVariable: ${this.yesNo(p[7])}`);
                    Donut_ImGuiText(`conservativeRasterizationPostDepthCoverage: ${this.yesNo(p[8])}`);
                } else if (sample.d3d12Tier > 0) {
                    Donut_ImGuiText(`ConservativeRasterizationTier: ${sample.d3d12Tier}`);
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
        Donut_SetAppName("conservative_rasterization");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the settings window.
        // -noconservative: start with conservative rasterization off.
        let options = AppOptions.None;
        let withUI = true;
        let conservative = true;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-noconservative") {
                conservative = false;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new ConservativeRasterizationPass(app);
        sample.conservativeRasterEnabled = conservative;
        if (!sample.init()) {
            app.destroy();
            return 1;
        }

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
    return ConservativeRasterization.main(argc, argv);
}

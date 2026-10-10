// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace RasterizationOrderAttachmentAccess {
    const WINDOW_TITLE = "Donut Example: Rasterization Order Attachment Access";

    // The sample's model and background (Vulkan-Samples' assets), the KTX texture converted to DDS
    // at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const MODEL_PATH = "media/rasterization_order_attachment_access/geosphere.gltf";
    const BACKGROUND_PATH = "media/rasterization_order_attachment_access/vulkan_logo_full.dds";

    // Donut_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // The sample's grid of transparent spheres: rows (x) by columns (y) by layers (z), one unit
    // apart and centered on the origin.
    const INSTANCE_ROW_COUNT = 4;
    const INSTANCE_COLUMN_COUNT = 4;
    const INSTANCE_LAYER_COUNT = 4;
    const INSTANCE_COUNT = INSTANCE_ROW_COUNT * INSTANCE_COLUMN_COUNT * INSTANCE_LAYER_COUNT;
    const INSTANCE_SCALE = 0.03;
    // struct Instance { float4x4 model; float4 color; }.
    const INSTANCE_FLOATS = 20;
    const RANDOM_SEED = 42;

    // struct SceneConstants { float4x4 projection, view; float backgroundGrayscale; }, padded.
    const CONST_PROJECTION = 0;
    const CONST_VIEW = 16;
    const CONST_BACKGROUND_GRAYSCALE = 32;
    const CONST_FLOATS = 36;
    const BACKGROUND_GRAYSCALE = 0.3;

    // The sample's camera: a "look at" camera 4 units back, 60 degrees vertically, reversed depth
    // from 256 to 0.1 (glm::perspective with near and far swapped).
    const CAMERA_POSITION = [0.0, 0.0, -4.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;
    // ApiVulkanSample's mouse controls: degrees per pixel dragged with the left button, zoom per
    // pixel with the right one, panning per pixel with the middle one.
    const ROTATION_SPEED = 1.0;
    const ZOOM_SPEED = 0.005;
    const PAN_SPEED = 0.01;

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

    // printf's %.3f.
    function formatFixed3(value: number): string {
        const scaled = Math.round(value * 1000.0);
        const whole = Math.floor(scaled / 1000);
        let fraction = `${scaled - whole * 1000}`;
        while (fraction.length < 3) {
            fraction = "0" + fraction;
        }
        return `${whole}.${fraction}`;
    }

    // MSVC's rand() after srand(seed), which the sample's colors come from: RAND_MAX 32767.
    class MsvcRandom {
        private state: number;

        constructor(seed: number) {
            this.state = seed;
        }

        next(): number {
            this.state = (this.state * 214013 + 2531011) % 4294967296;
            return Math.floor(this.state / 65536) % 32768;
        }

        // static_cast<float>(rand()) / RAND_MAX.
        nextFloat(): number {
            return this.next() / 32767.0;
        }
    }

    // Port of Vulkan-Samples' rasterization_order_attachment_access: 64 transparent spheres over a
    // background, each fragment blending itself over what it reads at its pixel (programmable
    // blending). The sample reads the color attachment (dynamic rendering local read); here the
    // color is a UAV texture of the swapchain's bytes. With rasterizer ordered views (the sample's
    // VK_EXT_rasterization_order_attachment_access), overlapping fragments of one draw take turns in
    // primitive order, so a single instanced draw does it; without, each sphere is drawn alone with
    // a barrier after it.
    class RasterizationOrderPass {
        private app: App;

        // The sample's settings and statistics.
        rovSupported: boolean;
        rovEnabled: boolean;
        gpuDrawTimeMs: number;
        hasGpuTime: boolean;

        // The sample's camera: rotation (degrees about x, y, z) and position.
        private cameraRotation: number[];
        private cameraPosition: number[];
        private leftButton: boolean;
        private rightButton: boolean;
        private middleButton: boolean;
        private mouseX: number;
        private mouseY: number;

        private fullscreenVS: ShaderHandle;
        private backgroundPS: ShaderHandle;
        private blendVS: ShaderHandle;
        private blendPS: ShaderHandle;
        private blendRovPS: ShaderHandle;
        private displayPS: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private backgroundBindingLayout: Opaque;
        private blendBindingLayout: Opaque;
        private displayBindingLayout: Opaque;
        private constantBuffer: BufferHandle;
        private instanceBuffer: BufferHandle;
        private background: TextureHandle;
        private sampler: SamplerHandle;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        private indexCount: int;
        private timerQuery: Opaque;
        private timerQueryInFlight: boolean;

        // Created on the first frame (the back buffer's layout).
        private pipelinesCreated: boolean;
        private backgroundPipeline: Opaque;
        private blendPipeline: Opaque;
        private blendRovPipeline: Opaque;
        private displayPipeline: Opaque;

        // The back buffer's size: the color texture and the binding sets that use it.
        private width: int;
        private height: int;
        private colorTexture: TextureHandle;
        private backgroundBindingSet: BindingSet;
        private blendBindingSet: BindingSet;
        private displayBindingSet: BindingSet;

        private constants: f32[];
        private drawConstants: int[];

        constructor(app: App) {
            this.app = app;
            this.rovSupported = false;
            this.rovEnabled = false;
            this.gpuDrawTimeMs = 0.0;
            this.hasGpuTime = false;
            this.cameraRotation = [0.0, 0.0, 0.0];
            this.cameraPosition = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
            this.leftButton = false;
            this.rightButton = false;
            this.middleButton = false;
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.indexCount = 0;
            this.timerQueryInFlight = false;
            this.pipelinesCreated = false;
            this.width = 0;
            this.height = 0;
            this.constants = [];
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
            this.drawConstants = [0];
        }

        drawCallCount(): int {
            return this.rovEnabled ? 2 : INSTANCE_COUNT + 1;
        }

        barrierCount(): int {
            return this.rovEnabled ? 0 : INSTANCE_COUNT - 1;
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

        releaseSizedResources(): void {
            if (this.width == 0) {
                return;
            }
            const resources: (ResourceHandle | null)[] = [this.backgroundBindingSet.handle, this.blendBindingSet.handle, this.displayBindingSet.handle,
                this.colorTexture];
            for (let i = 0; i < resources.length; i++) {
                const resource = resources[i];
                if (resource) {
                    this.app.releaseResource(resource);
                }
            }
            this.width = 0;
            this.height = 0;
        }

        onBackBufferResizing(): void {
            this.releaseSizedResources();
        }

        // The color texture: the swapchain's bytes (sRGB-encoded RGBA8), packed in a uint.
        createSizedResources(width: int, height: int): void {
            this.width = width;
            this.height = height;
            this.colorTexture = this.app.createUAVTextureWithFormat(width, height, Format.R32_UINT, "Color");

            const backgroundSetDesc = BindingSetDesc.create();
            backgroundSetDesc.bindEntireConstantBuffer(0, this.constantBuffer);
            backgroundSetDesc.bindTextureSRV(0, this.background);
            backgroundSetDesc.bindSampler(0, this.sampler);
            backgroundSetDesc.bindTextureUAV(1, this.colorTexture);
            this.backgroundBindingSet = this.app.createBindingSetForLayout(backgroundSetDesc, this.backgroundBindingLayout);

            const blendSetDesc = BindingSetDesc.create();
            blendSetDesc.bindEntireConstantBuffer(0, this.constantBuffer);
            blendSetDesc.bindPushConstants(1, 4);
            blendSetDesc.bindStructuredBufferSRV(1, this.instanceBuffer);
            blendSetDesc.bindTextureUAV(1, this.colorTexture);
            this.blendBindingSet = this.app.createBindingSetForLayout(blendSetDesc, this.blendBindingLayout);

            const displaySetDesc = BindingSetDesc.create();
            displaySetDesc.bindTextureSRV(2, this.colorTexture);
            this.displayBindingSet = this.app.createBindingSetForLayout(displaySetDesc, this.displayBindingLayout);
        }

        // The background and the blending write the color texture only (no color output); no depth
        // test; the spheres' back faces culled (counter-clockwise triangles are front faces).
        createPipelines(frame: Frame): void {
            const backgroundDesc = GraphicsPipelineDesc.create(this.fullscreenVS, this.backgroundPS);
            backgroundDesc.addBindingLayout(this.backgroundBindingLayout);
            backgroundDesc.setDepthState(0, 0, ComparisonFunc.Greater);
            backgroundDesc.setRasterState(CullMode.None, FillMode.Solid, 1);
            backgroundDesc.setColorWriteMask(ColorMask.None);
            this.backgroundPipeline = this.app.createGraphicsPipelineFromDescForFrame(backgroundDesc, frame);

            const blendDesc = GraphicsPipelineDesc.create(this.blendVS, this.blendPS);
            blendDesc.setInputLayout(this.inputLayout);
            blendDesc.addBindingLayout(this.blendBindingLayout);
            blendDesc.setDepthState(0, 0, ComparisonFunc.Greater);
            blendDesc.setRasterState(CullMode.Back, FillMode.Solid, 1);
            blendDesc.setColorWriteMask(ColorMask.None);
            this.blendPipeline = this.app.createGraphicsPipelineFromDescForFrame(blendDesc, frame);

            if (this.rovSupported) {
                const rovDesc = GraphicsPipelineDesc.create(this.blendVS, this.blendRovPS);
                rovDesc.setInputLayout(this.inputLayout);
                rovDesc.addBindingLayout(this.blendBindingLayout);
                rovDesc.setDepthState(0, 0, ComparisonFunc.Greater);
                rovDesc.setRasterState(CullMode.Back, FillMode.Solid, 1);
                rovDesc.setColorWriteMask(ColorMask.None);
                this.blendRovPipeline = this.app.createGraphicsPipelineFromDescForFrame(rovDesc, frame);
            }

            const displayDesc = GraphicsPipelineDesc.create(this.fullscreenVS, this.displayPS);
            displayDesc.addBindingLayout(this.displayBindingLayout);
            displayDesc.setDepthState(0, 0, ComparisonFunc.Greater);
            displayDesc.setRasterState(CullMode.None, FillMode.Solid, 1);
            this.displayPipeline = this.app.createGraphicsPipelineFromDescForFrame(displayDesc, frame);
            this.pipelinesCreated = true;
        }

        // The sample's update_scene_uniforms.
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
                c[CONST_VIEW + i] = view[i];
            }
            c[CONST_BACKGROUND_GRAYSCALE] = BACKGROUND_GRAYSCALE;
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (!this.pipelinesCreated) {
                this.createPipelines(frame);
            }
            if (this.width != width || this.height != height) {
                this.releaseSizedResources();
                this.createSizedResources(width, height);
            }

            this.updateConstants(width, height);
            commandList.writeBuffer(this.constantBuffer, Ref(this.constants[0]), CONST_FLOATS * 4);

            // The sample's GPU time: around the background and the spheres (read when ready).
            if (this.timerQueryInFlight && this.app.pollTimerQuery(this.timerQuery) != 0) {
                this.gpuDrawTimeMs = this.app.getTimerQueryTime(this.timerQuery) * 1000.0;
                this.hasGpuTime = true;
                this.app.resetTimerQuery(this.timerQuery);
                this.timerQueryInFlight = false;
            }
            const measure = !this.timerQueryInFlight;
            if (measure) {
                commandList.beginTimerQuery(this.timerQuery);
            }

            // Background (fullscreen triangle).
            frame.beginDraw(this.backgroundPipeline);
            frame.drawAddBindingSet(this.backgroundBindingSet);
            frame.drawVertices(3);

            // The spheres, over it.
            const d = this.drawConstants;
            if (this.rovSupported && this.rovEnabled) {
                // One instanced draw: the ROV orders its overlapping fragments.
                frame.beginDraw(this.blendRovPipeline);
                frame.drawAddBindingSet(this.blendBindingSet);
                frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
                frame.drawSetIndexBuffer(this.indexBuffer);
                d[0] = 0;
                frame.drawIndexedInstancedWithPushConstants(this.indexCount, INSTANCE_COUNT, Ref(d[0]), 4);
            } else {
                // A draw per sphere, a barrier between each two.
                frame.beginDraw(this.blendPipeline);
                frame.drawAddBindingSet(this.blendBindingSet);
                frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
                frame.drawSetIndexBuffer(this.indexBuffer);
                for (let instance = 0; instance < INSTANCE_COUNT; instance++) {
                    d[0] = instance;
                    frame.drawIndexedWithPushConstants(this.indexCount, Ref(d[0]), 4);
                    if (instance < INSTANCE_COUNT - 1) {
                        commandList.uavBarrier(this.colorTexture);
                    }
                }
            }

            if (measure) {
                commandList.endTimerQuery(this.timerQuery);
                this.timerQueryInFlight = true;
            }

            // The color texture's bytes to the screen.
            frame.beginDraw(this.displayPipeline);
            frame.drawAddBindingSet(this.displayBindingSet);
            frame.drawVertices(3);
        }

        // The sample's instance data: the grid's transforms and random colors (alpha 0.2 to 1).
        createInstanceBuffer(commandList: CommandList): void {
            const random = new MsvcRandom(RANDOM_SEED);
            let instances: f32[] = [];
            for (let z = 0; z < INSTANCE_LAYER_COUNT; z++) {
                for (let y = 0; y < INSTANCE_COLUMN_COUNT; y++) {
                    for (let x = 0; x < INSTANCE_ROW_COUNT; x++) {
                        const px = x - (INSTANCE_ROW_COUNT - 1) * 0.5;
                        const py = y - (INSTANCE_COLUMN_COUNT - 1) * 0.5;
                        const pz = z - (INSTANCE_LAYER_COUNT - 1) * 0.5;
                        // glm::scale(glm::translate(mat4(1), pos), vec3(scale))
                        const model = [INSTANCE_SCALE, 0.0, 0.0, 0.0, 0.0, INSTANCE_SCALE, 0.0, 0.0,
                            0.0, 0.0, INSTANCE_SCALE, 0.0, px, py, pz, 1.0];
                        for (let i = 0; i < 16; i++) {
                            instances.push(model[i]);
                        }
                        // glm::vec4(random_float(), random_float(), random_float(),
                        // random_float() * 0.8f + 0.2f): MSVC evaluates the arguments right to
                        // left, so alpha takes the first number, red the last.
                        const alpha = random.nextFloat() * 0.8 + 0.2;
                        const blue = random.nextFloat();
                        const green = random.nextFloat();
                        const red = random.nextFloat();
                        instances.push(red);
                        instances.push(green);
                        instances.push(blue);
                        instances.push(alpha);
                    }
                }
            }
            this.instanceBuffer = this.app.createStructuredBuffer(INSTANCE_FLOATS * 4, INSTANCE_COUNT, "InstanceData");
            commandList.writeBuffer(this.instanceBuffer, Ref(instances[0]), INSTANCE_COUNT * INSTANCE_FLOATS * 4);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.rovSupported = this.app.hasRasterizerOrderedViews() != 0;
            this.rovEnabled = this.rovSupported;

            const shader = "rasterization_order_attachment_access.hlsl";
            this.fullscreenVS = this.app.createShader(shader, "fullscreen_vs", ShaderType.Vertex);
            this.backgroundPS = this.app.createShader(shader, "background_ps", ShaderType.Pixel);
            this.blendVS = this.app.createShader(shader, "blend_vs", ShaderType.Vertex);
            this.blendPS = this.app.createShaderWithDefine(shader, "blend_ps", ShaderType.Pixel, "ROV", "0");
            this.displayPS = this.app.createShader(shader, "display_ps", ShaderType.Pixel);
            if (!this.fullscreenVS || !this.backgroundPS || !this.blendVS || !this.blendPS || !this.displayPS) {
                return false;
            }
            if (this.rovSupported) {
                this.blendRovPS = this.app.createShaderWithDefine(shader, "blend_ps", ShaderType.Pixel, "ROV", "1");
                if (!this.blendRovPS) {
                    return false;
                }
            }

            // The spheres' positions.
            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.blendVS);

            this.constantBuffer = this.app.createVolatileConstantBuffer(CONST_FLOATS * 4, "SceneConstants");

            // The sample's descriptor set, split by pass: the background's uniforms, texture and
            // sampler; the spheres' uniforms, instances and first instance; both the color texture.
            const backgroundLayoutDesc = BindingLayoutDesc.create();
            backgroundLayoutDesc.layoutVolatileConstantBuffer(0);
            backgroundLayoutDesc.layoutTextureSRV(0);
            backgroundLayoutDesc.layoutSampler(0);
            backgroundLayoutDesc.layoutTextureUAV(1);
            this.backgroundBindingLayout = this.app.createBindingLayout(backgroundLayoutDesc, ShaderType.Pixel);

            const blendLayoutDesc = BindingLayoutDesc.create();
            blendLayoutDesc.layoutVolatileConstantBuffer(0);
            blendLayoutDesc.layoutPushConstants(1, 4);
            blendLayoutDesc.layoutStructuredBufferSRV(1);
            blendLayoutDesc.layoutTextureUAV(1);
            this.blendBindingLayout = this.app.createBindingLayout(blendLayoutDesc, ShaderType.All);

            const displayLayoutDesc = BindingLayoutDesc.create();
            displayLayoutDesc.layoutTextureSRV(2);
            this.displayBindingLayout = this.app.createBindingLayout(displayLayoutDesc, ShaderType.Pixel);

            // The background's sampler: linear, repeating. Donut's common passes, which hold it,
            // upload their textures on a command list of their own: before ours is open.
            this.sampler = this.app.getCommonSampler(CommonSampler.LinearWrap);

            const commandList = this.app.createCommandList();
            commandList.open();
            const mesh = this.app.loadGltfMesh(commandList, MODEL_PATH);
            const background = this.app.loadTexture(commandList, BACKGROUND_PATH, 1);
            this.createInstanceBuffer(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (mesh.isNull() || !background) {
                console.log("Cannot load the model and the background: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }
            this.background = background;
            this.vertexBuffer = mesh.getVertexBuffer();
            this.indexBuffer = mesh.getIndexBuffer();
            this.indexCount = mesh.getIndexCount();
            this.timerQuery = this.app.createTimerQuery();

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
        private sample: RasterizationOrderPass;

        constructor(sample: RasterizationOrderPass) {
            this.sample = sample;
        }

        buildUI(): void {
            const sample = this.sample;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            // The sample's title (ApiVulkanSample's default).
            Donut_ImGuiBegin("Vulkan Example", 1);
            if (sample.rovSupported) {
                sample.rovEnabled = Donut_ImGuiCheckbox("Enable ROAA", sample.rovEnabled ? 1 : 0) != 0;
            } else {
                Donut_ImGuiText("ROAA not supported on this device");
            }
            Donut_ImGuiText(`Draw calls: ${sample.drawCallCount()}`);
            Donut_ImGuiText(`Barriers: ${sample.barrierCount()}`);
            if (sample.hasGpuTime) {
                Donut_ImGuiText(`GPU time: ${formatFixed3(sample.gpuDrawTimeMs)} ms`);
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
        Donut_SetAppName("rasterization_order_attachment_access");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the settings window.
        // -norov: start with a draw and a barrier per sphere.
        let options = AppOptions.None;
        let withUI = true;
        let rov = true;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-norov") {
                rov = false;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new RasterizationOrderPass(app);
        if (!sample.init()) {
            app.destroy();
            return 1;
        }
        sample.rovEnabled = sample.rovEnabled && rov;

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
    return RasterizationOrderAttachmentAccess.main(argc, argv);
}

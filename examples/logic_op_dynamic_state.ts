// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace LogicOpDynamicState {
    const WINDOW_TITLE = "Donut Example: Logic Operations Dynamic State";

    // The sample's background model and HDR cube map (Vulkan-Samples' assets), the KTX cube map
    // converted to DDS at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const BACKGROUND_PATH = "media/logic_op_dynamic_state/cube.gltf";
    const ENVMAP_PATH = "media/logic_op_dynamic_state/uffizi_rgba16f_cube.dds";

    // Donut_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // struct UBOCOMM { float4x4 projection, view; } and struct UBOBAS, as f32 offsets.
    const CONST_PROJECTION = 0;
    const CONST_VIEW = 16;
    const CONST_FLOATS = 32;
    const BASELINE_FLOATS = 16;
    // The push constants: float4x4 model_matrix (identity: glm's, GLM_FORCE_CTOR_INIT); float4 color.
    const PUSH_FLOATS = 20;

    const LOGIC_OP_NAMES = "CLEAR|AND|AND_REVERSE|COPY|AND_INVERTED|NO_OP|XOR|OR|NOR|EQUIVALENT|INVERT|OR_REVERSE|COPY_INVERTED|OR_INVERTED|NAND|SET";
    const LOGIC_OP_COUNT = 16;

    // The sample's camera: a "look at" camera at (2, -4, -10), turned by (-15, 190, 0) degrees, 60
    // degrees vertically, reversed depth from 256 to 0.1 (glm::perspective with near and far swapped).
    const CAMERA_POSITION = [2.0, -4.0, -10.0];
    const CAMERA_ROTATION = [-15.0, 190.0, 0.0];
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

    function normalize3(x: number, y: number, z: number): number[] {
        const length = Math.sqrt(x * x + y * y + z * z);
        return [x / length, y / length, z / length];
    }

    // Port of Vulkan-Samples' logic_op_dynamic_state: a lit cube in front of an HDR environment,
    // the cube's pixels combined with what is behind them by a logic operation on their bits (XOR,
    // OR, INVERT...) instead of blending, picked in the UI. The sample changes the operation as
    // dynamic state of one pipeline (VK_EXT_extended_dynamic_state2); D3D has it in the pipeline
    // state, so here it is a pipeline per operation, created as the UI picks it. The sample draws
    // into a UNORM swapchain (logic operations work on UNORM and UINT targets), so its colors are
    // stored without sRGB encoding. Here one texture takes its place, typeless: the background
    // draws into it as RGBA8_UNORM, the cube too on Vulkan, as RGBA8_UINT on D3D (D3D12 has logic
    // operations on UINT targets only, D3D11.1 documents them for those: the cube's pixel shader
    // converts its color as UNORM would), and it's read as SRGBA8_UNORM when blitted to the (sRGB)
    // back buffer, which stores the same bytes.
    class LogicOpPass {
        private app: App;

        // The sample's setting: a LogicOp value (VK_LOGIC_OP_COPY at start).
        selectedOperation: int;
        // The cube's logic operation on a UINT view of the color target (D3D), not UNORM (Vulkan).
        uintLogicOps: boolean;

        // The sample's camera: rotation (degrees about x, y, z) and position.
        private cameraRotation: number[];
        private cameraPosition: number[];
        private leftButton: boolean;
        private rightButton: boolean;
        private middleButton: boolean;
        private mouseX: number;
        private mouseY: number;

        private backgroundVS: ShaderHandle;
        private backgroundPS: ShaderHandle;
        private baselineVS: ShaderHandle;
        private baselinePS: ShaderHandle;
        private backgroundInputLayout: InputLayoutHandle;
        private baselineInputLayout: InputLayoutHandle;
        private backgroundBindingLayout: BindingLayoutHandle;
        private baselineBindingLayout: BindingLayoutHandle;
        private backgroundBindingSet: BindingSet;
        private baselineBindingSet: BindingSet;
        private commonBuffer: BufferHandle;
        private baselineBuffer: BufferHandle;
        private background: GltfMesh;
        private cubePositions: BufferHandle;
        private cubeNormals: BufferHandle;
        private cubeIndices: BufferHandle;
        private cubeIndexCount: int;

        // The back buffer's size: color (typeless SRGBA8, see above) and depth targets, as UNORM
        // and as the cube's logic operation takes them (UINT on D3D).
        private colorBuffer: TextureHandle | null;
        private depthBuffer: TextureHandle | null;
        private framebuffer: Opaque | null;
        private uintFramebuffer: Opaque | null;
        private backgroundPipeline: Opaque | null;
        // A pipeline per logic operation, created when first drawn.
        private baselinePipelines: (Opaque | null)[];

        private constants: f32[];
        private baselineConstants: f32[];
        private pushConstants: f32[];

        constructor(app: App) {
            this.app = app;
            this.selectedOperation = LogicOp.Copy;
            this.uintLogicOps = false;
            this.cameraRotation = [CAMERA_ROTATION[0], CAMERA_ROTATION[1], CAMERA_ROTATION[2]];
            this.cameraPosition = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
            this.leftButton = false;
            this.rightButton = false;
            this.middleButton = false;
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.cubeIndexCount = 0;
            this.colorBuffer = null;
            this.depthBuffer = null;
            this.framebuffer = null;
            this.uintFramebuffer = null;
            this.backgroundPipeline = null;
            this.baselinePipelines = [];
            for (let i = 0; i < LOGIC_OP_COUNT; i++) {
                this.baselinePipelines.push(null);
            }
            this.constants = [];
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
            // struct UBOBAS: ambientLightColor, lightPosition, lightColor, lightIntensity.
            this.baselineConstants = [
                1.0, 1.0, 1.0, 0.1,
                -3.0, -8.0, 6.0, -1.0,
                1.0, 1.0, 1.0, 1.0,
                50.0, 0.0, 0.0, 0.0,
            ];
            // The model matrix (identity) and the cube's color.
            this.pushConstants = [
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
                0.75, 1.0, 1.0, 1.0,
            ];
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

        releaseTargets(): void {
            for (let i = 0; i < LOGIC_OP_COUNT; i++) {
                const pipeline = this.baselinePipelines[i];
                if (pipeline) {
                    this.app.releaseResource(pipeline);
                }
                this.baselinePipelines[i] = null;
            }
            const resources: (ResourceHandle | null)[] = [this.backgroundPipeline, this.framebuffer, this.uintFramebuffer, this.colorBuffer, this.depthBuffer];
            for (let i = 0; i < resources.length; i++) {
                const resource = resources[i];
                if (resource) {
                    this.app.releaseResource(resource);
                }
            }
            this.backgroundPipeline = null;
            this.framebuffer = null;
            this.uintFramebuffer = null;
            this.colorBuffer = null;
            this.depthBuffer = null;
        }

        onBackBufferResizing(): void {
            this.releaseTargets();
            // The blit's cached binding sets still reference the old color buffer.
            this.app.clearBindingCache();
        }

        // The sample's pipelines: reversed depth (greater passes), back faces culled.
        createTargets(width: int, height: int): void {
            const colorBuffer = this.app.createTypelessRenderTargetTexture(width, height, Format.SRGBA8_UNORM, "ColorBuffer");
            const depthBuffer = this.app.createRenderTargetTexture(width, height, Format.D32, "DepthBuffer");
            this.colorBuffer = colorBuffer;
            this.depthBuffer = depthBuffer;
            const framebuffer = this.app.createFramebufferWithColorFormat(colorBuffer, Format.RGBA8_UNORM, depthBuffer);
            this.framebuffer = framebuffer;
            this.uintFramebuffer = this.uintLogicOps
                ? this.app.createFramebufferWithColorFormat(colorBuffer, Format.RGBA8_UINT, depthBuffer)
                : this.app.createFramebufferWithColorFormat(colorBuffer, Format.RGBA8_UNORM, depthBuffer);

            // The background: counter-clockwise front faces. (The sample blends it, alpha over;
            // its alpha is 1, so that's a copy.)
            const desc = GraphicsPipelineDesc.create(this.backgroundVS, this.backgroundPS);
            desc.setInputLayout(this.backgroundInputLayout);
            desc.addBindingLayout(this.backgroundBindingLayout);
            desc.setDepthState(1, 1, ComparisonFunc.Greater);
            desc.setRasterState(CullMode.Back, FillMode.Solid, 1);
            this.backgroundPipeline = this.app.createGraphicsPipelineFromDesc(desc, framebuffer);
        }

        // The cube's pipeline for a logic operation, for its view of the color target (UINT on D3D):
        // clockwise front faces, the logic operation instead of blending.
        getBaselinePipeline(framebuffer: Opaque, logicOp: int): Opaque | null {
            const existing = this.baselinePipelines[logicOp];
            if (existing) {
                return existing;
            }
            const desc = GraphicsPipelineDesc.create(this.baselineVS, this.baselinePS);
            desc.setInputLayout(this.baselineInputLayout);
            desc.addBindingLayout(this.baselineBindingLayout);
            desc.setDepthState(1, 1, ComparisonFunc.Greater);
            desc.setRasterState(CullMode.Back, FillMode.Solid, 0);
            desc.setLogicOp(1, logicOp);
            const pipeline = this.app.createGraphicsPipelineFromDesc(desc, framebuffer);
            this.baselinePipelines[logicOp] = pipeline;
            return pipeline;
        }

        // The sample's update_uniform_buffers: its camera's matrices.
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
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (!this.framebuffer) {
                this.createTargets(width, height);
            }
            const framebuffer = this.framebuffer;
            const uintFramebuffer = this.uintFramebuffer;
            const colorBuffer = this.colorBuffer;
            const depthBuffer = this.depthBuffer;
            const backgroundPipeline = this.backgroundPipeline;
            if (!framebuffer || !uintFramebuffer || !colorBuffer || !depthBuffer || !backgroundPipeline) {
                return;
            }
            const baselinePipeline = this.getBaselinePipeline(uintFramebuffer, this.selectedOperation);
            if (!baselinePipeline) {
                return;
            }

            this.updateConstants(width, height);
            commandList.writeBuffer(this.commonBuffer, Ref(this.constants[0]), CONST_FLOATS * 4);
            commandList.writeBuffer(this.baselineBuffer, Ref(this.baselineConstants[0]), BASELINE_FLOATS * 4);

            // Reversed depth: the far plane is 0.
            commandList.clearTextureFloat(colorBuffer, 0.0, 0.0, 0.0, 0.0);
            commandList.clearDepth(depthBuffer, 0.0);

            /* Drawing background */
            frame.beginDrawToFramebuffer(backgroundPipeline, framebuffer);
            frame.drawAddBindingSet(this.backgroundBindingSet);
            frame.drawAddVertexBuffer(this.background.getVertexBuffer(), 0, 0);
            frame.drawSetIndexBuffer(this.background.getIndexBuffer());
            frame.drawIndexed(this.background.getIndexCount());

            /* Draw model, with the logic operation chosen in the GUI */
            frame.beginDrawToFramebuffer(baselinePipeline, uintFramebuffer);
            frame.drawAddBindingSet(this.baselineBindingSet);
            frame.drawAddVertexBuffer(this.cubePositions, 0, 0);
            frame.drawAddVertexBuffer(this.cubeNormals, 1, 0);
            frame.drawSetIndexBuffer(this.cubeIndices);
            frame.drawIndexedWithPushConstants(this.cubeIndexCount, Ref(this.pushConstants[0]), PUSH_FLOATS * 4);

            this.app.blitTexture(frame, colorBuffer);
        }

        // The sample's model_data_creation: a cube of 8 vertices, each with the normalized sum of
        // its three faces' normals, scaled by 8 and moved by (0, 1, 5). The sample draws it as 6
        // triangle strips of 4 indices separated by primitive restarts (dynamic topology and
        // primitive restart); NVRHI has no primitive restart, so here they are unrolled into a
        // triangle list: a strip's odd triangles with their first two vertices swapped, which keeps
        // their winding.
        createCube(commandList: CommandList): void {
            const corners = [
                0.0, 0.0, 0.0,
                1.0, 0.0, 0.0,
                1.0, 1.0, 0.0,
                0.0, 1.0, 0.0,
                0.0, 0.0, 1.0,
                1.0, 0.0, 1.0,
                1.0, 1.0, 1.0,
                0.0, 1.0, 1.0,
            ];
            let positions: f32[] = [];
            let normals: f32[] = [];
            for (let i = 0; i < 8; i++) {
                const x = corners[i * 3];
                const y = corners[i * 3 + 1];
                const z = corners[i * 3 + 2];
                positions.push(x * 8.0 + 0.0);
                positions.push(y * 8.0 + 1.0);
                positions.push(z * 8.0 + 5.0);
                // Each corner's faces: +1 or -1 along each axis.
                const n = normalize3(x * 2.0 - 1.0, y * 2.0 - 1.0, z * 2.0 - 1.0);
                normals.push(n[0]);
                normals.push(n[1]);
                normals.push(n[2]);
            }

            const strips = [
                0, 4, 3, 7,
                1, 0, 2, 3,
                2, 6, 1, 5,
                1, 5, 0, 4,
                4, 5, 7, 6,
                2, 3, 6, 7,
            ];
            let indices: int[] = [];
            for (let strip = 0; strip < 6; strip++) {
                for (let t = 0; t < 2; t++) {
                    const v = strip * 4 + t;
                    const first: int = strips[t % 2 == 0 ? v : v + 1];
                    const second: int = strips[t % 2 == 0 ? v + 1 : v];
                    const third: int = strips[v + 2];
                    indices.push(first);
                    indices.push(second);
                    indices.push(third);
                }
            }
            this.cubeIndexCount = indices.length;

            this.cubePositions = this.app.createStaticVertexBuffer(commandList, Ref(positions[0]), positions.length * 4, "CubePositions");
            this.cubeNormals = this.app.createStaticVertexBuffer(commandList, Ref(normals[0]), normals.length * 4, "CubeNormals");
            this.cubeIndices = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), indices.length * 4, "CubeIndices");
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            if (this.app.hasLogicOps() == 0) {
                console.log("This example needs logic operations in blend states (OutputMergerLogicOp, Vulkan's logicOp)");
                return false;
            }

            const shader = "logic_op_dynamic_state.hlsl";
            this.backgroundVS = this.app.createShader(shader, "background_vs", ShaderType.Vertex);
            this.backgroundPS = this.app.createShader(shader, "background_ps", ShaderType.Pixel);
            this.baselineVS = this.app.createShader(shader, "baseline_vs", ShaderType.Vertex);
            this.baselinePS = this.app.createShaderWithDefine(shader, "baseline_ps", ShaderType.Pixel, "UINT_OUTPUT",
                this.uintLogicOps ? "1" : "0");
            if (!this.backgroundVS || !this.backgroundPS || !this.baselineVS || !this.baselinePS) {
                return false;
            }

            // The blit's common passes, created on first use, upload their textures on a command
            // list of their own: create them before ours (or the frame's) is open.
            this.app.getCommonSampler(CommonSampler.PointClamp);

            // The background: the glTF loader's interleaved vertices; the cube: positions and
            // normals in buffers of their own.
            const backgroundLayoutDesc = InputLayoutDesc.create();
            backgroundLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            this.backgroundInputLayout = this.app.createInputLayout(backgroundLayoutDesc, this.backgroundVS);
            const baselineLayoutDesc = InputLayoutDesc.create();
            baselineLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, 12);
            baselineLayoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 0, 1, 12);
            this.baselineInputLayout = this.app.createInputLayout(baselineLayoutDesc, this.baselineVS);

            const commandList = this.app.createCommandList();
            commandList.open();
            const background = this.app.loadGltfMesh(commandList, BACKGROUND_PATH);
            // Load HDR cube map
            const envmap = this.app.loadTexture(commandList, ENVMAP_PATH, 0);
            this.createCube(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (background.isNull() || !envmap) {
                console.log("Cannot load the model and the cube map: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }
            this.background = background;

            // The sample's descriptor sets: the common UBO with the cube map (background), with the
            // lighting UBO and the push constants (cube).
            this.commonBuffer = this.app.createVolatileConstantBuffer(CONST_FLOATS * 4, "UBOCommon");
            this.baselineBuffer = this.app.createVolatileConstantBuffer(BASELINE_FLOATS * 4, "UBOBaseline");

            const backgroundLayoutBindingDesc = BindingLayoutDesc.create();
            backgroundLayoutBindingDesc.layoutVolatileConstantBuffer(0);
            backgroundLayoutBindingDesc.layoutTextureSRV(0);
            backgroundLayoutBindingDesc.layoutSampler(0);
            this.backgroundBindingLayout = this.app.createBindingLayout(backgroundLayoutBindingDesc, ShaderType.All);
            const backgroundSetDesc = BindingSetDesc.create();
            backgroundSetDesc.bindEntireConstantBuffer(0, this.commonBuffer);
            backgroundSetDesc.bindTextureSRV(0, envmap);
            // The framework's cube map sampler: trilinear, the device's maximum anisotropy (16).
            backgroundSetDesc.bindSampler(0, this.app.getCommonSampler(CommonSampler.AnisotropicWrap));
            this.backgroundBindingSet = this.app.createBindingSetForLayout(backgroundSetDesc, this.backgroundBindingLayout);

            const baselineLayoutBindingDesc = BindingLayoutDesc.create();
            baselineLayoutBindingDesc.layoutVolatileConstantBuffer(0);
            baselineLayoutBindingDesc.layoutVolatileConstantBuffer(1);
            baselineLayoutBindingDesc.layoutPushConstants(2, PUSH_FLOATS * 4);
            this.baselineBindingLayout = this.app.createBindingLayout(baselineLayoutBindingDesc, ShaderType.Vertex);
            const baselineSetDesc = BindingSetDesc.create();
            baselineSetDesc.bindEntireConstantBuffer(0, this.commonBuffer);
            baselineSetDesc.bindEntireConstantBuffer(1, this.baselineBuffer);
            baselineSetDesc.bindPushConstants(2, PUSH_FLOATS * 4);
            this.baselineBindingSet = this.app.createBindingSetForLayout(baselineSetDesc, this.baselineBindingLayout);

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
        private sample: LogicOpPass;

        constructor(sample: LogicOpPass) {
            this.sample = sample;
        }

        buildUI(): void {
            const sample = this.sample;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            // The sample's title (ApiVulkanSample's default).
            Donut_ImGuiBegin("Vulkan Example", 1);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Settings") != 0) {
                sample.selectedOperation = Donut_ImGuiCombo("Logic operation", sample.selectedOperation, LOGIC_OP_NAMES);
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
        Donut_SetAppName("logic_op_dynamic_state");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the settings window.
        // -op <0..15>: the logic operation at start (LogicOp, Vulkan's order: 3 is COPY).
        let options = AppOptions.None;
        let withUI = true;
        let operation: int = LogicOp.Copy;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-op" && i + 1 < argc) {
                i++;
                operation = Math.min(Math.max(parseInt(Donut_GetArg(argv, i)), 0), LOGIC_OP_COUNT - 1);
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new LogicOpPass(app);
        sample.uintLogicOps = api != GraphicsAPI.VULKAN;
        sample.selectedOperation = operation;
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
    return LogicOpDynamicState.main(argc, argv);
}

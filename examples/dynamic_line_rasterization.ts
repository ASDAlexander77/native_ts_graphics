// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace DynamicLineRasterization {
    const WINDOW_TITLE = "Donut Example: Dynamic Line Rasterization";

    // The sample's cube: its corners (float3), its triangles and its 12 edges.
    const VERTICES = [
        -1.0, -1.0, 1.0,
        1.0, -1.0, 1.0,
        1.0, 1.0, 1.0,
        -1.0, 1.0, 1.0,

        -1.0, -1.0, -1.0,
        1.0, -1.0, -1.0,
        1.0, 1.0, -1.0,
        -1.0, 1.0, -1.0,
    ];
    const CUBE_INDICES = [
        0, 1, 2, 2, 3, 0,
        4, 5, 6, 6, 7, 4,
        0, 3, 7, 7, 4, 0,
        1, 5, 6, 6, 2, 1,
        3, 2, 6, 6, 7, 3,
        0, 4, 5, 5, 1, 0,
    ];
    const EDGE_INDICES = [
        0, 1, 1, 2, 2, 3, 3, 0,
        4, 5, 5, 6, 6, 7, 7, 4,
        0, 4, 1, 5, 2, 6, 3, 7,
    ];

    // The fill (mostly transparent) and edge colors.
    const FILL_COLOR = [0.957, 0.384, 0.024, 0.1];
    const EDGE_COLOR = [0.957, 0.384, 0.024, 1.0];
    const CLEAR_COLOR = [0.05, 0.05, 0.05, 1.0];

    // The sample's camera: a look-at camera at (0, 1, -5) turned by (-15, 15, 0) degrees, a 45
    // degree vertical field of view, depth reversed (near 128, far 0.1, as the sample passes them).
    const CAMERA_POSITION = [0.0, 1.0, -5.0];
    const CAMERA_ROTATION = [-15.0, 15.0, 0.0];
    const CAMERA_FOV = 45.0;
    const Z_NEAR = 128.0;
    const Z_FAR = 0.1;

    // The sample's rasterization modes (VkLineRasterizationModeEXT), and the LineRasterization bits
    // of each, plain and stippled (DEFAULT: rectangular lines, as strictLines makes them).
    const MODE_NAMES = ["DEFAULT", "RECT", "BRESENHAM", "SMOOTH"];
    const MODE_BITS = [LineRasterization.Rectangular, LineRasterization.Rectangular, LineRasterization.Bresenham,
        LineRasterization.Smooth];
    const STIPPLED_MODE_BITS = [LineRasterization.StippledRectangular, LineRasterization.StippledRectangular,
        LineRasterization.StippledBresenham, LineRasterization.StippledSmooth];

    // CameraUbo: projection * view and its inverse.
    const CAMERA_FLOATS = 32;

    // ImGui's combo items: names separated by '|'.
    function comboItems(names: string[]): string {
        let items = "";
        for (let i = 0; i < names.length; i++) {
            items += (i > 0 ? "|" : "") + names[i];
        }
        return items;
    }

    // value as std::hex prints it (lowercase, no leading zeros).
    function hex(value: int): string {
        const digits = "0123456789abcdef";
        let result = "";
        let v = value;
        do {
            result = digits.charAt(v % 16) + result;
            v = Math.floor(v / 16);
        } while (v > 0);
        return result;
    }

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

    // The inverse of m, by Gauss-Jordan elimination with partial pivoting.
    function inverse(m: number[]): number[] {
        // Rows of [m | I].
        let a: number[] = [];
        for (let row = 0; row < 4; row++) {
            for (let column = 0; column < 4; column++) {
                a.push(m[column * 4 + row]);
            }
            for (let column = 0; column < 4; column++) {
                a.push(row == column ? 1.0 : 0.0);
            }
        }
        for (let column = 0; column < 4; column++) {
            let pivot = column;
            for (let row = column + 1; row < 4; row++) {
                if (Math.abs(a[row * 8 + column]) > Math.abs(a[pivot * 8 + column])) {
                    pivot = row;
                }
            }
            for (let k = 0; k < 8; k++) {
                const t = a[column * 8 + k];
                a[column * 8 + k] = a[pivot * 8 + k];
                a[pivot * 8 + k] = t;
            }
            const p = a[column * 8 + column];
            for (let k = 0; k < 8; k++) {
                a[column * 8 + k] /= p;
            }
            for (let row = 0; row < 4; row++) {
                if (row != column) {
                    const f = a[row * 8 + column];
                    for (let k = 0; k < 8; k++) {
                        a[row * 8 + k] -= f * a[column * 8 + k];
                    }
                }
            }
        }
        let result: number[] = [];
        for (let column = 0; column < 4; column++) {
            for (let row = 0; row < 4; row++) {
                result.push(a[row * 8 + 4 + column]);
            }
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
            this.rotation = [CAMERA_ROTATION[0], CAMERA_ROTATION[1], CAMERA_ROTATION[2]];
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

    // Port of Vulkan-Samples' dynamic_line_rasterization: a cube, filled faintly, its edges drawn as
    // lines whose rasterization mode (VK_EXT_line_rasterization's rectangular, Bresenham or smooth
    // lines), width and stipple are set in the UI, over a grid on the ground. The sample sets these
    // as dynamic state (VK_EXT_extended_dynamic_state3); here each combination in use is a pipeline
    // of its own, made when first drawn. D3D has its own three kinds of lines (quadrilateral,
    // aliased, alpha antialiased) and no width or stipple.
    class LineRasterizationPass {
        private app: App;
        private camera: SampleCamera;

        // The sample's settings, from its UI.
        fillEnabled: boolean;
        gridEnabled: boolean;
        rasterizationMode: int;
        lineWidth: number;
        stippleEnabled: boolean;
        stippleFactor: int;
        stipplePattern: boolean[];
        // LineRasterization bits and the widest line the device draws.
        modes: int;
        maxLineWidth: number;

        private baseVS: Opaque;
        private basePS: Opaque;
        private gridVS: Opaque;
        private gridPS: Opaque;
        private inputLayout: Opaque;
        private bindingLayout: Opaque;
        private bindingSet: BindingSet;
        private cameraBuffer: Opaque;
        private colorBuffer: Opaque;
        private vertexBuffer: Opaque;
        private cubeIndexBuffer: Opaque;
        private edgeIndexBuffer: Opaque;

        // Made on the first frame (the back buffer's layout), dropped on resize.
        private pipelinesCreated: boolean;
        private gridPipeline: Opaque;
        private fillPipeline: Opaque;
        // The edges' pipelines made so far, by their line state (edgeKey).
        private edgeKeys: string[];
        private edgePipelines: Opaque[];

        // Upload buffers.
        private cameraConstants: f32[];
        private colorConstants: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
            this.fillEnabled = true;
            this.gridEnabled = true;
            this.rasterizationMode = 0;
            this.lineWidth = 1.0;
            this.stippleEnabled = true;
            this.stippleFactor = 1;
            // The first half on: 0x00ff.
            this.stipplePattern = [];
            for (let i = 0; i < 16; i++) {
                this.stipplePattern.push(i < 8);
            }
            this.modes = 0;
            this.maxLineWidth = 1.0;
            this.pipelinesCreated = false;
            this.edgeKeys = [];
            this.edgePipelines = [];
            this.cameraConstants = [];
            for (let i = 0; i < CAMERA_FLOATS; i++) {
                this.cameraConstants.push(0.0);
            }
            this.colorConstants = [0.0, 0.0, 0.0, 0.0];
        }

        // The stipple pattern's bits, the first checkbox the lowest.
        pattern(): int {
            let result = 0;
            for (let i = 0; i < 16; i++) {
                if (this.stipplePattern[i]) {
                    result |= 1 << i;
                }
            }
            return result;
        }

        // Whether the device stipples lines of the selected mode.
        canStipple(): boolean {
            return (this.modes & STIPPLED_MODE_BITS[this.rasterizationMode]) != 0;
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

        releasePipelines(): void {
            if (this.pipelinesCreated) {
                this.app.releaseResource(this.gridPipeline);
                this.app.releaseResource(this.fillPipeline);
            }
            for (let i = 0; i < this.edgePipelines.length; i++) {
                this.app.releaseResource(this.edgePipelines[i]);
            }
            this.pipelinesCreated = false;
            this.edgeKeys = [];
            this.edgePipelines = [];
        }

        onBackBufferResizing(): void {
            this.releasePipelines();
        }

        // The sample's pipeline state: no depth test, no culling, counter-clockwise front faces,
        // blending by the source's alpha (the alpha written as is).
        pipelineDesc(vs: Opaque, ps: Opaque, primitiveType: PrimitiveType): GraphicsPipelineDesc {
            const desc = GraphicsPipelineDesc.create(vs, ps);
            desc.addBindingLayout(this.bindingLayout);
            desc.setPrimitiveType(primitiveType);
            desc.setDepthState(0, 0, ComparisonFunc.Always);
            desc.setRasterState(CullMode.None, FillMode.Solid, 1);
            desc.setBlendState(1, BlendFactor.SrcAlpha, BlendFactor.InvSrcAlpha, BlendOp.Add,
                BlendFactor.One, BlendFactor.Zero, BlendOp.Add);
            return desc;
        }

        // The edges' pipeline for the line settings.
        edgePipeline(frame: Frame): Opaque {
            const stipple = this.stippleEnabled && this.canStipple();
            const key = `${this.rasterizationMode} ${this.lineWidth} ${stipple ? 1 : 0} ${this.stippleFactor} ${this.pattern()}`;
            for (let i = 0; i < this.edgeKeys.length; i++) {
                if (this.edgeKeys[i] == key) {
                    return this.edgePipelines[i];
                }
            }
            const desc = this.pipelineDesc(this.baseVS, this.basePS, PrimitiveType.LineList);
            desc.setInputLayout(this.inputLayout);
            desc.setLineRasterization(this.rasterizationMode, this.lineWidth, stipple ? 1 : 0, this.stippleFactor, this.pattern());
            const pipeline = this.app.createGraphicsPipelineFromDescForFrame(desc, frame);
            this.edgeKeys.push(key);
            this.edgePipelines.push(pipeline);
            return pipeline;
        }

        // The sample's push constant.
        setColor(frame: Frame, color: number[]): void {
            for (let i = 0; i < 4; i++) {
                this.colorConstants[i] = color[i];
            }
            frame.getCommandList().writeBuffer(this.colorBuffer, Ref(this.colorConstants[0]), 4 * 4);
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (!this.pipelinesCreated) {
                const gridDesc = this.pipelineDesc(this.gridVS, this.gridPS, PrimitiveType.TriangleList);
                this.gridPipeline = this.app.createGraphicsPipelineFromDescForFrame(gridDesc, frame);
                const fillDesc = this.pipelineDesc(this.baseVS, this.basePS, PrimitiveType.TriangleList);
                fillDesc.setInputLayout(this.inputLayout);
                this.fillPipeline = this.app.createGraphicsPipelineFromDescForFrame(fillDesc, frame);
                this.pipelinesCreated = true;
            }
            // Keep a handful of edge pipelines: drop them all now and then.
            if (this.edgePipelines.length > 32) {
                for (let i = 0; i < this.edgePipelines.length; i++) {
                    this.app.releaseResource(this.edgePipelines[i]);
                }
                this.edgeKeys = [];
                this.edgePipelines = [];
            }

            // The sample's update_uniform_buffers: projection * view, into Donut's clip space (y
            // negated), and its inverse.
            const view = this.camera.view();
            let viewProj = multiply(perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR), view);
            for (let i = 1; i < 16; i += 4) {
                viewProj[i] = -viewProj[i];
            }
            const viewProjInverse = inverse(viewProj);
            for (let i = 0; i < 16; i++) {
                this.cameraConstants[i] = viewProj[i];
                this.cameraConstants[16 + i] = viewProjInverse[i];
            }
            commandList.writeBuffer(this.cameraBuffer, Ref(this.cameraConstants[0]), CAMERA_FLOATS * 4);
            // (Written before the grid's draw too, which binds it.)
            this.setColor(frame, FILL_COLOR);

            frame.clearColor(CLEAR_COLOR[0], CLEAR_COLOR[1], CLEAR_COLOR[2], CLEAR_COLOR[3]);

            // The grid.
            if (this.gridEnabled) {
                frame.beginDraw(this.gridPipeline);
                frame.drawAddBindingSet(this.bindingSet);
                frame.drawVertices(6);
            }

            // The cube's faces.
            if (this.fillEnabled) {
                frame.beginDraw(this.fillPipeline);
                frame.drawAddBindingSet(this.bindingSet);
                frame.drawSetIndexBuffer(this.cubeIndexBuffer);
                frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
                frame.drawIndexedRange(CUBE_INDICES.length, 0, 0);
            }

            // Its edges.
            this.setColor(frame, EDGE_COLOR);
            frame.beginDraw(this.edgePipeline(frame));
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawSetIndexBuffer(this.edgeIndexBuffer);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            frame.drawIndexedRange(EDGE_INDICES.length, 0, 0);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "dynamic_line_rasterization.hlsl";
            this.baseVS = this.app.createShader(shader, "base_vs", ShaderType.Vertex);
            this.basePS = this.app.createShader(shader, "base_ps", ShaderType.Pixel);
            this.gridVS = this.app.createShader(shader, "grid_vs", ShaderType.Vertex);
            this.gridPS = this.app.createShader(shader, "grid_ps", ShaderType.Pixel);
            if (!this.baseVS || !this.basePS || !this.gridVS || !this.gridPS) {
                return false;
            }
            this.modes = this.app.getLineRasterizationModes();
            this.maxLineWidth = this.app.getMaxLineWidth();

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, 12);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.baseVS);

            this.cameraBuffer = this.app.createVolatileConstantBuffer(CAMERA_FLOATS * 4, "CameraUbo");
            this.colorBuffer = this.app.createVolatileConstantBuffer(4 * 4, "Color");
            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutVolatileConstantBuffer(0);
            bindingLayoutDesc.layoutVolatileConstantBuffer(1);
            this.bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.All);
            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.cameraBuffer);
            setDesc.bindEntireConstantBuffer(1, this.colorBuffer);
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);

            let vertices: f32[] = [];
            for (let i = 0; i < VERTICES.length; i++) {
                vertices.push(VERTICES[i]);
            }
            let cubeIndices: int[] = [];
            for (let i = 0; i < CUBE_INDICES.length; i++) {
                cubeIndices.push(CUBE_INDICES[i]);
            }
            let edgeIndices: int[] = [];
            for (let i = 0; i < EDGE_INDICES.length; i++) {
                edgeIndices.push(EDGE_INDICES[i]);
            }
            const commandList = this.app.createCommandList();
            commandList.open();
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Vertices");
            this.cubeIndexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(cubeIndices[0]), cubeIndices.length * 4,
                "CubeIndices");
            this.edgeIndexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(edgeIndices[0]), edgeIndices.length * 4,
                "EdgeIndices");
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);

            const pass = this.app.addPass();
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's options.
    class UserInterface {
        private lines: LineRasterizationPass;

        constructor(lines: LineRasterizationPass) {
            this.lines = lines;
        }

        buildUI(): void {
            const l = this.lines;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Options", 1);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Primitive options") != 0) {
                l.fillEnabled = Donut_ImGuiCheckbox("Fill", l.fillEnabled ? 1 : 0) != 0;
                l.gridEnabled = Donut_ImGuiCheckbox("Grid", l.gridEnabled ? 1 : 0) != 0;
                // Only the modes the device has (DEFAULT always).
                const mode = Donut_ImGuiCombo("Rasterization mode", l.rasterizationMode, comboItems(MODE_NAMES));
                if (mode == 0 || (l.modes & MODE_BITS[mode]) != 0) {
                    l.rasterizationMode = mode;
                }
                // Wide lines and stipple: Vulkan's only.
                if (l.maxLineWidth > 1.0) {
                    l.lineWidth = Donut_ImGuiSliderFloat("Line width", l.lineWidth, 1.0, Math.min(64.0, l.maxLineWidth));
                }
                if (l.canStipple()) {
                    l.stippleEnabled = Donut_ImGuiCheckbox("Stipple enabled", l.stippleEnabled ? 1 : 0) != 0;
                    // The stipple factor has a maximum value of 256. Here, a limit of 64 has been chosen to achieve a scroll step equal to 1.
                    l.stippleFactor = Donut_ImGuiSliderInt("Stipple factor", l.stippleFactor, 1, 64);
                    Donut_ImGuiText(`Stipple pattern: ${hex(l.pattern())}`);
                    for (let i = 0; i < 16; i++) {
                        Donut_ImGuiPushID(i);
                        l.stipplePattern[i] = Donut_ImGuiCheckbox("", l.stipplePattern[i] ? 1 : 0) != 0;
                        Donut_ImGuiPopID();
                        if (i % 8 != 7) {
                            Donut_ImGuiSameLine();
                        }
                    }
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
        Donut_SetAppName("dynamic_line_rasterization");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the options window.
        // -mode <n>: the rasterization mode (0 DEFAULT, 1 RECT, 2 BRESENHAM, 3 SMOOTH).
        // -width <w>: the line width. -nostipple: stipple off. -nofill, -nogrid.
        let options = AppOptions.None;
        let withUI = true;
        let mode = 0;
        let lineWidth = 1.0;
        let stipple = true;
        let fill = true;
        let gridOn = true;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-mode" && i + 1 < argc) {
                mode = parseInt(Donut_GetArg(argv, i + 1));
                i++;
            } else if (arg == "-width" && i + 1 < argc) {
                lineWidth = parseFloat(Donut_GetArg(argv, i + 1));
                i++;
            } else if (arg == "-nostipple") {
                stipple = false;
            } else if (arg == "-nofill") {
                fill = false;
            } else if (arg == "-nogrid") {
                gridOn = false;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const lines = new LineRasterizationPass(app);
        if (!lines.init()) {
            app.destroy();
            return 1;
        }
        if (mode > 0 && mode < MODE_NAMES.length && (lines.modes & MODE_BITS[mode]) != 0) {
            lines.rasterizationMode = mode;
        } else if (mode != 0) {
            console.log("The graphics device doesn't have that line rasterization mode");
        }
        lines.lineWidth = Math.max(1.0, Math.min(lineWidth, lines.maxLineWidth));
        lines.stippleEnabled = stipple;
        lines.fillEnabled = fill;
        lines.gridEnabled = gridOn;

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(lines);
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
    return DynamicLineRasterization.main(argc, argv);
}

// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck } from "../core/test_check";
import { formatFixed } from "../core/text_format";
import {
    KEY_1, KEY_2, KEY_3, KEY_W, KEY_ESCAPE, KEY_RIGHT, KEY_LEFT, KEY_DOWN, KEY_UP, KEY_F1, KEY_KP_1, KEY_KP_2,
    KEY_KP_3, Action,
} from "../core/glfw_input";

namespace SimpleBezier {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame. The corners are the gray clear color; the tessellated red
    // Bezier patches cover about 30% of the frame, red in the middle.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        const corners = check.corners(0x414141);
        if (corners != "") {
            return corners;
        }
        const middle = check.rgb(check.width / 2, check.height / 2);
        if ((middle & 0xFF) < 150 || ((middle >> 8) & 0xFF) > 60) {
            return "the middle isn't the patches' red";
        }
        return check.share(check.countInRange(151, 255, 0, 89, 0, 89, 0, 0, check.width, check.height), total,
            25.0, 36.0, "Patches");
    }

    const WINDOW_TITLE = "Donut Example: Simple Bezier";
    const FONT_PATH = "media/fonts/OpenSans/OpenSans-Regular.ttf";
    // The sample's SegoeUI_18 sprite font (its lines 32 pixels apart) as the OpenSans size giving
    // its strings' widths: ImGui sizes a font by its ascent + descent (OpenSans: 1.3618 em), so a
    // 23 pixel em is 31.5.
    const FONT_SIZE = 31.5;
    const LINE_SPACING = 32.0;
    // The help screen's SegoeUI_36 title, the same way.
    const TITLE_FONT_SIZE = 61.8;

    // Min and max divisions of the patch per side for the slider control.
    const MIN_DIVS = 4.0;
    const MAX_DIVS = 16.0;
    // Startup subdivisions per side.
    const DEFAULT_SUBDIVS = 8.0;
    // Camera's rotation angle per step (XM_2PI / 360.0f).
    const ROTATION_ANGLE_PER_STEP = 0.0174532924;

    // cbPerFrame: float4x4 viewProjection, float3 cameraWorldPos, float tessellationFactor.
    const CB_FLOATS = 20;

    // ATG::ColorsLinear::Background, cleared in the sRGB back buffer as the sample's; the text's
    // ATG::Colors::LightGrey (#7A7A7A), written as is as SpriteBatch does.
    const BACKGROUND = 0.052860655;
    const LIGHT_GREY = 0.478431374;

    // Partition modes: the hull shaders' order.
    enum PartitionMode {
        Integer = 0,
        FractionalEven = 1,
        FractionalOdd = 2
    }
    const HULL_SHADERS = ["BezierHS_int", "BezierHS_fracEven", "BezierHS_fracOdd"];
    const PARTITION_NAMES = ["Integer", "Fractional Even", "Fractional Odd"];

    // Simple Bezier patch for a Mobius strip.
    // 4 patches with 16 control points each.
    const MOBIUS_STRIP: number[] = [
        1.0, -0.5, 0.0,
        1.0, -0.5, 0.5,
        0.5, -0.3536, 1.354,
        0.0, -0.3536, 1.354,
        1.0, -0.1667, 0.0,
        1.0, -0.1667, 0.5,
        0.5, -0.1179, 1.118,
        0.0, -0.1179, 1.118,
        1.0, 0.1667, 0.0,
        1.0, 0.1667, 0.5,
        0.5, 0.1179, 0.8821,
        0.0, 0.1179, 0.8821,
        1.0, 0.5, 0.0,
        1.0, 0.5, 0.5,
        0.5, 0.3536, 0.6464,
        0.0, 0.3536, 0.6464,
        0.0, -0.3536, 1.354,
        -0.5, -0.3536, 1.354,
        -1.5, 0.0, 0.5,
        -1.5, 0.0, 0.0,
        0.0, -0.1179, 1.118,
        -0.5, -0.1179, 1.118,
        -1.167, 0.0, 0.5,
        -1.167, 0.0, 0.0,
        0.0, 0.1179, 0.8821,
        -0.5, 0.1179, 0.8821,
        -0.8333, 0.0, 0.5,
        -0.8333, 0.0, 0.0,
        0.0, 0.3536, 0.6464,
        -0.5, 0.3536, 0.6464,
        -0.5, 0.0, 0.5,
        -0.5, 0.0, 0.0,
        -1.5, 0.0, 0.0,
        -1.5, 0.0, -0.5,
        -0.5, 0.3536, -1.354,
        0.0, 0.3536, -1.354,
        -1.167, 0.0, 0.0,
        -1.167, 0.0, -0.5,
        -0.5, 0.1179, -1.118,
        0.0, 0.1179, -1.118,
        -0.8333, 0.0, 0.0,
        -0.8333, 0.0, -0.5,
        -0.5, -0.1179, -0.8821,
        0.0, -0.1179, -0.8821,
        -0.5, 0.0, 0.0,
        -0.5, 0.0, -0.5,
        -0.5, -0.3536, -0.6464,
        0.0, -0.3536, -0.6464,
        0.0, 0.3536, -1.354,
        0.5, 0.3536, -1.354,
        1.0, 0.5, -0.5,
        1.0, 0.5, 0.0,
        0.0, 0.1179, -1.118,
        0.5, 0.1179, -1.118,
        1.0, 0.1667, -0.5,
        1.0, 0.1667, 0.0,
        0.0, -0.1179, -0.8821,
        0.5, -0.1179, -0.8821,
        1.0, -0.1667, -0.5,
        1.0, -0.1667, 0.0,
        0.0, -0.3536, -0.6464,
        0.5, -0.3536, -0.6464,
        1.0, -0.5, -0.5,
        1.0, -0.5, 0.0,
    ];
    const CONTROL_POINTS = 64;
    const PATCH_SIZE = 16;

    // Initial camera setup
    const CAMERA_EYE = [0.0, 0.45, 2.7];
    const CAMERA_AT = [0.0, 0.0, 0.0];
    const CAMERA_UP = [0.0, 1.0, 0.0];

    // --- Math (DirectXMath's layout: 4 x 4 matrices by rows, for row vectors; float precision) -

    function f(x: number) {
        return Math.fround(x);
    }

    function multiply(a: number[], b: number[]) {
        let result: number[] = [];
        for (let row = 0; row < 4; row++) {
            for (let column = 0; column < 4; column++) {
                let sum = 0.0;
                for (let k = 0; k < 4; k++) {
                    sum = f(sum + f(a[row * 4 + k] * b[k * 4 + column]));
                }
                result.push(sum);
            }
        }
        return result;
    }

    function normalize3(v: number[]) {
        const length = f(Math.sqrt(f(f(f(v[0] * v[0]) + f(v[1] * v[1])) + f(v[2] * v[2]))));
        return [f(v[0] / length), f(v[1] / length), f(v[2] / length)];
    }

    function cross3(a: number[], b: number[]) {
        return [f(f(a[1] * b[2]) - f(a[2] * b[1])), f(f(a[2] * b[0]) - f(a[0] * b[2])), f(f(a[0] * b[1]) - f(a[1] * b[0]))];
    }

    function dot3(a: number[], b: number[]) {
        return f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
    }

    // XMMatrixLookAtLH.
    function lookAtLH(eye: number[], at: number[], up: number[]) {
        const r2 = normalize3([f(at[0] - eye[0]), f(at[1] - eye[1]), f(at[2] - eye[2])]);
        const r0 = normalize3(cross3(up, r2));
        const r1 = cross3(r2, r0);
        const negEye = [-eye[0], -eye[1], -eye[2]];
        return [
            r0[0], r1[0], r2[0], 0.0,
            r0[1], r1[1], r2[1], 0.0,
            r0[2], r1[2], r2[2], 0.0,
            dot3(r0, negEye), dot3(r1, negEye), dot3(r2, negEye), 1.0,
        ];
    }

    // XMMatrixPerspectiveFovLH.
    function perspectiveFovLH(fovY: number, aspect: number, nearZ: number, farZ: number) {
        const height = f(f(Math.cos(0.5 * fovY)) / f(Math.sin(0.5 * fovY)));
        const width = f(height / aspect);
        const range = f(farZ / f(farZ - nearZ));
        return [
            width, 0.0, 0.0, 0.0,
            0.0, height, 0.0, 0.0,
            0.0, 0.0, range, 1.0,
            0.0, 0.0, f(-range * nearZ), 0.0,
        ];
    }

    // XMVector3Transform(v, XMMatrixRotationY(angle)).
    function rotateY(v: number[], angle: number) {
        const c = f(Math.cos(angle));
        const s = f(Math.sin(angle));
        return [f(f(v[0] * c) + f(v[2] * s)), v[1], f(f(-v[0] * s) + f(v[2] * c))];
    }

    // --- The sample ---------------------------------------------------------------------------

    // Port of SimpleBezierPC12.cpp: a Mobius strip made of four bicubic Bezier patches (16 control
    // points each), tessellated by hull and domain shaders with the same factor on every edge and
    // inside, in one of the three partitioning modes; lit by N dot L from the camera, or drawn in
    // dark green wireframe. Left/Right turn the camera around the strip, Up/Down change the
    // subdivisions (per frame, as the sample), 1/2/3 the partition mode, W the wireframe, F1 the
    // help screen.
    class SimpleBezierPass {
        private app: App;

        // Control variables
        subdivs: number;
        drawWires: boolean;
        partitionMode: int;
        showHelp: boolean;

        private viewMatrix: number[];
        private projectionMatrix: number[];
        private cameraEye: number[];
        private held: boolean[];

        private vs: ShaderHandle;
        private hullShaders: ShaderHandle[];
        private ds: ShaderHandle;
        private pixelShaders: ShaderHandle[];
        private inputLayout: InputLayoutHandle;
        private bindingLayout: BindingLayoutHandle;
        private bindingSet: BindingSet;
        private constantBuffer: BufferHandle;
        private controlPointVB: BufferHandle;
        private cb: f32[];

        // The depth buffer and a framebuffer per back buffer, for the back buffers' size, and the
        // pipelines ([wireframe][partition mode]) made for them.
        private depth: TextureHandle;
        private framebuffers: FramebufferHandle[];
        private pipelines: GraphicsPipelineHandle[];
        frameWidth: int;
        frameHeight: int;

        constructor(app: App) {
            this.app = app;
            this.subdivs = DEFAULT_SUBDIVS;
            this.drawWires = false;
            this.partitionMode = PartitionMode.Integer;
            this.showHelp = false;
            this.cameraEye = [CAMERA_EYE[0], CAMERA_EYE[1], CAMERA_EYE[2]];
            this.viewMatrix = lookAtLH(this.cameraEye, CAMERA_AT, CAMERA_UP);
            this.projectionMatrix = [];
            this.held = [];
            for (let i = 0; i < 512; i++) {
                this.held.push(false);
            }
            this.hullShaders = [];
            this.pixelShaders = [];
            this.framebuffers = [];
            this.pipelines = [];
            this.frameWidth = 0;
            this.frameHeight = 0;
            this.cb = [];
            for (let i = 0; i < CB_FLOATS; i++) {
                this.cb.push(0.0);
            }
        }

        init() {
            const shader = "simple_bezier.hlsl";
            this.vs = this.app.createShader(shader, "BezierVS", ShaderType.Vertex);
            this.ds = this.app.createShader(shader, "BezierDS", ShaderType.Domain);
            if (!this.vs || !this.ds) {
                return false;
            }
            for (const entryPoint of HULL_SHADERS) {
                const hs = this.app.createShader(shader, entryPoint, ShaderType.Hull);
                if (!hs) {
                    return false;
                }
                this.hullShaders.push(hs);
            }
            const solidPS = this.app.createShader(shader, "BezierPS", ShaderType.Pixel);
            const wirePS = this.app.createShader(shader, "SolidColorPS", ShaderType.Pixel);
            if (!solidPS || !wirePS) {
                return false;
            }
            this.pixelShaders.push(solidPS);
            this.pixelShaders.push(wirePS);

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, 12);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vs);

            // The control points.
            let points = MOBIUS_STRIP.map((v): f32 => v);
            const commandList = this.app.createCommandList();
            commandList.open();
            this.controlPointVB = this.app.createStaticVertexBuffer(commandList, Ref(points[0]), CONTROL_POINTS * 12, "Control Point VB");
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);

            // The per frame constant buffer, for every stage.
            this.constantBuffer = this.app.createVolatileConstantBuffer(CB_FLOATS * 4, "Per Frame CB");
            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutVolatileConstantBuffer(0);
            this.bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.All);
            const bindingSetDesc = BindingSetDesc.create();
            bindingSetDesc.bindEntireConstantBuffer(0, this.constantBuffer);
            this.bindingSet = this.app.createBindingSetForLayout(bindingSetDesc, this.bindingLayout);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        // Turns the camera around the strip (positive: to the left), steps times.
        rotateCamera(angle: number, steps: int) {
            for (let i = 0; i < steps; i++) {
                this.cameraEye = rotateY(this.cameraEye, angle);
            }
            this.viewMatrix = lookAtLH(this.cameraEye, CAMERA_AT, CAMERA_UP);
        }

        // Sample::Update's key presses: one action per press, in the sample's order.
        onKey(key: int, scancode: int, action: int, mods: int) {
            if (key >= 0 && key < 512) {
                this.held[key] = action != Action.Release;
            }
            if (action != Action.Press) {
                return 0;
            }
            if (key == KEY_F1) {
                this.showHelp = !this.showHelp;
            } else if (this.showHelp && key == KEY_ESCAPE) {
                this.showHelp = false;
            } else if (key == KEY_W) {
                this.drawWires = !this.drawWires;
            } else if (key == KEY_1 || key == KEY_KP_1) {
                this.partitionMode = PartitionMode.Integer;
            } else if (key == KEY_2 || key == KEY_KP_2) {
                this.partitionMode = PartitionMode.FractionalEven;
            } else if (key == KEY_3 || key == KEY_KP_3) {
                this.partitionMode = PartitionMode.FractionalOdd;
            } else {
                // Escape (outside the help screen) goes on to InputPass, which closes the window.
                return 0;
            }
            return 1;
        }

        // Sample::Update's held keys, once per frame.
        onAnimate(elapsedSeconds: number) {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            const held = this.held;
            if (held[KEY_DOWN]) {
                this.subdivs = Math.max(f(this.subdivs - f(0.1)), MIN_DIVS);
            }
            if (held[KEY_UP]) {
                this.subdivs = Math.min(f(this.subdivs + f(0.1)), MAX_DIVS);
            }
            if (held[KEY_LEFT]) {
                this.rotateCamera(ROTATION_ANGLE_PER_STEP, 1);
            } else if (held[KEY_RIGHT]) {
                this.rotateCamera(-ROTATION_ANGLE_PER_STEP, 1);
            }
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
            this.frameWidth = 0;
            this.frameHeight = 0;
        }

        // The sample's PSOs: 16 control point patches, no culling, depth clip on, depth tested
        // (less) and written; solid with BezierPS or wireframe with SolidColorPS.
        createPipeline(wireframe: int, partitionMode: int) {
            const desc = GraphicsPipelineDesc.create(this.vs, this.pixelShaders[wireframe]);
            desc.setTessellation(this.hullShaders[partitionMode], this.ds, PATCH_SIZE);
            desc.setInputLayout(this.inputLayout);
            desc.addBindingLayout(this.bindingLayout);
            desc.setDepthState(1, 1, ComparisonFunc.Less);
            desc.setRasterState(CullMode.None, wireframe != 0 ? FillMode.Wireframe : FillMode.Solid, 0);
            desc.setDepthClip(1);
            // The edges are aliased lines (MultisampleEnable FALSE): D3D's diamond-exit rule, which
            // is Vulkan's Bresenham mode (VK_EXT_line_rasterization), where the device has it.
            if (wireframe != 0 && (this.app.getLineRasterizationModes() & LineRasterization.Bresenham) != 0) {
                desc.setLineRasterization(LineRasterizationMode.Bresenham, 1.0, 0, 1, 0xFFFF);
            }
            return this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]);
        }

        // Sample::CreateWindowSizeDependentResources: the depth buffer (D32_FLOAT) and projection.
        createTargets(width: int, height: int) {
            this.releaseTargets();
            this.depth = this.app.createDepthTexture(width, height, Format.D32, 1.0, "Depth");
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), this.depth));
            }
            if (this.pipelines.length == 0) {
                for (let wireframe = 0; wireframe < 2; wireframe++) {
                    for (let mode = 0; mode < HULL_SHADERS.length; mode++) {
                        this.pipelines.push(this.createPipeline(wireframe, mode));
                    }
                }
            }
            const aspect = f(f(width) / f(height));
            this.projectionMatrix = perspectiveFovLH(Math.PI / 4.0, aspect, 0.01, 100.0);
            this.frameWidth = width;
            this.frameHeight = height;
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            if (this.frameWidth != width || this.frameHeight != height) {
                this.createTargets(width, height);
            }

            // Sample::Clear.
            const commandList = frame.getCommandList();
            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), BACKGROUND, BACKGROUND, BACKGROUND, 1.0);
            commandList.clearDepth(this.depth, 1.0);
            if (this.showHelp) {
                return;
            }

            // Update per-frame variables.
            const viewProjection = multiply(this.viewMatrix, this.projectionMatrix);
            for (let i = 0; i < 16; i++) {
                this.cb[i] = viewProjection[i];
            }
            this.cb[16] = this.cameraEye[0];
            this.cb[17] = this.cameraEye[1];
            this.cb[18] = this.cameraEye[2];
            this.cb[19] = this.subdivs;
            commandList.writeBuffer(this.constantBuffer, Ref(this.cb[0]), CB_FLOATS * 4);

            // Draw the mesh
            const wireframe = this.drawWires ? 1 : 0;
            frame.beginDrawToFramebuffer(this.pipelines[wireframe * HULL_SHADERS.length + this.partitionMode],
                this.framebuffers[index]);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawAddVertexBuffer(this.controlPointVB, 0, 0);
            frame.drawVertices(CONTROL_POINTS);
        }
    }

    // The sample's HUD (SpriteFont text in the title-safe area): the settings at the top, the
    // controls at the bottom. Port: the help screen (ATG::Help, a gamepad picture with callouts)
    // is the sample's title, description and keyboard controls as text.
    class UserInterface {
        private sample: SimpleBezierPass;
        private app: App;

        font: ImGuiFont;
        titleFont: ImGuiFont;

        constructor(sample: SimpleBezierPass, app: App) {
            this.sample = sample;
            this.app = app;
        }

        init() {
            const imguiPass = this.app.addImGuiPass(this.buildUI);
            if (imguiPass.isNull()) {
                return false;
            }
            this.font = imguiPass.createFont(FONT_PATH, FONT_SIZE);
            this.titleFont = imguiPass.createFont(FONT_PATH, TITLE_FONT_SIZE);
            if (this.font.isNull() || this.titleFont.isNull()) {
                console.log("Cannot load the font: set DONUT_SAMPLES_MEDIA_DIR when configuring");
                return false;
            }
            return true;
        }

        line(x: number, y: number, text: string) {
            Donut_ImGuiDrawText(x, y, text, LIGHT_GREY, LIGHT_GREY, LIGHT_GREY, 1.0, 0);
        }

        buildUI() {
            const sample = this.sample;
            // SimpleMath::Viewport::ComputeTitleSafeArea
            const safeW = Math.fround((sample.frameWidth + 19.0) / 20.0);
            const safeH = Math.fround((sample.frameHeight + 19.0) / 20.0);
            const left: int = Math.floor(safeW);
            const top: int = Math.floor(safeH);
            const bottom: int = Math.floor(sample.frameHeight - safeH + 0.5);

            if (sample.showHelp) {
                this.titleFont.push();
                this.line(left, top, "Simple Bezier Sample");
                Donut_ImGuiPopFont();
                this.font.push();
                const y = top + TITLE_FONT_SIZE + LINE_SPACING;
                this.line(left, y, "Demonstrates how to create hull and domain shaders to draw a");
                this.line(left, y + LINE_SPACING, "tessellated Bezier surface representing a Mobius strip.");
                const controls = [
                    "Left/Right: Rotate Camera",
                    "Down: Decrease Subdivisions",
                    "Up: Increase Subdivisions",
                    "W: Toggle Wireframe",
                    "1: Integer Partitioning",
                    "2: Fractional Partitioning (Even)",
                    "3: Fractional Partitioning (Odd)",
                    "F1: Show/Hide Help",
                    "Esc: Exit (or hide this help)",
                ];
                for (let i = 0; i < controls.length; i++) {
                    this.line(left, y + (i + 3) * LINE_SPACING, controls[i]);
                }
                Donut_ImGuiPopFont();
                return;
            }

            this.font.push();
            this.line(left, top, `Subdivisions: ${formatFixed(sample.subdivs, 2)}   Partition Mode: ${PARTITION_NAMES[sample.partitionMode]}`);
            this.line(left, bottom - 2 * LINE_SPACING, "Left/Right - Rotate   Up/Down - Increase/decrease subdivisions");
            this.line(left, bottom - LINE_SPACING, "1/2/3 - Change partition mode   W - Toggle wireframe   Esc - Exit   F1 - Help");
            Donut_ImGuiPopFont();
        }
    }

    // The initial settings: -wireframe, -partition <0..2>, -subdivs <4..16>, -rotate <steps>, -help
    // (wireframe, partition mode, subdivisions, the camera turned by Left/Right steps, the help
    // screen).
    class SimpleBezierArgs extends Args {
        wireframe = false;
        partitionMode: int = PartitionMode.Integer;
        subdivs = DEFAULT_SUBDIVS;
        rotateSteps = 0;
        showHelp = false;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-wireframe") {
                    this.wireframe = true;
                } else if (arg == "-partition" && i + 1 < this.argc) {
                    i++;
                    this.partitionMode = Math.min(Math.max(parseInt(this[i]), 0), 2);
                } else if (arg == "-subdivs" && i + 1 < this.argc) {
                    i++;
                    this.subdivs = Math.min(Math.max(Math.fround(parseFloat(this[i])), MIN_DIVS), MAX_DIVS);
                } else if (arg == "-rotate" && i + 1 < this.argc) {
                    i++;
                    this.rotateSteps = parseInt(this[i]);
                } else if (arg == "-help") {
                    this.showHelp = true;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("simple_bezier");

        const args = new SimpleBezierArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // The sample's sRGB back buffers (gamma-correct rendering), in a 1280 x 720 window.
        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        // Before the sample's pass, which then sees the keys first (Escape closes the help screen).
        const input = new InputPass(app.handle);

        const sample = new SimpleBezierPass(app);
        if (!sample.init()) {
            app.destroy();
            return 1;
        }
        sample.drawWires = args.wireframe;
        sample.partitionMode = args.partitionMode;
        sample.subdivs = args.subdivs;
        sample.showHelp = args.showHelp;
        if (args.rotateSteps > 0) {
            sample.rotateCamera(ROTATION_ANGLE_PER_STEP, args.rotateSteps);
        } else if (args.rotateSteps < 0) {
            sample.rotateCamera(-ROTATION_ANGLE_PER_STEP, -args.rotateSteps);
        }

        const ui = new UserInterface(sample, app);
        if (!ui.init()) {
            app.destroy();
            return 1;
        }

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
    return SimpleBezier.main(argc, argv);
}

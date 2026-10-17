// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck } from "../core/test_check";
import { identity, multiply, rotate, inverseRigid, radians, perspective } from "../core/matrix";
import { comboItems } from "../core/text_format";

namespace DynamicBlending {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame. The corners are the gray background; the two blended quads,
    // right of the settings window, cover about a fifth of the frame's right half and its middle.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        const corners = check.corners(0xBCBCBC);
        if (corners != "") {
            return corners;
        }
        if (check.rgb(check.width / 2, check.height / 2) == 0xBCBCBC) {
            return "no quad in the middle";
        }
        const half = check.width / 2;
        return check.share(check.countOtherThan(0xBCBCBC, half, 0, half, check.height), half * check.height,
            12.0, 35.0, "Quads, right half");
    }

    const WINDOW_TITLE = "Donut Example: Dynamic Blending";

    // The sample's two faces: float3 position, float2 texture coordinates per vertex.
    const VERTEX_FLOATS = 5;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const VERTICES = [
        -1.0, -1.0, 1.0, 0.0, 0.0,
        1.0, -1.0, 1.0, 1.0, 0.0,
        1.0, 1.0, 1.0, 1.0, 1.0,
        -1.0, 1.0, 1.0, 0.0, 1.0,

        -1.0, -1.0, -1.0, 0.0, 0.0,
        1.0, -1.0, -1.0, 1.0, 0.0,
        1.0, 1.0, -1.0, 1.0, 1.0,
        -1.0, 1.0, -1.0, 0.0, 1.0,
    ];
    // The face at z = -1 (6 indices from 0), then the one at z = 1 (6 from 6).
    const INDICES = [6, 5, 4, 4, 7, 6, 0, 1, 2, 2, 3, 0];
    const FACE_INDEX_COUNT = 6;

    // The sample's camera: a look-at camera at (0, 0, -5) turned by (-15, 15, 0) degrees, a 45
    // degree vertical field of view, depth reversed (near 256, far 0.1, as the sample passes them).
    const CAMERA_POSITION = [0.0, 0.0, -5.0];
    const CAMERA_ROTATION = [-15.0, 15.0, 0.0];
    const CAMERA_FOV = 45.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // Vulkan's blend operations (VK_BLEND_OP_ADD ... MAX) and blend factors (VK_BLEND_FACTOR_ZERO
    // ... SRC_ALPHA_SATURATE), as the sample names them, and NVRHI's for them. NVRHI has no constant
    // alpha factors: their constant is 0, as the constant color's (the sample's blend constants are
    // zeros), so the constant color's factors do the same.
    const BLEND_OP_NAMES = ["ADD", "SUBTRACT", "REVERSE_SUBTRACT", "MIN", "MAX"];
    const BLEND_OPS = [BlendOp.Add, BlendOp.Subtract, BlendOp.ReverseSubtract, BlendOp.Min, BlendOp.Max];
    const BLEND_FACTOR_NAMES = ["ZERO", "ONE", "SRC_COLOR", "ONE_MINUS_SRC_COLOR", "DST_COLOR", "ONE_MINUS_DST_COLOR",
        "SRC_ALPHA", "ONE_MINUS_SRC_ALPHA", "DST_ALPHA", "ONE_MINUS_DST_ALPHA", "CONSTANT_COLOR",
        "ONE_MINUS_CONSTANT_COLOR", "CONSTANT_ALPHA", "ONE_MINUS_CONSTANT_ALPHA", "SRC_ALPHA_SATURATE"];
    const BLEND_FACTORS = [BlendFactor.Zero, BlendFactor.One, BlendFactor.SrcColor, BlendFactor.InvSrcColor,
        BlendFactor.DstColor, BlendFactor.InvDstColor, BlendFactor.SrcAlpha, BlendFactor.InvSrcAlpha, BlendFactor.DstAlpha,
        BlendFactor.InvDstAlpha, BlendFactor.ConstantColor, BlendFactor.InvConstantColor, BlendFactor.ConstantColor,
        BlendFactor.InvConstantColor, BlendFactor.SrcAlphaSaturate];
    // The same for the alpha: a color factor's alpha is its alpha factor's (D3D takes only those
    // there).
    const ALPHA_BLEND_FACTORS = [BlendFactor.Zero, BlendFactor.One, BlendFactor.SrcAlpha, BlendFactor.InvSrcAlpha,
        BlendFactor.DstAlpha, BlendFactor.InvDstAlpha, BlendFactor.SrcAlpha, BlendFactor.InvSrcAlpha, BlendFactor.DstAlpha,
        BlendFactor.InvDstAlpha, BlendFactor.ConstantColor, BlendFactor.InvConstantColor, BlendFactor.ConstantColor,
        BlendFactor.InvConstantColor, BlendFactor.SrcAlphaSaturate];
    const VK_BLEND_FACTOR_ZERO = 0;
    const VK_BLEND_FACTOR_ONE = 1;
    const VK_BLEND_FACTOR_SRC_ALPHA = 6;
    const VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA = 7;
    // VK_EXT_blend_operation_advanced's operations, from VK_BLEND_OP_ZERO_EXT.
    const ADVANCED_BLEND_OP_NAMES = ["ZERO_EXT", "SRC_EXT", "DST_EXT", "SRC_OVER_EXT", "DST_OVER_EXT", "SRC_IN_EXT",
        "DST_IN_EXT", "SRC_OUT_EXT", "DST_OUT_EXT", "SRC_ATOP_EXT", "DST_ATOP_EXT", "XOR_EXT", "MULTIPLY_EXT", "SCREEN_EXT",
        "OVERLAY_EXT", "DARKEN_EXT", "LIGHTEN_EXT", "COLORDODGE_EXT", "COLORBURN_EXT", "HARDLIGHT_EXT", "SOFTLIGHT_EXT",
        "DIFFERENCE_EXT", "EXCLUSION_EXT", "INVERT_EXT", "INVERT_RGB_EXT", "LINEARDODGE_EXT", "LINEARBURN_EXT",
        "VIVIDLIGHT_EXT", "LINEARLIGHT_EXT", "PINLIGHT_EXT", "HARDMIX_EXT", "HSL_HUE_EXT", "HSL_SATURATION_EXT",
        "HSL_COLOR_EXT", "HSL_LUMINOSITY_EXT", "PLUS_EXT", "PLUS_CLAMPED_EXT", "PLUS_CLAMPED_ALPHA_EXT", "PLUS_DARKER_EXT",
        "MINUS_EXT", "MINUS_CLAMPED_EXT", "CONTRAST_EXT", "INVERT_OVG_EXT", "RED_EXT", "GREEN_EXT", "BLUE_EXT"];
    const ADVANCED_SRC_OVER = 3;
    // VK_BLEND_OVERLAP_CONJOINT_EXT, as the sample sets.
    const ADVANCED_OVERLAP_CONJOINT = 2;

    // The blend options.
    const BLEND_EQUATION = 0;
    const BLEND_ADVANCED = 1;

    // ColorUbo: 8 float4 colors.
    const COLOR_FLOATS = 32;

    // A ColorMask from the sample's red, green, blue, alpha switches.
    function colorMask(enabled: boolean[]) {
        let mask = 0;
        if (enabled[0]) {
            mask |= ColorMask.Red;
        }
        if (enabled[1]) {
            mask |= ColorMask.Green;
        }
        if (enabled[2]) {
            mask |= ColorMask.Blue;
        }
        if (enabled[3]) {
            mask |= ColorMask.Alpha;
        }
        return mask;
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
        view() {
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
        mouseButton(button: int, action: int) {
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

    // One face's settings: its corner colors (top left, top right, bottom left, bottom right; 4
    // floats each) and which channels it writes (red, green, blue, alpha).
    class FacePreferences {
        indexOffset: int;
        colors: f32[];
        colorBitEnabled: boolean[];

        constructor(indexOffset: int, colors: number[]) {
            this.indexOffset = indexOffset;
            this.colors = [];
            for (let i = 0; i < 16; i++) {
                this.colors.push(colors[i]);
            }
            this.colorBitEnabled = [true, true, true, true];
        }
    }

    // --- Pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' dynamic_blending: two overlapping faces, each with a color per corner,
    // the far one drawn first, blended by the blend state set in the UI: blending on or off, its
    // equation (operations and factors of the color and of the alpha) or an advanced blend
    // operation (VK_EXT_blend_operation_advanced), and each face's color write mask. The sample
    // sets these as dynamic state (VK_EXT_extended_dynamic_state3); here each combination in use is
    // a pipeline of its own, made when first drawn. Advanced blend operations are Vulkan's only.
    class DynamicBlendingPass {
        private app: App;
        private camera: SampleCamera;

        // The sample's settings, from its UI.
        clearColor: f32[];
        faces: FacePreferences[];
        blendEnable: boolean;
        blendOption: int;
        colorOperator: int;
        alphaOperator: int;
        srcColorBlendFactor: int;
        dstColorBlendFactor: int;
        srcAlphaBlendFactor: int;
        dstAlphaBlendFactor: int;
        advancedOperator: int;
        srcPremultiplied: boolean;
        dstPremultiplied: boolean;
        // AdvancedBlend bits.
        advancedBlendOperations: int;

        private vs: ShaderHandle;
        private ps: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private bindingLayout: BindingLayoutHandle;
        private bindingSet: BindingSet;
        private cameraBuffer: BufferHandle;
        private colorBuffer: BufferHandle;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;

        // The depth buffer (reversed) and a framebuffer per back buffer, for the back buffers' size.
        private depth: TextureHandle;
        private framebuffers: FramebufferHandle[];
        private targetWidth: int;
        private targetHeight: int;
        // The pipelines made so far, by their blend state (pipelineKey).
        private pipelineKeys: string[];
        private pipelines: GraphicsPipelineHandle[];

        // Upload buffers.
        private cameraConstants: f32[];
        private colorConstants: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
            this.clearColor = [0.5, 0.5, 0.5, 1.0];
            this.faces = [
                new FacePreferences(0, [
                    1.0, 0.0, 0.0, 1.0,
                    0.0, 1.0, 0.0, 1.0,
                    0.0, 0.0, 1.0, 1.0,
                    0.0, 0.0, 0.0, 1.0]),
                new FacePreferences(FACE_INDEX_COUNT, [
                    0.0, 1.0, 1.0, 0.5,
                    1.0, 0.0, 1.0, 0.5,
                    1.0, 1.0, 0.0, 0.5,
                    1.0, 1.0, 1.0, 0.5]),
            ];
            this.blendEnable = true;
            this.blendOption = BLEND_EQUATION;
            this.colorOperator = 0;
            this.alphaOperator = 0;
            this.srcColorBlendFactor = VK_BLEND_FACTOR_SRC_ALPHA;
            this.dstColorBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
            this.srcAlphaBlendFactor = VK_BLEND_FACTOR_ZERO;
            this.dstAlphaBlendFactor = VK_BLEND_FACTOR_ONE;
            this.advancedOperator = ADVANCED_SRC_OVER;
            this.srcPremultiplied = true;
            this.dstPremultiplied = true;
            this.advancedBlendOperations = 0;
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.pipelineKeys = [];
            this.pipelines = [];
            this.cameraConstants = [];
            for (let i = 0; i < 16; i++) {
                this.cameraConstants.push(0.0);
            }
            this.colorConstants = [];
            for (let i = 0; i < COLOR_FLOATS; i++) {
                this.colorConstants.push(0.0);
            }
        }

        onMousePos(x: number, y: number) {
            this.camera.mouseMove(x, y);
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int) {
            this.camera.mouseButton(button, action);
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
            this.targetWidth = width;
            this.targetHeight = height;
        }

        // What makes a face's pipeline differ: the blend state and the face's write mask.
        pipelineKey(face: FacePreferences) {
            const mask = colorMask(face.colorBitEnabled);
            const blend = this.blendEnable ? 1 : 0;
            if (this.blendOption == BLEND_ADVANCED) {
                return `a ${blend} ${this.advancedOperator} ${this.srcPremultiplied ? 1 : 0} ${this.dstPremultiplied ? 1 : 0} ${mask}`;
            }
            return `e ${blend} ${this.colorOperator} ${this.srcColorBlendFactor} ${this.dstColorBlendFactor} `
                + `${this.alphaOperator} ${this.srcAlphaBlendFactor} ${this.dstAlphaBlendFactor} ${mask}`;
        }

        // The sample's pipeline with a face's dynamic state: depth test (greater: reversed) and
        // write, no culling, the blend state, the face's color write mask.
        facePipeline(face: FacePreferences) {
            const key = this.pipelineKey(face);
            for (let i = 0; i < this.pipelineKeys.length; i++) {
                if (this.pipelineKeys[i] == key) {
                    return this.pipelines[i];
                }
            }
            const desc = GraphicsPipelineDesc.create(this.vs, this.ps);
            desc.setInputLayout(this.inputLayout);
            desc.addBindingLayout(this.bindingLayout);
            desc.setDepthState(1, 1, ComparisonFunc.Greater);
            desc.setRasterState(CullMode.None, FillMode.Solid, 1);
            desc.setBlendState(this.blendEnable ? 1 : 0,
                BLEND_FACTORS[this.srcColorBlendFactor], BLEND_FACTORS[this.dstColorBlendFactor], BLEND_OPS[this.colorOperator],
                ALPHA_BLEND_FACTORS[this.srcAlphaBlendFactor], ALPHA_BLEND_FACTORS[this.dstAlphaBlendFactor],
                BLEND_OPS[this.alphaOperator]);
            if (this.blendOption == BLEND_ADVANCED) {
                desc.setAdvancedBlendOp(this.advancedOperator, this.srcPremultiplied ? 1 : 0, this.dstPremultiplied ? 1 : 0,
                    ADVANCED_OVERLAP_CONJOINT);
            }
            desc.setColorWriteMask(colorMask(face.colorBitEnabled));
            const pipeline = this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]);
            this.pipelineKeys.push(key);
            this.pipelines.push(pipeline);
            return pipeline;
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }
            // Keep a handful of pipelines: drop them all now and then.
            if (this.pipelines.length > 32) {
                for (const pipeline of this.pipelines) {
                    this.app.releaseResource(pipeline);
                }
                this.pipelineKeys = [];
                this.pipelines = [];
            }

            // The sample's update_uniform_buffers: projection * view * model (identity), into
            // Donut's clip space (y negated); and its update_color.
            const view = this.camera.view();
            const viewProj = multiply(perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR), view);
            for (let i = 0; i < 16; i++) {
                this.cameraConstants[i] = i % 4 == 1 ? -viewProj[i] : viewProj[i];
            }
            commandList.writeBuffer(this.cameraBuffer, Ref(this.cameraConstants[0]), 16 * 4);
            for (let face = 0; face < 2; face++) {
                for (let i = 0; i < 16; i++) {
                    this.colorConstants[face * 16 + i] = this.faces[face].colors[i];
                }
            }
            commandList.writeBuffer(this.colorBuffer, Ref(this.colorConstants[0]), COLOR_FLOATS * 4);

            // Which face is drawn first, as the sample decides it: the vertices 0 (on the z = 1 face)
            // and 4 (on the z = -1 one) through the inverse of the view, the one with the smaller z
            // last.
            const inverseView = inverseRigid(view);
            const z0 = inverseView[2] * VERTICES[0] + inverseView[6] * VERTICES[1] + inverseView[10] * VERTICES[2] + inverseView[14];
            const z4 = inverseView[2] * VERTICES[20] + inverseView[6] * VERTICES[21] + inverseView[10] * VERTICES[22] + inverseView[14];
            const reverse = z0 < z4;

            // The render pass: the background color, depth cleared to 0.
            const backBuffer = this.app.getBackBuffer(this.app.getCurrentBackBufferIndex());
            commandList.clearTextureFloat(backBuffer, this.clearColor[0], this.clearColor[1], this.clearColor[2], this.clearColor[3]);
            commandList.clearDepth(this.depth, 0.0);
            const framebuffer = this.framebuffers[this.app.getCurrentBackBufferIndex()];
            for (let i = 0; i < 2; i++) {
                const face = this.faces[reverse ? 1 - i : i];
                frame.beginDrawToFramebuffer(this.facePipeline(face), framebuffer);
                frame.drawAddBindingSet(this.bindingSet);
                frame.drawSetIndexBuffer(this.indexBuffer);
                frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
                frame.drawIndexedRange(FACE_INDEX_COUNT, face.indexOffset, 0);
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init() {
            const shader = "dynamic_blending.hlsl";
            this.vs = this.app.createShader(shader, "main_vs", ShaderType.Vertex);
            this.ps = this.app.createShader(shader, "main_ps", ShaderType.Pixel);
            if (!this.vs || !this.ps) {
                return false;
            }
            this.advancedBlendOperations = this.app.getAdvancedBlendOperations();

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 12, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vs);

            this.cameraBuffer = this.app.createVolatileConstantBuffer(16 * 4, "CameraUbo");
            this.colorBuffer = this.app.createVolatileConstantBuffer(COLOR_FLOATS * 4, "ColorUbo");
            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutVolatileConstantBuffer(0);
            bindingLayoutDesc.layoutVolatileConstantBuffer(1);
            this.bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.All);
            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.cameraBuffer);
            setDesc.bindEntireConstantBuffer(1, this.colorBuffer);
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);

            let vertices = VERTICES.map((v): f32 => v);
            let indices = INDICES.map((v): int => v);
            const commandList = this.app.createCommandList();
            commandList.open();
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Vertices");
            this.indexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), indices.length * 4, "Indices");
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
        private blending: DynamicBlendingPass;

        constructor(blending: DynamicBlendingPass) {
            this.blending = blending;
        }

        // A color editor (as the sample's, 200 pixels wide).
        colorEdit(id: int, caption: string, colors: f32[], first: int) {
            Donut_ImGuiPushID(id);
            Donut_ImGuiColorEdit4(caption, Ref(colors[first]), 200.0);
            Donut_ImGuiPopID();
        }

        // A "Next" button, then a combo of names; returns the new index.
        comboWithButton(id: int, caption: string, index: int, names: string[]) {
            let result = index;
            Donut_ImGuiPushID(id);
            if (Donut_ImGuiButton("Next") != 0) {
                result = (result + 1) % names.length;
            }
            Donut_ImGuiPopID();
            Donut_ImGuiSameLine();
            return Donut_ImGuiCombo(caption, result, comboItems(names));
        }

        // The sample's random colors (alpha kept).
        randomize(colors: f32[]) {
            for (let corner = 0; corner < 4; corner++) {
                for (let i = 0; i < 3; i++) {
                    colors[corner * 4 + i] = Math.random();
                }
            }
        }

        buildUI() {
            const b = this.blending;
            let id = 0;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Options", 1);

            id++;
            this.colorEdit(id, "Background", b.clearColor, 0);

            // (The sample titles both headers "Second face", which ImGui then opens and closes
            // together.)
            for (let f = 0; f < 2; f++) {
                const face = b.faces[f];
                if (Donut_ImGuiCollapsingHeaderDefaultOpen(f == 0 ? "First face" : "Second face") != 0) {
                    const corners = ["Top left", "Top right", "Bottom left", "Bottom right"];
                    for (let c = 0; c < 4; c++) {
                        id++;
                        this.colorEdit(id, corners[c], face.colors, c * 4);
                    }
                    id++;
                    Donut_ImGuiPushID(id);
                    if (Donut_ImGuiButton("Random") != 0) {
                        this.randomize(face.colors);
                    }
                    Donut_ImGuiPopID();

                    Donut_ImGuiText("Color write mask");
                    const channels = ["Red", "Green", "Blue", "Alpha"];
                    for (let c = 0; c < 4; c++) {
                        id++;
                        Donut_ImGuiPushID(id);
                        face.colorBitEnabled[c] = Donut_ImGuiCheckbox(channels[c], face.colorBitEnabled[c] ? 1 : 0) != 0;
                        Donut_ImGuiPopID();
                        if (c < 3) {
                            Donut_ImGuiSameLine();
                        }
                    }
                } else {
                    id += 9;
                }
            }

            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Blending") != 0) {
                b.blendEnable = Donut_ImGuiCheckbox("Enabled", b.blendEnable ? 1 : 0) != 0;
                // Advanced blend operations: Vulkan's VK_EXT_blend_operation_advanced only.
                if ((b.advancedBlendOperations & AdvancedBlend.Available) != 0) {
                    if (Donut_ImGuiRadioButton("BlendEquationEXT", b.blendOption == BLEND_EQUATION ? 1 : 0) != 0) {
                        b.blendOption = BLEND_EQUATION;
                    }
                    if (Donut_ImGuiRadioButton("BlendAdvancedEXT", b.blendOption == BLEND_ADVANCED ? 1 : 0) != 0) {
                        b.blendOption = BLEND_ADVANCED;
                    }
                }
                if (b.blendOption == BLEND_EQUATION) {
                    if (Donut_ImGuiCollapsingHeaderDefaultOpen("BlendEquationEXT") != 0) {
                        b.colorOperator = this.comboWithButton(++id, "Color operator", b.colorOperator, BLEND_OP_NAMES);
                        b.srcColorBlendFactor = this.comboWithButton(++id, "SrcColorBlendFactor", b.srcColorBlendFactor, BLEND_FACTOR_NAMES);
                        b.dstColorBlendFactor = this.comboWithButton(++id, "DstColorBlendFactor", b.dstColorBlendFactor, BLEND_FACTOR_NAMES);
                        b.alphaOperator = this.comboWithButton(++id, "Alpha operator", b.alphaOperator, BLEND_OP_NAMES);
                        b.srcAlphaBlendFactor = this.comboWithButton(++id, "SrcAlphaBlendFactor", b.srcAlphaBlendFactor, BLEND_FACTOR_NAMES);
                        b.dstAlphaBlendFactor = this.comboWithButton(++id, "DstAlphaBlendFactor", b.dstAlphaBlendFactor, BLEND_FACTOR_NAMES);
                    }
                } else {
                    if (Donut_ImGuiCollapsingHeaderDefaultOpen("BlendAdvancedEXT") != 0) {
                        b.advancedOperator = this.comboWithButton(++id, "Operator", b.advancedOperator, ADVANCED_BLEND_OP_NAMES);
                        b.srcPremultiplied = Donut_ImGuiCheckbox("Src premultiplied", b.srcPremultiplied ? 1 : 0) != 0;
                        b.dstPremultiplied = Donut_ImGuiCheckbox("Dst premultiplied", b.dstPremultiplied ? 1 : 0) != 0;
                    }
                }
            }
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App) {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    class DynamicBlendingArgs extends Args {
        // -advanced <n>: the advanced blend operation n (0 ZERO_EXT ... 45 BLUE_EXT; Vulkan).
        advanced = -1;
        // -noblend: blending off.
        noBlend = false;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-advanced" && i + 1 < this.argc) {
                    this.advanced = parseInt(this[i + 1]);
                    i++;
                } else if (arg == "-noblend") {
                    this.noBlend = true;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("dynamic_blending");

        const args = new DynamicBlendingArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const blending = new DynamicBlendingPass(app);
        if (!blending.init()) {
            app.destroy();
            return 1;
        }
        if (args.advanced >= 0) {
            if ((blending.advancedBlendOperations & AdvancedBlend.Available) != 0 && args.advanced < ADVANCED_BLEND_OP_NAMES.length) {
                blending.blendOption = BLEND_ADVANCED;
                blending.advancedOperator = args.advanced;
            } else {
                console.log("No advanced blend operations (Vulkan's VK_EXT_blend_operation_advanced)");
            }
        }
        blending.blendEnable = !args.noBlend;

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(blending);
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
    return DynamicBlending.main(argc, argv);
}

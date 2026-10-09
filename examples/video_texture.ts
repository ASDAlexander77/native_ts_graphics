// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace VideoTexture {
    const WINDOW_TITLE = "Donut Example: Video Texture";
    const VIDEO_PATH = "media/video_texture/SampleVideo.mp4";
    const FONT_PATH = "media/fonts/OpenSans/OpenSans-Regular.ttf";
    // The sample's SegoeUI_18 sprite font.
    // ImGui sizes a font by its ascent + descent (1.3618 OpenSans ems), so the 23 pixel em that gives
    // its strings' widths is 31.5.
    const FONT_SIZE = 31.5;

    // ATG::Colors: the background (#414141), the text's light grey (#7a7a7a).
    const BACKGROUND = 0.254901975;
    const LIGHT_GREY = 0.478431374;

    // BasicEffect's constant buffer (video_texture.hlsl): DiffuseColor, EmissiveColor,
    // SpecularColor and SpecularPower, the three lights' directions, diffuse and specular colors,
    // EyePosition, World, WorldInverseTranspose, WorldViewProj.
    const PARAMETERS_FLOATS = 4 + 4 + 4 + 12 + 12 + 12 + 4 + 16 + 16 + 16;
    const PARAMETERS_WORLD = 52;
    const PARAMETERS_WORLD_INVERSE_TRANSPOSE = 68;
    const PARAMETERS_WORLD_VIEW_PROJ = 84;
    // SpriteConstants: rect, target size.
    const SPRITE_CONSTANTS_FLOATS = 8;

    // DirectXTK's EffectLights::EnableDefaultLighting.
    const DEFAULT_DIRECTIONS = [
        -0.5265408, -0.5735765, -0.6275069,
        0.7198464, 0.3420201, 0.6040227,
        0.4545195, -0.7660444, 0.4545195,
    ];
    const DEFAULT_DIFFUSE = [
        1.0000000, 0.9607844, 0.8078432,
        0.9647059, 0.7607844, 0.4078432,
        0.3231373, 0.3607844, 0.3937255,
    ];
    const DEFAULT_SPECULAR = [
        1.0000000, 0.9607844, 0.8078432,
        0.0000000, 0.0000000, 0.0000000,
        0.3231373, 0.3607844, 0.3937255,
    ];
    const DEFAULT_AMBIENT = [0.05333332, 0.09882354, 0.1819608];

    // GLFW keys.
    const KEY_SPACE = 32;
    const ACTION_PRESS = 1;

    // --- DirectXMath, row-major for mul(vector, matrix) --------------------------------------

    function multiply(a: number[], b: number[]): number[] {
        let m: number[] = [];
        for (let row = 0; row < 4; row++) {
            for (let column = 0; column < 4; column++) {
                let sum = 0.0;
                for (let k = 0; k < 4; k++) {
                    sum += a[row * 4 + k] * b[k * 4 + column];
                }
                m.push(Math.fround(sum));
            }
        }
        return m;
    }

    // XMMatrixRotationY.
    function rotationY(angle: number): number[] {
        const s = Math.fround(Math.sin(angle));
        const c = Math.fround(Math.cos(angle));
        return [c, 0.0, -s, 0.0, 0.0, 1.0, 0.0, 0.0, s, 0.0, c, 0.0, 0.0, 0.0, 0.0, 1.0];
    }

    function normalize3(v: number[]): number[] {
        const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        return [v[0] / length, v[1] / length, v[2] / length];
    }

    function cross3(a: number[], b: number[]): number[] {
        return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    }

    function dot3(a: number[], b: number[]): number {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }

    // XMMatrixLookAtRH: XMMatrixLookToLH towards the eye's opposite.
    function lookAtRH(eye: number[], focus: number[], up: number[]): number[] {
        const r2 = normalize3([eye[0] - focus[0], eye[1] - focus[1], eye[2] - focus[2]]);
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

    // XMMatrixPerspectiveFovRH.
    function perspectiveFovRH(fovY: number, aspect: number, nearZ: number, farZ: number): number[] {
        const height = Math.cos(0.5 * fovY) / Math.sin(0.5 * fovY);
        const width = height / aspect;
        const range = farZ / (nearZ - farZ);
        return [width, 0.0, 0.0, 0.0, 0.0, height, 0.0, 0.0, 0.0, 0.0, range, -1.0, 0.0, 0.0, range * nearZ, 0.0];
    }

    // --- Passes -----------------------------------------------------------------------------

    // Port of the Xbox ATG VideoTexturePC12 sample (PCSamples/Graphics/VideoTexturePC12): a video
    // played by Media Foundation's Media Engine into a texture, shown on a spinning lit cube or as
    // a sprite at its own size (Space toggles); the sample exits when the video ends.
    //
    // As the sample, the Media Engine draws on a D3D11 device of its own into a texture shared
    // with the app's device (D3D12, or D3D11 here too). NVRHI can't take a D3D11 texture into
    // Vulkan, so there the frames come through memory. The cube needs a depth buffer, which Donut's
    // back buffers don't have: the scene renders into a color + depth target copied to the frame.
    class VideoTexturePass {
        private app: App;
        private player: Opaque;
        private videoWidth: int;
        private videoHeight: int;
        // D3D12 and D3D11: shared with the Media Engine's device; Vulkan: uploaded.
        private sharedTexture: Opaque | null;
        private videoTexture: Opaque;
        private cubeVertices: Opaque;
        private cubeIndices: Opaque;
        private cubeIndexCount: int;
        private parametersBuffer: Opaque;
        private parameters: f32[];
        private spriteConstants: f32[];
        private cubeLayout: Opaque;
        private spriteLayout: Opaque;
        private cubeBindingSet: BindingSet;
        private spriteBindingSet: BindingSet;
        private cubeVS: Opaque;
        private cubePS: Opaque;
        private spriteVS: Opaque;
        private spritePS: Opaque;
        // Frame-sized, made on the first frame and after each resize.
        private colorTarget: Opaque | null;
        private depthTarget: Opaque | null;
        private framebuffer: Opaque | null;
        private cubePipeline: Opaque | null;
        private spritePipeline: Opaque | null;
        private time: number;

        show3D: boolean;
        frameWidth: int;
        frameHeight: int;
        font: ImGuiFont;

        constructor(app: App) {
            this.app = app;
            this.videoWidth = 0;
            this.videoHeight = 0;
            this.sharedTexture = null;
            this.cubeIndexCount = 0;
            this.parameters = [];
            for (let i = 0; i < PARAMETERS_FLOATS; i++) {
                this.parameters.push(0.0);
            }
            this.spriteConstants = [];
            for (let i = 0; i < SPRITE_CONSTANTS_FLOATS; i++) {
                this.spriteConstants.push(0.0);
            }
            this.cubeBindingSet = new BindingSet(null);
            this.spriteBindingSet = new BindingSet(null);
            this.colorTarget = null;
            this.depthTarget = null;
            this.framebuffer = null;
            this.cubePipeline = null;
            this.spritePipeline = null;
            this.time = 0.0;
            this.show3D = true;
            this.frameWidth = 1280;
            this.frameHeight = 720;
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (key == KEY_SPACE && action == ACTION_PRESS) {
                this.show3D = !this.show3D;
            }
            return 0;
        }

        // The sample's Update: the cube's angle from the total time; the sample exits once the
        // video has played.
        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            this.time += elapsedSeconds;
            if (Donut_IsVideoFinished(this.player) != 0) {
                Donut_CloseWindow(this.app.handle);
            }
        }

        onBackBufferResizing(): void {
            const framebuffer = this.framebuffer;
            if (framebuffer) {
                this.app.releaseResource(framebuffer);
                this.framebuffer = null;
            }
            const colorTarget = this.colorTarget;
            if (colorTarget) {
                this.app.releaseResource(colorTarget);
                this.colorTarget = null;
            }
            const depthTarget = this.depthTarget;
            if (depthTarget) {
                this.app.releaseResource(depthTarget);
                this.depthTarget = null;
            }
        }

        // BasicEffect's constants for this frame: the world matrix, the camera of the sample's
        // CreateWindowSizeDependentResources, and the material and lights (EnableDefaultLighting).
        updateParameters(): void {
            const world = rotationY(Math.fround(Math.cos(Math.fround(this.time))) * 2.0);
            const view = lookAtRH([2.0, 2.0, 2.0], [0.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
            const proj = perspectiveFovRH(Math.PI / 4.0, this.frameWidth / this.frameHeight, 0.1, 10.0);
            const worldViewProj = multiply(multiply(world, view), proj);

            // DiffuseColor (white, alpha 1), EmissiveColor (ambient * diffuse), SpecularColor and
            // SpecularPower (EffectLights::InitializeConstants' defaults).
            this.parameters[0] = 1.0;
            this.parameters[1] = 1.0;
            this.parameters[2] = 1.0;
            this.parameters[3] = 1.0;
            for (let i = 0; i < 3; i++) {
                this.parameters[4 + i] = DEFAULT_AMBIENT[i];
                this.parameters[8 + i] = 1.0;
            }
            this.parameters[11] = 16.0;
            for (let light = 0; light < 3; light++) {
                for (let i = 0; i < 3; i++) {
                    this.parameters[12 + light * 4 + i] = DEFAULT_DIRECTIONS[light * 3 + i];
                    this.parameters[24 + light * 4 + i] = DEFAULT_DIFFUSE[light * 3 + i];
                    this.parameters[36 + light * 4 + i] = DEFAULT_SPECULAR[light * 3 + i];
                }
            }
            // EyePosition: the inverse view's translation.
            this.parameters[48] = 2.0;
            this.parameters[49] = 2.0;
            this.parameters[50] = 2.0;
            for (let i = 0; i < 16; i++) {
                this.parameters[PARAMETERS_WORLD + i] = world[i];
                // The world is a rotation: its inverse transpose is itself.
                this.parameters[PARAMETERS_WORLD_INVERSE_TRANSPOSE + i] = world[i];
                this.parameters[PARAMETERS_WORLD_VIEW_PROJ + i] = worldViewProj[i];
            }
        }

        onRender(frameHandle: Opaque): void {
            const frame = new Frame(frameHandle);
            this.frameWidth = frame.getWidth();
            this.frameHeight = frame.getHeight();
            const commandList = frame.getCommandList();

            // The sample's Render starts with the video's next frame.
            const shared = this.sharedTexture;
            if (shared) {
                Donut_TransferVideoFrame(this.player, Donut_GetSharedTextureHandle(shared));
            } else if (Donut_TransferVideoFrameToMemory(this.player) != 0) {
                commandList.writeTextureLevel(this.videoTexture, 0, Donut_GetVideoFrameData(this.player),
                    Donut_GetVideoFrameRowPitch(this.player));
            }

            let colorTarget = this.colorTarget;
            let depthTarget = this.depthTarget;
            if (!colorTarget || !depthTarget) {
                colorTarget = this.app.createRenderTargetTexture(this.frameWidth, this.frameHeight, this.app.getBackBufferFormat(), "Scene");
                depthTarget = this.app.createDepthTexture(this.frameWidth, this.frameHeight, Format.D32, 1.0, "Depth");
                this.colorTarget = colorTarget;
                this.depthTarget = depthTarget;
                this.framebuffer = this.app.createFramebuffer(colorTarget, depthTarget);
            }
            if (!this.cubePipeline) {
                const cubeDesc = GraphicsPipelineDesc.create(this.cubeVS, this.cubePS);
                cubeDesc.addBindingLayout(this.cubeLayout);
                cubeDesc.setDepthState(1, 1, ComparisonFunc.Less);
                cubeDesc.setRasterState(CullMode.None, FillMode.Solid, 0);
                this.cubePipeline = this.app.createGraphicsPipelineFromDesc(cubeDesc, this.framebuffer as Opaque);

                const spriteDesc = GraphicsPipelineDesc.create(this.spriteVS, this.spritePS);
                spriteDesc.addBindingLayout(this.spriteLayout);
                spriteDesc.setDepthState(0, 0, ComparisonFunc.Always);
                spriteDesc.setRasterState(CullMode.None, FillMode.Solid, 0);
                this.spritePipeline = this.app.createGraphicsPipelineFromDesc(spriteDesc, this.framebuffer as Opaque);
            }

            // Clear
            commandList.clearTextureFloat(colorTarget, BACKGROUND, BACKGROUND, BACKGROUND, 1.0);
            commandList.clearDepth(depthTarget, 1.0);

            if (this.show3D) {
                this.updateParameters();
                commandList.writeBuffer(this.parametersBuffer, Ref(this.parameters[0]), PARAMETERS_FLOATS * 4);
                frame.beginDrawToFramebuffer(this.cubePipeline as Opaque, this.framebuffer as Opaque);
                frame.drawAddBindingSet(this.cubeBindingSet);
                frame.drawSetIndexBuffer(this.cubeIndices);
                frame.drawIndexed(this.cubeIndexCount);
            } else {
                // At the title safe area's top-left corner, at the video's size.
                const left = Math.floor((this.frameWidth + 19.0) / 20.0);
                const top = Math.floor((this.frameHeight + 19.0) / 20.0);
                this.spriteConstants[0] = left;
                this.spriteConstants[1] = top;
                this.spriteConstants[2] = left + this.videoWidth;
                this.spriteConstants[3] = top + this.videoHeight;
                this.spriteConstants[4] = this.frameWidth;
                this.spriteConstants[5] = this.frameHeight;
                frame.beginDrawToFramebuffer(this.spritePipeline as Opaque, this.framebuffer as Opaque);
                frame.drawAddBindingSet(this.spriteBindingSet);
                frame.drawVerticesWithPushConstants(6, Ref(this.spriteConstants[0]), SPRITE_CONSTANTS_FLOATS * 4);
            }

            frame.copyTextureToFrame(colorTarget);
        }

        // GeometricPrimitive::CreateCube(1): DirectXTK's ComputeBox, each face's four vertices
        // (position, normal, texture coordinate) and two triangles.
        createCube(commandList: CommandList): void {
            const faceNormals = [0, 0, 1, 0, 0, -1, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0];
            const textureCoordinates = [1, 0, 1, 1, 0, 1, 0, 0];
            let vertices: f32[] = [];
            let indices: int[] = [];
            for (let face = 0; face < 6; face++) {
                const normal = [faceNormals[face * 3], faceNormals[face * 3 + 1], faceNormals[face * 3 + 2]];
                // Get two vectors perpendicular both to the face normal and to each other.
                const basis = face >= 4 ? [0.0, 0.0, 1.0] : [0.0, 1.0, 0.0];
                const side1 = cross3(normal, basis);
                const side2 = cross3(normal, side1);

                const vbase = face * 4;
                indices.push(vbase);
                indices.push(vbase + 1);
                indices.push(vbase + 2);
                indices.push(vbase);
                indices.push(vbase + 2);
                indices.push(vbase + 3);

                // (normal -+ side1 -+ side2) * size / 2
                const signs1 = [-1.0, -1.0, 1.0, 1.0];
                const signs2 = [-1.0, 1.0, 1.0, -1.0];
                for (let v = 0; v < 4; v++) {
                    for (let i = 0; i < 3; i++) {
                        vertices.push((normal[i] + signs1[v] * side1[i] + signs2[v] * side2[i]) * 0.5);
                    }
                    for (let i = 0; i < 3; i++) {
                        vertices.push(normal[i]);
                    }
                    vertices.push(textureCoordinates[v * 2]);
                    vertices.push(textureCoordinates[v * 2 + 1]);
                }
            }
            this.cubeVertices = this.app.createStaticRawVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Cube Vertices");
            this.cubeIndices = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), indices.length * 4, "Cube Indices");
            this.cubeIndexCount = indices.length;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(muted: boolean): boolean {
            // The sample's MediaEnginePlayer on the app's GPU.
            let luid: int[] = [0, 0];
            this.app.getAdapterLuid(Ref(luid[0]));
            const player = Donut_CreateVideoPlayer(VIDEO_PATH, luid[0], luid[1], muted ? 1 : 0);
            if (!player) {
                console.log("Cannot play the sample's video: set XBOX_ATG_SAMPLES_DIR when configuring");
                return false;
            }
            this.player = player as Opaque;
            this.videoWidth = Donut_GetVideoWidth(this.player);
            this.videoHeight = Donut_GetVideoHeight(this.player);
            console.log(`Video Size ${this.videoWidth} x ${this.videoHeight}`);

            // B8G8R8A8_UNORM, the Media Engine's output format.
            const shared = this.app.createSharedTexture(this.videoWidth, this.videoHeight, Format.BGRA8_UNORM, "Video");
            if (shared) {
                this.sharedTexture = shared;
                this.videoTexture = Donut_GetSharedTexture(shared as Opaque);
            } else {
                this.videoTexture = this.app.createTextureWithLevels(this.videoWidth, this.videoHeight, 1, Format.BGRA8_UNORM, "Video");
            }

            this.cubeVS = this.app.createShader("video_texture.hlsl", "cube_vs", ShaderType.Vertex);
            this.cubePS = this.app.createShader("video_texture.hlsl", "cube_ps", ShaderType.Pixel);
            this.spriteVS = this.app.createShader("video_texture.hlsl", "sprite_vs", ShaderType.Vertex);
            this.spritePS = this.app.createShader("video_texture.hlsl", "sprite_ps", ShaderType.Pixel);
            if (!this.cubeVS || !this.cubePS || !this.spriteVS || !this.spritePS) {
                return false;
            }

            const commandList = this.app.createCommandList();
            commandList.open();
            this.createCube(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);

            this.parametersBuffer = this.app.createVolatileConstantBuffer(PARAMETERS_FLOATS * 4, "BasicEffect Parameters");
            // CommonStates::AnisotropicWrap (16 samples); SpriteBatch's CommonStates::LinearClamp.
            const anisotropicWrap = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Wrap, 0.0, 0.0, 1000.0,
                Math.min(16.0, this.app.getMaxSamplerAnisotropy()));
            const linearClamp = this.app.getCommonSampler(CommonSampler.LinearClamp);

            const cubeLayoutDesc = BindingLayoutDesc.create();
            cubeLayoutDesc.layoutVolatileConstantBuffer(0);
            cubeLayoutDesc.layoutRawBufferSRV(0);
            cubeLayoutDesc.layoutTextureSRV(1);
            cubeLayoutDesc.layoutSampler(0);
            this.cubeLayout = this.app.createBindingLayout(cubeLayoutDesc, ShaderType.All);
            const cubeDesc = BindingSetDesc.create();
            cubeDesc.bindEntireConstantBuffer(0, this.parametersBuffer);
            cubeDesc.bindRawBufferSRV(0, this.cubeVertices);
            cubeDesc.bindTextureSRV(1, this.videoTexture);
            cubeDesc.bindSampler(0, anisotropicWrap);
            this.cubeBindingSet = this.app.createBindingSetForLayout(cubeDesc, this.cubeLayout);

            const spriteLayoutDesc = BindingLayoutDesc.create();
            spriteLayoutDesc.layoutPushConstants(1, SPRITE_CONSTANTS_FLOATS * 4);
            spriteLayoutDesc.layoutTextureSRV(1);
            spriteLayoutDesc.layoutSampler(0);
            this.spriteLayout = this.app.createBindingLayout(spriteLayoutDesc, ShaderType.All);
            const spriteDesc = BindingSetDesc.create();
            spriteDesc.bindPushConstants(1, SPRITE_CONSTANTS_FLOATS * 4);
            spriteDesc.bindTextureSRV(1, this.videoTexture);
            spriteDesc.bindSampler(0, linearClamp);
            this.spriteBindingSet = this.app.createBindingSetForLayout(spriteDesc, this.spriteLayout);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        destroy(): void {
            Donut_DestroyVideoPlayer(this.player);
        }
    }

    // The sample's controller string (the gamepad's [View] and [A] are buttons there).
    class UserInterface {
        private sample: VideoTexturePass;

        constructor(sample: VideoTexturePass) {
            this.sample = sample;
        }

        buildUI(): void {
            const sample = this.sample;
            const left = Math.floor((sample.frameWidth + 19.0) / 20.0);
            const safeH = (sample.frameHeight + 19.0) / 20.0;
            const bottom = Math.floor(sample.frameHeight - safeH + 0.5);
            sample.font.push();
            Donut_ImGuiDrawText(left, bottom - FONT_SIZE, "Esc  Exit   Space  Toggle texture vs. cutscene",
                LIGHT_GREY, LIGHT_GREY, LIGHT_GREY, 1.0, 0);
            Donut_ImGuiPopFont();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            const imguiPass = app.addImGuiPass(this.buildUI);
            if (imguiPass.isNull()) {
                return false;
            }
            this.sample.font = imguiPass.createFont(FONT_PATH, FONT_SIZE);
            return !this.sample.font.isNull();
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("video_texture");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -mute: without the video's sound. -sprite: start with the video as a sprite.
        // The back buffers are UNORM, as the sample's (B8G8R8A8_UNORM).
        let options = AppOptions.UnormBackBuffer;
        let muted = false;
        let sprite = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-mute") {
                muted = true;
            } else if (arg == "-sprite") {
                sprite = true;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new VideoTexturePass(app);
        if (!sample.init(muted)) {
            app.destroy();
            return 1;
        }
        sample.show3D = !sprite;
        const ui = new UserInterface(sample);
        if (!ui.init(app)) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        app.waitForIdle();
        sample.destroy();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return VideoTexture.main(argc, argv);
}

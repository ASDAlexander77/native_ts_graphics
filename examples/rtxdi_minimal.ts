// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, isFinite32, unsupported } from "../core/test_check";
import { perspProjD3DStyleReverse } from "../core/matrix";
import { formatFixed } from "../core/text_format";
import { PrepareLightsPass, RenderPass, RtxdiDI, RtxdiMinimalSettings, RtxdiRenderTargets } from "../core/rtxdi_di";

// Port of NVIDIA's RTXDI Minimal Sample (github.com/NVIDIA-RTX/RTXDI, Samples/MinimalSample, RTXDI 3.0.0): the
// Arcade lit by its emissive triangles, ReSTIR DI fused into one compute pass (primary rays, initial sampling,
// spatio-temporal resampling, shading). The sample, its RTXDI library and its shaders are under the NVIDIA RTX
// SDKs License, so they are used in place from an RTXDI checkout (RTXDI_DIR), nothing of them copied.
//
// Command line, besides the examples' (core/args.ts): -width / -height (1920 x 1080); the UI's settings
// -noResampling, -unbiased, -initialSamples n (1..32), -spatialSamples n (0..4), -brdfSamples n (0..8),
// -brdfCutoff x (0..1), clamped to the UI's ranges; -camera px py pz tx ty tz (the starting LookAt), -moveCamera
// dx dy dz (frame k's camera at the start plus k times d, k the frames rendered before it: no time-based
// movement); -dumpFrame N [-dumpPath file]: after frame index N, its HDR color (before the blit) as a float file
// (int32 width, height, then RGBA float32 pixels top row first) and exit; -frames n: the frames of -test.
namespace RtxdiMinimal {
    // Test mode: the frames rendered (more for -dumpFrame or -frames), enough for the temporal resampling to
    // run over several frames.
    const TEST_FRAMES = 4;

    const WINDOW_TITLE = "Hello RTXDI";
    // The sample's scene, from RTXDI_DIR/Assets (CMakeLists.txt links it next to bin/).
    const SCENE_PATH = "../Assets/Media/Arcade/Arcade.gltf";
    // The UI's font, as the sample's UserInterface.
    const FONT_PATH = "media/fonts/OpenSans/OpenSans-Regular.ttf";
    const FONT_SIZE = 17.0;
    const SETTINGS_TITLE = "Settings (Tilde key to hide)";

    // The sample's camera (SceneLoaded): its LookAt and move speed.
    const CAMERA_POSITION_X = -1.658;
    const CAMERA_POSITION_Y = 1.577;
    const CAMERA_POSITION_Z = 1.69;
    const CAMERA_TARGET_X = -0.9645;
    const CAMERA_TARGET_Y = 1.2672;
    const CAMERA_TARGET_Z = 1.0396;
    const CAMERA_MOVE_SPEED = 3.0;
    // SetupView's perspProjD3DStyleReverse(radians(60.f), aspect, 0.01f); Donut's radians(float) is
    // deg * (PI_f / 180.f) in float, PI_f = 3.141592654f.
    const FIELD_OF_VIEW = Math.fround(60.0 * Math.fround(Math.fround(3.141592654) / 180.0));
    const Z_NEAR = 0.01;

    // sizeof(RAB_LightInfo) in the sample's ShaderParameters.h, and its words: float3 center, uint scalars, uint2
    // radiance (four halves, alpha 0), two oct-encoded directions.
    const LIGHT_INFO_SIZE = 32;
    const LIGHT_INFO_WORDS = 8;
    const LIGHT_CENTER = 0;
    const LIGHT_RADIANCE = 4;

    // value within min..max (if-chains: tslang's Math.max / min are wrong for negative numbers).
    function clampInt(value: int, min: int, max: int): int {
        if (value < min) {
            return min;
        }
        if (value > max) {
            return max;
        }
        return value;
    }

    function clampNumber(value: number, min: number, max: number): number {
        if (!(value >= min)) {
            return min;
        }
        if (value > max) {
            return max;
        }
        return value;
    }

    // text with zeros in front up to width characters (printf's %05.2f of a number that isn't negative).
    function zeroPadded(text: string, width: int): string {
        let padded = text;
        while (padded.length < width) {
            padded = "0" + padded;
        }
        return padded;
    }

    class RtxdiMinimalArgs extends Args {
        // -width, -height: the window's (the render size), the sample's 1920 x 1080 by default.
        width: int = 1920;
        height: int = 1080;
        // The UI's settings; -1 where not given (the sample's defaults).
        noResampling: boolean = false;
        unbiased: boolean = false;
        initialSamples: int = -1;
        spatialSamples: int = -1;
        brdfSamples: int = -1;
        brdfCutoff: number = -1.0;
        // -camera: the camera's start (position, target) instead of the sample's; -moveCamera: its step a frame.
        hasCamera: boolean = false;
        camera: number[] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        hasMove: boolean = false;
        move: number[] = [0.0, 0.0, 0.0];
        // -dumpFrame: the frame index whose HDR color is saved to dumpPath (-1: none).
        dumpFrame: int = -1;
        dumpPath: string = "rtxdi_minimal_hdr.bin";

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-width" && i + 1 < this.argc) {
                    this.width = parseInt(this[i + 1]);
                } else if (arg == "-height" && i + 1 < this.argc) {
                    this.height = parseInt(this[i + 1]);
                } else if (arg == "-noResampling") {
                    this.noResampling = true;
                } else if (arg == "-unbiased") {
                    this.unbiased = true;
                } else if (arg == "-initialSamples" && i + 1 < this.argc) {
                    this.initialSamples = clampInt(parseInt(this[i + 1]), 1, 32);
                } else if (arg == "-spatialSamples" && i + 1 < this.argc) {
                    this.spatialSamples = clampInt(parseInt(this[i + 1]), 0, 4);
                } else if (arg == "-brdfSamples" && i + 1 < this.argc) {
                    this.brdfSamples = clampInt(parseInt(this[i + 1]), 0, 8);
                } else if (arg == "-brdfCutoff" && i + 1 < this.argc) {
                    this.brdfCutoff = clampNumber(parseFloat(this[i + 1]), 0.0, 1.0);
                } else if (arg == "-camera" && i + 6 < this.argc) {
                    this.hasCamera = true;
                    for (let k = 0; k < 6; k++) {
                        this.camera[k] = Math.fround(parseFloat(this[i + 1 + k]));
                    }
                } else if (arg == "-moveCamera" && i + 3 < this.argc) {
                    this.hasMove = true;
                    for (let k = 0; k < 3; k++) {
                        this.move[k] = Math.fround(parseFloat(this[i + 1 + k]));
                    }
                } else if (arg == "-dumpFrame" && i + 1 < this.argc) {
                    this.dumpFrame = parseInt(this[i + 1]);
                } else if (arg == "-dumpPath" && i + 1 < this.argc) {
                    this.dumpPath = this[i + 1];
                }
            }
        }

        // The settings the UI starts with: the sample's, changed by the options given.
        applyTo(s: RtxdiMinimalSettings): void {
            if (this.noResampling) {
                s.enableResampling = false;
            }
            if (this.unbiased) {
                s.unbiasedMode = true;
            }
            if (this.initialSamples >= 0) {
                s.numLocalLightSamples = this.initialSamples;
            }
            if (this.spatialSamples >= 0) {
                s.numSpatialSamples = this.spatialSamples;
            }
            if (this.brdfSamples >= 0) {
                s.numBrdfSamples = this.brdfSamples;
            }
            if (this.brdfCutoff >= 0.0) {
                s.brdfCutoff = this.brdfCutoff;
            }
        }
    }

    // The sample's SceneRenderer: the scene loaded with the bindless layout its shaders read through, its
    // acceleration structures, the camera and views, and, made on the first frame and again after a resize, the
    // ReSTIR DI context and resources, the render targets and the binding sets. A frame refreshes the scene,
    // prepares the lights, runs the Render pass and blits its HDR color to the back buffer; then the G-buffers,
    // the Render binding sets and the views go a frame on. The sample's UserInterface is its buildUI.
    class SceneRenderer {
        private bindlessLayout: BindingLayoutHandle;
        private scene: Scene;
        private accelStructs: RtxdiSceneAccelStructsHandle | null = null;
        private prepareLightsPass: PrepareLightsPass | null = null;
        private renderPass: RenderPass | null = null;
        private camera: Camera;
        private view: View;
        private prevView: View;
        // prevView is seeded from view on the first frame rendered (not again after a resize, as the sample's).
        private prevViewValid: boolean = false;
        private viewMatrix: f32[] = [];
        private projMatrix: f32[] = [];
        // The camera's start (the sample's LookAt or -camera's).
        private start: number[] = [CAMERA_POSITION_X, CAMERA_POSITION_Y, CAMERA_POSITION_Z,
            CAMERA_TARGET_X, CAMERA_TARGET_Y, CAMERA_TARGET_Z];
        // The ReSTIR DI context and resources couldn't be made: the window closes.
        private failed: boolean = false;
        private resized: boolean = false;
        private imguiPass: ImGuiPass;
        private font: ImGuiFont;
        private showUI: boolean = true;

        settings: RtxdiMinimalSettings = new RtxdiMinimalSettings();
        // Made on the first frame, dropped on resize.
        di: RtxdiDI | null = null;
        targets: RtxdiRenderTargets | null = null;

        // What -test checks: the app's frame index on the first frame rendered (0, as the sample's first
        // frame after a synchronous load), and the light count of the last frame.
        firstFrameIndex: int = -1;
        lightCount: int = 0;
        // The frames rendered (-moveCamera's k), and whether -dumpFrame's frame was rendered (main saves it).
        renderedFrames: int = 0;
        dumpRendered: boolean = false;

        constructor(private app: App, private args: RtxdiMinimalArgs) {
        }

        init(): boolean {
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
                this.projMatrix.push(0.0);
            }
            this.args.applyTo(this.settings);
            const s = this.settings;
            console.log(`Settings: resampling ${s.enableResampling}, unbiased ${s.unbiasedMode}, initial samples ${s.numLocalLightSamples}, spatial samples ${s.numSpatialSamples}, BRDF samples ${s.numBrdfSamples}, BRDF cutoff ${s.brdfCutoff}`);

            // The sample's bindless layout: its scene's vertex and index buffers (t0, space1), textures (t0,
            // space2) and writable textures (u0, space3), for every stage.
            const bindlessLayoutDesc = BindlessLayoutDesc.create(0, 1024, ShaderType.All);
            bindlessLayoutDesc.addRawBuffers(1);
            bindlessLayoutDesc.addTextures(2);
            bindlessLayoutDesc.addTextureUAVs(3);
            this.bindlessLayout = this.app.createBindlessLayout(bindlessLayoutDesc);
            const descriptorTableManager = this.app.createDescriptorTableManager(this.bindlessLayout);

            // Loaded before the first frame: the sample with its synchronous loading renders its first frame at
            // frame index 0, which RTXDI's random sequences start from; the frames match it from there.
            const scene = this.app.loadSceneWithDescriptorTable(SCENE_PATH, descriptorTableManager);
            if (scene.isNull()) {
                console.log(`Cannot load the scene ${SCENE_PATH} (configure with RTXDI_DIR, which links its Assets)`);
                return false;
            }
            this.scene = scene;

            const descriptorTable = descriptorTableManager.getDescriptorTable();
            const prepareLightsPass = new PrepareLightsPass(this.app, this.bindlessLayout, scene, descriptorTable);
            this.prepareLightsPass = prepareLightsPass;
            const renderPass = new RenderPass(this.app, this.bindlessLayout, scene, descriptorTable);
            this.renderPass = renderPass;
            if (!prepareLightsPass.createPipeline() || !renderPass.createPipeline()) {
                return false;
            }

            const commandList = this.app.createCommandList();
            commandList.open();
            this.accelStructs = Rtxdi_BuildSceneAccelStructs(this.app.handle, commandList.handle, scene.handle);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!this.accelStructs) {
                return false;
            }

            // SceneLoaded's camera.
            if (this.args.hasCamera) {
                for (let k = 0; k < 6; k++) {
                    this.start[k] = this.args.camera[k];
                }
            }
            this.camera = this.app.createFirstPersonCamera();
            this.camera.lookAt(this.start[0], this.start[1], this.start[2], this.start[3], this.start[4], this.start[5]);
            this.camera.setMoveSpeed(CAMERA_MOVE_SPEED);
            this.view = this.app.createPlanarView();
            this.prevView = this.app.createPlanarView();

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);

            // The UI after it: drawn on top, sees the input first.
            if (!this.args.noUI) {
                this.imguiPass = this.app.addImGuiPass(this.buildUI);
                if (this.imguiPass.isNull()) {
                    return false;
                }
                this.font = this.imguiPass.createFont(FONT_PATH, FONT_SIZE);
            }
            return true;
        }

        // Tilde shows or hides the UI; the camera gets the rest.
        onKey(key: Key, scancode: ScanCode, action: Action, mods: KeyMods): int {
            if (key == Key.GraveAccent && action == Action.Press) {
                this.showUI = !this.showUI;
                return 1;
            }
            this.camera.keyboardUpdate(key, scancode, action, mods);
            return 1;
        }

        onMousePos(x: number, y: number): int {
            this.camera.mousePosUpdate(x, y);
            return 1;
        }

        onMouseButton(button: MouseButton, action: Action, mods: KeyMods): int {
            this.camera.mouseButtonUpdate(button, action, mods);
            return 1;
        }

        // Before the frame's render: -resizeAt's resize (outside the render callbacks, which App.resizeBackBuffers
        // needs), and the camera's movement unless -camera or -moveCamera script it (the reference's Animate).
        onAnimate(elapsedSeconds: number) {
            if (this.args.resizeAt >= 0 && !this.resized && this.app.getFrameIndex() >= this.args.resizeAt) {
                this.resized = true;
                // Three quarters of the size: another aspect ratio than a multiple of the group size would give.
                const width: int = Math.floor(this.app.getWindowWidth() * 3 / 4);
                const height: int = Math.floor(this.app.getWindowHeight() * 3 / 4);
                console.log(`Resizing to ${width} x ${height} before frame index ${this.app.getFrameIndex()}`);
                this.app.resizeBackBuffers(width, height);
            }
            if (!this.args.hasCamera && !this.args.hasMove) {
                this.camera.animate(elapsedSeconds);
            }
        }

        // BackBufferResized: the context, the resources, the render targets and the binding sets are made again
        // for the new size, and the blit's cached binding sets (over the old HDR color) dropped.
        onBackBufferResizing() {
            const renderPass = this.renderPass;
            if (renderPass) {
                renderPass.releaseBindingSets();
            }
            const prepareLightsPass = this.prepareLightsPass;
            if (prepareLightsPass) {
                prepareLightsPass.releaseBindingSet();
            }
            const di = this.di;
            if (di) {
                di.dispose();
                this.di = null;
            }
            const targets = this.targets;
            if (targets) {
                targets.release(this.app);
                this.targets = null;
            }
            this.app.clearBindingCache();
        }

        // SetupView: the camera's view, a reversed-depth 60 degree projection over the back buffer, no jitter.
        private setupView(width: int, height: int) {
            this.camera.getWorldToView(Ref(this.viewMatrix[0]));
            const aspect = Math.fround(Math.fround(width) / Math.fround(height));
            const projection = perspProjD3DStyleReverse(FIELD_OF_VIEW, aspect, Z_NEAR);
            for (let i = 0; i < 16; i++) {
                this.projMatrix[i] = projection[i];
            }
            this.view.setPlanarView(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);
            if (!this.prevViewValid) {
                this.prevView.copyPlanarView(this.view);
                this.prevViewValid = true;
            }
        }

        onRender(frameHandle: FrameHandle) {
            if (this.failed) {
                return;
            }
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const frameIndex = this.app.getFrameIndex();
            if (this.firstFrameIndex < 0) {
                this.firstFrameIndex = frameIndex;
                console.log(`First rendered frame index ${frameIndex}, ${width} x ${height}`);
            }

            // -moveCamera: the start moved by k steps (float math as the reference's float3).
            if (this.args.hasMove) {
                const k = Math.fround(this.renderedFrames);
                const s = this.start;
                const d = this.args.move;
                const dx = Math.fround(d[0] * k);
                const dy = Math.fround(d[1] * k);
                const dz = Math.fround(d[2] * k);
                this.camera.lookAt(Math.fround(s[0] + dx), Math.fround(s[1] + dy), Math.fround(s[2] + dz),
                    Math.fround(s[3] + dx), Math.fround(s[4] + dy), Math.fround(s[5] + dz));
            }

            this.setupView(width, height);

            // SetupRenderPasses.
            const prepareLightsPass = this.prepareLightsPass as PrepareLightsPass;
            const renderPass = this.renderPass as RenderPass;
            let created = false;
            let di = this.di;
            if (!di) {
                di = new RtxdiDI(this.app, this.scene, width, height);
                if (di.isNull()) {
                    // Logged by the glue; not tried again every frame.
                    di.dispose();
                    this.failed = true;
                    this.app.closeWindow();
                    return;
                }
                prepareLightsPass.createBindingSet(di);
                this.di = di;
                created = true;
            }
            let targets = this.targets;
            if (!targets) {
                targets = new RtxdiRenderTargets(this.app, width, height);
                this.targets = targets;
                created = true;
            }
            if (created) {
                renderPass.createBindingSets(Rtxdi_GetTopLevelAS(this.accelStructs as RtxdiSceneAccelStructsHandle),
                    targets, di);
            }

            const commandList = frame.getCommandList();
            this.app.refreshScene(frame, this.scene);
            di.initializeNeighborOffsets(commandList);
            di.setFrameIndex(frameIndex);
            // The lights are static, but prepared every frame, as the sample does.
            this.lightCount = prepareLightsPass.dispatch(commandList, di);
            renderPass.render(commandList, di, this.view.handle, this.prevView.handle, this.settings, width, height);

            // -dumpFrame: this frame is the last; main saves its HDR color once the app has submitted it (nothing
            // writes the HDR color after the Render pass).
            if (frameIndex == this.args.dumpFrame) {
                this.dumpRendered = true;
                this.app.closeWindow();
            }

            this.app.blitTexture(frame, targets.hdrColor);
            this.renderedFrames++;

            // NextFrame: the frame's command list is submitted after this callback; what follows only changes
            // what the next frame binds.
            renderPass.nextFrame();
            targets.swap();
            this.prevView.copyPlanarView(this.view);
        }

        // UserInterface::buildUI.
        buildUI() {
            if (!this.showUI) {
                return;
            }
            const width = this.app.getWindowWidth();
            const height = this.app.getWindowHeight();
            const s = this.settings;
            this.font.push();
            ImGui.setNextWindowPos(10.0, 10.0);
            ImGui.setNextWindowSizeConstraints(375.0, 0.0, width - 20.0, height - 20.0);
            ImGui.begin(SETTINGS_TITLE, true);
            ImGui.pushItemWidth(100.0);
            s.enableResampling = ImGui.checkbox("Enable Resampling", s.enableResampling);
            s.unbiasedMode = ImGui.checkbox("Unbiased Mode", s.unbiasedMode);
            s.numLocalLightSamples = ImGui.sliderInt("Initial Samples", s.numLocalLightSamples, 1, 32);
            s.numSpatialSamples = ImGui.sliderInt("Spatial Samples", s.numSpatialSamples, 0, 4);
            s.numBrdfSamples = ImGui.sliderInt("Initial BRDF Samples", s.numBrdfSamples, 0, 8);
            s.brdfCutoff = ImGui.sliderFloat("BRDF Cutoff", s.brdfCutoff, 0.0, 1.0);
            ImGui.separator();
            // "%05.2f ms/frame (%05.1f FPS)".
            const frameTime = this.app.getAverageFrameTime();
            const fps = frameTime > 0.0 ? 1.0 / frameTime : 0.0;
            ImGui.text(`${zeroPadded(formatFixed(frameTime * 1000.0, 2), 5)} ms/frame (${zeroPadded(formatFixed(fps, 1), 5)} FPS)`);
            ImGui.popItemWidth();
            ImGui.end();
            ImGui.popFont();
        }

        // Before the app: frees what the app doesn't own (after App.waitForIdle: the acceleration structures don't
        // track liveness).
        dispose(): void {
            this.onBackBufferResizing();
            const accelStructs = this.accelStructs;
            if (accelStructs) {
                Rtxdi_DestroySceneAccelStructs(accelStructs);
                this.accelStructs = null;
            }
        }
    }

    // A GPU buffer's first byteSize bytes, as ints (TestCheck.readFloats' readback); empty if they can't be read.
    function readInts(app: App, buffer: BufferHandle, byteSize: int): int[] {
        const readback = app.createReadbackBuffer(byteSize, "Test readback");
        const commandList = app.createCommandList();
        commandList.open();
        commandList.copyBuffer(readback, 0, buffer, 0, byteSize);
        commandList.close();
        app.executeCommandList(commandList);
        app.waitForIdle();
        app.releaseResource(commandList.handle);
        const values: int[] = [];
        for (let i = 0; i < byteSize / 4; i++) {
            values.push(0);
        }
        const read = app.readBuffer(readback, Ref(values[0]), byteSize);
        app.releaseResource(readback);
        if (!read) {
            return [];
        }
        return values;
    }

    // A half's bits (IEEE 754 binary16) are a finite value that isn't negative.
    function isFiniteNonNegativeHalf(bits: int): boolean {
        return (bits & 0x8000) == 0 && (bits & 0x7C00) != 0x7C00;
    }

    // -test: the first frame was frame index 0 (as the sample's), and PrepareLights wrote every light: its center
    // finite, its radiance finite and not negative. Some lights' radiance is not zero, but not every one's: the
    // Arcade's one emissive material (the cabinets') is masked by its emissive texture, which PrepareLights samples
    // at each triangle's center, and most of the cabinets' triangles are dark there.
    function checkLights(app: App, renderer: SceneRenderer): string {
        if (renderer.firstFrameIndex != 0) {
            return `the first frame rendered was frame index ${renderer.firstFrameIndex}, not 0`;
        }
        const di = renderer.di;
        if (!di) {
            return "no RTXDI resources";
        }
        const count = renderer.lightCount;
        if (count <= 0) {
            return "PrepareLights found no lights";
        }
        const check = new TestCheck(app);
        const lightData = di.buffer(RtxdiBuffer.LightData);
        const floats = check.readFloats(lightData, count * LIGHT_INFO_SIZE);
        const ints = readInts(app, lightData, count * LIGHT_INFO_SIZE);
        if (floats.length == 0 || ints.length == 0) {
            return "cannot read the light data buffer";
        }
        let lit = 0;
        for (let i = 0; i < count; i++) {
            const base = i * LIGHT_INFO_WORDS;
            const x = floats[base + LIGHT_CENTER];
            const y = floats[base + LIGHT_CENTER + 1];
            const z = floats[base + LIGHT_CENTER + 2];
            if (!isFinite32(x) || !isFinite32(y) || !isFinite32(z)) {
                return `light ${i} of ${count}: center ${x}, ${y}, ${z} is not finite`;
            }
            // Red and green, then blue and alpha (0).
            const redGreen = ints[base + LIGHT_RADIANCE];
            const blueAlpha = ints[base + LIGHT_RADIANCE + 1];
            if (!isFiniteNonNegativeHalf(redGreen & 0xFFFF) || !isFiniteNonNegativeHalf((redGreen >> 16) & 0xFFFF)
                || !isFiniteNonNegativeHalf(blueAlpha & 0xFFFF) || (blueAlpha >> 16) != 0) {
                return `light ${i} of ${count}: radiance bits ${redGreen}, ${blueAlpha} are not a finite color that isn't negative (alpha 0)`;
            }
            if (redGreen != 0 || blueAlpha != 0) {
                lit++;
            }
        }
        console.log(`Lights: ${count}, ${lit} with radiance`);
        if (lit == 0) {
            return `none of the ${count} lights has radiance`;
        }
        return "";
    }

    // A finite half's (IEEE 754 binary16) value, scales as checkFrame makes them.
    function halfToFloat(bits: int, scales: number[]): number {
        const exponent = (bits >> 10) & 0x1F;
        const mantissa = bits & 0x3FF;
        const magnitude = exponent == 0 ? mantissa * scales[0] : (mantissa + 1024) * scales[exponent];
        return (bits & 0x8000) != 0 ? -magnitude : magnitude;
    }

    // -test, the frame: the back buffer read, its lower half lit (the blitted HDR color), and the HDR color the
    // Render pass wrote (before the blit) without NaN or infinity, its mean luminance within (0.01, 100).
    function checkFrame(app: App, renderer: SceneRenderer): string {
        const check = new TestCheck(app);
        const read = check.frameRead();
        if (read != "") {
            return read;
        }
        // The blit: the frame's lower half (no UI there) lit. Not its center pixel, which the brief asked for: at
        // the sample's camera it is a dark spot of the floor (1.6e-5 in the reference's HDR dump), black in 8 bits.
        const halfHeight: int = Math.floor(check.height / 2);
        const lit = check.share(check.countOtherThan(0, 0, halfHeight, check.width, check.height - halfHeight),
            check.width * (check.height - halfHeight), 5.0, 100.0, "Lower half not black");
        if (lit != "") {
            return lit;
        }
        const center = check.rgb(Math.floor(check.width / 2), halfHeight);
        const targets = renderer.targets;
        if (!targets) {
            return "no render targets";
        }
        const width = targets.width;
        const height = targets.height;
        // RGBA16_FLOAT: two halves an int.
        const halves: int[] = [];
        for (let i = 0; i < width * height * 2; i++) {
            halves.push(0);
        }
        if (app.readTextureLevel(targets.hdrColor, 0, Ref(halves[0]), halves.length * 4) != halves.length * 4) {
            return "cannot read the HDR color back";
        }
        // At e: 2^(e - 25), a mantissa unit of exponent e (1..30); at 0, the subnormals' 2^-24.
        const scales: number[] = [1.0 / 16777216.0];
        let scale = 1.0 / 16777216.0;
        for (let e = 1; e < 31; e++) {
            scales.push(scale);
            scale *= 2.0;
        }
        let nonFinite = 0;
        let sum = 0.0;
        for (let p = 0; p < width * height; p++) {
            const redGreen = halves[p * 2];
            const blueAlpha = halves[p * 2 + 1];
            const r = redGreen & 0xFFFF;
            const g = (redGreen >> 16) & 0xFFFF;
            const b = blueAlpha & 0xFFFF;
            const a = (blueAlpha >> 16) & 0xFFFF;
            if ((r & 0x7C00) == 0x7C00 || (g & 0x7C00) == 0x7C00 || (b & 0x7C00) == 0x7C00 || (a & 0x7C00) == 0x7C00) {
                nonFinite++;
                continue;
            }
            sum += 0.2126 * halfToFloat(r, scales) + 0.7152 * halfToFloat(g, scales) + 0.0722 * halfToFloat(b, scales);
        }
        const mean = sum / (width * height);
        console.log(`HDR color ${width} x ${height}: mean luminance ${mean}, ${nonFinite} pixels not finite, center ${center & 0xFF}, ${(center >> 8) & 0xFF}, ${(center >> 16) & 0xFF}`);
        if (nonFinite > 0) {
            return `${nonFinite} pixels of the HDR color are NaN or infinite`;
        }
        if (!(mean > 0.01 && mean < 100.0)) {
            return `the HDR color's mean luminance ${mean} is not within (0.01, 100)`;
        }
        return "";
    }

    // -test's frames: TEST_FRAMES, -frames' if given, at least through -dumpFrame's frame (read before Args, which
    // takes them).
    function testFrames(argc: int, argv: Ref<string>): int {
        let frames = TEST_FRAMES;
        let dumpFrame = -1;
        for (let i = 1; i + 1 < argc; i++) {
            const arg = CommandLine.getArg(argv, i);
            if (arg == "-frames") {
                frames = parseInt(CommandLine.getArg(argv, i + 1));
            } else if (arg == "-dumpFrame") {
                dumpFrame = parseInt(CommandLine.getArg(argv, i + 1));
            }
        }
        if (dumpFrame + 1 > frames) {
            frames = dumpFrame + 1;
        }
        return frames;
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Program.setAppName("rtxdi_minimal");

        const args = new RtxdiMinimalArgs(argc, argv, testFrames(argc, argv));
        args.parseArgs();

        // RayTracing: Vulkan's ray tracing extensions (the shaders' ray queries).
        const app = App.createWithOptions(args.api, WINDOW_TITLE, args.width, args.height,
            AppOptions.RayTracing | args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        if (!app.isFeatureSupported(Feature.RayQuery)) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support Ray Queries");
        }
        console.log(`Renderer: ${app.getRendererString()}`);

        const renderer = new SceneRenderer(app, args);
        if (!renderer.init()) {
            app.waitForIdle();
            renderer.dispose();
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        // -dumpFrame: the frame's HDR color, as the reference's dump (after its Render pass, before anything else).
        if (args.dumpFrame >= 0) {
            const targets = renderer.targets;
            if (!renderer.dumpRendered || !targets) {
                console.log(`Frame index ${args.dumpFrame} was not rendered: nothing dumped`);
                result = 1;
            } else if (Rtxdi_SaveTextureRGBA32F(app.handle, targets.hdrColor, args.dumpPath) == 0) {
                result = 1;
            } else {
                console.log(`Dumped frame index ${args.dumpFrame} (${targets.width} x ${targets.height}) to ${args.dumpPath}`);
            }
        }
        if (args.test) {
            let failure = checkLights(app, renderer);
            if (failure == "") {
                failure = checkFrame(app, renderer);
            }
            const testResult = app.finishTest(failure);
            if (result == 0) {
                result = testResult;
            }
        }
        app.waitForIdle();
        renderer.dispose();
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RtxdiMinimal.main(argc, argv);
}

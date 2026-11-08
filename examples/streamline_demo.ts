// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";
import { radiansF32 } from "../core/matrix";

// NVIDIA Streamline (github.com/NVIDIA-RTX/Streamline) on Donut: core/streamline.cpp loads its interposer and
// plugins from bin/streamline/ and hooks the app's device creation (AppOptions.Streamline). The frame is the
// Streamline Sample's (github.com/NVIDIA-RTX/Streamline_Sample, its StreamlineSample::RenderScene): Sponza
// with a dancing robot, cascaded shadow maps, a G-buffer, then ray traced lighting (the sample's ray
// generation library, compiled in place from STREAMLINE_SAMPLE_DIR) or deferred lighting with SSAO, the
// procedural sky, bloom, DLSS-SR, TAA or none (then optionally DLSS Ray Reconstruction), tone mapping with
// auto exposure, and optionally DeepDVC. Streamline's frame token,
// Reflex and PCL markers come from the device manager's frame callbacks (core/streamline.cpp).
namespace StreamlineDemo {
    // Test mode: the frames rendered: the last one is the sample's frame 120 (its reference frames', at
    // 1/60 s a frame), the 121st it renders.
    const TEST_FRAMES = 121;

    // -test: checks the last frame, Sponza lit and the robot in front of the camera, by the shares the
    // sample's own frames have (1920x1080): lit (not near black) 98-99% ray traced, 94.6% deferred; the
    // robot's white plates, 15-18% of its rectangle; saturated colors (the banners' pattern), 6-7% ray
    // traced (its reflections), 0.5% deferred; upscaled with DLSS from 960x540 (MaxPerformance) 3.9%.
    // With DeepDVC (its saturation boost) the sample's colored share is 41-43%: its band starts above the
    // plain frames' highest (DEEPDVC_MIN_COLORED > PLAIN_MAX_COLORED), so a pass also says it's more saturated.
    const PLAIN_MAX_COLORED = 9.0;
    const DEEPDVC_MIN_COLORED = 25.0;
    const DEEPDVC_MAX_COLORED = 60.0;
    function checkFrame(app: App, rayTraced: boolean, dlss: boolean, deepDvc: boolean) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        const lit = check.share(total - check.countInRange(0, 20, 0, 20, 0, 20, 0, 0, check.width, check.height), total,
            93.0, 100.0, "Lit");
        if (lit != "") {
            return lit;
        }
        const robotX = Math.trunc(check.width * 0.37);
        const robotY = Math.trunc(check.height * 0.4);
        const robotWidth = Math.trunc(check.width * 0.53) - robotX;
        const robotHeight = Math.trunc(check.height * 0.9) - robotY;
        const robot = check.share(check.countInRange(150, 255, 150, 255, 150, 255, robotX, robotY, robotWidth, robotHeight),
            robotWidth * robotHeight, 10.0, 25.0, "Robot");
        if (robot != "") {
            return robot;
        }
        const colored = check.countSpread(61, false, 0, 0, 0, check.width, check.height);
        if (deepDvc) {
            return check.share(colored, total, DEEPDVC_MIN_COLORED, DEEPDVC_MAX_COLORED, "Colored (DeepDVC)");
        }
        return check.share(colored, total, rayTraced ? (dlss ? 3.0 : 4.0) : 0.2, rayTraced ? PLAIN_MAX_COLORED : 1.5, "Colored");
    }

    // -test with -deepdvc: DeepDVC ran every frame.
    function checkDeepDvc(demo: StreamlineDemo, ui: UIData) {
        if (!ui.enableDeepDvc) {
            return "";
        }
        return demo.deepDvcEvaluations == TEST_FRAMES ? "" : `DeepDVC ran ${demo.deepDvcEvaluations} of ${TEST_FRAMES} frames`;
    }

    // -test with -dlss: DLSS upscaled every frame, from a smaller render size (DLAA's is the display's), made
    // once, or (-testDlssModeSwitch) made again once at the switch.
    function checkDlss(demo: StreamlineDemo, ui: UIData, modeSwitch: boolean) {
        if (ui.antiAliasingMode != AntiAliasingMode.DLSS) {
            return "";
        }
        if (demo.dlssEvaluations != TEST_FRAMES) {
            return `DLSS upscaled ${demo.dlssEvaluations} of ${TEST_FRAMES} frames`;
        }
        const targets = demo.renderTargets as RenderTargets;
        console.log(`DLSS: ${targets.renderWidth}x${targets.renderHeight} to ${targets.displayWidth}x${targets.displayHeight}`);
        if (ui.dlssMode != DlssMode.DLAA && targets.renderWidth >= targets.displayWidth) {
            return `DLSS renders at ${targets.renderWidth}x${targets.renderHeight}, not below the display size`;
        }
        const expectedChanges = modeSwitch ? 1 : 0;
        if (demo.renderSizeChanges != expectedChanges) {
            return `The render size changed ${demo.renderSizeChanges} times, not ${expectedChanges}`;
        }
        return "";
    }

    // -test with -dlssRR: DLSS-RR denoised and upscaled every frame, from a smaller render size (DLAA's is
    // the display's), made once.
    function checkDlssRR(demo: StreamlineDemo, ui: UIData) {
        if (ui.dlssRRMode == DlssMode.Off) {
            return "";
        }
        if (demo.dlssRREvaluations != TEST_FRAMES) {
            return `DLSS-RR evaluated ${demo.dlssRREvaluations} of ${TEST_FRAMES} frames`;
        }
        const targets = demo.renderTargets as RenderTargets;
        console.log(`DLSS-RR: ${targets.renderWidth}x${targets.renderHeight} to ${targets.displayWidth}x${targets.displayHeight}`);
        if (ui.dlssRRMode != DlssMode.DLAA && targets.renderWidth >= targets.displayWidth) {
            return `DLSS-RR renders at ${targets.renderWidth}x${targets.renderHeight}, not below the display size`;
        }
        if (demo.renderSizeChanges != 0) {
            return `The render size changed ${demo.renderSizeChanges} times, not 0`;
        }
        return "";
    }

    const WINDOW_TITLE = "Donut Example: Streamline";

    // Loaded unless --scene names another: Sponza with two dancing robots, the second behind the camera
    // (the sample's own scene, in its media folder, has a metal sphere there; the tests load that one).
    const DEFAULT_SCENE = "media/sponza-plus.scene.json";

    // The sample's camera: near plane, vertical field of view (degrees), move speed.
    const CAMERA_NEAR_PLANE = 0.01;
    const CAMERA_VERTICAL_FOV = 60.0;
    const CAMERA_MOVE_SPEED = 3.0;

    // The sample's cascaded shadow map (2048 x 2048, 4 cascades), its depth pass's biases, and its setup:
    // up to 100 m, over the view's frustum enlarged by 1 m on every side (so that light doesn't leak in at its
// edges).
    const SHADOW_MAP_RESOLUTION = 2048;
    const SHADOW_MAP_CASCADES = 4;
    const SHADOW_DEPTH_BIAS = 100;
    const SHADOW_SLOPE_SCALED_DEPTH_BIAS = 4.0;
    const MAX_SHADOW_DISTANCE = 100.0;
    const SHADOW_FRUSTUM_GROWTH = 1.0;

    // Stencil bit the G-buffer pass sets where it writes motion vectors, for TAA.
    const MOTION_VECTOR_STENCIL_MASK = 0x01;

    // The exposure the tone mapping pass starts from (ResetExposure), and the eye adaptation on that first
    // frame (the sample's minAdaptedLuminance 0.1, no adaptation down).
    const INITIAL_EXPOSURE = 8.0;
    const RESET_MIN_ADAPTED_LUMINANCE = 0.1;

    // Donut's ToneMappingParameters defaults (the sample's UIData keeps them).
    const EYE_ADAPTATION_SPEED_UP = 1.0;
    const EYE_ADAPTATION_SPEED_DOWN = 0.5;
    const MIN_ADAPTED_LUMINANCE = 0.02;
    const MAX_ADAPTED_LUMINANCE = 0.5;
    const EXPOSURE_BIAS = -0.5;

    // Donut's SkyParameters defaults (the sample's UIData keeps them): sky and ground colors (for the
    // ambient terms), brightness, glow and horizon.
    const SKY_COLOR = [0.17, 0.37, 0.65];
    const GROUND_COLOR = [0.62, 0.59, 0.55];
    const SKY_BRIGHTNESS = 0.1;
    const SKY_GLOW_SIZE = 5.0;
    const SKY_GLOW_SHARPNESS = 4.0;
    const SKY_GLOW_INTENSITY = 0.1;
    const SKY_HORIZON_SIZE = 30.0;
    const SKY_MAX_LIGHT_RADIANCE = 100.0;
    // The ray traced path's second sky: default parameters with the light's radiance clamped lower.
    const RT_SKY_MAX_LIGHT_RADIANCE = 0.75;

    // --- The ray generation library (StreamlineSample.hlsl in STREAMLINE_SAMPLE_DIR/src) ----------------

    const RT_SHADER_LIBRARY = "StreamlineSample.hlsl";
    // 2 x sizeof(float4): the largest ray payload; reflection hits trace shadow rays.
    const RT_PAYLOAD_SIZE = 32;
    const RT_MAX_RECURSION_DEPTH = 2;
    // Shader table entries per scene geometry: shadow, then reflection (the shaders'
    // MultiplierForGeometryContributionToHitGroupIndex).
    const RT_HIT_GROUPS_PER_GEOMETRY = 2;
    // Its global bindings (register space 0): LightingConstants at b0, the TLAS at t0, the G-buffer's depth
    // and four textures at t1..t5, the lit color at u0, the specular hit distance at u1 (bound, unused),
    // a sampler at s0. On Vulkan they're at bindings 200 + t, 300 + b, 400 + u (the sample's offsets).
    const RT_BINDING_LIGHTING_CONSTANTS = 0;
    const RT_BINDING_SCENE_BVH = 0;
    const RT_BINDING_GBUFFER_DEPTH = 1;
    const RT_BINDING_GBUFFER_0 = 2;
    const RT_BINDING_GBUFFER_1 = 3;
    const RT_BINDING_GBUFFER_2 = 4;
    const RT_BINDING_GBUFFER_3 = 5;
    const RT_BINDING_OUTPUT = 0;
    const RT_BINDING_SPEC_HIT_DISTANCE = 1;
    const RT_BINDING_SAMPLER = 0;
    const RT_VULKAN_SRV_OFFSET = 200;
    const RT_VULKAN_SAMPLER_OFFSET = 128;
    const RT_VULKAN_CB_OFFSET = 300;
    const RT_VULKAN_UAV_OFFSET = 400;
    // The reflection hit group's local bindings (D3D12 only, register space 1): the geometry's indices,
    // texture coordinates and normals at t0..t2, material textures at t3..t6, its MaterialConstants at b0.
    const RT_LOCAL_SPACE = 1;
    const RT_LOCAL_INDEX_BUFFER = 0;
    const RT_LOCAL_TEX_COORD_BUFFER = 1;
    const RT_LOCAL_NORMAL_BUFFER = 2;
    const RT_LOCAL_DIFFUSE_TEXTURE = 3;
    const RT_LOCAL_SPECULAR_TEXTURE = 4;
    const RT_LOCAL_NORMAL_TEXTURE = 5;
    const RT_LOCAL_OCCLUSION_TEXTURE = 6;
    const RT_LOCAL_MATERIAL_CONSTANTS = 0;
    // struct LightingConstants (the sample's lighting_cb.h), as f32 offsets: float4 ambientColor;
    // LightConstants light; PlanarViewConstants view; int frameIndex. The ray traced path's ambient color.
    const RT_LIGHT_OFFSET = 4;
    const RT_AMBIENT_COLOR = 0.037;

    enum AntiAliasingMode {
        NONE = 0,
        TEMPORAL = 1,
        DLSS = 2
    }

    // DLSS-SR's modes (sl::DLSSMode), as the sample's -DLSS_mode numbers them. UltraQuality (5) is
    // rejected, as the sample does.
    enum DlssMode {
        Off = 0,
        MaxPerformance = 1,
        Balanced = 2,
        MaxQuality = 3,
        UltraPerformance = 4,
        UltraQuality = 5,
        DLAA = 6
    }

    // -testDlssModeSwitch: the frame DLSS switches to MaxPerformance at.
    const DLSS_SWITCH_FRAME = 60;

    // --- UI state -----------------------------------------------------------------------------------

    // The settings the UI edits, with the sample's defaults (its UIData).
    class UIData {
        public enableAnimations = true;
        public animationSpeed = 1.0;
        public enableSsao = true;
        public enableToneMapping = true;
        public enableProceduralSky = true;
        public ambientIntensity = 0.2;
        public antiAliasingMode: int = AntiAliasingMode.NONE;
        public enableBloom = true;
        public bloomSigma = 32.0;
        public bloomAlpha = 0.05;
        public enableShadows = true;
        public csmExponent = 4.0;
        // 1: ray traced lighting; 0: deferred.
        public rayTracingMode: int = 1;
        public enableVsync = false;
        // DlssMode, with antiAliasingMode DLSS.
        public dlssMode: int = DlssMode.Off;
        // DLSS-RR's DlssMode (Off: not in use); anti-aliasing stays NONE with it, as in the sample.
        public dlssRRMode: int = DlssMode.Off;
        // DeepDVC on the color before the UI, its intensity and saturation boost (the sample's defaults).
        public enableDeepDvc = false;
        public deepDvcIntensity = 0.5;
        public deepDvcSaturationBoost = 0.75;
    }

    // --- Render targets --------------------------------------------------------------------------------

    // The sample's RenderTargets: Donut's G-buffer (motion vectors, reverse-Z depth) and HDR color, the
    // specular hit distance and ambient occlusion at the render size; the anti-aliased color, TAA's feedback,
    // LDR color, its copy without sRGB, the color before the UI (in the back buffer's format), DLSS-G's UI
    // color / alpha and DLSS-RR's guides at the display size (the same until DLSS renders smaller). NIS's
    // target is left out (no NIS plugin here).
    class RenderTargets {
        public gbuffer: GBufferTargets;
        public depth: TextureHandle;
        public motionVectors: TextureHandle;
        public hdrColor: TextureHandle;
        public specHitDistance: TextureHandle;
        public ambientOcclusion: TextureHandle;
        public aaResolvedColor: TextureHandle;
        public temporalFeedback1: TextureHandle;
        public temporalFeedback2: TextureHandle;
        public ldrColor: TextureHandle;
        public colorspaceCorrectionColor: TextureHandle;
        public preUIColor: TextureHandle;
        public uiColorAlpha: TextureHandle;
        public uiAlpha: TextureHandle;
        // DLSS-RR's diffuse / specular albedo and normals guides: cleared, never written, as in the sample.
        public gbufferDiffuseRR: TextureHandle;
        public gbufferSpecularRR: TextureHandle;
        public gbufferNormalsRR: TextureHandle;
        public gbufferEmissiveRR: TextureHandle;

        public forwardFramebuffer: FramebufferFactoryHandle;
        public hdrFramebuffer: FramebufferFactoryHandle;
        public ldrFramebuffer: FramebufferFactoryHandle;
        public aaResolvedFramebuffer: FramebufferFactoryHandle;
        public preUIFramebuffer: FramebufferFactoryHandle;

        public renderWidth: int;
        public renderHeight: int;
        public displayWidth: int;
        public displayHeight: int;

        constructor(app: App, renderWidth: int, renderHeight: int, displayWidth: int, displayHeight: int, backBufferFormat: Format) {
            this.renderWidth = renderWidth;
            this.renderHeight = renderHeight;
            this.displayWidth = displayWidth;
            this.displayHeight = displayHeight;

            // Reverse Z: depth is cleared to 0.
            this.gbuffer = app.createGBufferTargetsWithMotionVectors(renderWidth, renderHeight, 1);
            this.depth = this.gbuffer.getTexture(GBufferTexture.Depth);
            this.motionVectors = this.gbuffer.getTexture(GBufferTexture.MotionVectors);

            const w = renderWidth;
            const h = renderHeight;
            this.hdrColor = app.createRenderTargetTextureInState(w, h, Format.RGBA16_FLOAT, 1, ResourceState.ShaderResource, "HdrColor");
            this.specHitDistance = app.createRenderTargetTextureInState(w, h, Format.R16_FLOAT, 1, ResourceState.UnorderedAccess, "SpecHitDistance");
            this.ambientOcclusion = app.createRenderTargetTextureInState(w, h, Format.R8_UNORM, 1, ResourceState.RenderTarget, "AmbientOcclusion");

            const dw = displayWidth;
            const dh = displayHeight;
            this.aaResolvedColor = app.createRenderTargetTextureInState(dw, dh, Format.RGBA16_FLOAT, 1, ResourceState.RenderTarget, "AAResolvedColor");
            this.temporalFeedback1 = app.createRenderTargetTextureInState(dw, dh, Format.RGBA16_SNORM, 1, ResourceState.RenderTarget, "TemporalFeedback1");
            this.temporalFeedback2 = app.createRenderTargetTextureInState(dw, dh, Format.RGBA16_SNORM, 1, ResourceState.RenderTarget, "TemporalFeedback2");
            this.ldrColor = app.createRenderTargetTextureInState(dw, dh, Format.SRGBA8_UNORM, 0, ResourceState.RenderTarget, "LdrColor");
            this.gbufferDiffuseRR = app.createRenderTargetTextureInState(dw, dh, Format.RGBA16_FLOAT, 0, ResourceState.RenderTarget, "GBufferDiffuseRR");
            this.gbufferSpecularRR = app.createRenderTargetTextureInState(dw, dh, Format.RGBA16_FLOAT, 0, ResourceState.RenderTarget, "GBufferSpecularRR");
            this.gbufferNormalsRR = app.createRenderTargetTextureInState(dw, dh, Format.RGBA16_FLOAT, 0, ResourceState.RenderTarget, "GBufferNormalsRR");
            this.gbufferEmissiveRR = app.createRenderTargetTextureInState(dw, dh, Format.RGBA16_FLOAT, 0, ResourceState.RenderTarget, "GBufferEmissiveRR");
            this.colorspaceCorrectionColor = app.createRenderTargetTextureInState(dw, dh, Format.RGBA8_UNORM, 1, ResourceState.RenderTarget,
                "ColorspaceCorrectionColor");
            this.preUIColor = app.createRenderTargetTextureInState(dw, dh, backBufferFormat, 1, ResourceState.RenderTarget, "PreUIColor");
            this.uiColorAlpha = app.createRenderTargetTextureInState(dw, dh, Format.RGBA16_FLOAT, 0, ResourceState.RenderTarget, "UIColorAlpha");
            this.uiAlpha = app.createRenderTargetTextureInState(dw, dh, Format.R16_FLOAT, 0, ResourceState.RenderTarget, "UIAlpha");

            this.forwardFramebuffer = app.createFramebufferFactory(this.hdrColor, this.depth);
            this.hdrFramebuffer = app.createFramebufferFactory(this.hdrColor, null);
            this.ldrFramebuffer = app.createFramebufferFactory(this.ldrColor, null);
            this.aaResolvedFramebuffer = app.createFramebufferFactory(this.aaResolvedColor, null);
            this.preUIFramebuffer = app.createFramebufferFactory(this.preUIColor, null);
        }

        // The sample's RenderTargets::Clear: the G-buffer, then its own color targets, to 0.
        clear(frame: Frame) {
            frame.clearGBuffer(this.gbuffer);
            const commandList = frame.getCommandList();
            const textures = [this.hdrColor, this.ldrColor, this.preUIColor, this.uiColorAlpha, this.uiAlpha, this.aaResolvedColor,
                this.specHitDistance, this.gbufferDiffuseRR, this.gbufferSpecularRR, this.gbufferNormalsRR, this.gbufferEmissiveRR];
            for (let i = 0; i < textures.length; i++) {
                commandList.clearTextureFloat(textures[i], 0.0, 0.0, 0.0, 0.0);
            }
        }

        release(app: App) {
            app.releaseObject(this.forwardFramebuffer);
            app.releaseObject(this.hdrFramebuffer);
            app.releaseObject(this.ldrFramebuffer);
            app.releaseObject(this.aaResolvedFramebuffer);
            app.releaseObject(this.preUIFramebuffer);
            const textures = [this.hdrColor, this.specHitDistance, this.ambientOcclusion, this.aaResolvedColor, this.temporalFeedback1,
                this.temporalFeedback2, this.ldrColor, this.colorspaceCorrectionColor, this.preUIColor, this.uiColorAlpha, this.uiAlpha,
                this.gbufferDiffuseRR, this.gbufferSpecularRR, this.gbufferNormalsRR, this.gbufferEmissiveRR];
            for (let i = 0; i < textures.length; i++) {
                app.releaseResource(textures[i]);
            }
            app.releaseObject(this.gbuffer.handle);
        }
    }

    // --- Renderer ----------------------------------------------------------------------------------------

    // Port of the sample's StreamlineSample class (its RenderScene and what it calls), without Streamline.
    class StreamlineDemo {
        private app: App;
        private ui: UIData;
        // D3D12 or Vulkan with ray tracing pipelines: the sample's ray traced lighting (else deferred only).
        private rayTracingSupported: boolean;
        private isVulkan: boolean;

        private scene: Scene;
        private sceneGraph: SceneGraph;
        private sunLight: Light;
        private wallclockTime: number;

        private shadowMap: ShadowMap;
        private shadowDepthPass: DepthPass;

        public renderTargets: RenderTargets | null;
        // -test's DLSS checks: the frames DLSS upscaled, and how many times the render size changed.
        public dlssEvaluations: int;
        public renderSizeChanges: int;
        // -test's DLSS-RR and DeepDVC checks: the frames each ran.
        public dlssRREvaluations: int;
        public deepDvcEvaluations: int;
        // Streamline started, DLSS and DLSS-RR supported; -testDlssModeSwitch.
        public streamline: boolean;
        public dlssSupported: boolean;
        public dlssRRSupported: boolean;
        public deepDvcSupported: boolean;
        public testDlssModeSwitch: boolean;
        // The DLSS mode and display size the render size was last asked for (Off: DLSS not in use), that
        // render size, and the mip level bias the passes were made with.
        private dlssLastMode: int;
        private dlssLastDisplayWidth: int;
        private dlssLastDisplayHeight: int;
        private dlssRenderWidth: int;
        private dlssRenderHeight: int;
        // The same for DLSS-RR.
        private dlssRRLastMode: int;
        private dlssRRLastDisplayWidth: int;
        private dlssRRLastDisplayHeight: int;
        private dlssRRRenderWidth: int;
        private dlssRRRenderHeight: int;
        // DLSS-RR's camera: the inverse of viewMatrix (the world-to-view matrix), 16 floats.
        private viewToWorldMatrix: f32[];
        private previousLodBias: number;
        // Streamline's camera: position, forward, up, right (3 floats each).
        private cameraVectors: f32[];
        private gbufferPass: GBufferFillPass;
        private deferredLightingPass: DeferredLightingPass;
        private skyPass: SkyPassHandle | null;
        private temporalAntiAliasingPass: TemporalAntiAliasingPass;
        private ssaoPass: SsaoPassHandle | null;
        private bloomPass: BloomPassHandle | null;
        private toneMappingPass: ToneMappingPass;

        // The ray traced lighting: its pipeline's shader table, global binding layout and set (made with the
        // render targets), LightingConstants, the scene's acceleration structures.
        private shaderTable: ShaderTable;
        private globalBindingLayout: BindingLayoutHandle;
        private rtBindingSet: BindingSet;
        // Set by updateRenderTargets when it made new ones (then the passes are made again).
        private renderTargetsChanged: boolean;
        private lightingConstants: BufferHandle;
        private accelStructs: SceneAccelStructs;
        private constants: f32[];
        private viewOffset: int;
        private frameIndexOffset: int;
        private constantsSize: int;

        // This frame's view and the previous one (swapped every frame), and the tone mapping's (the display
        // size, unjittered).
        private view: View;
        private viewPrevious: View;
        private toneMappingView: View;
        private previousViewsValid: boolean;
        private camera: Camera;

        // Matrices passed to C++ by Ref (16 floats each), a pixel offset, box bounds.
        private viewMatrix: f32[];
        private projMatrix: f32[];
        private vector2: f32[];
        private bounds: f32[];

        constructor(app: App, ui: UIData) {
            this.app = app;
            this.ui = ui;
            this.rayTracingSupported = false;
            this.isVulkan = false;
            this.wallclockTime = 0.0;
            this.sunLight = new Light(null);
            this.renderTargets = null;
            this.dlssEvaluations = 0;
            this.renderSizeChanges = 0;
            this.dlssRREvaluations = 0;
            this.deepDvcEvaluations = 0;
            this.streamline = false;
            this.dlssSupported = false;
            this.dlssRRSupported = false;
            this.deepDvcSupported = false;
            this.testDlssModeSwitch = false;
            this.dlssLastMode = DlssMode.Off;
            this.dlssLastDisplayWidth = 0;
            this.dlssLastDisplayHeight = 0;
            this.dlssRenderWidth = 0;
            this.dlssRenderHeight = 0;
            this.dlssRRLastMode = DlssMode.Off;
            this.dlssRRLastDisplayWidth = 0;
            this.dlssRRLastDisplayHeight = 0;
            this.dlssRRRenderWidth = 0;
            this.dlssRRRenderHeight = 0;
            this.viewToWorldMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewToWorldMatrix.push(0.0);
            }
            this.previousLodBias = 0.0;
            this.cameraVectors = [];
            for (let i = 0; i < 12; i++) {
                this.cameraVectors.push(0.0);
            }
            this.gbufferPass = new GBufferFillPass(null);
            this.deferredLightingPass = new DeferredLightingPass(null);
            this.skyPass = null;
            this.temporalAntiAliasingPass = new TemporalAntiAliasingPass(null);
            this.ssaoPass = null;
            this.bloomPass = null;
            this.toneMappingPass = new ToneMappingPass(null);
            this.rtBindingSet = new BindingSet(null);
            this.renderTargetsChanged = false;
            this.constants = [];
            this.viewOffset = 0;
            this.frameIndexOffset = 0;
            this.constantsSize = 0;
            this.view = new View(null);
            this.viewPrevious = new View(null);
            this.toneMappingView = new View(null);
            this.previousViewsValid = false;
            this.viewMatrix = [];
            this.projMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
                this.projMatrix.push(0.0);
            }
            this.vector2 = [0.0, 0.0];
            this.bounds = [];
            for (let i = 0; i < 6; i++) {
                this.bounds.push(0.0);
            }
        }

        init(scenePath: string, api: GraphicsAPI) {
            const app = this.app;
            this.isVulkan = api == GraphicsAPI.VULKAN;
            this.rayTracingSupported = app.isFeatureSupported(Feature.RayTracingPipeline);
            if (!this.rayTracingSupported) {
                console.log("No ray tracing pipelines on this device: deferred lighting only");
                this.ui.rayTracingMode = 0;
            }

            this.shadowMap = app.createCascadedShadowMap(SHADOW_MAP_RESOLUTION, SHADOW_MAP_CASCADES);
            this.shadowDepthPass = app.createShadowDepthPass(SHADOW_DEPTH_BIAS, SHADOW_SLOPE_SCALED_DEPTH_BIAS);

            this.camera = app.createFirstPersonCamera();
            this.camera.setMoveSpeed(CAMERA_MOVE_SPEED);

            // Loaded at once, as the sample does (no asynchronous loading): its first frame shows the scene.
            const scene = app.loadScene(scenePath);
            if (scene.isNull()) {
                console.log(`Cannot load the scene ${scenePath}`);
                return false;
            }
            this.scene = scene;
            this.sceneLoaded();

            if (this.rayTracingSupported && !this.createRayTracingPipeline()) {
                return false;
            }

            const pass = app.addPass();
            pass.setKeyboardCallback(this.onKeyboard);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setMouseScrollCallback(this.onMouseScroll);
            pass.setAnimateCallback(this.onAnimate);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        // The sample's SceneLoaded: its directional light (or a sun), the camera.
        sceneLoaded() {
            const sceneGraph = this.scene.getSceneGraph();
            this.sceneGraph = sceneGraph;
            this.wallclockTime = 0.0;
            this.previousViewsValid = false;

            const lightCount = sceneGraph.getLightCount();
            for (let i = 0; i < lightCount; i++) {
                const light = sceneGraph.getLight(i);
                if (light.getType() == LightType.Directional) {
                    this.sunLight = light;
                    break;
                }
            }
            if (this.sunLight.isNull()) {
                this.sunLight = sceneGraph.addDirectionalLight(sceneGraph.getRootNode(), "Sun", 0.1, -0.9, 0.1, 0.53, 1.0);
                this.app.refreshSceneGraph(sceneGraph);
            }

            this.camera.lookAt(0.0, 1.8, 0.0, 1.0, 1.8, 0.0);
        }

        // The sample's CreateRayTracingPipeline and CreateAccelStruct: the ray generation library with the
        // reflection hit group reading materials (REFLECT_MATERIALS 1) on D3D12 only, as it has local binding
        // layouts there; one BLAS per mesh and a TLAS of the instances, two shader table entries per geometry.
        createRayTracingPipeline() {
            const app = this.app;
            const shaderLibrary = app.createShaderLibraryWithDefine(RT_SHADER_LIBRARY, "REFLECT_MATERIALS", this.isVulkan ? "0" : "1");
            if (!shaderLibrary) {
                console.log(`Cannot load ${RT_SHADER_LIBRARY} (built with STREAMLINE_SAMPLE_DIR?)`);
                return false;
            }

            const globalLayoutDesc = BindingLayoutDesc.create();
            globalLayoutDesc.setDescriptorSet(0);
            globalLayoutDesc.setVulkanOffsets(RT_VULKAN_SRV_OFFSET, RT_VULKAN_SAMPLER_OFFSET, RT_VULKAN_CB_OFFSET, RT_VULKAN_UAV_OFFSET);
            globalLayoutDesc.layoutVolatileConstantBuffer(RT_BINDING_LIGHTING_CONSTANTS);
            globalLayoutDesc.layoutAccelStruct(RT_BINDING_SCENE_BVH);
            globalLayoutDesc.layoutTextureSRV(RT_BINDING_GBUFFER_DEPTH);
            globalLayoutDesc.layoutTextureSRV(RT_BINDING_GBUFFER_0);
            globalLayoutDesc.layoutTextureSRV(RT_BINDING_GBUFFER_1);
            globalLayoutDesc.layoutTextureSRV(RT_BINDING_GBUFFER_2);
            globalLayoutDesc.layoutTextureSRV(RT_BINDING_GBUFFER_3);
            globalLayoutDesc.layoutTextureUAV(RT_BINDING_OUTPUT);
            globalLayoutDesc.layoutTextureUAV(RT_BINDING_SPEC_HIT_DISTANCE);
            globalLayoutDesc.layoutSampler(RT_BINDING_SAMPLER);
            this.globalBindingLayout = app.createBindingLayout(globalLayoutDesc, ShaderType.All);

            // The reflection hit group's local layout (D3D12).
            let localBindingLayout = this.globalBindingLayout;
            if (!this.isVulkan) {
                const localLayoutDesc = BindingLayoutDesc.create();
                localLayoutDesc.setDescriptorSet(RT_LOCAL_SPACE);
                localLayoutDesc.layoutTypedBufferSRV(RT_LOCAL_INDEX_BUFFER);
                localLayoutDesc.layoutTypedBufferSRV(RT_LOCAL_TEX_COORD_BUFFER);
                localLayoutDesc.layoutTypedBufferSRV(RT_LOCAL_NORMAL_BUFFER);
                localLayoutDesc.layoutTextureSRV(RT_LOCAL_DIFFUSE_TEXTURE);
                localLayoutDesc.layoutTextureSRV(RT_LOCAL_SPECULAR_TEXTURE);
                localLayoutDesc.layoutTextureSRV(RT_LOCAL_NORMAL_TEXTURE);
                localLayoutDesc.layoutTextureSRV(RT_LOCAL_OCCLUSION_TEXTURE);
                localLayoutDesc.layoutConstantBuffer(RT_LOCAL_MATERIAL_CONSTANTS);
                localBindingLayout = app.createBindingLayout(localLayoutDesc, ShaderType.All);
            }

            const pipelineDesc = RtPipelineDesc.create(RT_PAYLOAD_SIZE, RT_MAX_RECURSION_DEPTH);
            pipelineDesc.addGlobalBindingLayout(this.globalBindingLayout);
            pipelineDesc.addShader(shaderLibrary, "RayGen", ShaderType.RayGeneration);
            pipelineDesc.addShader(shaderLibrary, "ShadowMiss", ShaderType.Miss);
            pipelineDesc.addShader(shaderLibrary, "ReflectionMiss", ShaderType.Miss);
            // Shadow rays only need to know whether they hit anything.
            pipelineDesc.addHitGroup(shaderLibrary, "ShadowHitGroup", "", "", null);
            if (this.isVulkan) {
                pipelineDesc.addHitGroup(shaderLibrary, "ReflectionHitGroup", "ReflectionClosestHit", "", null);
            } else {
                pipelineDesc.addHitGroup(shaderLibrary, "ReflectionHitGroup", "ReflectionClosestHit", "", localBindingLayout);
            }
            const pipeline = app.createRayTracingPipelineFromDesc(pipelineDesc);
            if (!pipeline) {
                console.log("Cannot create the ray tracing pipeline");
                return false;
            }

            const shaderTable = app.createEmptyShaderTable(pipeline);
            // The shader table keeps the pipeline alive.
            app.releaseResource(pipeline);
            this.shaderTable = shaderTable;
            shaderTable.setRayGeneration("RayGen");
            shaderTable.addMiss("ShadowMiss");
            shaderTable.addMiss("ReflectionMiss");

            // Two entries per geometry, in global geometry index order (the TLAS instances' hit group offsets
            // assume it): shadow, then reflection with the geometry's resources (D3D12). The sample binds the
            // occlusion texture at t6, where the shader reads the emissive one, and neither t7 (occlusion) nor
            // t8 (transmission): kept.
            const geometryCount = this.scene.getGeometryCount();
            for (let geometry = 0; geometry < geometryCount; geometry++) {
                shaderTable.addHitGroup("ShadowHitGroup", null);
                if (!this.isVulkan) {
                    const desc = BindingSetDesc.create();
                    desc.bindGeometryIndexBuffer(RT_LOCAL_INDEX_BUFFER, this.scene, geometry);
                    desc.bindGeometryVertexAttribute(RT_LOCAL_TEX_COORD_BUFFER, this.scene, geometry, GeometryAttribute.TexCoord1);
                    desc.bindGeometryVertexAttribute(RT_LOCAL_NORMAL_BUFFER, this.scene, geometry, GeometryAttribute.Normal);
                    app.bindGeometryMaterialTexture(desc, RT_LOCAL_DIFFUSE_TEXTURE, this.scene, geometry,
                        MaterialTexture.BaseOrDiffuse, FallbackTexture.White);
                    app.bindGeometryMaterialTexture(desc, RT_LOCAL_SPECULAR_TEXTURE, this.scene, geometry,
                        MaterialTexture.MetalRoughOrSpecular, FallbackTexture.White);
                    app.bindGeometryMaterialTexture(desc, RT_LOCAL_NORMAL_TEXTURE, this.scene, geometry,
                        MaterialTexture.Normal, FallbackTexture.Black);
                    app.bindGeometryMaterialTexture(desc, RT_LOCAL_OCCLUSION_TEXTURE, this.scene, geometry,
                        MaterialTexture.Occlusion, FallbackTexture.White);
                    desc.bindGeometryMaterialConstants(RT_LOCAL_MATERIAL_CONSTANTS, this.scene, geometry);
                    shaderTable.addHitGroup("ReflectionHitGroup", app.createBindingSetForLayout(desc, localBindingLayout));
                } else {
                    shaderTable.addHitGroup("ReflectionHitGroup", null);
                }
            }

            // LightingConstants: the view's constants after the light's, the frame index last (16-byte rows).
            this.viewOffset = RT_LIGHT_OFFSET + ConstantSizes.light() / 4;
            this.frameIndexOffset = this.viewOffset + ConstantSizes.planarView() / 4;
            this.constantsSize = (this.frameIndexOffset + 4) * 4;
            for (let i = 0; i < this.constantsSize / 4; i++) {
                this.constants.push(0.0);
            }
            this.lightingConstants = app.createVolatileConstantBuffer(this.constantsSize, "LightingConstants");

            // The sample's acceleration structures of the loaded scene, rebuilt every frame (renderScene).
            const commandList = app.createCommandList();
            commandList.open();
            this.accelStructs = app.buildSceneAccelStructsWithHitGroupStride(commandList, this.scene, RT_HIT_GROUPS_PER_GEOMETRY);
            commandList.close();
            app.executeCommandList(commandList);
            app.waitForIdle();
            app.releaseResource(commandList.handle);
            return true;
        }

        // The sample's SetupView: this frame's view (jittered with TAA), the tone mapping's; true if the views
        // were created (then so are the passes).
        setupView(width: int, height: int, displayWidth: int, displayHeight: int) {
            const temporalAntiAliasingPass = this.temporalAntiAliasingPass;
            if (!temporalAntiAliasingPass.isNull()) {
                temporalAntiAliasingPass.setJitter(TemporalJitter.MSAA);
            }
            let pixelOffsetX = 0.0;
            let pixelOffsetY = 0.0;
            if (this.ui.antiAliasingMode != AntiAliasingMode.NONE && !temporalAntiAliasingPass.isNull()) {
                temporalAntiAliasingPass.getPixelOffset(Ref(this.vector2[0]));
                pixelOffsetX = this.vector2[0];
                pixelOffsetY = this.vector2[1];
            }

            this.camera.getWorldToView(Ref(this.viewMatrix[0]));
            // Reverse Z, infinite far plane; the aspect ratio in float, as the sample's.
            perspProjD3DStyleReverse(this.projMatrix, radiansF32(CAMERA_VERTICAL_FOV), Math.fround(width / height), CAMERA_NEAR_PLANE);

            let topologyChanged = false;
            if (this.view.isNull()) {
                this.view = this.app.createPlanarView();
                this.viewPrevious = this.app.createPlanarView();
                topologyChanged = true;
            }
            this.view.setPlanarViewJittered(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height, pixelOffsetX, pixelOffsetY);
            if (topologyChanged) {
                this.viewPrevious.copyPlanarView(this.view);
            }

            if (this.toneMappingView.isNull()) {
                this.toneMappingView = this.app.createPlanarView();
                topologyChanged = true;
            }
            this.toneMappingView.setPlanarViewJittered(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), displayWidth, displayHeight, 0.0, 0.0);
            return topologyChanged;
        }

        releaseObject(handle: ObjectHandle | null) {
            if (handle) {
                this.app.releaseObject(handle);
            }
        }

        // The sample's CreateRenderPasses, with the common samplers' mip level bias; returns whether the
        // exposure needs resetting (the first tone mapping pass).
        createRenderPasses(targets: RenderTargets, lodBias: number) {
            const app = this.app;
            const view = this.view;

            // The old passes may still be in flight.
            app.waitForIdle();
            app.setCommonSamplersMipBias(lodBias);

            this.releaseObject(this.gbufferPass.handle);
            this.releaseObject(this.deferredLightingPass.handle);
            this.releaseObject(this.skyPass);
            this.releaseObject(this.temporalAntiAliasingPass.handle);
            this.releaseObject(this.ssaoPass);
            this.releaseObject(this.bloomPass);

            this.gbufferPass = app.createGBufferFillPassWithOptions(1, MOTION_VECTOR_STENCIL_MASK);
            this.deferredLightingPass = app.createDeferredLightingPass();
            this.skyPass = app.createSkyPass(targets.forwardFramebuffer, view);
            this.temporalAntiAliasingPass = app.createTemporalAntiAliasingPassForTextures(view, targets.depth, targets.motionVectors,
                targets.hdrColor, targets.aaResolvedColor, targets.temporalFeedback1, targets.temporalFeedback2, MOTION_VECTOR_STENCIL_MASK);
            this.ssaoPass = app.createSsaoPassForTextures(targets.depth, targets.gbuffer.getTexture(GBufferTexture.Normals),
                targets.ambientOcclusion);

            // The new tone mapping pass takes over the old one's exposure.
            const previousToneMappingPass = this.toneMappingPass;
            const exposureResetRequired = previousToneMappingPass.isNull();
            this.bloomPass = app.createBloomPass(targets.hdrFramebuffer, this.toneMappingView);
            this.toneMappingPass = app.createToneMappingPass(targets.ldrFramebuffer, this.toneMappingView,
                exposureResetRequired ? null : previousToneMappingPass);
            this.releaseObject(previousToneMappingPass.handle);

            this.previousViewsValid = false;
            return exposureResetRequired;
        }

        // The render targets for the render and display sizes, made again when either changes, with the ray
        // tracing binding set over them.
        updateRenderTargets(renderWidth: int, renderHeight: int, width: int, height: int): RenderTargets {
            this.renderTargetsChanged = false;
            const current = this.renderTargets;
            if (current) {
                if (current.renderWidth == renderWidth && current.renderHeight == renderHeight && current.displayWidth == width
                    && current.displayHeight == height) {
                    return current;
                }
                this.renderSizeChanges++;
                // Released below: the GPU done with them, Streamline's references dropped.
                this.app.waitForIdle();
                Streamline_ClearTags();
                if (!this.rtBindingSet.isNull()) {
                    this.app.releaseResource(this.rtBindingSet.handle);
                    this.rtBindingSet = new BindingSet(null);
                }
                // Cached binding sets (blits, passes) still reference the old targets.
                this.app.clearBindingCache();
                current.release(this.app);
            }
            const targets = new RenderTargets(this.app, renderWidth, renderHeight, width, height, this.app.getBackBufferFormat());
            this.renderTargets = targets;
            this.renderTargetsChanged = true;

            if (this.rayTracingSupported) {
                const desc = BindingSetDesc.create();
                desc.bindEntireConstantBuffer(RT_BINDING_LIGHTING_CONSTANTS, this.lightingConstants);
                desc.bindAccelStruct(RT_BINDING_SCENE_BVH, this.accelStructs.getTopLevelAS());
                desc.bindTextureSRV(RT_BINDING_GBUFFER_DEPTH, targets.depth);
                desc.bindTextureSRV(RT_BINDING_GBUFFER_0, targets.gbuffer.getTexture(GBufferTexture.Diffuse));
                desc.bindTextureSRV(RT_BINDING_GBUFFER_1, targets.gbuffer.getTexture(GBufferTexture.Specular));
                desc.bindTextureSRV(RT_BINDING_GBUFFER_2, targets.gbuffer.getTexture(GBufferTexture.Normals));
                desc.bindTextureSRV(RT_BINDING_GBUFFER_3, targets.gbuffer.getTexture(GBufferTexture.Emissive));
                desc.bindTextureUAV(RT_BINDING_OUTPUT, targets.hdrColor);
                desc.bindTextureUAV(RT_BINDING_SPEC_HIT_DISTANCE, targets.specHitDistance);
                desc.bindSampler(RT_BINDING_SAMPLER, this.app.getCommonSampler(CommonSampler.LinearWrap));
                this.rtBindingSet = this.app.createBindingSetForLayout(desc, this.globalBindingLayout);
            }
            return targets;
        }

        // With DLSS: its render size for the mode at the display size, asked again when either changes (into
        // dlssRenderWidth / Height; DLSS failing to answer turns anti-aliasing off), and the texture mip level
        // bias for it, DLSS's programming guide's log2(render / display width) - 1. Leaving DLSS turns it off
        // and frees its resources. Returns the bias (0 without DLSS).
        updateDlss(width: int, height: int): number {
            const ui = this.ui;
            const usingDlss = ui.antiAliasingMode == AntiAliasingMode.DLSS && ui.dlssMode != DlssMode.Off && this.dlssSupported;
            if (!usingDlss) {
                if (ui.antiAliasingMode == AntiAliasingMode.DLSS) {
                    ui.antiAliasingMode = AntiAliasingMode.NONE;
                }
                if (this.dlssLastMode != DlssMode.Off) {
                    this.app.waitForIdle();
                    Streamline_DlssOptimalRenderSize(DlssMode.Off, width, height);
                    this.dlssLastMode = DlssMode.Off;
                }
                return 0.0;
            }
            if (ui.dlssMode != this.dlssLastMode || width != this.dlssLastDisplayWidth || height != this.dlssLastDisplayHeight) {
                if (this.dlssLastMode != DlssMode.Off) {
                    this.app.waitForIdle();
                    Streamline_DlssOptimalRenderSize(DlssMode.Off, width, height);
                }
                const size = Streamline_DlssOptimalRenderSize(ui.dlssMode, width, height);
                if (size == 0) {
                    console.log(`DLSS has no render size for mode ${ui.dlssMode} at ${width}x${height}: anti-aliasing off`);
                    ui.antiAliasingMode = AntiAliasingMode.NONE;
                    ui.dlssMode = DlssMode.Off;
                    return 0.0;
                }
                this.dlssRenderWidth = size & 0xffff;
                this.dlssRenderHeight = (size >> 16) & 0xffff;
                this.dlssLastMode = ui.dlssMode;
                this.dlssLastDisplayWidth = width;
                this.dlssLastDisplayHeight = height;
            }
            // In float, as the sample's log2f.
            return Math.fround(Math.fround(Math.log2(Math.fround(this.dlssRenderWidth / width))) - 1.0);
        }

        // With DLSS-RR (its mode not Off): its render size for the mode at the display size, asked again when
        // either changes (into dlssRRRenderWidth / Height; DLSS-RR failing to answer turns it off), as
        // updateDlss does. No mip level bias and no jitter with it: anti-aliasing stays NONE, as in the
        // sample. Turning it off frees its resources. Returns whether DLSS-RR is in use.
        updateDlssRR(width: int, height: int): boolean {
            const ui = this.ui;
            if (ui.dlssRRMode == DlssMode.Off || !this.dlssRRSupported) {
                ui.dlssRRMode = DlssMode.Off;
                if (this.dlssRRLastMode != DlssMode.Off) {
                    this.app.waitForIdle();
                    Streamline_DlssRROptimalRenderSize(DlssMode.Off, width, height);
                    this.dlssRRLastMode = DlssMode.Off;
                }
                return false;
            }
            if (ui.dlssRRMode != this.dlssRRLastMode || width != this.dlssRRLastDisplayWidth || height != this.dlssRRLastDisplayHeight) {
                // Freed first, as DLSS's (updateDlss).
                if (this.dlssRRLastMode != DlssMode.Off) {
                    this.app.waitForIdle();
                    Streamline_DlssRROptimalRenderSize(DlssMode.Off, width, height);
                }
                const size = Streamline_DlssRROptimalRenderSize(ui.dlssRRMode, width, height);
                if (size == 0) {
                    console.log(`DLSS-RR has no render size for mode ${ui.dlssRRMode} at ${width}x${height}: DLSS-RR off`);
                    ui.dlssRRMode = DlssMode.Off;
                    this.dlssRRLastMode = DlssMode.Off;
                    return false;
                }
                this.dlssRRRenderWidth = size & 0xffff;
                this.dlssRRRenderHeight = (size >> 16) & 0xffff;
                this.dlssRRLastMode = ui.dlssRRMode;
                this.dlssRRLastDisplayWidth = width;
                this.dlssRRLastDisplayHeight = height;
            }
            return true;
        }

        // DLSS-RR's evaluation into the resolved color (over what the anti-aliasing step put there, as the
        // sample does), with the camera's matrices. Its albedo and normal guides are the RR render targets,
        // which are only cleared, never drawn into: the sample's frame, kept for parity.
        evaluateDlssRR(commandList: CommandList, targets: RenderTargets) {
            // The world-to-view matrix setupView filled is rigid ([R 0; t 1], row vectors): its inverse is
            // [R^T 0; -t R^T 1].
            const m = this.viewMatrix;
            const inv = this.viewToWorldMatrix;
            for (let row = 0; row < 3; row++) {
                for (let column = 0; column < 3; column++) {
                    inv[column * 4 + row] = m[row * 4 + column];
                }
                inv[row * 4 + 3] = 0.0;
            }
            for (let column = 0; column < 3; column++) {
                inv[12 + column] = Math.fround(-Math.fround(Math.fround(m[12] * m[column * 4]) + Math.fround(m[13] * m[column * 4 + 1])
                    + Math.fround(m[14] * m[column * 4 + 2])));
            }
            inv[15] = 1.0;
            Streamline_EvaluateDlssRR(commandList.handle, this.ui.dlssRRMode, targets.hdrColor, targets.aaResolvedColor,
                targets.gbufferDiffuseRR, targets.gbufferSpecularRR, targets.gbufferNormalsRR, targets.specHitDistance,
                Ref(this.viewMatrix[0]), Ref(inv[0]));
            this.dlssRREvaluations++;
        }

        // Streamline's constants for the frame (set every frame Streamline runs, whatever its features do) and
        // its common tags: motion vectors, depth, the color before the UI.
        setStreamlineConstants(commandList: CommandList, targets: RenderTargets) {
            const v = this.cameraVectors;
            this.camera.getPosition(Ref(v[0]));
            this.camera.getDirection(Ref(v[3]));
            this.camera.getUp(Ref(v[6]));
            // Right = normalize(forward x up).
            const rx = Math.fround(v[4] * v[8] - v[5] * v[7]);
            const ry = Math.fround(v[5] * v[6] - v[3] * v[8]);
            const rz = Math.fround(v[3] * v[7] - v[4] * v[6]);
            const length = Math.fround(Math.sqrt(rx * rx + ry * ry + rz * rz));
            v[9] = length > 0.0 ? rx / length : 0.0;
            v[10] = length > 0.0 ? ry / length : 0.0;
            v[11] = length > 0.0 ? rz / length : 0.0;
            // reset 0 always: the sample's flag for it is a shadowed local that stays false.
            Streamline_SetConstants(this.view.handle, this.viewPrevious.handle, Ref(v[0]), Ref(v[3]), Ref(v[6]), Ref(v[9]),
                targets.renderWidth, targets.renderHeight, 0);
            Streamline_TagCommon(commandList.handle, targets.motionVectors, targets.depth, targets.preUIColor);
        }

        // The sample's RenderScene, without its NIS and DLSS-G features (yet).
        renderScene(frame: Frame) {
            const app = this.app;
            const ui = this.ui;
            const sceneGraph = this.sceneGraph;
            const sunLight = this.sunLight;
            const width = frame.getWidth();
            const height = frame.getHeight();

            if (this.testDlssModeSwitch && app.getFrameIndex() == DLSS_SWITCH_FRAME) {
                ui.dlssMode = DlssMode.MaxPerformance;
            }

            // The render size: DLSS's for its mode, else the display size; the mip level bias for it.
            const lodBias = this.updateDlss(width, height);
            let renderWidth = ui.antiAliasingMode == AntiAliasingMode.DLSS ? this.dlssRenderWidth : width;
            let renderHeight = ui.antiAliasingMode == AntiAliasingMode.DLSS ? this.dlssRenderHeight : height;
            // DLSS-RR's render size instead, when it's on (the sample's order: it overrides DLSS's).
            const usingDlssRR = this.updateDlssRR(width, height);
            if (usingDlssRR) {
                renderWidth = this.dlssRRRenderWidth;
                renderHeight = this.dlssRRRenderHeight;
            }

            // RefreshSceneGraph, and (into the frame's command list) RefreshBuffers: the robot's skinning.
            app.refreshScene(frame, this.scene);

            const targets = this.updateRenderTargets(renderWidth, renderHeight, width, height);
            let needNewPasses = this.renderTargetsChanged;
            if (lodBias != this.previousLodBias) {
                needNewPasses = true;
                this.previousLodBias = lodBias;
            }
            if (this.setupView(renderWidth, renderHeight, targets.displayWidth, targets.displayHeight)) {
                needNewPasses = true;
            }
            let exposureResetRequired = false;
            if (needNewPasses) {
                exposureResetRequired = this.createRenderPasses(targets, lodBias);
            }

            const commandList = frame.getCommandList();
            const view = this.view;
            const viewPrevious = this.viewPrevious;
            const toneMappingPass = this.toneMappingPass;
            const temporalAntiAliasingPass = this.temporalAntiAliasingPass;

            targets.clear(frame);
            frame.clearColor(0.0, 0.0, 0.0, 0.0);

            if (exposureResetRequired) {
                commandList.resetExposure(toneMappingPass, INITIAL_EXPOSURE);
            }

            // Ambient = intensity x the sky's (ground's) color x its brightness, in float as the sample's.
            const ambientTop = [0.0, 0.0, 0.0];
            const ambientBottom = [0.0, 0.0, 0.0];
            for (let i = 0; i < 3; i++) {
                ambientTop[i] = Math.fround(Math.fround(Math.fround(ui.ambientIntensity) * Math.fround(SKY_COLOR[i])) * Math.fround(SKY_BRIGHTNESS));
                ambientBottom[i] = Math.fround(Math.fround(Math.fround(ui.ambientIntensity) * Math.fround(GROUND_COLOR[i])) * Math.fround(SKY_BRIGHTNESS));
            }

            // Shadow map: cascades over the view's frustum, depth over half the scene's diagonal.
            if (ui.enableShadows) {
                sunLight.setShadowMap(this.shadowMap);
                sceneGraph.getRootNode().getBoundingBox(Ref(this.bounds[0]));
                const b = this.bounds;
                const dx = Math.fround(b[3] - b[0]);
                const dy = Math.fround(b[4] - b[1]);
                const dz = Math.fround(b[5] - b[2]);
                const zRange = Math.fround(Math.fround(Math.sqrt(dx * dx + dy * dy + dz * dz)) * 0.5);
                this.shadowMap.setupForGrownView(sunLight, view, SHADOW_FRUSTUM_GROWTH, MAX_SHADOW_DISTANCE, zRange, ui.csmExponent);
                commandList.clearShadowMap(this.shadowMap);
                commandList.renderShadowDepth(this.shadowDepthPass, this.shadowMap, sceneGraph, 0);
            } else {
                sunLight.setShadowMap(null);
            }

            // The G-buffer (the sample clears its targets again first).
            targets.clear(frame);
            commandList.renderGBufferFillTargets(this.gbufferPass, view, viewPrevious, targets.gbuffer, sceneGraph);

            const skyPass = this.skyPass as SkyPassHandle;
            const bloomPass = this.bloomPass as BloomPassHandle;
            if (ui.rayTracingMode != 0 && this.rayTracingSupported) {
                // Ray traced lighting into HDR color. No camera motion vectors on this path (as in the sample).
                for (let i = 0; i < 4; i++) {
                    this.constants[i] = RT_AMBIENT_COLOR;
                }
                sunLight.fillConstants(Ref(this.constants[RT_LIGHT_OFFSET]));
                view.fillPlanarViewConstants(Ref(this.constants[this.viewOffset]));
                RawMemory.storeInt32(Ref(this.constants[this.frameIndexOffset]), app.getFrameIndex());
                commandList.writeBuffer(this.lightingConstants, Ref(this.constants[0]), this.constantsSize);

                // The sample's CreateAccelStruct every frame: every BLAS rebuilt (the robot's skinned pose), then
                // the TLAS. The sample builds a new TLAS, but its binding set keeps the first one, which its rays
                // trace over the rebuilt BLASes: invalid in DXR (D3D12 removes the device here, mostly with two
                // robots). The TLAS rebuilt in place instead is the same one (the instances don't move).
                commandList.rebuildSceneAccelStructs(this.accelStructs, this.scene, RT_HIT_GROUPS_PER_GEOMETRY);

                // At the back buffer's size, as the sample dispatches: with DLSS more rays than the render size,
                // whose writes outside the color target are dropped.
                frame.dispatchRays(this.shaderTable, this.rtBindingSet, width, height);

                // The sample's sky and bloom in this branch, then once more after it (below): kept.
                if (ui.enableProceduralSky) {
                    commandList.renderSky(skyPass, view, sunLight, SKY_BRIGHTNESS, SKY_GLOW_SIZE, SKY_GLOW_SHARPNESS,
                        SKY_GLOW_INTENSITY, SKY_HORIZON_SIZE);
                }
                if (ui.enableBloom) {
                    commandList.renderBloom(bloomPass, targets.hdrFramebuffer, view, targets.hdrColor, ui.bloomSigma, ui.bloomAlpha);
                }
                // Then a sky of default parameters with the light's radiance clamped (always).
                commandList.renderSkyClamped(skyPass, view, sunLight, SKY_BRIGHTNESS, SKY_GLOW_SIZE, SKY_GLOW_SHARPNESS,
                    SKY_GLOW_INTENSITY, SKY_HORIZON_SIZE, RT_SKY_MAX_LIGHT_RADIANCE);
            } else {
                // Deferred shading: camera motion vectors (for TAA), SSAO, the lights.
                if (this.previousViewsValid) {
                    commandList.renderViewMotionVectors(temporalAntiAliasingPass, view, viewPrevious);
                }
                const ssaoPass = this.ssaoPass;
                if (ui.enableSsao && ssaoPass) {
                    commandList.renderSsao(ssaoPass, view);
                }
                commandList.renderDeferredLightingTargets(this.deferredLightingPass, view, targets.gbuffer,
                    ui.enableSsao ? targets.ambientOcclusion : null, ambientTop[0], ambientTop[1], ambientTop[2],
                    ambientBottom[0], ambientBottom[1], ambientBottom[2], sceneGraph, targets.hdrColor);
            }

            if (ui.enableProceduralSky) {
                commandList.renderSky(skyPass, view, sunLight, SKY_BRIGHTNESS, SKY_GLOW_SIZE, SKY_GLOW_SHARPNESS,
                    SKY_GLOW_INTENSITY, SKY_HORIZON_SIZE);
            }
            if (ui.enableBloom) {
                commandList.renderBloom(bloomPass, targets.hdrFramebuffer, view, targets.hdrColor, ui.bloomSigma, ui.bloomAlpha);
            }

            if (this.streamline) {
                this.setStreamlineConstants(commandList, targets);
            }

            // Anti-aliasing into the resolved color: DLSS, TAA, or a copy.
            if (ui.antiAliasingMode == AntiAliasingMode.DLSS) {
                Streamline_EvaluateDlss(commandList.handle, ui.dlssMode, targets.hdrColor, targets.aaResolvedColor,
                    targets.renderWidth, targets.renderHeight);
                this.dlssEvaluations++;
                this.previousViewsValid = true;
            } else if (ui.antiAliasingMode == AntiAliasingMode.TEMPORAL) {
                commandList.temporalResolveView(temporalAntiAliasingPass, view, this.previousViewsValid ? 1 : 0, 1);
                this.previousViewsValid = true;
            } else {
                app.blitTextureToFramebuffer(commandList, targets.aaResolvedFramebuffer, view, targets.hdrColor);
                this.previousViewsValid = false;
            }
            // DLSS-RR over the resolved color.
            if (usingDlssRR) {
                this.evaluateDlssRR(commandList, targets);
            }

            // Tone mapping (on the first frame, adapting up at once from the reset exposure), its LDR result
            // copied as RGBA8_UNORM (the sRGB-encoded bytes as they are), then into the color before the UI.
            let texToDisplay = targets.aaResolvedColor;
            if (ui.enableToneMapping) {
                commandList.renderToneMappingAdapted(toneMappingPass, this.toneMappingView, targets.aaResolvedColor,
                    EYE_ADAPTATION_SPEED_UP, exposureResetRequired ? 0.0 : EYE_ADAPTATION_SPEED_DOWN,
                    exposureResetRequired ? RESET_MIN_ADAPTED_LUMINANCE : MIN_ADAPTED_LUMINANCE, MAX_ADAPTED_LUMINANCE, EXPOSURE_BIAS);
                commandList.copyTextureRegion(targets.colorspaceCorrectionColor, 0, 0, 0, targets.ldrColor, 0, 0, 0,
                    targets.displayWidth, targets.displayHeight);
                texToDisplay = targets.colorspaceCorrectionColor;
            }
            app.blitTextureToFramebuffer(commandList, targets.preUIFramebuffer, view, texToDisplay);

            // DeepDVC on the color before the UI, in place (after tone mapping, as the sample). Turned off, it
            // just isn't evaluated: its plugin has no explicit resource free (slFreeResources: "plugin does
            // not support explicit resource deallocation").
            if (ui.enableDeepDvc && this.deepDvcSupported) {
                Streamline_EvaluateDeepDvc(commandList.handle, targets.preUIColor, ui.deepDvcIntensity, ui.deepDvcSaturationBoost);
                this.deepDvcEvaluations++;
            }

            // Into the back buffer as it is (the UI draws over it after).
            frame.copyTextureToFrame(targets.preUIColor);

            temporalAntiAliasingPass.advanceFrame();
            this.view = viewPrevious;
            this.viewPrevious = view;
            app.setVsyncEnabled(ui.enableVsync);
        }

        // --- Pass callbacks ---

        onKeyboard(key: Key, scancode: ScanCode, action: Action, mods: KeyMods) {
            if (key == Key.Space && action == Action.Press) {
                this.ui.enableAnimations = !this.ui.enableAnimations;
            }
            this.camera.keyboardUpdate(key, scancode, action, mods);
            return 1;
        }

        onMousePos(x: number, y: number) {
            this.camera.mousePosUpdate(x, y);
            return 1;
        }

        onMouseButton(button: MouseButton, action: Action, mods: KeyMods) {
            this.camera.mouseButtonUpdate(button, action, mods);
            return 1;
        }

        onMouseScroll(xOffset: number, yOffset: number) {
            this.camera.mouseScrollUpdate(xOffset, yOffset);
            return 1;
        }

        // The sample's Animate: the camera, the eye adaptation's time, the scene's animations at the
        // wall-clock time (in float, as the sample keeps it).
        onAnimate(elapsedSeconds: number) {
            this.camera.animate(elapsedSeconds);
            const toneMappingPass = this.toneMappingPass;
            if (!toneMappingPass.isNull()) {
                toneMappingPass.advanceFrame(elapsedSeconds);
            }
            if (this.ui.enableAnimations) {
                this.wallclockTime = Math.fround(this.wallclockTime + Math.fround(Math.fround(elapsedSeconds) * Math.fround(this.ui.animationSpeed)));
                const animationCount = this.scene.getAnimationCount();
                for (let i = 0; i < animationCount; i++) {
                    const duration = Math.fround(this.scene.getAnimationDuration(i));
                    const cycles = Math.fround(this.wallclockTime / duration);
                    const animationTime = Math.fround(Math.fround(cycles - Math.floor(cycles)) * duration);
                    this.scene.applyAnimation(i, animationTime);
                }
            }
        }

        onRender(frameHandle: FrameHandle) {
            this.renderScene(new Frame(frameHandle));
        }
    }

    // math::perspProjD3DStyleReverse(verticalFOV, aspect, zNear) into 16 floats: reverse-Z, infinite far
    // plane; row-major, row-vector convention; in float32 as Donut's.
    function perspProjD3DStyleReverse(dst: f32[], verticalFOV: number, aspect: number, zNear: number) {
        const yScale = Math.fround(1.0 / Math.fround(Math.tan(Math.fround(0.5 * Math.fround(verticalFOV)))));
        const xScale = Math.fround(yScale / Math.fround(aspect));
        for (let i = 0; i < 16; i++) {
            dst[i] = 0.0;
        }
        dst[0] = xScale;
        dst[5] = yScale;
        dst[11] = 1.0;
        dst[14] = zNear;
    }

    // --- UI ----------------------------------------------------------------------------------------------

    // The sample's settings this port has so far (its UIRenderer's rendering section).
    class UserInterface {
        private ui: UIData;
        private rayTracingSupported: boolean;

        constructor(ui: UIData, rayTracingSupported: boolean) {
            this.ui = ui;
            this.rayTracingSupported = rayTracingSupported;
        }

        init(app: App) {
            return !app.addImGuiPass(this.buildUI).isNull();
        }

        buildUI() {
            const ui = this.ui;
            ImGui.setNextWindowPos(10.0, 10.0);
            ImGui.begin("Settings", true);
            ui.enableVsync = ImGui.checkbox("VSync", ui.enableVsync);
            ui.enableAnimations = ImGui.checkbox("Animations", ui.enableAnimations);
            if (this.rayTracingSupported) {
                ui.rayTracingMode = ImGui.checkbox("Ray Traced Lighting", ui.rayTracingMode != 0) ? 1 : 0;
            }
            ui.antiAliasingMode = ImGui.combo("AA Mode", ui.antiAliasingMode, "None|TAA|DLSS");
            if (ui.antiAliasingMode == AntiAliasingMode.DLSS) {
                // DLSS turned on starts Balanced, as the sample's; UltraQuality isn't offered.
                if (ui.dlssMode == DlssMode.Off) {
                    ui.dlssMode = DlssMode.Balanced;
                }
                const index = ui.dlssMode == DlssMode.DLAA ? 5 : ui.dlssMode;
                const chosen = ImGui.combo("DLSS Mode", index, "Off|Max Performance|Balanced|Max Quality|Ultra Performance|DLAA");
                ui.dlssMode = chosen == 5 ? DlssMode.DLAA : chosen;
            }
            ui.enableDeepDvc = ImGui.checkbox("DeepDVC", ui.enableDeepDvc);
            if (ui.enableDeepDvc) {
                ui.deepDvcIntensity = ImGui.sliderFloat("DeepDVC Intensity", ui.deepDvcIntensity, 0.0, 1.0);
                ui.deepDvcSaturationBoost = ImGui.sliderFloat("DeepDVC Saturation Boost", ui.deepDvcSaturationBoost, 0.0, 1.0);
            }
            ImGui.separator();
            ui.enableShadows = ImGui.checkbox("Shadows", ui.enableShadows);
            ui.enableSsao = ImGui.checkbox("SSAO (deferred)", ui.enableSsao);
            ui.ambientIntensity = ImGui.sliderFloat("Ambient Intensity", ui.ambientIntensity, 0.0, 1.0);
            ui.enableProceduralSky = ImGui.checkbox("Procedural Sky", ui.enableProceduralSky);
            ui.enableBloom = ImGui.checkbox("Bloom", ui.enableBloom);
            ui.enableToneMapping = ImGui.checkbox("Tone Mapping", ui.enableToneMapping);
            ImGui.end();
        }
    }

    // --- Command line -----------------------------------------------------------------------------------

    class StreamlineDemoArgs extends Args {
        width: int = 1920;
        height: int = 1080;
        // -slDisable: without Streamline (no Streamline_Init): every feature reports unsupported.
        slDisable: boolean = false;
        // -latewarp: Latewarp instead of DLSS-G (not in Streamline 2.12.0: Streamline_Init fails).
        latewarp: boolean = false;
        // -slLog: Streamline's log in the console.
        slLog: boolean = false;
        // -noRT: deferred lighting (the sample's RayTracing_Mode 0) instead of ray traced.
        noRT: boolean = false;
        // -aa none|taa: the anti-aliasing mode (the sample's AAMode NONE or TEMPORAL).
        taa: boolean = false;
        // -pauseAnimation: the robot stands still (the sample's EnableAnimations off).
        pauseAnimation: boolean = false;
        // -dlss <mode>: DLSS-SR in the sample's -DLSS_mode numbering (DlssMode); -1: not given.
        dlss: int = -1;
        // -testDlssModeSwitch: under -test, DLSS switches to MaxPerformance at frame DLSS_SWITCH_FRAME.
        testDlssModeSwitch: boolean = false;
        // -reflex <0..2>: Reflex off, low latency, low latency with boost; -reflexFpsCap <n>: a frame rate
        // cap (0: none).
        reflex: int = 0;
        reflexFpsCap: int = 0;
        // -deepdvc: DeepDVC on (intensity 0.5, saturation boost 0.75).
        deepDvc: boolean = false;
        // -dlssRR <mode>: DLSS Ray Reconstruction in the sample's -DLSSRR_mode numbering (DlssMode); -1: not
        // given.
        dlssRR: int = -1;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-width" && i + 1 < this.argc) {
                    this.width = parseInt(this[i + 1]);
                } else if (arg == "-height" && i + 1 < this.argc) {
                    this.height = parseInt(this[i + 1]);
                } else if (arg == "-slDisable") {
                    this.slDisable = true;
                } else if (arg == "-latewarp") {
                    this.latewarp = true;
                } else if (arg == "-slLog") {
                    this.slLog = true;
                } else if (arg == "-noRT") {
                    this.noRT = true;
                } else if (arg == "-aa" && i + 1 < this.argc) {
                    this.taa = this[i + 1] == "taa";
                } else if (arg == "-pauseAnimation") {
                    this.pauseAnimation = true;
                } else if (arg == "-dlss" && i + 1 < this.argc) {
                    this.dlss = parseInt(this[i + 1]);
                } else if (arg == "-testDlssModeSwitch") {
                    this.testDlssModeSwitch = true;
                } else if (arg == "-reflex" && i + 1 < this.argc) {
                    this.reflex = parseInt(this[i + 1]);
                } else if (arg == "-reflexFpsCap" && i + 1 < this.argc) {
                    this.reflexFpsCap = parseInt(this[i + 1]);
                } else if (arg == "-deepdvc") {
                    this.deepDvc = true;
                } else if (arg == "-dlssRR" && i + 1 < this.argc) {
                    this.dlssRR = parseInt(this[i + 1]);
                }
            }
        }
    }

    // The features the demo reports, by name, and those -test needs (DLSS-G and PCL depend on the GPU
    // generation and on a swap chain, Latewarp isn't in 2.12.0: reported only).
    const FEATURE_NAMES = ["DLSS", "DLSS_RR", "DeepDVC", "Reflex", "PCL", "DLSS_G", "Latewarp"];
    const FEATURES = [StreamlineFeature.DLSS, StreamlineFeature.DLSS_RR, StreamlineFeature.DeepDVC,
        StreamlineFeature.Reflex, StreamlineFeature.PCL, StreamlineFeature.DLSS_G, StreamlineFeature.Latewarp];
    const REQUIRED_FEATURES = 4;

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Program.setAppName("streamline_demo");

        const args = new StreamlineDemoArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // Streamline before the device: its plugins from bin/streamline/ (next to the executable, or to
        // donut_interop_shared.dll under the JIT).
        let slInitialized = false;
        if (!args.slDisable) {
            slInitialized = Streamline_Init(args.api, "", args.latewarp ? 1 : 0, args.slLog ? 1 : 0) != 0;
            if (!slInitialized) {
                console.log("Streamline: not initialized (see the log above)");
            }
        }

        // RayTracing: Vulkan's ray tracing extensions. UnormBackBuffer: the sample's BGRA8_UNORM swap chain
        // (RGBA8 on D3D12), as the color before the UI is stored sRGB-encoded already.
        const app = App.createWithOptions(args.api, WINDOW_TITLE, args.width, args.height,
            args.options | AppOptions.Streamline | AppOptions.RayTracing | AppOptions.UnormBackBuffer);
        if (app.isNull()) {
            Streamline_Shutdown();
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        // One line a feature: "<name>: supported" or "<name>: <why not>".
        let missing = "";
        let supportedCount = 0;
        for (let i = 0; i < FEATURES.length; i++) {
            const supported = Streamline_IsFeatureSupported(app.handle, FEATURES[i]) != 0;
            const status = supported ? "supported" : Streamline_FeatureStatusText(FEATURES[i]);
            console.log(`${FEATURE_NAMES[i]}: ${status}`);
            if (supported) {
                supportedCount++;
            } else if (i < REQUIRED_FEATURES) {
                missing = missing == "" ? FEATURE_NAMES[i] : `${missing}, ${FEATURE_NAMES[i]}`;
            }
        }

        const uiData = new UIData();
        if (args.noRT) {
            uiData.rayTracingMode = 0;
        }
        if (args.taa) {
            uiData.antiAliasingMode = AntiAliasingMode.TEMPORAL;
        }
        if (args.pauseAnimation) {
            uiData.enableAnimations = false;
        }
        if (args.dlss == DlssMode.UltraQuality || args.dlss < -1 || args.dlss > DlssMode.DLAA) {
            console.log(`-dlss ${args.dlss}: not a DLSS mode (0..4, 6), ignored`);
        } else if (args.dlss > 0) {
            uiData.antiAliasingMode = AntiAliasingMode.DLSS;
            uiData.dlssMode = args.dlss;
        }
        if (args.dlssRR == DlssMode.UltraQuality || args.dlssRR < -1 || args.dlssRR > DlssMode.DLAA) {
            console.log(`-dlssRR ${args.dlssRR}: not a DLSS mode (0..4, 6), ignored`);
        } else if (args.dlssRR > 0) {
            // Ray Reconstruction replaces DLSS-SR (the sample turns DLSS's mode off under it): anti-aliasing none.
            if (uiData.antiAliasingMode == AntiAliasingMode.DLSS) {
                console.log("-dlssRR: DLSS-SR off (Ray Reconstruction upscales instead)");
                uiData.antiAliasingMode = AntiAliasingMode.NONE;
                uiData.dlssMode = DlssMode.Off;
            }
            uiData.dlssRRMode = args.dlssRR;
        }

        if (args.deepDvc) {
            uiData.enableDeepDvc = true;
        }

        const scenePath = args.scenePath != "" ? args.scenePath : DEFAULT_SCENE;
        const demo = new StreamlineDemo(app, uiData);
        demo.streamline = slInitialized;
        demo.dlssSupported = Streamline_IsFeatureSupported(app.handle, StreamlineFeature.DLSS) != 0;
        demo.dlssRRSupported = Streamline_IsFeatureSupported(app.handle, StreamlineFeature.DLSS_RR) != 0;
        if (uiData.dlssRRMode != DlssMode.Off && !demo.dlssRRSupported) {
            console.log("DLSS-RR: not supported here, off");
        }
        demo.deepDvcSupported = Streamline_IsFeatureSupported(app.handle, StreamlineFeature.DeepDVC) != 0;
        if (uiData.enableDeepDvc && !demo.deepDvcSupported) {
            console.log("DeepDVC: not supported here, off");
        }
        demo.testDlssModeSwitch = args.test && args.testDlssModeSwitch;
        if (uiData.antiAliasingMode == AntiAliasingMode.DLSS && !demo.dlssSupported) {
            console.log("DLSS: not supported here, anti-aliasing off");
        }
        // Reflex's options (its sleep runs every frame, Reflex supported).
        if (Streamline_IsFeatureSupported(app.handle, StreamlineFeature.Reflex) != 0) {
            Streamline_SetReflex(args.reflex, args.reflexFpsCap);
        }
        if (!demo.init(scenePath, args.api)) {
            Streamline_Shutdown();
            app.destroy();
            return 1;
        }

        // Not under -test: the sample's reference frames are the color before the UI.
        const gui = new UserInterface(uiData, app.isFeatureSupported(Feature.RayTracingPipeline));
        if (!args.noUI && !args.test && !gui.init(app)) {
            console.log("Cannot initialize the user interface");
        }
        const input = new InputPass(app.handle);
        app.run();

        // Reflex's latency once, at the end (none without a presented frame, e.g. under -test).
        const latency = Streamline_ReflexLatencyMs();
        console.log(latency >= 0.0 ? `Reflex latency: ${latency} ms` : "Reflex latency: no report");

        let result = 0;
        if (args.test) {
            const frameFailure = checkFrame(app, uiData.rayTracingMode != 0,
                uiData.antiAliasingMode == AntiAliasingMode.DLSS || uiData.dlssRRMode != DlssMode.Off, uiData.enableDeepDvc);
            if (frameFailure != "") {
                result = app.finishTest(frameFailure);
            } else if (!args.slDisable && !slInitialized) {
                // Streamline starts on any GPU (its features may not be supported): failing to is an error, but
                // Latewarp's, which this SDK hasn't.
                result = args.latewarp ? unsupported(true, "Latewarp: not in Streamline 2.12.0")
                    : app.finishTest("Streamline_Init failed");
            } else if (!slInitialized) {
                // Without Streamline nothing may report supported.
                result = supportedCount == 0 ? unsupported(true, "Streamline is not initialized")
                    : app.finishTest(`${supportedCount} features report supported without Streamline`);
            } else if (missing != "") {
                result = unsupported(true, `not supported here: ${missing}`);
            } else {
                const dlssFailure = checkDlss(demo, uiData, args.testDlssModeSwitch);
                const rrFailure = dlssFailure != "" ? dlssFailure : checkDlssRR(demo, uiData);
                result = app.finishTest(rrFailure != "" ? rrFailure : checkDeepDvc(demo, uiData));
            }
        }

        // Streamline goes before the device it hooks.
        Streamline_Shutdown();
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return StreamlineDemo.main(argc, argv);
}

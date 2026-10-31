// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";
import { RtxptRenderer } from "../core/rtxpt_renderer";
import { RtxptGame, GameWorld } from "../core/rtxpt_game";

// Port of NVIDIA's RTX Path Tracing sample (github.com/NVIDIA-RTX/RTXPT): its reference path tracer and its
// real-time mode with the standalone denoiser (NRD's ReBLUR or ReLAX) and TAA. The
// sample is under the NVIDIA RTX SDKs License: build with RTXPT_DIR set to a checkout (CMakeLists.txt) and
// run with --scene <RTXPT_DIR>/Assets/kitchen.scene.json. This software contains source code provided by
// NVIDIA Corporation.
//
// This file is the sample's host (Sample.cpp, AdvancedSample.cpp): its settings (SampleUIData, the
// "Balanced" performance preset), the camera, the path tracer's shader macros, the accumulation and when
// to rebuild what. core/rtxpt.cpp holds the sample's renderer library (compiled from the checkout) and
// does the steps: the scene, materials, NEE-AT lights and environment map, the acceleration structures, the
// path tracing passes (compiled at run time per material), accumulation or the denoiser and TAA, bloom and
// tone mapping. Of the real-time mode, ReSTIR, SHaRC and sub-sampling are not ported. Its AA is the sample's
// default DLSS-RR (ray reconstruction: DLSS denoising as it upscales), DLSS, TAA or none; DLSS and DLSS-RR (with
// DONUT_WITH_DLSS; the sample's run through Streamline, these over NGX) render at the DLSS mode's size and upscale
// to the window's. DLSS 5 (DLSS 3D-Guided Neural Rendering, DONUT_WITH_DLSS_NR, not in the sample) enhances the
// tone-mapped image in either mode, as in examples/rtxcr_pathtracer.ts.
namespace Rtxpt {
    const WINDOW_TITLE = "RTX Path Tracing";

    // SampleUIData's DLSSRRMicroJitter: DLSS-RR's per-pixel jitter of the rays, and DLRRPreset (preset F, the
    // transformer model; NVSDK_NGX_RayReconstruction_Hint_Render_Preset_F).
    const DLSS_RR_MICRO_JITTER = 0.01;
    const DLSS_RR_PRESET = 6;

    // Test mode: the frames rendered (and accumulated, after the warm-up). The scene loads on a thread, slower under
    // a parallel ctest: the test renders splash screens until then, up to TEST_LOADING_FRAMES_MAX more frames, each
    // waiting TEST_LOADING_WAIT_MS for the thread (as feature_demo's).
    const TEST_FRAMES = 64;
    const TEST_LOADING_FRAMES_MAX = 20000;
    const TEST_LOADING_WAIT_MS = 1;

    // The start in frames, each step after a splash screen naming it (the sample's progress bars): "Initializing..."
    // while the renderer is made; Donut's asynchronous scene loading (feature_demo's), the scene file loading on a
    // thread with its progress shown; then "Initializing renderer..." while the next frame's animate sets the renderer
    // up for the scene (the materials' textures, acceleration structures, passes and shaders).
    enum LoadingState {
        Starting = 0,
        Loading = 1,
        Initializing = 2,
        Ready = 3
    }

    // RtxptFrameSettings (core/rtxpt.cpp), as byte offsets; all fields 4 bytes.
    const FRAME_SETTINGS_SIZE = 280;
    const FS_CAMERA_POS = 0;
    const FS_FOV_Y = 12;
    const FS_CAMERA_DIR = 16;
    const FS_Z_NEAR = 28;
    const FS_CAMERA_UP = 32;
    const FS_FOCAL_DISTANCE = 44;
    const FS_APERTURE_RADIUS = 48;
    const FS_FRAME_INDEX = 52;
    const FS_SAMPLE_INDEX = 56;
    const FS_RESET_ACCUMULATION = 60;
    const FS_BOUNCE_COUNT = 64;
    const FS_DIFFUSE_BOUNCE_COUNT = 68;
    const FS_ENV_MAP_DIFFUSE_MIP_LEVEL = 72;
    const FS_TEX_LOD_BIAS = 76;
    const FS_PER_PIXEL_JITTER_AA_SCALE = 80;
    const FS_FIREFLY_FILTER_ENABLED = 84;
    const FS_FIREFLY_FILTER_THRESHOLD = 88;
    const FS_ENABLE_TONE_MAPPING = 92;
    const FS_NEE_ENABLED = 96;
    const FS_NEE_TYPE = 100;
    const FS_NEE_CANDIDATE_SAMPLES = 104;
    const FS_NEE_FULL_SAMPLES = 108;
    const FS_NEEAT_GLOBAL_TEMPORAL_FEEDBACK_WEIGHT = 112;
    const FS_NEEAT_LOCAL_TO_GLOBAL_SAMPLE_RATIO = 116;
    const FS_NEEAT_DISTANT_VS_LOCAL_IMPORTANCE = 120;
    const FS_USE_APPROXIMATE_MIS = 124;
    const FS_ENV_MAP_ENABLED = 128;
    const FS_ENV_MAP_INTENSITY = 132;
    const FS_ENV_MAP_TINT = 136;
    const FS_ENV_MAP_ROTATION = 148;
    const FS_TONE_MAP_OPERATOR = 160;
    const FS_AUTO_EXPOSURE = 164;
    const FS_EXPOSURE_COMPENSATION = 168;
    const FS_EXPOSURE_VALUE = 172;
    const FS_EXPOSURE_VALUE_MIN = 176;
    const FS_EXPOSURE_VALUE_MAX = 180;
    const FS_ENABLE_BLOOM = 184;
    const FS_BLOOM_RADIUS = 188;
    const FS_BLOOM_INTENSITY = 192;
    const FS_ACTIVE_DENOISING_LAYER_COUNT = 196;
    const FS_DENOISING_LAYERS_MAX_VERTEX_DEPTH = 200;
    const FS_ALLOW_PRIMARY_SURFACE_REPLACEMENT = 204;
    const FS_DENOISING_LAYERS_SPLIT_STOP_THRESHOLD = 208;
    const FS_DENOISING_LAYERS_SUPPRESS_PRIMARY_INDIRECT_SPECULAR_K = 212;
    const FS_DENOISING_LAYERS_ANTI_ALIASING_FALLTHROUGH = 216;
    const FS_DENOISER_RADIANCE_CLAMP_K = 220;
    const FS_REALTIME_MODE = 224;
    const FS_REALTIME_AA = 228;
    const FS_STANDALONE_DENOISER = 232;
    const FS_NRD_METHOD = 236;
    const FS_RESET_REALTIME_CACHES = 240;
    const FS_ENABLE_ANIMATIONS = 244;
    const FS_TAA_JITTER = 248;
    const FS_TAA_NEW_FRAME_WEIGHT = 252;
    const FS_TAA_ENABLE_HISTORY_CLAMPING = 256;
    const FS_TAA_USE_HISTORY_CLAMP_RELAX = 260;
    const FS_NRD_DISOCCLUSION_THRESHOLD = 264;
    const FS_NRD_DISOCCLUSION_THRESHOLD_ALTERNATE = 268;
    const FS_NRD_USE_ALTERNATE_DISOCCLUSION_THRESHOLD_MIX = 272;
    const FS_SAMPLES_PER_PIXEL = 276;

    // The sample's ToneMapperOperator (ToneMapper/ToneMapping_cb.h).
    enum ToneMapperOperator {
        Linear = 0,
        Reinhard = 1,
        ReinhardModified = 2,
        HejiHableAlu = 3,
        HableUc2 = 4,
        Aces = 5
    }

    // TONEMAPPING_EXPOSURE_LOG2_MIN / _MAX (ToneMapper/ToneMapping_cb.h).
    const EXPOSURE_LOG2_MIN = -6.0;
    const EXPOSURE_LOG2_MAX = 6.0;

    // cDenoisingLayerMaxVertexIndex (Shaders/PathTracer/Config.h) is 15: SampleUIData's default depth is min(9, it).
    const DENOISING_LAYERS_MAX_VERTEX_DEPTH = 9;

    // Donut's TemporalAntiAliasingJitter.
    enum TemporalAntiAliasingJitter {
        Msaa = 0,
        Halton = 1,
        R2 = 2,
        WhiteNoise = 3
    }

    // The accumulation's warm-up (Sample::PreUpdatePathTracing with AccumulationPreWarmRealtimeCaches): the
    // first frames after a reset feed NEE-AT's feedback without accumulating.
    const ACCUMULATION_WARM_UP_FRAMES = 32;

    // The keys of RtxptRenderer.getSceneSetting.
    enum SceneSetting {
        RealtimeMode = 0,
        EnableAnimations = 1,
        StartingCamera = 2,
        RealtimeFireflyFilter = 3,
        MaxBounces = 4,
        MaxDiffuseBounces = 5,
        TextureMipBias = 6,
        EnvironmentLightIntensity = 7
    }

    function isNaN32(x: number): boolean {
        return x != x;
    }

    // A struct written as 4-byte fields at byte offsets, for core/rtxpt.cpp to read.
    class ConstantBlock {
        data: f32[] = [];
        byteSize: int;

        constructor(byteSize: int) {
            this.byteSize = byteSize;
            for (let i = 0; i < byteSize / 4; i++) {
                this.data.push(0.0);
            }
        }

        setFloat(offset: int, value: number) {
            this.data[offset / 4] = value;
        }

        setInt(offset: int, value: int) {
            RawMemory.storeInt32(Ref(this.data[offset / 4]), value);
        }

        setBool(offset: int, value: boolean) {
            RawMemory.storeInt32(Ref(this.data[offset / 4]), value ? 1 : 0);
        }

        setFloat3(offset: int, x: number, y: number, z: number) {
            this.data[offset / 4] = x;
            this.data[offset / 4 + 1] = y;
            this.data[offset / 4 + 2] = z;
        }
    }

    // SampleUIData: the fields the path tracer reads, with their defaults (SampleUI.h, CommandLine.h and SampleUI's
    // constructor).
    class Settings {
        // The scene's, unless -overrideToRealtimeMode or -overrideToReferenceMode.
        realtimeMode = false;
        overrideToRealtimeMode = false;
        overrideToReferenceMode = false;
        overrideAutoexposureOff = false;
        stopAnimations = false;
        disableFireflyFilters = false;
        disablePostProcessFilters = false;
        // SampleGame: --propShowTags (props tagged with one of these show) and --propCameraAttach (the prop the
        // camera attaches to after loading).
        propShowTags = "";
        propCameraAttach = "";
        // >= 0: NEEMISType instead of the preset's.
        neeMISTypeOverride: int = -1;

        // Reference mode.
        accumulationTarget: int = 4096;
        // CaptureScriptManager's warm-up: the frames from captureStart that restart the accumulation.
        captureStart: int = 0;
        captureWarmupFrames: int = 0;
        // The scene's (and game's) time the warm-up starts at.
        captureStartTime = 0.0;
        // >= 0: overrides the scene's environment map intensity.
        environmentMapIntensityOverride = -1.0;
        accumulationPreWarm = true;
        accumulationAA = true;
        resetAccumulation = false;
        enableAnimations = false;

        bounceCount: int = 20;
        diffuseBounceCount: int = 2;
        texLODBias = -1.0;
        nestedDielectricsQuality: int = 1;
        environmentMapDiffuseSampleMipLevel: int = 2;
        enableRussianRoulette = true;
        enableLDSamplerForBSDF = true;
        useFp16Types = false;
        referenceFireflyFilterEnabled = true;
        referenceFireflyFilterThreshold = 2.5;
        denoiserRadianceClampK = 8.0;

        // Real-time mode: realtimeAA 0 none, 1 TAA, 2 DLSS, 3 DLSS-RR (the sample's; DLSS-RR falls back to DLSS, DLSS
        // to TAA where not available). dlssMode: the sample's (Streamline's DLSSMode) for both, the render size:
        // 1 performance, 2 balanced (the sample's default), 3 quality (3/4 of the size here), 4 ultra performance,
        // 5 ultra quality, 6 DLAA (the full size).
        realtimeAA: int = 3;
        dlssMode: int = 2;
        realtimeSamplesPerPixel: int = 1;
        realtimeFireflyFilterEnabled = true;
        realtimeFireflyFilterThreshold = 0.1;
        standaloneDenoiser = true;
        // NrdConfig::DenoiserMethod: 0 ReBLUR, 1 ReLAX.
        nrdMethod: int = 0;
        nrdDisocclusionThreshold = 0.03;
        nrdUseAlternateDisocclusionThresholdMix = true;
        nrdDisocclusionThresholdAlternate = 0.2;
        taaJitter: int = TemporalAntiAliasingJitter.Halton;
        taaNewFrameWeight = 0.1;
        taaEnableHistoryClamping = true;
        taaUseHistoryClampRelax = true;
        // DLSS 5 (DLSS-NR) over the tone-mapped image, with RTX Remix's defaults (as examples/rtxcr_pathtracer.ts).
        enableDlssNeuralRendering = false;
        dlssNeuralRenderingModel: int = 0;
        dlssNeuralRenderingIntensity = 1.0;
        dlssNeuralRenderingStructureStrength = 0.7;
        dlssNeuralRenderingToneStrength = 0.3;
        dlssNeuralRenderingUseAutoMask = true;
        dlssNeuralRenderingSkinStrength = 0.5;
        // Set once DLSS, DLSS-RR and DLSS-NR initialize (built with DONUT_WITH_DLSS(_NR), on an RTX GPU).
        dlssAvailable = false;
        dlssRayReconstructionAvailable = false;
        dlssNeuralRenderingAvailable = false;
        // Sample's ResetRealtimeCaches: the denoiser's history and NEE-AT's feedback start again.
        resetRealtimeCaches = false;

        useNEE = true;
        neeType: int = 2;
        neeCandidateSamples: int = 5;
        neeFullSamples: int = 1;
        neeMISType: int = 1;
        neeatGlobalTemporalFeedbackWeight = 0.75;
        neeatLocalToGlobalSampleRatio = 0.65;
        neeatDistantVsLocalImportance = 1.0;
        neeatQualityPreset: int = 0;

        // Shader execution reordering: DXR 1.2's on D3D12 (the Agility SDK's SM 6.9), none on Vulkan.
        dxHitObjectExtension = false;
        dxMaybeReorderThreads = true;

        denoisingLayersActiveCount: int = 4;
        denoisingLayersMaxVertexDepth: int = DENOISING_LAYERS_MAX_VERTEX_DEPTH;
        allowPrimarySurfaceReplacement = true;
        denoisingLayersSplitStopThreshold = 0.95;
        denoisingLayersSuppressPrimaryIndirectSpecular = true;
        denoisingLayersSuppressPrimaryIndirectSpecularK = 0.6;
        denoisingLayersAntiAliasingFallthrough = 0.6;

        cameraAperture = 0.0;
        cameraFocalDistance = 10000.0;
        cameraMoveSpeed = 1.0;

        environmentMapEnabled = true;
        environmentMapIntensity = 1.0;
        environmentMapTintR = 1.0;
        environmentMapTintG = 1.0;
        environmentMapTintB = 1.0;
        environmentMapRotationX = 0.0;
        environmentMapRotationY = 0.0;
        environmentMapRotationZ = 0.0;

        enableToneMapping = true;
        toneMapOperator: int = ToneMapperOperator.HableUc2;
        autoExposure = false;
        exposureCompensation = 0.0;
        exposureValue = 0.0;
        exposureValueMin = EXPOSURE_LOG2_MIN;
        exposureValueMax = EXPOSURE_LOG2_MAX;

        enableBloom = true;
        bloomRadius = 8.0;
        bloomIntensity = 0.004;

        // ApplyPerformancePreset(ui, 2) (SampleUI.cpp's "Balanced" row), which SceneLoaded applies after the scene's
        // settings: the fields of it the path tracer reads (its sub-sampling isn't ported).
        applyBalancedPreset() {
            this.realtimeSamplesPerPixel = 1;
            this.realtimeFireflyFilterThreshold = 0.1;
            this.neeCandidateSamples = 5;
            this.neeFullSamples = 1;
            this.neeMISType = 1;
            this.bounceCount = 14;
            this.diffuseBounceCount = 2;
            this.texLODBias = -1.0;
            this.nestedDielectricsQuality = 1;
            this.environmentMapDiffuseSampleMipLevel = 2;
            this.denoisingLayersActiveCount = 3;
            this.allowPrimarySurfaceReplacement = true;
            this.enableBloom = true;
            this.enableLDSamplerForBSDF = true;
            this.resetAccumulation = true;
        }

        // SampleUIData::ActualFireflyFilterEnabled, and its threshold.
        actualFireflyFilterEnabled(): boolean {
            return this.realtimeMode ? this.realtimeFireflyFilterEnabled : this.referenceFireflyFilterEnabled;
        }

        actualFireflyFilterThreshold(): number {
            return this.realtimeMode ? this.realtimeFireflyFilterThreshold : this.referenceFireflyFilterThreshold;
        }

        // SampleUIData::ActualUseApproximateMIS.
        actualUseApproximateMIS(): boolean {
            return this.realtimeMode ? this.neeMISType != 0 : this.neeMISType == 2;
        }

        // SampleUIData::ActualSamplesPerPixel (without ReSTIR).
        actualSamplesPerPixel(): int {
            return this.realtimeMode ? this.realtimeSamplesPerPixel : 1;
        }

        // SampleUIData::ActualUseStandaloneDenoiser: not under DLSS-RR, which denoises itself.
        actualUseStandaloneDenoiser(): boolean {
            return this.realtimeMode && this.realtimeAA < 3 && this.standaloneDenoiser;
        }

        // DLSS or DLSS-RR, which render at the DLSS mode's size.
        actualUseDlss(): boolean {
            return this.realtimeMode && (this.realtimeAA == 2 || this.realtimeAA == 3);
        }

        // SampleUIData::ActualNEEAT_LocalToGlobalSampleRatio: no local samples without NEE-AT.
        actualLocalToGlobalSampleRatio(): number {
            return this.neeType == 2 ? this.neeatLocalToGlobalSampleRatio : 0.0;
        }
    }

    class Renderer {
        private rtxpt: RtxptRenderer;
        private camera: Camera;
        // SampleGame (core/rtxpt_game.ts), with a camera of its own.
        game: RtxptGame;
        private frameSettings: ConstantBlock;
        private cameraValues: f32[] = [];
        private lastCamera: number[] = [];

        private width: int;
        private height: int;
        private preparedWidth: int = 0;
        private preparedHeight: int = 0;
        private needNewPasses = true;
        private rebuildAccelStructs = true;
        private shaderMacrosKey = "";

        // Sample's m_frameIndex, m_accumulationSampleIndex, m_sampleIndex.
        private frameIndex: int = 0;
        private accumulationSampleIndex: int = 0;
        private sampleIndex: int = 0;
        // 0: the free camera; n: the scene's camera n - 1, every frame.
        private selectedCameraIndex: int = 0;
        private sceneTime = 0.0;
        private cameraVerticalFov = 1.0471975511965976;
        private cameraZNear = 0.001;

        // DLSS and DLSS-RR (the real-time mode's realtimeAA 2 and 3, run by core/rtxpt.cpp) and DLSS-NR (null handles
        // without support), the window size they're set up for, and whether DLSS-NR ran last frame (else it starts
        // without history). The frames' size (the DLSS mode's with DLSS or DLSS-RR, else the window's), and the DLSS
        // mode's size for the window (optimalKey: the window size and mode it is for).
        private dlss: Dlss;
        private dlssRayReconstruction: DlssRayReconstruction;
        private dlssNeuralRendering: DlssNeuralRendering;
        private dlssWidth: int = 0;
        private dlssHeight: int = 0;
        private dlssNeuralRenderingActive = false;
        private renderWidth: int = 0;
        private renderHeight: int = 0;
        private optimalKey = "";
        private optimalWidth: int = 0;
        private optimalHeight: int = 0;

        private loadingState = LoadingState.Starting;
        // The splash screens shown so far (the renderer is made after the first).
        private splashFrames: int = 0;
        loadingFailed = false;
        private loadingStats: int[] = [0, 0, 0, 0];
        // -test's frames (0 without -test): the window closes once they have rendered, the loading's frames aside.
        testFrames: int = 0;

        constructor(private app: App, private settings: Settings, private scenePath: string, private assetsPath: string,
            width: int, height: int) {
            this.rtxpt = new RtxptRenderer(null);
            this.camera = new Camera(null);
            this.game = new RtxptGame(this.camera);
            this.dlss = new Dlss(null);
            this.dlssRayReconstruction = new DlssRayReconstruction(null);
            this.dlssNeuralRendering = new DlssNeuralRendering(null);
            this.frameSettings = new ConstantBlock(FRAME_SETTINGS_SIZE);
            for (let i = 0; i < 16; i++) {
                this.cameraValues.push(0.0);
            }
            for (let i = 0; i < 9; i++) {
                this.lastCamera.push(0.0);
            }
            this.width = width;
            this.height = height;
        }

        init(): boolean {
            this.camera = this.app.createFirstPersonCamera();
            this.camera.setRotateSpeed(0.003);
            this.game = new RtxptGame(this.app.createFirstPersonCamera());

            // DLSS-RR and DLSS-NR share the NGX instance of DLSS; all are set up for the sizes in onAnimate.
            this.dlss = this.app.createDlss();
            this.dlssRayReconstruction = this.app.createDlssRayReconstruction(this.dlss);
            this.dlssNeuralRendering = this.app.createDlssNeuralRendering(this.dlss);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setMouseScrollCallback(this.onMouseScroll);
            pass.setAnimateCallback(this.onAnimate);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        // Once a frame has shown "Initializing...": the renderer (it loads its shaders), then the scene file's loading.
        private start(): boolean {
            this.rtxpt = RtxptRenderer.create(this.app.getNvrhiDevice(), this.assetsPath);
            if (this.rtxpt.isNull()) {
                console.log("Cannot create the renderer");
                return false;
            }
            this.rtxpt.setDlss(this.dlss.isNull() ? null : this.dlss.handle);
            this.rtxpt.setDlssRayReconstruction(this.dlssRayReconstruction.isNull() ? null : this.dlssRayReconstruction.handle);
            this.rtxpt.beginLoadingScene(this.scenePath);
            return true;
        }

        // Once the scene file has loaded: Sample::SceneLoaded, which starts with the game's step.
        private finishLoading(): boolean {
            // The game edits the scene's Donut graph; RTXPT's renderer reads a negative spot outer angle as its
            // minimum falloff, as SampleGame sets it.
            const world = new GameWorld(this.app.handle, this.rtxpt.getScene(), this.rtxpt.hasGameSettings(), true);
            this.game.sceneLoaded(world, this.scenePath, this.assetsPath, this.settings.propShowTags, this.settings.propCameraAttach);
            if (!this.rtxpt.finishLoadingScene()) {
                return false;
            }
            this.sceneLoaded();
            return true;
        }

        isReady(): boolean {
            return this.loadingState == LoadingState.Ready;
        }

        // The splash screen's text until the renderer is ready (feature_demo's, then the sample's second progress bar).
        getLoadingText(): string {
            if (this.loadingState == LoadingState.Starting) {
                return "Initializing...";
            }
            if (this.loadingState == LoadingState.Initializing) {
                return "Initializing renderer...";
            }
            this.rtxpt.getSceneLoadingStats(Ref(this.loadingStats[0]));
            const stats = this.loadingStats;
            return `Loading scene ${this.scenePath}, please wait...\nObjects: ${stats[0]}/${stats[1]}, Textures: ${stats[2]}/${stats[3]}`;
        }

        shutdown() {
            this.app.waitForIdle();
            if (!this.rtxpt.isNull()) {
                this.rtxpt.destroy();
            }
        }

        // Sample::SceneLoaded's settings: the scene camera and exposure, the environment light, the scene's sample
        // settings, then the "Balanced" preset.
        private sceneLoaded() {
            const s = this.settings;
            this.frameIndex = 0;
            s.exposureCompensation = 2.0;
            s.exposureValue = 0.0;

            s.environmentMapEnabled = true;
            s.environmentMapIntensity = 1.0;
            s.environmentMapTintR = 1.0;
            s.environmentMapTintG = 1.0;
            s.environmentMapTintB = 1.0;
            s.environmentMapRotationX = 0.0;
            s.environmentMapRotationY = 0.0;
            s.environmentMapRotationZ = 0.0;
            const envIntensity = this.rtxpt.getSceneSetting(SceneSetting.EnvironmentLightIntensity);
            if (!isNaN32(envIntensity)) {
                s.environmentMapIntensity = envIntensity;
            }
            if (s.environmentMapIntensityOverride >= 0.0) {
                s.environmentMapIntensity = s.environmentMapIntensityOverride;
            }

            // The camera: the scene's last, or the sample's default.
            const cameraCount = this.rtxpt.getSceneCameraCount();
            if (cameraCount == 0) {
                this.camera.lookAtWithUp(0.0, 1.8, 0.0, 1.0, 1.55, 0.0, 0.0, 1.0, 0.0);
                this.cameraVerticalFov = 1.0471975511965976;
                this.cameraZNear = 0.001;
            } else {
                this.updateCameraFromScene(cameraCount - 1);
            }

            this.rebuildAccelStructs = true;
            this.needNewPasses = true;
            s.enableAnimations = false;
            s.realtimeMode = false;
            this.selectedCameraIndex = 0;

            const realtimeMode = this.rtxpt.getSceneSetting(SceneSetting.RealtimeMode);
            if (!isNaN32(realtimeMode)) {
                s.realtimeMode = realtimeMode != 0.0;
            }
            const animations = this.rtxpt.getSceneSetting(SceneSetting.EnableAnimations);
            if (!isNaN32(animations)) {
                s.enableAnimations = animations != 0.0;
            }
            const startingCamera = this.rtxpt.getSceneSetting(SceneSetting.StartingCamera);
            if (!isNaN32(startingCamera)) {
                this.selectedCameraIndex = <int>startingCamera + 1;
            }
            const realtimeFireflyFilter = this.rtxpt.getSceneSetting(SceneSetting.RealtimeFireflyFilter);
            if (!isNaN32(realtimeFireflyFilter)) {
                s.realtimeFireflyFilterThreshold = realtimeFireflyFilter;
                s.realtimeFireflyFilterEnabled = true;
            }
            const maxBounces = this.rtxpt.getSceneSetting(SceneSetting.MaxBounces);
            if (!isNaN32(maxBounces)) {
                s.bounceCount = <int>maxBounces;
            }
            const maxDiffuseBounces = this.rtxpt.getSceneSetting(SceneSetting.MaxDiffuseBounces);
            if (!isNaN32(maxDiffuseBounces)) {
                s.diffuseBounceCount = <int>maxDiffuseBounces;
            }
            const mipBias = this.rtxpt.getSceneSetting(SceneSetting.TextureMipBias);
            if (!isNaN32(mipBias)) {
                s.texLODBias = mipBias;
            }
            if (s.stopAnimations) {
                s.enableAnimations = false;
            }

            // The command line's overrides.
            if (s.overrideToRealtimeMode) {
                s.realtimeMode = true;
            }
            if (s.overrideToReferenceMode) {
                s.realtimeMode = false;
            }
            if (s.overrideAutoexposureOff) {
                s.autoExposure = false;
                s.exposureValue = 0.0;
            }
            if (s.disableFireflyFilters) {
                s.realtimeFireflyFilterEnabled = false;
                s.referenceFireflyFilterEnabled = false;
            }

            s.applyBalancedPreset();
            if (s.neeMISTypeOverride >= 0) {
                s.neeMISType = s.neeMISTypeOverride;
            }
            if (s.disablePostProcessFilters) {
                s.enableBloom = false;
            }
            s.resetAccumulation = true;
        }

        // Sample::UpdateCameraFromScene: the free camera takes the scene camera's place and settings.
        private updateCameraFromScene(index: int) {
            const v = this.cameraValues;
            if (!this.rtxpt.getSceneCamera(index, Ref(v[0]))) {
                return;
            }
            this.camera.lookAtWithUp(v[0], v[1], v[2], v[0] + v[3], v[1] + v[4], v[2] + v[5], v[6], v[7], v[8]);
            this.cameraVerticalFov = v[9];
            this.cameraZNear = v[10];
            // Only a camera with exposure settings (PerspectiveCameraEx, e.g. not a glTF model's) sets the exposure.
            if (isNaN32(v[11])) {
                return;
            }
            const s = this.settings;
            s.autoExposure = v[11] != 0.0;
            s.exposureCompensation = v[12];
            s.exposureValue = v[13];
            s.exposureValueMin = v[14];
            s.exposureValueMax = v[15];
        }

        // The camera's input, the game camera's while it is attached to a prop.
        onKey(key: Key, scancode: ScanCode, action: Action, mods: KeyMods) {
            if (this.game.cameraActive()) {
                this.game.gameCamera.keyboardUpdate(key, scancode, action, mods);
            } else {
                this.camera.keyboardUpdate(key, scancode, action, mods);
            }
            return 1;
        }

        onMousePos(x: number, y: number) {
            if (this.game.cameraActive()) {
                this.game.gameCamera.mousePosUpdate(x, y);
            } else {
                this.camera.mousePosUpdate(x, y);
            }
            return 1;
        }

        onMouseButton(button: MouseButton, action: Action, mods: KeyMods) {
            if (this.game.cameraActive()) {
                this.game.gameCamera.mouseButtonUpdate(button, action, mods);
            } else {
                this.camera.mouseButtonUpdate(button, action, mods);
            }
            return 1;
        }

        onMouseScroll(xOffset: number, yOffset: number) {
            if (!this.game.cameraActive()) {
                this.camera.mouseScrollUpdate(xOffset, yOffset);
            }
            return 1;
        }

        // Sample::GetPTPipelineGlobalMacros (the lights baker adds its own in core/rtxpt.cpp).
        private updateShaderMacros() {
            const s = this.settings;
            const names: string[] = [];
            const values: string[] = [];
            const add = (name: string, value: string) => {
                names.push(name);
                values.push(value);
            };
            const flag = (value: boolean) => value ? "1" : "0";
            add("ENABLE_DEBUG_SURFACE_VIZ", "0");
            add("ENABLE_DEBUG_LINES_VIZ", "0");
            add("USE_NVAPI_HIT_OBJECT_EXTENSION", "0");
            add("USE_NVAPI_REORDER_THREADS", "0");
            add("USE_DX_HIT_OBJECT_EXTENSION", flag(s.dxHitObjectExtension));
            add("USE_DX_MAYBE_REORDER_THREADS", flag(s.dxHitObjectExtension && s.dxMaybeReorderThreads));
            add("PT_ENABLE_RUSSIAN_ROULETTE", flag(s.enableRussianRoulette));
            add("PT_NEE_ENABLED", flag(s.useNEE));
            add("PT_USE_RESTIR_DI", "0");
            add("PT_USE_RESTIR_GI", "0");
            add("RTXPT_USE_APPROXIMATE_MIS", flag(s.actualUseApproximateMIS()));
            add("RTXPT_NEE_FULL_SAMPLE_COUNT", `${s.neeFullSamples}`);
            // NEEAT::ComputeCandidateSampleLocalCount: at least 1 global candidate, then evened out.
            const local = <int>Math.floor((s.neeCandidateSamples - 1) * s.actualLocalToGlobalSampleRatio() + 0.75);
            add("RTXPT_NEE_LOCAL_CANDIDATE_SAMPLE_COUNT", `${local}`);
            add("RTXPT_NEE_GLOBAL_CANDIDATE_SAMPLE_COUNT", `${s.neeCandidateSamples - local}`);
            add("RTXPT_NEE_TOTAL_CANDIDATE_SAMPLE_COUNT", `${s.neeCandidateSamples}`);
            add("RTXPT_DISABLE_SER_TERMINATION_HINT", "0");
            add("RTXPT_DISCARD_NON_NEE_LIGHTING", "0");
            add("RTXPT_DISCARD_NEE_LIGHTING", "0");
            add("RTXPT_FIREFLY_FILTER", flag(s.actualFireflyFilterEnabled()));
            add("RTXPT_ACTIVE_DENOISING_LAYER_COUNT", `${s.denoisingLayersActiveCount}`);
            add("RTXPT_NESTED_DIELECTRICS_QUALITY", `${s.nestedDielectricsQuality}`);
            add("RTXPT_LP_TYPES_USE_16BIT_PRECISION", flag(s.useFp16Types));
            add("RTXPT_ENABLE_LOW_DISCREPANCY_SAMPLER_FOR_BSDF", flag(s.enableLDSamplerForBSDF));

            let key = "";
            for (let i = 0; i < names.length; i++) {
                key += `${names[i]}=${values[i]};`;
            }
            if (key == this.shaderMacrosKey) {
                return;
            }
            this.shaderMacrosKey = key;
            this.rtxpt.clearShaderMacros();
            for (let i = 0; i < names.length; i++) {
                this.rtxpt.addShaderMacro(names[i], values[i]);
            }
        }

        // Sample::Animate, then the setup Sample::Render does before recording (core/rtxpt.cpp executes command
        // lists of its own for it, which it can't while the frame's is open).
        onAnimate(elapsedSeconds: number) {
            // The loading's steps between frames (they execute command lists of their own), then the renderer's setup
            // below, the frame after "Initializing renderer..." has shown.
            if (this.loadingState == LoadingState.Starting) {
                if (this.splashFrames == 0) {
                    return;
                }
                if (this.start()) {
                    this.loadingState = LoadingState.Loading;
                } else {
                    this.loadingFailed = true;
                    this.app.closeWindow();
                }
                return;
            }
            if (this.loadingState == LoadingState.Loading) {
                const loading = this.rtxpt.updateLoading();
                if (loading < 0 || (loading == 1 && !this.finishLoading())) {
                    console.log(`Cannot load the scene ${this.scenePath}`);
                    this.loadingFailed = true;
                    this.app.closeWindow();
                } else if (loading == 1) {
                    this.loadingState = LoadingState.Initializing;
                }
                return;
            }
            this.loadingState = LoadingState.Ready;
            const s = this.settings;
            this.camera.setMoveSpeed(s.cameraMoveSpeed);

            // The scene's animations run in real-time mode; otherwise they only apply (at time 0) when the
            // accumulation restarts.
            const enableAnimations = s.enableAnimations && s.realtimeMode;
            const applyAnimations = enableAnimations || s.resetAccumulation;
            // CaptureScriptManager::PreAnim: the capture's warm-up starts the scene's (and game's) time over.
            if (this.frameIndex == s.captureStart) {
                this.sceneTime = s.captureStartTime;
                if (this.game.initialized) {
                    this.game.gameTime = s.captureStartTime;
                }
            }
            this.game.tick(elapsedSeconds, enableAnimations);
            if (!applyAnimations) {
                this.sceneTime = 0.0;
            } else {
                if (enableAnimations) {
                    this.sceneTime += elapsedSeconds;
                }
                // The game's time is the scene's.
                if (this.game.initialized) {
                    this.sceneTime = this.game.gameTime;
                }
            }
            this.rtxpt.animate(this.sceneTime, applyAnimations, elapsedSeconds);

            if (this.selectedCameraIndex > 0) {
                this.updateCameraFromScene(this.selectedCameraIndex - 1);
            }
            this.camera.animate(elapsedSeconds);
            this.game.tickCamera(elapsedSeconds, this.camera);

            // A moved camera restarts the accumulation (in reference mode).
            const v = this.cameraValues;
            this.camera.getPosition(Ref(v[0]));
            this.camera.getDirection(Ref(v[3]));
            this.camera.getUp(Ref(v[6]));
            let moved = false;
            for (let i = 0; i < 9; i++) {
                if (this.lastCamera[i] != v[i]) {
                    moved = true;
                    this.lastCamera[i] = v[i];
                }
            }
            if (moved && !s.realtimeMode) {
                s.resetAccumulation = true;
            }

            if (this.width != this.dlssWidth || this.height != this.dlssHeight) {
                this.dlssWidth = this.width;
                this.dlssHeight = this.height;
                if (!this.dlss.isNull()) {
                    this.dlss.init(this.width, this.height, this.width, this.height, 1);
                    s.dlssAvailable = this.dlss.isInitialized();
                }
                s.dlssRayReconstructionAvailable = !this.dlssRayReconstruction.isNull();
                if (!this.dlssNeuralRendering.isNull()) {
                    s.dlssNeuralRenderingAvailable = this.dlssNeuralRendering.init(this.width, this.height) != 0;
                }
                this.dlssNeuralRenderingActive = false;
            }
            this.updateRenderSize();

            this.updateShaderMacros();
            const prepared = this.rtxpt.prepare(this.renderWidth, this.renderHeight, this.width, this.height, this.needNewPasses,
                this.rebuildAccelStructs, s.neeatQualityPreset);
            this.preparedWidth = this.width;
            this.preparedHeight = this.height;
            if (s.actualUseDlss()) {
                // Again only when a size or the mode changes (both check). DLSS measures the exposure, as
                // Streamline's (no exposure texture).
                if (s.realtimeAA == 2) {
                    this.dlss.init(this.renderWidth, this.renderHeight, this.width, this.height, 1);
                } else if (this.dlssRayReconstruction.init(this.renderWidth, this.renderHeight, this.width, this.height, s.dlssMode - 1,
                    DLSS_RR_PRESET) == 0) {
                    console.log("DLSS-RR failed to initialize: DLSS instead");
                    s.dlssRayReconstructionAvailable = false;
                    s.realtimeAA = 2;
                }
            }
            // New passes reset the accumulation (Render's needNewPasses); new acceleration structures too.
            if ((prepared & 3) != 0) {
                this.needNewPasses = true;
            }
            if ((prepared & 4) != 0) {
                s.resetAccumulation = true;
            }
            this.rebuildAccelStructs = false;
        }

        // Sample::PreRender's DLSS setup: DLSS-RR falls back to DLSS and DLSS to TAA where not available; with
        // either, the frames render at the size NGX recommends for the DLSS mode (Streamline's
        // QueryDLSSOptimalSettings; quality at 3/4 of the window instead of 2/3, as the sample overrides it), and
        // upscale to the window's. Without a size for the mode, no AA at the window's size (as the sample).
        private updateRenderSize() {
            const s = this.settings;
            if (s.realtimeAA == 3 && !s.dlssRayReconstructionAvailable) {
                console.log("DLSS-RR is not available: DLSS instead");
                s.realtimeAA = 2;
            }
            if (s.realtimeAA == 2 && !s.dlssAvailable) {
                console.log("DLSS is not available: TAA instead");
                s.realtimeAA = 1;
            }
            this.renderWidth = this.width;
            this.renderHeight = this.height;
            if (!s.actualUseDlss()) {
                return;
            }
            const key = `${this.width}x${this.height}:${s.dlssMode}`;
            if (key != this.optimalKey) {
                this.optimalKey = key;
                // Streamline's DLSSMode m is NGX's quality value m - 1.
                const size = this.app.getDlssOptimalRenderSize(this.dlss, this.width, this.height, s.dlssMode - 1);
                this.optimalWidth = size % 65536;
                this.optimalHeight = (size - this.optimalWidth) / 65536;
                if (size != 0 && s.dlssMode == 3) {
                    // (int)(outputWidth * 3 / 4 + 0.5f) with the sample's integer division first.
                    this.optimalWidth = Math.floor(this.width * 3 / 4);
                    this.optimalHeight = Math.floor(this.height * 3 / 4);
                }
            }
            if (this.optimalWidth <= 0 || this.optimalHeight <= 0) {
                console.log("DLSS has no render size for the mode: no AA");
                s.realtimeAA = 0;
                return;
            }
            this.renderWidth = this.optimalWidth;
            this.renderHeight = this.optimalHeight;
        }

        // For the UI: the average frame time, the samples accumulated (negative while warming up) and the
        // scene's togglable nodes.
        getRenderWidth(): int {
            return this.renderWidth;
        }

        getRenderHeight(): int {
            return this.renderHeight;
        }

        getWidth(): int {
            return this.width;
        }

        getHeight(): int {
            return this.height;
        }

        getFrameSeconds(): number {
            return this.app.getAverageFrameTime();
        }

        getAccumulatedSamples(): int {
            return this.accumulationSampleIndex;
        }

        getTogglableNodeCount(): int {
            return this.rtxpt.getTogglableNodeCount();
        }

        getTogglableNodeName(index: int): string {
            return this.rtxpt.getTogglableNodeName(index);
        }

        isTogglableNodeShown(index: int): boolean {
            return this.rtxpt.isTogglableNodeShown(index);
        }

        showTogglableNode(index: int, shown: boolean) {
            this.rtxpt.showTogglableNode(index, shown);
        }

        // Sample::PreUpdatePathTracing: where the accumulation is (always restarting in real-time mode).
        private preUpdatePathTracing(resetAccumulation: boolean) {
            const s = this.settings;
            if (resetAccumulation || s.resetAccumulation || s.realtimeMode) {
                this.accumulationSampleIndex = s.accumulationPreWarm ? -ACCUMULATION_WARM_UP_FRAMES : 0;
            }
            // The warm-up's samples are far from the accumulated ones; past the target the last one repeats. In
            // real-time mode, the frame's.
            if (s.realtimeMode) {
                this.sampleIndex = this.frameIndex % 8192;
            } else if (this.accumulationSampleIndex < 0) {
                this.sampleIndex = this.accumulationSampleIndex + 4096;
            } else {
                this.sampleIndex = this.accumulationSampleIndex < s.accumulationTarget - 1 ? this.accumulationSampleIndex : s.accumulationTarget - 1;
            }
        }

        private writeFrameSettings() {
            const s = this.settings;
            const f = this.frameSettings;
            const v = this.cameraValues;
            this.camera.getPosition(Ref(v[0]));
            this.camera.getDirection(Ref(v[3]));
            this.camera.getUp(Ref(v[6]));
            f.setFloat3(FS_CAMERA_POS, v[0], v[1], v[2]);
            f.setFloat(FS_FOV_Y, this.cameraVerticalFov);
            f.setFloat3(FS_CAMERA_DIR, v[3], v[4], v[5]);
            f.setFloat(FS_Z_NEAR, this.cameraZNear);
            f.setFloat3(FS_CAMERA_UP, v[6], v[7], v[8]);
            f.setFloat(FS_FOCAL_DISTANCE, s.cameraFocalDistance);
            f.setFloat(FS_APERTURE_RADIUS, s.cameraAperture);
            f.setInt(FS_FRAME_INDEX, this.frameIndex);
            f.setInt(FS_SAMPLE_INDEX, this.sampleIndex);
            f.setBool(FS_RESET_ACCUMULATION, s.resetAccumulation);
            f.setInt(FS_BOUNCE_COUNT, s.bounceCount);
            f.setInt(FS_DIFFUSE_BOUNCE_COUNT, s.diffuseBounceCount);
            f.setFloat(FS_ENV_MAP_DIFFUSE_MIP_LEVEL, s.environmentMapDiffuseSampleMipLevel);
            f.setFloat(FS_TEX_LOD_BIAS, s.texLODBias);
            f.setFloat(FS_PER_PIXEL_JITTER_AA_SCALE, !s.realtimeMode && s.accumulationAA ? 1.0 :
                (s.realtimeMode && s.realtimeAA == 3 ? DLSS_RR_MICRO_JITTER : 0.0));
            f.setBool(FS_FIREFLY_FILTER_ENABLED, s.actualFireflyFilterEnabled());
            f.setFloat(FS_FIREFLY_FILTER_THRESHOLD, s.actualFireflyFilterThreshold());
            f.setBool(FS_ENABLE_TONE_MAPPING, s.enableToneMapping);
            f.setBool(FS_NEE_ENABLED, s.useNEE);
            f.setInt(FS_NEE_TYPE, s.neeType);
            f.setInt(FS_NEE_CANDIDATE_SAMPLES, s.neeCandidateSamples);
            f.setInt(FS_NEE_FULL_SAMPLES, s.neeFullSamples);
            f.setFloat(FS_NEEAT_GLOBAL_TEMPORAL_FEEDBACK_WEIGHT, s.neeatGlobalTemporalFeedbackWeight);
            f.setFloat(FS_NEEAT_LOCAL_TO_GLOBAL_SAMPLE_RATIO, s.actualLocalToGlobalSampleRatio());
            f.setFloat(FS_NEEAT_DISTANT_VS_LOCAL_IMPORTANCE, s.neeatDistantVsLocalImportance);
            f.setBool(FS_USE_APPROXIMATE_MIS, s.actualUseApproximateMIS());
            f.setBool(FS_ENV_MAP_ENABLED, s.environmentMapEnabled);
            f.setFloat(FS_ENV_MAP_INTENSITY, s.environmentMapIntensity);
            f.setFloat3(FS_ENV_MAP_TINT, s.environmentMapTintR, s.environmentMapTintG, s.environmentMapTintB);
            f.setFloat3(FS_ENV_MAP_ROTATION, s.environmentMapRotationX, s.environmentMapRotationY, s.environmentMapRotationZ);
            f.setInt(FS_TONE_MAP_OPERATOR, s.toneMapOperator);
            f.setBool(FS_AUTO_EXPOSURE, s.autoExposure);
            f.setFloat(FS_EXPOSURE_COMPENSATION, s.exposureCompensation);
            f.setFloat(FS_EXPOSURE_VALUE, s.exposureValue);
            f.setFloat(FS_EXPOSURE_VALUE_MIN, s.exposureValueMin);
            f.setFloat(FS_EXPOSURE_VALUE_MAX, s.exposureValueMax);
            f.setBool(FS_ENABLE_BLOOM, s.enableBloom);
            f.setFloat(FS_BLOOM_RADIUS, s.bloomRadius);
            f.setFloat(FS_BLOOM_INTENSITY, s.bloomIntensity);
            f.setInt(FS_ACTIVE_DENOISING_LAYER_COUNT, s.denoisingLayersActiveCount);
            f.setInt(FS_DENOISING_LAYERS_MAX_VERTEX_DEPTH, s.denoisingLayersMaxVertexDepth);
            f.setBool(FS_ALLOW_PRIMARY_SURFACE_REPLACEMENT, s.allowPrimarySurfaceReplacement);
            f.setFloat(FS_DENOISING_LAYERS_SPLIT_STOP_THRESHOLD, s.denoisingLayersSplitStopThreshold);
            f.setFloat(FS_DENOISING_LAYERS_SUPPRESS_PRIMARY_INDIRECT_SPECULAR_K,
                s.denoisingLayersSuppressPrimaryIndirectSpecular ? s.denoisingLayersSuppressPrimaryIndirectSpecularK : 0.0);
            f.setFloat(FS_DENOISING_LAYERS_ANTI_ALIASING_FALLTHROUGH, s.denoisingLayersAntiAliasingFallthrough);
            f.setFloat(FS_DENOISER_RADIANCE_CLAMP_K, s.denoiserRadianceClampK);
            f.setBool(FS_REALTIME_MODE, s.realtimeMode);
            f.setInt(FS_REALTIME_AA, s.realtimeAA);
            f.setBool(FS_STANDALONE_DENOISER, s.standaloneDenoiser);
            f.setInt(FS_NRD_METHOD, s.nrdMethod);
            f.setBool(FS_RESET_REALTIME_CACHES, s.resetRealtimeCaches);
            f.setBool(FS_ENABLE_ANIMATIONS, s.enableAnimations);
            f.setInt(FS_TAA_JITTER, s.taaJitter);
            f.setFloat(FS_TAA_NEW_FRAME_WEIGHT, s.taaNewFrameWeight);
            f.setBool(FS_TAA_ENABLE_HISTORY_CLAMPING, s.taaEnableHistoryClamping);
            f.setBool(FS_TAA_USE_HISTORY_CLAMP_RELAX, s.taaUseHistoryClampRelax);
            f.setFloat(FS_NRD_DISOCCLUSION_THRESHOLD, s.nrdDisocclusionThreshold);
            f.setFloat(FS_NRD_DISOCCLUSION_THRESHOLD_ALTERNATE, s.nrdDisocclusionThresholdAlternate);
            f.setBool(FS_NRD_USE_ALTERNATE_DISOCCLUSION_THRESHOLD_MIX, s.nrdUseAlternateDisocclusionThresholdMix);
            f.setInt(FS_SAMPLES_PER_PIXEL, s.actualSamplesPerPixel());
        }

        // Sample::Render and AdvancedPathTracer::SampleRenderCode.
        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            if (this.loadingState != LoadingState.Ready) {
                // The splash screen (the UI shows the loading's progress over it), at the window's size.
                this.width = width;
                this.height = height;
                frame.clearColor(0.0, 0.0, 0.0, 0.0);
                this.splashFrames++;
                if (this.testFrames > 0) {
                    Program.sleepMilliseconds(TEST_LOADING_WAIT_MS);
                }
                return;
            }
            if (width != this.preparedWidth || height != this.preparedHeight) {
                // Resized: the next animate makes the targets for this size.
                this.width = width;
                this.height = height;
                return;
            }
            const s = this.settings;
            const commandList = frame.getCommandList();

            // CaptureScriptManager::PreRender: its warm-up starts with the real-time caches reset.
            if (this.frameIndex >= s.captureStart && this.frameIndex < s.captureStart + s.captureWarmupFrames) {
                s.resetAccumulation = true;
                if (this.frameIndex == s.captureStart) {
                    s.resetRealtimeCaches = true;
                }
            }
            this.preUpdatePathTracing(this.needNewPasses);
            this.writeFrameSettings();
            const environmentChanged = this.rtxpt.beginFrame(commandList.handle, Ref(this.frameSettings.data[0]));
            this.rtxpt.pathTrace(commandList.handle);

            // Sample::PostProcessAA's in reference mode: 1 / (n + 1) until the target, then the accumulated image stays.
            const index = this.accumulationSampleIndex;
            // (Not Math.max: the warm-up's index is negative.)
            const weight = index < s.accumulationTarget ? 1.0 / ((index > 0 ? index : 0) + 1) : 0.0;
            this.rtxpt.resolve(commandList.handle, weight);

            // DLSS 5 enhances the tone-mapped image, guided by the frame's depth (reverse-Z) and motion vectors.
            const neuralRenderingRuns = s.enableDlssNeuralRendering && !this.dlssNeuralRendering.isNull() &&
                this.dlssNeuralRendering.isInitialized();
            if (neuralRenderingRuns) {
                const reset = !this.dlssNeuralRenderingActive || s.resetAccumulation || s.resetRealtimeCaches;
                commandList.evaluateDlssNeuralRenderingTextures(this.dlssNeuralRendering, this.rtxpt.getLdrColor(),
                    this.rtxpt.getDepth(), this.rtxpt.getMotionVectors(), this.rtxpt.getJitterX(), this.rtxpt.getJitterY(), 1,
                    s.dlssNeuralRenderingIntensity, s.dlssNeuralRenderingToneStrength, s.dlssNeuralRenderingStructureStrength,
                    s.dlssNeuralRenderingModel, s.dlssNeuralRenderingUseAutoMask ? 1 : 0, s.dlssNeuralRenderingSkinStrength,
                    reset ? 1 : 0);
            }
            this.dlssNeuralRenderingActive = neuralRenderingRuns;
            this.app.blitTexture(frame, this.rtxpt.getLdrColor());
            this.rtxpt.endFrame();

            // Sample::PostUpdatePathTracing.
            if (this.accumulationSampleIndex < s.accumulationTarget) {
                this.accumulationSampleIndex++;
            }
            s.resetAccumulation = environmentChanged;
            s.resetRealtimeCaches = false;
            this.needNewPasses = false;
            this.frameIndex++;
            if (this.frameIndex == this.testFrames) {
                this.app.closeWindow();
            }
        }
    }

    // --- Settings window -----------------------------------------------------------------------

    // SampleUI's settings (SampleUI.cpp, AdvancedSampleUI.cpp): the mode, the accumulation or the real-time
    // mode's denoiser and TAA, the path tracer and NEE, the environment map, tone mapping and bloom, and the
    // scene's togglable nodes. A change to the picture restarts the accumulation (the sample's
    // RESET_ON_CHANGE); the ones the path tracer's shaders bake in recompile it (Renderer.updateShaderMacros).
    class UserInterface {
        private colorValues: f32[] = [1.0, 1.0, 1.0, 1.0];
        private rotationValues: f32[] = [0.0, 0.0, 0.0];

        private imguiPass: ImGuiPass;

        constructor(private settings: Settings, private renderer: Renderer) {
            this.imguiPass = new ImGuiPass(null);
        }

        init(app: App) {
            this.imguiPass = app.addImGuiPass(this.buildUI);
            return !this.imguiPass.isNull();
        }

        private check(label: string, value: boolean) {
            const result = ImGui.checkbox(label, value);
            if (result != value) {
                this.settings.resetAccumulation = true;
            }
            return result;
        }

        private slider(label: string, value: number, min: number, max: number) {
            const result = ImGui.sliderFloat(label, value, min, max);
            if (result != value) {
                this.settings.resetAccumulation = true;
            }
            return result;
        }

        private sliderInt(label: string, value: int, min: int, max: int) {
            const result = ImGui.sliderInt(label, value, min, max);
            if (result != value) {
                this.settings.resetAccumulation = true;
            }
            return result;
        }

        private combo(label: string, value: int, items: string) {
            const result = ImGui.combo(label, value, items);
            if (result != value) {
                this.settings.resetAccumulation = true;
            }
            return result;
        }

        buildUI() {
            const s = this.settings;
            const r = this.renderer;

            // The scene's loading progress until the renderer is ready (feature_demo's).
            if (!r.isReady()) {
                this.imguiPass.beginFullScreenWindow();
                this.imguiPass.drawScreenCenteredText(r.getLoadingText());
                this.imguiPass.endFullScreenWindow();
                return;
            }

            ImGui.setNextWindowPos(10.0, 10.0);
            ImGui.begin(WINDOW_TITLE, true);

            const seconds = r.getFrameSeconds();
            ImGui.text(`${seconds > 0.0 ? Math.round(1.0 / seconds) : 0} FPS (${Math.round(seconds * 100000.0) / 100.0} ms)`);
            const mode = this.combo("Mode", s.realtimeMode ? 1 : 0, "Reference|Real-time");
            s.realtimeMode = mode == 1;
            if (s.realtimeMode) {
                if (ImGui.button("Reset real-time caches")) {
                    s.resetRealtimeCaches = true;
                }
            } else {
                const accumulated = r.getAccumulatedSamples();
                ImGui.text(accumulated < 0 ? `Warming up: ${-accumulated}` : `Accumulated: ${accumulated} / ${s.accumulationTarget}`);
                if (ImGui.button("Reset accumulation")) {
                    s.resetAccumulation = true;
                }
            }

            if (s.realtimeMode && ImGui.collapsingHeaderDefaultOpen("Real-time")) {
                ImGui.indent();
                s.realtimeSamplesPerPixel = ImGui.sliderInt("Samples per pixel", s.realtimeSamplesPerPixel, 1, 64);
                s.realtimeAA = ImGui.combo("Anti-aliasing", s.realtimeAA, s.dlssRayReconstructionAvailable ? "None|TAA|DLSS|DLSS-RR" :
                    (s.dlssAvailable ? "None|TAA|DLSS" : "None|TAA"));
                if (s.realtimeAA == 2 || s.realtimeAA == 3) {
                    // SampleUI::DLSSModeUI's order.
                    const modes = [4, 1, 2, 3, 6];
                    let current = 2;
                    for (let i = 0; i < 5; i++) {
                        if (modes[i] == s.dlssMode) {
                            current = i;
                        }
                    }
                    current = ImGui.combo("DLSS resolution scale", current, "Ultra performance|Performance|Balanced|Quality|DLAA");
                    s.dlssMode = modes[current];
                    ImGui.text(`${r.getRenderWidth()}x${r.getRenderHeight()} -> ${r.getWidth()}x${r.getHeight()}`);
                }
                if (s.realtimeAA == 1 || s.realtimeAA == 2 || s.realtimeAA == 3) {
                    s.taaJitter = ImGui.combo("Jitter", s.taaJitter, "MSAA|Halton|R2|White noise");
                }
                if (s.realtimeAA == 1) {
                    s.taaEnableHistoryClamping = ImGui.checkbox("TAA history clamping", s.taaEnableHistoryClamping);
                    s.taaUseHistoryClampRelax = ImGui.checkbox("TAA history clamp relax", s.taaUseHistoryClampRelax);
                    s.taaNewFrameWeight = ImGui.sliderFloat("TAA new frame weight", s.taaNewFrameWeight, 0.001, 1.0);
                }
                // DLSS-RR denoises itself.
                if (s.realtimeAA != 3) {
                    s.standaloneDenoiser = ImGui.checkbox("Denoiser (NRD)", s.standaloneDenoiser);
                }
                if (s.actualUseStandaloneDenoiser()) {
                    s.nrdMethod = ImGui.combo("Denoiser method", s.nrdMethod, "ReBLUR|ReLAX");
                    s.nrdDisocclusionThreshold = ImGui.sliderFloat("Disocclusion threshold", s.nrdDisocclusionThreshold, 0.0, 1.0);
                    s.nrdUseAlternateDisocclusionThresholdMix = ImGui.checkbox("Alternate disocclusion threshold mix",
                        s.nrdUseAlternateDisocclusionThresholdMix);
                    if (s.nrdUseAlternateDisocclusionThresholdMix) {
                        s.nrdDisocclusionThresholdAlternate = ImGui.sliderFloat("Alternate disocclusion threshold",
                            s.nrdDisocclusionThresholdAlternate, 0.0, 1.0);
                    }
                }
                s.denoisingLayersActiveCount = ImGui.sliderInt("Denoising layers", s.denoisingLayersActiveCount, 1, 4);
                s.realtimeFireflyFilterEnabled = ImGui.checkbox("Firefly filter", s.realtimeFireflyFilterEnabled);
                if (s.realtimeFireflyFilterEnabled) {
                    s.realtimeFireflyFilterThreshold = ImGui.sliderFloat("Firefly threshold", s.realtimeFireflyFilterThreshold, 0.01, 1000.0);
                }
                s.enableAnimations = ImGui.checkbox("Animations", s.enableAnimations);
                ImGui.unindent();
            }

            if (s.dlssNeuralRenderingAvailable && ImGui.collapsingHeaderDefaultOpen("DLSS 5")) {
                ImGui.indent();
                // As RTX Remix's DLSS 3D-Guided Neural Rendering settings.
                s.enableDlssNeuralRendering = ImGui.checkbox("DLSS 5 (Neural Rendering)", s.enableDlssNeuralRendering);
                if (s.enableDlssNeuralRendering) {
                    s.dlssNeuralRenderingModel = ImGui.combo("Model", s.dlssNeuralRenderingModel, "Model A|Model B|Model C");
                    s.dlssNeuralRenderingIntensity = ImGui.sliderFloat("Intensity", s.dlssNeuralRenderingIntensity, 0.0, 1.0);
                    s.dlssNeuralRenderingStructureStrength = ImGui.sliderFloat("Structure Intensity",
                        s.dlssNeuralRenderingStructureStrength, 0.0, 1.0);
                    s.dlssNeuralRenderingToneStrength = ImGui.sliderFloat("Tone Intensity", s.dlssNeuralRenderingToneStrength, 0.0, 1.0);
                    s.dlssNeuralRenderingUseAutoMask = ImGui.checkbox("Auto Mask", s.dlssNeuralRenderingUseAutoMask);
                    if (s.dlssNeuralRenderingUseAutoMask) {
                        s.dlssNeuralRenderingSkinStrength = ImGui.sliderFloat("Character Intensity", s.dlssNeuralRenderingSkinStrength, 0.0, 1.0);
                    }
                }
                ImGui.unindent();
            }

            const game = this.renderer.game;
            if (game.initialized && ImGui.collapsingHeader("Interactive elements")) {
                ImGui.indent();
                game.debugGUI();
                ImGui.unindent();
            }

            if (ImGui.collapsingHeaderDefaultOpen("Path tracer")) {
                ImGui.indent();
                s.cameraMoveSpeed = ImGui.sliderFloat("Camera speed", s.cameraMoveSpeed, 0.1, 50.0);
                if (!s.realtimeMode) {
                    s.accumulationTarget = this.sliderInt("Samples per pixel", s.accumulationTarget, 1, 65536);
                    s.accumulationAA = this.check("Anti-aliasing (per-pixel jitter)", s.accumulationAA);
                }
                s.bounceCount = this.sliderInt("Max bounces", s.bounceCount, 0, 128);
                s.diffuseBounceCount = this.sliderInt("Max diffuse bounces", s.diffuseBounceCount, 0, 128);
                s.enableRussianRoulette = this.check("Russian roulette", s.enableRussianRoulette);
                s.texLODBias = this.slider("Texture MIP bias", s.texLODBias, -8.0, 4.0);
                s.nestedDielectricsQuality = this.combo("Nested dielectrics", s.nestedDielectricsQuality, "Off|Fast|Quality");
                s.enableLDSamplerForBSDF = this.check("Low-discrepancy BSDF sampler", s.enableLDSamplerForBSDF);
                if (!s.realtimeMode) {
                    s.referenceFireflyFilterEnabled = this.check("Firefly filter", s.referenceFireflyFilterEnabled);
                    if (s.referenceFireflyFilterEnabled) {
                        s.referenceFireflyFilterThreshold = this.slider("Firefly threshold", s.referenceFireflyFilterThreshold, 0.01, 1000.0);
                    }
                }
                ImGui.unindent();
            }

            if (ImGui.collapsingHeader("Next event estimation")) {
                ImGui.indent();
                s.useNEE = this.check("Enabled", s.useNEE);
                if (s.useNEE) {
                    s.neeType = this.combo("Light sampling", s.neeType, "Uniform|Power|NEE-AT");
                    s.neeCandidateSamples = this.sliderInt("Candidate samples", s.neeCandidateSamples, 1, 31);
                    s.neeFullSamples = this.sliderInt("Full samples", s.neeFullSamples, 1, 7);
                    s.neeMISType = this.combo("MIS", s.neeMISType, "Full|Full in reference|Approximate");
                    if (s.neeType == 2) {
                        s.neeatGlobalTemporalFeedbackWeight = this.slider("Global feedback", s.neeatGlobalTemporalFeedbackWeight, 0.0, 0.95);
                        s.neeatLocalToGlobalSampleRatio = this.slider("Local to global", s.neeatLocalToGlobalSampleRatio, 0.0, 1.0);
                        s.neeatDistantVsLocalImportance = this.slider("Distant vs local", s.neeatDistantVsLocalImportance, 0.1, 10.0);
                    }
                }
                ImGui.unindent();
            }

            if (ImGui.collapsingHeader("Environment map")) {
                ImGui.indent();
                s.environmentMapEnabled = this.check("Enabled", s.environmentMapEnabled);
                s.environmentMapIntensity = this.slider("Intensity", s.environmentMapIntensity, 0.0, 10.0);
                this.colorValues[0] = s.environmentMapTintR;
                this.colorValues[1] = s.environmentMapTintG;
                this.colorValues[2] = s.environmentMapTintB;
                if (ImGui.colorEdit4("Tint", Ref(this.colorValues[0]), 0.0)) {
                    s.environmentMapTintR = this.colorValues[0];
                    s.environmentMapTintG = this.colorValues[1];
                    s.environmentMapTintB = this.colorValues[2];
                    s.resetAccumulation = true;
                }
                this.rotationValues[0] = s.environmentMapRotationX;
                this.rotationValues[1] = s.environmentMapRotationY;
                this.rotationValues[2] = s.environmentMapRotationZ;
                if (ImGui.dragFloat3("Rotation XYZ", Ref(this.rotationValues[0]), 0.5)) {
                    s.environmentMapRotationX = this.rotationValues[0];
                    s.environmentMapRotationY = this.rotationValues[1];
                    s.environmentMapRotationZ = this.rotationValues[2];
                    s.resetAccumulation = true;
                }
                ImGui.unindent();
            }

            // Tone mapping and bloom are after the accumulation: no restart.
            if (ImGui.collapsingHeader("Tone mapping")) {
                ImGui.indent();
                s.enableToneMapping = ImGui.checkbox("Enabled", s.enableToneMapping);
                s.toneMapOperator = ImGui.combo("Operator", s.toneMapOperator, "Linear|Reinhard|Reinhard modified|Heji-Hable ALU|Hable UC2|ACES");
                s.autoExposure = ImGui.checkbox("Auto exposure", s.autoExposure);
                s.exposureCompensation = ImGui.sliderFloat("Exposure compensation", s.exposureCompensation, -8.0, 8.0);
                if (!s.autoExposure) {
                    s.exposureValue = ImGui.sliderFloat("Exposure value", s.exposureValue, -16.0, 16.0);
                } else {
                    s.exposureValueMin = ImGui.sliderFloat("Exposure min", s.exposureValueMin, EXPOSURE_LOG2_MIN, EXPOSURE_LOG2_MAX);
                    s.exposureValueMax = ImGui.sliderFloat("Exposure max", s.exposureValueMax, EXPOSURE_LOG2_MIN, EXPOSURE_LOG2_MAX);
                }
                s.enableBloom = ImGui.checkbox("Bloom", s.enableBloom);
                if (s.enableBloom) {
                    s.bloomRadius = ImGui.sliderFloat("Bloom radius", s.bloomRadius, 1.0, 32.0);
                    s.bloomIntensity = ImGui.sliderFloat("Bloom intensity", s.bloomIntensity, 0.0, 0.1);
                }
                ImGui.unindent();
            }

            const toggleCount = r.getTogglableNodeCount();
            if (toggleCount > 0 && ImGui.collapsingHeader("Scene")) {
                ImGui.indent();
                for (let i = 0; i < toggleCount; i++) {
                    const shown = r.isTogglableNodeShown(i);
                    if (ImGui.checkbox(r.getTogglableNodeName(i), shown) != shown) {
                        r.showTogglableNode(i, !shown);
                        s.resetAccumulation = true;
                    }
                }
                ImGui.unindent();
            }

            ImGui.end();
            // GameScene::StandaloneGUI: the prop camera's "Exit prop camera" button.
            r.game.standaloneGUI(r.getWidth(), r.getHeight());
        }
    }

    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        return check.share(total - check.countInRange(0, 3, 0, 3, 0, 3, 0, 0, check.width, check.height), total,
            50.0, 100.0, "Lit");
    }

    class RtxptArgs extends Args {
        // -width / -height of the window.
        width: int = 1920;
        height: int = 1080;
        // -referenceSamplesPerPixel <n>: the accumulation's target (the sample's option).
        referenceSamplesPerPixel: int = 4096;
        // -noSER: no shader execution reordering (the sample's --noSER).
        noSER = false;
        // -captureWarmup <frames>: the accumulation restarts every frame of the first ones, as the sample's
        // --captureSimple does for its 64 warm-up frames before it saves the accumulated frame (in real-time mode,
        // the last warm-up frame). -captureStart <frame>: the frame the warm-up starts at, with the scene's time at
        // -captureStartTime <seconds> (0; the sample's --sequenceWarmupStart); the sample's starts once the scene has
        // loaded, after a few frames (real-time mode's noise and caches follow the frame index).
        captureWarmup: int = 0;
        captureStart: int = 0;
        captureStartTime = 0.0;
        // -envMapIntensity <x>: the environment map's intensity instead of the scene's.
        envMapIntensity = -1.0;
        // The sample's: -overrideToRealtimeMode / -overrideToReferenceMode instead of the scene's mode,
        // -overrideAutoexposureOff, -stopAnimations, -disableFireflyFilters, -disablePostProcessFilters (bloom), and the real-time mode's -realtimeAA <0 none, 1 TAA, 2 DLSS, 3 DLSS-RR (default)>,
        // -overrideDLSSMode <1 performance, 2 balanced (default), 3 quality, 4 ultra performance, 5 ultra quality, 6 DLAA>,
        // -standaloneDenoiser <0|1>, -nrdMethod <0 ReBLUR, 1 ReLAX>.
        overrideToRealtimeMode = false;
        overrideToReferenceMode = false;
        overrideAutoexposureOff = false;
        stopAnimations = false;
        disableFireflyFilters = false;
        disablePostProcessFilters = false;
        // -propShowTags <tags>, -propCameraAttach <prop>: SampleGame's (the sample's --propShowTags, --propCameraAttach).
        propShowTags = "";
        propCameraAttach = "";
        realtimeAA: int = 3;
        dlssMode: int = 2;
        standaloneDenoiser = true;
        nrdMethod: int = 0;
        // -dlss: the real-time mode's DLSS (-realtimeAA 2); -dlss5: DLSS 5 (DLSS-NR) over the tone-mapped image. Both
        // where available. -nrModel <0-2>, -nrIntensity, -nrStructure, -nrTone, -nrSkin <0-1>, -noAutoMask: the DLSS 5
        // settings of the UI.
        dlss5 = false;
        nrModel: int = 0;
        nrIntensity = 1.0;
        nrStructure = 0.7;
        nrTone = 0.3;
        nrSkin = 0.5;
        noAutoMask = false;
        // -useNEE <0|1>: next event estimation; -NEEType <0 uniform, 1 power, 2 NEE-AT> (the sample's options).
        useNEE = true;
        neeType: int = 2;
        // -NEEMISType <0 full, 1 full in reference / approximate in real-time, 2 approximate>: instead of the preset's.
        neeMISType: int = -1;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-noSER" || arg == "--noSER") {
                    this.noSER = true;
                } else if (arg == "-overrideToRealtimeMode" || arg == "--overrideToRealtimeMode") {
                    this.overrideToRealtimeMode = true;
                } else if (arg == "-overrideToReferenceMode" || arg == "--overrideToReferenceMode") {
                    this.overrideToReferenceMode = true;
                } else if (arg == "-overrideAutoexposureOff" || arg == "--overrideAutoexposureOff") {
                    this.overrideAutoexposureOff = true;
                } else if (arg == "-stopAnimations" || arg == "--stopAnimations") {
                    this.stopAnimations = true;
                } else if (arg == "-disableFireflyFilters" || arg == "--disableFireflyFilters") {
                    this.disableFireflyFilters = true;
                } else if (arg == "-disablePostProcessFilters" || arg == "--disablePostProcessFilters") {
                    this.disablePostProcessFilters = true;
                } else if (arg == "-dlss") {
                    this.realtimeAA = 2;
                } else if (arg == "-dlss5") {
                    this.dlss5 = true;
                } else if (arg == "-noAutoMask") {
                    this.noAutoMask = true;
                } else if (i + 1 < this.argc) {
                    if (arg == "-width") {
                        this.width = parseInt(this[i + 1]);
                    } else if (arg == "-height") {
                        this.height = parseInt(this[i + 1]);
                    } else if (arg == "-referenceSamplesPerPixel") {
                        this.referenceSamplesPerPixel = parseInt(this[i + 1]);
                    } else if (arg == "-captureWarmup") {
                        this.captureWarmup = parseInt(this[i + 1]);
                    } else if (arg == "-captureStart") {
                        this.captureStart = parseInt(this[i + 1]);
                    } else if (arg == "-captureStartTime") {
                        this.captureStartTime = parseFloat(this[i + 1]);
                    } else if (arg == "-envMapIntensity") {
                        this.envMapIntensity = parseFloat(this[i + 1]);
                    } else if (arg == "-realtimeAA") {
                        const aa = parseInt(this[i + 1]);
                        this.realtimeAA = aa >= 0 && aa <= 3 ? aa : 3;
                    } else if (arg == "-overrideDLSSMode" || arg == "--overrideDLSSMode") {
                        const mode = parseInt(this[i + 1]);
                        if (mode >= 1 && mode <= 6) {
                            this.dlssMode = mode;
                        }
                    } else if (arg == "-standaloneDenoiser") {
                        this.standaloneDenoiser = parseInt(this[i + 1]) != 0;
                    } else if (arg == "-propShowTags" || arg == "--propShowTags") {
                        this.propShowTags = this[i + 1];
                    } else if (arg == "-propCameraAttach" || arg == "--propCameraAttach") {
                        this.propCameraAttach = this[i + 1];
                    } else if (arg == "-NEEMISType") {
                        this.neeMISType = parseInt(this[i + 1]);
                    } else if (arg == "-NEEType") {
                        this.neeType = parseInt(this[i + 1]);
                    } else if (arg == "-useNEE") {
                        this.useNEE = parseInt(this[i + 1]) != 0;
                    } else if (arg == "-nrdMethod") {
                        this.nrdMethod = parseInt(this[i + 1]) == 1 ? 1 : 0;
                    } else if (arg == "-nrModel") {
                        this.nrModel = parseInt(this[i + 1]);
                    } else if (arg == "-nrIntensity") {
                        this.nrIntensity = parseFloat(this[i + 1]);
                    } else if (arg == "-nrStructure") {
                        this.nrStructure = parseFloat(this[i + 1]);
                    } else if (arg == "-nrTone") {
                        this.nrTone = parseFloat(this[i + 1]);
                    } else if (arg == "-nrSkin") {
                        this.nrSkin = parseFloat(this[i + 1]);
                    }
                }
            }
        }
    }

    // The folder of a path ("" without one).
    function directoryOf(path: string): string {
        let end = -1;
        for (let i = 0; i < path.length; i++) {
            const c = path.charAt(i);
            if (c == "/" || c == "\\") {
                end = i;
            }
        }
        return end < 0 ? "" : path.substring(0, end);
    }

    export function main(argc: int, argv: Ref<string>) {
        Program.setAppName("rtxpt");

        // -frames <n>: the frames -test renders.
        let testFrames = TEST_FRAMES;
        for (let i = 1; i + 1 < argc; i++) {
            if (CommandLine.getArg(argv, i) == "-frames") {
                testFrames = parseInt(CommandLine.getArg(argv, i + 1));
            }
        }
        const args = new RtxptArgs(argc, argv, testFrames + TEST_LOADING_FRAMES_MAX);
        args.parseArgs();

        if (args.scenePath == "") {
            console.log("Pass the scene with --scene <RTXPT_DIR>/Assets/kitchen.scene.json");
            return 1;
        }

        // AppOptions.Dlss: the Vulkan extensions DLSS and DLSS-NR need.
        const app = App.createWithOptions(args.api, WINDOW_TITLE, args.width, args.height,
            AppOptions.RayTracing | AppOptions.Dlss | args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        if (!app.isFeatureSupported(Feature.RayTracingPipeline)) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support Ray Tracing Pipelines");
        }
        console.log(`Renderer: ${app.getRendererString()}`);

        const settings = new Settings();
        settings.accumulationTarget = args.referenceSamplesPerPixel;
        settings.captureWarmupFrames = args.captureWarmup;
        settings.captureStart = args.captureStart;
        settings.captureStartTime = args.captureStartTime;
        settings.environmentMapIntensityOverride = args.envMapIntensity;
        settings.overrideToRealtimeMode = args.overrideToRealtimeMode;
        settings.overrideToReferenceMode = args.overrideToReferenceMode;
        settings.overrideAutoexposureOff = args.overrideAutoexposureOff;
        settings.stopAnimations = args.stopAnimations;
        settings.disableFireflyFilters = args.disableFireflyFilters;
        settings.disablePostProcessFilters = args.disablePostProcessFilters;
        settings.propShowTags = args.propShowTags;
        settings.propCameraAttach = args.propCameraAttach;
        settings.realtimeAA = args.realtimeAA;
        settings.dlssMode = args.dlssMode;
        settings.standaloneDenoiser = args.standaloneDenoiser;
        settings.nrdMethod = args.nrdMethod;
        settings.enableDlssNeuralRendering = args.dlss5;
        settings.dlssNeuralRenderingModel = args.nrModel;
        settings.dlssNeuralRenderingIntensity = args.nrIntensity;
        settings.dlssNeuralRenderingStructureStrength = args.nrStructure;
        settings.dlssNeuralRenderingToneStrength = args.nrTone;
        settings.dlssNeuralRenderingSkinStrength = args.nrSkin;
        settings.dlssNeuralRenderingUseAutoMask = !args.noAutoMask;
        settings.useNEE = args.useNEE;
        settings.neeType = args.neeType;
        settings.neeMISTypeOverride = args.neeMISType;
        // SampleUI's constructor: DXR 1.2's hit objects on D3D12 (SM 6.9 guarantees them), unless -noSER.
        settings.dxHitObjectExtension = args.api == GraphicsAPI.D3D12 && !args.noSER;

        const renderer = new Renderer(app, settings, args.scenePath, directoryOf(args.scenePath), args.width, args.height);
        renderer.testFrames = args.test ? testFrames : 0;
        if (!renderer.init()) {
            renderer.shutdown();
            app.destroy();
            return 1;
        }
        const input = new InputPass(app.handle);
        if (!args.noUI) {
            const ui = new UserInterface(settings, renderer);
            if (!ui.init(app)) {
                renderer.shutdown();
                app.destroy();
                return 1;
            }
        }

        app.run();
        let result = 0;
        if (renderer.loadingFailed) {
            result = 1;
        } else if (args.test) {
            result = app.finishTest(checkFrame(app));
        }
        renderer.shutdown();
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return Rtxpt.main(argc, argv);
}

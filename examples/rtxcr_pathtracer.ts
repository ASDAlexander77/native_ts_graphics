// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";
import { RtxcrScene, RtxcrNrd } from "../core/rtxcr_scene";
import { perspProjD3DStyleReverse } from "../core/matrix";

// Port of NVIDIA's RTX Character Rendering pathtracer sample (github.com/NVIDIA-RTX/RTXCR), which
// is under the NVIDIA RTX SDKs License: build with RTXCR_DIR set to a checkout (CMakeLists.txt) and
// run with --scene <RTXCR_DIR>/assets/claire.scene.json. This software contains source code
// provided by NVIDIA Corporation.
//
// A path tracer for hair and skin: a G-buffer pass and the path tracing pass (the sample's shaders,
// compiled in place from the checkout) over the scene's acceleration structures, the hair curves
// tessellated into polytubes, DOTS or linear swept spheres (core/rtxcr.cpp), accumulating samples
// while the camera stands still, then tone mapped. Or denoised instead of accumulating: NVIDIA's NRD
// (ReBLUR or ReLAX, core/rtxcr.cpp) over the noisy diffuse and specular radiance, packed and composited
// again by the sample's denoiser.hlsl. The sample's DLSS ray reconstruction, upscalers and frame
// generation are not ported.
namespace RtxcrPathtracer {
    const WINDOW_TITLE = "RTX Character Rendering: Pathtracer";

    // Test mode: the frames rendered (and accumulated).
    const TEST_FRAMES = 16;

    // The sample's TessellationType values.
    enum HairTessellation {
        Polytube = 0,
        Dots = 1,
        Lss = 2
    }

    // The sample's SkyType values.
    enum SkyType {
        Constant = 0,
        Procedural = 1,
        EnvironmentMap = 2
    }

    // sizeof(RayPayload) in payloads.h: 17 floats / uints.
    const PAYLOAD_SIZE = 17 * 4;
    // RTXCR_NVAPI_SHADER_EXT_SLOT (shared/shared.h): the UAV slot of NVAPI's shader extensions, which
    // the LSS hit shaders read the swept spheres through.
    const NVAPI_SHADER_EXT_SLOT = 10;

    // GlobalConstants (shared/globalCb.h), as byte offsets: the HLSL constant buffer's layout, which
    // the C++ struct matches (checked for the sample at 448 bytes).
    const GLOBAL_CONSTANTS_SIZE = 448;
    const G_ENABLE_BACK_FACE_CULL = 0;
    const G_BOUNCES_MAX = 4;
    const G_FRAME_INDEX = 8;
    const G_SAMPLES_PER_PIXEL = 12;
    const G_JITTER_OFFSET = 16;
    const G_DEBUG_OUTPUT_MODE = 24;
    const G_ENABLE_DENOISER_VALIDATION_LAYER = 28;
    const G_ENABLE_ACCUMULATION = 32;
    const G_RECIP_ACCUMULATED_FRAMES = 36;
    const G_ACCUMULATED_FRAMES_MAX = 40;
    const G_ENABLE_DENOISER = 44;
    const G_ENABLE_EMISSIVES = 48;
    const G_ENABLE_LIGHTING = 52;
    const G_ENABLE_DIRECT_LIGHTING = 56;
    const G_ENABLE_INDIRECT_LIGHTING = 60;
    const G_ENABLE_TRANSPARENT_SHADOWS = 64;
    const G_ENABLE_SOFT_SHADOWS = 68;
    const G_ENABLE_RUSSIAN_ROULETTE = 72;
    const G_ENABLE_HAIR = 76;
    const G_ENABLE_SSS = 80;
    const G_ENABLE_SSS_INDIRECT = 84;
    const G_TARGET_LIGHT = 88;
    const G_ENVIRONMENT_LIGHT_INTENSITY = 92;
    const G_THROUGHPUT_THRESHOLD = 96;
    const G_EXPOSURE_SCALE = 100;
    const G_TONE_MAPPING_OPERATOR = 104;
    const G_CLAMP = 108;
    const G_NRD_HIT_DISTANCE_PARAMS = 112;
    const G_HAIR_MODE = 128;
    const G_HAIR_BASE_COLOR = 132;
    const G_LONGITUDINAL_ROUGHNESS = 144;
    const G_AZIMUTHAL_ROUGHNESS = 148;
    const G_HAIR_IOR = 152;
    const G_CUTICLE_ANGLE_IN_DEGREES = 156;
    const G_ABSORPTION_MODEL = 160;
    const G_MELANIN = 164;
    const G_MELANIN_REDNESS = 168;
    const G_HAIR_ROUGHNESS = 172;
    const G_DIFFUSE_REFLECTION_TINT = 176;
    const G_DIFFUSE_REFLECTION_WEIGHT = 188;
    const G_ANALYTICAL_FRESNEL = 192;
    const G_ENABLE_TRANSMISSION = 196;
    const G_ENABLE_OCCLUSION = 200;
    const G_WHITE_FURNACE_SAMPLE_COUNT = 204;
    const G_ENABLE_SSS_TRANSMISSION = 208;
    const G_ENABLE_SSS_MATERIAL_OVERRIDE = 212;
    const G_ENABLE_DIFFUSION_PROFILE = 216;
    const G_ENABLE_SSS_DEBUG = 220;
    const G_SSS_SAMPLE_COUNT = 224;
    const G_SSS_SCALE = 228;
    const G_MAX_SAMPLE_RADIUS = 232;
    const G_SSS_ANISOTROPY = 236;
    const G_SSS_SCATTERING_COLOR = 240;
    const G_SSS_WEIGHT = 252;
    const G_SSS_TRANSMISSION_PER_BSDF_SCATTERING_SAMPLE_COUNT = 256;
    const G_SSS_TRANSMISSION_BSDF_SAMPLE_COUNT = 260;
    const G_USE_MATERIAL_DIFFUSE_ALBEDO_AS_SSS_TRANSMISSION = 264;
    const G_USE_MATERIAL_SPECULAR_ALBEDO_AS_SSS_TRANSMISSION = 268;
    const G_SSS_TRANSMISSION_COLOR = 272;
    const G_ENABLE_SINGLE_SCATTERING_DIFFUSION_PROFILE_CORRECTION = 284;
    const G_ENABLE_SSS_MICROFACET = 288;
    const G_SSS_SPECULAR_WEIGHT = 292;
    const G_ENABLE_SSS_ROUGHNESS_OVERRIDE = 296;
    const G_SSS_ROUGHNESS_OVERRIDE = 300;
    const G_SSS_DEBUG_COORDINATE = 304;
    const G_FORCE_LAMBERTIAN_BRDF = 312;
    const G_ENABLE_HAIR_MATERIAL_OVERRIDE = 316;
    const G_SKY_PARAMS = 320;
    const G_ENABLE_DLSS_RR = 416;
    const G_DEBUG_SCALE = 420;
    const G_DEBUG_MIN = 424;
    const G_DEBUG_MAX = 428;
    const G_ENABLE_ANIMATION = 432;

    // LightingConstants (shared/lightingCb.h): float4 skyColor; int lightCount and 3 pads; then
    // PlanarViewConstants view, viewPrev; LightConstants sunLight, headLight, lights[8].
    const MAX_LIGHTS = 8;
    const L_LIGHT_COUNT = 16;
    const L_VIEW = 32;

    // The sample's UIData defaults (Ui/PathtracerUi.h) that the port keeps.
    class Settings {
        enableBackFaceCull = true;
        bouncesMax = 8;
        enableAccumulation = true;
        exposureAdjustment = 0.0;
        enableSky = true;
        skyType = SkyType.EnvironmentMap;
        enableEmissives = true;
        showEmissiveSurfaces = false;
        enableLighting = true;
        enableDirectLighting = true;
        enableIndirectLighting = true;
        enableTransparentShadows = true;
        enableSoftShadows = true;
        enableTransmission = true;
        throughputThreshold = 0.01;
        enableRussianRoulette = true;
        skyColor = [42.0 / 255.0, 52.0 / 255.0, 57.0 / 255.0];
        environmentLightIntensity = 0.33;
        samplesPerPixel = 1;
        toneMappingClamp = true;
        // 0 linear, 1 Reinhard.
        toneMappingOperator = 1;

        enableHair = true;
        enableHairMaterialOverride = false;
        // 0 Chiang, 1 farfield.
        hairTechSelection = 1;
        // 0 color, 1 physics, 2 physics normalized.
        hairAbsorptionModel = 1;
        analyticalFresnel = false;
        hairBaseColor = [0.227, 0.130, 0.035];
        anisotropicRoughness = true;
        longitudinalRoughness = 0.4;
        azimuthalRoughness = 0.6;
        melanin = 0.805;
        melaninRedness = 0.05;
        hairRoughness = 0.25;
        diffuseReflectionWeight = 0.0;
        diffuseReflectionTint = [1.0, 1.0, 1.0];
        hairIor = 1.55;
        cuticleAngleInDegrees = 3.0;
        whiteFurnaceSampleCount = 1000;

        enableSss = true;
        enableSssIndirect = true;
        enableSssMaterialOverride = false;
        useMaterialSpecularAlbedoAsSssTransmission = false;
        useMaterialDiffuseAlbedoAsSssTransmission = true;
        sssTransmissionColor = [1.0, 1.0, 1.0];
        sssScatteringColor = [0.8, 0.4, 0.2];
        sssScale = 40.0;
        maxSampleRadius = 1.0;
        sssSampleCount = 1;
        enableSssTransmission = true;
        sssAnisotropy = 0.0;
        sssTransmissionBsdfSampleCount = 1;
        sssTransmissionPerBsdfScatteringSampleCount = 1;
        enableSingleScatteringDiffusionProfileCorrection = false;
        enableSssMicrofacet = true;
        sssWeight = 1.0;
        sssSpecularWeight = 1.0;
        enableSssRoughnessOverride = false;
        sssRoughnessOverride = 0.4;
        enableSssDebug = false;
        enableDiffusionProfile = true;
        forceLambertianBrdf = false;

        // The sample's cameraSpeed.
        cameraSpeed = 50.0;

        // The sample's animation settings: the scene's node animations and the hair's morph targets.
        enableAnimations = false;
        animationFps = 30.0;
        enableAnimationSmoothing = true;
        animationSmoothingFactor = 16.0;
        enableAnimationDebugging = false;
        animationKeyFrameIndexOverride = 0;
        animationKeyFrameWeightOverride = 0.0;

        // The sample's denoiser settings (UIData::enableDenoiser, nrdDenoiserMode and the NRD ones): NRD
        // instead of accumulating samples. nrdMode is 0 for ReBLUR and 1 for ReLAX.
        enableDenoiser = false;
        nrdMode = 0;
        nrdDisocclusionThreshold = 0.01;
        nrdAntiFirefly = true;
        nrdValidation = false;
        nrdSplitScreen = 0.0;

        // The hair tessellation the window asks for (HairTessellation).
        hairTessellationType = 1;
        // A test's: the tessellation to ask for after the first frames, or -1.
        switchTessellation = -1;
        // Set by the window when a setting that changes the picture does: the accumulated samples are
        // of the old one.
        dirty = false;

        // What the renderer tells the window.
        accumulatedFrames = 1;
        lssSupported = false;
        morphTargetCount = 0;
        frameSeconds = 0.0;
    }

    // A constant buffer's contents as an f32 array, written by byte offset.
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
            Donut_StoreInt32(Ref(this.data[offset / 4]), value);
        }

        setBool(offset: int, value: boolean) {
            Donut_StoreInt32(Ref(this.data[offset / 4]), value ? 1 : 0);
        }

        setFloat3(offset: int, value: number[]) {
            this.data[offset / 4] = value[0];
            this.data[offset / 4 + 1] = value[1];
            this.data[offset / 4 + 2] = value[2];
        }
    }

    // The sample's getCurrentPixelOffset (SampleRenderer.cpp): the Halton sequence of bases 2 and 3
    // over 64 frames, centered on the pixel.
    function haltonPixelOffset(frame: int): number[] {
        const frameIndex = frame % 64;
        let x = 0.0;
        let index = frameIndex + 1;
        let fraction = 0.5;
        while (index > 0) {
            x += (index % 2) * fraction;
            index = Math.floor(index / 2);
            fraction *= 0.5;
        }
        let y = 0.0;
        index = frameIndex + 1;
        fraction = 1.0 / 3.0;
        while (index > 0) {
            y += (index % 3) * fraction;
            index = Math.floor(index / 3);
            fraction /= 3.0;
        }
        return [Math.fround(x - 0.5), Math.fround(y - 0.5)];
    }

    // The directory of a path, with its trailing slash.
    function directoryOf(path: string): string {
        let end = path.lastIndexOf("/");
        const backslash = path.lastIndexOf("\\");
        if (backslash > end) {
            end = backslash;
        }
        return path.substring(0, end + 1);
    }

    // --- Settings window -----------------------------------------------------------------------

    // The sample's UI (Ui/PathtracerUi.cpp) without the upscaler and frame generation: the settings of
    // the path tracer, the NRD denoiser, the hair, the skin and the animation. A setting that changes the
    // picture marks the settings dirty, which restarts the accumulation.
    class UserInterface {
        private settings: Settings;
        private colorValues: f32[];

        constructor(settings: Settings) {
            this.settings = settings;
            this.colorValues = [0.0, 0.0, 0.0, 1.0];
        }

        init(app: App) {
            return !app.addImGuiPass(this.buildUI).isNull();
        }

        check(label: string, value: boolean) {
            const result = ImGui.checkbox(label, value);
            if (result != value) {
                this.settings.dirty = true;
            }
            return result;
        }

        slider(label: string, value: number, min: number, max: number) {
            const result = ImGui.sliderFloat(label, value, min, max);
            if (result != value) {
                this.settings.dirty = true;
            }
            return result;
        }

        sliderInt(label: string, value: int, min: int, max: int) {
            const result = ImGui.sliderInt(label, value, min, max);
            if (result != value) {
                this.settings.dirty = true;
            }
            return result;
        }

        combo(label: string, value: int, items: string) {
            const result = ImGui.combo(label, value, items);
            if (result != value) {
                this.settings.dirty = true;
            }
            return result;
        }

        color(label: string, value: number[]) {
            for (let i = 0; i < 3; i++) {
                this.colorValues[i] = value[i];
            }
            if (ImGui.colorEdit4(label, Ref(this.colorValues[0]), 0.0)) {
                for (let i = 0; i < 3; i++) {
                    value[i] = this.colorValues[i];
                }
                this.settings.dirty = true;
            }
        }

        buildUI() {
            const s = this.settings;

            ImGui.setNextWindowPos(10.0, 10.0);
            ImGui.begin("RTX Character Rendering", true);

            const seconds = s.frameSeconds;
            ImGui.text(`${seconds > 0.0 ? Math.round(1.0 / seconds) : 0} FPS`);
            if (s.enableAccumulation && !s.enableDenoiser) {
                ImGui.text(`Accumulated frames: ${s.accumulatedFrames}`);
            }

            if (ImGui.collapsingHeaderDefaultOpen("Path tracing")) {
                ImGui.indent();
                s.enableAccumulation = this.check("Accumulate", s.enableAccumulation);
                s.cameraSpeed = ImGui.sliderFloat("Camera speed", s.cameraSpeed, 1.0, 500.0);
                s.bouncesMax = this.sliderInt("Max bounces", s.bouncesMax, 1, 16);
                s.samplesPerPixel = this.sliderInt("Samples per pixel", s.samplesPerPixel, 1, 8);
                s.enableBackFaceCull = this.check("Back face culling", s.enableBackFaceCull);
                s.enableRussianRoulette = this.check("Russian roulette", s.enableRussianRoulette);
                s.throughputThreshold = this.slider("Throughput threshold", s.throughputThreshold, 0.0, 0.1);
                s.enableTransmission = this.check("Transmission", s.enableTransmission);
                s.enableEmissives = this.check("Emissives", s.enableEmissives);
                s.enableLighting = this.check("Lighting", s.enableLighting);
                s.enableDirectLighting = this.check("Direct lighting", s.enableDirectLighting);
                s.enableIndirectLighting = this.check("Indirect lighting", s.enableIndirectLighting);
                s.enableSoftShadows = this.check("Soft shadows", s.enableSoftShadows);
                s.enableTransparentShadows = this.check("Transparent shadows", s.enableTransparentShadows);
                ImGui.unindent();
            }

            if (ImGui.collapsingHeader("Denoiser")) {
                ImGui.indent();
                s.enableDenoiser = this.check("NRD denoiser", s.enableDenoiser);
                if (s.enableDenoiser) {
                    s.nrdMode = this.combo("Method", s.nrdMode, "ReBLUR|ReLAX");
                    s.nrdDisocclusionThreshold = ImGui.sliderFloat("Disocclusion threshold", s.nrdDisocclusionThreshold, 0.01, 0.02);
                    s.nrdAntiFirefly = ImGui.checkbox("Anti-firefly", s.nrdAntiFirefly);
                    s.nrdValidation = ImGui.checkbox("Validation layer", s.nrdValidation);
                    s.nrdSplitScreen = ImGui.sliderFloat("Split screen", s.nrdSplitScreen, 0.0, 1.0);
                }
                ImGui.unindent();
            }

            if (ImGui.collapsingHeader("Sky and tone mapping")) {
                ImGui.indent();
                s.enableSky = this.check("Sky", s.enableSky);
                s.skyType = this.combo("Sky type", s.skyType, "Constant|Procedural|Environment map");
                s.environmentLightIntensity = this.slider("Environment intensity", s.environmentLightIntensity, 0.0, 4.0);
                this.color("Sky color", s.skyColor);
                s.exposureAdjustment = ImGui.sliderFloat("Exposure", s.exposureAdjustment, -8.0, 8.0);
                s.toneMappingOperator = ImGui.combo("Tone mapping", s.toneMappingOperator, "Linear|Reinhard");
                s.toneMappingClamp = ImGui.checkbox("Clamp", s.toneMappingClamp);
                ImGui.unindent();
            }

            if (ImGui.collapsingHeaderDefaultOpen("Hair")) {
                ImGui.indent();
                s.enableHair = this.check("Hair shading", s.enableHair);
                if (s.lssSupported) {
                    s.hairTessellationType = ImGui.combo("Tessellation", s.hairTessellationType, "Polytube|DOTS|LSS");
                } else {
                    // LSS needs D3D12 and NVAPI's shader extensions.
                    s.hairTessellationType = ImGui.combo("Tessellation", s.hairTessellationType, "Polytube|DOTS");
                }
                s.hairTechSelection = this.combo("BCSDF", s.hairTechSelection, "Chiang|Farfield");
                s.enableHairMaterialOverride = this.check("Override hair material", s.enableHairMaterialOverride);
                s.analyticalFresnel = this.check("Analytical Fresnel", s.analyticalFresnel);
                s.hairIor = this.slider("IOR", s.hairIor, 1.0, 3.0);
                s.cuticleAngleInDegrees = this.slider("Cuticle angle", s.cuticleAngleInDegrees, 0.0, 10.0);
                if (s.hairTechSelection == 0) {
                    this.color("Base color", s.hairBaseColor);
                    s.anisotropicRoughness = this.check("Anisotropic roughness", s.anisotropicRoughness);
                    s.longitudinalRoughness = this.slider("Longitudinal roughness", s.longitudinalRoughness, 0.01, 1.0);
                    s.azimuthalRoughness = this.slider("Azimuthal roughness", s.azimuthalRoughness, 0.01, 1.0);
                } else {
                    s.hairAbsorptionModel = this.combo("Absorption", s.hairAbsorptionModel, "Color|Physics|Physics normalized");
                    if (s.hairAbsorptionModel == 0) {
                        this.color("Base color", s.hairBaseColor);
                    } else {
                        s.melanin = this.slider("Melanin", s.melanin, 0.0, 1.0);
                        s.melaninRedness = this.slider("Melanin redness", s.melaninRedness, 0.0, 1.0);
                    }
                    s.hairRoughness = this.slider("Roughness", s.hairRoughness, 0.01, 1.0);
                    s.diffuseReflectionWeight = this.slider("Diffuse reflection weight", s.diffuseReflectionWeight, 0.0, 1.0);
                    this.color("Diffuse reflection tint", s.diffuseReflectionTint);
                }
                ImGui.unindent();
            }

            if (ImGui.collapsingHeader("Skin")) {
                ImGui.indent();
                s.enableSss = this.check("Subsurface scattering", s.enableSss);
                s.enableSssIndirect = this.check("Indirect SSS", s.enableSssIndirect);
                s.enableDiffusionProfile = this.check("Diffusion profile", s.enableDiffusionProfile);
                s.enableSssMaterialOverride = this.check("Override SSS material", s.enableSssMaterialOverride);
                this.color("Scattering color", s.sssScatteringColor);
                this.color("Transmission color", s.sssTransmissionColor);
                s.sssScale = this.slider("Scale", s.sssScale, 0.0, 100.0);
                s.maxSampleRadius = this.slider("Max sample radius", s.maxSampleRadius, 0.0, 5.0);
                s.sssSampleCount = this.sliderInt("Samples", s.sssSampleCount, 1, 16);
                s.enableSssTransmission = this.check("Transmission", s.enableSssTransmission);
                s.sssAnisotropy = this.slider("Anisotropy", s.sssAnisotropy, -0.99, 0.99);
                s.sssTransmissionBsdfSampleCount = this.sliderInt("Transmission BSDF samples", s.sssTransmissionBsdfSampleCount, 1, 16);
                s.sssTransmissionPerBsdfScatteringSampleCount = this.sliderInt("Transmission scattering samples",
                    s.sssTransmissionPerBsdfScatteringSampleCount, 1, 16);
                s.enableSssMicrofacet = this.check("Specular reflection", s.enableSssMicrofacet);
                s.sssWeight = this.slider("Diffuse weight", s.sssWeight, 0.0, 1.0);
                s.sssSpecularWeight = this.slider("Specular weight", s.sssSpecularWeight, 0.0, 1.0);
                s.enableSssRoughnessOverride = this.check("Override roughness", s.enableSssRoughnessOverride);
                s.sssRoughnessOverride = this.slider("Roughness", s.sssRoughnessOverride, 0.01, 1.0);
                s.forceLambertianBrdf = this.check("Force Lambertian BRDF", s.forceLambertianBrdf);
                ImGui.unindent();
            }

            if (ImGui.collapsingHeader("Animation")) {
                ImGui.indent();
                s.enableAnimations = ImGui.checkbox("Animate (Space)", s.enableAnimations);
                if (s.enableAnimations && s.enableAccumulation) {
                    ImGui.text("The picture changes every frame: nothing accumulates.");
                }
                ImGui.text(`Morph target meshes: ${s.morphTargetCount}`);
                s.animationFps = ImGui.sliderFloat("Keyframes per second", s.animationFps, 1.0, 120.0);
                s.enableAnimationSmoothing = ImGui.checkbox("Smooth the loop", s.enableAnimationSmoothing);
                s.animationSmoothingFactor = ImGui.sliderFloat("Smoothing", s.animationSmoothingFactor, 1.0, 64.0);
                s.enableAnimationDebugging = ImGui.checkbox("Pick the keyframes", s.enableAnimationDebugging);
                if (s.enableAnimationDebugging) {
                    s.animationKeyFrameIndexOverride = ImGui.sliderInt("Keyframe", s.animationKeyFrameIndexOverride, 0, 127);
                    s.animationKeyFrameWeightOverride = ImGui.sliderFloat("Blend", s.animationKeyFrameWeightOverride, 0.0, 1.0);
                }
                ImGui.unindent();
            }

            ImGui.end();
        }
    }

    // --- Renderer ----------------------------------------------------------------------------

    // The sample's SampleRenderer with its resource manager, G-buffer, path tracing and
    // post-processing passes.
    class Renderer {
        private app: App;
        private settings: Settings;
        private scenePath: string;
        private hairTessellationType: int;
        private hairRadiusScale: number;
        // Whether the device traces linear swept spheres, which the shaders reach through NVAPI (D3D12):
        // the hair can be LSS, and the shaders are the ones with NVAPI's extensions.
        private useLss: boolean;
        private pendingTessellation: boolean;

        private scene: Scene;
        private sceneGraph: SceneGraph;
        private rtxcrScene: RtxcrScene;
        private descriptorTableManager: DescriptorTableManager;
        private descriptorTable: DescriptorTableHandle;
        private bindlessLayout: BindingLayoutHandle;
        private sunLight: Light;
        private lights: Light[];
        private sceneCameraVerticalFov: number;
        private sceneCameraZNear: number;
        private envMap: LoadedTexture;

        private camera: Camera;
        private view: View;
        private previousView: View;
        private viewMatrix: f32[];
        private projMatrix: f32[];

        private lighting: ConstantBlock;
        private global: ConstantBlock;
        private lightingBuffer: BufferHandle;
        private globalBuffer: BufferHandle;
        private viewConstantsSize: int;
        private lightConstantsSize: int;
        private morphTargetCount: int;
        private wallclockTime: number;
        private elapsedSeconds: number;

        // Pipelines
        private gbufferLayout: BindingLayoutHandle;
        private gbufferDenoiserLayout: BindingLayoutHandle;
        private gbufferTable: ShaderTable;
        private ptLayout: BindingLayoutHandle;
        private ptDenoiserLayout: BindingLayoutHandle;
        private ptTable: ShaderTable;
        private tonemapLayout: BindingLayoutHandle;
        private tonemapVS: ShaderHandle;
        private tonemapPS: ShaderHandle;
        private tonemapPipeline: GraphicsPipelineHandle;
        private tonemapPipelineReady: boolean;

        // Render targets, created on the first frame and when the window changes size.
        private width: int;
        private height: int;
        private targetsReady: boolean;
        private pathTracerOutput: TextureHandle;
        private postProcessing: TextureHandle;
        private accumulation: TextureHandle;
        private viewZ: TextureHandle;
        private shadingNormalRoughness: TextureHandle;
        private motionVector: TextureHandle;
        private emissive: TextureHandle;
        private albedo: TextureHandle;
        private specularAlbedo: TextureHandle;
        private screenSpaceMotionVector: TextureHandle;
        private deviceZ: TextureHandle;
        private noisyDiffuse: TextureHandle;
        private noisySpecular: TextureHandle;
        private specularHitDistance: TextureHandle;
        private denoiserValidation: TextureHandle;
        private denoisedDiffuse: TextureHandle;
        private denoisedSpecular: TextureHandle;
        private gbufferSet: BindingSet;
        private gbufferDenoiserSet: BindingSet;
        private ptSet: BindingSet;
        private ptDenoiserSet: BindingSet;
        private tonemapSet: BindingSet;

        // The NRD denoiser: the passes that pack the noisy radiance for it and composite what it returns
        // (the sample's denoiser.hlsl; ReBLUR and ReLAX pack differently), and NRD itself.
        private nrdLayout: BindingLayoutHandle;
        private nrdTexturesLayout: BindingLayoutHandle;
        private nrdPackShader: ShaderHandle[];
        private nrdCompositeShader: ShaderHandle[];
        private nrdPackPipeline: ComputePipelineHandle[];
        private nrdCompositePipeline: ComputePipelineHandle[];
        private nrdSet: BindingSet;
        private nrdPackSet: BindingSet;
        private nrdCompositeSet: BindingSet;
        private nrd: RtxcrNrd;
        // The method (0 ReBLUR, 1 ReLAX) of nrd, or -1 while there is none.
        private nrdMethod: int;
        // The denoiser's history is of another picture (a new denoiser, a resize, a setting).
        private resetDenoiser: boolean;
        private jitterX: number;
        private jitterY: number;
        private previousJitterX: number;
        private previousJitterY: number;

        private frameCounter: int;
        // The sample's PathTracingPass accumulation state.
        private accumulatedFrameCount: int;
        private resetAccumulation: boolean;
        private previousViewValid: boolean;
        private lastViewMatrix: f32[];

        constructor(app: App, settings: Settings, scenePath: string, hairTessellationType: int, hairRadiusScale: number) {
            this.app = app;
            this.settings = settings;
            this.scenePath = scenePath;
            this.hairTessellationType = hairTessellationType;
            this.hairRadiusScale = hairRadiusScale;
            this.useLss = settings.lssSupported;
            this.pendingTessellation = false;
            this.lights = [];
            this.tonemapPipelineReady = false;
            this.targetsReady = false;
            this.width = 0;
            this.height = 0;
            this.gbufferSet = new BindingSet(null);
            this.gbufferDenoiserSet = new BindingSet(null);
            this.ptSet = new BindingSet(null);
            this.ptDenoiserSet = new BindingSet(null);
            this.tonemapSet = new BindingSet(null);
            this.nrdSet = new BindingSet(null);
            this.nrdPackSet = new BindingSet(null);
            this.nrdCompositeSet = new BindingSet(null);
            this.nrd = new RtxcrNrd(null);
            this.nrdMethod = -1;
            this.resetDenoiser = true;
            this.jitterX = 0.0;
            this.jitterY = 0.0;
            this.previousJitterX = 0.0;
            this.previousJitterY = 0.0;
            this.nrdPackShader = [];
            this.nrdCompositeShader = [];
            this.nrdPackPipeline = [];
            this.nrdCompositePipeline = [];
            this.morphTargetCount = 0;
            this.wallclockTime = 0.0;
            this.elapsedSeconds = 0.0;
            this.frameCounter = 0;
            this.accumulatedFrameCount = 1;
            this.resetAccumulation = true;
            this.previousViewValid = false;
            this.viewMatrix = [];
            this.projMatrix = [];
            this.lastViewMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
                this.projMatrix.push(0.0);
                this.lastViewMatrix.push(0.0);
            }
        }

        init() {
            // The bindless resources of the scene: buffers in space 2, textures in space 3.
            const bindlessLayoutDesc = BindlessLayoutDesc.create(0, 1024, ShaderType.All);
            bindlessLayoutDesc.addRawBuffers(2);
            bindlessLayoutDesc.addTextures(3);
            this.bindlessLayout = this.app.createBindlessLayout(bindlessLayoutDesc);
            this.descriptorTableManager = this.app.createDescriptorTableManager(this.bindlessLayout);
            this.descriptorTable = this.descriptorTableManager.getDescriptorTable();

            // The hair curves are tessellated before the scene's buffers are uploaded.
            const scene = this.app.loadSceneWithDescriptorTableDeferred(this.scenePath, this.descriptorTableManager);
            if (scene.isNull()) {
                console.log(`Cannot load the scene ${this.scenePath}`);
                return false;
            }
            this.scene = scene;
            this.rtxcrScene = RtxcrScene.create(this.app.getNvrhiDevice(), scene.handle, this.descriptorTableManager.handle,
                this.hairRadiusScale, this.hairTessellationType);
            this.sceneGraph = scene.getSceneGraph();

            // The sun is the scene's first directional light; the shader takes all the lights.
            const lightCount = this.sceneGraph.getLightCount();
            let sunLight: Light | null = null;
            for (let i = 0; i < lightCount; i++) {
                const light = this.sceneGraph.getLight(i);
                this.lights.push(light);
                if (!sunLight && light.getType() == LightType.Directional) {
                    sunLight = light;
                }
            }
            if (!sunLight) {
                // The sample's default sun.
                sunLight = this.sceneGraph.addDirectionalLight(this.sceneGraph.getRootNode(), "Sun",
                    -0.791, -0.259, -0.554, 0.8, 20.0);
                this.app.refreshSceneGraph(this.sceneGraph);
                this.lights.push(sunLight);
            }
            this.sunLight = sunLight;

            // The camera: the scene's DefaultCamera, or the first one.
            this.camera = this.app.createFirstPersonCamera();
            this.camera.setMoveSpeed(this.settings.cameraSpeed);
            const cameraCount = this.sceneGraph.getCameraCount();
            if (cameraCount > 0) {
                let sceneCamera = this.sceneGraph.getCamera(0);
                for (let i = 0; i < cameraCount; i++) {
                    if (this.sceneGraph.getCamera(i).getName() == "DefaultCamera") {
                        sceneCamera = this.sceneGraph.getCamera(i);
                    }
                }
                this.sceneCameraVerticalFov = this.sceneGraph.getCamera(0).getVerticalFov();
                this.sceneCameraZNear = this.sceneGraph.getCamera(0).getZNear();
                const viewToWorld: f32[] = [];
                for (let i = 0; i < 16; i++) {
                    viewToWorld.push(0.0);
                }
                sceneCamera.getViewToWorld(Ref(viewToWorld[0]));
                // The rows of the view-to-world matrix: right, up, forward, position.
                const px = viewToWorld[12];
                const py = viewToWorld[13];
                const pz = viewToWorld[14];
                this.camera.lookAtWithUp(px, py, pz, px + viewToWorld[8], py + viewToWorld[9], pz + viewToWorld[10],
                    viewToWorld[4], viewToWorld[5], viewToWorld[6]);
            } else {
                this.sceneCameraVerticalFov = 1.0;
                this.sceneCameraZNear = 0.1;
                this.camera.lookAt(0.0, 1.8, 0.0, 1.0, 1.8, 0.0);
            }

            this.view = this.app.createPlanarView();
            this.previousView = this.app.createPlanarView();

            // The environment map beside the scene's assets.
            const envMap = this.app.loadBindlessTexture(this.descriptorTableManager,
                directoryOf(this.scenePath) + "EnvironmentMaps/venice_sunset_1k.exr", 0);
            if (envMap.isNull()) {
                console.log("Cannot load the environment map");
                return false;
            }
            this.envMap = envMap;

            this.viewConstantsSize = Donut_GetPlanarViewConstantsSize();
            this.lightConstantsSize = Donut_GetLightConstantsSize();
            const lightingSize = L_VIEW + this.viewConstantsSize * 2 + this.lightConstantsSize * (2 + MAX_LIGHTS);
            this.lighting = new ConstantBlock(lightingSize);
            this.global = new ConstantBlock(GLOBAL_CONSTANTS_SIZE);
            this.lightingBuffer = this.app.createVolatileConstantBuffer(lightingSize, "LightingConstants");
            this.globalBuffer = this.app.createVolatileConstantBuffer(GLOBAL_CONSTANTS_SIZE, "GlobalConstants");

            // The animated hair (morph targets), and the acceleration structures over the scene.
            this.morphTargetCount = this.rtxcrScene.createMorphTargets();
            this.buildAccelStructs();

            if (!this.createPipelines()) {
                return false;
            }

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setMouseScrollCallback(this.onMouseScroll);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        // Drops what holds the scene's materials and buffers, before the device goes.
        shutdown() {
            this.app.waitForIdle();
            if (!this.nrd.isNull()) {
                this.nrd.destroy();
            }
            this.rtxcrScene.destroy();
        }

        onKey(key: Key, scancode: ScanCode, action: Action, mods: KeyMods) {
            this.camera.keyboardUpdate(key, scancode, action, mods);
            if (key == Key.Space && action == Action.Press) {
                this.settings.enableAnimations = !this.settings.enableAnimations;
            }
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

        onAnimate(elapsedSeconds: number) {
            this.camera.animate(elapsedSeconds);
            this.elapsedSeconds = elapsedSeconds;

            // Another tessellation of the hair makes buffers and acceleration structures in command lists of
            // their own, which no frame's list may be open beside.
            if (this.settings.switchTessellation >= 0 && this.frameCounter == 4) {
                this.settings.hairTessellationType = this.settings.switchTessellation;
            }
            this.changeTessellation();

            // The sample's SampleScene::Animate: the scene's node animations, each starting a second
            // after the previous one.
            if (this.settings.enableAnimations) {
                this.wallclockTime += elapsedSeconds;
                let offset = 0.0;
                const animationCount = this.scene.getAnimationCount();
                for (let i = 0; i < animationCount; i++) {
                    const duration = this.scene.getAnimationDuration(i);
                    const cycles = (this.wallclockTime + offset) / duration;
                    this.scene.applyAnimation(i, (cycles - Math.floor(cycles)) * duration);
                    offset += 1.0;
                }
            }
        }

        onBackBufferResizing() {
            this.releaseTargets();
        }

        // Frees the render targets and what binds them.
        releaseTargets() {
            const sets: BindingSet[] = [];
            sets.push(this.gbufferSet);
            sets.push(this.gbufferDenoiserSet);
            sets.push(this.ptSet);
            sets.push(this.ptDenoiserSet);
            sets.push(this.tonemapSet);
            sets.push(this.nrdSet);
            sets.push(this.nrdPackSet);
            sets.push(this.nrdCompositeSet);
            for (let i = 0; i < sets.length; i++) {
                if (!sets[i].isNull()) {
                    this.app.releaseResource(sets[i].handle);
                }
            }
            this.gbufferSet = new BindingSet(null);
            this.gbufferDenoiserSet = new BindingSet(null);
            this.ptSet = new BindingSet(null);
            this.ptDenoiserSet = new BindingSet(null);
            this.tonemapSet = new BindingSet(null);
            this.nrdSet = new BindingSet(null);
            this.nrdPackSet = new BindingSet(null);
            this.nrdCompositeSet = new BindingSet(null);
            if (this.targetsReady) {
                const textures: TextureHandle[] = [];
                textures.push(this.pathTracerOutput);
                textures.push(this.postProcessing);
                textures.push(this.accumulation);
                textures.push(this.viewZ);
                textures.push(this.shadingNormalRoughness);
                textures.push(this.motionVector);
                textures.push(this.emissive);
                textures.push(this.albedo);
                textures.push(this.specularAlbedo);
                textures.push(this.screenSpaceMotionVector);
                textures.push(this.deviceZ);
                textures.push(this.noisyDiffuse);
                textures.push(this.noisySpecular);
                textures.push(this.specularHitDistance);
                textures.push(this.denoiserValidation);
                textures.push(this.denoisedDiffuse);
                textures.push(this.denoisedSpecular);
                for (let i = 0; i < textures.length; i++) {
                    this.app.releaseResource(textures[i]);
                }
                this.targetsReady = false;
            }
            // The tone mapping pipeline is for the frame's framebuffer, which changes too.
            if (this.tonemapPipelineReady) {
                this.app.releaseResource(this.tonemapPipeline);
                this.tonemapPipelineReady = false;
            }
            this.app.clearBindingCache();
            this.resetAccumulation = true;
            this.resetDenoiser = true;
        }

        // The sample's ResourceManager::CreateScreenResolutionTextures and
        // CreateRenderResolutionTextures: all the targets are the window's size here.
        createTargets(width: int, height: int) {
            this.width = width;
            this.height = height;
            this.targetsReady = true;
            this.pathTracerOutput = this.app.createRenderTargetUAVTexture(width, height, Format.RGBA32_FLOAT, "PathTracerOutput");
            this.postProcessing = this.app.createRenderTargetUAVTexture(width, height, Format.RGBA32_FLOAT, "Post Processing Texture");
            this.accumulation = this.app.createRenderTargetUAVTexture(width, height, Format.RGBA32_FLOAT, "AccumulateTexture");
            this.viewZ = this.app.createRenderTargetUAVTexture(width, height, Format.R16_FLOAT, "ViewZ");
            this.shadingNormalRoughness = this.app.createRenderTargetUAVTexture(width, height, Format.RGBA16_FLOAT, "Shading Normal Roughness");
            this.motionVector = this.app.createRenderTargetUAVTexture(width, height, Format.RGBA16_FLOAT, "Motion Vector");
            this.emissive = this.app.createRenderTargetUAVTexture(width, height, Format.RGBA16_FLOAT, "Emissive");
            this.albedo = this.app.createRenderTargetUAVTexture(width, height, Format.RGBA8_UNORM, "Albedo");
            this.specularAlbedo = this.app.createRenderTargetUAVTexture(width, height, Format.RGBA16_FLOAT, "Specular Albedo");
            this.screenSpaceMotionVector = this.app.createRenderTargetUAVTexture(width, height, Format.RG16_FLOAT, "Screen Space Motion Vector");
            this.deviceZ = this.app.createRenderTargetUAVTexture(width, height, Format.R16_FLOAT, "DeviceZ");
            this.noisyDiffuse = this.app.createRenderTargetUAVTexture(width, height, Format.RGBA16_FLOAT, "Noisy Diffuse Radiance HitT");
            this.noisySpecular = this.app.createRenderTargetUAVTexture(width, height, Format.RGBA16_FLOAT, "Noisy Specular Radiance HitT");
            this.specularHitDistance = this.app.createRenderTargetUAVTexture(width, height, Format.R16_FLOAT, "Specular HitT");
            this.denoiserValidation = this.app.createRenderTargetUAVTexture(width, height, Format.RGBA8_UNORM, "Denoiser Validation Texture");
            this.denoisedDiffuse = this.app.createRenderTargetUAVTexture(width, height, Format.RGBA16_FLOAT, "Denoised Diffuse Radiance HitT");
            this.denoisedSpecular = this.app.createRenderTargetUAVTexture(width, height, Format.RGBA16_FLOAT, "Denoised Specular Radiance HitT");
            if (!this.nrd.isNull()) {
                this.nrd.resize(width, height);
            }
        }

        // A layout of the sample's pass bindings in register space / descriptor set `set`.
        makeLayout(set: int, kind: int) {
            const desc = BindingLayoutDesc.create();
            if (kind == 0 || kind == 1) {
                // Space 0 of the G-buffer (0) and path tracing (1) passes.
                desc.layoutVolatileConstantBuffer(0);
                desc.layoutVolatileConstantBuffer(1);
                desc.layoutAccelStruct(0);
                desc.layoutStructuredBufferSRV(1);
                desc.layoutStructuredBufferSRV(2);
                desc.layoutStructuredBufferSRV(3);
                if (kind == 1) {
                    desc.layoutTextureSRV(4);
                    desc.layoutStructuredBufferSRV(5);
                } else {
                    desc.layoutStructuredBufferSRV(4);
                }
                desc.layoutSampler(0);
                if (kind == 1) {
                    desc.layoutTextureUAV(0);
                }
                if (this.useLss) {
                    desc.layoutTypedBufferUAV(NVAPI_SHADER_EXT_SLOT);
                }
            } else if (kind == 2) {
                // Space 1 of the G-buffer pass: eight UAVs.
                for (let i = 0; i < 8; i++) {
                    desc.layoutTextureUAV(i);
                }
            } else {
                // Space 1 of the path tracing pass: the G-buffer as eight SRVs and three UAVs.
                for (let i = 0; i < 8; i++) {
                    desc.layoutTextureSRV(i);
                }
                for (let i = 0; i < 3; i++) {
                    desc.layoutTextureUAV(i);
                }
            }
            desc.setDescriptorSet(set);
            return this.app.createBindingLayout(desc, ShaderType.All);
        }

        createPipelines() {
            this.gbufferLayout = this.makeLayout(0, 0);
            this.gbufferDenoiserLayout = this.makeLayout(1, 2);
            this.ptLayout = this.makeLayout(0, 1);
            this.ptDenoiserLayout = this.makeLayout(1, 3);

            // The shaders with LSS reach the spheres through NVAPI; without it (the hair is triangles) they don't.
            const macros = this.useLss ? "LSS_GEOMETRY_SUPPORTED=1;API_DX12=1" : "LSS_GEOMETRY_SUPPORTED=0;API_DX12=0";
            const missLibrary = this.app.createShaderLibrary("PathtracingPass.miss.hlsl");
            const closestHitLibrary = this.app.createShaderLibraryWithDefines("PathtracingPass.chs.hlsl", macros);
            const gbufferLibrary = this.app.createShaderLibrary("GBufferPass.rgs.hlsl");
            const rayGenLibrary = this.app.createShaderLibraryWithDefines("PathtracingPass.rgs.hlsl", macros);
            if (!missLibrary || !closestHitLibrary || !gbufferLibrary || !rayGenLibrary) {
                console.log("Cannot load the shaders");
                return false;
            }

            // G-buffer pass: one miss shader, one hit group.
            {
                const desc = RtPipelineDesc.create(PAYLOAD_SIZE, 1);
                desc.addGlobalBindingLayout(this.gbufferLayout);
                desc.addGlobalBindingLayout(this.gbufferDenoiserLayout);
                desc.addGlobalBindingLayout(this.bindlessLayout);
                desc.addShader(gbufferLibrary, "RayGen", ShaderType.RayGeneration);
                desc.addShader(missLibrary, "Miss", ShaderType.Miss);
                desc.addHitGroup(closestHitLibrary, "HitGroup", "ClosestHit", "", null);
                if (this.useLss) {
                    desc.setHlslExtensionsUAV(NVAPI_SHADER_EXT_SLOT);
                }
                const pipeline = this.app.createRayTracingPipelineFromDesc(desc);
                if (!pipeline) {
                    return false;
                }
                const table = this.app.createEmptyShaderTable(pipeline);
                table.setRayGeneration("RayGen");
                table.addHitGroup("HitGroup", null);
                table.addMiss("Miss");
                this.gbufferTable = table;
            }

            // Path tracing pass: the shadow rays have a miss shader and a hit group of their own.
            {
                const desc = RtPipelineDesc.create(PAYLOAD_SIZE, 1);
                desc.addGlobalBindingLayout(this.ptLayout);
                desc.addGlobalBindingLayout(this.ptDenoiserLayout);
                desc.addGlobalBindingLayout(this.bindlessLayout);
                desc.addShader(rayGenLibrary, "RayGen", ShaderType.RayGeneration);
                desc.addShader(missLibrary, "Miss", ShaderType.Miss);
                desc.addShader(missLibrary, "ShadowMiss", ShaderType.Miss);
                desc.addHitGroup(closestHitLibrary, "HitGroup", "ClosestHit", "", null);
                desc.addHitGroup(closestHitLibrary, "HitGroupShadow", "ClosestHitShadow", "", null);
                if (this.useLss) {
                    desc.setHlslExtensionsUAV(NVAPI_SHADER_EXT_SLOT);
                }
                const pipeline = this.app.createRayTracingPipelineFromDesc(desc);
                if (!pipeline) {
                    return false;
                }
                const table = this.app.createEmptyShaderTable(pipeline);
                table.setRayGeneration("RayGen");
                table.addHitGroup("HitGroup", null);
                table.addHitGroup("HitGroupShadow", null);
                table.addMiss("Miss");
                table.addMiss("ShadowMiss");
                this.ptTable = table;
            }

            // The morph target pass.
            if (!this.createMorphTargetShader()) {
                return false;
            }

            // The denoiser's packing and compositing passes (denoiser.hlsl, ReBLUR's and ReLAX's): the global
            // constants and the output in space 0, the G-buffer and the radiance in space 1, all UAVs.
            {
                const desc = BindingLayoutDesc.create();
                desc.layoutVolatileConstantBuffer(0);
                desc.layoutTextureUAV(0);
                desc.setDescriptorSet(0);
                this.nrdLayout = this.app.createBindingLayout(desc, ShaderType.Compute);
                const texturesDesc = BindingLayoutDesc.create();
                for (let i = 0; i < 8; i++) {
                    texturesDesc.layoutTextureUAV(i);
                }
                texturesDesc.setDescriptorSet(1);
                this.nrdTexturesLayout = this.app.createBindingLayout(texturesDesc, ShaderType.Compute);
                for (let method = 0; method < 2; method++) {
                    const value = `${method}`;
                    const pack = this.app.createShaderWithDefine("denoiser.hlsl", "demodulate", ShaderType.Compute, "USE_RELAX", value);
                    const composite = this.app.createShaderWithDefine("denoiser.hlsl", "composite", ShaderType.Compute, "USE_RELAX", value);
                    if (!pack || !composite) {
                        console.log("Cannot load the denoiser shaders");
                        return false;
                    }
                    this.nrdPackShader.push(pack);
                    this.nrdCompositeShader.push(composite);
                    this.nrdPackPipeline.push(this.app.createComputePipelineWithLayouts(pack, this.nrdLayout, this.nrdTexturesLayout));
                    this.nrdCompositePipeline.push(this.app.createComputePipelineWithLayouts(composite, this.nrdLayout, this.nrdTexturesLayout));
                }
            }

            // Tone mapping: the sample's pixel shader over a full-screen strip.
            const tonemapDesc = BindingLayoutDesc.create();
            tonemapDesc.layoutVolatileConstantBuffer(0);
            tonemapDesc.layoutTextureUAV(0);
            tonemapDesc.layoutTextureUAV(1);
            tonemapDesc.layoutTextureSRV(0);
            this.tonemapLayout = this.app.createBindingLayout(tonemapDesc, ShaderType.Pixel);
            this.tonemapVS = this.app.createShader("rtxcr_pathtracer_vs.hlsl", "main_vs", ShaderType.Vertex);
            this.tonemapPS = this.app.createShader("tonemapping.hlsl", "main_ps", ShaderType.Pixel);
            if (!this.tonemapVS || !this.tonemapPS) {
                console.log("Cannot load the tone mapping shaders");
                return false;
            }
            return true;
        }

        // The morph target pass's shader for the hair's tessellation.
        createMorphTargetShader() {
            if (this.morphTargetCount > 0) {
                const morphShader = this.app.createShaderWithDefine("morphTargetAnimation.cs.hlsl", "main_cs", ShaderType.Compute,
                    "RTXCR_CURVE_TESSELLATION_TYPE", `${this.hairTessellationType}`);
                if (!morphShader) {
                    console.log("Cannot load the morph target shader");
                    return false;
                }
                this.rtxcrScene.setMorphTargetShader(morphShader);
            }
            return true;
        }

        // The window asked for another hair tessellation: the scene's hair, morph targets and
        // acceleration structures are made again, and the render targets' bindings (the scene's buffers).
        changeTessellation() {
            const type = this.settings.hairTessellationType;
            if (type == this.hairTessellationType) {
                return;
            }
            this.app.waitForIdle();
            if (this.rtxcrScene.setTessellationType(type, this.frameCounter) == 0) {
                return;
            }
            this.hairTessellationType = type;
            this.morphTargetCount = this.rtxcrScene.createMorphTargets();
            this.createMorphTargetShader();
            this.buildAccelStructs();
            this.releaseTargets();
        }

        // The bottom level structures of the scene's meshes and the top level one, in a command list of their
        // own (the frame's might have used the morph targets' vertex buffers already).
        buildAccelStructs() {
            const buildList = this.app.createCommandList();
            buildList.open();
            this.rtxcrScene.buildAccelStructs(buildList.handle, true);
            this.rtxcrScene.buildTlas(buildList.handle, this.settings.showEmissiveSurfaces);
            buildList.close();
            this.app.executeCommandList(buildList);
            this.app.waitForIdle();
            this.app.releaseResource(buildList.handle);
        }

        createBindingSets() {
            const gbufferDesc = BindingSetDesc.create();
            gbufferDesc.bindEntireConstantBuffer(0, this.lightingBuffer);
            gbufferDesc.bindEntireConstantBuffer(1, this.globalBuffer);
            gbufferDesc.bindAccelStruct(0, this.rtxcrScene.getTlas());
            gbufferDesc.bindStructuredBufferSRV(1, this.scene.getBuffer(SceneBuffer.Instances));
            gbufferDesc.bindStructuredBufferSRV(2, this.scene.getBuffer(SceneBuffer.Geometries));
            gbufferDesc.bindStructuredBufferSRV(3, this.scene.getBuffer(SceneBuffer.Materials));
            gbufferDesc.bindStructuredBufferSRV(4, this.rtxcrScene.getMorphTargetMask());
            gbufferDesc.bindSampler(0, this.app.getCommonSampler(CommonSampler.AnisotropicWrap));
            if (this.useLss) {
                gbufferDesc.bindNullTypedBufferUAV(NVAPI_SHADER_EXT_SLOT);
            }
            this.gbufferSet = this.app.createBindingSetForLayout(gbufferDesc, this.gbufferLayout);

            const gbufferDenoiserDesc = BindingSetDesc.create();
            gbufferDenoiserDesc.bindTextureUAV(0, this.viewZ);
            gbufferDenoiserDesc.bindTextureUAV(1, this.shadingNormalRoughness);
            gbufferDenoiserDesc.bindTextureUAV(2, this.motionVector);
            gbufferDenoiserDesc.bindTextureUAV(3, this.emissive);
            gbufferDenoiserDesc.bindTextureUAV(4, this.albedo);
            gbufferDenoiserDesc.bindTextureUAV(5, this.specularAlbedo);
            gbufferDenoiserDesc.bindTextureUAV(6, this.screenSpaceMotionVector);
            gbufferDenoiserDesc.bindTextureUAV(7, this.deviceZ);
            this.gbufferDenoiserSet = this.app.createBindingSetForLayout(gbufferDenoiserDesc, this.gbufferDenoiserLayout);

            const output = this.pathTracerOutput;
            const ptDesc = BindingSetDesc.create();
            ptDesc.bindEntireConstantBuffer(0, this.lightingBuffer);
            ptDesc.bindEntireConstantBuffer(1, this.globalBuffer);
            ptDesc.bindAccelStruct(0, this.rtxcrScene.getTlas());
            ptDesc.bindStructuredBufferSRV(1, this.scene.getBuffer(SceneBuffer.Instances));
            ptDesc.bindStructuredBufferSRV(2, this.scene.getBuffer(SceneBuffer.Geometries));
            ptDesc.bindStructuredBufferSRV(3, this.scene.getBuffer(SceneBuffer.Materials));
            ptDesc.bindTextureSRV(4, Donut_GetLoadedTextureTexture(this.envMap.handle));
            ptDesc.bindStructuredBufferSRV(5, this.rtxcrScene.getMorphTargetMask());
            ptDesc.bindSampler(0, this.app.getCommonSampler(CommonSampler.AnisotropicWrap));
            ptDesc.bindTextureUAV(0, output);
            if (this.useLss) {
                ptDesc.bindNullTypedBufferUAV(NVAPI_SHADER_EXT_SLOT);
            }
            this.ptSet = this.app.createBindingSetForLayout(ptDesc, this.ptLayout);

            const ptDenoiserDesc = BindingSetDesc.create();
            ptDenoiserDesc.bindTextureSRV(0, this.viewZ);
            ptDenoiserDesc.bindTextureSRV(1, this.shadingNormalRoughness);
            ptDenoiserDesc.bindTextureSRV(2, this.motionVector);
            ptDenoiserDesc.bindTextureSRV(3, this.emissive);
            ptDenoiserDesc.bindTextureSRV(4, this.albedo);
            ptDenoiserDesc.bindTextureSRV(5, this.specularAlbedo);
            ptDenoiserDesc.bindTextureSRV(6, this.screenSpaceMotionVector);
            ptDenoiserDesc.bindTextureSRV(7, this.deviceZ);
            ptDenoiserDesc.bindTextureUAV(0, this.noisyDiffuse);
            ptDenoiserDesc.bindTextureUAV(1, this.noisySpecular);
            ptDenoiserDesc.bindTextureUAV(2, this.specularHitDistance);
            this.ptDenoiserSet = this.app.createBindingSetForLayout(ptDenoiserDesc, this.ptDenoiserLayout);

            const nrdDesc = BindingSetDesc.create();
            nrdDesc.bindEntireConstantBuffer(0, this.globalBuffer);
            nrdDesc.bindTextureUAV(0, output);
            this.nrdSet = this.app.createBindingSetForLayout(nrdDesc, this.nrdLayout);
            // The packing reads the noisy radiance and writes it back packed; the compositing reads what NRD denoised.
            for (let pass = 0; pass < 2; pass++) {
                const desc = BindingSetDesc.create();
                desc.bindTextureUAV(0, pass == 0 ? this.noisyDiffuse : this.denoisedDiffuse);
                desc.bindTextureUAV(1, pass == 0 ? this.noisySpecular : this.denoisedSpecular);
                desc.bindTextureUAV(2, this.viewZ);
                desc.bindTextureUAV(3, this.shadingNormalRoughness);
                desc.bindTextureUAV(4, this.motionVector);
                desc.bindTextureUAV(5, this.emissive);
                desc.bindTextureUAV(6, this.albedo);
                desc.bindTextureUAV(7, this.specularAlbedo);
                const set = this.app.createBindingSetForLayout(desc, this.nrdTexturesLayout);
                if (pass == 0) {
                    this.nrdPackSet = set;
                } else {
                    this.nrdCompositeSet = set;
                }
            }

            const tonemapDesc = BindingSetDesc.create();
            tonemapDesc.bindEntireConstantBuffer(0, this.globalBuffer);
            tonemapDesc.bindTextureUAV(0, this.postProcessing);
            tonemapDesc.bindTextureUAV(1, this.accumulation);
            tonemapDesc.bindTextureSRV(0, this.denoiserValidation);
            this.tonemapSet = this.app.createBindingSetForLayout(tonemapDesc, this.tonemapLayout);
        }

        // True while the frame is denoised: the window asks for it and NRD is there (see prepareDenoiser).
        denoising() {
            return this.settings.enableDenoiser && !this.nrd.isNull();
        }

        // Makes, replaces or drops NRD to match the window's choice. A new one has no history.
        prepareDenoiser() {
            const wanted = this.settings.enableDenoiser ? this.settings.nrdMode : -1;
            if (wanted == this.nrdMethod) {
                return;
            }
            this.app.waitForIdle();
            if (!this.nrd.isNull()) {
                this.nrd.destroy();
                this.nrd = new RtxcrNrd(null);
            }
            this.nrdMethod = wanted;
            this.resetDenoiser = true;
            if (wanted >= 0) {
                this.nrd = RtxcrNrd.create(this.app.getNvrhiDevice(), wanted, this.width, this.height);
                if (this.nrd.isNull()) {
                    console.log("Cannot create the NRD denoiser");
                    this.settings.enableDenoiser = false;
                    this.nrdMethod = -1;
                }
            }
        }

        // The sample's NrdDenoiser::Dispatch: the noisy radiance is packed for NRD (demodulated by the albedos), NRD
        // denoises it, and the composite pass modulates the result by the albedos again and adds the emission, into
        // the path tracer's output.
        denoise(commandList: CommandList, width: int, height: int) {
            const settings = this.settings;
            this.nrd.setSetting(0, settings.nrdDisocclusionThreshold);
            this.nrd.setSetting(2, settings.nrdAntiFirefly ? 1.0 : 0.0);
            this.nrd.setSetting(3, settings.nrdValidation ? 1.0 : 0.0);
            this.nrd.setSetting(4, settings.nrdSplitScreen);

            const groupsX = Math.floor((width + 15) / 16);
            const groupsY = Math.floor((height + 15) / 16);
            const method = this.nrdMethod;
            commandList.dispatchWithBindingSets(this.nrdPackPipeline[method], this.nrdSet, this.nrdPackSet, groupsX, groupsY, 1);
            this.nrd.denoise(commandList.handle, this.motionVector, this.shadingNormalRoughness, this.viewZ, this.noisyDiffuse,
                this.noisySpecular, this.denoisedDiffuse, this.denoisedSpecular, this.denoiserValidation, this.view.handle,
                this.previousView.handle, -this.jitterX, -this.jitterY, -this.previousJitterX, -this.previousJitterY,
                this.frameCounter, this.resetDenoiser);
            this.resetDenoiser = false;
            commandList.dispatchWithBindingSets(this.nrdCompositePipeline[method], this.nrdSet, this.nrdCompositeSet, groupsX, groupsY, 1);
        }

        // The sample's SampleRenderer::updateConstantBuffers: the lighting and global constants.
        updateConstants(commandList: CommandList, width: int, height: int) {
            const settings = this.settings;
            const lighting = this.lighting;
            const lightingData = lighting.data;

            // Camera and views: the previous frame's is the one before the camera moved.
            this.camera.getWorldToView(Ref(this.viewMatrix[0]));
            const projection = perspProjD3DStyleReverse(this.sceneCameraVerticalFov, width / height, this.sceneCameraZNear);
            for (let i = 0; i < 16; i++) {
                this.projMatrix[i] = projection[i];
            }
            this.view.setPlanarView(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);
            if (!this.previousViewValid) {
                this.previousView.copyPlanarView(this.view);
            }

            // Any camera movement restarts the accumulation.
            let moved = false;
            for (let i = 0; i < 16; i++) {
                if (this.viewMatrix[i] != this.lastViewMatrix[i]) {
                    moved = true;
                }
                this.lastViewMatrix[i] = this.viewMatrix[i];
            }
            if (moved) {
                this.resetAccumulation = true;
            }

            const skyColor = settings.enableSky ? settings.skyColor : [0.0, 0.0, 0.0];
            lighting.setFloat3(0, skyColor);
            lighting.setFloat(12, 1.0);

            const lightCount = Math.min(this.lights.length, MAX_LIGHTS);
            lighting.setInt(L_LIGHT_COUNT, lightCount);
            this.view.fillPlanarViewConstants(Ref(lightingData[L_VIEW / 4]));
            this.previousView.fillPlanarViewConstants(Ref(lightingData[(L_VIEW + this.viewConstantsSize) / 4]));
            const sunOffset = L_VIEW + this.viewConstantsSize * 2;
            this.sunLight.fillConstants(Ref(lightingData[sunOffset / 4]));
            const lightsOffset = sunOffset + this.lightConstantsSize * 2;
            for (let i = 0; i < lightCount; i++) {
                this.lights[i].fillConstants(Ref(lightingData[(lightsOffset + i * this.lightConstantsSize) / 4]));
            }
            commandList.writeBuffer(this.lightingBuffer, Ref(lightingData[0]), lighting.byteSize);

            const g = this.global;
            // The Halton jitter, as the sample's Halton_DLSS mode (no upscaler).
            const jitter = haltonPixelOffset(this.frameCounter);
            g.setFloat(G_JITTER_OFFSET, jitter[0]);
            g.setFloat(G_JITTER_OFFSET + 4, jitter[1]);
            this.previousJitterX = this.jitterX;
            this.previousJitterY = this.jitterY;
            this.jitterX = jitter[0];
            this.jitterY = jitter[1];
            g.setBool(G_ENABLE_BACK_FACE_CULL, settings.enableBackFaceCull);
            g.setInt(G_BOUNCES_MAX, settings.bouncesMax);
            g.setInt(G_FRAME_INDEX, this.frameCounter);
            this.frameCounter++;
            // The denoiser takes the place of accumulating samples.
            const accumulate = settings.enableAccumulation && !this.denoising();
            g.setBool(G_ENABLE_ACCUMULATION, accumulate);
            g.setInt(G_ACCUMULATED_FRAMES_MAX, this.resetAccumulation ? 1 : 128);
            g.setFloat(G_RECIP_ACCUMULATED_FRAMES, accumulate ? 1.0 / this.accumulatedFrameCount : 1.0);
            g.setBool(G_ENABLE_DENOISER, this.denoising());
            g.setBool(G_ENABLE_DENOISER_VALIDATION_LAYER, this.denoising() && settings.nrdValidation);
            if (this.denoising()) {
                // ReBLUR's A, B and C: the shaders normalize the radiance's hit distance with them.
                g.setFloat(G_NRD_HIT_DISTANCE_PARAMS, this.nrd.getHitDistanceParameter(0));
                g.setFloat(G_NRD_HIT_DISTANCE_PARAMS + 4, this.nrd.getHitDistanceParameter(1));
                g.setFloat(G_NRD_HIT_DISTANCE_PARAMS + 8, this.nrd.getHitDistanceParameter(2));
                g.setFloat(G_NRD_HIT_DISTANCE_PARAMS + 12, 0.0);
            }
            g.setFloat(G_ENVIRONMENT_LIGHT_INTENSITY, settings.environmentLightIntensity);
            g.setBool(G_ENABLE_EMISSIVES, settings.enableEmissives);
            g.setBool(G_ENABLE_LIGHTING, settings.enableLighting);
            g.setBool(G_ENABLE_DIRECT_LIGHTING, settings.enableDirectLighting);
            g.setBool(G_ENABLE_INDIRECT_LIGHTING, settings.enableIndirectLighting);
            g.setBool(G_ENABLE_TRANSMISSION, settings.enableTransmission);
            g.setBool(G_ENABLE_TRANSPARENT_SHADOWS, settings.enableTransparentShadows);
            g.setBool(G_ENABLE_SOFT_SHADOWS, settings.enableSoftShadows);
            g.setFloat(G_THROUGHPUT_THRESHOLD, settings.throughputThreshold);
            g.setBool(G_ENABLE_RUSSIAN_ROULETTE, settings.enableRussianRoulette);
            g.setInt(G_SAMPLES_PER_PIXEL, settings.samplesPerPixel);
            g.setFloat(G_EXPOSURE_SCALE, Math.pow(2.0, settings.exposureAdjustment));
            g.setBool(G_CLAMP, settings.toneMappingClamp);
            g.setInt(G_TONE_MAPPING_OPERATOR, settings.toneMappingOperator);

            // Hair
            g.setBool(G_ENABLE_HAIR, settings.enableHair);
            g.setBool(G_ENABLE_HAIR_MATERIAL_OVERRIDE, settings.enableHairMaterialOverride);
            g.setInt(G_HAIR_MODE, settings.hairTechSelection);
            g.setFloat3(G_HAIR_BASE_COLOR, settings.hairBaseColor);
            g.setBool(G_ANALYTICAL_FRESNEL, settings.analyticalFresnel);
            g.setFloat(G_LONGITUDINAL_ROUGHNESS, settings.longitudinalRoughness);
            g.setFloat(G_AZIMUTHAL_ROUGHNESS,
                settings.anisotropicRoughness ? settings.azimuthalRoughness : settings.longitudinalRoughness);
            g.setFloat(G_HAIR_IOR, settings.hairIor);
            g.setFloat(G_CUTICLE_ANGLE_IN_DEGREES, settings.cuticleAngleInDegrees);
            g.setInt(G_ABSORPTION_MODEL, settings.hairAbsorptionModel);
            g.setFloat(G_MELANIN, settings.melanin);
            g.setFloat(G_MELANIN_REDNESS, settings.melaninRedness);
            g.setFloat(G_HAIR_ROUGHNESS, settings.hairRoughness);
            g.setFloat3(G_DIFFUSE_REFLECTION_TINT, settings.diffuseReflectionTint);
            g.setFloat(G_DIFFUSE_REFLECTION_WEIGHT, settings.diffuseReflectionWeight);
            g.setInt(G_WHITE_FURNACE_SAMPLE_COUNT, settings.whiteFurnaceSampleCount);

            // Skin
            g.setBool(G_ENABLE_SSS, settings.enableSss);
            g.setBool(G_ENABLE_SSS_INDIRECT, settings.enableSssIndirect);
            g.setBool(G_ENABLE_SSS_MATERIAL_OVERRIDE, settings.enableSssMaterialOverride);
            g.setInt(G_SSS_SAMPLE_COUNT, settings.sssSampleCount);
            g.setBool(G_USE_MATERIAL_SPECULAR_ALBEDO_AS_SSS_TRANSMISSION, settings.useMaterialSpecularAlbedoAsSssTransmission);
            g.setBool(G_USE_MATERIAL_DIFFUSE_ALBEDO_AS_SSS_TRANSMISSION, settings.useMaterialDiffuseAlbedoAsSssTransmission);
            g.setBool(G_ENABLE_SSS_TRANSMISSION, settings.enableSssTransmission);
            g.setFloat3(G_SSS_TRANSMISSION_COLOR, settings.sssTransmissionColor);
            g.setFloat3(G_SSS_SCATTERING_COLOR, settings.sssScatteringColor);
            g.setFloat(G_SSS_SCALE, Math.max(settings.sssScale, 1e-7));
            g.setBool(G_FORCE_LAMBERTIAN_BRDF, settings.forceLambertianBrdf);
            g.setFloat(G_MAX_SAMPLE_RADIUS, settings.maxSampleRadius);
            g.setFloat(G_SSS_ANISOTROPY, Math.min(Math.max(settings.sssAnisotropy, -0.999), 0.999));
            g.setInt(G_SSS_TRANSMISSION_BSDF_SAMPLE_COUNT, settings.sssTransmissionBsdfSampleCount);
            g.setInt(G_SSS_TRANSMISSION_PER_BSDF_SCATTERING_SAMPLE_COUNT, settings.sssTransmissionPerBsdfScatteringSampleCount);
            g.setBool(G_ENABLE_SINGLE_SCATTERING_DIFFUSION_PROFILE_CORRECTION, settings.enableSingleScatteringDiffusionProfileCorrection);
            g.setBool(G_ENABLE_SSS_MICROFACET, settings.enableSssMicrofacet);
            const sssWeightSum = settings.sssWeight + settings.sssSpecularWeight;
            const sssWeightSumRcp = sssWeightSum > 1e-7 ? 1.0 / sssWeightSum : 0.0;
            g.setFloat(G_SSS_WEIGHT, settings.enableSssMicrofacet ? settings.sssWeight * sssWeightSumRcp : 1.0);
            g.setFloat(G_SSS_SPECULAR_WEIGHT, settings.sssSpecularWeight * sssWeightSumRcp);
            g.setBool(G_ENABLE_SSS_ROUGHNESS_OVERRIDE, settings.enableSssRoughnessOverride);
            g.setFloat(G_SSS_ROUGHNESS_OVERRIDE, settings.sssRoughnessOverride);
            g.setBool(G_ENABLE_SSS_DEBUG, settings.enableSssDebug);
            g.setBool(G_ENABLE_DIFFUSION_PROFILE, settings.enableDiffusionProfile);
            g.setInt(G_SSS_DEBUG_COORDINATE, 960);
            g.setInt(G_SSS_DEBUG_COORDINATE + 4, 540);

            // Sky
            this.rtxcrScene.fillSkyParameters(this.sunLight.handle, skyColor[0], skyColor[1], skyColor[2], settings.enableSky,
                settings.skyType, Ref(g.data[G_SKY_PARAMS / 4]));

            g.setInt(G_TARGET_LIGHT, -1);
            g.setBool(G_ENABLE_ANIMATION, settings.enableAnimations);
            g.setInt(G_DEBUG_OUTPUT_MODE, 0);
            g.setFloat(G_DEBUG_SCALE, 1.0);
            g.setFloat(G_DEBUG_MIN, 0.0);
            g.setFloat(G_DEBUG_MAX, 10000.0);
            commandList.writeBuffer(this.globalBuffer, Ref(g.data[0]), g.byteSize);
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            this.camera.setMoveSpeed(this.settings.cameraSpeed);
            this.settings.accumulatedFrames = this.accumulatedFrameCount;
            this.settings.morphTargetCount = this.morphTargetCount;
            this.settings.frameSeconds = this.app.getAverageFrameTime();
            if (this.settings.dirty) {
                this.resetAccumulation = true;
                this.resetDenoiser = true;
                this.settings.dirty = false;
            }

            if (this.targetsReady && (width != this.width || height != this.height)) {
                this.releaseTargets();
            }

            if (!this.targetsReady) {
                this.createTargets(width, height);
                this.createBindingSets();
            }
            this.prepareDenoiser();
            if (!this.tonemapPipelineReady) {
                const desc = GraphicsPipelineDesc.create(this.tonemapVS, this.tonemapPS);
                desc.addBindingLayout(this.tonemapLayout);
                desc.setPrimitiveType(PrimitiveType.TriangleStrip);
                desc.setDepthState(0, 0, ComparisonFunc.Always);
                desc.setRasterState(CullMode.None, FillMode.Solid, 0);
                this.tonemapPipeline = this.app.createGraphicsPipelineFromDescForFrame(desc, frame);
                this.tonemapPipelineReady = true;
            }

            // The sample clears its outputs each frame.
            const output = this.pathTracerOutput;
            const cleared: TextureHandle[] = [];
            cleared.push(output);
            cleared.push(this.emissive);
            cleared.push(this.albedo);
            cleared.push(this.specularAlbedo);
            cleared.push(this.viewZ);
            cleared.push(this.motionVector);
            cleared.push(this.shadingNormalRoughness);
            cleared.push(this.noisyDiffuse);
            cleared.push(this.noisySpecular);
            for (let i = 0; i < cleared.length; i++) {
                Donut_ClearTextureFloat(commandList.handle, cleared[i], 0.0, 0.0, 0.0, 0.0);
            }

            this.app.refreshScene(frame, this.scene);

            // Animation: the hair's vertices and their structures follow the keyframes, the
            // instances their nodes; the samples accumulated so far are of another picture.
            if (this.settings.enableAnimations) {
                this.resetAccumulation = true;
                if (this.morphTargetCount > 0) {
                    this.rtxcrScene.animateMorphTargets(commandList.handle, this.frameCounter, this.elapsedSeconds,
                        Math.max(1.0 / this.settings.animationFps, 0.001), this.settings.enableAnimationDebugging,
                        this.settings.animationKeyFrameIndexOverride, this.settings.animationKeyFrameWeightOverride,
                        this.settings.enableAnimationSmoothing ? this.settings.animationSmoothingFactor : 1.0);
                }
                this.rtxcrScene.buildTlas(commandList.handle, this.settings.showEmissiveSurfaces);
            }
            this.updateConstants(commandList, width, height);

            frame.dispatchRaysWithBindingSets(this.gbufferTable, this.gbufferSet, this.gbufferDenoiserSet, this.descriptorTable,
                width, height);
            frame.dispatchRaysWithBindingSets(this.ptTable, this.ptSet, this.ptDenoiserSet, this.descriptorTable, width, height);
            if (this.denoising()) {
                this.denoise(commandList, width, height);
            }

            // The sample's PathTracingPass accumulation counter.
            this.accumulatedFrameCount++;
            if (this.resetAccumulation) {
                this.accumulatedFrameCount = 1;
            }
            this.resetAccumulation = false;

            // Tone mapping reads the copy of the path tracer's output.
            commandList.copyTextureRegion(this.postProcessing, 0, 0, 0, output, 0, 0, 0, width, height);
            frame.beginDraw(this.tonemapPipeline);
            frame.drawAddBindingSet(this.tonemapSet);
            frame.drawVertices(4);

            this.previousView.copyPlanarView(this.view);
            this.previousViewValid = true;
        }
    }

    // -test: checks the last frame: the lit head and the environment around it.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        return check.share(total - check.countInRange(0, 3, 0, 3, 0, 3, 0, 0, check.width, check.height), total,
            50.0, 100.0, "Lit");
    }

    class RtxcrArgs extends Args {
        // -hairTessellationType <0 polytubes, 1 DOTS, 2 LSS>
        hairTessellationType: int = HairTessellation.Lss;
        // -hairRadiusScale <scale>: the sample's ui.hairRadiusScale.
        hairRadiusScale: number = 0.618;
        // -width / -height of the window.
        width: int = 1920;
        height: int = 1080;
        // -noAccumulate: shows every frame as rendered.
        accumulate: boolean = true;
        // -switchTessellation <type>: the window's tessellation choice, made after the first frames (a test of
        // changing it while running).
        switchTessellation: int = -1;
        // -enableAnimation <0 or 1>: the sample's option; Space toggles it.
        enableAnimation: boolean = false;
        // -denoiser <0 or 1>: NRD instead of accumulating samples (the sample's -denoiser 1), and
        // -nrdMode <0 ReBLUR, 1 ReLAX> its method.
        denoiser: boolean = false;
        nrdMode: int = 0;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-noAccumulate") {
                    this.accumulate = false;
                } else if (i + 1 < this.argc) {
                    if (arg == "-hairTessellationType") {
                        this.hairTessellationType = parseInt(this[i + 1]);
                    } else if (arg == "-hairRadiusScale") {
                        this.hairRadiusScale = parseFloat(this[i + 1]);
                    } else if (arg == "-width") {
                        this.width = parseInt(this[i + 1]);
                    } else if (arg == "-height") {
                        this.height = parseInt(this[i + 1]);
                    } else if (arg == "-switchTessellation") {
                        this.switchTessellation = parseInt(this[i + 1]);
                    } else if (arg == "-enableAnimation") {
                        this.enableAnimation = parseInt(this[i + 1]) != 0;
                    } else if (arg == "-denoiser") {
                        this.denoiser = parseInt(this[i + 1]) != 0;
                    } else if (arg == "-nrdMode") {
                        this.nrdMode = parseInt(this[i + 1]);
                    }
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        Donut_SetAppName("rtxcr_pathtracer");

        // -frames <n>: the frames -test renders.
        let testFrames = TEST_FRAMES;
        for (let i = 1; i + 1 < argc; i++) {
            if (Donut_GetArg(argv, i) == "-frames") {
                testFrames = parseInt(Donut_GetArg(argv, i + 1));
            }
        }
        const args = new RtxcrArgs(argc, argv, testFrames);
        args.parseArgs();

        if (args.scenePath == "") {
            console.log("Pass the scene with --scene <RTXCR_DIR>/assets/claire.scene.json");
            return 1;
        }

        const app = App.createWithOptions(args.api, WINDOW_TITLE, args.width, args.height, AppOptions.RayTracing | args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        if (!app.isFeatureSupported(Feature.RayTracingPipeline)) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support Ray Tracing Pipelines");
        }
        console.log(`Renderer: ${app.getRendererString()}`);

        // LSS hair needs the device's support and the shaders' NVAPI extensions: D3D12 only (the sample's
        // shaders of the other APIs have none); else the sample's fallback, DOTS.
        const settings = new Settings();
        settings.lssSupported = args.api == GraphicsAPI.D3D12 && app.isFeatureSupported(Feature.LinearSweptSpheres) &&
            app.isFeatureSupported(Feature.HlslExtensionUAV);
        let hairTessellationType = args.hairTessellationType;
        if (hairTessellationType == HairTessellation.Lss && !settings.lssSupported) {
            console.log("Linear swept spheres aren't available here: the hair is DOTS");
            hairTessellationType = HairTessellation.Dots;
        }
        settings.hairTessellationType = hairTessellationType;
        settings.enableAccumulation = args.accumulate;
        settings.enableAnimations = args.enableAnimation;
        settings.enableDenoiser = args.denoiser;
        settings.nrdMode = args.nrdMode;
        settings.switchTessellation = args.switchTessellation;
        const renderer = new Renderer(app, settings, args.scenePath, hairTessellationType, args.hairRadiusScale);
        if (!renderer.init()) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);
        if (!args.noUI) {
            const ui = new UserInterface(settings);
            if (!ui.init(app)) {
                app.destroy();
                return 1;
            }
        }

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(checkFrame(app));
        }
        renderer.shutdown();
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RtxcrPathtracer.main(argc, argv);
}

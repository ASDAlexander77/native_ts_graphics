// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";
import { RtxcrScene } from "../core/rtxcr_scene";
import { perspProjD3DStyleReverse } from "../core/matrix";

// Port of NVIDIA's RTX Character Rendering pathtracer sample (github.com/NVIDIA-RTX/RTXCR), which
// is under the NVIDIA RTX SDKs License: build with RTXCR_DIR set to a checkout (CMakeLists.txt) and
// run with --scene <RTXCR_DIR>/assets/claire.scene.json. This software contains source code
// provided by NVIDIA Corporation.
//
// A path tracer for hair and skin: a G-buffer pass and the path tracing pass (the sample's shaders,
// compiled in place from the checkout) over the scene's acceleration structures, the hair curves
// tessellated into polytubes, DOTS or linear swept spheres (core/rtxcr.cpp), accumulating samples
// while the camera stands still, then tone mapped. The sample's denoisers (NRD, DLSS ray
// reconstruction), upscalers and frame generation are not ported.
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

    // --- Renderer ----------------------------------------------------------------------------

    // The sample's SampleRenderer with its resource manager, G-buffer, path tracing and
    // post-processing passes.
    class Renderer {
        private app: App;
        private settings: Settings;
        private scenePath: string;
        private hairTessellationType: int;
        private hairRadiusScale: number;
        // Whether the hair is linear swept spheres, which the shaders reach through NVAPI (D3D12).
        private useLss: boolean;

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
        private morphTargetMask: BufferHandle;

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
        private gbufferSet: BindingSet;
        private gbufferDenoiserSet: BindingSet;
        private ptSet: BindingSet;
        private ptDenoiserSet: BindingSet;
        private tonemapSet: BindingSet;

        private accelStructsBuilt: boolean;
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
            this.useLss = hairTessellationType == HairTessellation.Lss;
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
            this.accelStructsBuilt = false;
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

            // The sample's morph target meta data: one uint per instance, 0 for the static scene.
            const instanceCount = this.scene.getInstanceCount();
            const mask: int[] = [];
            for (let i = 0; i < instanceCount; i++) {
                mask.push(0);
            }
            const uploadList = this.app.createCommandList();
            uploadList.open();
            this.morphTargetMask = this.app.createStaticShaderBuffer(uploadList, Ref(mask[0]), instanceCount * 4, 4,
                "Instance Morph Target Meta Data");
            uploadList.close();
            this.app.executeCommandList(uploadList);
            this.app.waitForIdle();
            this.app.releaseResource(uploadList.handle);

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
            this.rtxcrScene.destroy();
        }

        onKey(key: Key, scancode: ScanCode, action: Action, mods: KeyMods) {
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

        onAnimate(elapsedSeconds: number) {
            this.camera.animate(elapsedSeconds);
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

        createBindingSets() {
            const gbufferDesc = BindingSetDesc.create();
            gbufferDesc.bindEntireConstantBuffer(0, this.lightingBuffer);
            gbufferDesc.bindEntireConstantBuffer(1, this.globalBuffer);
            gbufferDesc.bindAccelStruct(0, this.rtxcrScene.getTlas());
            gbufferDesc.bindStructuredBufferSRV(1, this.scene.getBuffer(SceneBuffer.Instances));
            gbufferDesc.bindStructuredBufferSRV(2, this.scene.getBuffer(SceneBuffer.Geometries));
            gbufferDesc.bindStructuredBufferSRV(3, this.scene.getBuffer(SceneBuffer.Materials));
            gbufferDesc.bindStructuredBufferSRV(4, this.morphTargetMask);
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
            ptDesc.bindStructuredBufferSRV(5, this.morphTargetMask);
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

            const tonemapDesc = BindingSetDesc.create();
            tonemapDesc.bindEntireConstantBuffer(0, this.globalBuffer);
            tonemapDesc.bindTextureUAV(0, this.postProcessing);
            tonemapDesc.bindTextureUAV(1, this.accumulation);
            tonemapDesc.bindTextureSRV(0, this.denoiserValidation);
            this.tonemapSet = this.app.createBindingSetForLayout(tonemapDesc, this.tonemapLayout);
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
            g.setBool(G_ENABLE_BACK_FACE_CULL, settings.enableBackFaceCull);
            g.setInt(G_BOUNCES_MAX, settings.bouncesMax);
            g.setInt(G_FRAME_INDEX, this.frameCounter);
            this.frameCounter++;
            g.setBool(G_ENABLE_ACCUMULATION, settings.enableAccumulation);
            g.setInt(G_ACCUMULATED_FRAMES_MAX, this.resetAccumulation ? 1 : 128);
            g.setFloat(G_RECIP_ACCUMULATED_FRAMES,
                settings.enableAccumulation ? 1.0 / this.accumulatedFrameCount : 1.0);
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
            g.setBool(G_ENABLE_ANIMATION, false);
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

            if (this.targetsReady && (width != this.width || height != this.height)) {
                this.releaseTargets();
            }

            // The acceleration structures over the scene's hair and surfaces, built once.
            if (!this.accelStructsBuilt) {
                this.rtxcrScene.buildAccelStructs(commandList.handle, true);
                this.rtxcrScene.buildTlas(commandList.handle, this.settings.showEmissiveSurfaces);
                this.accelStructsBuilt = true;
            }

            if (!this.targetsReady) {
                this.createTargets(width, height);
                this.createBindingSets();
            }
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
            cleared.push(this.postProcessing);
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
            this.updateConstants(commandList, width, height);

            frame.dispatchRaysWithBindingSets(this.gbufferTable, this.gbufferSet, this.gbufferDenoiserSet, this.descriptorTable,
                width, height);
            frame.dispatchRaysWithBindingSets(this.ptTable, this.ptSet, this.ptDenoiserSet, this.descriptorTable, width, height);

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
                    }
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        Donut_SetAppName("rtxcr_pathtracer");

        const args = new RtxcrArgs(argc, argv, TEST_FRAMES);
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
        let hairTessellationType = args.hairTessellationType;
        if (hairTessellationType == HairTessellation.Lss &&
            !(args.api == GraphicsAPI.D3D12 && app.isFeatureSupported(Feature.LinearSweptSpheres) &&
                app.isFeatureSupported(Feature.HlslExtensionUAV))) {
            console.log("Linear swept spheres aren't available here: the hair is DOTS");
            hairTessellationType = HairTessellation.Dots;
        }

        const settings = new Settings();
        settings.enableAccumulation = args.accumulate;
        const renderer = new Renderer(app, settings, args.scenePath, hairTessellationType, args.hairRadiusScale);
        if (!renderer.init()) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

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

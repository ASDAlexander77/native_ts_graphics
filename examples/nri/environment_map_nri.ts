/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { perspProjD3DStyleReverse } from "../../core/matrix";
import { DonutFirstPersonCamera } from "../../core/donut_first_person_camera";
import { DonutSceneTextures } from "../../core/nri_donut_textures";

namespace EnvironmentMapNri {
    // environment_map, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: Donut's passes' shaders (shadow depth, forward shading, environment map, tone
    // mapping, blit: shaders/framework, as Donut compiles them), the scene loaded as Donut's engine
    // loads it (core/nri/nri_donut_scene.cpp, core/nri_donut_textures.ts), the constants filled as
    // Donut fills them (core/nri/nri_donut_constants.cpp), through the NRI calls
    // core/nri/nri_interop.d.ts binds. This example creates everything it runs, and does the
    // rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Environment Map";
    const DEFAULT_SCENE = "media/glTF-Sample-Assets/Models/Sponza/glTF/Sponza.gltf";
    // A lat-long BC7 environment map (Donut-Samples' rt_particles one). (The Donut example's -ktx2
    // loads the same blocks from a Zstandard-supercompressed KTX 2 file through Donut's loader, which
    // isn't ported.)
    const ENVIRONMENT_MAP = "media/rt_particles/environment-map.dds";

    // The sun (Donut_AddDirectionalLight's arguments in the Donut example).
    const SUN_DIRECTION = [0.35, -1.0, 0.2];
    const SUN_ANGULAR_SIZE = 0.53;
    const SUN_IRRADIANCE = 2.0;

    // One shadow map over the whole scene; shadows fade out over the last FADE_RANGE world units at
    // its edges. Donut's shadow depth pass's biases (Donut_CreateShadowDepthPass(100, 4)).
    const SHADOW_MAP_RESOLUTION = 4096;
    const SHADOW_FADE_RANGE = 0.5;
    const SHADOW_DEPTH_BIAS = 100.0;
    const SHADOW_SLOPE_SCALED_DEPTH_BIAS = 4.0;

    // A fixed exposure (the adapted luminance tone mapping divides by; no eye adaptation: the frame
    // time is 0), and the ambient light from above and below.
    const EXPOSURE = 0.2;
    const AMBIENT_TOP = 0.15;
    const AMBIENT_BOTTOM = 0.05;

    // The Donut example's camera: Donut's FirstPersonCamera, under the open roof looking up past the
    // arches at the sky; reversed depth from 0.1, a 45 degree field of view.
    const MOVE_SPEED = 3.0;
    const ROTATE_SPEED = 0.005;
    const Z_NEAR = 0.1;

    // ForwardPushConstants (forward_cb.h): startInstanceLocation, startVertexLocation, then the
    // position, texture coordinate, normal and tangent streams' offsets. DepthPushConstants
    // (depth_cb.h): the first four.
    const FORWARD_PUSH_WORDS = 6;
    const DEPTH_PUSH_WORDS = 4;

    // Donut's blit (CommonRenderPasses::BlitTexture): struct BlitConstants { float2 sourceOrigin,
    // sourceSize, targetOrigin, targetSize; float sharpenFactor; }.
    const BLIT_CONSTANTS: f32[] = [0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0];

    // Donut's tone mapping histogram (HISTOGRAM_BINS) and its compute shaders' groups (16 x 16).
    const HISTOGRAM_BINS = 256;
    const TONE_MAPPING_GROUP_SIZE = 16;

    // Material domains: what InstancedOpaqueDrawStrategy draws (MaterialDomain_Opaque,
    // _AlphaTested). The scene's transparent materials (the Donut example's second forward pass)
    // aren't drawn: Sponza has none.
    const DOMAIN_OPAQUE = 0;
    const DOMAIN_ALPHA_TESTED = 1;

    // Constant buffer views' alignment.
    const CONSTANTS_ALIGNMENT = 256;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // -test: checks the last frame, read back, as the Donut example does: Sponza, reflecting the
    // environment map, fills it, with the sky through the roof about 0.8% white.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        let dark = 0;
        let white = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r <= 20 && g <= 20 && b <= 20) {
                dark++;
            }
            if (r >= 221 && g >= 221 && b >= 221) {
                white++;
            }
        }
        const lit = 100.0 * (total - dark) / total;
        const whiteShare = 100.0 * white / total;
        console.log(`Lit: ${lit}%`);
        console.log(`White: ${whiteShare}%`);
        if (lit < 95.0) {
            return `Lit: ${lit}% of the pixels, not 95% to 100%`;
        }
        if (whiteShare < 0.3 || whiteShare > 2.0) {
            return `White: ${whiteShare}% of the pixels, not 0.3% to 2%`;
        }
        return "";
    }

    function align(size: int) {
        return Math.floor((size + CONSTANTS_ALIGNMENT - 1) / CONSTANTS_ALIGNMENT) * CONSTANTS_ALIGNMENT;
    }

    // An f32 array of n zeros.
    function zeros(n: int) {
        const values: f32[] = [];
        for (let i = 0; i < n; i++) {
            values.push(0.0);
        }
        return values;
    }

    // What a frame in flight records into, and its sets (its copies of the per-frame constants).
    class QueuedFrame {
        constructor(public commandBuffer: NriCommandBufferHandle,
            public viewSet: NriDescriptorSetHandle, public skySet: NriDescriptorSetHandle,
            public histogramSet: NriDescriptorSetHandle, public exposureSet: NriDescriptorSetHandle,
            public toneMappingSet: NriDescriptorSetHandle) {
        }
    }

    // A draw of the forward and shadow depth passes: a geometry of an instance with its material.
    class DrawItem {
        constructor(public material: int, public doubleSided: boolean, public alphaTested: boolean, public indexCount: int,
            public firstIndex: int, public forwardPush: f32[], public depthPush: f32[]) {
        }
    }

    // Port of Donut-Samples-style environment_map (as examples/environment_map.ts ports it) to NRI:
    // Donut's forward shading of Sponza lit by a sun, under an environment map: the background is
    // Donut's EnvironmentMapPass (a lat-long texture) drawn where no geometry is, and the sun's
    // shadows come from a PlanarShadowMap fitted to the whole scene, rendered once (the scene and the
    // sun don't move); then Donut's tone mapping with a fixed exposure. Space switches the shadows off
    // and on; WASD/QE and the left mouse button move the camera (Donut's FirstPersonCamera).
    class EnvironmentMap {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        // The swap chain textures' format (their views': viewFormat).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private width: int = 0;
        private height: int = 0;
        private test: boolean = false;
        scenePath: string = DEFAULT_SCENE;
        private enableShadows: boolean = true;

        // The scene and its draws.
        private scene: NriDonutSceneHandle | null = null;
        private vertexBuffer: NriBufferHandle | null = null;
        private vertexBufferView: NriDescriptorHandle | null = null;
        private instanceBuffer: NriBufferHandle | null = null;
        private instanceBufferView: NriDescriptorHandle | null = null;
        private indexBuffer: NriBufferHandle | null = null;
        private materialBuffer: NriBufferHandle | null = null;
        private materialViews: NriDescriptorHandle[] = [];
        // A material's forward set (all its textures) and depth set (base color and opacity).
        private materialSets: NriDescriptorSetHandle[] = [];
        private depthMaterialSets: NriDescriptorSetHandle[] = [];
        private textures: DonutSceneTextures = new DonutSceneTextures();
        private drawItems: DrawItem[] = [];

        // The environment map, the shadow map (D24S8, one layer; rendered in the first frame), the
        // scene targets (SceneRenderTargets': HDR RGBA16F, D24S8 reverse depth, LDR sRGB).
        private environmentMap: NriTextureHandle | null = null;
        private environmentMapView: NriDescriptorHandle | null = null;
        private shadowMap: NriTextureHandle | null = null;
        private shadowMapAttachment: NriDescriptorHandle | null = null;
        private shadowMapView: NriDescriptorHandle | null = null;
        private shadowMapRendered: boolean = false;
        private shadowMirrored: boolean = false;
        private hdrColor: NriTextureHandle | null = null;
        private hdrAttachment: NriDescriptorHandle | null = null;
        private hdrView: NriDescriptorHandle | null = null;
        private depth: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private ldrColor: NriTextureHandle | null = null;
        private ldrAttachment: NriDescriptorHandle | null = null;
        private ldrView: NriDescriptorHandle | null = null;

        // Tone mapping's histogram and exposure (typed R32_UINT buffers) and their views.
        private histogram: NriBufferHandle | null = null;
        private histogramStorage: NriDescriptorHandle | null = null;
        private histogramView: NriDescriptorHandle | null = null;
        private exposure: NriBufferHandle | null = null;
        private exposureStorage: NriDescriptorHandle | null = null;
        private exposureView: NriDescriptorHandle | null = null;

        // CommonRenderPasses' fallbacks: black, a black cubemap array, a depth texture array (the
        // shadow maps' when shadows are off; cleared once).
        private solidTextures: NriTextureHandle[] = [];
        private blackView: NriDescriptorHandle | null = null;
        private blackCubeArrayView: NriDescriptorHandle | null = null;
        private noShadowTexture: NriTextureHandle | null = null;
        private noShadowView: NriDescriptorHandle | null = null;
        private noShadowAttachment: NriDescriptorHandle | null = null;
        private noShadowCleared: boolean = false;

        // The passes' layouts and pipelines: the forward pass's (by cull mode and front face), the
        // shadow depth pass's (by cull mode, alpha test and front face), the environment map's, tone
        // mapping's (histogram, exposure, the tone mapping draw), the blit's.
        private forwardLayout: NriPipelineLayoutHandle | null = null;
        private forwardPipelines: NriPipelineHandle[] = [];
        private depthLayout: NriPipelineLayoutHandle | null = null;
        private depthPipelines: NriPipelineHandle[] = [];
        private skyLayout: NriPipelineLayoutHandle | null = null;
        private skyPipeline: NriPipelineHandle | null = null;
        private histogramLayout: NriPipelineLayoutHandle | null = null;
        private histogramPipeline: NriPipelineHandle | null = null;
        private exposureLayout: NriPipelineLayoutHandle | null = null;
        private exposurePipeline: NriPipelineHandle | null = null;
        private toneMappingLayout: NriPipelineLayoutHandle | null = null;
        private toneMappingPipeline: NriPipelineHandle | null = null;
        private blitLayout: NriPipelineLayoutHandle | null = null;
        private blitPipeline: NriPipelineHandle | null = null;

        // CommonRenderPasses' samplers (anisotropic wrap, linear wrap, linear clamp) and the forward
        // pass's shadow sampler (border, white).
        private anisotropicWrap: NriDescriptorHandle | null = null;
        private linearWrap: NriDescriptorHandle | null = null;
        private linearClamp: NriDescriptorHandle | null = null;
        private shadowSampler: NriDescriptorHandle | null = null;

        // The constant buffer: the static constants (the forward light constants with shadows and
        // without, the depth pass's), then a queued frame's (the view, the sky, tone mapping's three).
        private constantBuffer: NriBufferHandle | null = null;
        private constantViews: NriDescriptorHandle[] = [];
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        // The shading sets (shadows on, off), the depth pass's view set, the blit's set.
        private shadingSets: NriDescriptorSetHandle[] = [];
        private depthViewSet: NriDescriptorSetHandle | null = null;
        private blitSet: NriDescriptorSetHandle | null = null;
        private viewSize: int = 0;
        private skySize: int = 0;
        private toneMappingSize: int = 0;
        private staticStride: int = 0;
        private frameStride: int = 0;

        private camera: DonutFirstPersonCamera = new DonutFirstPersonCamera(MOVE_SPEED, ROTATE_SPEED);
        private viewMatrix: f32[] = zeros(16);
        private projMatrix: f32[] = zeros(16);
        private mirrored: boolean = false;
        private viewConstants: f32[] = [];
        private skyConstants: f32[] = [];
        private toneMappingConstants: f32[] = [];
        private blitConstants: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (const value of BLIT_CONSTANTS) {
                this.blitConstants.push(value);
            }
        }

        // Renders until the window is closed (in test mode, the test's frames); the exit code.
        run(argc: int, argv: Ref<string>): int {
            const initialize: NriInitializeCallback = this.initialize;
            const latencySleep: NriFrameCallback = this.latencySleep;
            const renderFrame: NriFrameCallback = this.renderFrame;
            retainedInitializeCallbacks.push(initialize);
            retainedFrameCallbacks.push(latencySleep);
            retainedFrameCallbacks.push(renderFrame);
            Nri_SetInitializeCallback(this.sample, initialize);
            Nri_SetLatencySleepCallback(this.sample, latencySleep);
            Nri_SetRenderFrameCallback(this.sample, renderFrame);

            let result = Nri_RunSample(this.sample, argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (result == 0 && this.test) {
                const failure = checkFrame(this.readBack(), this.width, this.height);
                console.log(failure == "" ? "Test PASSED" : `Test FAILED: ${failure}`);
                result = failure == "" ? 0 : 1;
            }
            this.destroy();
            return result;
        }

        initialize(graphicsAPI: NriGraphicsAPI): int {
            const device = Nri_CreateDevice(this.sample, graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri_GetGraphicsAPIString(graphicsAPI)} (${Nri_GetAdapterName(device)})`);

            this.queue = Nri_GetGraphicsQueue(device);
            this.test = Nri_IsTest(this.sample) != 0;

            // Swap chain: blitted into through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;

            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            if (!this.loadScene(device, folder, graphicsAPI == NriGraphicsAPI.D3D11) || !this.createTargets(device) || !this.createLayouts(device)
                || !this.createPipelines(device, folder) || !this.createDescriptorSets(device, queuedFrameNum)) {
                return 0;
            }

            this.camera.lookAt(-6.0, 1.8, -0.5, 4.0, 7.0, 0.5);

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The scene, as Donut's engine loads it, its textures, the materials' constants; the draws
        // InstancedOpaqueDrawStrategy makes of it (opaque and alpha-tested materials), by material.
        // The environment map.
        loadScene(device: NriDeviceHandle, folder: string, d3d11: boolean) {
            const scene = Nri_LoadDonutScene(this.scenePath);
            this.scene = scene;
            if (!scene) {
                console.log(`Cannot load the scene ${this.scenePath}`);
                return false;
            }
            const vertexBuffer = Nri_CreateDonutSceneBuffer(device, this.queue, scene, 0);
            // (D3D11's shaders read the instances as a ByteAddressBuffer.)
            const instanceBuffer = Nri_CreateDonutSceneBuffer(device, this.queue, scene, d3d11 ? 6 : 2);
            this.vertexBuffer = vertexBuffer;
            this.instanceBuffer = instanceBuffer;
            this.indexBuffer = Nri_CreateDonutSceneBuffer(device, this.queue, scene, 5);
            this.materialBuffer = Nri_CreateDonutSceneMaterialBuffer(device, scene);
            if (!vertexBuffer || !instanceBuffer || !this.indexBuffer || !this.materialBuffer) {
                console.log("Cannot create the scene's buffers");
                return false;
            }
            this.vertexBufferView = Nri_CreateStructuredBufferView(vertexBuffer, 0);
            this.instanceBufferView = Nri_CreateStructuredBufferView(instanceBuffer, 0);

            const streams: int[] = [];
            for (let stream = 0; stream < 4; stream++) {
                streams.push(Nri_GetDonutSceneStreamOffset(scene, stream));
            }
            // By material (Donut sorts by the materials' addresses), then in the scene's order.
            const materialCount = Nri_GetDonutSceneMaterialCount(scene);
            const instanceCount = Nri_GetDonutSceneInstanceCount(scene);
            for (let drawnMaterial = 0; drawnMaterial < materialCount; drawnMaterial++) {
                const domain = Nri_GetDonutSceneMaterialDomain(scene, drawnMaterial);
                if (domain != DOMAIN_OPAQUE && domain != DOMAIN_ALPHA_TESTED) {
                    continue;
                }
                // DepthPass: alpha-tested materials with a base color or opacity texture run its pixel
                // shader.
                const alphaTested = domain == DOMAIN_ALPHA_TESTED && (Nri_GetDonutSceneMaterialTexture(scene, drawnMaterial, 0) >= 0
                    || Nri_GetDonutSceneMaterialTexture(scene, drawnMaterial, 6) >= 0);
                const doubleSided = Nri_GetDonutSceneMaterialDoubleSided(scene, drawnMaterial) != 0;
                for (let instance = 0; instance < instanceCount; instance++) {
                    const geometryCount = Nri_GetDonutSceneInstanceGeometryCount(scene, instance);
                    for (let geometry = 0; geometry < geometryCount; geometry++) {
                        if (Nri_GetDonutSceneGeometryMaterial(scene, instance, geometry) != drawnMaterial) {
                            continue;
                        }
                        const words = [instance, Nri_GetDonutSceneGeometryFirstVertex(scene, instance, geometry),
                            streams[0], streams[1], streams[2], streams[3]];
                        const forwardPush = zeros(FORWARD_PUSH_WORDS);
                        for (let k = 0; k < FORWARD_PUSH_WORDS; k++) {
                            Nri_StoreInt32(Ref(forwardPush[k]), words[k]);
                        }
                        const depthPush = zeros(DEPTH_PUSH_WORDS);
                        for (let k = 0; k < DEPTH_PUSH_WORDS; k++) {
                            Nri_StoreInt32(Ref(depthPush[k]), words[k]);
                        }
                        this.drawItems.push(new DrawItem(drawnMaterial, doubleSided, alphaTested,
                            Nri_GetDonutSceneGeometryIndexCount(scene, instance, geometry),
                            Nri_GetDonutSceneGeometryFirstIndex(scene, instance, geometry), forwardPush, depthPush));
                    }
                }
            }

            const environmentMap = Nri_LoadDdsTexture(device, this.queue, ENVIRONMENT_MAP, 0);
            this.environmentMap = environmentMap;
            if (!environmentMap) {
                console.log(`Cannot load the environment map ${ENVIRONMENT_MAP}`);
                return false;
            }
            this.environmentMapView = Nri_CreateTextureView(environmentMap, Nri_GetTextureFormat(environmentMap));

            return this.textures.load(device, this.queue, scene, folder);
        }

        // The window-size scene targets: the HDR color, its depth and tone mapping's LDR color, in
        // the states their creation leaves them in (the frames' barriers start from them).
        createSizedTargets(device: NriDeviceHandle): boolean {
            const hdrColor = Nri_CreateRenderTargetTexture(device, this.queue, this.width, this.height, NriFormat.RGBA16_SFLOAT);
            this.hdrColor = hdrColor;
            const depth = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D24_UNORM_S8_UINT);
            this.depth = depth;
            const ldrColor = Nri_CreateRenderTargetTexture(device, this.queue, this.width, this.height, NriFormat.RGBA8_SRGB);
            this.ldrColor = ldrColor;
            if (!hdrColor || !depth || !ldrColor) {
                return false;
            }
            this.hdrAttachment = Nri_CreateColorAttachmentView(hdrColor, NriFormat.RGBA16_SFLOAT);
            this.hdrView = Nri_CreateTextureView(hdrColor, NriFormat.RGBA16_SFLOAT);
            this.depthAttachment = Nri_CreateDepthAttachmentView(depth, NriFormat.D24_UNORM_S8_UINT);
            this.ldrAttachment = Nri_CreateColorAttachmentView(ldrColor, NriFormat.RGBA8_SRGB);
            this.ldrView = Nri_CreateTextureView(ldrColor, NriFormat.RGBA8_SRGB);
            return true;
        }

        destroySizedTargets() {
            const descriptors = [this.hdrAttachment, this.hdrView, this.depthAttachment, this.ldrAttachment, this.ldrView];
            for (const descriptor of descriptors) {
                if (descriptor) {
                    Nri_DestroyDescriptor(descriptor);
                }
            }
            const textures = [this.hdrColor, this.depth, this.ldrColor];
            for (const texture of textures) {
                if (texture) {
                    Nri_DestroyTexture(texture);
                }
            }
            this.hdrAttachment = null;
            this.hdrView = null;
            this.depthAttachment = null;
            this.ldrAttachment = null;
            this.ldrView = null;
            this.hdrColor = null;
            this.depth = null;
            this.ldrColor = null;
        }

        // The sets reading the window-size targets pointed at the new ones: the blit's LDR color, every
        // queued frame's histogram and tone mapping HDR color.
        updateSizedDescriptors() {
            const hdrView = this.hdrView;
            const ldrView = this.ldrView;
            if (!hdrView || !ldrView) {
                return;
            }
            const blitSet = this.blitSet;
            if (blitSet) {
                Nri_UpdateDescriptor(blitSet, 0, 0, ldrView);
            }
            for (const queuedFrame of this.queuedFrames) {
                Nri_UpdateDescriptor(queuedFrame.histogramSet, 1, 0, hdrView);
                Nri_UpdateDescriptor(queuedFrame.toneMappingSet, 1, 0, hdrView);
            }
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (Nri_UseResizableWindow): once the GPU is done with them, the swap
        // chain and the scene targets made again at its size, and the sets pointed at them. The
        // projection, tone mapping's constants and dispatch read the size every frame.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            Nri_DeviceWaitIdle(device);
            this.destroySizedTargets();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            if (this.createSizedTargets(device)) {
                this.updateSizedDescriptors();
            }
        }

        // The shadow map, the scene targets, tone mapping's buffers, the fallbacks.
        createTargets(device: NriDeviceHandle) {
            const shadowMap = Nri_CreateSampledDepthTexture(device, this.queue, SHADOW_MAP_RESOLUTION, SHADOW_MAP_RESOLUTION,
                NriFormat.D24_UNORM_S8_UINT);
            this.shadowMap = shadowMap;
            if (!shadowMap || !this.createSizedTargets(device)) {
                console.log("Cannot create the render targets");
                return false;
            }
            this.shadowMapAttachment = Nri_CreateDepthAttachmentView(shadowMap, NriFormat.D24_UNORM_S8_UINT);
            this.shadowMapView = Nri_CreateTextureArrayView(shadowMap, NriFormat.R24_UNORM_X8);

            // The histogram (zeroed each frame) and the exposure (ToneMappingPass::ResetExposure: the
            // exposure's bits).
            const histogramZeros: int[] = [];
            for (let i = 0; i < HISTOGRAM_BINS; i++) {
                histogramZeros.push(0);
            }
            const histogram = Nri_CreateStorageBufferFromInts(device, this.queue, Ref(histogramZeros[0]), HISTOGRAM_BINS * 4, 0,
                NriBufferState.CopyDestination);
            this.histogram = histogram;
            const exposureValue = zeros(1);
            exposureValue[0] = EXPOSURE;
            const exposure = Nri_CreateStorageBuffer(device, this.queue, Ref(exposureValue[0]), 4, 0);
            this.exposure = exposure;
            if (!histogram || !exposure) {
                console.log("Cannot create tone mapping's buffers");
                return false;
            }
            this.histogramStorage = Nri_CreateTypedBufferView(histogram, NriFormat.R32_UINT, 1);
            this.histogramView = Nri_CreateTypedBufferView(histogram, NriFormat.R32_UINT, 0);
            this.exposureStorage = Nri_CreateTypedBufferView(exposure, NriFormat.R32_UINT, 1);
            this.exposureView = Nri_CreateTypedBufferView(exposure, NriFormat.R32_UINT, 0);

            const black = Nri_CreateSolidTexture(device, this.queue, 1, 0xFF000000, NriTextureState.AllShaderResource);
            const blackCubes = Nri_CreateSolidTexture(device, this.queue, 6, 0xFF000000, NriTextureState.ShaderResource);
            const noShadowTexture = Nri_CreateSampledDepthTexture(device, this.queue, 1, 1, NriFormat.D16_UNORM);
            this.noShadowTexture = noShadowTexture;
            if (!black || !blackCubes || !noShadowTexture) {
                console.log("Cannot create the default textures");
                return false;
            }
            this.solidTextures.push(black);
            this.solidTextures.push(blackCubes);
            this.blackView = Nri_CreateTextureView(black, NriFormat.RGBA8_UNORM);
            this.blackCubeArrayView = Nri_CreateTextureCubeArrayView(blackCubes, NriFormat.RGBA8_UNORM);
            this.noShadowView = Nri_CreateTextureArrayView(noShadowTexture, NriFormat.D16_UNORM);
            this.noShadowAttachment = Nri_CreateDepthAttachmentView(noShadowTexture, NriFormat.D16_UNORM);
            return true;
        }

        // The passes' layouts, as their shaders declare their bindings (Donut's register spaces).
        createLayouts(device: NriDeviceHandle) {
            // Forward shading: 0 the material, 1 the inputs (root), 2 the view, 3 the shading.
            const forwardDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(forwardDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(forwardDesc, 0, 0, 7, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(forwardDesc, 1, 2, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescSetRegisterSpace(forwardDesc, 1, 2);
            Nri_PipelineLayoutDescAddRange(forwardDesc, 2, 3, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(forwardDesc, 2, 20, 4, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(forwardDesc, 2, 0, 4, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescSetRegisterSpace(forwardDesc, 2, 3);
            Nri_PipelineLayoutDescSetRootRegisterSpace(forwardDesc, 1);
            Nri_PipelineLayoutDescAddRootConstants(forwardDesc, 1, FORWARD_PUSH_WORDS * 4, NriStage.Vertex);
            Nri_PipelineLayoutDescAddRootDescriptor(forwardDesc, 10, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            Nri_PipelineLayoutDescAddRootDescriptor(forwardDesc, 11, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            this.forwardLayout = Nri_CreatePipelineLayoutFromDesc(device, forwardDesc);
            Nri_DestroyPipelineLayoutDesc(forwardDesc);

            // Shadow depth: 0 the material (b0, t0 base color, t1 opacity), 1 the inputs (root), 2 the
            // view (b2) and the material sampler (s0).
            const depthDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(depthDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(depthDesc, 0, 0, 2, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(depthDesc, 1, 2, 1, NriDescriptorType.ConstantBuffer, NriStage.Vertex, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(depthDesc, 1, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescSetRegisterSpace(depthDesc, 1, 2);
            Nri_PipelineLayoutDescSetRootRegisterSpace(depthDesc, 1);
            Nri_PipelineLayoutDescAddRootConstants(depthDesc, 1, DEPTH_PUSH_WORDS * 4, NriStage.Vertex);
            Nri_PipelineLayoutDescAddRootDescriptor(depthDesc, 10, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            Nri_PipelineLayoutDescAddRootDescriptor(depthDesc, 11, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            this.depthLayout = Nri_CreatePipelineLayoutFromDesc(device, depthDesc);
            Nri_DestroyPipelineLayoutDesc(depthDesc);

            // The environment map: b0, t0, s0.
            const skyDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(skyDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(skyDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(skyDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.skyLayout = Nri_CreatePipelineLayoutFromDesc(device, skyDesc);
            Nri_DestroyPipelineLayoutDesc(skyDesc);

            // The histogram and exposure compute shaders: b0, t0 (the source texture; the
            // histogram, a typed buffer), u0 (a typed buffer).
            const computeTypes = [NriDescriptorType.Texture, NriDescriptorType.Buffer];
            for (let k = 0; k < 2; k++) {
                const computeDesc = Nri_CreatePipelineLayoutDesc();
                Nri_PipelineLayoutDescAddRange(computeDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Compute, NriRangeFlags.None);
                Nri_PipelineLayoutDescAddRange(computeDesc, 0, 0, 1, computeTypes[k], NriStage.Compute, NriRangeFlags.None);
                Nri_PipelineLayoutDescAddRange(computeDesc, 0, 0, 1, NriDescriptorType.StorageBuffer, NriStage.Compute, NriRangeFlags.None);
                const computeLayout = Nri_CreatePipelineLayoutFromDesc(device, computeDesc);
                Nri_DestroyPipelineLayoutDesc(computeDesc);
                if (k == 0) {
                    this.histogramLayout = computeLayout;
                } else {
                    this.exposureLayout = computeLayout;
                }
            }

            // The tone mapping draw: b0, t0 (the HDR color), t1 (the exposure), t2 (the color LUT),
            // s0.
            const toneMappingDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(toneMappingDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(toneMappingDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(toneMappingDesc, 0, 1, 1, NriDescriptorType.Buffer, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(toneMappingDesc, 0, 2, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(toneMappingDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.toneMappingLayout = Nri_CreatePipelineLayoutFromDesc(device, toneMappingDesc);
            Nri_DestroyPipelineLayoutDesc(toneMappingDesc);

            const blitDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(blitDesc, 0, BLIT_CONSTANTS.length * 4, NriStage.Vertex);
            Nri_PipelineLayoutDescAddRange(blitDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(blitDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.blitLayout = Nri_CreatePipelineLayoutFromDesc(device, blitDesc);
            Nri_DestroyPipelineLayoutDesc(blitDesc);

            if (!this.forwardLayout || !this.depthLayout || !this.skyLayout || !this.histogramLayout || !this.exposureLayout
                || !this.toneMappingLayout || !this.blitLayout) {
                console.log("Cannot create the pipeline layouts");
                return false;
            }
            return true;
        }

        // A fullscreen pass's pipeline (Donut's fullscreen_vs with its quad at depth 0, a pixel shader
        // permutation) into a color attachment of format, depth tested (greater or equal, not written)
        // against D24S8 if depthTested.
        createFullscreenPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, framework: string, ps: string, permutation: string,
            format: NriFormat, depthTested: boolean) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShaderPermutation(desc, NriShaderStage.Vertex, `${framework}/fullscreen_vs.bin`, "main",
                "QUAD_Z=0") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShaderPermutation(desc, NriShaderStage.Pixel, `${framework}/${ps}`, "main", permutation) != 0;
            }
            Nri_PipelineDescSetTopology(desc, NriTopology.TriangleStrip);
            Nri_PipelineDescSetColor(desc, format, NriColorWrite.RGBA);
            if (depthTested) {
                Nri_PipelineDescSetDepth(desc, NriFormat.D24_UNORM_S8_UINT, NriCompareOp.GreaterEqual, 0, 0);
            }
            const pipeline = loaded ? Nri_CreatePipelineFromDesc(device, layout, desc) : null;
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        createPipelines(device: NriDeviceHandle, folder: string) {
            const forwardLayout = this.forwardLayout;
            const depthLayout = this.depthLayout;
            const skyLayout = this.skyLayout;
            const histogramLayout = this.histogramLayout;
            const exposureLayout = this.exposureLayout;
            const toneMappingLayout = this.toneMappingLayout;
            const blitLayout = this.blitLayout;
            if (!forwardLayout || !depthLayout || !skyLayout || !histogramLayout || !exposureLayout || !toneMappingLayout) {
                return false;
            }
            if (!blitLayout) {
                return false;
            }
            const framework = `shaders/framework/${folder}`;

            // Forward shading, by key: bit 0 no culling (double-sided), bit 1 counterclockwise front
            // faces (a mirrored view); reverse depth (greater or equal, written).
            for (let key = 0; key < 4; key++) {
                const desc = Nri_CreatePipelineDesc();
                let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${framework}/passes/forward_vs_buffer_loads.bin`,
                    "buffer_loads") != 0;
                if (loaded) {
                    loaded = Nri_PipelineDescAddShaderPermutation(desc, NriShaderStage.Pixel, `${framework}/passes/forward_ps.bin`, "main",
                        "TRANSMISSIVE_MATERIAL=0") != 0;
                }
                Nri_PipelineDescSetCullMode(desc, (key & 1) != 0 ? NriCullMode.None : NriCullMode.Back);
                Nri_PipelineDescSetFrontCounterClockwise(desc, key >> 1);
                Nri_PipelineDescSetColor(desc, NriFormat.RGBA16_SFLOAT, NriColorWrite.RGBA);
                Nri_PipelineDescSetDepth(desc, NriFormat.D24_UNORM_S8_UINT, NriCompareOp.GreaterEqual, 1, 0);
                const pipeline = loaded ? Nri_CreatePipelineFromDesc(device, forwardLayout, desc) : null;
                Nri_DestroyPipelineDesc(desc);
                if (!pipeline) {
                    console.log("Cannot load the forward shading shaders");
                    return false;
                }
                this.forwardPipelines.push(pipeline);
            }

            // Shadow depth (DepthPass::CreateGraphicsPipeline), by key: bit 0 no culling, bit 1 the
            // alpha test's pixel shader, bit 2 counterclockwise front faces; depth tested less or
            // equal and written, with its biases.
            for (let key = 0; key < 8; key++) {
                const desc = Nri_CreatePipelineDesc();
                let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${framework}/passes/depth_vs_buffer_loads.bin`,
                    "buffer_loads") != 0;
                if (loaded && (key & 2) != 0) {
                    loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${framework}/passes/depth_ps.bin`, "main") != 0;
                }
                Nri_PipelineDescSetCullMode(desc, (key & 1) != 0 ? NriCullMode.None : NriCullMode.Back);
                Nri_PipelineDescSetFrontCounterClockwise(desc, (key >> 2) & 1);
                Nri_PipelineDescSetDepth(desc, NriFormat.D24_UNORM_S8_UINT, NriCompareOp.LessEqual, 1, 0);
                Nri_PipelineDescSetDepthBias(desc, SHADOW_DEPTH_BIAS, 0.0, SHADOW_SLOPE_SCALED_DEPTH_BIAS);
                const pipeline = loaded ? Nri_CreatePipelineFromDesc(device, depthLayout, desc) : null;
                Nri_DestroyPipelineDesc(desc);
                if (!pipeline) {
                    console.log("Cannot load the depth pass shaders");
                    return false;
                }
                this.depthPipelines.push(pipeline);
            }

            // The environment map (a lat-long texture) behind the geometry; tone mapping into the LDR
            // color.
            this.skyPipeline = this.createFullscreenPipeline(device, skyLayout, framework, "passes/environment_map_ps.bin",
                "LATLONG_TEXTURE=1", NriFormat.RGBA16_SFLOAT, true);
            this.toneMappingPipeline = this.createFullscreenPipeline(device, toneMappingLayout, framework, "passes/tonemapping_ps.bin",
                "HISTOGRAM_BINS=256 SOURCE_ARRAY=0", NriFormat.RGBA8_SRGB, false);
            this.histogramPipeline = Nri_CreateComputePipelinePermutation(device, histogramLayout, `${framework}/passes/histogram_cs.bin`,
                "main", "HISTOGRAM_BINS=256 SOURCE_ARRAY=0");
            this.exposurePipeline = Nri_CreateComputePipelinePermutation(device, exposureLayout, `${framework}/passes/exposure_cs.bin`,
                "main", "HISTOGRAM_BINS=256 SOURCE_ARRAY=0");

            const blitDesc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(blitDesc, NriShaderStage.Vertex, `${framework}/rect_vs.bin`, "main") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShaderPermutation(blitDesc, NriShaderStage.Pixel, `${framework}/blit_ps.bin`, "main",
                    "TEXTURE_ARRAY=0") != 0;
            }
            Nri_PipelineDescSetTopology(blitDesc, NriTopology.TriangleStrip);
            Nri_PipelineDescSetColor(blitDesc, this.viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.blitPipeline = Nri_CreatePipelineFromDesc(device, blitLayout, blitDesc);
            }
            Nri_DestroyPipelineDesc(blitDesc);

            if (!this.skyPipeline || !this.toneMappingPipeline || !this.histogramPipeline || !this.exposurePipeline || !this.blitPipeline) {
                console.log("Cannot load Donut's passes' shaders");
                return false;
            }
            return true;
        }

        // A constant buffer view of the constant buffer, kept for destruction.
        constantView(offset: int, size: int): NriDescriptorHandle | null {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return null;
            }
            const view = Nri_CreateConstantBufferView(constantBuffer, offset, size);
            if (view) {
                this.constantViews.push(view);
            }
            return view;
        }

        // The samplers; the constant buffer: the static constants (the shadow map's fit, the forward
        // light constants with shadows and without), then a queued frame's; the sets.
        createDescriptorSets(device: NriDeviceHandle, queuedFrameNum: int) {
            const scene = this.scene;
            const materialBuffer = this.materialBuffer;
            const forwardLayout = this.forwardLayout;
            const depthLayout = this.depthLayout;
            const skyLayout = this.skyLayout;
            const histogramLayout = this.histogramLayout;
            const exposureLayout = this.exposureLayout;
            const toneMappingLayout = this.toneMappingLayout;
            const blitLayout = this.blitLayout;
            if (!scene || !materialBuffer || !forwardLayout || !depthLayout || !skyLayout || !histogramLayout) {
                return false;
            }
            if (!exposureLayout || !toneMappingLayout || !blitLayout) {
                return false;
            }
            this.anisotropicWrap = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.Repeat, 16);
            this.linearWrap = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.Repeat, 1);
            this.linearClamp = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            this.shadowSampler = Nri_CreateBorderSampler(device, NriFilter.Linear, 1);

            // The static constants: the shadow map's fit (its DepthPassConstants, ShadowConstants), the
            // forward light constants with the shadow map and without.
            const bounds = zeros(6);
            Nri_GetDonutSceneBounds(scene, Ref(bounds[0]));
            const depthConstants = zeros(Nri_GetDonutConstantsSize(6) / 4);
            const shadowConstants = zeros(Nri_GetDonutConstantsSize(5) / 4);
            this.shadowMirrored = Nri_SetupDonutPlanarShadowMap(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2], Ref(bounds[0]),
                SHADOW_MAP_RESOLUTION, SHADOW_FADE_RANGE, Ref(depthConstants[0]), Ref(shadowConstants[0])) != 0;
            const lightConstantsSize = Nri_GetDonutConstantsSize(4);
            const lightConstants = [zeros(lightConstantsSize / 4), zeros(lightConstantsSize / 4)];
            for (let k = 0; k < 2; k++) {
                Nri_FillDonutForwardSunLightConstants(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2], SUN_ANGULAR_SIZE,
                    SUN_IRRADIANCE, Ref(shadowConstants[0]), k == 0 ? SHADOW_MAP_RESOLUTION : 0, AMBIENT_TOP, AMBIENT_TOP, AMBIENT_TOP,
                    AMBIENT_BOTTOM, AMBIENT_BOTTOM, AMBIENT_BOTTOM, Ref(lightConstants[k][0]));
            }
            const depthStride = align(depthConstants.length * 4);
            const lightStride = align(lightConstantsSize);
            this.staticStride = depthStride + 2 * lightStride;
            this.viewSize = Nri_GetDonutConstantsSize(0);
            this.skySize = Nri_GetDonutConstantsSize(7);
            this.toneMappingSize = Nri_GetDonutConstantsSize(8);
            this.viewConstants = zeros(this.viewSize / 4);
            this.skyConstants = zeros(this.skySize / 4);
            this.toneMappingConstants = zeros(this.toneMappingSize / 4);
            this.frameStride = align(this.viewSize) + align(this.skySize) + 3 * align(this.toneMappingSize);
            const constantBuffer = Nri_CreateHostBuffer(device, this.staticStride + queuedFrameNum * this.frameStride,
                NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;

            const materialCount = Nri_GetDonutSceneMaterialCount(scene);
            const blitCount = this.textures.blitSetCount();
            const setNum = 2 * materialCount + 2 + 1 + 1 + 5 * queuedFrameNum + blitCount;
            // (Typed buffers: a queued frame's exposure set reads the histogram, its tone mapping set the
            // exposure; its histogram and exposure sets write one each.)
            const descriptorPool = Nri_CreateDescriptorPoolWithTypedBuffers(device, setNum,
                1 + 4 * 2 + 1 + 2 * queuedFrameNum + blitCount,
                2 * materialCount + 3 + 5 * queuedFrameNum,
                9 * materialCount + 4 * 2 + 1 + 4 * queuedFrameNum + blitCount, 0, 0, 0,
                queuedFrameNum * 2, queuedFrameNum * 2);
            this.descriptorPool = descriptorPool;
            const blackView = this.blackView;
            const blackCubeArrayView = this.blackCubeArrayView;
            const shadowMapView = this.shadowMapView;
            const noShadowView = this.noShadowView;
            const anisotropicWrap = this.anisotropicWrap;
            const linearWrap = this.linearWrap;
            const linearClamp = this.linearClamp;
            const shadowSampler = this.shadowSampler;
            if (!constantBuffer || !descriptorPool || !blackView || !blackCubeArrayView || !shadowMapView || !noShadowView) {
                console.log("Cannot create the descriptors");
                return false;
            }
            if (!anisotropicWrap || !linearWrap || !linearClamp || !shadowSampler) {
                console.log("Cannot create the samplers");
                return false;
            }
            Nri_WriteBuffer(constantBuffer, 0, Ref(depthConstants[0]), depthConstants.length * 4);
            for (let k = 0; k < 2; k++) {
                Nri_WriteBuffer(constantBuffer, depthStride + k * lightStride, Ref(lightConstants[k][0]), lightConstantsSize);
            }

            // A material's sets: the forward pass's (its constants, its textures, black for the slots
            // it doesn't use), the depth pass's (its constants, base color, opacity).
            for (let m = 0; m < materialCount; m++) {
                const set = Nri_AllocateDescriptorSet(descriptorPool, forwardLayout, 0, 0);
                const depthSet = Nri_AllocateDescriptorSet(descriptorPool, depthLayout, 0, 0);
                const view = Nri_CreateConstantBufferView(materialBuffer, m * CONSTANTS_ALIGNMENT, CONSTANTS_ALIGNMENT);
                if (!set || !depthSet || !view) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                this.materialSets.push(set);
                this.depthMaterialSets.push(depthSet);
                this.materialViews.push(view);
                Nri_UpdateDescriptor(set, 0, 0, view);
                for (let slot = 0; slot < 7; slot++) {
                    const texture = Nri_GetDonutSceneMaterialTexture(scene, m, slot);
                    Nri_UpdateDescriptor(set, 1, slot, texture >= 0 ? this.textures.views[texture] : blackView);
                }
                Nri_UpdateDescriptor(depthSet, 0, 0, view);
                const slots = [0, 6];
                for (let k = 0; k < 2; k++) {
                    const texture = Nri_GetDonutSceneMaterialTexture(scene, m, slots[k]);
                    Nri_UpdateDescriptor(depthSet, 1, k, texture >= 0 ? this.textures.views[texture] : blackView);
                }
            }

            // The shading sets: shadows on (the shadow map), off (the fallback).
            for (let k = 0; k < 2; k++) {
                const set = Nri_AllocateDescriptorSet(descriptorPool, forwardLayout, 2, 0);
                const view = this.constantView(depthStride + k * lightStride, lightStride);
                if (!set || !view) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                Nri_UpdateDescriptor(set, 0, 0, view);
                Nri_UpdateDescriptor(set, 1, 0, k == 0 ? shadowMapView : noShadowView);
                Nri_UpdateDescriptor(set, 1, 1, blackCubeArrayView);
                Nri_UpdateDescriptor(set, 1, 2, blackCubeArrayView);
                Nri_UpdateDescriptor(set, 1, 3, blackView);
                Nri_UpdateDescriptor(set, 2, 0, anisotropicWrap);
                Nri_UpdateDescriptor(set, 2, 1, shadowSampler);
                Nri_UpdateDescriptor(set, 2, 2, linearWrap);
                Nri_UpdateDescriptor(set, 2, 3, linearClamp);
                this.shadingSets.push(set);
            }

            // The depth pass's view set: the shadow map's DepthPassConstants, the material sampler.
            const depthViewSet = Nri_AllocateDescriptorSet(descriptorPool, depthLayout, 1, 0);
            const depthView = this.constantView(0, depthStride);
            this.depthViewSet = depthViewSet;
            if (!depthViewSet || !depthView) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            Nri_UpdateDescriptor(depthViewSet, 0, 0, depthView);
            Nri_UpdateDescriptor(depthViewSet, 1, 0, anisotropicWrap);

            const blitSet = Nri_AllocateDescriptorSet(descriptorPool, blitLayout, 0, 0);
            this.blitSet = blitSet;
            const ldrView = this.ldrView;
            const hdrView = this.hdrView;
            const environmentMapView = this.environmentMapView;
            const histogramStorage = this.histogramStorage;
            const histogramView = this.histogramView;
            const exposureStorage = this.exposureStorage;
            const exposureView = this.exposureView;
            if (!blitSet || !ldrView || !hdrView || !environmentMapView || !histogramStorage || !histogramView) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            if (!exposureStorage || !exposureView) {
                return false;
            }
            Nri_UpdateDescriptor(blitSet, 0, 0, ldrView);
            Nri_UpdateDescriptor(blitSet, 1, 0, linearClamp);

            // A queued frame's: the view, the sky, the histogram, the exposure, the tone mapping.
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const base = this.frameOffset(i);
                const viewSet = Nri_AllocateDescriptorSet(descriptorPool, forwardLayout, 1, 0);
                const skySet = Nri_AllocateDescriptorSet(descriptorPool, skyLayout, 0, 0);
                const histogramSet = Nri_AllocateDescriptorSet(descriptorPool, histogramLayout, 0, 0);
                const exposureSet = Nri_AllocateDescriptorSet(descriptorPool, exposureLayout, 0, 0);
                const toneMappingSet = Nri_AllocateDescriptorSet(descriptorPool, toneMappingLayout, 0, 0);
                const viewView = this.constantView(base, align(this.viewSize));
                const skyView = this.constantView(this.skyOffset(i), align(this.skySize));
                const histogramConstants = this.constantView(this.toneMappingOffset(i, 0), align(this.toneMappingSize));
                const exposureConstants = this.constantView(this.toneMappingOffset(i, 1), align(this.toneMappingSize));
                const toneMappingConstants = this.constantView(this.toneMappingOffset(i, 2), align(this.toneMappingSize));
                if (!viewSet || !skySet || !histogramSet || !exposureSet || !toneMappingSet || !viewView || !skyView) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                if (!histogramConstants || !exposureConstants || !toneMappingConstants) {
                    return false;
                }
                Nri_UpdateDescriptor(viewSet, 0, 0, viewView);
                Nri_UpdateDescriptor(skySet, 0, 0, skyView);
                Nri_UpdateDescriptor(skySet, 1, 0, environmentMapView);
                Nri_UpdateDescriptor(skySet, 2, 0, linearWrap);
                Nri_UpdateDescriptor(histogramSet, 0, 0, histogramConstants);
                Nri_UpdateDescriptor(histogramSet, 1, 0, hdrView);
                Nri_UpdateDescriptor(histogramSet, 2, 0, histogramStorage);
                Nri_UpdateDescriptor(exposureSet, 0, 0, exposureConstants);
                Nri_UpdateDescriptor(exposureSet, 1, 0, histogramView);
                Nri_UpdateDescriptor(exposureSet, 2, 0, exposureStorage);
                Nri_UpdateDescriptor(toneMappingSet, 0, 0, toneMappingConstants);
                Nri_UpdateDescriptor(toneMappingSet, 1, 0, hdrView);
                Nri_UpdateDescriptor(toneMappingSet, 2, 0, exposureView);
                Nri_UpdateDescriptor(toneMappingSet, 3, 0, blackView);
                Nri_UpdateDescriptor(toneMappingSet, 4, 0, linearClamp);
                this.queuedFrames.push(new QueuedFrame(this.frames.commandBuffer(i), viewSet, skySet,
                    histogramSet, exposureSet, toneMappingSet));
            }

            if (!this.textures.createBlits(descriptorPool)) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            return true;
        }

        // Where a queued frame's constants are: the view, the sky, tone mapping's stage's.
        frameOffset(queuedFrameIndex: int) {
            return this.staticStride + queuedFrameIndex * this.frameStride;
        }

        skyOffset(queuedFrameIndex: int) {
            return this.frameOffset(queuedFrameIndex) + align(this.viewSize);
        }

        toneMappingOffset(queuedFrameIndex: int, stage: int) {
            return this.skyOffset(queuedFrameIndex) + align(this.skySize) + stage * align(this.toneMappingSize);
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The camera (Donut's FirstPersonCamera, unless in test mode, where nothing moves it), the
        // queued frame's view, sky and tone mapping constants.
        writeConstants(queuedFrameIndex: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            if (!this.test) {
                this.camera.animate(this.sample, Nri_GetFrameTime(this.sample), true);
            }
            const worldToView = this.camera.worldToView();
            const projection = perspProjD3DStyleReverse(Math.PI * 0.25, this.width / this.height, Z_NEAR);
            for (let i = 0; i < 16; i++) {
                this.viewMatrix[i] = worldToView[i];
                this.projMatrix[i] = projection[i];
            }
            // PlanarView::IsMirrored: the forward pass's front faces.
            const m = this.viewMatrix;
            const determinant = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8])
                + m[2] * (m[4] * m[9] - m[5] * m[8]);
            this.mirrored = determinant < 0.0;

            Nri_FillDonutPlanarViewConstants(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), this.width, this.height,
                Ref(this.viewConstants[0]));
            Nri_WriteBuffer(constantBuffer, this.frameOffset(queuedFrameIndex), Ref(this.viewConstants[0]), this.viewSize);
            Nri_FillDonutSkyConstants(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), this.width, this.height, Ref(this.skyConstants[0]));
            Nri_WriteBuffer(constantBuffer, this.skyOffset(queuedFrameIndex), Ref(this.skyConstants[0]), this.skySize);
            // (No eye adaptation: a frame time of 0, as Donut_AdvanceToneMappingFrame is never called.)
            for (let stage = 0; stage < 3; stage++) {
                Nri_FillDonutToneMappingConstants(stage, this.width, this.height, 0.0, Ref(this.toneMappingConstants[0]));
                Nri_WriteBuffer(constantBuffer, this.toneMappingOffset(queuedFrameIndex, stage), Ref(this.toneMappingConstants[0]),
                    this.toneMappingSize);
            }
        }

        // The fallback shadow map, cleared once (D3D12 wants depth textures initialized before
        // shaders read them).
        clearNoShadow(commandBuffer: NriCommandBufferHandle) {
            const texture = this.noShadowTexture;
            const attachment = this.noShadowAttachment;
            if (this.noShadowCleared || !texture || !attachment) {
                return;
            }
            Nri_CmdTextureBarrier(commandBuffer, texture, NriTextureState.ShaderResource, NriTextureState.DepthAttachment);
            Nri_CmdBeginRenderingDepthOnly(commandBuffer, attachment);
            Nri_CmdClearDepth(commandBuffer, 0.0);
            Nri_CmdEndRendering(commandBuffer);
            Nri_CmdTextureBarrier(commandBuffer, texture, NriTextureState.DepthAttachment, NriTextureState.ShaderResource);
            this.noShadowCleared = true;
        }

        // The draws' geometry (the instances and vertices as root descriptors, the index buffer) and
        // each draw, with set 0 the draw's material set and the pipeline of its key (by the pass).
        recordDraws(commandBuffer: NriCommandBufferHandle, depthPass: boolean) {
            const indexBuffer = this.indexBuffer;
            const instanceBufferView = this.instanceBufferView;
            const vertexBufferView = this.vertexBufferView;
            if (!indexBuffer || !instanceBufferView || !vertexBufferView) {
                return;
            }
            Nri_CmdSetRootDescriptor(commandBuffer, 0, instanceBufferView, 0);
            Nri_CmdSetRootDescriptor(commandBuffer, 1, vertexBufferView, 0);
            Nri_CmdSetIndexBuffer(commandBuffer, indexBuffer, 0, NriIndexType.UInt32);
            let pipeline = -1;
            let material = -1;
            for (const item of this.drawItems) {
                const itemPipeline = depthPass
                    ? (item.doubleSided ? 1 : 0) + (item.alphaTested ? 2 : 0) + (this.shadowMirrored ? 4 : 0)
                    : (item.doubleSided ? 1 : 0) + (this.mirrored ? 2 : 0);
                if (itemPipeline != pipeline) {
                    Nri_CmdSetPipeline(commandBuffer, depthPass ? this.depthPipelines[itemPipeline] : this.forwardPipelines[itemPipeline]);
                    pipeline = itemPipeline;
                }
                if (item.material != material) {
                    Nri_CmdSetDescriptorSet(commandBuffer, 0, depthPass ? this.depthMaterialSets[item.material] : this.materialSets[item.material]);
                    material = item.material;
                }
                if (depthPass) {
                    Nri_CmdSetRootConstants(commandBuffer, 0, Ref(item.depthPush[0]), DEPTH_PUSH_WORDS * 4);
                } else {
                    Nri_CmdSetRootConstants(commandBuffer, 0, Ref(item.forwardPush[0]), FORWARD_PUSH_WORDS * 4);
                }
                Nri_CmdDrawIndexed(commandBuffer, item.indexCount, 1, item.firstIndex, 0, 0);
            }
        }

        // The shadow map, once (the scene and the sun don't move): cleared to 1, the opaque and
        // alpha-tested geometries drawn by Donut's depth pass from the sun.
        recordShadowMap(commandBuffer: NriCommandBufferHandle) {
            const shadowMap = this.shadowMap;
            const attachment = this.shadowMapAttachment;
            const layout = this.depthLayout;
            const depthViewSet = this.depthViewSet;
            if (this.shadowMapRendered || !shadowMap || !attachment || !layout || !depthViewSet) {
                return;
            }
            Nri_CmdTextureBarrier(commandBuffer, shadowMap, NriTextureState.ShaderResource, NriTextureState.DepthAttachment);
            Nri_CmdBeginRenderingDepthOnly(commandBuffer, attachment);
            Nri_CmdClearDepth(commandBuffer, 1.0);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, SHADOW_MAP_RESOLUTION, SHADOW_MAP_RESOLUTION);
            Nri_CmdSetScissor(commandBuffer, 0, 0, SHADOW_MAP_RESOLUTION, SHADOW_MAP_RESOLUTION);
            Nri_CmdSetPipelineLayout(commandBuffer, layout);
            Nri_CmdSetDescriptorSet(commandBuffer, 1, depthViewSet);
            this.recordDraws(commandBuffer, true);
            Nri_CmdEndRendering(commandBuffer);
            Nri_CmdTextureBarrier(commandBuffer, shadowMap, NriTextureState.DepthAttachment, NriTextureState.ShaderResource);
            this.shadowMapRendered = true;
        }

        // The HDR color and depth cleared (to 0), the forward pass's opaque draws, then the
        // environment map behind them.
        recordScene(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const hdrColor = this.hdrColor;
            const hdrAttachment = this.hdrAttachment;
            const depthAttachment = this.depthAttachment;
            const forwardLayout = this.forwardLayout;
            const skyLayout = this.skyLayout;
            const skyPipeline = this.skyPipeline;
            if (!hdrColor || !hdrAttachment || !depthAttachment || !forwardLayout || !skyLayout || !skyPipeline) {
                return;
            }
            Nri_CmdTextureBarrier(commandBuffer, hdrColor, NriTextureState.AllShaderResource, NriTextureState.ColorAttachment);
            Nri_CmdBeginRenderingWithDepth(commandBuffer, hdrAttachment, depthAttachment);
            Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
            Nri_CmdClearDepth(commandBuffer, 0.0);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, forwardLayout);
            Nri_CmdSetDescriptorSet(commandBuffer, 1, queuedFrame.viewSet);
            Nri_CmdSetDescriptorSet(commandBuffer, 2, this.shadingSets[this.enableShadows ? 0 : 1]);
            this.recordDraws(commandBuffer, false);

            // Behind everything opaque.
            Nri_CmdSetPipelineLayout(commandBuffer, skyLayout);
            Nri_CmdSetPipeline(commandBuffer, skyPipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, queuedFrame.skySet);
            Nri_CmdDraw(commandBuffer, 4, 1, 0, 0);
            Nri_CmdEndRendering(commandBuffer);
            Nri_CmdTextureBarrier(commandBuffer, hdrColor, NriTextureState.ColorAttachment, NriTextureState.AllShaderResource);
        }

        // Donut's ToneMappingPass::SimpleRender: the histogram zeroed and filled from the HDR color,
        // the exposure computed from it (kept as it is: no frame time), the HDR color tone mapped
        // into the LDR color.
        recordToneMapping(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const histogram = this.histogram;
            const exposure = this.exposure;
            const histogramLayout = this.histogramLayout;
            const histogramPipeline = this.histogramPipeline;
            const exposureLayout = this.exposureLayout;
            const exposurePipeline = this.exposurePipeline;
            const toneMappingLayout = this.toneMappingLayout;
            const toneMappingPipeline = this.toneMappingPipeline;
            const ldrColor = this.ldrColor;
            const ldrAttachment = this.ldrAttachment;
            if (!histogram || !exposure || !histogramLayout || !histogramPipeline || !exposurePipeline || !toneMappingLayout) {
                return;
            }
            if (!exposureLayout || !toneMappingPipeline || !ldrColor || !ldrAttachment) {
                return;
            }
            Nri_CmdZeroBuffer(commandBuffer, histogram);
            Nri_CmdBufferBarrier(commandBuffer, histogram, NriBufferState.CopyDestination, NriBufferState.Storage);
            Nri_CmdSetComputePipelineLayout(commandBuffer, histogramLayout);
            Nri_CmdSetPipeline(commandBuffer, histogramPipeline);
            Nri_CmdSetComputeDescriptorSet(commandBuffer, 0, queuedFrame.histogramSet);
            Nri_CmdDispatch(commandBuffer, Math.floor((this.width + TONE_MAPPING_GROUP_SIZE - 1) / TONE_MAPPING_GROUP_SIZE),
                Math.floor((this.height + TONE_MAPPING_GROUP_SIZE - 1) / TONE_MAPPING_GROUP_SIZE), 1);
            Nri_CmdBufferBarrier(commandBuffer, histogram, NriBufferState.Storage, NriBufferState.ComputeShaderResource);
            Nri_CmdSetComputePipelineLayout(commandBuffer, exposureLayout);
            Nri_CmdSetPipeline(commandBuffer, exposurePipeline);
            Nri_CmdSetComputeDescriptorSet(commandBuffer, 0, queuedFrame.exposureSet);
            Nri_CmdDispatch(commandBuffer, 1, 1, 1);
            Nri_CmdBufferBarrier(commandBuffer, histogram, NriBufferState.ComputeShaderResource, NriBufferState.CopyDestination);
            Nri_CmdBufferBarrier(commandBuffer, exposure, NriBufferState.Storage, NriBufferState.PixelShaderResource);

            Nri_CmdTextureBarrier(commandBuffer, ldrColor, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            Nri_CmdBeginRendering(commandBuffer, ldrAttachment);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, toneMappingLayout);
            Nri_CmdSetPipeline(commandBuffer, toneMappingPipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, queuedFrame.toneMappingSet);
            Nri_CmdDraw(commandBuffer, 4, 1, 0, 0);
            Nri_CmdEndRendering(commandBuffer);
            Nri_CmdTextureBarrier(commandBuffer, ldrColor, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
            Nri_CmdBufferBarrier(commandBuffer, exposure, NriBufferState.PixelShaderResource, NriBufferState.Storage);
        }

        // The LDR color over the swap chain texture (between Nri_CmdBeginRendering and
        // Nri_CmdEndRendering), as Donut's BlitTexture draws it.
        recordBlit(commandBuffer: NriCommandBufferHandle) {
            const layout = this.blitLayout;
            const pipeline = this.blitPipeline;
            const blitSet = this.blitSet;
            if (!layout || !pipeline || !blitSet) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, layout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.blitConstants[0]), BLIT_CONSTANTS.length * 4);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, blitSet);
            Nri_CmdDraw(commandBuffer, 4, 1, 0, 0);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (Nri_IsKeyToggled(this.sample, NriKey.Space) != 0) {
                this.enableShadows = !this.enableShadows;
                Nri_SetWindowTitle(this.sample, `${WINDOW_TITLE} - shadows ${this.enableShadows ? "on" : "off"}`);
            }
            this.writeConstants(queuedFrameIndex);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                this.recordAndSubmit(frameIndex, queuedFrame, index);
            }

            // Signaled after the present, as NRISamples do
            this.frames.signal(frameIndex);
        }

        // Records the frame into the queued frame's command buffer, submits it and presents.
        recordAndSubmit(frameIndex: int, queuedFrame: QueuedFrame, index: int) {
            const descriptorPool = this.descriptorPool;
            if (!descriptorPool) {
                return;
            }
            const commandBuffer = queuedFrame.commandBuffer;
            Nri_BeginCommandBuffer(commandBuffer);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            // The first frame: the mip chains, the fallback, the shadow map.
            this.textures.recordBlits(commandBuffer);
            this.clearNoShadow(commandBuffer);
            if (this.enableShadows) {
                this.recordShadowMap(commandBuffer);
            }
            this.recordScene(commandBuffer, queuedFrame);
            this.recordToneMapping(commandBuffer, queuedFrame);

            Nri_CmdTextureBarrier(commandBuffer, this.swapChain.texture(index), NriTextureState.Undefined, NriTextureState.ColorAttachment);
            Nri_CmdBeginRendering(commandBuffer, this.swapChain.colorAttachment(index));
            this.recordBlit(commandBuffer);
            Nri_CmdEndRendering(commandBuffer);

            // The test's last frame: read back
            let presentFrom = NriTextureState.ColorAttachment;
            const readbackBuffer = this.readbackBuffer;
            if (readbackBuffer) {
                if (frameIndex == TEST_FRAMES - 1) {
                    Nri_CmdTextureBarrier(commandBuffer, this.swapChain.texture(index), NriTextureState.ColorAttachment, NriTextureState.CopySource);
                    Nri_CmdReadbackTextureToBuffer(commandBuffer, readbackBuffer, this.rowPitch, this.swapChain.texture(index), this.width, this.height);
                    presentFrom = NriTextureState.CopySource;
                }
            }
            Nri_CmdTextureBarrier(commandBuffer, this.swapChain.texture(index), presentFrom, NriTextureState.Present);
            Nri_EndCommandBuffer(commandBuffer);

            // Submit and present
            this.swapChain.submit(commandBuffer, index);
            this.swapChain.present(index);
        }

        // The last frame's pixels (0xAABBGGRR), empty if it can't be read.
        readBack(): int[] {
            const device = this.device;
            const readbackBuffer = this.readbackBuffer;
            if (!device || !readbackBuffer) {
                return [];
            }
            Nri_DeviceWaitIdle(device);
            const pixels: int[] = [];
            for (let i = 0; i < this.width * this.height; i++) {
                pixels.push(0);
            }
            if (Nri_ReadBufferRGBA8(readbackBuffer, this.rowPitch, this.width, this.height, this.readbackFormat,
                Ref(pixels[0]), pixels.length) == 0) {
                return [];
            }
            return pixels;
        }

        destroy() {
            const device = this.device;
            if (device) {
                Nri_DeviceWaitIdle(device);
                this.swapChain.destroy();
                this.destroySizedTargets();
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                this.textures.destroy();
                const descriptors = [this.vertexBufferView, this.instanceBufferView, this.environmentMapView, this.shadowMapAttachment,
                    this.shadowMapView, this.histogramStorage, this.histogramView, this.exposureStorage, this.exposureView, this.blackView,
                    this.blackCubeArrayView, this.noShadowView, this.noShadowAttachment, this.anisotropicWrap, this.linearWrap,
                    this.linearClamp, this.shadowSampler];
                for (const descriptor of descriptors) {
                    if (descriptor) {
                        Nri_DestroyDescriptor(descriptor);
                    }
                }
                for (const view of this.materialViews) {
                    Nri_DestroyDescriptor(view);
                }
                for (const view of this.constantViews) {
                    Nri_DestroyDescriptor(view);
                }
                const textures = [this.environmentMap, this.shadowMap, this.noShadowTexture];
                for (const texture of textures) {
                    if (texture) {
                        Nri_DestroyTexture(texture);
                    }
                }
                for (const texture of this.solidTextures) {
                    Nri_DestroyTexture(texture);
                }
                const buffers = [this.vertexBuffer, this.instanceBuffer, this.indexBuffer, this.materialBuffer, this.histogram,
                    this.exposure, this.constantBuffer, this.readbackBuffer];
                for (const buffer of buffers) {
                    if (buffer) {
                        Nri_DestroyBuffer(buffer);
                    }
                }
                for (const pipeline of this.forwardPipelines) {
                    Nri_DestroyPipeline(pipeline);
                }
                for (const pipeline of this.depthPipelines) {
                    Nri_DestroyPipeline(pipeline);
                }
                const pipelines = [this.skyPipeline, this.histogramPipeline, this.exposurePipeline, this.toneMappingPipeline, this.blitPipeline];
                for (const pipeline of pipelines) {
                    if (pipeline) {
                        Nri_DestroyPipeline(pipeline);
                    }
                }
                const layouts = [this.forwardLayout, this.depthLayout, this.skyLayout, this.histogramLayout, this.exposureLayout,
                    this.toneMappingLayout, this.blitLayout];
                for (const layout of layouts) {
                    if (layout) {
                        Nri_DestroyPipelineLayout(layout);
                    }
                }
                this.frames.destroy();
                Nri_DestroyDevice(device);
            }
            const scene = this.scene;
            if (scene) {
                Nri_DestroyDonutScene(scene);
            }
            Nri_DestroySample(this.sample);
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        Nri_UseResizableWindow(sample);
        const environmentMap = new EnvironmentMap(sample);
        // --scene <path>: relative to the executable's directory.
        Nri_AddExampleOptionWithValues(sample, "--scene", 1);
        for (let i = 1; i < argc; i++) {
            if (Nri_GetArg(argc, argv, i) == "--scene" && i + 1 < argc) {
                environmentMap.scenePath = Nri_GetArg(argc, argv, i + 1);
            }
        }
        return environmentMap.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return EnvironmentMapNri.main(argc, argv);
}

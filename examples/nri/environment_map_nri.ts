/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { perspProjD3DStyleReverse } from "../../core/matrix";
import { DonutFirstPersonCamera } from "../../core/donut_first_person_camera";
import { DonutSceneTextures } from "../../core/nri_donut_textures";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriDonutScene, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

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
        constructor(public commandBuffer: NriCommandBuffer,
            public viewSet: NriDescriptorSet, public skySet: NriDescriptorSet,
            public histogramSet: NriDescriptorSet, public exposureSet: NriDescriptorSet,
            public toneMappingSet: NriDescriptorSet) {
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
        private device: NriDevice | null = null;
        private queue: NriQueue;
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
        private scene: NriDonutScene | null = null;
        private vertexBuffer: NriBuffer | null = null;
        private vertexBufferView: NriDescriptor | null = null;
        private instanceBuffer: NriBuffer | null = null;
        private instanceBufferView: NriDescriptor | null = null;
        private indexBuffer: NriBuffer | null = null;
        private materialBuffer: NriBuffer | null = null;
        private materialViews: NriDescriptor[] = [];
        // A material's forward set (all its textures) and depth set (base color and opacity).
        private materialSets: NriDescriptorSet[] = [];
        private depthMaterialSets: NriDescriptorSet[] = [];
        private textures: DonutSceneTextures = new DonutSceneTextures();
        private drawItems: DrawItem[] = [];

        // The environment map, the shadow map (D24S8, one layer; rendered in the first frame), the
        // scene targets (SceneRenderTargets': HDR RGBA16F, D24S8 reverse depth, LDR sRGB).
        private environmentMap: NriTexture | null = null;
        private environmentMapView: NriDescriptor | null = null;
        private shadowMap: NriTexture | null = null;
        private shadowMapAttachment: NriDescriptor | null = null;
        private shadowMapView: NriDescriptor | null = null;
        private shadowMapRendered: boolean = false;
        private shadowMirrored: boolean = false;
        private hdrColor: NriTexture | null = null;
        private hdrAttachment: NriDescriptor | null = null;
        private hdrView: NriDescriptor | null = null;
        private depth: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private ldrColor: NriTexture | null = null;
        private ldrAttachment: NriDescriptor | null = null;
        private ldrView: NriDescriptor | null = null;

        // Tone mapping's histogram and exposure (typed R32_UINT buffers) and their views.
        private histogram: NriBuffer | null = null;
        private histogramStorage: NriDescriptor | null = null;
        private histogramView: NriDescriptor | null = null;
        private exposure: NriBuffer | null = null;
        private exposureStorage: NriDescriptor | null = null;
        private exposureView: NriDescriptor | null = null;

        // CommonRenderPasses' fallbacks: black, a black cubemap array, a depth texture array (the
        // shadow maps' when shadows are off; cleared once).
        private solidTextures: NriTexture[] = [];
        private blackView: NriDescriptor | null = null;
        private blackCubeArrayView: NriDescriptor | null = null;
        private noShadowTexture: NriTexture | null = null;
        private noShadowView: NriDescriptor | null = null;
        private noShadowAttachment: NriDescriptor | null = null;
        private noShadowCleared: boolean = false;

        // The passes' layouts and pipelines: the forward pass's (by cull mode and front face), the
        // shadow depth pass's (by cull mode, alpha test and front face), the environment map's, tone
        // mapping's (histogram, exposure, the tone mapping draw), the blit's.
        private forwardLayout: NriPipelineLayout | null = null;
        private forwardPipelines: NriPipeline[] = [];
        private depthLayout: NriPipelineLayout | null = null;
        private depthPipelines: NriPipeline[] = [];
        private skyLayout: NriPipelineLayout | null = null;
        private skyPipeline: NriPipeline | null = null;
        private histogramLayout: NriPipelineLayout | null = null;
        private histogramPipeline: NriPipeline | null = null;
        private exposureLayout: NriPipelineLayout | null = null;
        private exposurePipeline: NriPipeline | null = null;
        private toneMappingLayout: NriPipelineLayout | null = null;
        private toneMappingPipeline: NriPipeline | null = null;
        private blitLayout: NriPipelineLayout | null = null;
        private blitPipeline: NriPipeline | null = null;

        // CommonRenderPasses' samplers (anisotropic wrap, linear wrap, linear clamp) and the forward
        // pass's shadow sampler (border, white).
        private anisotropicWrap: NriDescriptor | null = null;
        private linearWrap: NriDescriptor | null = null;
        private linearClamp: NriDescriptor | null = null;
        private shadowSampler: NriDescriptor | null = null;

        // The constant buffer: the static constants (the forward light constants with shadows and
        // without, the depth pass's), then a queued frame's (the view, the sky, tone mapping's three).
        private constantBuffer: NriBuffer | null = null;
        private constantViews: NriDescriptor[] = [];
        private descriptorPool: NriDescriptorPool | null = null;
        // The shading sets (shadows on, off), the depth pass's view set, the blit's set.
        private shadingSets: NriDescriptorSet[] = [];
        private depthViewSet: NriDescriptorSet | null = null;
        private blitSet: NriDescriptorSet | null = null;
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
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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
            this.sample.setInitializeCallback(initialize);
            this.sample.setLatencySleepCallback(latencySleep);
            this.sample.setRenderFrameCallback(renderFrame);

            let result = this.sample.run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (result == 0 && this.test) {
                const failure = checkFrame(this.readBack(), this.width, this.height);
                console.log(failure == "" ? "Test PASSED" : `Test FAILED: ${failure}`);
                result = failure == "" ? 0 : 1;
            }
            this.destroy();
            return result;
        }

        initialize(graphicsAPI: NriGraphicsAPI): int {
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // Swap chain: blitted into through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
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
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The scene, as Donut's engine loads it, its textures, the materials' constants; the draws
        // InstancedOpaqueDrawStrategy makes of it (opaque and alpha-tested materials), by material.
        // The environment map.
        loadScene(device: NriDevice, folder: string, d3d11: boolean) {
            const scene = NriDonutScene.load(this.scenePath);
            this.scene = scene;
            if (!scene) {
                console.log(`Cannot load the scene ${this.scenePath}`);
                return false;
            }
            const vertexBuffer = device.createDonutSceneBuffer(this.queue, scene, 0);
            // (D3D11's shaders read the instances as a ByteAddressBuffer.)
            const instanceBuffer = device.createDonutSceneBuffer(this.queue, scene, d3d11 ? 6 : 2);
            this.vertexBuffer = vertexBuffer;
            this.instanceBuffer = instanceBuffer;
            this.indexBuffer = device.createDonutSceneBuffer(this.queue, scene, 5);
            this.materialBuffer = device.createDonutSceneMaterialBuffer(scene);
            if (!vertexBuffer || !instanceBuffer || !this.indexBuffer || !this.materialBuffer) {
                console.log("Cannot create the scene's buffers");
                return false;
            }
            this.vertexBufferView = vertexBuffer.createStructuredView(0);
            this.instanceBufferView = instanceBuffer.createStructuredView(0);

            const streams: int[] = [];
            for (let stream = 0; stream < 4; stream++) {
                streams.push(scene.getStreamOffset(stream));
            }
            // By material (Donut sorts by the materials' addresses), then in the scene's order.
            const materialCount = scene.getMaterialCount();
            const instanceCount = scene.getInstanceCount();
            for (let drawnMaterial = 0; drawnMaterial < materialCount; drawnMaterial++) {
                const domain = scene.getMaterialDomain(drawnMaterial);
                if (domain != DOMAIN_OPAQUE && domain != DOMAIN_ALPHA_TESTED) {
                    continue;
                }
                // DepthPass: alpha-tested materials with a base color or opacity texture run its pixel
                // shader.
                const alphaTested = domain == DOMAIN_ALPHA_TESTED && (scene.getMaterialTexture(drawnMaterial, 0) >= 0
                    || scene.getMaterialTexture(drawnMaterial, 6) >= 0);
                const doubleSided = scene.getMaterialDoubleSided(drawnMaterial) != 0;
                for (let instance = 0; instance < instanceCount; instance++) {
                    const geometryCount = scene.getInstanceGeometryCount(instance);
                    for (let geometry = 0; geometry < geometryCount; geometry++) {
                        if (scene.getGeometryMaterial(instance, geometry) != drawnMaterial) {
                            continue;
                        }
                        const words = [instance, scene.getGeometryFirstVertex(instance, geometry),
                            streams[0], streams[1], streams[2], streams[3]];
                        const forwardPush = zeros(FORWARD_PUSH_WORDS);
                        for (let k = 0; k < FORWARD_PUSH_WORDS; k++) {
                            Nri.storeInt32(Ref(forwardPush[k]), words[k]);
                        }
                        const depthPush = zeros(DEPTH_PUSH_WORDS);
                        for (let k = 0; k < DEPTH_PUSH_WORDS; k++) {
                            Nri.storeInt32(Ref(depthPush[k]), words[k]);
                        }
                        this.drawItems.push(new DrawItem(drawnMaterial, doubleSided, alphaTested,
                            scene.getGeometryIndexCount(instance, geometry),
                            scene.getGeometryFirstIndex(instance, geometry), forwardPush, depthPush));
                    }
                }
            }

            const environmentMap = device.loadDdsTexture(this.queue, ENVIRONMENT_MAP, 0);
            this.environmentMap = environmentMap;
            if (!environmentMap) {
                console.log(`Cannot load the environment map ${ENVIRONMENT_MAP}`);
                return false;
            }
            this.environmentMapView = environmentMap.createView(environmentMap.getFormat());

            return this.textures.load(device, this.queue, scene, folder);
        }

        // The window-size scene targets: the HDR color, its depth and tone mapping's LDR color, in
        // the states their creation leaves them in (the frames' barriers start from them).
        createSizedTargets(device: NriDevice): boolean {
            const hdrColor = device.createRenderTargetTexture(this.queue, this.width, this.height, NriFormat.RGBA16_SFLOAT);
            this.hdrColor = hdrColor;
            const depth = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D24_UNORM_S8_UINT);
            this.depth = depth;
            const ldrColor = device.createRenderTargetTexture(this.queue, this.width, this.height, NriFormat.RGBA8_SRGB);
            this.ldrColor = ldrColor;
            if (!hdrColor || !depth || !ldrColor) {
                return false;
            }
            this.hdrAttachment = hdrColor.createColorAttachmentView(NriFormat.RGBA16_SFLOAT);
            this.hdrView = hdrColor.createView(NriFormat.RGBA16_SFLOAT);
            this.depthAttachment = depth.createDepthAttachmentView(NriFormat.D24_UNORM_S8_UINT);
            this.ldrAttachment = ldrColor.createColorAttachmentView(NriFormat.RGBA8_SRGB);
            this.ldrView = ldrColor.createView(NriFormat.RGBA8_SRGB);
            return true;
        }

        destroySizedTargets() {
            const descriptors = [this.hdrAttachment, this.hdrView, this.depthAttachment, this.ldrAttachment, this.ldrView];
            for (const descriptor of descriptors) {
                if (descriptor) {
                    descriptor.destroy();
                }
            }
            const textures = [this.hdrColor, this.depth, this.ldrColor];
            for (const texture of textures) {
                if (texture) {
                    texture.destroy();
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
                blitSet.updateDescriptor(0, 0, ldrView);
            }
            for (const queuedFrame of this.queuedFrames) {
                queuedFrame.histogramSet.updateDescriptor(1, 0, hdrView);
                queuedFrame.toneMappingSet.updateDescriptor(1, 0, hdrView);
            }
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): once the GPU is done with them, the swap
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
            device.waitIdle();
            this.destroySizedTargets();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            if (this.createSizedTargets(device)) {
                this.updateSizedDescriptors();
            }
        }

        // The shadow map, the scene targets, tone mapping's buffers, the fallbacks.
        createTargets(device: NriDevice) {
            const shadowMap = device.createSampledDepthTexture(this.queue, SHADOW_MAP_RESOLUTION, SHADOW_MAP_RESOLUTION,
                NriFormat.D24_UNORM_S8_UINT);
            this.shadowMap = shadowMap;
            if (!shadowMap || !this.createSizedTargets(device)) {
                console.log("Cannot create the render targets");
                return false;
            }
            this.shadowMapAttachment = shadowMap.createDepthAttachmentView(NriFormat.D24_UNORM_S8_UINT);
            this.shadowMapView = shadowMap.createArrayView(NriFormat.R24_UNORM_X8);

            // The histogram (zeroed each frame) and the exposure (ToneMappingPass::ResetExposure: the
            // exposure's bits).
            const histogramZeros: int[] = [];
            for (let i = 0; i < HISTOGRAM_BINS; i++) {
                histogramZeros.push(0);
            }
            const histogram = device.createStorageBufferFromInts(this.queue, Ref(histogramZeros[0]), HISTOGRAM_BINS * 4, 0,
                NriBufferState.CopyDestination);
            this.histogram = histogram;
            const exposureValue = zeros(1);
            exposureValue[0] = EXPOSURE;
            const exposure = device.createStorageBuffer(this.queue, Ref(exposureValue[0]), 4, 0);
            this.exposure = exposure;
            if (!histogram || !exposure) {
                console.log("Cannot create tone mapping's buffers");
                return false;
            }
            this.histogramStorage = histogram.createTypedView(NriFormat.R32_UINT, 1);
            this.histogramView = histogram.createTypedView(NriFormat.R32_UINT, 0);
            this.exposureStorage = exposure.createTypedView(NriFormat.R32_UINT, 1);
            this.exposureView = exposure.createTypedView(NriFormat.R32_UINT, 0);

            const black = device.createSolidTexture(this.queue, 1, 0xFF000000, NriTextureState.AllShaderResource);
            const blackCubes = device.createSolidTexture(this.queue, 6, 0xFF000000, NriTextureState.ShaderResource);
            const noShadowTexture = device.createSampledDepthTexture(this.queue, 1, 1, NriFormat.D16_UNORM);
            this.noShadowTexture = noShadowTexture;
            if (!black || !blackCubes || !noShadowTexture) {
                console.log("Cannot create the default textures");
                return false;
            }
            this.solidTextures.push(black);
            this.solidTextures.push(blackCubes);
            this.blackView = black.createView(NriFormat.RGBA8_UNORM);
            this.blackCubeArrayView = blackCubes.createCubeArrayView(NriFormat.RGBA8_UNORM);
            this.noShadowView = noShadowTexture.createArrayView(NriFormat.D16_UNORM);
            this.noShadowAttachment = noShadowTexture.createDepthAttachmentView(NriFormat.D16_UNORM);
            return true;
        }

        // The passes' layouts, as their shaders declare their bindings (Donut's register spaces).
        createLayouts(device: NriDevice) {
            // Forward shading: 0 the material, 1 the inputs (root), 2 the view, 3 the shading.
            const forwardDesc = NriPipelineLayoutDesc.create();
            forwardDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            forwardDesc.addRange(0, 0, 7, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            forwardDesc.addRange(1, 2, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            forwardDesc.setRegisterSpace(1, 2);
            forwardDesc.addRange(2, 3, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            forwardDesc.addRange(2, 20, 4, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            forwardDesc.addRange(2, 0, 4, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            forwardDesc.setRegisterSpace(2, 3);
            forwardDesc.setRootRegisterSpace(1);
            forwardDesc.addRootConstants(1, FORWARD_PUSH_WORDS * 4, NriStage.Vertex);
            forwardDesc.addRootDescriptor(10, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            forwardDesc.addRootDescriptor(11, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            this.forwardLayout = device.createPipelineLayoutFromDesc(forwardDesc);
            forwardDesc.destroy();

            // Shadow depth: 0 the material (b0, t0 base color, t1 opacity), 1 the inputs (root), 2 the
            // view (b2) and the material sampler (s0).
            const depthDesc = NriPipelineLayoutDesc.create();
            depthDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            depthDesc.addRange(0, 0, 2, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            depthDesc.addRange(1, 2, 1, NriDescriptorType.ConstantBuffer, NriStage.Vertex, NriRangeFlags.None);
            depthDesc.addRange(1, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            depthDesc.setRegisterSpace(1, 2);
            depthDesc.setRootRegisterSpace(1);
            depthDesc.addRootConstants(1, DEPTH_PUSH_WORDS * 4, NriStage.Vertex);
            depthDesc.addRootDescriptor(10, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            depthDesc.addRootDescriptor(11, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            this.depthLayout = device.createPipelineLayoutFromDesc(depthDesc);
            depthDesc.destroy();

            // The environment map: b0, t0, s0.
            const skyDesc = NriPipelineLayoutDesc.create();
            skyDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            skyDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            skyDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.skyLayout = device.createPipelineLayoutFromDesc(skyDesc);
            skyDesc.destroy();

            // The histogram and exposure compute shaders: b0, t0 (the source texture; the
            // histogram, a typed buffer), u0 (a typed buffer).
            const computeTypes = [NriDescriptorType.Texture, NriDescriptorType.Buffer];
            for (let k = 0; k < 2; k++) {
                const computeDesc = NriPipelineLayoutDesc.create();
                computeDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Compute, NriRangeFlags.None);
                computeDesc.addRange(0, 0, 1, computeTypes[k], NriStage.Compute, NriRangeFlags.None);
                computeDesc.addRange(0, 0, 1, NriDescriptorType.StorageBuffer, NriStage.Compute, NriRangeFlags.None);
                const computeLayout = device.createPipelineLayoutFromDesc(computeDesc);
                computeDesc.destroy();
                if (k == 0) {
                    this.histogramLayout = computeLayout;
                } else {
                    this.exposureLayout = computeLayout;
                }
            }

            // The tone mapping draw: b0, t0 (the HDR color), t1 (the exposure), t2 (the color LUT),
            // s0.
            const toneMappingDesc = NriPipelineLayoutDesc.create();
            toneMappingDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            toneMappingDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            toneMappingDesc.addRange(0, 1, 1, NriDescriptorType.Buffer, NriStage.Pixel, NriRangeFlags.None);
            toneMappingDesc.addRange(0, 2, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            toneMappingDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.toneMappingLayout = device.createPipelineLayoutFromDesc(toneMappingDesc);
            toneMappingDesc.destroy();

            const blitDesc = NriPipelineLayoutDesc.create();
            blitDesc.addRootConstants(0, BLIT_CONSTANTS.length * 4, NriStage.Vertex);
            blitDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            blitDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.blitLayout = device.createPipelineLayoutFromDesc(blitDesc);
            blitDesc.destroy();

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
        createFullscreenPipeline(device: NriDevice, layout: NriPipelineLayout, framework: string, ps: string, permutation: string,
            format: NriFormat, depthTested: boolean) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShaderPermutation(NriShaderStage.Vertex, `${framework}/fullscreen_vs.bin`, "main",
                "QUAD_Z=0") != 0;
            if (loaded) {
                loaded = desc.addShaderPermutation(NriShaderStage.Pixel, `${framework}/${ps}`, "main", permutation) != 0;
            }
            desc.setTopology(NriTopology.TriangleStrip);
            desc.setColor(format, NriColorWrite.RGBA);
            if (depthTested) {
                desc.setDepth(NriFormat.D24_UNORM_S8_UINT, NriCompareOp.GreaterEqual, 0, 0);
            }
            const pipeline = loaded ? device.createPipelineFromDesc(layout, desc) : null;
            desc.destroy();
            return pipeline;
        }

        createPipelines(device: NriDevice, folder: string) {
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
                const desc = NriPipelineDesc.create();
                let loaded = desc.addShader(NriShaderStage.Vertex, `${framework}/passes/forward_vs_buffer_loads.bin`,
                    "buffer_loads") != 0;
                if (loaded) {
                    loaded = desc.addShaderPermutation(NriShaderStage.Pixel, `${framework}/passes/forward_ps.bin`, "main",
                        "TRANSMISSIVE_MATERIAL=0") != 0;
                }
                desc.setCullMode((key & 1) != 0 ? NriCullMode.None : NriCullMode.Back);
                desc.setFrontCounterClockwise(key >> 1);
                desc.setColor(NriFormat.RGBA16_SFLOAT, NriColorWrite.RGBA);
                desc.setDepth(NriFormat.D24_UNORM_S8_UINT, NriCompareOp.GreaterEqual, 1, 0);
                const pipeline = loaded ? device.createPipelineFromDesc(forwardLayout, desc) : null;
                desc.destroy();
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
                const desc = NriPipelineDesc.create();
                let loaded = desc.addShader(NriShaderStage.Vertex, `${framework}/passes/depth_vs_buffer_loads.bin`,
                    "buffer_loads") != 0;
                if (loaded && (key & 2) != 0) {
                    loaded = desc.addShader(NriShaderStage.Pixel, `${framework}/passes/depth_ps.bin`, "main") != 0;
                }
                desc.setCullMode((key & 1) != 0 ? NriCullMode.None : NriCullMode.Back);
                desc.setFrontCounterClockwise((key >> 2) & 1);
                desc.setDepth(NriFormat.D24_UNORM_S8_UINT, NriCompareOp.LessEqual, 1, 0);
                desc.setDepthBias(SHADOW_DEPTH_BIAS, 0.0, SHADOW_SLOPE_SCALED_DEPTH_BIAS);
                const pipeline = loaded ? device.createPipelineFromDesc(depthLayout, desc) : null;
                desc.destroy();
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
            this.histogramPipeline = device.createComputePipelinePermutation(histogramLayout, `${framework}/passes/histogram_cs.bin`,
                "main", "HISTOGRAM_BINS=256 SOURCE_ARRAY=0");
            this.exposurePipeline = device.createComputePipelinePermutation(exposureLayout, `${framework}/passes/exposure_cs.bin`,
                "main", "HISTOGRAM_BINS=256 SOURCE_ARRAY=0");

            const blitDesc = NriPipelineDesc.create();
            let loaded = blitDesc.addShader(NriShaderStage.Vertex, `${framework}/rect_vs.bin`, "main") != 0;
            if (loaded) {
                loaded = blitDesc.addShaderPermutation(NriShaderStage.Pixel, `${framework}/blit_ps.bin`, "main",
                    "TEXTURE_ARRAY=0") != 0;
            }
            blitDesc.setTopology(NriTopology.TriangleStrip);
            blitDesc.setColor(this.viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.blitPipeline = device.createPipelineFromDesc(blitLayout, blitDesc);
            }
            blitDesc.destroy();

            if (!this.skyPipeline || !this.toneMappingPipeline || !this.histogramPipeline || !this.exposurePipeline || !this.blitPipeline) {
                console.log("Cannot load Donut's passes' shaders");
                return false;
            }
            return true;
        }

        // A constant buffer view of the constant buffer, kept for destruction.
        constantView(offset: int, size: int): NriDescriptor | null {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return null;
            }
            const view = constantBuffer.createConstantView(offset, size);
            if (view) {
                this.constantViews.push(view);
            }
            return view;
        }

        // The samplers; the constant buffer: the static constants (the shadow map's fit, the forward
        // light constants with shadows and without), then a queued frame's; the sets.
        createDescriptorSets(device: NriDevice, queuedFrameNum: int) {
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
            this.anisotropicWrap = device.createSampler(NriFilter.Linear, NriAddressMode.Repeat, 16);
            this.linearWrap = device.createSampler(NriFilter.Linear, NriAddressMode.Repeat, 1);
            this.linearClamp = device.createSampler(NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            this.shadowSampler = device.createBorderSampler(NriFilter.Linear, 1);

            // The static constants: the shadow map's fit (its DepthPassConstants, ShadowConstants), the
            // forward light constants with the shadow map and without.
            const bounds = zeros(6);
            scene.getBounds(Ref(bounds[0]));
            const depthConstants = zeros(Nri.getDonutConstantsSize(6) / 4);
            const shadowConstants = zeros(Nri.getDonutConstantsSize(5) / 4);
            this.shadowMirrored = Nri.setupDonutPlanarShadowMap(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2], Ref(bounds[0]),
                SHADOW_MAP_RESOLUTION, SHADOW_FADE_RANGE, Ref(depthConstants[0]), Ref(shadowConstants[0])) != 0;
            const lightConstantsSize = Nri.getDonutConstantsSize(4);
            const lightConstants = [zeros(lightConstantsSize / 4), zeros(lightConstantsSize / 4)];
            for (let k = 0; k < 2; k++) {
                Nri.fillDonutForwardSunLightConstants(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2], SUN_ANGULAR_SIZE,
                    SUN_IRRADIANCE, Ref(shadowConstants[0]), k == 0 ? SHADOW_MAP_RESOLUTION : 0, AMBIENT_TOP, AMBIENT_TOP, AMBIENT_TOP,
                    AMBIENT_BOTTOM, AMBIENT_BOTTOM, AMBIENT_BOTTOM, Ref(lightConstants[k][0]));
            }
            const depthStride = align(depthConstants.length * 4);
            const lightStride = align(lightConstantsSize);
            this.staticStride = depthStride + 2 * lightStride;
            this.viewSize = Nri.getDonutConstantsSize(0);
            this.skySize = Nri.getDonutConstantsSize(7);
            this.toneMappingSize = Nri.getDonutConstantsSize(8);
            this.viewConstants = zeros(this.viewSize / 4);
            this.skyConstants = zeros(this.skySize / 4);
            this.toneMappingConstants = zeros(this.toneMappingSize / 4);
            this.frameStride = align(this.viewSize) + align(this.skySize) + 3 * align(this.toneMappingSize);
            const constantBuffer = device.createHostBuffer(this.staticStride + queuedFrameNum * this.frameStride,
                NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;

            const materialCount = scene.getMaterialCount();
            const blitCount = this.textures.blitSetCount();
            const setNum = 2 * materialCount + 2 + 1 + 1 + 5 * queuedFrameNum + blitCount;
            // (Typed buffers: a queued frame's exposure set reads the histogram, its tone mapping set the
            // exposure; its histogram and exposure sets write one each.)
            const descriptorPool = device.createDescriptorPoolWithTypedBuffers(setNum,
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
            constantBuffer.write(0, Ref(depthConstants[0]), depthConstants.length * 4);
            for (let k = 0; k < 2; k++) {
                constantBuffer.write(depthStride + k * lightStride, Ref(lightConstants[k][0]), lightConstantsSize);
            }

            // A material's sets: the forward pass's (its constants, its textures, black for the slots
            // it doesn't use), the depth pass's (its constants, base color, opacity).
            for (let m = 0; m < materialCount; m++) {
                const set = descriptorPool.allocateDescriptorSet(forwardLayout, 0, 0);
                const depthSet = descriptorPool.allocateDescriptorSet(depthLayout, 0, 0);
                const view = materialBuffer.createConstantView(m * CONSTANTS_ALIGNMENT, CONSTANTS_ALIGNMENT);
                if (!set || !depthSet || !view) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                this.materialSets.push(set);
                this.depthMaterialSets.push(depthSet);
                this.materialViews.push(view);
                set.updateDescriptor(0, 0, view);
                for (let slot = 0; slot < 7; slot++) {
                    const texture = scene.getMaterialTexture(m, slot);
                    set.updateDescriptor(1, slot, texture >= 0 ? this.textures.views[texture] : blackView);
                }
                depthSet.updateDescriptor(0, 0, view);
                const slots = [0, 6];
                for (let k = 0; k < 2; k++) {
                    const texture = scene.getMaterialTexture(m, slots[k]);
                    depthSet.updateDescriptor(1, k, texture >= 0 ? this.textures.views[texture] : blackView);
                }
            }

            // The shading sets: shadows on (the shadow map), off (the fallback).
            for (let k = 0; k < 2; k++) {
                const set = descriptorPool.allocateDescriptorSet(forwardLayout, 2, 0);
                const view = this.constantView(depthStride + k * lightStride, lightStride);
                if (!set || !view) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                set.updateDescriptor(0, 0, view);
                set.updateDescriptor(1, 0, k == 0 ? shadowMapView : noShadowView);
                set.updateDescriptor(1, 1, blackCubeArrayView);
                set.updateDescriptor(1, 2, blackCubeArrayView);
                set.updateDescriptor(1, 3, blackView);
                set.updateDescriptor(2, 0, anisotropicWrap);
                set.updateDescriptor(2, 1, shadowSampler);
                set.updateDescriptor(2, 2, linearWrap);
                set.updateDescriptor(2, 3, linearClamp);
                this.shadingSets.push(set);
            }

            // The depth pass's view set: the shadow map's DepthPassConstants, the material sampler.
            const depthViewSet = descriptorPool.allocateDescriptorSet(depthLayout, 1, 0);
            const depthView = this.constantView(0, depthStride);
            this.depthViewSet = depthViewSet;
            if (!depthViewSet || !depthView) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            depthViewSet.updateDescriptor(0, 0, depthView);
            depthViewSet.updateDescriptor(1, 0, anisotropicWrap);

            const blitSet = descriptorPool.allocateDescriptorSet(blitLayout, 0, 0);
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
            blitSet.updateDescriptor(0, 0, ldrView);
            blitSet.updateDescriptor(1, 0, linearClamp);

            // A queued frame's: the view, the sky, the histogram, the exposure, the tone mapping.
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const base = this.frameOffset(i);
                const viewSet = descriptorPool.allocateDescriptorSet(forwardLayout, 1, 0);
                const skySet = descriptorPool.allocateDescriptorSet(skyLayout, 0, 0);
                const histogramSet = descriptorPool.allocateDescriptorSet(histogramLayout, 0, 0);
                const exposureSet = descriptorPool.allocateDescriptorSet(exposureLayout, 0, 0);
                const toneMappingSet = descriptorPool.allocateDescriptorSet(toneMappingLayout, 0, 0);
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
                viewSet.updateDescriptor(0, 0, viewView);
                skySet.updateDescriptor(0, 0, skyView);
                skySet.updateDescriptor(1, 0, environmentMapView);
                skySet.updateDescriptor(2, 0, linearWrap);
                histogramSet.updateDescriptor(0, 0, histogramConstants);
                histogramSet.updateDescriptor(1, 0, hdrView);
                histogramSet.updateDescriptor(2, 0, histogramStorage);
                exposureSet.updateDescriptor(0, 0, exposureConstants);
                exposureSet.updateDescriptor(1, 0, histogramView);
                exposureSet.updateDescriptor(2, 0, exposureStorage);
                toneMappingSet.updateDescriptor(0, 0, toneMappingConstants);
                toneMappingSet.updateDescriptor(1, 0, hdrView);
                toneMappingSet.updateDescriptor(2, 0, exposureView);
                toneMappingSet.updateDescriptor(3, 0, blackView);
                toneMappingSet.updateDescriptor(4, 0, linearClamp);
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
                this.camera.animate(this.sample, this.sample.getFrameTime(), true);
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

            Nri.fillDonutPlanarViewConstants(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), this.width, this.height,
                Ref(this.viewConstants[0]));
            constantBuffer.write(this.frameOffset(queuedFrameIndex), Ref(this.viewConstants[0]), this.viewSize);
            Nri.fillDonutSkyConstants(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), this.width, this.height, Ref(this.skyConstants[0]));
            constantBuffer.write(this.skyOffset(queuedFrameIndex), Ref(this.skyConstants[0]), this.skySize);
            // (No eye adaptation: a frame time of 0, as Donut_AdvanceToneMappingFrame is never called.)
            for (let stage = 0; stage < 3; stage++) {
                Nri.fillDonutToneMappingConstants(stage, this.width, this.height, 0.0, Ref(this.toneMappingConstants[0]));
                constantBuffer.write(this.toneMappingOffset(queuedFrameIndex, stage), Ref(this.toneMappingConstants[0]),
                    this.toneMappingSize);
            }
        }

        // The fallback shadow map, cleared once (D3D12 wants depth textures initialized before
        // shaders read them).
        clearNoShadow(commandBuffer: NriCommandBuffer) {
            const texture = this.noShadowTexture;
            const attachment = this.noShadowAttachment;
            if (this.noShadowCleared || !texture || !attachment) {
                return;
            }
            commandBuffer.textureBarrier(texture, NriTextureState.ShaderResource, NriTextureState.DepthAttachment);
            commandBuffer.beginRenderingDepthOnly(attachment);
            commandBuffer.clearDepth(0.0);
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(texture, NriTextureState.DepthAttachment, NriTextureState.ShaderResource);
            this.noShadowCleared = true;
        }

        // The draws' geometry (the instances and vertices as root descriptors, the index buffer) and
        // each draw, with set 0 the draw's material set and the pipeline of its key (by the pass).
        recordDraws(commandBuffer: NriCommandBuffer, depthPass: boolean) {
            const indexBuffer = this.indexBuffer;
            const instanceBufferView = this.instanceBufferView;
            const vertexBufferView = this.vertexBufferView;
            if (!indexBuffer || !instanceBufferView || !vertexBufferView) {
                return;
            }
            commandBuffer.setRootDescriptor(0, instanceBufferView, 0);
            commandBuffer.setRootDescriptor(1, vertexBufferView, 0);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
            let pipeline = -1;
            let material = -1;
            for (const item of this.drawItems) {
                const itemPipeline = depthPass
                    ? (item.doubleSided ? 1 : 0) + (item.alphaTested ? 2 : 0) + (this.shadowMirrored ? 4 : 0)
                    : (item.doubleSided ? 1 : 0) + (this.mirrored ? 2 : 0);
                if (itemPipeline != pipeline) {
                    commandBuffer.setPipeline(depthPass ? this.depthPipelines[itemPipeline] : this.forwardPipelines[itemPipeline]);
                    pipeline = itemPipeline;
                }
                if (item.material != material) {
                    commandBuffer.setDescriptorSet(0, depthPass ? this.depthMaterialSets[item.material] : this.materialSets[item.material]);
                    material = item.material;
                }
                if (depthPass) {
                    commandBuffer.setRootConstants(0, Ref(item.depthPush[0]), DEPTH_PUSH_WORDS * 4);
                } else {
                    commandBuffer.setRootConstants(0, Ref(item.forwardPush[0]), FORWARD_PUSH_WORDS * 4);
                }
                commandBuffer.drawIndexed(item.indexCount, 1, item.firstIndex, 0, 0);
            }
        }

        // The shadow map, once (the scene and the sun don't move): cleared to 1, the opaque and
        // alpha-tested geometries drawn by Donut's depth pass from the sun.
        recordShadowMap(commandBuffer: NriCommandBuffer) {
            const shadowMap = this.shadowMap;
            const attachment = this.shadowMapAttachment;
            const layout = this.depthLayout;
            const depthViewSet = this.depthViewSet;
            if (this.shadowMapRendered || !shadowMap || !attachment || !layout || !depthViewSet) {
                return;
            }
            commandBuffer.textureBarrier(shadowMap, NriTextureState.ShaderResource, NriTextureState.DepthAttachment);
            commandBuffer.beginRenderingDepthOnly(attachment);
            commandBuffer.clearDepth(1.0);
            commandBuffer.setViewport(0.0, 0.0, SHADOW_MAP_RESOLUTION, SHADOW_MAP_RESOLUTION);
            commandBuffer.setScissor(0, 0, SHADOW_MAP_RESOLUTION, SHADOW_MAP_RESOLUTION);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setDescriptorSet(1, depthViewSet);
            this.recordDraws(commandBuffer, true);
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(shadowMap, NriTextureState.DepthAttachment, NriTextureState.ShaderResource);
            this.shadowMapRendered = true;
        }

        // The HDR color and depth cleared (to 0), the forward pass's opaque draws, then the
        // environment map behind them.
        recordScene(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const hdrColor = this.hdrColor;
            const hdrAttachment = this.hdrAttachment;
            const depthAttachment = this.depthAttachment;
            const forwardLayout = this.forwardLayout;
            const skyLayout = this.skyLayout;
            const skyPipeline = this.skyPipeline;
            if (!hdrColor || !hdrAttachment || !depthAttachment || !forwardLayout || !skyLayout || !skyPipeline) {
                return;
            }
            commandBuffer.textureBarrier(hdrColor, NriTextureState.AllShaderResource, NriTextureState.ColorAttachment);
            commandBuffer.beginRenderingWithDepth(hdrAttachment, depthAttachment);
            commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
            commandBuffer.clearDepth(0.0);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(forwardLayout);
            commandBuffer.setDescriptorSet(1, queuedFrame.viewSet);
            commandBuffer.setDescriptorSet(2, this.shadingSets[this.enableShadows ? 0 : 1]);
            this.recordDraws(commandBuffer, false);

            // Behind everything opaque.
            commandBuffer.setPipelineLayout(skyLayout);
            commandBuffer.setPipeline(skyPipeline);
            commandBuffer.setDescriptorSet(0, queuedFrame.skySet);
            commandBuffer.draw(4, 1, 0, 0);
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(hdrColor, NriTextureState.ColorAttachment, NriTextureState.AllShaderResource);
        }

        // Donut's ToneMappingPass::SimpleRender: the histogram zeroed and filled from the HDR color,
        // the exposure computed from it (kept as it is: no frame time), the HDR color tone mapped
        // into the LDR color.
        recordToneMapping(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
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
            commandBuffer.zeroBuffer(histogram);
            commandBuffer.bufferBarrier(histogram, NriBufferState.CopyDestination, NriBufferState.Storage);
            commandBuffer.setComputePipelineLayout(histogramLayout);
            commandBuffer.setPipeline(histogramPipeline);
            commandBuffer.setComputeDescriptorSet(0, queuedFrame.histogramSet);
            commandBuffer.dispatch(Math.floor((this.width + TONE_MAPPING_GROUP_SIZE - 1) / TONE_MAPPING_GROUP_SIZE),
                Math.floor((this.height + TONE_MAPPING_GROUP_SIZE - 1) / TONE_MAPPING_GROUP_SIZE), 1);
            commandBuffer.bufferBarrier(histogram, NriBufferState.Storage, NriBufferState.ComputeShaderResource);
            commandBuffer.setComputePipelineLayout(exposureLayout);
            commandBuffer.setPipeline(exposurePipeline);
            commandBuffer.setComputeDescriptorSet(0, queuedFrame.exposureSet);
            commandBuffer.dispatch(1, 1, 1);
            commandBuffer.bufferBarrier(histogram, NriBufferState.ComputeShaderResource, NriBufferState.CopyDestination);
            commandBuffer.bufferBarrier(exposure, NriBufferState.Storage, NriBufferState.PixelShaderResource);

            commandBuffer.textureBarrier(ldrColor, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(ldrAttachment);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(toneMappingLayout);
            commandBuffer.setPipeline(toneMappingPipeline);
            commandBuffer.setDescriptorSet(0, queuedFrame.toneMappingSet);
            commandBuffer.draw(4, 1, 0, 0);
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(ldrColor, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
            commandBuffer.bufferBarrier(exposure, NriBufferState.PixelShaderResource, NriBufferState.Storage);
        }

        // The LDR color over the swap chain texture (between NriCommandBuffer.beginRendering and
        // NriCommandBuffer.endRendering), as Donut's BlitTexture draws it.
        recordBlit(commandBuffer: NriCommandBuffer) {
            const layout = this.blitLayout;
            const pipeline = this.blitPipeline;
            const blitSet = this.blitSet;
            if (!layout || !pipeline || !blitSet) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setRootConstants(0, Ref(this.blitConstants[0]), BLIT_CONSTANTS.length * 4);
            commandBuffer.setDescriptorSet(0, blitSet);
            commandBuffer.draw(4, 1, 0, 0);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.sample.isKeyToggled(NriKey.Space) != 0) {
                this.enableShadows = !this.enableShadows;
                this.sample.setWindowTitle(`${WINDOW_TITLE} - shadows ${this.enableShadows ? "on" : "off"}`);
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
            commandBuffer.begin();
            commandBuffer.setDescriptorPool(descriptorPool);
            // The first frame: the mip chains, the fallback, the shadow map.
            this.textures.recordBlits(commandBuffer);
            this.clearNoShadow(commandBuffer);
            if (this.enableShadows) {
                this.recordShadowMap(commandBuffer);
            }
            this.recordScene(commandBuffer, queuedFrame);
            this.recordToneMapping(commandBuffer, queuedFrame);

            commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.Undefined, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
            this.recordBlit(commandBuffer);
            commandBuffer.endRendering();

            // The test's last frame: read back
            let presentFrom = NriTextureState.ColorAttachment;
            const readbackBuffer = this.readbackBuffer;
            if (readbackBuffer) {
                if (frameIndex == TEST_FRAMES - 1) {
                    commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.ColorAttachment, NriTextureState.CopySource);
                    commandBuffer.readbackTextureToBuffer(readbackBuffer, this.rowPitch, this.swapChain.texture(index), this.width, this.height);
                    presentFrom = NriTextureState.CopySource;
                }
            }
            commandBuffer.textureBarrier(this.swapChain.texture(index), presentFrom, NriTextureState.Present);
            commandBuffer.end();

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
            device.waitIdle();
            const pixels: int[] = [];
            for (let i = 0; i < this.width * this.height; i++) {
                pixels.push(0);
            }
            if (readbackBuffer.readRGBA8(this.rowPitch, this.width, this.height, this.readbackFormat,
                Ref(pixels[0]), pixels.length) == 0) {
                return [];
            }
            return pixels;
        }

        destroy() {
            const device = this.device;
            if (device) {
                device.waitIdle();
                this.swapChain.destroy();
                this.destroySizedTargets();
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.textures.destroy();
                const descriptors = [this.vertexBufferView, this.instanceBufferView, this.environmentMapView, this.shadowMapAttachment,
                    this.shadowMapView, this.histogramStorage, this.histogramView, this.exposureStorage, this.exposureView, this.blackView,
                    this.blackCubeArrayView, this.noShadowView, this.noShadowAttachment, this.anisotropicWrap, this.linearWrap,
                    this.linearClamp, this.shadowSampler];
                for (const descriptor of descriptors) {
                    if (descriptor) {
                        descriptor.destroy();
                    }
                }
                for (const view of this.materialViews) {
                    view.destroy();
                }
                for (const view of this.constantViews) {
                    view.destroy();
                }
                const textures = [this.environmentMap, this.shadowMap, this.noShadowTexture];
                for (const texture of textures) {
                    if (texture) {
                        texture.destroy();
                    }
                }
                for (const texture of this.solidTextures) {
                    texture.destroy();
                }
                const buffers = [this.vertexBuffer, this.instanceBuffer, this.indexBuffer, this.materialBuffer, this.histogram,
                    this.exposure, this.constantBuffer, this.readbackBuffer];
                for (const buffer of buffers) {
                    if (buffer) {
                        buffer.destroy();
                    }
                }
                for (const pipeline of this.forwardPipelines) {
                    pipeline.destroy();
                }
                for (const pipeline of this.depthPipelines) {
                    pipeline.destroy();
                }
                const pipelines = [this.skyPipeline, this.histogramPipeline, this.exposurePipeline, this.toneMappingPipeline, this.blitPipeline];
                for (const pipeline of pipelines) {
                    if (pipeline) {
                        pipeline.destroy();
                    }
                }
                const layouts = [this.forwardLayout, this.depthLayout, this.skyLayout, this.histogramLayout, this.exposureLayout,
                    this.toneMappingLayout, this.blitLayout];
                for (const layout of layouts) {
                    if (layout) {
                        layout.destroy();
                    }
                }
                this.frames.destroy();
                device.destroy();
            }
            const scene = this.scene;
            if (scene) {
                scene.destroy();
            }
            this.sample.destroy();
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const environmentMap = new EnvironmentMap(sample);
        // --scene <path>: relative to the executable's directory.
        sample.addExampleOptionWithValues("--scene", 1);
        for (let i = 1; i < argc; i++) {
            if (Nri.getArg(argc, argv, i) == "--scene" && i + 1 < argc) {
                environmentMap.scenePath = Nri.getArg(argc, argv, i + 1);
            }
        }
        return environmentMap.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return EnvironmentMapNri.main(argc, argv);
}

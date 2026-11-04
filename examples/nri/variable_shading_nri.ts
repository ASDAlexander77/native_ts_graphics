/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { perspProjD3DStyleReverse } from "../../core/matrix";
import { DonutFirstPersonCamera } from "../../core/donut_first_person_camera";
import { DonutSceneTextures } from "../../core/nri_donut_textures";
import { DonutBlit } from "../../core/nri_donut_blit";

namespace VariableShadingNri {
    // variable_shading, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: Donut's passes' shaders (forward shading, TAA's motion vectors and resolve, the
    // blit: shaders/framework, as Donut compiles them) and the example's shading rate compute shader,
    // the scene loaded as Donut's engine loads it (core/nri/nri_donut_scene.cpp,
    // core/nri_donut_textures.ts), the constants filled as Donut fills them
    // (core/nri/nri_donut_constants.cpp), through the NRI calls core/nri/nri_interop.d.ts binds.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Variable Rate Shading";
    const DEFAULT_SCENE = "media/glTF-Sample-Assets/Models/Sponza/glTF/Sponza.gltf";

    // The sun (the Donut example's addDirectionalLight arguments): no shadow map.
    const SUN_DIRECTION = [0.1, -1.0, 0.15];
    const SUN_ANGULAR_SIZE = 0.53;
    const SUN_IRRADIANCE = 2.0;
    // The ambient light from above and below.
    const AMBIENT_COLOR = 0.2;

    // The Donut example's camera: Donut's FirstPersonCamera, reversed depth from 0.1, a 45 degree
    // field of view.
    const MOVE_SPEED = 3.0;
    const ROTATE_SPEED = 0.005;
    const Z_NEAR = 0.1;

    // ForwardPushConstants (forward_cb.h): startInstanceLocation, startVertexLocation, then the
    // position, texture coordinate, normal and tangent streams' offsets.
    const FORWARD_PUSH_WORDS = 6;

    // Material domains: what InstancedOpaqueDrawStrategy draws (MaterialDomain_Opaque,
    // _AlphaTested). TransparentDrawStrategy's draws (the Donut example's second forward pass) aren't
    // drawn: Sponza has no transparent materials.
    const DOMAIN_OPAQUE = 0;
    const DOMAIN_ALPHA_TESTED = 1;

    // The TAA pass's stencil mask (Donut_CreateTemporalAntiAliasingPass: motion vectors where the
    // stencil has bit 0 set are the geometry's own; nothing writes the stencil here).
    const MOTION_VECTOR_STENCIL_MASK = 0x01;
    // taa_cs's groups (16 x 16 pixels); the shading rate compute shader's (one tile, 16 x 16 pixels,
    // a thread).
    const TAA_GROUP_SIZE = 16;

    // Constant buffer views' alignment.
    const CONSTANTS_ALIGNMENT = 256;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // -test: checks the last frame, read back, as the Donut example does: Sponza fills it (about 99%
    // lit).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        let dark = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r <= 20 && g <= 20 && b <= 20) {
                dark++;
            }
        }
        const lit = 100.0 * (total - dark) / total;
        console.log(`Lit: ${lit}% (${total - dark} of ${total} pixels)`);
        if (lit < 90.0 || lit > 100.0) {
            return `Lit: ${lit}% of the pixels, not 90% to 100%`;
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
            public viewSet: NriDescriptorSetHandle, public motionVectorsSet: NriDescriptorSetHandle,
            public resolveSet: NriDescriptorSetHandle) {
        }
    }

    // A draw of the forward pass: a geometry of an instance with its material.
    class DrawItem {
        constructor(public material: int, public doubleSided: boolean, public indexCount: int, public firstIndex: int,
            public forwardPush: f32[]) {
        }
    }

    // Port of Donut-Samples' variable_shading.cpp (NVIDIA Variable Rate Shading sample), as
    // examples/variable_shading.ts ports it, to NRI: a compute shader fills a shading rate surface
    // from the previous frame (coarse 4x4 shading where its tile was more green than red), the scene
    // is forward-shaded with it (the attachment's rate overriding the draws' 1x1), then Donut's TAA
    // runs at full rate (motion vectors from the camera's movement, the resolve; no jitter: the view
    // has no pixel offset, and the pass's frame never advances, so the feedback read is always the
    // first one). With -raw (D3D12) the Donut example binds the surface through D3D12 directly, every
    // combiner at MAX: the same rates, set here as NRI's combiners. WASD/QE and the left mouse button
    // move the camera (Donut's FirstPersonCamera).
    class VariableShading {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private width: int = 0;
        private height: int = 0;
        private test: boolean = false;
        scenePath: string = DEFAULT_SCENE;
        // -raw: the Donut example's D3D12 path (every combiner at MAX).
        rawD3D12: boolean = false;
        // Why the example can't run (D3D11: the Donut example's message and exit code 1; a device
        // without variable rate shading: skipped under -test).
        private d3d11: boolean = false;
        private unsupportedReason: string = "";

        // The scene and its draws.
        private scene: NriDonutSceneHandle | null = null;
        private vertexBuffer: NriBufferHandle | null = null;
        private vertexBufferView: NriDescriptorHandle | null = null;
        private instanceBuffer: NriBufferHandle | null = null;
        private instanceBufferView: NriDescriptorHandle | null = null;
        private indexBuffer: NriBufferHandle | null = null;
        private materialBuffer: NriBufferHandle | null = null;
        private materialViews: NriDescriptorHandle[] = [];
        private materialSets: NriDescriptorSetHandle[] = [];
        private textures: DonutSceneTextures = new DonutSceneTextures();
        private drawItems: DrawItem[] = [];

        // Donut_CreateTemporalTargets' targets: D24S8 depth (cleared to 0 and stencil 0 every frame),
        // RGBA16F HDR color, RG16F motion vectors, the TAA's RGBA16F resolved color and feedback (the
        // one read, RGBA16_SNORM, never written: zeros, as D3D12's fresh textures; the one written,
        // never read, RGBA16F here: taa_cs declares it rgba16f, which NRIFramework's Vulkan validation
        // holds the view to). The shading rate surface (R8_UINT, a texel per tile).
        private depth: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private depthView: NriDescriptorHandle | null = null;
        private stencilView: NriDescriptorHandle | null = null;
        private hdrColor: NriTextureHandle | null = null;
        private hdrAttachment: NriDescriptorHandle | null = null;
        private hdrView: NriDescriptorHandle | null = null;
        private motionVectors: NriTextureHandle | null = null;
        private motionVectorsAttachment: NriDescriptorHandle | null = null;
        private motionVectorsView: NriDescriptorHandle | null = null;
        private resolvedColor: NriTextureHandle | null = null;
        private resolvedStorage: NriDescriptorHandle | null = null;
        private resolvedView: NriDescriptorHandle | null = null;
        private feedbackInput: NriTextureHandle | null = null;
        private feedbackInputView: NriDescriptorHandle | null = null;
        private feedbackOutput: NriTextureHandle | null = null;
        private feedbackOutputStorage: NriDescriptorHandle | null = null;
        private shadingRateSurface: NriTextureHandle | null = null;
        private shadingRateAttachment: NriDescriptorHandle | null = null;
        private shadingRateStorage: NriDescriptorHandle | null = null;
        private vrsTileSize: int = 0;
        private surfaceWidth: int = 0;
        private surfaceHeight: int = 0;
        // The first frame clears the HDR color and the motion vectors (the shading rate shader reads
        // them before anything draws them, as Donut's zeroed textures); the resolved color starts in
        // NriTextureState.Storage.
        private targetsCleared: boolean = false;
        private resolvedInStorage: boolean = true;

        // CommonRenderPasses' fallbacks: black, a black cubemap array, a depth texture array (the
        // forward pass's shadow map: none; cleared once).
        private solidTextures: NriTextureHandle[] = [];
        private blackView: NriDescriptorHandle | null = null;
        private blackCubeArrayView: NriDescriptorHandle | null = null;
        private noShadowTexture: NriTextureHandle | null = null;
        private noShadowView: NriDescriptorHandle | null = null;
        private noShadowAttachment: NriDescriptorHandle | null = null;
        private noShadowCleared: boolean = false;

        // The passes' layouts and pipelines: the forward pass's (by cull mode and front face), the
        // motion vectors', the shading rate surface's, the resolve's; the blit.
        private forwardLayout: NriPipelineLayoutHandle | null = null;
        private forwardPipelines: NriPipelineHandle[] = [];
        private motionVectorsLayout: NriPipelineLayoutHandle | null = null;
        private motionVectorsPipeline: NriPipelineHandle | null = null;
        private shadingRateLayout: NriPipelineLayoutHandle | null = null;
        private shadingRatePipeline: NriPipelineHandle | null = null;
        private resolveLayout: NriPipelineLayoutHandle | null = null;
        private resolvePipeline: NriPipelineHandle | null = null;
        private blit: DonutBlit = new DonutBlit();

        // CommonRenderPasses' samplers (anisotropic wrap, linear wrap, linear clamp), the forward
        // pass's shadow sampler (border, white), the TAA's bilinear sampler (border, black).
        private anisotropicWrap: NriDescriptorHandle | null = null;
        private linearWrap: NriDescriptorHandle | null = null;
        private linearClamp: NriDescriptorHandle | null = null;
        private shadowSampler: NriDescriptorHandle | null = null;
        private bilinearBorder: NriDescriptorHandle | null = null;

        // The constant buffer: the static constants (the forward light constants), then a queued
        // frame's (the view, the motion vectors' and the resolve's TAA constants).
        private constantBuffer: NriBufferHandle | null = null;
        private constantViews: NriDescriptorHandle[] = [];
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private shadingSet: NriDescriptorSetHandle | null = null;
        private shadingRateSet: NriDescriptorSetHandle | null = null;
        private blitSet: NriDescriptorSetHandle | null = null;
        private viewSize: int = 0;
        private taaSize: int = 0;
        private staticStride: int = 0;
        private frameStride: int = 0;

        private camera: DonutFirstPersonCamera = new DonutFirstPersonCamera(MOVE_SPEED, ROTATE_SPEED);
        private viewMatrix: f32[] = zeros(16);
        private projMatrix: f32[] = zeros(16);
        // The previous frame's view (the Donut example's viewPrevious), valid after the first frame.
        private prevViewMatrix: f32[] = zeros(16);
        private prevProjMatrix: f32[] = zeros(16);
        private previousViewsValid: boolean = false;
        private mirrored: boolean = false;
        private viewConstants: f32[] = [];
        private taaConstants: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
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
            if (this.d3d11) {
                console.log("The Variable Rate Shading example does not support D3D11.");
                result = 1;
            } else if (this.unsupportedReason != "") {
                const test = Nri_IsTest(this.sample) != 0;
                console.log(test ? `Test SKIPPED: ${this.unsupportedReason}` : this.unsupportedReason);
                result = test ? 77 : 1;
            } else if (result == 0 && this.test) {
                const failure = checkFrame(this.readBack(), this.width, this.height);
                console.log(failure == "" ? "Test PASSED" : `Test FAILED: ${failure}`);
                result = failure == "" ? 0 : 1;
            }
            this.destroy();
            return result;
        }

        initialize(graphicsAPI: NriGraphicsAPI): int {
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.d3d11 = true;
                return 0;
            }
            const device = Nri_CreateDevice(this.sample, graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri_GetGraphicsAPIString(graphicsAPI)} (${Nri_GetAdapterName(device)})`);
            // -raw is the Donut example's D3D12 path only.
            this.rawD3D12 = this.rawD3D12 && graphicsAPI == NriGraphicsAPI.D3D12;

            this.queue = Nri_GetGraphicsQueue(device);
            this.test = Nri_IsTest(this.sample) != 0;

            // Swap chain: blitted into through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.viewFormat;

            if (Nri_IsFeatureSupported(device, NriFeature.VariableRateShading) == 0) {
                this.unsupportedReason = "The device does not support Variable Rate Shading";
                return 0;
            }
            // The VRS tile size (it can vary depending on hardware): the surface is about 1 / tileSize
            // of the frame in both dimensions (rounded up; createSizeTargets).
            this.vrsTileSize = Nri_GetShadingRateTileSize(device);
            if (this.vrsTileSize == 0) {
                this.unsupportedReason = "The device does not support Variable Rate Shading";
                return 0;
            }

            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            if (!this.loadScene(device, folder) || !this.createTargets(device) || !this.createLayouts(device)
                || !this.createPipelines(device, folder) || !this.blit.init(device, folder, viewFormat)
                || !this.createDescriptorSets(device, queuedFrameNum)) {
                return 0;
            }

            this.camera.lookAt(0.0, 1.8, 0.0, 1.0, 1.8, 0.0);

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
        loadScene(device: NriDeviceHandle, folder: string) {
            const scene = Nri_LoadDonutScene(this.scenePath);
            this.scene = scene;
            if (!scene) {
                console.log(`Cannot load the scene ${this.scenePath}`);
                return false;
            }
            const vertexBuffer = Nri_CreateDonutSceneBuffer(device, this.queue, scene, 0);
            const instanceBuffer = Nri_CreateDonutSceneBuffer(device, this.queue, scene, 2);
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
                        this.drawItems.push(new DrawItem(drawnMaterial, doubleSided,
                            Nri_GetDonutSceneGeometryIndexCount(scene, instance, geometry),
                            Nri_GetDonutSceneGeometryFirstIndex(scene, instance, geometry), forwardPush));
                    }
                }
            }
            return this.textures.load(device, this.queue, scene, folder);
        }

        // The temporal targets, the shading rate surface, the fallbacks.
        createTargets(device: NriDeviceHandle) {
            if (!this.createSizeTargets(device)) {
                return false;
            }

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

        // The window-sized targets: the temporal targets and the shading rate surface (a texel per
        // VRS tile), in the states the frames expect first (targetsCleared, resolvedInStorage).
        createSizeTargets(device: NriDeviceHandle) {
            this.surfaceWidth = Math.floor((this.width + this.vrsTileSize - 1) / this.vrsTileSize);
            this.surfaceHeight = Math.floor((this.height + this.vrsTileSize - 1) / this.vrsTileSize);
            const width = this.width;
            const height = this.height;
            const depth = Nri_CreateSampledDepthTexture(device, this.queue, width, height, NriFormat.D24_UNORM_S8_UINT);
            this.depth = depth;
            const hdrColor = Nri_CreateRenderTargetTexture(device, this.queue, width, height, NriFormat.RGBA16_SFLOAT);
            this.hdrColor = hdrColor;
            const motionVectors = Nri_CreateRenderTargetTexture(device, this.queue, width, height, NriFormat.RG16_SFLOAT);
            this.motionVectors = motionVectors;
            const resolvedColor = Nri_CreateStorageTexture(device, this.queue, width, height, NriFormat.RGBA16_SFLOAT);
            this.resolvedColor = resolvedColor;
            const feedbackOutput = Nri_CreateStorageTexture(device, this.queue, width, height, NriFormat.RGBA16_SFLOAT);
            this.feedbackOutput = feedbackOutput;
            // The feedback taa_cs reads: zeros (8 bytes a texel), left in NriTextureState.ShaderResource.
            const feedbackInput = Nri_CreateCommittedTexture(device, width, height, NriFormat.RGBA16_SNORM);
            this.feedbackInput = feedbackInput;
            let feedbackUploaded = false;
            if (feedbackInput) {
                const feedbackZeros: int[] = [];
                for (let i = 0; i < width * height * 2; i++) {
                    feedbackZeros.push(0);
                }
                feedbackUploaded = Nri_UploadTexture(this.queue, feedbackInput, Ref(feedbackZeros[0]), width * 8) != 0;
            }
            // The shading rate surface, written by the compute shader before every forward pass (its
            // first contents never read).
            const surfaceZeros: int[] = [];
            const surfaceRowPitch = Math.floor((this.surfaceWidth + 3) / 4) * 4;
            for (let i = 0; i < Math.floor(surfaceRowPitch / 4) * this.surfaceHeight; i++) {
                surfaceZeros.push(0);
            }
            const shadingRateSurface = Nri_CreateShadingRateTexture(device, this.queue, this.surfaceWidth, this.surfaceHeight,
                Ref(surfaceZeros[0]), surfaceRowPitch, 1);
            this.shadingRateSurface = shadingRateSurface;
            if (!depth || !hdrColor || !motionVectors || !resolvedColor || !feedbackOutput || !feedbackInput || !feedbackUploaded) {
                console.log("Cannot create the render targets");
                return false;
            }
            if (!shadingRateSurface) {
                console.log("Cannot create the shading rate surface");
                return false;
            }
            this.depthAttachment = Nri_CreateDepthAttachmentView(depth, NriFormat.D24_UNORM_S8_UINT);
            this.depthView = Nri_CreateTextureView(depth, NriFormat.R24_UNORM_X8);
            this.stencilView = Nri_CreateTextureView(depth, NriFormat.X24_G8_UINT);
            this.hdrAttachment = Nri_CreateColorAttachmentView(hdrColor, NriFormat.RGBA16_SFLOAT);
            this.hdrView = Nri_CreateTextureView(hdrColor, NriFormat.RGBA16_SFLOAT);
            this.motionVectorsAttachment = Nri_CreateColorAttachmentView(motionVectors, NriFormat.RG16_SFLOAT);
            this.motionVectorsView = Nri_CreateTextureView(motionVectors, NriFormat.RG16_SFLOAT);
            this.resolvedStorage = Nri_CreateStorageTextureView(resolvedColor, NriFormat.RGBA16_SFLOAT);
            this.resolvedView = Nri_CreateTextureView(resolvedColor, NriFormat.RGBA16_SFLOAT);
            this.feedbackInputView = Nri_CreateTextureView(feedbackInput, NriFormat.RGBA16_SNORM);
            this.feedbackOutputStorage = Nri_CreateStorageTextureView(feedbackOutput, NriFormat.RGBA16_SFLOAT);
            this.shadingRateAttachment = Nri_CreateShadingRateAttachmentView(shadingRateSurface);
            this.shadingRateStorage = Nri_CreateStorageTextureView(shadingRateSurface, NriFormat.R8_UINT);
            return true;
        }

        destroySizeTargets() {
            const descriptors = [this.depthAttachment, this.depthView, this.stencilView, this.hdrAttachment, this.hdrView,
                this.motionVectorsAttachment, this.motionVectorsView, this.resolvedStorage, this.resolvedView,
                this.feedbackInputView, this.feedbackOutputStorage, this.shadingRateAttachment, this.shadingRateStorage];
            for (const descriptor of descriptors) {
                if (descriptor) {
                    Nri_DestroyDescriptor(descriptor);
                }
            }
            const textures = [this.depth, this.hdrColor, this.motionVectors, this.resolvedColor, this.feedbackInput,
                this.feedbackOutput, this.shadingRateSurface];
            for (const texture of textures) {
                if (texture) {
                    Nri_DestroyTexture(texture);
                }
            }
            this.depthAttachment = null;
            this.depthView = null;
            this.stencilView = null;
            this.hdrAttachment = null;
            this.hdrView = null;
            this.motionVectorsAttachment = null;
            this.motionVectorsView = null;
            this.resolvedStorage = null;
            this.resolvedView = null;
            this.feedbackInputView = null;
            this.feedbackOutputStorage = null;
            this.shadingRateAttachment = null;
            this.shadingRateStorage = null;
            this.depth = null;
            this.hdrColor = null;
            this.motionVectors = null;
            this.resolvedColor = null;
            this.feedbackInput = null;
            this.feedbackOutput = null;
            this.shadingRateSurface = null;
        }

        // The sets' slots of the window-sized targets pointed at the current ones: the shading rate
        // surface's, the blit's and every queued frame's motion vectors' and resolve's.
        updateSizeDescriptors() {
            const depthView = this.depthView;
            const stencilView = this.stencilView;
            const hdrView = this.hdrView;
            const motionVectorsView = this.motionVectorsView;
            const feedbackInputView = this.feedbackInputView;
            const resolvedStorage = this.resolvedStorage;
            const resolvedView = this.resolvedView;
            const feedbackOutputStorage = this.feedbackOutputStorage;
            const shadingRateStorage = this.shadingRateStorage;
            if (!depthView || !stencilView || !hdrView || !motionVectorsView || !feedbackInputView || !resolvedStorage) {
                return;
            }
            if (!resolvedView || !feedbackOutputStorage || !shadingRateStorage) {
                return;
            }
            const shadingRateSet = this.shadingRateSet;
            if (shadingRateSet) {
                Nri_UpdateDescriptor(shadingRateSet, 0, 0, shadingRateStorage);
                Nri_UpdateDescriptor(shadingRateSet, 1, 0, motionVectorsView);
                Nri_UpdateDescriptor(shadingRateSet, 1, 1, hdrView);
            }
            const blitSet = this.blitSet;
            if (blitSet) {
                Nri_UpdateDescriptor(blitSet, 0, 0, resolvedView);
            }
            for (const queuedFrame of this.queuedFrames) {
                Nri_UpdateDescriptor(queuedFrame.motionVectorsSet, 1, 0, depthView);
                Nri_UpdateDescriptor(queuedFrame.motionVectorsSet, 1, 1, stencilView);
                Nri_UpdateDescriptor(queuedFrame.resolveSet, 2, 0, hdrView);
                Nri_UpdateDescriptor(queuedFrame.resolveSet, 2, 1, motionVectorsView);
                Nri_UpdateDescriptor(queuedFrame.resolveSet, 2, 2, feedbackInputView);
                Nri_UpdateDescriptor(queuedFrame.resolveSet, 2, 3, hdrView);
                Nri_UpdateDescriptor(queuedFrame.resolveSet, 3, 0, resolvedStorage);
                Nri_UpdateDescriptor(queuedFrame.resolveSet, 3, 1, feedbackOutputStorage);
            }
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

            // The motion vectors (motion_vectors_ps with USE_STENCIL): b0 the TAA constants, t0 the
            // depth, t1 the stencil.
            const motionVectorsDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(motionVectorsDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(motionVectorsDesc, 0, 0, 2, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            this.motionVectorsLayout = Nri_CreatePipelineLayoutFromDesc(device, motionVectorsDesc);
            Nri_DestroyPipelineLayoutDesc(motionVectorsDesc);

            // The shading rate surface (variable_shading.hlsl's main_cs): u0 the surface, t0 the motion
            // vectors, t1 the previous frame's HDR color.
            const shadingRateDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(shadingRateDesc, 0, 0, 1, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(shadingRateDesc, 0, 0, 2, NriDescriptorType.Texture, NriStage.Compute, NriRangeFlags.None);
            this.shadingRateLayout = Nri_CreatePipelineLayoutFromDesc(device, shadingRateDesc);
            Nri_DestroyPipelineLayoutDesc(shadingRateDesc);

            // The resolve (taa_cs): b0, s0, t0 the HDR color, t1 the motion vectors, t2 the feedback
            // read, t3 the history clamp relax mask (none: the HDR color, as Donut binds it), u0 the
            // resolved color, u1 the feedback written.
            const resolveDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(resolveDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(resolveDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(resolveDesc, 0, 0, 4, NriDescriptorType.Texture, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(resolveDesc, 0, 0, 2, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
            this.resolveLayout = Nri_CreatePipelineLayoutFromDesc(device, resolveDesc);
            Nri_DestroyPipelineLayoutDesc(resolveDesc);

            if (!this.forwardLayout || !this.motionVectorsLayout || !this.shadingRateLayout || !this.resolveLayout) {
                console.log("Cannot create the pipeline layouts");
                return false;
            }
            return true;
        }

        createPipelines(device: NriDeviceHandle, folder: string) {
            const forwardLayout = this.forwardLayout;
            const motionVectorsLayout = this.motionVectorsLayout;
            const shadingRateLayout = this.shadingRateLayout;
            const resolveLayout = this.resolveLayout;
            if (!forwardLayout || !motionVectorsLayout || !shadingRateLayout || !resolveLayout) {
                return false;
            }
            const framework = `shaders/framework/${folder}`;

            // Forward shading, by key: bit 0 no culling (double-sided), bit 1 counterclockwise front
            // faces (a mirrored view); reverse depth (greater or equal, written); variable rate
            // shading (the view's VariableRateShadingState, in the pipelines Donut makes for it).
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
                Nri_PipelineDescSetShadingRate(desc, 1);
                const pipeline = loaded ? Nri_CreatePipelineFromDesc(device, forwardLayout, desc) : null;
                Nri_DestroyPipelineDesc(desc);
                if (!pipeline) {
                    console.log("Cannot load the forward shading shaders");
                    return false;
                }
                this.forwardPipelines.push(pipeline);
            }

            // The motion vectors: CommonRenderPasses' fullscreen_vs (its quad at depth 0), a triangle
            // strip, not culled, no depth test, into the RG16F motion vectors.
            const motionVectorsDesc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShaderPermutation(motionVectorsDesc, NriShaderStage.Vertex, `${framework}/fullscreen_vs.bin`, "main",
                "QUAD_Z=0") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShaderPermutation(motionVectorsDesc, NriShaderStage.Pixel, `${framework}/passes/motion_vectors_ps.bin`,
                    "main", "USE_STENCIL=1") != 0;
            }
            Nri_PipelineDescSetTopology(motionVectorsDesc, NriTopology.TriangleStrip);
            Nri_PipelineDescSetColor(motionVectorsDesc, NriFormat.RG16_SFLOAT, NriColorWrite.RGBA);
            this.motionVectorsPipeline = loaded ? Nri_CreatePipelineFromDesc(device, motionVectorsLayout, motionVectorsDesc) : null;
            Nri_DestroyPipelineDesc(motionVectorsDesc);

            this.shadingRatePipeline = Nri_CreateComputePipeline(device, shadingRateLayout,
                `shaders/variable_shading/${folder}/variable_shading_main_cs.bin`, "main_cs");
            // TAA's resolve: one sample, the Catmull-Rom filter (Donut_CreateTemporalAntiAliasingPass's).
            this.resolvePipeline = Nri_CreateComputePipelinePermutation(device, resolveLayout, `${framework}/passes/taa_cs.bin`, "main",
                "SAMPLE_COUNT=1 USE_CATMULL_ROM_FILTER=1");

            if (!this.motionVectorsPipeline || !this.shadingRatePipeline || !this.resolvePipeline) {
                console.log("Cannot load the TAA and shading rate shaders");
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

        // The samplers; the constant buffer: the static constants (the forward light constants), then a
        // queued frame's; the sets.
        createDescriptorSets(device: NriDeviceHandle, queuedFrameNum: int) {
            const scene = this.scene;
            const materialBuffer = this.materialBuffer;
            const forwardLayout = this.forwardLayout;
            const motionVectorsLayout = this.motionVectorsLayout;
            const shadingRateLayout = this.shadingRateLayout;
            const resolveLayout = this.resolveLayout;
            if (!scene || !materialBuffer || !forwardLayout || !motionVectorsLayout || !shadingRateLayout || !resolveLayout) {
                return false;
            }
            this.anisotropicWrap = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.Repeat, 16);
            this.linearWrap = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.Repeat, 1);
            this.linearClamp = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            this.shadowSampler = Nri_CreateBorderSampler(device, NriFilter.Linear, 1);
            this.bilinearBorder = Nri_CreateBorderSampler(device, NriFilter.Linear, 0);

            // The static constants: the forward light constants (the sun, no shadow map; its shadow
            // constants unused).
            const lightConstantsSize = Nri_GetDonutConstantsSize(4);
            const lightConstants = zeros(lightConstantsSize / 4);
            const noShadowConstants = zeros(Nri_GetDonutConstantsSize(5) / 4);
            Nri_FillDonutForwardSunLightConstants(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2], SUN_ANGULAR_SIZE, SUN_IRRADIANCE,
                Ref(noShadowConstants[0]), 0, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR,
                Ref(lightConstants[0]));
            this.staticStride = align(lightConstantsSize);
            this.viewSize = Nri_GetDonutConstantsSize(0);
            this.taaSize = Nri_GetDonutConstantsSize(9);
            this.viewConstants = zeros(this.viewSize / 4);
            this.taaConstants = zeros(this.taaSize / 4);
            this.frameStride = align(this.viewSize) + 2 * align(this.taaSize);
            const constantBuffer = Nri_CreateHostBuffer(device, this.staticStride + queuedFrameNum * this.frameStride,
                NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;

            const materialCount = Nri_GetDonutSceneMaterialCount(scene);
            const blitCount = this.textures.blitSetCount();
            const setNum = materialCount + 1 + 1 + 1 + 3 * queuedFrameNum + blitCount;
            const descriptorPool = Nri_CreateDescriptorPool(device, setNum,
                4 + queuedFrameNum + 1 + blitCount,
                materialCount + 1 + 3 * queuedFrameNum,
                7 * materialCount + 4 + 2 + 6 * queuedFrameNum + 1 + blitCount,
                1 + 2 * queuedFrameNum, 0);
            this.descriptorPool = descriptorPool;
            const blackView = this.blackView;
            const blackCubeArrayView = this.blackCubeArrayView;
            const noShadowView = this.noShadowView;
            const anisotropicWrap = this.anisotropicWrap;
            const linearWrap = this.linearWrap;
            const linearClamp = this.linearClamp;
            const shadowSampler = this.shadowSampler;
            const bilinearBorder = this.bilinearBorder;
            if (!constantBuffer || !descriptorPool || !blackView || !blackCubeArrayView || !noShadowView) {
                console.log("Cannot create the descriptors");
                return false;
            }
            if (!anisotropicWrap || !linearWrap || !linearClamp || !shadowSampler || !bilinearBorder) {
                console.log("Cannot create the samplers");
                return false;
            }
            Nri_WriteBuffer(constantBuffer, 0, Ref(lightConstants[0]), lightConstantsSize);

            // A material's set: its constants, its textures (black for the slots it doesn't use).
            for (let m = 0; m < materialCount; m++) {
                const set = Nri_AllocateDescriptorSet(descriptorPool, forwardLayout, 0, 0);
                const view = Nri_CreateConstantBufferView(materialBuffer, m * CONSTANTS_ALIGNMENT, CONSTANTS_ALIGNMENT);
                if (!set || !view) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                this.materialSets.push(set);
                this.materialViews.push(view);
                Nri_UpdateDescriptor(set, 0, 0, view);
                for (let slot = 0; slot < 7; slot++) {
                    const texture = Nri_GetDonutSceneMaterialTexture(scene, m, slot);
                    Nri_UpdateDescriptor(set, 1, slot, texture >= 0 ? this.textures.views[texture] : blackView);
                }
            }

            // The shading set: the light constants, no shadow map (the fallback), no light probes.
            const shadingSet = Nri_AllocateDescriptorSet(descriptorPool, forwardLayout, 2, 0);
            const lightView = this.constantView(0, this.staticStride);
            this.shadingSet = shadingSet;
            if (!shadingSet || !lightView) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            Nri_UpdateDescriptor(shadingSet, 0, 0, lightView);
            Nri_UpdateDescriptor(shadingSet, 1, 0, noShadowView);
            Nri_UpdateDescriptor(shadingSet, 1, 1, blackCubeArrayView);
            Nri_UpdateDescriptor(shadingSet, 1, 2, blackCubeArrayView);
            Nri_UpdateDescriptor(shadingSet, 1, 3, blackView);
            Nri_UpdateDescriptor(shadingSet, 2, 0, anisotropicWrap);
            Nri_UpdateDescriptor(shadingSet, 2, 1, shadowSampler);
            Nri_UpdateDescriptor(shadingSet, 2, 2, linearWrap);
            Nri_UpdateDescriptor(shadingSet, 2, 3, linearClamp);

            const depthView = this.depthView;
            const stencilView = this.stencilView;
            const hdrView = this.hdrView;
            const motionVectorsView = this.motionVectorsView;
            const feedbackInputView = this.feedbackInputView;
            const resolvedStorage = this.resolvedStorage;
            const resolvedView = this.resolvedView;
            const feedbackOutputStorage = this.feedbackOutputStorage;
            const shadingRateStorage = this.shadingRateStorage;
            if (!depthView || !stencilView || !hdrView || !motionVectorsView || !feedbackInputView || !resolvedStorage) {
                console.log("Cannot create the views");
                return false;
            }
            if (!resolvedView || !feedbackOutputStorage || !shadingRateStorage) {
                console.log("Cannot create the views");
                return false;
            }

            // The shading rate surface's set: the surface, the motion vectors, the HDR color.
            const shadingRateSet = Nri_AllocateDescriptorSet(descriptorPool, shadingRateLayout, 0, 0);
            this.shadingRateSet = shadingRateSet;
            const blitSet = this.blit.createSet(descriptorPool, resolvedView);
            this.blitSet = blitSet;
            if (!shadingRateSet || !blitSet) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            Nri_UpdateDescriptor(shadingRateSet, 0, 0, shadingRateStorage);
            Nri_UpdateDescriptor(shadingRateSet, 1, 0, motionVectorsView);
            Nri_UpdateDescriptor(shadingRateSet, 1, 1, hdrView);

            // A queued frame's: the view, the motion vectors', the resolve's.
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const viewSet = Nri_AllocateDescriptorSet(descriptorPool, forwardLayout, 1, 0);
                const motionVectorsSet = Nri_AllocateDescriptorSet(descriptorPool, motionVectorsLayout, 0, 0);
                const resolveSet = Nri_AllocateDescriptorSet(descriptorPool, resolveLayout, 0, 0);
                const viewView = this.constantView(this.frameOffset(i), align(this.viewSize));
                const motionVectorsConstants = this.constantView(this.motionVectorsOffset(i), align(this.taaSize));
                const resolveConstants = this.constantView(this.resolveOffset(i), align(this.taaSize));
                if (!viewSet || !motionVectorsSet || !resolveSet || !viewView || !motionVectorsConstants || !resolveConstants) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                Nri_UpdateDescriptor(viewSet, 0, 0, viewView);
                Nri_UpdateDescriptor(motionVectorsSet, 0, 0, motionVectorsConstants);
                Nri_UpdateDescriptor(motionVectorsSet, 1, 0, depthView);
                Nri_UpdateDescriptor(motionVectorsSet, 1, 1, stencilView);
                Nri_UpdateDescriptor(resolveSet, 0, 0, resolveConstants);
                Nri_UpdateDescriptor(resolveSet, 1, 0, bilinearBorder);
                Nri_UpdateDescriptor(resolveSet, 2, 0, hdrView);
                Nri_UpdateDescriptor(resolveSet, 2, 1, motionVectorsView);
                Nri_UpdateDescriptor(resolveSet, 2, 2, feedbackInputView);
                Nri_UpdateDescriptor(resolveSet, 2, 3, hdrView);
                Nri_UpdateDescriptor(resolveSet, 3, 0, resolvedStorage);
                Nri_UpdateDescriptor(resolveSet, 3, 1, feedbackOutputStorage);
                this.queuedFrames.push(new QueuedFrame(this.frames.commandBuffer(i), viewSet,
                    motionVectorsSet, resolveSet));
            }

            if (!this.textures.createBlits(descriptorPool)) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            return true;
        }

        // Where a queued frame's constants are: the view, the motion vectors' and the resolve's TAA
        // constants.
        frameOffset(queuedFrameIndex: int) {
            return this.staticStride + queuedFrameIndex * this.frameStride;
        }

        motionVectorsOffset(queuedFrameIndex: int) {
            return this.frameOffset(queuedFrameIndex) + align(this.viewSize);
        }

        resolveOffset(queuedFrameIndex: int) {
            return this.motionVectorsOffset(queuedFrameIndex) + align(this.taaSize);
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The camera (Donut's FirstPersonCamera, unless in test mode, where nothing moves it), the
        // queued frame's view and TAA constants: the motion vectors' from the previous frame's view
        // (the Donut example's viewPrevious) to this one, the resolve's (the feedback valid after the
        // first frame).
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
            if (this.previousViewsValid) {
                Nri_FillDonutTaaMotionVectorConstants(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), Ref(this.prevViewMatrix[0]),
                    Ref(this.prevProjMatrix[0]), this.width, this.height, MOTION_VECTOR_STENCIL_MASK, Ref(this.taaConstants[0]));
                Nri_WriteBuffer(constantBuffer, this.motionVectorsOffset(queuedFrameIndex), Ref(this.taaConstants[0]), this.taaSize);
            }
            Nri_FillDonutTaaResolveConstants(this.width, this.height, this.previousViewsValid ? 1 : 0, Ref(this.taaConstants[0]));
            Nri_WriteBuffer(constantBuffer, this.resolveOffset(queuedFrameIndex), Ref(this.taaConstants[0]), this.taaSize);
        }

        // The first frame: the fallback shadow map cleared (D3D12 wants depth textures initialized
        // before shaders read them), the HDR color and the motion vectors cleared to 0 (as Donut's
        // zeroed textures, which the shading rate shader reads before anything draws them).
        clearTargets(commandBuffer: NriCommandBufferHandle) {
            const noShadowTexture = this.noShadowTexture;
            const noShadowAttachment = this.noShadowAttachment;
            // (Nested: tslang can't && its @cpp handles, TSLANG_ISSUES #23.)
            if (!this.noShadowCleared) {
                if (noShadowTexture) {
                    if (noShadowAttachment) {
                        Nri_CmdTextureBarrier(commandBuffer, noShadowTexture, NriTextureState.ShaderResource, NriTextureState.DepthAttachment);
                        Nri_CmdBeginRenderingDepthOnly(commandBuffer, noShadowAttachment);
                        Nri_CmdClearDepth(commandBuffer, 0.0);
                        Nri_CmdEndRendering(commandBuffer);
                        Nri_CmdTextureBarrier(commandBuffer, noShadowTexture, NriTextureState.DepthAttachment, NriTextureState.ShaderResource);
                        this.noShadowCleared = true;
                    }
                }
            }
            const hdrColor = this.hdrColor;
            const hdrAttachment = this.hdrAttachment;
            const motionVectors = this.motionVectors;
            const motionVectorsAttachment = this.motionVectorsAttachment;
            if (this.targetsCleared || !hdrColor || !hdrAttachment || !motionVectors || !motionVectorsAttachment) {
                return;
            }
            Nri_CmdTextureBarrier(commandBuffer, hdrColor, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            Nri_CmdBeginRendering(commandBuffer, hdrAttachment);
            Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
            Nri_CmdEndRendering(commandBuffer);
            Nri_CmdTextureBarrier(commandBuffer, hdrColor, NriTextureState.ColorAttachment, NriTextureState.AllShaderResource);
            Nri_CmdTextureBarrier(commandBuffer, motionVectors, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            Nri_CmdBeginRendering(commandBuffer, motionVectorsAttachment);
            Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
            Nri_CmdEndRendering(commandBuffer);
            Nri_CmdTextureBarrier(commandBuffer, motionVectors, NriTextureState.ColorAttachment, NriTextureState.AllShaderResource);
            this.targetsCleared = true;
        }

        // TemporalAntiAliasingPass::RenderMotionVectors (after the first frame): from the previous
        // frame's depth, the camera's movement between the two views, over the whole frame.
        recordMotionVectors(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const motionVectors = this.motionVectors;
            const motionVectorsAttachment = this.motionVectorsAttachment;
            const layout = this.motionVectorsLayout;
            const pipeline = this.motionVectorsPipeline;
            if (!this.previousViewsValid || !motionVectors || !motionVectorsAttachment || !layout || !pipeline) {
                return;
            }
            Nri_CmdTextureBarrier(commandBuffer, motionVectors, NriTextureState.AllShaderResource, NriTextureState.ColorAttachment);
            Nri_CmdBeginRendering(commandBuffer, motionVectorsAttachment);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, layout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, queuedFrame.motionVectorsSet);
            Nri_CmdDraw(commandBuffer, 4, 1, 0, 0);
            Nri_CmdEndRendering(commandBuffer);
            Nri_CmdTextureBarrier(commandBuffer, motionVectors, NriTextureState.ColorAttachment, NriTextureState.AllShaderResource);
        }

        // The shading rate surface from the motion vectors and the previous frame's HDR color: a
        // thread a tile.
        recordShadingRateSurface(commandBuffer: NriCommandBufferHandle) {
            const surface = this.shadingRateSurface;
            const layout = this.shadingRateLayout;
            const pipeline = this.shadingRatePipeline;
            const set = this.shadingRateSet;
            if (!surface || !layout || !pipeline || !set) {
                return;
            }
            Nri_CmdTextureBarrier(commandBuffer, surface, NriTextureState.ShadingRateAttachment, NriTextureState.Storage);
            Nri_CmdSetComputePipelineLayout(commandBuffer, layout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetComputeDescriptorSet(commandBuffer, 0, set);
            Nri_CmdDispatch(commandBuffer, this.surfaceWidth, this.surfaceHeight, 1);
            Nri_CmdTextureBarrier(commandBuffer, surface, NriTextureState.Storage, NriTextureState.ShadingRateAttachment);
        }

        // Donut_ClearTemporalTargets (depth 0, stencil 0, HDR color 0), then the forward pass's draws
        // with the shading rate surface: the draws' 1x1 rate, the surface's overriding it (-raw: every
        // combiner at MAX, as the Donut example's D3D12 path; the same rates).
        recordScene(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const hdrColor = this.hdrColor;
            const hdrAttachment = this.hdrAttachment;
            const depth = this.depth;
            const depthAttachment = this.depthAttachment;
            const shadingRateAttachment = this.shadingRateAttachment;
            const forwardLayout = this.forwardLayout;
            const shadingSet = this.shadingSet;
            const indexBuffer = this.indexBuffer;
            const instanceBufferView = this.instanceBufferView;
            const vertexBufferView = this.vertexBufferView;
            if (!hdrColor || !hdrAttachment || !depth || !depthAttachment || !shadingRateAttachment || !forwardLayout || !shadingSet) {
                return;
            }
            if (!indexBuffer || !instanceBufferView || !vertexBufferView) {
                return;
            }
            Nri_CmdTextureBarrier(commandBuffer, hdrColor, NriTextureState.AllShaderResource, NriTextureState.ColorAttachment);
            Nri_CmdTextureBarrier(commandBuffer, depth, NriTextureState.ShaderResource, NriTextureState.DepthAttachment);
            Nri_CmdBeginRenderingWithShadingRate(commandBuffer, hdrAttachment, null, depthAttachment, shadingRateAttachment);
            Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
            Nri_CmdClearDepthStencil(commandBuffer, 0.0, 0);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            if (this.rawD3D12) {
                Nri_CmdSetShadingRate(commandBuffer, NriShadingRate.Rate1x1, NriShadingRateCombiner.Max, NriShadingRateCombiner.Max);
            } else {
                Nri_CmdSetShadingRate(commandBuffer, NriShadingRate.Rate1x1, NriShadingRateCombiner.Keep, NriShadingRateCombiner.Replace);
            }
            Nri_CmdSetPipelineLayout(commandBuffer, forwardLayout);
            Nri_CmdSetDescriptorSet(commandBuffer, 1, queuedFrame.viewSet);
            Nri_CmdSetDescriptorSet(commandBuffer, 2, shadingSet);
            Nri_CmdSetRootDescriptor(commandBuffer, 0, instanceBufferView, 0);
            Nri_CmdSetRootDescriptor(commandBuffer, 1, vertexBufferView, 0);
            Nri_CmdSetIndexBuffer(commandBuffer, indexBuffer, 0, NriIndexType.UInt32);
            let pipeline = -1;
            let material = -1;
            for (const item of this.drawItems) {
                const itemPipeline = (item.doubleSided ? 1 : 0) + (this.mirrored ? 2 : 0);
                if (itemPipeline != pipeline) {
                    Nri_CmdSetPipeline(commandBuffer, this.forwardPipelines[itemPipeline]);
                    pipeline = itemPipeline;
                }
                if (item.material != material) {
                    Nri_CmdSetDescriptorSet(commandBuffer, 0, this.materialSets[item.material]);
                    material = item.material;
                }
                Nri_CmdSetRootConstants(commandBuffer, 0, Ref(item.forwardPush[0]), FORWARD_PUSH_WORDS * 4);
                Nri_CmdDrawIndexed(commandBuffer, item.indexCount, 1, item.firstIndex, 0, 0);
            }
            Nri_CmdEndRendering(commandBuffer);
            Nri_CmdTextureBarrier(commandBuffer, depth, NriTextureState.DepthAttachment, NriTextureState.ShaderResource);
            Nri_CmdTextureBarrier(commandBuffer, hdrColor, NriTextureState.ColorAttachment, NriTextureState.AllShaderResource);
        }

        // TemporalAntiAliasingPass::TemporalResolve (runs at full rate): the HDR color into the
        // resolved color.
        recordResolve(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const resolvedColor = this.resolvedColor;
            const layout = this.resolveLayout;
            const pipeline = this.resolvePipeline;
            if (!resolvedColor || !layout || !pipeline) {
                return;
            }
            if (!this.resolvedInStorage) {
                Nri_CmdTextureBarrier(commandBuffer, resolvedColor, NriTextureState.ShaderResource, NriTextureState.Storage);
            }
            Nri_CmdSetComputePipelineLayout(commandBuffer, layout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetComputeDescriptorSet(commandBuffer, 0, queuedFrame.resolveSet);
            Nri_CmdDispatch(commandBuffer, Math.floor((this.width + TAA_GROUP_SIZE - 1) / TAA_GROUP_SIZE),
                Math.floor((this.height + TAA_GROUP_SIZE - 1) / TAA_GROUP_SIZE), 1);
            Nri_CmdTextureBarrier(commandBuffer, resolvedColor, NriTextureState.Storage, NriTextureState.ShaderResource);
            this.resolvedInStorage = false;
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (Nri_UseResizableWindow): the swap chain, the temporal targets
        // and the shading rate surface made again at its size, once the GPU is done with the old ones;
        // the sets pointed at them; the first frame's clears done again, the resolved color back in
        // NriTextureState.Storage, and the previous view forgotten (its projection had the old aspect
        // ratio). The projection, viewports and dispatches read the size every frame.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            Nri_DeviceWaitIdle(device);
            this.destroySizeTargets();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            if (!this.createSizeTargets(device)) {
                return;
            }
            this.updateSizeDescriptors();
            this.targetsCleared = false;
            this.resolvedInStorage = true;
            this.previousViewsValid = false;
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.writeConstants(queuedFrameIndex);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                this.recordAndSubmit(frameIndex, queuedFrame, index);
            }

            // The Donut example's viewPrevious.copyPlanarView(view).
            for (let i = 0; i < 16; i++) {
                this.prevViewMatrix[i] = this.viewMatrix[i];
                this.prevProjMatrix[i] = this.projMatrix[i];
            }
            this.previousViewsValid = true;

            // Signaled after the present, as NRISamples do
            this.frames.signal(frameIndex);
        }

        // Records the frame into the queued frame's command buffer, submits it and presents.
        recordAndSubmit(frameIndex: int, queuedFrame: QueuedFrame, index: int) {
            const descriptorPool = this.descriptorPool;
            const blitSet = this.blitSet;
            if (!descriptorPool || !blitSet) {
                return;
            }
            const commandBuffer = queuedFrame.commandBuffer;
            Nri_BeginCommandBuffer(commandBuffer);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            // The first frame: the mip chains, the cleared targets.
            this.textures.recordBlits(commandBuffer);
            this.clearTargets(commandBuffer);

            this.recordMotionVectors(commandBuffer, queuedFrame);
            this.recordShadingRateSurface(commandBuffer);
            this.recordScene(commandBuffer, queuedFrame);
            this.recordResolve(commandBuffer, queuedFrame);

            Nri_CmdTextureBarrier(commandBuffer, this.swapChain.texture(index), NriTextureState.Undefined, NriTextureState.ColorAttachment);
            Nri_CmdBeginRendering(commandBuffer, this.swapChain.colorAttachment(index));
            this.blit.record(commandBuffer, blitSet, this.width, this.height);
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
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                this.textures.destroy();
                this.blit.destroy();
                this.destroySizeTargets();
                const descriptors = [this.vertexBufferView, this.instanceBufferView, this.blackView, this.blackCubeArrayView,
                    this.noShadowView, this.noShadowAttachment, this.anisotropicWrap, this.linearWrap, this.linearClamp, this.shadowSampler,
                    this.bilinearBorder];
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
                const noShadowTexture = this.noShadowTexture;
                if (noShadowTexture) {
                    Nri_DestroyTexture(noShadowTexture);
                }
                for (const texture of this.solidTextures) {
                    Nri_DestroyTexture(texture);
                }
                const buffers = [this.vertexBuffer, this.instanceBuffer, this.indexBuffer, this.materialBuffer, this.constantBuffer,
                    this.readbackBuffer];
                for (const buffer of buffers) {
                    if (buffer) {
                        Nri_DestroyBuffer(buffer);
                    }
                }
                for (const pipeline of this.forwardPipelines) {
                    Nri_DestroyPipeline(pipeline);
                }
                const pipelines = [this.motionVectorsPipeline, this.shadingRatePipeline, this.resolvePipeline];
                for (const pipeline of pipelines) {
                    if (pipeline) {
                        Nri_DestroyPipeline(pipeline);
                    }
                }
                const layouts = [this.forwardLayout, this.motionVectorsLayout, this.shadingRateLayout, this.resolveLayout];
                for (const layout of layouts) {
                    if (layout) {
                        Nri_DestroyPipelineLayout(layout);
                    }
                }
                this.frames.destroy();
                this.swapChain.destroy();
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
        const variableShading = new VariableShading(sample);
        // --scene <path>: relative to the executable's directory. -raw: the Donut example's D3D12
        // path (on D3D12; ignored otherwise).
        Nri_AddExampleOptionWithValues(sample, "--scene", 1);
        Nri_AddExampleOption(sample, "-raw");
        Nri_UseResizableWindow(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "--scene" && i + 1 < argc) {
                variableShading.scenePath = Nri_GetArg(argc, argv, i + 1);
            } else if (arg == "-raw") {
                variableShading.rawD3D12 = true;
            }
        }
        return variableShading.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return VariableShadingNri.main(argc, argv);
}

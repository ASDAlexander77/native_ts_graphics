/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { perspProjD3DStyleReverse } from "../../core/matrix";
import { DonutFirstPersonCamera } from "../../core/donut_first_person_camera";
import { DonutSceneTextures } from "../../core/nri_donut_textures";
import { DonutBlit } from "../../core/nri_donut_blit";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriDonutScene, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

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
        constructor(public commandBuffer: NriCommandBuffer,
            public viewSet: NriDescriptorSet, public motionVectorsSet: NriDescriptorSet,
            public resolveSet: NriDescriptorSet) {
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
        private device: NriDevice | null = null;
        private queue: NriQueue;
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
        private scene: NriDonutScene | null = null;
        private vertexBuffer: NriBuffer | null = null;
        private vertexBufferView: NriDescriptor | null = null;
        private instanceBuffer: NriBuffer | null = null;
        private instanceBufferView: NriDescriptor | null = null;
        private indexBuffer: NriBuffer | null = null;
        private materialBuffer: NriBuffer | null = null;
        private materialViews: NriDescriptor[] = [];
        private materialSets: NriDescriptorSet[] = [];
        private textures: DonutSceneTextures = new DonutSceneTextures();
        private drawItems: DrawItem[] = [];

        // Donut_CreateTemporalTargets' targets: D24S8 depth (cleared to 0 and stencil 0 every frame),
        // RGBA16F HDR color, RG16F motion vectors, the TAA's RGBA16F resolved color and feedback (the
        // one read, RGBA16_SNORM, never written: zeros, as D3D12's fresh textures; the one written,
        // never read, RGBA16F here: taa_cs declares it rgba16f, which NRIFramework's Vulkan validation
        // holds the view to). The shading rate surface (R8_UINT, a texel per tile).
        private depth: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private depthView: NriDescriptor | null = null;
        private stencilView: NriDescriptor | null = null;
        private hdrColor: NriTexture | null = null;
        private hdrAttachment: NriDescriptor | null = null;
        private hdrView: NriDescriptor | null = null;
        private motionVectors: NriTexture | null = null;
        private motionVectorsAttachment: NriDescriptor | null = null;
        private motionVectorsView: NriDescriptor | null = null;
        private resolvedColor: NriTexture | null = null;
        private resolvedStorage: NriDescriptor | null = null;
        private resolvedView: NriDescriptor | null = null;
        private feedbackInput: NriTexture | null = null;
        private feedbackInputView: NriDescriptor | null = null;
        private feedbackOutput: NriTexture | null = null;
        private feedbackOutputStorage: NriDescriptor | null = null;
        private shadingRateSurface: NriTexture | null = null;
        private shadingRateAttachment: NriDescriptor | null = null;
        private shadingRateStorage: NriDescriptor | null = null;
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
        private solidTextures: NriTexture[] = [];
        private blackView: NriDescriptor | null = null;
        private blackCubeArrayView: NriDescriptor | null = null;
        private noShadowTexture: NriTexture | null = null;
        private noShadowView: NriDescriptor | null = null;
        private noShadowAttachment: NriDescriptor | null = null;
        private noShadowCleared: boolean = false;

        // The passes' layouts and pipelines: the forward pass's (by cull mode and front face), the
        // motion vectors', the shading rate surface's, the resolve's; the blit.
        private forwardLayout: NriPipelineLayout | null = null;
        private forwardPipelines: NriPipeline[] = [];
        private motionVectorsLayout: NriPipelineLayout | null = null;
        private motionVectorsPipeline: NriPipeline | null = null;
        private shadingRateLayout: NriPipelineLayout | null = null;
        private shadingRatePipeline: NriPipeline | null = null;
        private resolveLayout: NriPipelineLayout | null = null;
        private resolvePipeline: NriPipeline | null = null;
        private blit: DonutBlit = new DonutBlit();

        // CommonRenderPasses' samplers (anisotropic wrap, linear wrap, linear clamp), the forward
        // pass's shadow sampler (border, white), the TAA's bilinear sampler (border, black).
        private anisotropicWrap: NriDescriptor | null = null;
        private linearWrap: NriDescriptor | null = null;
        private linearClamp: NriDescriptor | null = null;
        private shadowSampler: NriDescriptor | null = null;
        private bilinearBorder: NriDescriptor | null = null;

        // The constant buffer: the static constants (the forward light constants), then a queued
        // frame's (the view, the motion vectors' and the resolve's TAA constants).
        private constantBuffer: NriBuffer | null = null;
        private constantViews: NriDescriptor[] = [];
        private descriptorPool: NriDescriptorPool | null = null;
        private shadingSet: NriDescriptorSet | null = null;
        private shadingRateSet: NriDescriptorSet | null = null;
        private blitSet: NriDescriptorSet | null = null;
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
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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
            if (this.d3d11) {
                console.log("The Variable Rate Shading example does not support D3D11.");
                result = 1;
            } else if (this.unsupportedReason != "") {
                const test = this.sample.isTest() != 0;
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
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);
            // -raw is the Donut example's D3D12 path only.
            this.rawD3D12 = this.rawD3D12 && graphicsAPI == NriGraphicsAPI.D3D12;

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // Swap chain: blitted into through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.viewFormat;

            if (device.isFeatureSupported(NriFeature.VariableRateShading) == 0) {
                this.unsupportedReason = "The device does not support Variable Rate Shading";
                return 0;
            }
            // The VRS tile size (it can vary depending on hardware): the surface is about 1 / tileSize
            // of the frame in both dimensions (rounded up; createSizeTargets).
            this.vrsTileSize = device.getShadingRateTileSize();
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
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The scene, as Donut's engine loads it, its textures, the materials' constants; the draws
        // InstancedOpaqueDrawStrategy makes of it (opaque and alpha-tested materials), by material.
        loadScene(device: NriDevice, folder: string) {
            const scene = NriDonutScene.load(this.scenePath);
            this.scene = scene;
            if (!scene) {
                console.log(`Cannot load the scene ${this.scenePath}`);
                return false;
            }
            const vertexBuffer = device.createDonutSceneBuffer(this.queue, scene, 0);
            const instanceBuffer = device.createDonutSceneBuffer(this.queue, scene, 2);
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
                        this.drawItems.push(new DrawItem(drawnMaterial, doubleSided,
                            scene.getGeometryIndexCount(instance, geometry),
                            scene.getGeometryFirstIndex(instance, geometry), forwardPush));
                    }
                }
            }
            return this.textures.load(device, this.queue, scene, folder);
        }

        // The temporal targets, the shading rate surface, the fallbacks.
        createTargets(device: NriDevice) {
            if (!this.createSizeTargets(device)) {
                return false;
            }

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

        // The window-sized targets: the temporal targets and the shading rate surface (a texel per
        // VRS tile), in the states the frames expect first (targetsCleared, resolvedInStorage).
        createSizeTargets(device: NriDevice) {
            this.surfaceWidth = Math.floor((this.width + this.vrsTileSize - 1) / this.vrsTileSize);
            this.surfaceHeight = Math.floor((this.height + this.vrsTileSize - 1) / this.vrsTileSize);
            const width = this.width;
            const height = this.height;
            const depth = device.createSampledDepthTexture(this.queue, width, height, NriFormat.D24_UNORM_S8_UINT);
            this.depth = depth;
            const hdrColor = device.createRenderTargetTexture(this.queue, width, height, NriFormat.RGBA16_SFLOAT);
            this.hdrColor = hdrColor;
            const motionVectors = device.createRenderTargetTexture(this.queue, width, height, NriFormat.RG16_SFLOAT);
            this.motionVectors = motionVectors;
            const resolvedColor = device.createStorageTexture(this.queue, width, height, NriFormat.RGBA16_SFLOAT);
            this.resolvedColor = resolvedColor;
            const feedbackOutput = device.createStorageTexture(this.queue, width, height, NriFormat.RGBA16_SFLOAT);
            this.feedbackOutput = feedbackOutput;
            // The feedback taa_cs reads: zeros (8 bytes a texel), left in NriTextureState.ShaderResource.
            const feedbackInput = device.createCommittedTexture(width, height, NriFormat.RGBA16_SNORM);
            this.feedbackInput = feedbackInput;
            let feedbackUploaded = false;
            if (feedbackInput) {
                const feedbackZeros: int[] = [];
                for (let i = 0; i < width * height * 2; i++) {
                    feedbackZeros.push(0);
                }
                feedbackUploaded = this.queue.uploadTexture(feedbackInput, Ref(feedbackZeros[0]), width * 8) != 0;
            }
            // The shading rate surface, written by the compute shader before every forward pass (its
            // first contents never read).
            const surfaceZeros: int[] = [];
            const surfaceRowPitch = Math.floor((this.surfaceWidth + 3) / 4) * 4;
            for (let i = 0; i < Math.floor(surfaceRowPitch / 4) * this.surfaceHeight; i++) {
                surfaceZeros.push(0);
            }
            const shadingRateSurface = device.createShadingRateTexture(this.queue, this.surfaceWidth, this.surfaceHeight,
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
            this.depthAttachment = depth.createDepthAttachmentView(NriFormat.D24_UNORM_S8_UINT);
            this.depthView = depth.createView(NriFormat.R24_UNORM_X8);
            this.stencilView = depth.createView(NriFormat.X24_G8_UINT);
            this.hdrAttachment = hdrColor.createColorAttachmentView(NriFormat.RGBA16_SFLOAT);
            this.hdrView = hdrColor.createView(NriFormat.RGBA16_SFLOAT);
            this.motionVectorsAttachment = motionVectors.createColorAttachmentView(NriFormat.RG16_SFLOAT);
            this.motionVectorsView = motionVectors.createView(NriFormat.RG16_SFLOAT);
            this.resolvedStorage = resolvedColor.createStorageView(NriFormat.RGBA16_SFLOAT);
            this.resolvedView = resolvedColor.createView(NriFormat.RGBA16_SFLOAT);
            this.feedbackInputView = feedbackInput.createView(NriFormat.RGBA16_SNORM);
            this.feedbackOutputStorage = feedbackOutput.createStorageView(NriFormat.RGBA16_SFLOAT);
            this.shadingRateAttachment = shadingRateSurface.createShadingRateAttachmentView();
            this.shadingRateStorage = shadingRateSurface.createStorageView(NriFormat.R8_UINT);
            return true;
        }

        destroySizeTargets() {
            const descriptors = [this.depthAttachment, this.depthView, this.stencilView, this.hdrAttachment, this.hdrView,
                this.motionVectorsAttachment, this.motionVectorsView, this.resolvedStorage, this.resolvedView,
                this.feedbackInputView, this.feedbackOutputStorage, this.shadingRateAttachment, this.shadingRateStorage];
            for (const descriptor of descriptors) {
                if (descriptor) {
                    descriptor.destroy();
                }
            }
            const textures = [this.depth, this.hdrColor, this.motionVectors, this.resolvedColor, this.feedbackInput,
                this.feedbackOutput, this.shadingRateSurface];
            for (const texture of textures) {
                if (texture) {
                    texture.destroy();
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
                shadingRateSet.updateDescriptor(0, 0, shadingRateStorage);
                shadingRateSet.updateDescriptor(1, 0, motionVectorsView);
                shadingRateSet.updateDescriptor(1, 1, hdrView);
            }
            const blitSet = this.blitSet;
            if (blitSet) {
                blitSet.updateDescriptor(0, 0, resolvedView);
            }
            for (const queuedFrame of this.queuedFrames) {
                queuedFrame.motionVectorsSet.updateDescriptor(1, 0, depthView);
                queuedFrame.motionVectorsSet.updateDescriptor(1, 1, stencilView);
                queuedFrame.resolveSet.updateDescriptor(2, 0, hdrView);
                queuedFrame.resolveSet.updateDescriptor(2, 1, motionVectorsView);
                queuedFrame.resolveSet.updateDescriptor(2, 2, feedbackInputView);
                queuedFrame.resolveSet.updateDescriptor(2, 3, hdrView);
                queuedFrame.resolveSet.updateDescriptor(3, 0, resolvedStorage);
                queuedFrame.resolveSet.updateDescriptor(3, 1, feedbackOutputStorage);
            }
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

            // The motion vectors (motion_vectors_ps with USE_STENCIL): b0 the TAA constants, t0 the
            // depth, t1 the stencil.
            const motionVectorsDesc = NriPipelineLayoutDesc.create();
            motionVectorsDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            motionVectorsDesc.addRange(0, 0, 2, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            this.motionVectorsLayout = device.createPipelineLayoutFromDesc(motionVectorsDesc);
            motionVectorsDesc.destroy();

            // The shading rate surface (variable_shading.hlsl's main_cs): u0 the surface, t0 the motion
            // vectors, t1 the previous frame's HDR color.
            const shadingRateDesc = NriPipelineLayoutDesc.create();
            shadingRateDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
            shadingRateDesc.addRange(0, 0, 2, NriDescriptorType.Texture, NriStage.Compute, NriRangeFlags.None);
            this.shadingRateLayout = device.createPipelineLayoutFromDesc(shadingRateDesc);
            shadingRateDesc.destroy();

            // The resolve (taa_cs): b0, s0, t0 the HDR color, t1 the motion vectors, t2 the feedback
            // read, t3 the history clamp relax mask (none: the HDR color, as Donut binds it), u0 the
            // resolved color, u1 the feedback written.
            const resolveDesc = NriPipelineLayoutDesc.create();
            resolveDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Compute, NriRangeFlags.None);
            resolveDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Compute, NriRangeFlags.None);
            resolveDesc.addRange(0, 0, 4, NriDescriptorType.Texture, NriStage.Compute, NriRangeFlags.None);
            resolveDesc.addRange(0, 0, 2, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
            this.resolveLayout = device.createPipelineLayoutFromDesc(resolveDesc);
            resolveDesc.destroy();

            if (!this.forwardLayout || !this.motionVectorsLayout || !this.shadingRateLayout || !this.resolveLayout) {
                console.log("Cannot create the pipeline layouts");
                return false;
            }
            return true;
        }

        createPipelines(device: NriDevice, folder: string) {
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
                desc.setShadingRate(1);
                const pipeline = loaded ? device.createPipelineFromDesc(forwardLayout, desc) : null;
                desc.destroy();
                if (!pipeline) {
                    console.log("Cannot load the forward shading shaders");
                    return false;
                }
                this.forwardPipelines.push(pipeline);
            }

            // The motion vectors: CommonRenderPasses' fullscreen_vs (its quad at depth 0), a triangle
            // strip, not culled, no depth test, into the RG16F motion vectors.
            const motionVectorsDesc = NriPipelineDesc.create();
            let loaded = motionVectorsDesc.addShaderPermutation(NriShaderStage.Vertex, `${framework}/fullscreen_vs.bin`, "main",
                "QUAD_Z=0") != 0;
            if (loaded) {
                loaded = motionVectorsDesc.addShaderPermutation(NriShaderStage.Pixel, `${framework}/passes/motion_vectors_ps.bin`,
                    "main", "USE_STENCIL=1") != 0;
            }
            motionVectorsDesc.setTopology(NriTopology.TriangleStrip);
            motionVectorsDesc.setColor(NriFormat.RG16_SFLOAT, NriColorWrite.RGBA);
            this.motionVectorsPipeline = loaded ? device.createPipelineFromDesc(motionVectorsLayout, motionVectorsDesc) : null;
            motionVectorsDesc.destroy();

            this.shadingRatePipeline = device.createComputePipeline(shadingRateLayout,
                `shaders/variable_shading/${folder}/variable_shading_main_cs.bin`, "main_cs");
            // TAA's resolve: one sample, the Catmull-Rom filter (Donut_CreateTemporalAntiAliasingPass's).
            this.resolvePipeline = device.createComputePipelinePermutation(resolveLayout, `${framework}/passes/taa_cs.bin`, "main",
                "SAMPLE_COUNT=1 USE_CATMULL_ROM_FILTER=1");

            if (!this.motionVectorsPipeline || !this.shadingRatePipeline || !this.resolvePipeline) {
                console.log("Cannot load the TAA and shading rate shaders");
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

        // The samplers; the constant buffer: the static constants (the forward light constants), then a
        // queued frame's; the sets.
        createDescriptorSets(device: NriDevice, queuedFrameNum: int) {
            const scene = this.scene;
            const materialBuffer = this.materialBuffer;
            const forwardLayout = this.forwardLayout;
            const motionVectorsLayout = this.motionVectorsLayout;
            const shadingRateLayout = this.shadingRateLayout;
            const resolveLayout = this.resolveLayout;
            if (!scene || !materialBuffer || !forwardLayout || !motionVectorsLayout || !shadingRateLayout || !resolveLayout) {
                return false;
            }
            this.anisotropicWrap = device.createSampler(NriFilter.Linear, NriAddressMode.Repeat, 16);
            this.linearWrap = device.createSampler(NriFilter.Linear, NriAddressMode.Repeat, 1);
            this.linearClamp = device.createSampler(NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            this.shadowSampler = device.createBorderSampler(NriFilter.Linear, 1);
            this.bilinearBorder = device.createBorderSampler(NriFilter.Linear, 0);

            // The static constants: the forward light constants (the sun, no shadow map; its shadow
            // constants unused).
            const lightConstantsSize = Nri.getDonutConstantsSize(4);
            const lightConstants = zeros(lightConstantsSize / 4);
            const noShadowConstants = zeros(Nri.getDonutConstantsSize(5) / 4);
            Nri.fillDonutForwardSunLightConstants(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2], SUN_ANGULAR_SIZE, SUN_IRRADIANCE,
                Ref(noShadowConstants[0]), 0, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR, AMBIENT_COLOR,
                Ref(lightConstants[0]));
            this.staticStride = align(lightConstantsSize);
            this.viewSize = Nri.getDonutConstantsSize(0);
            this.taaSize = Nri.getDonutConstantsSize(9);
            this.viewConstants = zeros(this.viewSize / 4);
            this.taaConstants = zeros(this.taaSize / 4);
            this.frameStride = align(this.viewSize) + 2 * align(this.taaSize);
            const constantBuffer = device.createHostBuffer(this.staticStride + queuedFrameNum * this.frameStride,
                NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;

            const materialCount = scene.getMaterialCount();
            const blitCount = this.textures.blitSetCount();
            const setNum = materialCount + 1 + 1 + 1 + 3 * queuedFrameNum + blitCount;
            const descriptorPool = device.createDescriptorPool(setNum,
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
            constantBuffer.write(0, Ref(lightConstants[0]), lightConstantsSize);

            // A material's set: its constants, its textures (black for the slots it doesn't use).
            for (let m = 0; m < materialCount; m++) {
                const set = descriptorPool.allocateDescriptorSet(forwardLayout, 0, 0);
                const view = materialBuffer.createConstantView(m * CONSTANTS_ALIGNMENT, CONSTANTS_ALIGNMENT);
                if (!set || !view) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                this.materialSets.push(set);
                this.materialViews.push(view);
                set.updateDescriptor(0, 0, view);
                for (let slot = 0; slot < 7; slot++) {
                    const texture = scene.getMaterialTexture(m, slot);
                    set.updateDescriptor(1, slot, texture >= 0 ? this.textures.views[texture] : blackView);
                }
            }

            // The shading set: the light constants, no shadow map (the fallback), no light probes.
            const shadingSet = descriptorPool.allocateDescriptorSet(forwardLayout, 2, 0);
            const lightView = this.constantView(0, this.staticStride);
            this.shadingSet = shadingSet;
            if (!shadingSet || !lightView) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            shadingSet.updateDescriptor(0, 0, lightView);
            shadingSet.updateDescriptor(1, 0, noShadowView);
            shadingSet.updateDescriptor(1, 1, blackCubeArrayView);
            shadingSet.updateDescriptor(1, 2, blackCubeArrayView);
            shadingSet.updateDescriptor(1, 3, blackView);
            shadingSet.updateDescriptor(2, 0, anisotropicWrap);
            shadingSet.updateDescriptor(2, 1, shadowSampler);
            shadingSet.updateDescriptor(2, 2, linearWrap);
            shadingSet.updateDescriptor(2, 3, linearClamp);

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
            const shadingRateSet = descriptorPool.allocateDescriptorSet(shadingRateLayout, 0, 0);
            this.shadingRateSet = shadingRateSet;
            const blitSet = this.blit.createSet(descriptorPool, resolvedView);
            this.blitSet = blitSet;
            if (!shadingRateSet || !blitSet) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            shadingRateSet.updateDescriptor(0, 0, shadingRateStorage);
            shadingRateSet.updateDescriptor(1, 0, motionVectorsView);
            shadingRateSet.updateDescriptor(1, 1, hdrView);

            // A queued frame's: the view, the motion vectors', the resolve's.
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const viewSet = descriptorPool.allocateDescriptorSet(forwardLayout, 1, 0);
                const motionVectorsSet = descriptorPool.allocateDescriptorSet(motionVectorsLayout, 0, 0);
                const resolveSet = descriptorPool.allocateDescriptorSet(resolveLayout, 0, 0);
                const viewView = this.constantView(this.frameOffset(i), align(this.viewSize));
                const motionVectorsConstants = this.constantView(this.motionVectorsOffset(i), align(this.taaSize));
                const resolveConstants = this.constantView(this.resolveOffset(i), align(this.taaSize));
                if (!viewSet || !motionVectorsSet || !resolveSet || !viewView || !motionVectorsConstants || !resolveConstants) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                viewSet.updateDescriptor(0, 0, viewView);
                motionVectorsSet.updateDescriptor(0, 0, motionVectorsConstants);
                motionVectorsSet.updateDescriptor(1, 0, depthView);
                motionVectorsSet.updateDescriptor(1, 1, stencilView);
                resolveSet.updateDescriptor(0, 0, resolveConstants);
                resolveSet.updateDescriptor(1, 0, bilinearBorder);
                resolveSet.updateDescriptor(2, 0, hdrView);
                resolveSet.updateDescriptor(2, 1, motionVectorsView);
                resolveSet.updateDescriptor(2, 2, feedbackInputView);
                resolveSet.updateDescriptor(2, 3, hdrView);
                resolveSet.updateDescriptor(3, 0, resolvedStorage);
                resolveSet.updateDescriptor(3, 1, feedbackOutputStorage);
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
            if (this.previousViewsValid) {
                Nri.fillDonutTaaMotionVectorConstants(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), Ref(this.prevViewMatrix[0]),
                    Ref(this.prevProjMatrix[0]), this.width, this.height, MOTION_VECTOR_STENCIL_MASK, Ref(this.taaConstants[0]));
                constantBuffer.write(this.motionVectorsOffset(queuedFrameIndex), Ref(this.taaConstants[0]), this.taaSize);
            }
            Nri.fillDonutTaaResolveConstants(this.width, this.height, this.previousViewsValid ? 1 : 0, Ref(this.taaConstants[0]));
            constantBuffer.write(this.resolveOffset(queuedFrameIndex), Ref(this.taaConstants[0]), this.taaSize);
        }

        // The first frame: the fallback shadow map cleared (D3D12 wants depth textures initialized
        // before shaders read them), the HDR color and the motion vectors cleared to 0 (as Donut's
        // zeroed textures, which the shading rate shader reads before anything draws them).
        clearTargets(commandBuffer: NriCommandBuffer) {
            const noShadowTexture = this.noShadowTexture;
            const noShadowAttachment = this.noShadowAttachment;
            // (Nested: tslang can't && its @cpp handles, TSLANG_ISSUES #23.)
            if (!this.noShadowCleared) {
                if (noShadowTexture) {
                    if (noShadowAttachment) {
                        commandBuffer.textureBarrier(noShadowTexture, NriTextureState.ShaderResource, NriTextureState.DepthAttachment);
                        commandBuffer.beginRenderingDepthOnly(noShadowAttachment);
                        commandBuffer.clearDepth(0.0);
                        commandBuffer.endRendering();
                        commandBuffer.textureBarrier(noShadowTexture, NriTextureState.DepthAttachment, NriTextureState.ShaderResource);
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
            commandBuffer.textureBarrier(hdrColor, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(hdrAttachment);
            commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(hdrColor, NriTextureState.ColorAttachment, NriTextureState.AllShaderResource);
            commandBuffer.textureBarrier(motionVectors, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(motionVectorsAttachment);
            commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(motionVectors, NriTextureState.ColorAttachment, NriTextureState.AllShaderResource);
            this.targetsCleared = true;
        }

        // TemporalAntiAliasingPass::RenderMotionVectors (after the first frame): from the previous
        // frame's depth, the camera's movement between the two views, over the whole frame.
        recordMotionVectors(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const motionVectors = this.motionVectors;
            const motionVectorsAttachment = this.motionVectorsAttachment;
            const layout = this.motionVectorsLayout;
            const pipeline = this.motionVectorsPipeline;
            if (!this.previousViewsValid || !motionVectors || !motionVectorsAttachment || !layout || !pipeline) {
                return;
            }
            commandBuffer.textureBarrier(motionVectors, NriTextureState.AllShaderResource, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(motionVectorsAttachment);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setDescriptorSet(0, queuedFrame.motionVectorsSet);
            commandBuffer.draw(4, 1, 0, 0);
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(motionVectors, NriTextureState.ColorAttachment, NriTextureState.AllShaderResource);
        }

        // The shading rate surface from the motion vectors and the previous frame's HDR color: a
        // thread a tile.
        recordShadingRateSurface(commandBuffer: NriCommandBuffer) {
            const surface = this.shadingRateSurface;
            const layout = this.shadingRateLayout;
            const pipeline = this.shadingRatePipeline;
            const set = this.shadingRateSet;
            if (!surface || !layout || !pipeline || !set) {
                return;
            }
            commandBuffer.textureBarrier(surface, NriTextureState.ShadingRateAttachment, NriTextureState.Storage);
            commandBuffer.setComputePipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setComputeDescriptorSet(0, set);
            commandBuffer.dispatch(this.surfaceWidth, this.surfaceHeight, 1);
            commandBuffer.textureBarrier(surface, NriTextureState.Storage, NriTextureState.ShadingRateAttachment);
        }

        // Donut_ClearTemporalTargets (depth 0, stencil 0, HDR color 0), then the forward pass's draws
        // with the shading rate surface: the draws' 1x1 rate, the surface's overriding it (-raw: every
        // combiner at MAX, as the Donut example's D3D12 path; the same rates).
        recordScene(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
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
            commandBuffer.textureBarrier(hdrColor, NriTextureState.AllShaderResource, NriTextureState.ColorAttachment);
            commandBuffer.textureBarrier(depth, NriTextureState.ShaderResource, NriTextureState.DepthAttachment);
            commandBuffer.beginRenderingWithShadingRate(hdrAttachment, null, depthAttachment, shadingRateAttachment);
            commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
            commandBuffer.clearDepthStencil(0.0, 0);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            if (this.rawD3D12) {
                commandBuffer.setShadingRate(NriShadingRate.Rate1x1, NriShadingRateCombiner.Max, NriShadingRateCombiner.Max);
            } else {
                commandBuffer.setShadingRate(NriShadingRate.Rate1x1, NriShadingRateCombiner.Keep, NriShadingRateCombiner.Replace);
            }
            commandBuffer.setPipelineLayout(forwardLayout);
            commandBuffer.setDescriptorSet(1, queuedFrame.viewSet);
            commandBuffer.setDescriptorSet(2, shadingSet);
            commandBuffer.setRootDescriptor(0, instanceBufferView, 0);
            commandBuffer.setRootDescriptor(1, vertexBufferView, 0);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
            let pipeline = -1;
            let material = -1;
            for (const item of this.drawItems) {
                const itemPipeline = (item.doubleSided ? 1 : 0) + (this.mirrored ? 2 : 0);
                if (itemPipeline != pipeline) {
                    commandBuffer.setPipeline(this.forwardPipelines[itemPipeline]);
                    pipeline = itemPipeline;
                }
                if (item.material != material) {
                    commandBuffer.setDescriptorSet(0, this.materialSets[item.material]);
                    material = item.material;
                }
                commandBuffer.setRootConstants(0, Ref(item.forwardPush[0]), FORWARD_PUSH_WORDS * 4);
                commandBuffer.drawIndexed(item.indexCount, 1, item.firstIndex, 0, 0);
            }
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(depth, NriTextureState.DepthAttachment, NriTextureState.ShaderResource);
            commandBuffer.textureBarrier(hdrColor, NriTextureState.ColorAttachment, NriTextureState.AllShaderResource);
        }

        // TemporalAntiAliasingPass::TemporalResolve (runs at full rate): the HDR color into the
        // resolved color.
        recordResolve(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const resolvedColor = this.resolvedColor;
            const layout = this.resolveLayout;
            const pipeline = this.resolvePipeline;
            if (!resolvedColor || !layout || !pipeline) {
                return;
            }
            if (!this.resolvedInStorage) {
                commandBuffer.textureBarrier(resolvedColor, NriTextureState.ShaderResource, NriTextureState.Storage);
            }
            commandBuffer.setComputePipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setComputeDescriptorSet(0, queuedFrame.resolveSet);
            commandBuffer.dispatch(Math.floor((this.width + TAA_GROUP_SIZE - 1) / TAA_GROUP_SIZE),
                Math.floor((this.height + TAA_GROUP_SIZE - 1) / TAA_GROUP_SIZE), 1);
            commandBuffer.textureBarrier(resolvedColor, NriTextureState.Storage, NriTextureState.ShaderResource);
            this.resolvedInStorage = false;
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain, the temporal targets
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
            device.waitIdle();
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
            commandBuffer.begin();
            commandBuffer.setDescriptorPool(descriptorPool);
            // The first frame: the mip chains, the cleared targets.
            this.textures.recordBlits(commandBuffer);
            this.clearTargets(commandBuffer);

            this.recordMotionVectors(commandBuffer, queuedFrame);
            this.recordShadingRateSurface(commandBuffer);
            this.recordScene(commandBuffer, queuedFrame);
            this.recordResolve(commandBuffer, queuedFrame);

            commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.Undefined, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
            this.blit.record(commandBuffer, blitSet, this.width, this.height);
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
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.textures.destroy();
                this.blit.destroy();
                this.destroySizeTargets();
                const descriptors = [this.vertexBufferView, this.instanceBufferView, this.blackView, this.blackCubeArrayView,
                    this.noShadowView, this.noShadowAttachment, this.anisotropicWrap, this.linearWrap, this.linearClamp, this.shadowSampler,
                    this.bilinearBorder];
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
                const noShadowTexture = this.noShadowTexture;
                if (noShadowTexture) {
                    noShadowTexture.destroy();
                }
                for (const texture of this.solidTextures) {
                    texture.destroy();
                }
                const buffers = [this.vertexBuffer, this.instanceBuffer, this.indexBuffer, this.materialBuffer, this.constantBuffer,
                    this.readbackBuffer];
                for (const buffer of buffers) {
                    if (buffer) {
                        buffer.destroy();
                    }
                }
                for (const pipeline of this.forwardPipelines) {
                    pipeline.destroy();
                }
                const pipelines = [this.motionVectorsPipeline, this.shadingRatePipeline, this.resolvePipeline];
                for (const pipeline of pipelines) {
                    if (pipeline) {
                        pipeline.destroy();
                    }
                }
                const layouts = [this.forwardLayout, this.motionVectorsLayout, this.shadingRateLayout, this.resolveLayout];
                for (const layout of layouts) {
                    if (layout) {
                        layout.destroy();
                    }
                }
                this.frames.destroy();
                this.swapChain.destroy();
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
        const variableShading = new VariableShading(sample);
        // --scene <path>: relative to the executable's directory. -raw: the Donut example's D3D12
        // path (on D3D12; ignored otherwise).
        sample.addExampleOptionWithValues("--scene", 1);
        sample.addExampleOption("-raw");
        sample.useResizableWindow();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "--scene" && i + 1 < argc) {
                variableShading.scenePath = Nri.getArg(argc, argv, i + 1);
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

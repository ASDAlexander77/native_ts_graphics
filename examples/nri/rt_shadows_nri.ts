/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { perspProjD3DStyleReverse } from "../../core/matrix";
import { DonutFirstPersonCamera } from "../../core/donut_first_person_camera";
import { DonutSceneTextures } from "../../core/nri_donut_textures";
import { DonutBlit } from "../../core/nri_donut_blit";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriDonutScene, NriDonutSceneAccelStructs, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriRayTracingPipelineDesc, NriSample, NriShaderTable, NriTexture } from "../../core/nri";

namespace RtShadowsNri {
    // rt_shadows, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut and
    // NVRHI: the same shaders (rt_shadows.hlsl's library; Donut's G-buffer fill and blit shaders, as
    // Donut compiles them), the scene loaded as Donut's engine loads it (core/nri/nri_donut_scene.cpp,
    // core/nri_donut_textures.ts) with its acceleration structures as Donut builds them, the constants
    // filled as Donut fills them (core/nri/nri_donut_constants.cpp), through the NRI calls
    // core/nri/nri_interop.d.ts binds. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no ray tracing, or no shaders for
    // the graphics API (D3D11).
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Ray Traced Shadows";
    const DEFAULT_SCENE = "media/glTF-Sample-Assets/Models/Sponza/glTF/Sponza.gltf";

    // sizeof(float4): the ray tracing pipeline's payload size, as in the sample; the triangles' float2
    // barycentrics (no hit shader reads them).
    const PAYLOAD_SIZE = 16;
    const ATTRIBUTE_SIZE = 8;

    // The sun (Donut_AddDirectionalLight's arguments in the Donut example), the ambient color.
    const SUN_DIRECTION = [0.1, -1.0, 0.15];
    const SUN_ANGULAR_SIZE = 0.53;
    const SUN_IRRADIANCE = 1.0;
    const AMBIENT = 0.05;

    // The Donut example's camera: Donut's FirstPersonCamera at eye height looking along x; reversed
    // depth from 0.1, a 45 degree field of view.
    const MOVE_SPEED = 3.0;
    const ROTATE_SPEED = 0.005;
    const Z_NEAR = 0.1;

    // GBufferPushConstants (gbuffer_cb.h): startInstanceLocation, startVertexLocation, then the
    // position, previous position, texture coordinate, normal and tangent streams' offsets.
    const GBUFFER_PUSH_WORDS = 7;

    // Material domains: what InstancedOpaqueDrawStrategy draws (MaterialDomain_Opaque, _AlphaTested).
    const DOMAIN_OPAQUE = 0;
    const DOMAIN_ALPHA_TESTED = 1;

    // Constant buffer views' alignment.
    const CONSTANTS_ALIGNMENT = 256;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // -test: checks the last frame, read back, as the Donut example does: Sponza, lit by the sun with
    // ray traced shadows, about 62% of the frame lit and the rest in shadow.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        let dark = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            if ((p & 0xFF) <= 20 && ((p >> 8) & 0xFF) <= 20 && ((p >> 16) & 0xFF) <= 20) {
                dark++;
            }
        }
        const lit = 100.0 * (total - dark) / total;
        console.log(`Lit: ${lit}% (${total - dark} of ${total} pixels)`);
        if (lit < 50.0 || lit > 75.0) {
            return `Lit: ${lit}% of the pixels, not 50% to 75%`;
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
            public viewSet: NriDescriptorSet, public rayTracingSet: NriDescriptorSet) {
        }
    }

    // A G-buffer texture (or the depth), its attachment view and the view shaders read.
    class Target {
        constructor(public texture: NriTexture, public attachment: NriDescriptor, public view: NriDescriptor) {
        }
    }

    // A draw of the G-buffer fill pass: a geometry of an instance with its material.
    class DrawItem {
        constructor(public material: int, public doubleSided: boolean, public alphaTested: boolean, public indexCount: int,
            public firstIndex: int, public push: f32[]) {
        }
    }

    // Port of Donut-Samples' rt_shadows.cpp (as examples/rt_shadows.ts ports it) to NRI: Sponza drawn
    // into a G-buffer (Donut's GBufferFillPass, reverse depth), then a ray generation shader traces one
    // ray per pixel towards the sun through the scene's acceleration structures and shades the pixel,
    // lit or in shadow; the result is blitted into the swap chain. WASD/QE and the left mouse button
    // move the camera (Donut's FirstPersonCamera).
    class RtShadows {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        // The swap chain's size, and the window-size targets': the window's when they were (re)made.
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and the views' (sRGB).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private viewFormat: NriFormat = NriFormat.Unknown;
        private test: boolean = false;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";
        scenePath: string = DEFAULT_SCENE;

        // The scene, its draws and its acceleration structures.
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
        private accelStructs: NriDonutSceneAccelStructs | null = null;
        private topLevelASView: NriDescriptor | null = null;

        // The G-buffer (GBufferRenderTargets': sRGB diffuse and specular, snorm normals, float
        // emissive), its D24S8 depth, the shaded color (RGBA16F, written by the rays); the states they
        // are in between frames.
        private gbuffer: Target[] = [];
        private depth: Target | null = null;
        private shadedColor: NriTexture | null = null;
        private shadedColorStorage: NriDescriptor | null = null;
        private shadedColorView: NriDescriptor | null = null;
        private gbufferState: NriTextureState = NriTextureState.ShaderResource;
        private shadedColorState: NriTextureState = NriTextureState.Storage;
        // CommonRenderPasses' black, for the material slots without textures.
        private black: NriTexture | null = null;
        private blackView: NriDescriptor | null = null;

        // The G-buffer fill pass's layout and pipelines (by key: bit 0 no culling, bit 1 the alpha
        // test, bit 2 counterclockwise front faces), the ray tracing pass's, the blit.
        private gbufferLayout: NriPipelineLayout | null = null;
        private gbufferPipelines: NriPipeline[] = [];
        private rayTracingLayout: NriPipelineLayout | null = null;
        private rayTracingPipeline: NriPipeline | null = null;
        private shaderTable: NriShaderTable | null = null;
        private blit: DonutBlit = new DonutBlit();
        private blitSet: NriDescriptorSet | null = null;
        // CommonRenderPasses' anisotropic wrap sampler (the materials').
        private anisotropicWrap: NriDescriptor | null = null;

        // The constant buffer: a queued frame's GBufferFillConstants (the view, and as the previous
        // view the same) and LightingConstants.
        private constantBuffer: NriBuffer | null = null;
        private constantViews: NriDescriptor[] = [];
        private descriptorPool: NriDescriptorPool | null = null;
        private viewSize: int = 0;
        private viewStride: int = 0;
        private lightingStride: int = 0;

        private camera: DonutFirstPersonCamera = new DonutFirstPersonCamera(MOVE_SPEED, ROTATE_SPEED);
        private viewMatrix: f32[] = zeros(16);
        private projMatrix: f32[] = zeros(16);
        private mirrored: boolean = false;
        private viewConstants: f32[] = [];
        // LightingConstants (rt_shadows_lighting_cb.h): float4 ambientColor, LightConstants light,
        // PlanarViewConstants view.
        private lightingConstants: f32[] = [];
        private lightOffset: int = 4;
        private lightingViewOffset: int = 0;

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
            if (this.unsupportedReason != "") {
                const test = this.sample.isTest() != 0;
                console.log(test ? `Test SKIPPED: ${this.unsupportedReason}` : this.unsupportedReason);
                result = test ? TEST_SKIPPED : 1;
            } else if (result == 0 && this.test) {
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
            const viewFormat = this.viewFormat;

            // Ray tracing pipelines: D3D12 or Vulkan (the Donut example's shaders have no DXBC).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (ray tracing needs D3D12 or Vulkan)";
                return 0;
            }
            if (device.isFeatureSupported(NriFeature.RayTracing) == 0) {
                this.unsupportedReason = "The graphics device does not support Ray Tracing Pipelines";
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

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): once the GPU is done with them, the swap
        // chain and the targets of the window's size made again at its new size, and the descriptor
        // sets pointed at the new targets.
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
        }

        // The scene, as Donut's engine loads it, its textures, the materials' constants; the draws
        // InstancedOpaqueDrawStrategy makes of it (opaque and alpha-tested materials), by material;
        // its acceleration structures, as Donut's buildSceneAccelStructs builds them.
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
                        // The previous positions are the positions: the scene doesn't move.
                        const words = [instance, scene.getGeometryFirstVertex(instance, geometry),
                            streams[0], streams[0], streams[1], streams[2], streams[3]];
                        const push = zeros(GBUFFER_PUSH_WORDS);
                        for (let k = 0; k < GBUFFER_PUSH_WORDS; k++) {
                            Nri.storeInt32(Ref(push[k]), words[k]);
                        }
                        this.drawItems.push(new DrawItem(drawnMaterial, doubleSided, domain == DOMAIN_ALPHA_TESTED,
                            scene.getGeometryIndexCount(instance, geometry),
                            scene.getGeometryFirstIndex(instance, geometry), push));
                    }
                }
            }

            const accelStructs = device.buildDonutSceneAccelStructs(this.queue, scene);
            this.accelStructs = accelStructs;
            if (!accelStructs) {
                console.log("Cannot build the scene's acceleration structures");
                return false;
            }
            this.topLevelASView = accelStructs.getTopLevelAS().getTopLevelAccelerationStructure().createDescriptor();

            return this.textures.load(device, this.queue, scene, folder);
        }

        // The G-buffer (GBufferRenderTargets' formats; the depth: D24S8), the shaded color and
        // Donut's black fallback.
        createTargets(device: NriDevice) {
            if (!this.createSizeTargets(device)) {
                return false;
            }
            const black = device.createSolidTexture(this.queue, 1, 0xFF000000, NriTextureState.AllShaderResource);
            this.black = black;
            if (!black) {
                console.log("Cannot create the black texture");
                return false;
            }
            this.blackView = black.createView(NriFormat.RGBA8_UNORM);
            return true;
        }

        // The targets of the window's size: the G-buffer and its depth (made in ShaderResource), the
        // shaded color (made a storage texture), their views; their states as made.
        createSizeTargets(device: NriDevice) {
            this.gbufferState = NriTextureState.ShaderResource;
            this.shadedColorState = NriTextureState.Storage;
            const formats = [NriFormat.RGBA8_SRGB, NriFormat.RGBA8_SRGB, NriFormat.RGBA16_SNORM, NriFormat.RGBA16_SFLOAT];
            for (const format of formats) {
                const texture = device.createRenderTargetTexture(this.queue, this.width, this.height, format);
                if (!texture) {
                    console.log("Cannot create the G-buffer");
                    return false;
                }
                this.gbuffer.push(new Target(texture, texture.createColorAttachmentView(format), texture.createView(format)));
            }
            const depthTexture = device.createSampledDepthTexture(this.queue, this.width, this.height, NriFormat.D24_UNORM_S8_UINT);
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return false;
            }
            this.depth = new Target(depthTexture, depthTexture.createDepthAttachmentView(NriFormat.D24_UNORM_S8_UINT),
                depthTexture.createView(NriFormat.R24_UNORM_X8));

            const shadedColor = device.createStorageTexture(this.queue, this.width, this.height, NriFormat.RGBA16_SFLOAT);
            this.shadedColor = shadedColor;
            if (!shadedColor) {
                console.log("Cannot create the shaded color texture");
                return false;
            }
            this.shadedColorStorage = shadedColor.createStorageView(NriFormat.RGBA16_SFLOAT);
            this.shadedColorView = shadedColor.createView(NriFormat.RGBA16_SFLOAT);
            return true;
        }

        destroySizeTargets() {
            for (const target of this.gbuffer) {
                this.destroyTarget(target);
            }
            this.gbuffer = [];
            const depth = this.depth;
            if (depth) {
                this.destroyTarget(depth);
            }
            this.depth = null;
            this.destroyDescriptor(this.shadedColorStorage);
            this.destroyDescriptor(this.shadedColorView);
            this.destroyTexture(this.shadedColor);
            this.shadedColorStorage = null;
            this.shadedColorView = null;
            this.shadedColor = null;
        }

        // The descriptors of the window-size targets, after they were made again: each queued frame's
        // ray generation set (the G-buffer and depth, the shaded color) and the blit's (the shaded color).
        updateSizeDescriptors() {
            const depth = this.depth;
            const shadedColorStorage = this.shadedColorStorage;
            const shadedColorView = this.shadedColorView;
            if (!depth || !shadedColorStorage || !shadedColorView) {
                return;
            }
            for (const queuedFrame of this.queuedFrames) {
                queuedFrame.rayTracingSet.updateDescriptor(2, 0, depth.view);
                for (let k = 0; k < this.gbuffer.length; k++) {
                    queuedFrame.rayTracingSet.updateDescriptor(2, 1 + k, this.gbuffer[k].view);
                }
                queuedFrame.rayTracingSet.updateDescriptor(3, 0, shadedColorStorage);
            }
            const blitSet = this.blitSet;
            if (blitSet) {
                blitSet.updateDescriptor(0, 0, shadedColorView);
            }
        }

        // The passes' layouts, as their shaders declare their bindings: the G-buffer fill pass's
        // (Donut's register spaces: a set each, the instances and vertices as root descriptors in the
        // root register space), the ray generation shader's.
        createLayouts(device: NriDevice) {
            // G-buffer fill: space 0 the material (b0, t0 to t6), space 1 the push constants (b1) and
            // the instances and vertices (t10, t11), space 2 the view (b2) and its sampler (s0).
            const gbufferDesc = NriPipelineLayoutDesc.create();
            gbufferDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            gbufferDesc.addRange(0, 0, 7, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            gbufferDesc.addRange(1, 2, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            gbufferDesc.addRange(1, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            gbufferDesc.setRegisterSpace(1, 2);
            gbufferDesc.setRootRegisterSpace(1);
            gbufferDesc.addRootConstants(1, GBUFFER_PUSH_WORDS * 4, NriStage.Vertex);
            gbufferDesc.addRootDescriptor(10, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            gbufferDesc.addRootDescriptor(11, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            this.gbufferLayout = device.createPipelineLayoutFromDesc(gbufferDesc);
            gbufferDesc.destroy();

            // Ray tracing: the lighting constants (b0), the scene (t0), the G-buffer's depth and
            // textures (t1 to t5), the shaded color (u0).
            const rayTracingDesc = NriPipelineLayoutDesc.create();
            rayTracingDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.RayGen, NriRangeFlags.None);
            rayTracingDesc.addRange(0, 0, 1, NriDescriptorType.AccelerationStructure, NriStage.RayGen, NriRangeFlags.None);
            rayTracingDesc.addRange(0, 1, 5, NriDescriptorType.Texture, NriStage.RayGen, NriRangeFlags.None);
            rayTracingDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, NriStage.RayGen, NriRangeFlags.None);
            this.rayTracingLayout = device.createPipelineLayoutFromDesc(rayTracingDesc);
            rayTracingDesc.destroy();

            if (!this.gbufferLayout || !this.rayTracingLayout) {
                console.log("Cannot create the pipeline layouts");
                return false;
            }
            return true;
        }

        // Donut's G-buffer fill pass's pipelines (GBufferFillPass::CreateGraphicsPipeline: buffer
        // loads, no motion vectors; the alpha-tested ones with the alpha test's pixel shader and no
        // culling; reverse depth: greater or equal, written); the ray tracing pipeline (the ray
        // generation and miss shaders; the hit group has no shaders: a hit leaves the payload's
        // `missed` false) and its shader table.
        createPipelines(device: NriDevice, folder: string) {
            const gbufferLayout = this.gbufferLayout;
            const rayTracingLayout = this.rayTracingLayout;
            if (!gbufferLayout || !rayTracingLayout) {
                return false;
            }
            const framework = `shaders/framework/${folder}`;
            for (let key = 0; key < 8; key++) {
                const alphaTested = (key & 2) != 0;
                const desc = NriPipelineDesc.create();
                let loaded = desc.addShaderPermutation(NriShaderStage.Vertex, `${framework}/passes/gbuffer_vs_buffer_loads.bin`,
                    "buffer_loads", "MOTION_VECTORS=0") != 0;
                if (loaded) {
                    loaded = desc.addShaderPermutation(NriShaderStage.Pixel, `${framework}/passes/gbuffer_ps.bin`, "main",
                        alphaTested ? "ALPHA_TESTED=1 MOTION_VECTORS=0" : "ALPHA_TESTED=0 MOTION_VECTORS=0") != 0;
                }
                desc.setCullMode((key & 1) != 0 || alphaTested ? NriCullMode.None : NriCullMode.Back);
                desc.setFrontCounterClockwise((key >> 2) & 1);
                desc.setColor(this.gbuffer[0].texture.getFormat(), NriColorWrite.RGBA);
                for (let k = 1; k < this.gbuffer.length; k++) {
                    desc.addColor(this.gbuffer[k].texture.getFormat(), NriColorWrite.RGBA);
                }
                desc.setDepth(NriFormat.D24_UNORM_S8_UINT, NriCompareOp.GreaterEqual, 1, 0);
                const pipeline = loaded ? device.createPipelineFromDesc(gbufferLayout, desc) : null;
                desc.destroy();
                if (!pipeline) {
                    console.log("Cannot load Donut's G-buffer fill shaders");
                    return false;
                }
                this.gbufferPipelines.push(pipeline);
            }

            const desc = NriRayTracingPipelineDesc.create();
            const raygenGroup = desc.addGroup(desc.addShader(NriStage.RayGen, "RayGen"), -1, -1);
            const missGroup = desc.addGroup(desc.addShader(NriStage.Miss, "Miss"), -1, -1);
            const pipeline = device.createRayTracingPipelineFromDesc(rayTracingLayout, `shaders/rt_shadows/${folder}/rt_shadows.bin`, desc,
                PAYLOAD_SIZE, ATTRIBUTE_SIZE, 1);
            desc.destroy();
            this.rayTracingPipeline = pipeline;
            if (!pipeline) {
                console.log("Cannot initialize the ray tracing pipeline");
                return false;
            }
            const missGroups: int[] = [missGroup];
            const hitGroups: int[] = [-1];
            this.shaderTable = device.createShaderTableFromGroups(this.queue, pipeline, raygenGroup, Ref(missGroups[0]), 1,
                Ref(hitGroups[0]), 1);
            if (!this.shaderTable) {
                console.log("Cannot create the shader table");
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

        // The sampler; the constant buffer (a queued frame's constants); the queued frames and their
        // sets (the view's, the rays'); the materials' sets, the blits'.
        createDescriptorSets(device: NriDevice, queuedFrameNum: int) {
            const scene = this.scene;
            const materialBuffer = this.materialBuffer;
            const gbufferLayout = this.gbufferLayout;
            const rayTracingLayout = this.rayTracingLayout;
            const depth = this.depth;
            const blackView = this.blackView;
            const topLevelASView = this.topLevelASView;
            const shadedColorStorage = this.shadedColorStorage;
            const shadedColorView = this.shadedColorView;
            if (!scene || !materialBuffer || !gbufferLayout || !rayTracingLayout || !depth || !blackView) {
                return false;
            }
            if (!topLevelASView || !shadedColorStorage || !shadedColorView) {
                return false;
            }
            const anisotropicWrap = device.createSampler(NriFilter.Linear, NriAddressMode.Repeat, 16);
            this.anisotropicWrap = anisotropicWrap;

            this.viewSize = Nri.getDonutConstantsSize(0);
            this.viewConstants = zeros(this.viewSize / 4);
            const lightSize = Nri.getDonutConstantsSize(2);
            this.lightingViewOffset = this.lightOffset + lightSize / 4;
            this.lightingConstants = zeros(this.lightingViewOffset + this.viewSize / 4);
            this.viewStride = align(this.viewSize * 2);
            this.lightingStride = align(this.lightingConstants.length * 4);
            const frameStride = this.viewStride + this.lightingStride;
            const constantBuffer = device.createHostBuffer(queuedFrameNum * frameStride, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;

            // The sun's LightConstants and the ambient color don't change.
            for (let i = 0; i < 4; i++) {
                this.lightingConstants[i] = AMBIENT;
            }
            Nri.fillDonutDirectionalLightConstants(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2], SUN_ANGULAR_SIZE, SUN_IRRADIANCE,
                Ref(this.lightingConstants[this.lightOffset]));

            const materialCount = scene.getMaterialCount();
            const blitCount = this.textures.blitSetCount();
            const descriptorPool = device.createDescriptorPoolWithAccelerationStructures(
                materialCount + 2 * queuedFrameNum + 1 + blitCount,
                queuedFrameNum + 1 + blitCount,
                materialCount + 2 * queuedFrameNum,
                7 * materialCount + 5 * queuedFrameNum + 1 + blitCount,
                queuedFrameNum, 0, queuedFrameNum);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool || !anisotropicWrap) {
                console.log("Cannot create the descriptors");
                return false;
            }

            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const viewSet = descriptorPool.allocateDescriptorSet(gbufferLayout, 1, 0);
                const rayTracingSet = descriptorPool.allocateDescriptorSet(rayTracingLayout, 0, 0);
                const viewView = this.constantView(i * frameStride, this.viewStride);
                const lightingView = this.constantView(i * frameStride + this.viewStride, this.lightingStride);
                if (!viewSet || !rayTracingSet || !viewView || !lightingView) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                this.queuedFrames.push(new QueuedFrame(this.frames.commandBuffer(i), viewSet, rayTracingSet));
                viewSet.updateDescriptor(0, 0, viewView);
                viewSet.updateDescriptor(1, 0, anisotropicWrap);
                rayTracingSet.updateDescriptor(0, 0, lightingView);
                rayTracingSet.updateDescriptor(1, 0, topLevelASView);
                rayTracingSet.updateDescriptor(2, 0, depth.view);
                for (let k = 0; k < this.gbuffer.length; k++) {
                    rayTracingSet.updateDescriptor(2, 1 + k, this.gbuffer[k].view);
                }
                rayTracingSet.updateDescriptor(3, 0, shadedColorStorage);
            }

            // A material's set: its constants, its textures, black for the slots it doesn't use.
            for (let m = 0; m < materialCount; m++) {
                const set = descriptorPool.allocateDescriptorSet(gbufferLayout, 0, 0);
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

            this.blitSet = this.blit.createSet(descriptorPool, shadedColorView);
            if (!this.blitSet || !this.textures.createBlits(descriptorPool)) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The camera (Donut's FirstPersonCamera, unless in test mode, where nothing moves it), the
        // queued frame's GBufferFillConstants and LightingConstants.
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
            // PlanarView::IsMirrored: the G-buffer fill pass's front faces.
            const m = this.viewMatrix;
            const determinant = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8])
                + m[2] * (m[4] * m[9] - m[5] * m[8]);
            this.mirrored = determinant < 0.0;

            const offset = queuedFrameIndex * (this.viewStride + this.lightingStride);
            Nri.fillDonutPlanarViewConstants(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), this.width, this.height,
                Ref(this.viewConstants[0]));
            constantBuffer.write(offset, Ref(this.viewConstants[0]), this.viewSize);
            constantBuffer.write(offset + this.viewSize, Ref(this.viewConstants[0]), this.viewSize);
            Nri.fillDonutPlanarViewConstants(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), this.width, this.height,
                Ref(this.lightingConstants[this.lightingViewOffset]));
            constantBuffer.write(offset + this.viewStride, Ref(this.lightingConstants[0]), this.lightingConstants.length * 4);
        }

        // The G-buffer, cleared (to 0, the depth to 0: reverse depth), then the scene's opaque and
        // alpha-tested geometries drawn into it, as Donut's GBufferFillPass draws them.
        recordGBuffer(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const depth = this.depth;
            const layout = this.gbufferLayout;
            const indexBuffer = this.indexBuffer;
            const instanceBufferView = this.instanceBufferView;
            const vertexBufferView = this.vertexBufferView;
            if (!depth || !layout || !indexBuffer || !instanceBufferView || !vertexBufferView) {
                return;
            }
            for (const target of this.gbuffer) {
                commandBuffer.textureBarrier(target.texture, this.gbufferState, NriTextureState.ColorAttachment);
            }
            commandBuffer.textureBarrier(depth.texture, this.gbufferState, NriTextureState.DepthAttachment);

            commandBuffer.beginRenderingWithFourColorsAndDepth(this.gbuffer[0].attachment, this.gbuffer[1].attachment,
                this.gbuffer[2].attachment, this.gbuffer[3].attachment, depth.attachment);
            for (let k = 0; k < this.gbuffer.length; k++) {
                commandBuffer.clearColorAttachment(k, 0.0, 0.0, 0.0, 0.0);
            }
            commandBuffer.clearDepth(0.0);
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setDescriptorSet(1, queuedFrame.viewSet);
            commandBuffer.setRootDescriptor(0, instanceBufferView, 0);
            commandBuffer.setRootDescriptor(1, vertexBufferView, 0);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
            let pipeline = -1;
            let material = -1;
            for (const item of this.drawItems) {
                const itemPipeline = (item.doubleSided ? 1 : 0) + (item.alphaTested ? 2 : 0) + (this.mirrored ? 4 : 0);
                if (itemPipeline != pipeline) {
                    commandBuffer.setPipeline(this.gbufferPipelines[itemPipeline]);
                    pipeline = itemPipeline;
                }
                if (item.material != material) {
                    commandBuffer.setDescriptorSet(0, this.materialSets[item.material]);
                    material = item.material;
                }
                commandBuffer.setRootConstants(0, Ref(item.push[0]), GBUFFER_PUSH_WORDS * 4);
                commandBuffer.drawIndexed(item.indexCount, 1, item.firstIndex, 0, 0);
            }
            commandBuffer.endRendering();

            for (const target of this.gbuffer) {
                commandBuffer.textureBarrier(target.texture, NriTextureState.ColorAttachment, NriTextureState.RayTracingShaderResource);
            }
            commandBuffer.textureBarrier(depth.texture, NriTextureState.DepthAttachment, NriTextureState.RayTracingShaderResource);
            this.gbufferState = NriTextureState.RayTracingShaderResource;
        }

        // The rays: one per pixel towards the sun, shading the pixel into the shaded color, which then
        // goes to the blit.
        recordRays(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const shadedColor = this.shadedColor;
            const layout = this.rayTracingLayout;
            const pipeline = this.rayTracingPipeline;
            const shaderTable = this.shaderTable;
            if (!shadedColor || !layout || !pipeline || !shaderTable) {
                return;
            }
            // (From its creation, already a storage texture: D3D12 wants the states to differ.)
            if (this.shadedColorState != NriTextureState.Storage) {
                commandBuffer.textureBarrier(shadedColor, this.shadedColorState, NriTextureState.RayTracingStorage);
            }
            commandBuffer.setRayTracingPipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setRayTracingDescriptorSet(0, queuedFrame.rayTracingSet);
            commandBuffer.dispatchRays(shaderTable, this.width, this.height);
            commandBuffer.textureBarrier(shadedColor, NriTextureState.RayTracingStorage, NriTextureState.ShaderResource);
            this.shadedColorState = NriTextureState.ShaderResource;
        }

        // The shaded color over the frame (between NriCommandBuffer.beginRendering and NriCommandBuffer.endRendering).
        recordBlit(commandBuffer: NriCommandBuffer) {
            const blitSet = this.blitSet;
            if (blitSet) {
                this.blit.record(commandBuffer, blitSet, this.width, this.height);
            }
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
            // The first frame: the mip chains.
            this.textures.recordBlits(commandBuffer);
            this.recordGBuffer(commandBuffer, queuedFrame);
            this.recordRays(commandBuffer, queuedFrame);

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
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                for (const view of this.constantViews) {
                    view.destroy();
                }
                for (const view of this.materialViews) {
                    view.destroy();
                }
                this.destroyDescriptor(this.anisotropicWrap);
                this.blit.destroy();
                this.textures.destroy();
                this.destroySizeTargets();
                this.destroyDescriptor(this.blackView);
                this.destroyTexture(this.black);
                this.destroyDescriptor(this.topLevelASView);
                const accelStructs = this.accelStructs;
                if (accelStructs) {
                    accelStructs.destroy();
                }
                const shaderTable = this.shaderTable;
                if (shaderTable) {
                    shaderTable.destroy();
                }
                this.destroyDescriptor(this.vertexBufferView);
                this.destroyDescriptor(this.instanceBufferView);
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.instanceBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.materialBuffer);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                for (const pipeline of this.gbufferPipelines) {
                    pipeline.destroy();
                }
                const rayTracingPipeline = this.rayTracingPipeline;
                if (rayTracingPipeline) {
                    rayTracingPipeline.destroy();
                }
                this.destroyLayout(this.gbufferLayout);
                this.destroyLayout(this.rayTracingLayout);
                this.frames.destroy();
                device.destroy();
            }
            const scene = this.scene;
            if (scene) {
                scene.destroy();
            }
            this.sample.destroy();
        }

        destroyTarget(target: Target) {
            target.attachment.destroy();
            target.view.destroy();
            target.texture.destroy();
        }

        destroyDescriptor(descriptor: NriDescriptor | null) {
            if (descriptor) {
                descriptor.destroy();
            }
        }

        destroyTexture(texture: NriTexture | null) {
            if (texture) {
                texture.destroy();
            }
        }

        destroyBuffer(buffer: NriBuffer | null) {
            if (buffer) {
                buffer.destroy();
            }
        }

        destroyLayout(layout: NriPipelineLayout | null) {
            if (layout) {
                layout.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const rtShadows = new RtShadows(sample);
        // --scene <path>: relative to the executable's directory.
        sample.addExampleOptionWithValues("--scene", 1);
        for (let i = 1; i < argc; i++) {
            if (Nri.getArg(argc, argv, i) == "--scene" && i + 1 < argc) {
                rtShadows.scenePath = Nri.getArg(argc, argv, i + 1);
            }
        }
        return rtShadows.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RtShadowsNri.main(argc, argv);
}

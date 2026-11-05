/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriSwapChain } from "../../core/nri_swap_chain";
import { DonutFirstPersonCamera } from "../../core/donut_first_person_camera";
import { DonutSceneTextures } from "../../core/nri_donut_textures";
import { Nri, NriBuffer, NriCommandAllocator, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriDonutScene, NriDrawList, NriDrawPass, NriFence, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace ThreadedRenderingNri {
    // threaded_rendering, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: Donut's forward shading pass's shaders and blit shaders (shaders/framework, as
    // Donut compiles them), the scene loaded as Donut's engine loads it (core/nri/nri_donut_scene.cpp,
    // core/nri_donut_textures.ts), the constants filled as Donut fills them
    // (core/nri/nri_donut_constants.cpp), through the NRI calls core/nri/nri_interop.d.ts binds. This
    // example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Threaded Rendering";
    const DEFAULT_SCENE = "media/glTF-Sample-Assets/Models/Sponza/glTF/Sponza.gltf";
    // The window's size: the cube faces' layout.
    const WINDOW_WIDTH = 1024;
    const WINDOW_HEIGHT = 768;

    const NUM_FACES = 6;
    const CUBEMAP_RESOLUTION = 1024;

    // Where each cube face goes in the window, as (column, row) of a 4 x 3 grid.
    const g_FaceLayout: int[] = [
        3, 1,
        1, 1,
        2, 0,
        2, 2,
        2, 1,
        0, 1,
    ];

    // The Donut example's camera: Donut's FirstPersonCamera (its default rotate speed), at the eye
    // height looking along x; the cube map's views from 0.1 (CubemapView's reverse infinite
    // projection).
    const MOVE_SPEED = 3.0;
    const ROTATE_SPEED = 0.005;
    const Z_NEAR = 0.1;

    // The ambient light (the only light: ForwardShadingPass::PrepareLights' top and bottom colors).
    const AMBIENT_TOP = 1.0;
    const AMBIENT_BOTTOM = 0.3;

    // ForwardPushConstants (donut/shaders/forward_cb.h): startInstanceLocation, startVertexLocation,
    // then the position, texture coordinate, normal and tangent streams' offsets.
    const PUSH_CONSTANT_WORDS = 6;

    // Donut's blit of a slice (CommonRenderPasses::BlitTexture): struct BlitConstants
    // { float2 sourceOrigin, sourceSize, targetOrigin, targetSize; float sharpenFactor; }.
    const BLIT_CONSTANTS: f32[] = [0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0];

    // Material domains Donut's InstancedOpaqueDrawStrategy draws (MaterialDomain_Opaque,
    // _AlphaTested).
    const DOMAIN_OPAQUE = 0;
    const DOMAIN_ALPHA_TESTED = 1;

    // Constant buffer views' alignment.
    const CONSTANTS_ALIGNMENT = 256;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // -test: checks the last frame, read back, as the Donut example does. The corners are black; the
    // scene, drawn into the cube faces, covers about half the frame.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != 0) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not black`;
            }
        }
        let scene = 0;
        for (let i = 0; i < width * height; i++) {
            if ((pixels[i] & 0xFFFFFF) != 0) {
                scene++;
            }
        }
        const percent = 100.0 * scene / (width * height);
        console.log(`Scene: ${percent}% (${scene} of ${width * height} pixels)`);
        if (percent < 40.0 || percent > 58.0) {
            return `Scene: ${percent}% of the pixels, not 40% to 58%`;
        }
        return "";
    }

    // What a frame in flight records into: before the faces (the first frame's mip chains, the cube
    // map's barrier) and after them (the blits); a face's own allocator and command buffer each (a
    // worker thread records each); its sets (a face's view constants each).
    class QueuedFrame {
        faceAllocators: NriCommandAllocator[] = [];
        faceCommandBuffers: NriCommandBuffer[] = [];
        constructor(public commandAllocator: NriCommandAllocator, public beforeFaces: NriCommandBuffer,
            public commandBuffer: NriCommandBuffer, public viewSets: NriDescriptorSet[],
            public viewConstantsViews: NriDescriptor[]) {
        }
    }

    // A draw of the forward pass: a geometry of an instance with its material.
    class DrawItem {
        constructor(public instance: int, public material: int, public doubleSided: boolean, public indexCount: int,
            public firstIndex: int, public pushConstants: f32[]) {
        }
    }

    // Port of Donut-Samples' threaded_rendering.cpp (as examples/threaded_rendering.ts ports it) to
    // NRI: renders the scene, lit by the ambient light alone, with Donut's forward shading pass into
    // the six faces of a cube map around the camera, each face into its own command buffer, either on
    // worker threads or one after another (Space toggles), then shows the faces unfolded. WASD/QE and
    // the left mouse button move the camera (Donut's FirstPersonCamera).
    //
    // The faces' recording is C++ (nri_interop's draw passes, replaying a draw list this class makes
    // once): TypeScript code must not run on the worker threads, which its garbage collector doesn't
    // know about.
    class ThreadedRendering {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frameFence: NriFence;
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views' (the swap chain's).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private swapChainViewFormat: NriFormat = NriFormat.Unknown;
        private test: boolean = false;
        scenePath: string = DEFAULT_SCENE;

        // The scene: its buffers (vertices, instances, the index buffer, the materials' constants),
        // views, textures; its draws.
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
        // The draws as a draw list (pipeline slots 0, back faces culled, and 1, none), and a face's
        // draw pass each.
        private drawList: NriDrawList | null = null;
        private facePasses: NriDrawPass[] = [];
        // Space toggles; -noThreads starts without.
        useThreads: boolean = true;

        // The cube map (Donut_CreateCubemapTarget's: sRGB color, D32 depth, six layers) and a face's
        // views: attachments, and the slice the blit reads.
        private cubeColor: NriTexture | null = null;
        private cubeDepth: NriTexture | null = null;
        private faceColorAttachments: NriDescriptor[] = [];
        private faceDepthAttachments: NriDescriptor[] = [];
        private faceViews: NriDescriptor[] = [];
        private faceBlitSets: NriDescriptorSet[] = [];

        // Donut's CommonRenderPasses fallbacks the forward pass binds for the inputs it isn't given:
        // black, a black cubemap array, a depth texture array (the shadow maps', cleared once); their
        // views.
        private solidTextures: NriTexture[] = [];
        private blackView: NriDescriptor | null = null;
        private blackCubeArrayView: NriDescriptor | null = null;
        private shadowMapTexture: NriTexture | null = null;
        private shadowMapView: NriDescriptor | null = null;
        private shadowMapAttachment: NriDescriptor | null = null;
        private shadowMapCleared: boolean = false;

        // The forward pass's layout, its pipelines (back faces culled, or none for double-sided
        // materials; front faces clockwise, or counterclockwise in a mirrored view),
        // its shading set (the light constants, the fallbacks, the samplers); the blit's.
        private layout: NriPipelineLayout | null = null;
        private pipelines: NriPipeline[] = [];
        private shadingSet: NriDescriptorSet | null = null;
        private lightConstantsView: NriDescriptor | null = null;
        private blitLayout: NriPipelineLayout | null = null;
        private blitPipeline: NriPipeline | null = null;
        // CommonRenderPasses' anisotropic wrap, linear wrap and linear clamp samplers, the forward
        // pass's shadow sampler (border).
        private samplers: NriDescriptor[] = [];
        private constantBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private viewConstantsSize: int = 0;
        private viewStride: int = 0;
        private lightStride: int = 0;

        private camera: DonutFirstPersonCamera = new DonutFirstPersonCamera(MOVE_SPEED, ROTATE_SPEED);
        private viewMatrix: f32[] = [];
        // The faces' views are mirrored (PlanarView::IsMirrored: the view's basis has a negative
        // determinant, as Donut's cameras' do: their right is dir x up).
        private mirrored: boolean = false;
        private viewConstants: f32[] = [];
        private blitConstants: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
            }
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
            this.sample.setWindowSize(WINDOW_WIDTH, WINDOW_HEIGHT);

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
            // As the Donut example.
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                console.log("The Threaded Rendering example does not support D3D11.");
                return 0;
            }
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);

            this.queue = device.getGraphicsQueue();
            this.frameFence = device.createFence(0);
            this.test = this.sample.isTest() != 0;

            // Swap chain: blitted into through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;

            const folder = graphicsAPI == NriGraphicsAPI.VK ? "spirv" : "dxil";
            if (!this.loadScene(device, folder) || !this.createTargets(device) || !this.createPipelines(device, folder)
                || !this.createDescriptorSets(device, queuedFrameNum) || !this.createFacePasses()) {
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

        // The scene, as Donut's engine loads it: its buffers, its textures (their mip chains blitted
        // in the first frame), the materials' constants; the draws InstancedOpaqueDrawStrategy makes
        // of it (opaque and alpha-tested materials), sorted by material as it sorts them.
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
                for (let instance = 0; instance < instanceCount; instance++) {
                    const geometryCount = scene.getInstanceGeometryCount(instance);
                    for (let geometry = 0; geometry < geometryCount; geometry++) {
                        const material = scene.getGeometryMaterial(instance, geometry);
                        if (material != drawnMaterial) {
                            continue;
                        }
                        const domain = scene.getMaterialDomain(material);
                        if (domain != DOMAIN_OPAQUE && domain != DOMAIN_ALPHA_TESTED) {
                            continue;
                        }
                        const words = [instance, scene.getGeometryFirstVertex(instance, geometry),
                            streams[0], streams[1], streams[2], streams[3]];
                        const pushConstants: f32[] = [];
                        for (let k = 0; k < PUSH_CONSTANT_WORDS; k++) {
                            pushConstants.push(0.0);
                            Nri.storeInt32(Ref(pushConstants[k]), words[k]);
                        }
                        this.drawItems.push(new DrawItem(instance, material, scene.getMaterialDoubleSided(material) != 0,
                            scene.getGeometryIndexCount(instance, geometry),
                            scene.getGeometryFirstIndex(instance, geometry), pushConstants));
                    }
                }
            }

            return this.textures.load(device, this.queue, scene, folder);
        }

        // The cube map, a face's views; the fallback textures.
        createTargets(device: NriDevice) {
            const cubeColor = device.createLayeredRenderTargetTexture(this.queue, CUBEMAP_RESOLUTION, CUBEMAP_RESOLUTION, NUM_FACES,
                NriFormat.RGBA8_SRGB);
            const cubeDepth = device.createLayeredDepthTexture(this.queue, CUBEMAP_RESOLUTION, CUBEMAP_RESOLUTION, NUM_FACES,
                NriFormat.D32_SFLOAT);
            this.cubeColor = cubeColor;
            this.cubeDepth = cubeDepth;
            if (!cubeColor || !cubeDepth) {
                console.log("Cannot create the cube map");
                return false;
            }
            for (let face = 0; face < NUM_FACES; face++) {
                this.faceColorAttachments.push(cubeColor.createColorAttachmentLayerView(NriFormat.RGBA8_SRGB, face));
                this.faceDepthAttachments.push(cubeDepth.createDepthAttachmentLayerView(NriFormat.D32_SFLOAT, face));
                this.faceViews.push(cubeColor.createArrayLayerView(NriFormat.RGBA8_SRGB, face));
            }

            const black = device.createSolidTexture(this.queue, 1, 0xFF000000, NriTextureState.ShaderResource);
            const blackCubes = device.createSolidTexture(this.queue, 6, 0xFF000000, NriTextureState.ShaderResource);
            const shadowMapTexture = device.createSampledDepthTexture(this.queue, 1, 1, NriFormat.D16_UNORM);
            this.shadowMapTexture = shadowMapTexture;
            if (!black || !blackCubes || !shadowMapTexture) {
                console.log("Cannot create the default textures");
                return false;
            }
            this.solidTextures.push(black);
            this.solidTextures.push(blackCubes);
            this.blackView = black.createView(NriFormat.RGBA8_UNORM);
            this.blackCubeArrayView = blackCubes.createCubeArrayView(NriFormat.RGBA8_UNORM);
            this.shadowMapView = shadowMapTexture.createArrayView(NriFormat.D16_UNORM);
            this.shadowMapAttachment = shadowMapTexture.createDepthAttachmentView(NriFormat.D16_UNORM);
            return true;
        }

        // The forward pass's layout (Donut's register spaces: 0 the material, 1 the inputs as root
        // constants and descriptors, 2 the view, 3 the shading) and pipelines (forward_vs's buffer
        // loads, forward_ps without transmission; front faces clockwise, depth tested greater or
        // equal and written: reverse depth); Donut's slice blit (blit_ps with texture arrays).
        createPipelines(device: NriDevice, folder: string) {
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 7, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(1, 2, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            layoutDesc.setRegisterSpace(1, 2);
            layoutDesc.addRange(2, 3, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(2, 20, 4, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(2, 0, 4, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.setRegisterSpace(2, 3);
            layoutDesc.setRootRegisterSpace(1);
            layoutDesc.addRootConstants(1, PUSH_CONSTANT_WORDS * 4, NriStage.Vertex);
            layoutDesc.addRootDescriptor(10, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            layoutDesc.addRootDescriptor(11, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            const layout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            this.layout = layout;

            const blitDesc = NriPipelineLayoutDesc.create();
            blitDesc.addRootConstants(0, BLIT_CONSTANTS.length * 4, NriStage.Vertex);
            blitDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            blitDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const blitLayout = device.createPipelineLayoutFromDesc(blitDesc);
            blitDesc.destroy();
            this.blitLayout = blitLayout;
            if (!layout || !blitLayout) {
                console.log("Cannot create the pipeline layouts");
                return false;
            }

            const framework = `shaders/framework/${folder}`;
            // By cull mode (back faces, none) and front face (clockwise, counterclockwise: a mirrored
            // view's, ForwardShadingPass's pipeline key).
            for (let key = 0; key < 4; key++) {
                const cullMode = (key & 1) != 0 ? NriCullMode.None : NriCullMode.Back;
                const desc = NriPipelineDesc.create();
                let loaded = desc.addShader(NriShaderStage.Vertex, `${framework}/passes/forward_vs_buffer_loads.bin`,
                    "buffer_loads") != 0;
                if (loaded) {
                    loaded = desc.addShaderPermutation(NriShaderStage.Pixel, `${framework}/passes/forward_ps.bin`, "main",
                        "TRANSMISSIVE_MATERIAL=0") != 0;
                }
                desc.setCullMode(cullMode);
                desc.setFrontCounterClockwise(key >> 1);
                desc.setColor(NriFormat.RGBA8_SRGB, NriColorWrite.RGBA);
                desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.GreaterEqual, 1, 0);
                const pipeline = loaded ? device.createPipelineFromDesc(layout, desc) : null;
                desc.destroy();
                if (!pipeline) {
                    console.log("Cannot load the forward shading shaders");
                    return false;
                }
                this.pipelines.push(pipeline);
            }

            const blitPipelineDesc = NriPipelineDesc.create();
            let loaded = blitPipelineDesc.addShader(NriShaderStage.Vertex, `${framework}/rect_vs.bin`, "main") != 0;
            if (loaded) {
                loaded = blitPipelineDesc.addShaderPermutation(NriShaderStage.Pixel, `${framework}/blit_ps.bin`, "main",
                    "TEXTURE_ARRAY=1") != 0;
            }
            blitPipelineDesc.setTopology(NriTopology.TriangleStrip);
            blitPipelineDesc.setColor(this.viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.blitPipeline = device.createPipelineFromDesc(blitLayout, blitPipelineDesc);
            }
            blitPipelineDesc.destroy();
            if (!this.blitPipeline) {
                console.log("Cannot load Donut's blit shaders");
                return false;
            }
            return true;
        }

        // The samplers, the constant buffer (the light constants, then a queued frame's six faces'
        // view constants each), the sets: a material's each, the shading set, a queued frame's six
        // view sets, a face blit's each, the texture blits'.
        createDescriptorSets(device: NriDevice, queuedFrameNum: int) {
            const scene = this.scene;
            const layout = this.layout;
            const blitLayout = this.blitLayout;
            const materialBuffer = this.materialBuffer;
            if (!scene || !layout || !blitLayout || !materialBuffer) {
                return false;
            }
            this.samplers.push(device.createSampler(NriFilter.Linear, NriAddressMode.Repeat, 16));
            this.samplers.push(device.createSampler(NriFilter.Linear, NriAddressMode.ClampToBorder, 1));
            this.samplers.push(device.createSampler(NriFilter.Linear, NriAddressMode.Repeat, 1));
            this.samplers.push(device.createSampler(NriFilter.Linear, NriAddressMode.ClampToEdge, 1));

            this.viewConstantsSize = Nri.getDonutConstantsSize(0);
            for (let i = 0; i < this.viewConstantsSize / 4; i++) {
                this.viewConstants.push(0.0);
            }
            const lightConstantsSize = Nri.getDonutConstantsSize(4);
            this.viewStride = Math.floor((this.viewConstantsSize + CONSTANTS_ALIGNMENT - 1) / CONSTANTS_ALIGNMENT) * CONSTANTS_ALIGNMENT;
            this.lightStride = Math.floor((lightConstantsSize + CONSTANTS_ALIGNMENT - 1) / CONSTANTS_ALIGNMENT) * CONSTANTS_ALIGNMENT;
            const constantBuffer = device.createHostBuffer(this.lightStride + queuedFrameNum * NUM_FACES * this.viewStride,
                NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;

            const materialCount = scene.getMaterialCount();
            const blitCount = this.textures.blitSetCount();
            const setNum = materialCount + 1 + queuedFrameNum * NUM_FACES + NUM_FACES + blitCount;
            const descriptorPool = device.createDescriptorPool(setNum, 4 + NUM_FACES + blitCount,
                materialCount + 1 + queuedFrameNum * NUM_FACES, 7 * materialCount + 4 + NUM_FACES + blitCount, 0, 0);
            this.descriptorPool = descriptorPool;
            const blackView = this.blackView;
            const blackCubeArrayView = this.blackCubeArrayView;
            const shadowMapView = this.shadowMapView;
            if (!constantBuffer || !descriptorPool || !blackView || !blackCubeArrayView || !shadowMapView) {
                console.log("Cannot create the descriptors");
                return false;
            }

            // The light constants: the ambient light alone.
            const lightConstants: f32[] = [];
            for (let i = 0; i < lightConstantsSize / 4; i++) {
                lightConstants.push(0.0);
            }
            Nri.fillDonutForwardLightConstants(AMBIENT_TOP, AMBIENT_TOP, AMBIENT_TOP, AMBIENT_BOTTOM, AMBIENT_BOTTOM, AMBIENT_BOTTOM,
                Ref(lightConstants[0]));
            constantBuffer.write(0, Ref(lightConstants[0]), lightConstantsSize);
            this.lightConstantsView = constantBuffer.createConstantView(0, this.lightStride);

            // A material's: its constants, its textures (black for the slots it doesn't use).
            for (let m = 0; m < materialCount; m++) {
                const set = descriptorPool.allocateDescriptorSet(layout, 0, 0);
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

            // The shading set: ForwardShadingPass::CreateShadingBindingSet's, with CommonRenderPasses'
            // fallbacks.
            const shadingSet = descriptorPool.allocateDescriptorSet(layout, 2, 0);
            const lightConstantsView = this.lightConstantsView;
            this.shadingSet = shadingSet;
            if (!shadingSet || !lightConstantsView) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            shadingSet.updateDescriptor(0, 0, lightConstantsView);
            shadingSet.updateDescriptor(1, 0, shadowMapView);
            shadingSet.updateDescriptor(1, 1, blackCubeArrayView);
            shadingSet.updateDescriptor(1, 2, blackCubeArrayView);
            shadingSet.updateDescriptor(1, 3, blackView);
            const shadingSamplers = [this.samplers[0], this.samplers[1], this.samplers[2], this.samplers[3]];
            for (let k = 0; k < 4; k++) {
                shadingSet.updateDescriptor(2, k, shadingSamplers[k]);
            }

            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = this.queue.createCommandAllocator();
                const viewSets: NriDescriptorSet[] = [];
                const views: NriDescriptor[] = [];
                for (let face = 0; face < NUM_FACES; face++) {
                    const set = descriptorPool.allocateDescriptorSet(layout, 1, 0);
                    const view = constantBuffer.createConstantView(this.viewOffset(i, face), this.viewStride);
                    if (!set || !view) {
                        console.log("Cannot create the descriptor sets");
                        return false;
                    }
                    set.updateDescriptor(0, 0, view);
                    viewSets.push(set);
                    views.push(view);
                }
                const queuedFrame = new QueuedFrame(commandAllocator, commandAllocator.createCommandBuffer(),
                    commandAllocator.createCommandBuffer(), viewSets, views);
                for (let face = 0; face < NUM_FACES; face++) {
                    const faceAllocator = this.queue.createCommandAllocator();
                    queuedFrame.faceAllocators.push(faceAllocator);
                    queuedFrame.faceCommandBuffers.push(faceAllocator.createCommandBuffer());
                }
                this.queuedFrames.push(queuedFrame);
            }

            for (let face = 0; face < NUM_FACES; face++) {
                const set = descriptorPool.allocateDescriptorSet(blitLayout, 0, 0);
                if (!set) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                set.updateDescriptor(0, 0, this.faceViews[face]);
                set.updateDescriptor(1, 0, this.samplers[3]);
                this.faceBlitSets.push(set);
            }

            if (!this.textures.createBlits(descriptorPool)) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            return true;
        }

        // The draw list (the draws in order, a pipeline slot, material set and push constants changed
        // as they change) and a face's pass each: its attachments, cleared to 0 (color and reverse
        // depth), the shading set, the instances and vertices, the index buffer.
        createFacePasses() {
            const layout = this.layout;
            const descriptorPool = this.descriptorPool;
            const shadingSet = this.shadingSet;
            const indexBuffer = this.indexBuffer;
            const instanceBufferView = this.instanceBufferView;
            const vertexBufferView = this.vertexBufferView;
            if (!layout || !descriptorPool || !shadingSet || !indexBuffer || !instanceBufferView) {
                return false;
            }
            if (!vertexBufferView) {
                return false;
            }
            const drawList = NriDrawList.create();
            this.drawList = drawList;
            let slot = -1;
            let material = -1;
            for (const item of this.drawItems) {
                const itemSlot = item.doubleSided ? 1 : 0;
                if (itemSlot != slot) {
                    drawList.setPipeline(itemSlot);
                    slot = itemSlot;
                }
                if (item.material != material) {
                    drawList.setDescriptorSet(0, this.materialSets[item.material]);
                    material = item.material;
                }
                drawList.setRootConstants(0, Ref(item.pushConstants[0]), PUSH_CONSTANT_WORDS * 4);
                drawList.drawIndexed(item.indexCount, 1, item.firstIndex, 0, 0);
            }
            for (let face = 0; face < NUM_FACES; face++) {
                const pass = drawList.createDrawPass(this.faceColorAttachments[face], this.faceDepthAttachments[face],
                    CUBEMAP_RESOLUTION, CUBEMAP_RESOLUTION, layout, descriptorPool);
                pass.setDescriptorSet(2, shadingSet);
                pass.setRootDescriptor(0, instanceBufferView);
                pass.setRootDescriptor(1, vertexBufferView);
                pass.setIndexBuffer(indexBuffer);
                this.facePasses.push(pass);
            }
            return true;
        }

        // Where a queued frame's face's view constants are in the constant buffer.
        viewOffset(queuedFrameIndex: int, face: int) {
            return this.lightStride + (queuedFrameIndex * NUM_FACES + face) * this.viewStride;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            this.frameFence.wait(frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            queuedFrame.commandAllocator.reset();
            for (const faceAllocator of queuedFrame.faceAllocators) {
                faceAllocator.reset();
            }
        }

        // The camera (Donut's FirstPersonCamera, unless in test mode, where nothing moves it) and the
        // queued frame's faces' view constants (CubemapView::SetTransform with the camera's view).
        writeConstants(queuedFrameIndex: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            if (!this.test) {
                this.camera.animate(this.sample, this.sample.getFrameTime(), true);
            }
            const worldToView = this.camera.worldToView();
            for (let i = 0; i < 16; i++) {
                this.viewMatrix[i] = worldToView[i];
            }
            // (The faces' turns are rotations: the camera's basis decides.)
            const m = this.viewMatrix;
            const determinant = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8])
                + m[2] * (m[4] * m[9] - m[5] * m[8]);
            this.mirrored = determinant < 0.0;
            for (let face = 0; face < NUM_FACES; face++) {
                Nri.fillDonutCubemapFaceViewConstants(Ref(this.viewMatrix[0]), Z_NEAR, CUBEMAP_RESOLUTION, face, Ref(this.viewConstants[0]));
                constantBuffer.write(this.viewOffset(queuedFrameIndex, face), Ref(this.viewConstants[0]), this.viewConstantsSize);
            }
        }

        // The shadow map fallback, cleared once (D3D12 wants depth textures initialized before
        // shaders read them).
        clearShadowMap(commandBuffer: NriCommandBuffer) {
            const texture = this.shadowMapTexture;
            const attachment = this.shadowMapAttachment;
            if (this.shadowMapCleared || !texture || !attachment) {
                return;
            }
            commandBuffer.textureBarrier(texture, NriTextureState.ShaderResource, NriTextureState.DepthAttachment);
            commandBuffer.beginRenderingDepthOnly(attachment);
            commandBuffer.clearDepth(0.0);
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(texture, NriTextureState.DepthAttachment, NriTextureState.ShaderResource);
            this.shadowMapCleared = true;
        }

        // The faces unfolded over the swap chain texture (between NriCommandBuffer.beginRendering and
        // NriCommandBuffer.endRendering): Donut's blit of each slice into its square.
        recordBlits(commandBuffer: NriCommandBuffer) {
            const blitLayout = this.blitLayout;
            const blitPipeline = this.blitPipeline;
            if (!blitLayout || !blitPipeline) {
                return;
            }
            const faceSize = Math.min(Math.floor(this.width / 4), Math.floor(this.height / 3));
            commandBuffer.setPipelineLayout(blitLayout);
            commandBuffer.setPipeline(blitPipeline);
            for (let face = 0; face < NUM_FACES; face++) {
                const x = g_FaceLayout[face * 2] * faceSize;
                const y = g_FaceLayout[face * 2 + 1] * faceSize;
                commandBuffer.setViewport(x, y, faceSize, faceSize);
                commandBuffer.setScissor(x, y, faceSize, faceSize);
                commandBuffer.setRootConstants(0, Ref(this.blitConstants[0]), BLIT_CONSTANTS.length * 4);
                commandBuffer.setDescriptorSet(0, this.faceBlitSets[face]);
                commandBuffer.draw(4, 1, 0, 0);
            }
        }

        // The faces' passes record the scene into the queued frame's faces' command buffers, as seen by
        // its faces' views, with the pipelines of the views' front faces: on worker threads, or one
        // after another.
        recordFaces(queuedFrame: QueuedFrame) {
            for (let face = 0; face < NUM_FACES; face++) {
                const pass = this.facePasses[face];
                pass.setDescriptorSet(1, queuedFrame.viewSets[face]);
                pass.setPipeline(0, this.pipelines[this.mirrored ? 2 : 0]);
                pass.setPipeline(1, this.pipelines[this.mirrored ? 3 : 1]);
                if (this.useThreads) {
                    pass.recordAsync(queuedFrame.faceCommandBuffers[face]);
                } else {
                    pass.record(queuedFrame.faceCommandBuffers[face]);
                }
            }
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain made
        // again at its size, once the GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            this.swapChain.recreate();
            this.sizeToSwapChain();
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.sample.isKeyToggled(NriKey.Space) != 0) {
                this.useThreads = !this.useThreads;
                this.sample.setWindowTitle(`${WINDOW_TITLE} ${this.useThreads ? "(With threads)" : "(No threads)"}`);
            }
            this.writeConstants(queuedFrameIndex);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                this.recordAndSubmit(frameIndex, queuedFrame, index);
            }

            // Signaled after the present, as NRISamples do
            this.queue.signal(this.frameFence, 1 + frameIndex);
        }

        // Records the frame into the queued frame's command buffer, submits it and presents.
        recordAndSubmit(frameIndex: int, queuedFrame: QueuedFrame, index: int) {
            const descriptorPool = this.descriptorPool;
            const cubeColor = this.cubeColor;
            if (!descriptorPool || !cubeColor) {
                return;
            }
            // The faces, on their threads; meanwhile, before them: the mip chains and the fallback (the
            // first frame), the cube map's barrier; after them: their blits.
            this.recordFaces(queuedFrame);
            const beforeFaces = queuedFrame.beforeFaces;
            beforeFaces.begin();
            beforeFaces.setDescriptorPool(descriptorPool);
            this.textures.recordBlits(beforeFaces);
            this.clearShadowMap(beforeFaces);
            beforeFaces.textureBarrier(cubeColor, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            beforeFaces.end();

            const commandBuffer = queuedFrame.commandBuffer;
            commandBuffer.begin();
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.textureBarrier(cubeColor, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
            commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.Undefined, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
            commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
            this.recordBlits(commandBuffer);
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

            // Submit (once the faces are recorded) and present
            for (const pass of this.facePasses) {
                pass.wait();
            }
            this.queue.submitCommandBuffer(beforeFaces);
            for (const faceCommandBuffer of queuedFrame.faceCommandBuffers) {
                this.queue.submitCommandBuffer(faceCommandBuffer);
            }
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
                for (const pass of this.facePasses) {
                    pass.destroy();
                }
                const drawList = this.drawList;
                if (drawList) {
                    drawList.destroy();
                }
                device.waitIdle();
                for (const queuedFrame of this.queuedFrames) {
                    for (let face = 0; face < queuedFrame.faceCommandBuffers.length; face++) {
                        queuedFrame.faceCommandBuffers[face].destroy();
                        queuedFrame.faceAllocators[face].destroy();
                    }
                    queuedFrame.beforeFaces.destroy();
                    queuedFrame.commandBuffer.destroy();
                    queuedFrame.commandAllocator.destroy();
                    for (const view of queuedFrame.viewConstantsViews) {
                        view.destroy();
                    }
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.textures.destroy();
                for (const view of this.materialViews) {
                    view.destroy();
                }
                for (const sampler of this.samplers) {
                    sampler.destroy();
                }
                for (let face = 0; face < this.faceViews.length; face++) {
                    this.faceColorAttachments[face].destroy();
                    this.faceDepthAttachments[face].destroy();
                    this.faceViews[face].destroy();
                }
                this.destroyDescriptor(this.lightConstantsView);
                this.destroyDescriptor(this.blackView);
                this.destroyDescriptor(this.blackCubeArrayView);
                this.destroyDescriptor(this.shadowMapView);
                this.destroyDescriptor(this.shadowMapAttachment);
                this.destroyDescriptor(this.vertexBufferView);
                this.destroyDescriptor(this.instanceBufferView);
                for (const texture of this.solidTextures) {
                    texture.destroy();
                }
                this.destroyTexture(this.shadowMapTexture);
                this.destroyTexture(this.cubeColor);
                this.destroyTexture(this.cubeDepth);
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.instanceBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.materialBuffer);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                for (const pipeline of this.pipelines) {
                    pipeline.destroy();
                }
                const blitPipeline = this.blitPipeline;
                if (blitPipeline) {
                    blitPipeline.destroy();
                }
                const layout = this.layout;
                if (layout) {
                    layout.destroy();
                }
                const blitLayout = this.blitLayout;
                if (blitLayout) {
                    blitLayout.destroy();
                }
                this.frameFence.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            const scene = this.scene;
            if (scene) {
                scene.destroy();
            }
            this.sample.destroy();
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
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const rendering = new ThreadedRendering(sample);
        // --scene <path>: relative to the executable's directory; -noThreads: the faces recorded one
        // after another from the start.
        sample.addExampleOptionWithValues("--scene", 1);
        sample.addExampleOption("-noThreads");
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "--scene" && i + 1 < argc) {
                rendering.scenePath = Nri.getArg(argc, argv, i + 1);
            } else if (arg == "-noThreads") {
                rendering.useThreads = false;
            }
        }
        return rendering.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return ThreadedRenderingNri.main(argc, argv);
}

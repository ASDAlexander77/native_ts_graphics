/// <reference path="../../core/nri/nri_interop.d.ts" />
import { DonutFirstPersonCamera } from "../../core/donut_first_person_camera";
import { DonutSceneTextures } from "../../core/nri_donut_textures";

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
        faceAllocators: NriCommandAllocatorHandle[] = [];
        faceCommandBuffers: NriCommandBufferHandle[] = [];
        constructor(public commandAllocator: NriCommandAllocatorHandle, public beforeFaces: NriCommandBufferHandle,
            public commandBuffer: NriCommandBufferHandle, public viewSets: NriDescriptorSetHandle[],
            public viewConstantsViews: NriDescriptorHandle[]) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
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
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private width: int = 0;
        private height: int = 0;
        private test: boolean = false;
        scenePath: string = DEFAULT_SCENE;

        // The scene: its buffers (vertices, instances, the index buffer, the materials' constants),
        // views, textures; its draws.
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
        // The draws as a draw list (pipeline slots 0, back faces culled, and 1, none), and a face's
        // draw pass each.
        private drawList: NriDrawListHandle | null = null;
        private facePasses: NriDrawPassHandle[] = [];
        // Space toggles; -noThreads starts without.
        useThreads: boolean = true;

        // The cube map (Donut_CreateCubemapTarget's: sRGB color, D32 depth, six layers) and a face's
        // views: attachments, and the slice the blit reads.
        private cubeColor: NriTextureHandle | null = null;
        private cubeDepth: NriTextureHandle | null = null;
        private faceColorAttachments: NriDescriptorHandle[] = [];
        private faceDepthAttachments: NriDescriptorHandle[] = [];
        private faceViews: NriDescriptorHandle[] = [];
        private faceBlitSets: NriDescriptorSetHandle[] = [];

        // Donut's CommonRenderPasses fallbacks the forward pass binds for the inputs it isn't given:
        // black, a black cubemap array, a depth texture array (the shadow maps', cleared once); their
        // views.
        private solidTextures: NriTextureHandle[] = [];
        private blackView: NriDescriptorHandle | null = null;
        private blackCubeArrayView: NriDescriptorHandle | null = null;
        private shadowMapTexture: NriTextureHandle | null = null;
        private shadowMapView: NriDescriptorHandle | null = null;
        private shadowMapAttachment: NriDescriptorHandle | null = null;
        private shadowMapCleared: boolean = false;

        // The forward pass's layout, its pipelines (back faces culled, or none for double-sided
        // materials; front faces clockwise, or counterclockwise in a mirrored view),
        // its shading set (the light constants, the fallbacks, the samplers); the blit's.
        private layout: NriPipelineLayoutHandle | null = null;
        private pipelines: NriPipelineHandle[] = [];
        private shadingSet: NriDescriptorSetHandle | null = null;
        private lightConstantsView: NriDescriptorHandle | null = null;
        private blitLayout: NriPipelineLayoutHandle | null = null;
        private blitPipeline: NriPipelineHandle | null = null;
        // CommonRenderPasses' anisotropic wrap, linear wrap and linear clamp samplers, the forward
        // pass's shadow sampler (border).
        private samplers: NriDescriptorHandle[] = [];
        private constantBuffer: NriBufferHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
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
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
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
            Nri_SetInitializeCallback(this.sample, initialize);
            Nri_SetLatencySleepCallback(this.sample, latencySleep);
            Nri_SetRenderFrameCallback(this.sample, renderFrame);
            Nri_SetWindowSize(this.sample, WINDOW_WIDTH, WINDOW_HEIGHT);

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
            // As the Donut example.
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                console.log("The Threaded Rendering example does not support D3D11.");
                return 0;
            }
            const device = Nri_CreateDevice(this.sample, graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri_GetGraphicsAPIString(graphicsAPI)} (${Nri_GetAdapterName(device)})`);

            this.queue = Nri_GetGraphicsQueue(device);
            this.frameFence = Nri_CreateFence(device, 0);
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.test = Nri_IsTest(this.sample) != 0;

            // Swap chain: blitted into through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, queuedFrameNum + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            const viewFormat = Nri_GetSrgbFormat(format);
            this.viewFormat = viewFormat;
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(this.swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, viewFormat),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }

            const folder = graphicsAPI == NriGraphicsAPI.VK ? "spirv" : "dxil";
            if (!this.loadScene(device, folder) || !this.createTargets(device) || !this.createPipelines(device, folder)
                || !this.createDescriptorSets(device, queuedFrameNum) || !this.createFacePasses()) {
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

        // The scene, as Donut's engine loads it: its buffers, its textures (their mip chains blitted
        // in the first frame), the materials' constants; the draws InstancedOpaqueDrawStrategy makes
        // of it (opaque and alpha-tested materials), sorted by material as it sorts them.
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
                for (let instance = 0; instance < instanceCount; instance++) {
                    const geometryCount = Nri_GetDonutSceneInstanceGeometryCount(scene, instance);
                    for (let geometry = 0; geometry < geometryCount; geometry++) {
                        const material = Nri_GetDonutSceneGeometryMaterial(scene, instance, geometry);
                        if (material != drawnMaterial) {
                            continue;
                        }
                        const domain = Nri_GetDonutSceneMaterialDomain(scene, material);
                        if (domain != DOMAIN_OPAQUE && domain != DOMAIN_ALPHA_TESTED) {
                            continue;
                        }
                        const words = [instance, Nri_GetDonutSceneGeometryFirstVertex(scene, instance, geometry),
                            streams[0], streams[1], streams[2], streams[3]];
                        const pushConstants: f32[] = [];
                        for (let k = 0; k < PUSH_CONSTANT_WORDS; k++) {
                            pushConstants.push(0.0);
                            Nri_StoreInt32(Ref(pushConstants[k]), words[k]);
                        }
                        this.drawItems.push(new DrawItem(instance, material, Nri_GetDonutSceneMaterialDoubleSided(scene, material) != 0,
                            Nri_GetDonutSceneGeometryIndexCount(scene, instance, geometry),
                            Nri_GetDonutSceneGeometryFirstIndex(scene, instance, geometry), pushConstants));
                    }
                }
            }

            return this.textures.load(device, this.queue, scene, folder);
        }

        // The cube map, a face's views; the fallback textures.
        createTargets(device: NriDeviceHandle) {
            const cubeColor = Nri_CreateLayeredRenderTargetTexture(device, this.queue, CUBEMAP_RESOLUTION, CUBEMAP_RESOLUTION, NUM_FACES,
                NriFormat.RGBA8_SRGB);
            const cubeDepth = Nri_CreateLayeredDepthTexture(device, this.queue, CUBEMAP_RESOLUTION, CUBEMAP_RESOLUTION, NUM_FACES,
                NriFormat.D32_SFLOAT);
            this.cubeColor = cubeColor;
            this.cubeDepth = cubeDepth;
            if (!cubeColor || !cubeDepth) {
                console.log("Cannot create the cube map");
                return false;
            }
            for (let face = 0; face < NUM_FACES; face++) {
                this.faceColorAttachments.push(Nri_CreateColorAttachmentLayerView(cubeColor, NriFormat.RGBA8_SRGB, face));
                this.faceDepthAttachments.push(Nri_CreateDepthAttachmentLayerView(cubeDepth, NriFormat.D32_SFLOAT, face));
                this.faceViews.push(Nri_CreateTextureArrayLayerView(cubeColor, NriFormat.RGBA8_SRGB, face));
            }

            const black = Nri_CreateSolidTexture(device, this.queue, 1, 0xFF000000, NriTextureState.ShaderResource);
            const blackCubes = Nri_CreateSolidTexture(device, this.queue, 6, 0xFF000000, NriTextureState.ShaderResource);
            const shadowMapTexture = Nri_CreateSampledDepthTexture(device, this.queue, 1, 1, NriFormat.D16_UNORM);
            this.shadowMapTexture = shadowMapTexture;
            if (!black || !blackCubes || !shadowMapTexture) {
                console.log("Cannot create the default textures");
                return false;
            }
            this.solidTextures.push(black);
            this.solidTextures.push(blackCubes);
            this.blackView = Nri_CreateTextureView(black, NriFormat.RGBA8_UNORM);
            this.blackCubeArrayView = Nri_CreateTextureCubeArrayView(blackCubes, NriFormat.RGBA8_UNORM);
            this.shadowMapView = Nri_CreateTextureArrayView(shadowMapTexture, NriFormat.D16_UNORM);
            this.shadowMapAttachment = Nri_CreateDepthAttachmentView(shadowMapTexture, NriFormat.D16_UNORM);
            return true;
        }

        // The forward pass's layout (Donut's register spaces: 0 the material, 1 the inputs as root
        // constants and descriptors, 2 the view, 3 the shading) and pipelines (forward_vs's buffer
        // loads, forward_ps without transmission; front faces clockwise, depth tested greater or
        // equal and written: reverse depth); Donut's slice blit (blit_ps with texture arrays).
        createPipelines(device: NriDeviceHandle, folder: string) {
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 7, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 1, 2, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescSetRegisterSpace(layoutDesc, 1, 2);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 2, 3, 1, NriDescriptorType.ConstantBuffer, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 2, 20, 4, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 2, 0, 4, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescSetRegisterSpace(layoutDesc, 2, 3);
            Nri_PipelineLayoutDescSetRootRegisterSpace(layoutDesc, 1);
            Nri_PipelineLayoutDescAddRootConstants(layoutDesc, 1, PUSH_CONSTANT_WORDS * 4, NriStage.Vertex);
            Nri_PipelineLayoutDescAddRootDescriptor(layoutDesc, 10, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            Nri_PipelineLayoutDescAddRootDescriptor(layoutDesc, 11, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            const layout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            this.layout = layout;

            const blitDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(blitDesc, 0, BLIT_CONSTANTS.length * 4, NriStage.Vertex);
            Nri_PipelineLayoutDescAddRange(blitDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(blitDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const blitLayout = Nri_CreatePipelineLayoutFromDesc(device, blitDesc);
            Nri_DestroyPipelineLayoutDesc(blitDesc);
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
                const desc = Nri_CreatePipelineDesc();
                let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${framework}/passes/forward_vs_buffer_loads.bin`,
                    "buffer_loads") != 0;
                if (loaded) {
                    loaded = Nri_PipelineDescAddShaderPermutation(desc, NriShaderStage.Pixel, `${framework}/passes/forward_ps.bin`, "main",
                        "TRANSMISSIVE_MATERIAL=0") != 0;
                }
                Nri_PipelineDescSetCullMode(desc, cullMode);
                Nri_PipelineDescSetFrontCounterClockwise(desc, key >> 1);
                Nri_PipelineDescSetColor(desc, NriFormat.RGBA8_SRGB, NriColorWrite.RGBA);
                Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.GreaterEqual, 1, 0);
                const pipeline = loaded ? Nri_CreatePipelineFromDesc(device, layout, desc) : null;
                Nri_DestroyPipelineDesc(desc);
                if (!pipeline) {
                    console.log("Cannot load the forward shading shaders");
                    return false;
                }
                this.pipelines.push(pipeline);
            }

            const blitPipelineDesc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(blitPipelineDesc, NriShaderStage.Vertex, `${framework}/rect_vs.bin`, "main") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShaderPermutation(blitPipelineDesc, NriShaderStage.Pixel, `${framework}/blit_ps.bin`, "main",
                    "TEXTURE_ARRAY=1") != 0;
            }
            Nri_PipelineDescSetTopology(blitPipelineDesc, NriTopology.TriangleStrip);
            Nri_PipelineDescSetColor(blitPipelineDesc, this.viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.blitPipeline = Nri_CreatePipelineFromDesc(device, blitLayout, blitPipelineDesc);
            }
            Nri_DestroyPipelineDesc(blitPipelineDesc);
            if (!this.blitPipeline) {
                console.log("Cannot load Donut's blit shaders");
                return false;
            }
            return true;
        }

        // The samplers, the constant buffer (the light constants, then a queued frame's six faces'
        // view constants each), the sets: a material's each, the shading set, a queued frame's six
        // view sets, a face blit's each, the texture blits'.
        createDescriptorSets(device: NriDeviceHandle, queuedFrameNum: int) {
            const scene = this.scene;
            const layout = this.layout;
            const blitLayout = this.blitLayout;
            const materialBuffer = this.materialBuffer;
            if (!scene || !layout || !blitLayout || !materialBuffer) {
                return false;
            }
            this.samplers.push(Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.Repeat, 16));
            this.samplers.push(Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.ClampToBorder, 1));
            this.samplers.push(Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.Repeat, 1));
            this.samplers.push(Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.ClampToEdge, 1));

            this.viewConstantsSize = Nri_GetDonutConstantsSize(0);
            for (let i = 0; i < this.viewConstantsSize / 4; i++) {
                this.viewConstants.push(0.0);
            }
            const lightConstantsSize = Nri_GetDonutConstantsSize(4);
            this.viewStride = Math.floor((this.viewConstantsSize + CONSTANTS_ALIGNMENT - 1) / CONSTANTS_ALIGNMENT) * CONSTANTS_ALIGNMENT;
            this.lightStride = Math.floor((lightConstantsSize + CONSTANTS_ALIGNMENT - 1) / CONSTANTS_ALIGNMENT) * CONSTANTS_ALIGNMENT;
            const constantBuffer = Nri_CreateHostBuffer(device, this.lightStride + queuedFrameNum * NUM_FACES * this.viewStride,
                NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;

            const materialCount = Nri_GetDonutSceneMaterialCount(scene);
            const blitCount = this.textures.blitSetCount();
            const setNum = materialCount + 1 + queuedFrameNum * NUM_FACES + NUM_FACES + blitCount;
            const descriptorPool = Nri_CreateDescriptorPool(device, setNum, 4 + NUM_FACES + blitCount,
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
            Nri_FillDonutForwardLightConstants(AMBIENT_TOP, AMBIENT_TOP, AMBIENT_TOP, AMBIENT_BOTTOM, AMBIENT_BOTTOM, AMBIENT_BOTTOM,
                Ref(lightConstants[0]));
            Nri_WriteBuffer(constantBuffer, 0, Ref(lightConstants[0]), lightConstantsSize);
            this.lightConstantsView = Nri_CreateConstantBufferView(constantBuffer, 0, this.lightStride);

            // A material's: its constants, its textures (black for the slots it doesn't use).
            for (let m = 0; m < materialCount; m++) {
                const set = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
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

            // The shading set: ForwardShadingPass::CreateShadingBindingSet's, with CommonRenderPasses'
            // fallbacks.
            const shadingSet = Nri_AllocateDescriptorSet(descriptorPool, layout, 2, 0);
            const lightConstantsView = this.lightConstantsView;
            this.shadingSet = shadingSet;
            if (!shadingSet || !lightConstantsView) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            Nri_UpdateDescriptor(shadingSet, 0, 0, lightConstantsView);
            Nri_UpdateDescriptor(shadingSet, 1, 0, shadowMapView);
            Nri_UpdateDescriptor(shadingSet, 1, 1, blackCubeArrayView);
            Nri_UpdateDescriptor(shadingSet, 1, 2, blackCubeArrayView);
            Nri_UpdateDescriptor(shadingSet, 1, 3, blackView);
            const shadingSamplers = [this.samplers[0], this.samplers[1], this.samplers[2], this.samplers[3]];
            for (let k = 0; k < 4; k++) {
                Nri_UpdateDescriptor(shadingSet, 2, k, shadingSamplers[k]);
            }

            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const viewSets: NriDescriptorSetHandle[] = [];
                const views: NriDescriptorHandle[] = [];
                for (let face = 0; face < NUM_FACES; face++) {
                    const set = Nri_AllocateDescriptorSet(descriptorPool, layout, 1, 0);
                    const view = Nri_CreateConstantBufferView(constantBuffer, this.viewOffset(i, face), this.viewStride);
                    if (!set || !view) {
                        console.log("Cannot create the descriptor sets");
                        return false;
                    }
                    Nri_UpdateDescriptor(set, 0, 0, view);
                    viewSets.push(set);
                    views.push(view);
                }
                const queuedFrame = new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator),
                    Nri_CreateCommandBuffer(commandAllocator), viewSets, views);
                for (let face = 0; face < NUM_FACES; face++) {
                    const faceAllocator = Nri_CreateCommandAllocator(this.queue);
                    queuedFrame.faceAllocators.push(faceAllocator);
                    queuedFrame.faceCommandBuffers.push(Nri_CreateCommandBuffer(faceAllocator));
                }
                this.queuedFrames.push(queuedFrame);
            }

            for (let face = 0; face < NUM_FACES; face++) {
                const set = Nri_AllocateDescriptorSet(descriptorPool, blitLayout, 0, 0);
                if (!set) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                Nri_UpdateDescriptor(set, 0, 0, this.faceViews[face]);
                Nri_UpdateDescriptor(set, 1, 0, this.samplers[3]);
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
            const drawList = Nri_CreateDrawList();
            this.drawList = drawList;
            let slot = -1;
            let material = -1;
            for (const item of this.drawItems) {
                const itemSlot = item.doubleSided ? 1 : 0;
                if (itemSlot != slot) {
                    Nri_DrawListSetPipeline(drawList, itemSlot);
                    slot = itemSlot;
                }
                if (item.material != material) {
                    Nri_DrawListSetDescriptorSet(drawList, 0, this.materialSets[item.material]);
                    material = item.material;
                }
                Nri_DrawListSetRootConstants(drawList, 0, Ref(item.pushConstants[0]), PUSH_CONSTANT_WORDS * 4);
                Nri_DrawListDrawIndexed(drawList, item.indexCount, 1, item.firstIndex, 0, 0);
            }
            for (let face = 0; face < NUM_FACES; face++) {
                const pass = Nri_CreateDrawPass(drawList, this.faceColorAttachments[face], this.faceDepthAttachments[face],
                    CUBEMAP_RESOLUTION, CUBEMAP_RESOLUTION, layout, descriptorPool);
                Nri_DrawPassSetDescriptorSet(pass, 2, shadingSet);
                Nri_DrawPassSetRootDescriptor(pass, 0, instanceBufferView);
                Nri_DrawPassSetRootDescriptor(pass, 1, vertexBufferView);
                Nri_DrawPassSetIndexBuffer(pass, indexBuffer);
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
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
            for (const faceAllocator of queuedFrame.faceAllocators) {
                Nri_ResetCommandAllocator(faceAllocator);
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
                this.camera.animate(this.sample, Nri_GetFrameTime(this.sample), true);
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
                Nri_FillDonutCubemapFaceViewConstants(Ref(this.viewMatrix[0]), Z_NEAR, CUBEMAP_RESOLUTION, face, Ref(this.viewConstants[0]));
                Nri_WriteBuffer(constantBuffer, this.viewOffset(queuedFrameIndex, face), Ref(this.viewConstants[0]), this.viewConstantsSize);
            }
        }

        // The shadow map fallback, cleared once (D3D12 wants depth textures initialized before
        // shaders read them).
        clearShadowMap(commandBuffer: NriCommandBufferHandle) {
            const texture = this.shadowMapTexture;
            const attachment = this.shadowMapAttachment;
            if (this.shadowMapCleared || !texture || !attachment) {
                return;
            }
            Nri_CmdTextureBarrier(commandBuffer, texture, NriTextureState.ShaderResource, NriTextureState.DepthAttachment);
            Nri_CmdBeginRenderingDepthOnly(commandBuffer, attachment);
            Nri_CmdClearDepth(commandBuffer, 0.0);
            Nri_CmdEndRendering(commandBuffer);
            Nri_CmdTextureBarrier(commandBuffer, texture, NriTextureState.DepthAttachment, NriTextureState.ShaderResource);
            this.shadowMapCleared = true;
        }

        // The faces unfolded over the swap chain texture (between Nri_CmdBeginRendering and
        // Nri_CmdEndRendering): Donut's blit of each slice into its square.
        recordBlits(commandBuffer: NriCommandBufferHandle) {
            const blitLayout = this.blitLayout;
            const blitPipeline = this.blitPipeline;
            if (!blitLayout || !blitPipeline) {
                return;
            }
            const faceSize = Math.min(Math.floor(this.width / 4), Math.floor(this.height / 3));
            Nri_CmdSetPipelineLayout(commandBuffer, blitLayout);
            Nri_CmdSetPipeline(commandBuffer, blitPipeline);
            for (let face = 0; face < NUM_FACES; face++) {
                const x = g_FaceLayout[face * 2] * faceSize;
                const y = g_FaceLayout[face * 2 + 1] * faceSize;
                Nri_CmdSetViewport(commandBuffer, x, y, faceSize, faceSize);
                Nri_CmdSetScissor(commandBuffer, x, y, faceSize, faceSize);
                Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.blitConstants[0]), BLIT_CONSTANTS.length * 4);
                Nri_CmdSetDescriptorSet(commandBuffer, 0, this.faceBlitSets[face]);
                Nri_CmdDraw(commandBuffer, 4, 1, 0, 0);
            }
        }

        // The faces' passes record the scene into the queued frame's faces' command buffers, as seen by
        // its faces' views, with the pipelines of the views' front faces: on worker threads, or one
        // after another.
        recordFaces(queuedFrame: QueuedFrame) {
            for (let face = 0; face < NUM_FACES; face++) {
                const pass = this.facePasses[face];
                Nri_DrawPassSetDescriptorSet(pass, 1, queuedFrame.viewSets[face]);
                Nri_DrawPassSetPipeline(pass, 0, this.pipelines[this.mirrored ? 2 : 0]);
                Nri_DrawPassSetPipeline(pass, 1, this.pipelines[this.mirrored ? 3 : 1]);
                if (this.useThreads) {
                    Nri_RecordDrawPassAsync(pass, queuedFrame.faceCommandBuffers[face]);
                } else {
                    Nri_RecordDrawPass(pass, queuedFrame.faceCommandBuffers[face]);
                }
            }
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (Nri_IsKeyToggled(this.sample, NriKey.Space) != 0) {
                this.useThreads = !this.useThreads;
                Nri_SetWindowTitle(this.sample, `${WINDOW_TITLE} ${this.useThreads ? "(With threads)" : "(No threads)"}`);
            }
            this.writeConstants(queuedFrameIndex);

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                this.recordAndSubmit(frameIndex, queuedFrame, this.swapChainTextures[index], acquireSemaphore);
            }

            // Signaled after the present, as NRISamples do
            Nri_QueueSignal(this.queue, this.frameFence, 1 + frameIndex);
        }

        // Records the frame into the queued frame's command buffer, submits it and presents.
        recordAndSubmit(frameIndex: int, queuedFrame: QueuedFrame, swapChainTexture: SwapChainTexture, acquireSemaphore: NriFenceHandle) {
            const descriptorPool = this.descriptorPool;
            const cubeColor = this.cubeColor;
            if (!descriptorPool || !cubeColor) {
                return;
            }
            // The faces, on their threads; meanwhile, before them: the mip chains and the fallback (the
            // first frame), the cube map's barrier; after them: their blits.
            this.recordFaces(queuedFrame);
            const beforeFaces = queuedFrame.beforeFaces;
            Nri_BeginCommandBuffer(beforeFaces);
            Nri_CmdSetDescriptorPool(beforeFaces, descriptorPool);
            this.textures.recordBlits(beforeFaces);
            this.clearShadowMap(beforeFaces);
            Nri_CmdTextureBarrier(beforeFaces, cubeColor, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            Nri_EndCommandBuffer(beforeFaces);

            const commandBuffer = queuedFrame.commandBuffer;
            Nri_BeginCommandBuffer(commandBuffer);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdTextureBarrier(commandBuffer, cubeColor, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
            Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
            Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
            Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
            this.recordBlits(commandBuffer);
            Nri_CmdEndRendering(commandBuffer);

            // The test's last frame: read back
            let presentFrom = NriTextureState.ColorAttachment;
            const readbackBuffer = this.readbackBuffer;
            if (readbackBuffer) {
                if (frameIndex == TEST_FRAMES - 1) {
                    Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                    Nri_CmdReadbackTextureToBuffer(commandBuffer, readbackBuffer, this.rowPitch, swapChainTexture.texture, this.width, this.height);
                    presentFrom = NriTextureState.CopySource;
                }
            }
            Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, presentFrom, NriTextureState.Present);
            Nri_EndCommandBuffer(commandBuffer);

            // Submit (once the faces are recorded) and present
            for (const pass of this.facePasses) {
                Nri_WaitDrawPass(pass);
            }
            Nri_QueueSubmitCommandBuffer(this.queue, beforeFaces);
            for (const faceCommandBuffer of queuedFrame.faceCommandBuffers) {
                Nri_QueueSubmitCommandBuffer(this.queue, faceCommandBuffer);
            }
            Nri_QueueSubmit(this.queue, commandBuffer, acquireSemaphore, swapChainTexture.releaseSemaphore);
            Nri_QueuePresent(this.swapChain, swapChainTexture.releaseSemaphore);
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
                for (const pass of this.facePasses) {
                    Nri_DestroyDrawPass(pass);
                }
                const drawList = this.drawList;
                if (drawList) {
                    Nri_DestroyDrawList(drawList);
                }
                Nri_DeviceWaitIdle(device);
                for (const queuedFrame of this.queuedFrames) {
                    for (let face = 0; face < queuedFrame.faceCommandBuffers.length; face++) {
                        Nri_DestroyCommandBuffer(queuedFrame.faceCommandBuffers[face]);
                        Nri_DestroyCommandAllocator(queuedFrame.faceAllocators[face]);
                    }
                    Nri_DestroyCommandBuffer(queuedFrame.beforeFaces);
                    Nri_DestroyCommandBuffer(queuedFrame.commandBuffer);
                    Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
                    for (const view of queuedFrame.viewConstantsViews) {
                        Nri_DestroyDescriptor(view);
                    }
                }
                for (const swapChainTexture of this.swapChainTextures) {
                    Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                    Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                    Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                this.textures.destroy();
                for (const view of this.materialViews) {
                    Nri_DestroyDescriptor(view);
                }
                for (const sampler of this.samplers) {
                    Nri_DestroyDescriptor(sampler);
                }
                for (let face = 0; face < this.faceViews.length; face++) {
                    Nri_DestroyDescriptor(this.faceColorAttachments[face]);
                    Nri_DestroyDescriptor(this.faceDepthAttachments[face]);
                    Nri_DestroyDescriptor(this.faceViews[face]);
                }
                this.destroyDescriptor(this.lightConstantsView);
                this.destroyDescriptor(this.blackView);
                this.destroyDescriptor(this.blackCubeArrayView);
                this.destroyDescriptor(this.shadowMapView);
                this.destroyDescriptor(this.shadowMapAttachment);
                this.destroyDescriptor(this.vertexBufferView);
                this.destroyDescriptor(this.instanceBufferView);
                for (const texture of this.solidTextures) {
                    Nri_DestroyTexture(texture);
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
                    Nri_DestroyPipeline(pipeline);
                }
                const blitPipeline = this.blitPipeline;
                if (blitPipeline) {
                    Nri_DestroyPipeline(blitPipeline);
                }
                const layout = this.layout;
                if (layout) {
                    Nri_DestroyPipelineLayout(layout);
                }
                const blitLayout = this.blitLayout;
                if (blitLayout) {
                    Nri_DestroyPipelineLayout(blitLayout);
                }
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            const scene = this.scene;
            if (scene) {
                Nri_DestroyDonutScene(scene);
            }
            Nri_DestroySample(this.sample);
        }

        destroyDescriptor(descriptor: NriDescriptorHandle | null) {
            if (descriptor) {
                Nri_DestroyDescriptor(descriptor);
            }
        }

        destroyTexture(texture: NriTextureHandle | null) {
            if (texture) {
                Nri_DestroyTexture(texture);
            }
        }

        destroyBuffer(buffer: NriBufferHandle | null) {
            if (buffer) {
                Nri_DestroyBuffer(buffer);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const rendering = new ThreadedRendering(sample);
        // --scene <path>: relative to the executable's directory; -noThreads: the faces recorded one
        // after another from the start.
        Nri_AddExampleOptionWithValues(sample, "--scene", 1);
        Nri_AddExampleOption(sample, "-noThreads");
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "--scene" && i + 1 < argc) {
                rendering.scenePath = Nri_GetArg(argc, argv, i + 1);
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

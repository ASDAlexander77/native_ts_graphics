/// <reference path="../../core/nri/nri_interop.d.ts" />
import { perspProjReverse, radiansF32 } from "../../core/matrix";
import { DonutFirstPersonCamera } from "../../core/donut_first_person_camera";

namespace TerrainTessellationNri {
    // terrain_tessellation, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead
    // of Donut and NVRHI: the same shaders (terrain_tessellation.hlsl's, and Donut's blit shaders),
    // through the NRI calls core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws, with
    // NRIFramework's ImGui for the sample's settings window. This example creates everything it
    // runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Terrain Tessellation";

    // The sample's KTX textures, converted to DDS at build time (see VULKAN_SAMPLES_ASSETS_DIR in
    // CMakeLists.txt).
    const HEIGHTMAP_PATH = "media/terrain_tessellation/terrain_heightmap_r16.dds";
    const TERRAIN_LAYERS_PATH = "media/terrain_tessellation/terrain_texturearray_rgba.dds";
    const SKY_PATH = "media/terrain_tessellation/skysphere_rgba.dds";

    // main_vs in terrain_tessellation.hlsl: (64 - 1)^2 quad patches of 4 vertices.
    const PATCH_SIZE = 64;
    const PATCH_VERTICES = 4;
    const TERRAIN_VERTICES = (PATCH_SIZE - 1) * (PATCH_SIZE - 1) * PATCH_VERTICES;

    // struct TerrainConstants, as f32 offsets (HLSL packing).
    const CONST_WORLD_TO_VIEW = 0;
    const CONST_VIEW_TO_CLIP = 16;
    const CONST_VIEW_TO_WORLD = 32;
    const CONST_LIGHT_POS = 48;
    const CONST_FRUSTUM_PLANES = 52;
    const CONST_DISPLACEMENT_FACTOR = 76;
    const CONST_TESSELLATION_FACTOR = 77;
    const CONST_VIEWPORT_DIM = 78;
    const CONST_TESSELLATED_EDGE_SIZE = 80;
    // Padded to 16 bytes; a queued frame's each CONST_STRIDE bytes apart (D3D12 constant buffer
    // views' size is a multiple of 256).
    const CONST_FLOATS = 84;
    const CONST_STRIDE = 512;

    // Donut's blit (CommonRenderPasses::BlitTexture) of the color buffer into the swap chain
    // texture: struct BlitConstants { float2 sourceOrigin, sourceSize, targetOrigin, targetSize;
    // float sharpenFactor; }.
    const BLIT_CONSTANT_FLOATS = 9;

    // The sample's camera: reversed depth from 0.1 to 512.
    const Z_NEAR = 0.1;
    const Z_FAR = 512.0;
    const DISPLACEMENT_FACTOR = 32.0;

    // Donut's FirstPersonCamera's speeds, at 7.5 units a second as the Donut example sets them.
    const MOVE_SPEED = 7.5;
    const ROTATE_SPEED = 0.005;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into: its command buffer, and the descriptor set with its
    // constants.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public constantBufferView: NriDescriptorHandle | null, public descriptorSet: NriDescriptorSetHandle | null) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does: the tessellated terrain
    // under the sky fills it (95% or more of the pixels lit), the top left corner the blue sky.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const sky = pixels[0];
        if (((sky >> 16) & 0xFF) < (sky & 0xFF) + 20) {
            return "the top left corner isn't the sky";
        }
        let dark = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            if ((p & 0xFF) <= 20 && ((p >> 8) & 0xFF) <= 20 && ((p >> 16) & 0xFF) <= 20) {
                dark++;
            }
        }
        const total = width * height;
        const lit = 100.0 * (total - dark) / total;
        console.log(`Lit: ${lit}% (${total - dark} of ${total} pixels)`);
        if (lit < 95.0) {
            return `Lit: ${lit}% of the pixels, not 95% to 100%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' terrain_tessellation (as examples/terrain_tessellation.ts ports it) to
    // NRI: a terrain of quad patches, tessellated by the hull shader according to their size on
    // screen (and culled against the view frustum), displaced by a heightmap in the domain shader,
    // and textured by height from a texture array, under a sky sphere; rendered into an RGBA8 color
    // buffer, then blitted into the sRGB swap chain texture with Donut's blit shaders, as the Donut
    // example does.
    class TerrainTessellation {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private camera: DonutFirstPersonCamera = new DonutFirstPersonCamera(MOVE_SPEED, ROTATE_SPEED);

        private terrainLayout: NriPipelineLayoutHandle | null = null;
        private terrainPipeline: NriPipelineHandle | null = null;
        private wireframePipeline: NriPipelineHandle | null = null;
        private skyPipeline: NriPipelineHandle | null = null;
        private blitLayout: NriPipelineLayoutHandle | null = null;
        private blitPipeline: NriPipelineHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private heightmap: NriTextureHandle | null = null;
        private terrainLayers: NriTextureHandle | null = null;
        private sky: NriTextureHandle | null = null;
        private views: NriDescriptorHandle[] = [];
        private samplers: NriDescriptorHandle[] = [];
        private colorBuffer: NriTextureHandle | null = null;
        private colorAttachment: NriDescriptorHandle | null = null;
        private colorView: NriDescriptorHandle | null = null;
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private blitSet: NriDescriptorSetHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        // The TerrainConstants contents, and the blit's.
        private constants: f32[] = [];
        private blitConstants: f32[] = [0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0];

        // The sample's settings; -noUI: no settings window.
        tessellation: boolean = true;
        tessellationFactor: number = 0.75;
        wireframe: boolean = false;
        noUI: boolean = false;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
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
            this.frameFence = Nri_CreateFence(device, 0);
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.test = Nri_IsTest(this.sample) != 0;

            // Swap chain: blitted into through sRGB views, as the Donut example's sRGB back buffer.
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

            // The textures, as the sample (vkb) loads KTX 1 files: color as sRGB, the heightmap as is.
            this.heightmap = Nri_LoadDdsTexture(device, this.queue, HEIGHTMAP_PATH, 0);
            this.terrainLayers = Nri_LoadDdsTexture(device, this.queue, TERRAIN_LAYERS_PATH, 1);
            this.sky = Nri_LoadDdsTexture(device, this.queue, SKY_PATH, 1);
            const heightmap = this.heightmap;
            const terrainLayers = this.terrainLayers;
            const sky = this.sky;
            if (!heightmap || !terrainLayers || !sky) {
                console.log("Cannot load the terrain textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            this.views.push(Nri_CreateTextureView(heightmap, Nri_GetTextureFormat(heightmap)));
            this.views.push(Nri_CreateTextureArrayView(terrainLayers, Nri_GetTextureFormat(terrainLayers)));
            this.views.push(Nri_CreateTextureView(sky, Nri_GetTextureFormat(sky)));

            // The sample's samplers (Donut's common ones): linear and clamped for the heightmap,
            // anisotropic and repeating for the terrain layers, linear and repeating for the sky.
            const linearClamp = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            const anisotropicWrap = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.Repeat,
                Math.min(16, Nri_GetMaxSamplerAnisotropy(device)));
            const linearWrap = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.Repeat, 1);
            if (!linearClamp || !anisotropicWrap || !linearWrap) {
                console.log("Cannot create the samplers");
                return 0;
            }
            this.samplers.push(linearClamp);
            this.samplers.push(anisotropicWrap);
            this.samplers.push(linearWrap);

            // The color buffer (RGBA8, as the Donut example's) and the depth buffer, the swap chain's
            // size.
            const colorBuffer = Nri_CreateRenderTargetTexture(device, this.queue, this.width, this.height, NriFormat.RGBA8_UNORM);
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.colorBuffer = colorBuffer;
            this.depthTexture = depthTexture;
            if (!colorBuffer || !depthTexture) {
                console.log("Cannot create the color and depth buffers");
                return 0;
            }
            this.colorAttachment = Nri_CreateColorAttachmentView(colorBuffer, NriFormat.RGBA8_UNORM);
            this.colorView = Nri_CreateTextureView(colorBuffer, NriFormat.RGBA8_UNORM);
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            // The layouts: the terrain's (and the sky's) constants (b0), textures (t0 to t2) and
            // samplers (s0 to s2) for every stage; the blit's constants (b0) and its source (t0, s0).
            const terrainLayoutDesc = Nri_CreatePipelineLayoutDesc();
            const stages = NriStage.VertexTessellationPixel;
            Nri_PipelineLayoutDescAddRange(terrainLayoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, stages, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(terrainLayoutDesc, 0, 0, 3, NriDescriptorType.Texture, stages, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(terrainLayoutDesc, 0, 0, 3, NriDescriptorType.Sampler, stages, NriRangeFlags.None);
            this.terrainLayout = Nri_CreatePipelineLayoutFromDesc(device, terrainLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(terrainLayoutDesc);
            const blitLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(blitLayoutDesc, 0, BLIT_CONSTANT_FLOATS * 4, NriStage.Vertex);
            Nri_PipelineLayoutDescAddRange(blitLayoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(blitLayoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.blitLayout = Nri_CreatePipelineLayoutFromDesc(device, blitLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(blitLayoutDesc);
            const terrainLayout = this.terrainLayout;
            const blitLayout = this.blitLayout;
            if (!terrainLayout || !blitLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: terrain_tessellation.hlsl's shaders, as compiled for the Donut example;
            // Donut's blit shaders (rect_vs, blit_ps), as Donut compiles them.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            const shaders = `shaders/terrain_tessellation/${folder}/terrain_tessellation`;
            this.terrainPipeline = this.createTerrainPipeline(device, terrainLayout, shaders, 0);
            this.wireframePipeline = this.createTerrainPipeline(device, terrainLayout, shaders, 1);
            this.skyPipeline = this.createSkyPipeline(device, terrainLayout, shaders);
            this.blitPipeline = this.createBlitPipeline(device, blitLayout, `shaders/framework/${folder}`);
            if (!this.terrainPipeline || !this.wireframePipeline || !this.skyPipeline || !this.blitPipeline) {
                console.log("Cannot load the terrain tessellation shaders");
                return 0;
            }

            // The constants (a queued frame's each), the descriptor sets (a queued frame's each, and
            // the blit's).
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * CONST_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = Nri_CreateDescriptorPool(device, queuedFrameNum + 1, 3 * queuedFrameNum + 1, queuedFrameNum,
                3 * queuedFrameNum + 1, 0, 0);
            this.descriptorPool = descriptorPool;
            const colorView = this.colorView;
            if (!constantBuffer || !descriptorPool || !colorView) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const constantBufferView = Nri_CreateConstantBufferView(constantBuffer, i * CONST_STRIDE, CONST_STRIDE);
                const descriptorSet = Nri_AllocateDescriptorSet(descriptorPool, terrainLayout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), constantBufferView,
                    descriptorSet));
                if (!constantBufferView || !descriptorSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(descriptorSet, 0, 0, constantBufferView);
                for (let k = 0; k < 3; k++) {
                    Nri_UpdateDescriptor(descriptorSet, 1, k, this.views[k]);
                    Nri_UpdateDescriptor(descriptorSet, 2, k, this.samplers[k]);
                }
            }
            const blitSet = Nri_AllocateDescriptorSet(descriptorPool, blitLayout, 0, 0);
            this.blitSet = blitSet;
            if (!blitSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            Nri_UpdateDescriptor(blitSet, 0, 0, colorView);
            Nri_UpdateDescriptor(blitSet, 1, 0, linearClamp);

            // The sample's first person camera at (18, 22.5, 57.5), rotated (-12, 159) degrees: in
            // Donut's world (see updateConstants), at (18, 22.5, -57.5) looking down the direction below.
            this.camera.lookAt(18.0, 22.5, -57.5, 18.0 - 0.3505, 22.5 - 0.2079, -57.5 + 0.9132);

            // The sample's settings window.
            if (!this.noUI) {
                if (Nri_InitImgui(this.sample, device) == 0) {
                    console.log("Cannot initialize the user interface");
                    return 0;
                }
                this.imgui = true;
            }

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The terrain pipeline: quad patches, reversed depth (greater passes), back faces culled.
        createTerrainPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, shaders: string, wireframe: int) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_main_vs.bin`, "main_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Hull, `${shaders}_main_hs.bin`, "main_hs") != 0;
            }
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Domain, `${shaders}_main_ds.bin`, "main_ds") != 0;
            }
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_main_ps.bin`, "main_ps") != 0;
            }
            Nri_PipelineDescSetTopology(desc, NriTopology.PatchList);
            Nri_PipelineDescSetPatchControlPoints(desc, PATCH_VERTICES);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            Nri_PipelineDescSetWireframe(desc, wireframe);
            Nri_PipelineDescSetColor(desc, NriFormat.RGBA8_UNORM, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // The sky: a full screen triangle behind everything, without depth.
        createSkyPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, shaders: string) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_sky_vs.bin`, "sky_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_sky_ps.bin`, "sky_ps") != 0;
            }
            Nri_PipelineDescSetColor(desc, NriFormat.RGBA8_UNORM, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.None, 0, 0);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // Donut's blit pipeline: rect_vs's quad (a triangle strip), blit_ps without texture arrays,
        // no culling, no depth.
        createBlitPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, framework: string) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${framework}/rect_vs.bin`, "main") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShaderPermutation(desc, NriShaderStage.Pixel, `${framework}/blit_ps.bin`, "main",
                    "TEXTURE_ARRAY=0") != 0;
            }
            Nri_PipelineDescSetTopology(desc, NriTopology.TriangleStrip);
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The sample's settings window.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Settings", 1);
            this.tessellation = Nri_ImguiCheckbox("Tessellation", this.tessellation ? 1 : 0) != 0;
            this.tessellationFactor = Nri_ImguiDragFloat("Factor", this.tessellationFactor, 0.05, 0.0, 4.0);
            this.wireframe = Nri_ImguiCheckbox("Wireframe", this.wireframe ? 1 : 0) != 0;
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The sample's update_uniform_buffers.
        updateConstants(width: int, height: int) {
            const c = this.constants;

            // The sample's world has the terrain rising towards -y and, rendered by Vulkan without a
            // flipped viewport, -y up on the screen. Rotating it half a turn around z (x and y
            // negated) gives Donut's world, y up, with the same picture.
            const donutWorldToView = this.camera.worldToView();
            for (let i = 0; i < 16; i++) {
                const row = Math.floor(i / 4);
                c[CONST_WORLD_TO_VIEW + i] = row < 2 ? -donutWorldToView[i] : donutWorldToView[i];
            }

            const projection = perspProjReverse(radiansF32(60.0), width / height, Z_NEAR, Z_FAR);
            for (let i = 0; i < 16; i++) {
                c[CONST_VIEW_TO_CLIP + i] = projection[i];
            }

            // The rotation's inverse: its transpose.
            for (let row = 0; row < 4; row++) {
                for (let column = 0; column < 4; column++) {
                    c[CONST_VIEW_TO_WORLD + row * 4 + column] = row < 3 && column < 3
                        ? c[CONST_WORLD_TO_VIEW + column * 4 + row] : (row == column ? 1.0 : 0.0);
                }
            }

            c[CONST_LIGHT_POS + 0] = -48.0;
            c[CONST_LIGHT_POS + 1] = -0.5 - DISPLACEMENT_FACTOR;
            c[CONST_LIGHT_POS + 2] = 46.0;
            c[CONST_LIGHT_POS + 3] = 0.0;

            // The frustum planes (vkb::Frustum) of world to clip space, as row vectors times matrix:
            // each plane is a combination of the matrix's columns.
            const worldToClip: number[] = [];
            for (let row = 0; row < 4; row++) {
                for (let column = 0; column < 4; column++) {
                    let sum = 0.0;
                    for (let k = 0; k < 4; k++) {
                        sum += c[CONST_WORLD_TO_VIEW + row * 4 + k] * c[CONST_VIEW_TO_CLIP + k * 4 + column];
                    }
                    worldToClip.push(sum);
                }
            }
            // Left, right (x), bottom, top (y), far (z >= 0, reversed depth) and near (z <= w).
            const columnA = [3, 3, 3, 3, 2, 3];
            const columnB = [0, 0, 1, 1, -1, 2];
            const signB = [1.0, -1.0, 1.0, -1.0, 0.0, -1.0];
            for (let plane = 0; plane < 6; plane++) {
                const p = CONST_FRUSTUM_PLANES + plane * 4;
                for (let k = 0; k < 4; k++) {
                    let value = worldToClip[k * 4 + columnA[plane]];
                    if (columnB[plane] >= 0) {
                        value += signB[plane] * worldToClip[k * 4 + columnB[plane]];
                    }
                    c[p + k] = value;
                }
                const length = Math.sqrt(c[p] * c[p] + c[p + 1] * c[p + 1] + c[p + 2] * c[p + 2]);
                for (let k = 0; k < 4; k++) {
                    c[p + k] = c[p + k] / length;
                }
            }

            c[CONST_DISPLACEMENT_FACTOR] = DISPLACEMENT_FACTOR;
            // Zero sets all tessellation factors to 1 in the hull shader.
            c[CONST_TESSELLATION_FACTOR] = this.tessellation ? this.tessellationFactor : 0.0;
            c[CONST_VIEWPORT_DIM + 0] = width;
            c[CONST_VIEWPORT_DIM + 1] = height;
            // Desired size of tessellated quad patch edge
            c[CONST_TESSELLATED_EDGE_SIZE] = 20.0;
        }

        // The sky, then the terrain, into the color buffer (between Nri_CmdBeginRenderingWithDepth and
        // Nri_CmdEndRendering).
        recordScene(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const terrainLayout = this.terrainLayout;
            const skyPipeline = this.skyPipeline;
            const terrainPipeline = this.wireframe ? this.wireframePipeline : this.terrainPipeline;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = queuedFrame.descriptorSet;
            if (!terrainLayout || !skyPipeline || !terrainPipeline || !descriptorPool || !descriptorSet) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, terrainLayout);

            // Skysphere
            Nri_CmdSetPipeline(commandBuffer, skyPipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, descriptorSet);
            Nri_CmdDraw(commandBuffer, 3, 1, 0, 0);

            // Terrain
            Nri_CmdSetPipeline(commandBuffer, terrainPipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, descriptorSet);
            Nri_CmdDraw(commandBuffer, TERRAIN_VERTICES, 1, 0, 0);
        }

        // The color buffer over the whole swap chain texture (between Nri_CmdBeginRendering and
        // Nri_CmdEndRendering), as Donut's BlitTexture draws it.
        recordBlit(commandBuffer: NriCommandBufferHandle) {
            const blitLayout = this.blitLayout;
            const blitPipeline = this.blitPipeline;
            const descriptorPool = this.descriptorPool;
            const blitSet = this.blitSet;
            if (!blitLayout || !blitPipeline || !descriptorPool || !blitSet) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, blitLayout);
            Nri_CmdSetPipeline(commandBuffer, blitPipeline);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.blitConstants[0]), BLIT_CONSTANT_FLOATS * 4);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, blitSet);
            Nri_CmdDraw(commandBuffer, 4, 1, 0, 0);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            if (!this.test) {
                this.camera.animate(this.sample, Nri_GetFrameTime(this.sample), Nri_ImguiWantsMouse() == 0);
            }
            this.updateConstants(this.width, this.height);
            const constantBuffer = this.constantBuffer;
            if (constantBuffer) {
                Nri_WriteBuffer(constantBuffer, queuedFrameIndex * CONST_STRIDE, Ref(this.constants[0]), CONST_FLOATS * 4);
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const colorBuffer = this.colorBuffer;
            const colorAttachment = this.colorAttachment;
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the scene into the color buffer (the depth cleared to 0, the far plane of
                // reversed depth), the color buffer blitted into the swap chain texture, the settings
                // window over it.
                Nri_BeginCommandBuffer(commandBuffer);
                if (colorBuffer) {
                    Nri_CmdTextureBarrier(commandBuffer, colorBuffer, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
                    if (colorAttachment) {
                        if (depthAttachment) {
                            Nri_CmdBeginRenderingWithDepth(commandBuffer, colorAttachment, depthAttachment);
                            Nri_CmdClearDepth(commandBuffer, 0.0);
                            this.recordScene(commandBuffer, queuedFrame);
                            Nri_CmdEndRendering(commandBuffer);
                        }
                    }
                    Nri_CmdTextureBarrier(commandBuffer, colorBuffer, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
                }
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                this.recordBlit(commandBuffer);
                if (this.imgui) {
                    Nri_CmdDrawImgui(this.sample, commandBuffer, this.viewFormat);
                }
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

                // Submit and present
                Nri_QueueSubmit(this.queue, commandBuffer, acquireSemaphore, swapChainTexture.releaseSemaphore);
                if (this.imgui) {
                    Nri_ImguiEndFrame(this.sample);
                }
                Nri_QueuePresent(this.swapChain, swapChainTexture.releaseSemaphore);
            }

            // Signaled after the present, as NRISamples do
            Nri_QueueSignal(this.queue, this.frameFence, 1 + frameIndex);
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
                if (this.imgui) {
                    Nri_DestroyImgui(this.sample);
                }
                for (const queuedFrame of this.queuedFrames) {
                    Nri_DestroyCommandBuffer(queuedFrame.commandBuffer);
                    Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
                    this.destroyDescriptor(queuedFrame.constantBufferView);
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
                for (const view of this.views) {
                    Nri_DestroyDescriptor(view);
                }
                for (const sampler of this.samplers) {
                    Nri_DestroyDescriptor(sampler);
                }
                this.destroyDescriptor(this.colorAttachment);
                this.destroyDescriptor(this.colorView);
                this.destroyDescriptor(this.depthAttachment);
                this.destroyTexture(this.heightmap);
                this.destroyTexture(this.terrainLayers);
                this.destroyTexture(this.sky);
                this.destroyTexture(this.colorBuffer);
                this.destroyTexture(this.depthTexture);
                const constantBuffer = this.constantBuffer;
                if (constantBuffer) {
                    Nri_DestroyBuffer(constantBuffer);
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
                }
                this.destroyPipeline(this.terrainPipeline);
                this.destroyPipeline(this.wireframePipeline);
                this.destroyPipeline(this.skyPipeline);
                this.destroyPipeline(this.blitPipeline);
                this.destroyLayout(this.terrainLayout);
                this.destroyLayout(this.blitLayout);
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
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

        destroyPipeline(pipeline: NriPipelineHandle | null) {
            if (pipeline) {
                Nri_DestroyPipeline(pipeline);
            }
        }

        destroyLayout(layout: NriPipelineLayoutHandle | null) {
            if (layout) {
                Nri_DestroyPipelineLayout(layout);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const terrain = new TerrainTessellation(sample);
        // -noUI: no settings window.
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-noUI") {
                terrain.noUI = true;
            }
        }
        return terrain.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return TerrainTessellationNri.main(argc, argv);
}

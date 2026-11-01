/// <reference path="../../core/nri/nri_interop.d.ts" />
import { multiply, rotation, translation, scale, radians, samplePerspective } from "../../core/matrix";

namespace OitDepthPeelingNri {
    // oit_depth_peeling, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (oit_depth_peeling.hlsl's), model (read as Donut's
    // loadGltfMesh reads it) and background, through the NRI calls core/nri/nri_interop.d.ts binds,
    // with NRIFramework's ImGui for the sample's overlay. This example creates everything it runs,
    // and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: OIT Depth Peeling";

    // The sample's model and background (Vulkan-Samples' assets), the KTX texture converted to DDS
    // at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const OBJECT_PATH = "media/oit_depth_peeling/torusknot.gltf";
    const BACKGROUND_PATH = "media/oit_depth_peeling/vulkan_logo_full.dds";

    // Nri_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;
    const TEXCOORD_OFFSET = 24;

    // The layers peeled at most, and the depth targets taking turns.
    const LAYER_MAX_COUNT = 8;
    const DEPTH_COUNT = 2;

    // struct SceneConstants { float4x4 model_view_projection; float background_grayscale,
    // object_alpha; int front_layer_index, back_layer_index; }, as f32 offsets; a queued frame's in
    // a 256-byte slice of the constant buffer (D3D12 constant buffer views' alignment).
    const CONST_MVP = 0;
    const CONST_BACKGROUND_GRAYSCALE = 16;
    const CONST_OBJECT_ALPHA = 17;
    const CONST_FRONT_LAYER_INDEX = 18;
    const CONST_BACK_LAYER_INDEX = 19;
    const CONST_FLOATS = 20;
    const CONST_STRIDE = 256;

    // The sample's camera: a "look at" camera at (0, 0, -4), 60 degrees vertically, reversed depth
    // from 16 to 0.1 (glm::perspective with near and far swapped); the model scaled by 0.08.
    const CAMERA_POSITION = [0.0, 0.0, -4.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 16.0;
    const Z_FAR = 0.1;
    const MODEL_SCALE = 0.08;
    // Degrees per second about x and y, with auto-rotation on.
    const AUTO_ROTATION_SPEED = 5.0;
    // ApiVulkanSample's mouse controls: degrees per pixel dragged with the left button, zoom per
    // pixel with the right one, panning per pixel with the middle one.
    const ROTATION_SPEED = 1.0;
    const ZOOM_SPEED = 0.005;
    const PAN_SPEED = 0.01;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into: its command buffer, its descriptor sets (the gather
    // passes', one per depth target drawn into, reading the other; the background and combine
    // passes') and the view of its slice of the constants.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public gatherSets: NriDescriptorSetHandle[], public combineSet: NriDescriptorSetHandle | null,
            public constantBufferView: NriDescriptorHandle | null) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // A render target and its views: rendered into (a layer's color, a depth target's depth) and
    // read by shaders.
    class Target {
        constructor(public texture: NriTextureHandle, public attachment: NriDescriptorHandle, public shaderResource: NriDescriptorHandle) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does: the corners are the gray
    // background; the translucent tori, blended in depth-peeled layers, color about half the frame.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != 0x959595) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 149, 149, 149`;
            }
        }
        let colored = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            const high = Math.max(r, Math.max(g, b));
            const low = Math.min(r, Math.min(g, b));
            if (high - low >= 61) {
                colored++;
            }
        }
        const total = width * height;
        const percent = 100.0 * colored / total;
        console.log(`Colored: ${percent}% (${colored} of ${total} pixels)`);
        if (percent < 40.0 || percent > 60.0) {
            return `Colored: ${percent}% of the pixels, not 40% to 60%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' oit_depth_peeling (as examples/oit_depth_peeling.ts ports it) to NRI:
    // order-independent transparency by depth peeling (Cass Everitt's): a transparent torus knot is
    // drawn up to 8 times, each gather pass keeping the nearest fragments behind the layer the pass
    // before kept (its depth target, read as a texture), into a layer texture of its own; a combine
    // pass blends the layers back to front over the background. Drawn straight into the sRGB swap
    // chain view, where the Donut example draws into an sRGB color buffer and blits it.
    class OitDepthPeeling {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private gatherLayout: NriPipelineLayoutHandle | null = null;
        private combineLayout: NriPipelineLayoutHandle | null = null;
        private gatherFirstPipeline: NriPipelineHandle | null = null;
        private gatherPipeline: NriPipelineHandle | null = null;
        private backgroundPipeline: NriPipelineHandle | null = null;
        private combinePipeline: NriPipelineHandle | null = null;
        private object: NriGltfMeshHandle | null = null;
        private background: NriTextureHandle | null = null;
        private backgroundView: NriDescriptorHandle | null = null;
        private pointSampler: NriDescriptorHandle | null = null;
        private anisotropicSampler: NriDescriptorHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        // The layers and the depth targets, for the window's size.
        private layers: Target[] = [];
        private depths: Target[] = [];
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        // The sample's camera: rotation (degrees about x, y, z) and position; the mouse as it last
        // saw it.
        private cameraRotation: number[] = [0.0, 0.0, 0.0];
        private cameraPosition: number[] = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
        private buttons: boolean[] = [false, false, false];
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;

        // The sample's settings (-rotate, -grayscale <value>, -alpha <value>, -layers <front>
        // <back>); -noUI: no overlay.
        cameraAutoRotation: boolean = false;
        backgroundGrayscale: number = 0.3;
        objectAlpha: number = 0.5;
        frontLayerIndex: int = 0;
        backLayerIndex: int = LAYER_MAX_COUNT - 1;
        noUI: boolean = false;

        private constants: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        // Whether the layers and the depth targets have been cleared once (initializeTargets).
        private targetsInitialized: boolean = false;
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

            // Swap chain: rendered through sRGB views, as the sample's sRGB color buffer (which the
            // Donut example blits into its back buffer).
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

            // The model and the background (KTX 1 files have no color space: the framework takes
            // color textures as sRGB).
            this.object = Nri_LoadGltfMesh(device, this.queue, OBJECT_PATH);
            const background = Nri_LoadDdsTexture(device, this.queue, BACKGROUND_PATH, 1);
            this.background = background;
            if (!this.object || !background) {
                console.log("Cannot load the model and the texture: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const backgroundView = Nri_CreateTextureView(background, NriFormat.RGBA8_SRGB);
            this.backgroundView = backgroundView;
            // Donut's PointClamp, for the layers; its AnisotropicWrap (trilinear, the device's
            // maximum anisotropy), for the background.
            const pointSampler = Nri_CreateSamplerWithMipFilter(device, NriFilter.Nearest, NriFilter.Nearest, NriAddressMode.ClampToEdge, 1);
            const anisotropicSampler = Nri_CreateSamplerWithMipFilter(device, NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat,
                Nri_GetMaxSamplerAnisotropy(device));
            this.pointSampler = pointSampler;
            this.anisotropicSampler = anisotropicSampler;

            // The gather passes: the constants and the other depth target. The background and
            // combine passes: the constants, the background texture and its sampler, the layers and
            // their sampler.
            const gatherLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(gatherLayoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(gatherLayoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.VertexPixel, NriRangeFlags.None);
            this.gatherLayout = Nri_CreatePipelineLayoutFromDesc(device, gatherLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(gatherLayoutDesc);

            const combineLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(combineLayoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(combineLayoutDesc, 0, 1, 1, NriDescriptorType.Texture, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(combineLayoutDesc, 0, 1, 1, NriDescriptorType.Sampler, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(combineLayoutDesc, 0, 2, LAYER_MAX_COUNT, NriDescriptorType.Texture, NriStage.VertexPixel,
                NriRangeFlags.Array);
            Nri_PipelineLayoutDescAddRange(combineLayoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.VertexPixel, NriRangeFlags.None);
            this.combineLayout = Nri_CreatePipelineLayoutFromDesc(device, combineLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(combineLayoutDesc);

            const gatherLayout = this.gatherLayout;
            const combineLayout = this.combineLayout;
            if (!gatherLayout || !combineLayout || !pointSampler || !anisotropicSampler) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The sample's pipelines: oit_depth_peeling.hlsl's shaders, as compiled for the Donut
            // example. The gather passes: no culling, reversed depth (greater passes), written. The
            // background, then the layers combined and alpha blended over it (Donut's AlphaBlend:
            // color source alpha over, alpha inverse source alpha and zero; the sample's alpha
            // factors are One and Zero; the color target's alpha isn't shown).
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            const shaders = `shaders/oit_depth_peeling/${folder}/oit_depth_peeling`;
            this.gatherFirstPipeline = this.createGatherPipeline(device, gatherLayout, shaders, "gather_first_ps");
            this.gatherPipeline = this.createGatherPipeline(device, gatherLayout, shaders, "gather_ps");
            this.backgroundPipeline = this.createFullscreenPipeline(device, combineLayout, shaders, "background_ps", false);
            this.combinePipeline = this.createFullscreenPipeline(device, combineLayout, shaders, "combine_ps", true);
            if (!this.gatherFirstPipeline || !this.gatherPipeline || !this.backgroundPipeline || !this.combinePipeline) {
                console.log("Cannot load the oit depth peeling shaders");
                return 0;
            }

            // The sample's create_sized_objects: the layers and the depth targets, read by shaders
            // (both left as shader resources between the passes).
            for (let i = 0; i < LAYER_MAX_COUNT; i++) {
                const layer = Nri_CreateRenderTargetTexture(device, this.queue, this.width, this.height, NriFormat.RGBA8_UNORM);
                if (!layer) {
                    console.log("Cannot create the layers");
                    return 0;
                }
                this.layers.push(new Target(layer, Nri_CreateColorAttachmentView(layer, NriFormat.RGBA8_UNORM),
                    Nri_CreateTextureView(layer, NriFormat.RGBA8_UNORM)));
            }
            for (let i = 0; i < DEPTH_COUNT; i++) {
                const depth = Nri_CreateSampledDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
                if (!depth) {
                    console.log("Cannot create the depth targets");
                    return 0;
                }
                this.depths.push(new Target(depth, Nri_CreateDepthAttachmentView(depth, NriFormat.D32_SFLOAT),
                    Nri_CreateTextureView(depth, NriFormat.D32_SFLOAT)));
            }

            // The constants, a queued frame's each; a queued frame's descriptor sets.
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * CONST_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const setNum = DEPTH_COUNT + 1;
            const descriptorPool = Nri_CreateDescriptorPool(device, setNum * queuedFrameNum, 2 * queuedFrameNum, setNum * queuedFrameNum,
                (DEPTH_COUNT + 1 + LAYER_MAX_COUNT) * queuedFrameNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool) {
                console.log("Cannot create the constant buffer");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const constantBufferView = Nri_CreateConstantBufferView(constantBuffer, i * CONST_STRIDE, CONST_STRIDE);
                const gatherSets: NriDescriptorSetHandle[] = [];
                const combineSet = Nri_AllocateDescriptorSet(descriptorPool, combineLayout, 0, 0);
                const queuedFrame = new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), gatherSets, combineSet,
                    constantBufferView);
                this.queuedFrames.push(queuedFrame);
                if (!constantBufferView || !combineSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                // The pass drawing into depth target d reads the other one.
                for (let d = 0; d < DEPTH_COUNT; d++) {
                    const gatherSet = Nri_AllocateDescriptorSet(descriptorPool, gatherLayout, 0, 0);
                    if (!gatherSet) {
                        console.log("Cannot create the descriptor sets");
                        return 0;
                    }
                    Nri_UpdateDescriptor(gatherSet, 0, 0, constantBufferView);
                    Nri_UpdateDescriptor(gatherSet, 1, 0, this.depths[(d + 1) % DEPTH_COUNT].shaderResource);
                    gatherSets.push(gatherSet);
                }
                Nri_UpdateDescriptor(combineSet, 0, 0, constantBufferView);
                Nri_UpdateDescriptor(combineSet, 1, 0, backgroundView);
                Nri_UpdateDescriptor(combineSet, 2, 0, anisotropicSampler);
                for (let l = 0; l < LAYER_MAX_COUNT; l++) {
                    Nri_UpdateDescriptor(combineSet, 3, l, this.layers[l].shaderResource);
                }
                Nri_UpdateDescriptor(combineSet, 4, 0, pointSampler);
            }

            // The sample's overlay.
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

        // A gather pass's pipeline (gather_vs and the pixel shader ps): positions and texture
        // coordinates, into a layer (RGBA8) and a depth target (greater passes, written).
        createGatherPipeline(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle, shaders: string, ps: string) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_gather_vs.bin`, "gather_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_${ps}.bin`, ps) != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "TEXCOORD", NriFormat.RG32_SFLOAT, TEXCOORD_OFFSET);
            Nri_PipelineDescSetColor(desc, NriFormat.RGBA8_UNORM, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, pipelineLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // A fullscreen pass's pipeline (fullscreen_vs and the pixel shader ps) into the swap chain
        // view: blended (AlphaBlend) or not; no depth.
        createFullscreenPipeline(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle, shaders: string, ps: string,
            blend: boolean) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_fullscreen_vs.bin`, "fullscreen_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_${ps}.bin`, ps) != 0;
            }
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            if (blend) {
                Nri_PipelineDescSetBlend(desc, NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha, NriBlendOp.Add,
                    NriBlendFactor.OneMinusSrcAlpha, NriBlendFactor.Zero, NriBlendOp.Add);
            }
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, pipelineLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // Waits for the frame that last used this frame's command allocator (and its UBO slice).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // ApiVulkanSample's mouse handling, unless the overlay has the mouse: dragging with the left
        // button rotates the camera, with the right one zooms, with the middle one pans.
        handleMouse() {
            const overlay = this.imgui && Nri_ImguiWantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = Nri_IsButtonPressed(this.sample, button) != 0;
                if (!pressed || !overlay) {
                    this.buttons[button] = pressed;
                }
            }
            const x = Nri_GetMouseX(this.sample);
            const y = Nri_GetMouseY(this.sample);
            const dx = this.mouseX - x;
            const dy = this.mouseY - y;
            if (this.buttons[0]) {
                this.cameraRotation[0] += dy * ROTATION_SPEED;
                this.cameraRotation[1] -= dx * ROTATION_SPEED;
            }
            if (this.buttons[1]) {
                this.cameraPosition[2] += dy * ZOOM_SPEED;
            }
            if (this.buttons[2]) {
                this.cameraPosition[0] -= dx * PAN_SPEED;
                this.cameraPosition[1] -= dy * PAN_SPEED;
            }
            this.mouseX = x;
            this.mouseY = y;
        }

        // The camera's auto-rotation: the frame's time (Donut's test mode: a float's 1/60 second).
        animate() {
            if (!this.cameraAutoRotation) {
                return;
            }
            const elapsedSeconds = this.test ? Math.fround(1.0 / 60.0) : Nri_GetFrameTime(this.sample);
            this.cameraRotation[0] += elapsedSeconds * AUTO_ROTATION_SPEED;
            this.cameraRotation[1] += elapsedSeconds * AUTO_ROTATION_SPEED;
        }

        // The sample's overlay (its title, ApiVulkanSample's default).
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Vulkan Example", 1);
            this.cameraAutoRotation = Nri_ImguiCheckbox("Camera auto-rotation", this.cameraAutoRotation ? 1 : 0) != 0;
            this.backgroundGrayscale = Nri_ImguiSliderFloat("Background grayscale", this.backgroundGrayscale, 0.0, 1.0);
            this.objectAlpha = Nri_ImguiSliderFloat("Object opacity", this.objectAlpha, 0.0, 1.0);
            this.frontLayerIndex = Nri_ImguiSliderInt("Front layer index", this.frontLayerIndex, 0, this.backLayerIndex);
            this.backLayerIndex = Nri_ImguiSliderInt("Back layer index", this.backLayerIndex, this.frontLayerIndex, LAYER_MAX_COUNT - 1);
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The sample's update_scene_constants, into this frame's slice.
        updateConstants(constantBuffer: NriBufferHandle, offset: int) {
            const c = this.constants;
            const projection = samplePerspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            // A "look at" camera: translation * rotation (about x, then y, then z).
            const r = this.cameraRotation;
            let rotationMatrix = multiply(rotation(radians(r[0]), 1.0, 0.0, 0.0), rotation(radians(r[1]), 0.0, 1.0, 0.0));
            rotationMatrix = multiply(rotationMatrix, rotation(radians(r[2]), 0.0, 0.0, 1.0));
            const p = this.cameraPosition;
            const view = multiply(translation(p[0], p[1], p[2]), rotationMatrix);
            const mvp = multiply(multiply(projection, view), scale(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE));
            for (let i = 0; i < 16; i++) {
                c[CONST_MVP + i] = mvp[i];
            }
            c[CONST_BACKGROUND_GRAYSCALE] = this.backgroundGrayscale;
            c[CONST_OBJECT_ALPHA] = this.objectAlpha;
            Nri_StoreInt32(Ref(c[CONST_FRONT_LAYER_INDEX]), this.frontLayerIndex);
            Nri_StoreInt32(Ref(c[CONST_BACK_LAYER_INDEX]), this.backLayerIndex);
            Nri_WriteBuffer(constantBuffer, offset, Ref(c[0]), CONST_FLOATS * 4);
        }

        // Clears every layer and both depth targets, once: a gather pass binds the other depth target
        // and the combine pass all the layers before they're all rendered into, and D3D12 rejects
        // reading a render target or depth texture (not zeroed at creation) before a clear.
        initializeTargets(commandBuffer: NriCommandBufferHandle) {
            for (let l = 0; l < LAYER_MAX_COUNT; l++) {
                const layer = this.layers[l];
                const depth = this.depths[l % DEPTH_COUNT];
                Nri_CmdTextureBarrier(commandBuffer, layer.texture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
                Nri_CmdTextureBarrier(commandBuffer, depth.texture, NriTextureState.ShaderResource, NriTextureState.DepthAttachment);
                Nri_CmdBeginRenderingWithDepth(commandBuffer, layer.attachment, depth.attachment);
                Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
                Nri_CmdClearDepth(commandBuffer, 0.0);
                Nri_CmdEndRendering(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, layer.texture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
                Nri_CmdTextureBarrier(commandBuffer, depth.texture, NriTextureState.DepthAttachment, NriTextureState.ShaderResource);
            }
            this.targetsInitialized = true;
        }

        // Gather pass l: a single transparent layer into layer l's texture. The two depth targets
        // take turns: depth target l % 2 for the fixed-function depth test, the other one the
        // previous gather pass's result, read in the shader to discard the fragments of the
        // previous layers.
        recordGather(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame, l: int) {
            const gatherLayout = this.gatherLayout;
            const pipeline = l == 0 ? this.gatherFirstPipeline : this.gatherPipeline;
            const object = this.object;
            if (!gatherLayout || !pipeline || !object) {
                return;
            }
            const layer = this.layers[l];
            const depth = this.depths[l % DEPTH_COUNT];
            Nri_CmdTextureBarrier(commandBuffer, layer.texture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            Nri_CmdTextureBarrier(commandBuffer, depth.texture, NriTextureState.ShaderResource, NriTextureState.DepthAttachment);
            Nri_CmdBeginRenderingWithDepth(commandBuffer, layer.attachment, depth.attachment);
            Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
            Nri_CmdClearDepth(commandBuffer, 0.0);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, gatherLayout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, queuedFrame.gatherSets[l % DEPTH_COUNT]);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, Nri_GetGltfMeshVertexBuffer(object), 0, VERTEX_SIZE);
            Nri_CmdSetIndexBuffer(commandBuffer, Nri_GetGltfMeshIndexBuffer(object), 0, NriIndexType.UInt32);
            Nri_CmdDrawIndexed(commandBuffer, Nri_GetGltfMeshIndexCount(object), 1, 0, 0, 0);
            Nri_CmdEndRendering(commandBuffer);
            Nri_CmdTextureBarrier(commandBuffer, layer.texture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
            Nri_CmdTextureBarrier(commandBuffer, depth.texture, NriTextureState.DepthAttachment, NriTextureState.ShaderResource);
        }

        // A fullscreen triangle of the pipeline with the combine set (between Nri_CmdBeginRendering
        // and Nri_CmdEndRendering).
        drawFullscreen(commandBuffer: NriCommandBufferHandle, pipeline: NriPipelineHandle | null, combineSet: NriDescriptorSetHandle | null) {
            const combineLayout = this.combineLayout;
            if (!combineLayout || !pipeline || !combineSet) {
                return;
            }
            Nri_CmdSetPipelineLayout(commandBuffer, combineLayout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, combineSet);
            Nri_CmdDraw(commandBuffer, 3, 1, 0, 0);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();
            this.animate();

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                this.recordAndPresent(frameIndex, queuedFrame, queuedFrameIndex, this.swapChainTextures[index], acquireSemaphore);
            }

            // Signaled after the present, as NRISamples do
            Nri_QueueSignal(this.queue, this.frameFence, 1 + frameIndex);
        }

        // Records the frame into the swap chain texture, submits it and presents it.
        recordAndPresent(frameIndex: int, queuedFrame: QueuedFrame, queuedFrameIndex: int, swapChainTexture: SwapChainTexture,
            acquireSemaphore: NriFenceHandle) {
            const descriptorPool = this.descriptorPool;
            const constantBuffer = this.constantBuffer;
            if (!descriptorPool || !constantBuffer) {
                return;
            }
            const commandBuffer = queuedFrame.commandBuffer;
            this.updateConstants(constantBuffer, queuedFrameIndex * CONST_STRIDE);

            Nri_BeginCommandBuffer(commandBuffer);
            if (this.imgui) {
                Nri_CmdCopyImguiData(this.sample, commandBuffer);
            }
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            if (!this.targetsInitialized) {
                this.initializeTargets(commandBuffer);
            }

            // Gather passes: each renders a single transparent layer into a layer texture.
            for (let l = 0; l <= this.backLayerIndex; l++) {
                this.recordGather(commandBuffer, queuedFrame, l);
            }

            // Combine pass: the layers blended into the final transparent color, alpha blended over
            // the background; the overlay over them.
            Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
            Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
            Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            this.drawFullscreen(commandBuffer, this.backgroundPipeline, queuedFrame.combineSet);
            this.drawFullscreen(commandBuffer, this.combinePipeline, queuedFrame.combineSet);
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
                for (const target of this.layers) {
                    this.destroyTarget(target);
                }
                for (const target of this.depths) {
                    this.destroyTarget(target);
                }
                this.destroyDescriptor(this.backgroundView);
                this.destroyDescriptor(this.pointSampler);
                this.destroyDescriptor(this.anisotropicSampler);
                const background = this.background;
                if (background) {
                    Nri_DestroyTexture(background);
                }
                const object = this.object;
                if (object) {
                    Nri_DestroyGltfMesh(object);
                }
                const constantBuffer = this.constantBuffer;
                if (constantBuffer) {
                    Nri_DestroyBuffer(constantBuffer);
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
                }
                this.destroyPipeline(this.gatherFirstPipeline);
                this.destroyPipeline(this.gatherPipeline);
                this.destroyPipeline(this.backgroundPipeline);
                this.destroyPipeline(this.combinePipeline);
                this.destroyPipelineLayout(this.gatherLayout);
                this.destroyPipelineLayout(this.combineLayout);
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }

        destroyTarget(target: Target) {
            Nri_DestroyDescriptor(target.attachment);
            Nri_DestroyDescriptor(target.shaderResource);
            Nri_DestroyTexture(target.texture);
        }

        destroyDescriptor(descriptor: NriDescriptorHandle | null) {
            if (descriptor) {
                Nri_DestroyDescriptor(descriptor);
            }
        }

        destroyPipeline(pipeline: NriPipelineHandle | null) {
            if (pipeline) {
                Nri_DestroyPipeline(pipeline);
            }
        }

        destroyPipelineLayout(pipelineLayout: NriPipelineLayoutHandle | null) {
            if (pipelineLayout) {
                Nri_DestroyPipelineLayout(pipelineLayout);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const oit = new OitDepthPeeling(sample);
        // -layers <front> <back>: the layers combined (0..7); -alpha <value>, -grayscale <value>: the
        // object's opacity, the background's brightness; -rotate: start with the camera's
        // auto-rotation on; -noUI: no overlay.
        Nri_AddExampleOptionWithValues(sample, "-layers", 2);
        Nri_AddExampleOptionWithValues(sample, "-alpha", 1);
        Nri_AddExampleOptionWithValues(sample, "-grayscale", 1);
        Nri_AddExampleOption(sample, "-rotate");
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-rotate") {
                oit.cameraAutoRotation = true;
            } else if (arg == "-layers" && i + 2 < argc) {
                oit.backLayerIndex = Math.min(Math.max(parseInt(Nri_GetArg(argc, argv, i + 2)), 0), LAYER_MAX_COUNT - 1);
                oit.frontLayerIndex = Math.min(Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), 0), oit.backLayerIndex);
                i += 2;
            } else if (arg == "-alpha" && i + 1 < argc) {
                i++;
                oit.objectAlpha = parseFloat(Nri_GetArg(argc, argv, i));
            } else if (arg == "-grayscale" && i + 1 < argc) {
                i++;
                oit.backgroundGrayscale = parseFloat(Nri_GetArg(argc, argv, i));
            } else if (arg == "-noUI") {
                oit.noUI = true;
            }
        }
        return oit.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return OitDepthPeelingNri.main(argc, argv);
}

/// <reference path="../../core/nri/nri_interop.d.ts" />
import { radians, perspective } from "../../core/matrix";
import { FirstPersonCamera } from "../../core/vulkan_samples_camera";

namespace FragmentShadingRateDynamicNri {
    // fragment_shading_rate_dynamic, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework
    // instead of Donut and NVRHI: the same shaders (fragment_shading_rate_dynamic.hlsl's and
    // fragment_shading_rate_dynamic_compute.hlsl's), models (read as Donut's loadGltfMesh reads them)
    // and textures, through the NRI calls core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui
    // for the sample's overlay. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no variable rate shading with
    // shading rate attachments, or no shaders for the graphics API (D3D11).
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Dynamic Fragment Shading Rate";

    // The sample's models and textures (Vulkan-Samples' assets), the KTX textures converted to DDS
    // at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const MEDIA_DIR = "media/fragment_shading_rate_dynamic/";
    const SKYSPHERE_PATH = MEDIA_DIR + "geosphere.gltf";
    const SCENE_PATH = MEDIA_DIR + "textured_unit_cube.gltf";
    const SKYSPHERE_TEXTURE_PATH = MEDIA_DIR + "skysphere_rgba.dds";
    const SCENE_TEXTURE_PATH = MEDIA_DIR + "vulkan_logo_full.dds";

    // Nri_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // struct UBOScene { float4x4 projection, modelview, skysphere_modelview; int color_shading_rate; },
    // padded, as f32 offsets; a queued frame's in a 256-byte slice of the constant buffer (D3D12
    // constant buffer views' alignment).
    const UBO_PROJECTION = 0;
    const UBO_MODELVIEW = 16;
    const UBO_SKYSPHERE_MODELVIEW = 32;
    const UBO_COLOR_SHADING_RATE = 48;
    const UBO_FLOATS = 52;
    const UBO_STRIDE = 256;
    // The push constants (root constants at b1): float4 offset; int object_type.
    const PUSH_FLOATS = 5;
    const PUSH_SIZE = PUSH_FLOATS * 4;
    const OBJECT_SKYSPHERE = 0;
    const OBJECT_CUBE = 1;

    // The three cubes' offsets.
    const MESH_OFFSETS = [-2.5, 0.0, 0.0, 0.0, 0.0, 0.0, 2.5, 0.0, 0.0];

    // The sample's first person camera at (0, 0, -4) (the view's translation), a 60 degree vertical
    // field of view, depth reversed (near 256, far 0.1, as the sample passes them).
    const CAMERA_POSITION = [0.0, 0.0, -4.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // GLFW's key codes of the camera's keys (W, S, A, D: Donut's Key values).
    const CAMERA_KEYS = [87, 83, 65, 68];

    // The compute shader's 8 x 8 thread groups.
    const GROUP_SIZE = 8;

    // The compute shader's parameters (FrequencyInformation, uint2 pairs): 8 uints, then up to 16
    // rates.
    const PARAMS_INTS = 8 + 32;
    const PARAMS_STRIDE = 8;

    const SUBPASS_RATIOS = "1|2|4|8|16";
    const VISUALIZE_NAMES = "Render output|Shading Rates|Frequency channel";

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into: its command buffer, its UBO slice's view, and its
    // descriptor sets, one per swap chain texture (the UBO's slice, the textures and samplers, the
    // previous swap chain texture's frequency content).
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public constantBufferView: NriDescriptorHandle | null, public renderSets: NriDescriptorSetHandle[]) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // A swap chain texture's own targets, as the sample has per swap chain image: its shading rate
    // attachment (which the compute shader writes) and frequency content (a color attachment the
    // next frame's pixel shader reads, as a storage texture), their views, and the compute shader's
    // descriptor set.
    class Targets {
        constructor(public shadingRate: NriTextureHandle, public shadingRateAttachment: NriDescriptorHandle,
            public shadingRateStorage: NriDescriptorHandle, public frequency: NriTextureHandle,
            public frequencyAttachment: NriDescriptorHandle, public frequencyStorage: NriDescriptorHandle,
            public computeSet: NriDescriptorSetHandle | null) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does: the cubes with the Vulkan
    // logo over the sky, 8% to 18% of it red and 20% to 40% white.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        let red = 0;
        let white = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r >= 151 && g <= 89 && b <= 89) {
                red++;
            }
            if (r >= 221 && g >= 221 && b >= 221) {
                white++;
            }
        }
        const total = width * height;
        const redPercent = 100.0 * red / total;
        console.log(`Red: ${redPercent}% (${red} of ${total} pixels)`);
        if (redPercent < 8.0 || redPercent > 18.0) {
            return `Red: ${redPercent}% of the pixels, not 8% to 18%`;
        }
        const whitePercent = 100.0 * white / total;
        console.log(`White: ${whitePercent}% (${white} of ${total} pixels)`);
        if (whitePercent < 20.0 || whitePercent > 40.0) {
            return `White: ${whitePercent}% of the pixels, not 20% to 40%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' fragment_shading_rate_dynamic (as
    // examples/fragment_shading_rate_dynamic.ts ports it) to NRI: a sky sphere and three textured,
    // lit cubes drawn with a shading rate attachment that a compute shader makes each frame from the
    // scene's frequency content (each draw also writes its color's squared screen-space derivatives),
    // coarser rates where it's low. The frequency content comes from a second, reduced size pass at
    // the full rate in the corner of the targets, which the compute shader reads. Each swap chain
    // texture has its own shading rate attachment and frequency content: a frame uses the rates its
    // texture's previous frame made, and shows the frequency content of the frame before.
    //
    // The Donut example draws the reduced size pass into targets of its own and copies them into the
    // corners; this draws it straight into the corner (the same pixels: cleared there, the viewport
    // and scissor the corner), and its compute shader writes the shading rate attachment itself
    // instead of a copy of it. Drawn into the sRGB swap chain view, as the Donut example draws into
    // its back buffer; the overlay in a pass of its own (its pipeline has no shading rate). D3D12
    // (tier 2) or Vulkan (VK_KHR_fragment_shading_rate).
    class FragmentShadingRateDynamic {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private targets: Targets[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private renderLayout: NriPipelineLayoutHandle | null = null;
        private computeLayout: NriPipelineLayoutHandle | null = null;
        private skyspherePipeline: NriPipelineHandle | null = null;
        private cubePipeline: NriPipelineHandle | null = null;
        private computePipeline: NriPipelineHandle | null = null;
        private skysphereMesh: NriGltfMeshHandle | null = null;
        private sceneMesh: NriGltfMeshHandle | null = null;
        private skysphereTexture: NriTextureHandle | null = null;
        private skysphereTextureView: NriDescriptorHandle | null = null;
        private sceneTexture: NriTextureHandle | null = null;
        private sceneTextureView: NriDescriptorHandle | null = null;
        private sampler: NriDescriptorHandle | null = null;
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private paramsBuffer: NriBufferHandle | null = null;
        private paramsView: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";
        // Whether the frequency content has been cleared once (D3D12 wants render targets cleared
        // before shaders read them).
        private targetsInitialized: boolean = false;

        // The device's shading rates (width, height pairs, largest first), the shading rate
        // attachment's tile size and size.
        private rates: int[] = [];
        private rateCount: int = 0;
        private tileSize: int = 1;
        private shadingRateWidth: int = 0;
        private shadingRateHeight: int = 0;
        // The reduced size pass's size, for the ratio it was made for.
        private subpassWidth: int = 0;
        private subpassHeight: int = 0;
        private paramsRatio: int = 0;
        // The swap chain texture the frame before rendered into (-1 before the first frame): its
        // frequency content is the one shown. Vulkan's swap chain needn't hand its textures out in
        // order, so the one before the current isn't it.
        private previousIndex: int = -1;

        private camera: FirstPersonCamera = new FirstPersonCamera(CAMERA_POSITION, [0.0, 0.0, 0.0]);
        private buttons: boolean[] = [false, false, false];
        private keys: boolean[] = [false, false, false, false];

        // The sample's settings (-noattachment, -nosky, -ratio <1..16>, -visualize <0..2>); -noUI: no
        // overlay.
        enableAttachmentShadingRate: boolean = true;
        displaySkySphere: boolean = true;
        subpassExtentRatio: int = 4;
        colorShadingRate: int = 0;
        noUI: boolean = false;

        // Upload buffers: the UBO, the push constants, the compute shader's parameters.
        private ubo: f32[] = [];
        private push: f32[] = [];
        private params: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
            for (let i = 0; i < PUSH_FLOATS; i++) {
                this.push.push(0.0);
            }
            for (let i = 0; i < PARAMS_INTS; i++) {
                this.params.push(0.0);
            }
            for (let i = 0; i < 32; i++) {
                this.rates.push(0);
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
            if (this.unsupportedReason != "") {
                const test = Nri_IsTest(this.sample) != 0;
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

            // Swap chain: rendered through sRGB views, as the Donut example's sRGB back buffer.
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

            // SV_ShadingRate is shader model 6.4's (the Donut example's shaders: DXIL and SPIR-V).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (fragment_shading_rate_dynamic.hlsl needs shader model 6.4)";
                return 0;
            }
            if (Nri_IsFeatureSupported(device, NriFeature.VariableRateShading) == 0) {
                this.unsupportedReason = "The graphics device has no variable rate shading (D3D12 tier 2 or Vulkan's VK_KHR_fragment_shading_rate)";
                return 0;
            }
            this.rateCount = Nri_GetFragmentShadingRates(device, Ref(this.rates[0]));
            this.tileSize = Nri_GetShadingRateTileSize(device);
            if (this.rateCount == 0 || this.tileSize == 0) {
                this.unsupportedReason = "The graphics device has no variable rate shading with shading rate images";
                return 0;
            }

            // The models and textures, the textures as sRGB (as the framework loads KTX 1 color
            // textures).
            this.skysphereMesh = Nri_LoadGltfMesh(device, this.queue, SKYSPHERE_PATH);
            this.sceneMesh = Nri_LoadGltfMesh(device, this.queue, SCENE_PATH);
            const skysphereTexture = Nri_LoadDdsTexture(device, this.queue, SKYSPHERE_TEXTURE_PATH, 1);
            const sceneTexture = Nri_LoadDdsTexture(device, this.queue, SCENE_TEXTURE_PATH, 1);
            this.skysphereTexture = skysphereTexture;
            this.sceneTexture = sceneTexture;
            if (!this.modelsLoaded() || !skysphereTexture || !sceneTexture) {
                console.log("Cannot load the models and textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const skysphereTextureView = Nri_CreateTextureView(skysphereTexture, NriFormat.RGBA8_SRGB);
            const sceneTextureView = Nri_CreateTextureView(sceneTexture, NriFormat.RGBA8_SRGB);
            this.skysphereTextureView = skysphereTextureView;
            this.sceneTextureView = sceneTextureView;
            // ApiVulkanSample::load_texture's sampler: trilinear, repeating, anisotropic at the
            // device's most.
            const sampler = Nri_CreateSamplerWithMipFilter(device, NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat,
                Nri_GetMaxSamplerAnisotropy(device));
            this.sampler = sampler;

            // The layouts: the scene's descriptor set (the UBO at b0, the sky sphere's texture and
            // sampler at t0 and s0, the cubes' at t1 and s1, the previous frequency content at u0)
            // and push constants (b1: root constants); the compute shader's set (the frequency
            // content at u0, the shading rates at u1, the parameters at t0).
            const renderLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(renderLayoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(renderLayoutDesc, 0, 0, 2, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(renderLayoutDesc, 0, 0, 2, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(renderLayoutDesc, 0, 0, 1, NriDescriptorType.StorageTexture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRootConstants(renderLayoutDesc, 1, PUSH_SIZE, NriStage.VertexPixel);
            this.renderLayout = Nri_CreatePipelineLayoutFromDesc(device, renderLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(renderLayoutDesc);
            const computeLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(computeLayoutDesc, 0, 0, 2, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(computeLayoutDesc, 0, 0, 1, NriDescriptorType.StructuredBuffer, NriStage.Compute, NriRangeFlags.None);
            this.computeLayout = Nri_CreatePipelineLayoutFromDesc(device, computeLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(computeLayoutDesc);
            const renderLayout = this.renderLayout;
            const computeLayout = this.computeLayout;
            if (!renderLayout || !computeLayout || !sampler) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The sample's pipelines: the sky sphere without depth, back faces culled; the cubes
            // depth tested (greater: reversed) and written, front faces culled; counter-clockwise
            // front faces; into the color and the frequency content; their shading rates set with
            // each pass. The compute shader's.
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/fragment_shading_rate_dynamic/${folder}/fragment_shading_rate_dynamic`;
            this.skyspherePipeline = this.createPipeline(device, renderLayout, shaders, false);
            this.cubePipeline = this.createPipeline(device, renderLayout, shaders, true);
            this.computePipeline = Nri_CreateComputePipeline(device, computeLayout, `${shaders}_compute_generate_cs.bin`, "generate_cs");
            if (!this.skyspherePipeline || !this.cubePipeline || !this.computePipeline) {
                console.log("Cannot load the dynamic fragment shading rate shaders");
                return 0;
            }

            // The UBO, a queued frame's each; the compute shader's parameters.
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * UBO_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const paramsBuffer = Nri_CreateHostBufferWithStride(device, PARAMS_INTS * 4, NriBufferUsage.StructuredBuffer, PARAMS_STRIDE);
            this.paramsBuffer = paramsBuffer;
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!constantBuffer || !paramsBuffer || !depthTexture) {
                console.log("Cannot create the buffers and the depth buffer");
                return 0;
            }
            const paramsView = Nri_CreateStructuredBufferView(paramsBuffer, 0);
            this.paramsView = paramsView;
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            // The descriptor sets: per queued frame, one per swap chain texture; the compute
            // shader's, one per swap chain texture.
            const setNum = queuedFrameNum * textureNum + textureNum;
            const descriptorPool = Nri_CreateDescriptorPoolWithBuffers(device, setNum, 2 * queuedFrameNum * textureNum,
                queuedFrameNum * textureNum, 2 * queuedFrameNum * textureNum, queuedFrameNum * textureNum + 2 * textureNum, textureNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!descriptorPool || !paramsView) {
                console.log("Cannot create the descriptor pool");
                return 0;
            }

            // The sample's create_shading_rate_attachment and setup_framebuffer, per swap chain
            // texture: the shading rate attachment first at the lowest rate (the device's first,
            // largest: (min_shading_rate.height >> 1) | ((min_shading_rate.width << 1) & 12)), the
            // frequency content.
            this.shadingRateWidth = Math.ceil(this.width / this.tileSize);
            this.shadingRateHeight = Math.ceil(this.height / this.tileSize);
            // The compute shader's parameters, with the shading rate attachment's size.
            this.writeParams();
            const initialRateCode = (this.rates[1] >> 1) | ((this.rates[0] << 1) & 12);
            const initialRates: int[] = [];
            for (let i = 0; i < Math.floor((this.shadingRateWidth * this.shadingRateHeight + 3) / 4); i++) {
                initialRates.push(initialRateCode | (initialRateCode << 8) | (initialRateCode << 16) | (initialRateCode << 24));
            }
            for (let i = 0; i < textureNum; i++) {
                const shadingRate = Nri_CreateShadingRateTexture(device, this.queue, this.shadingRateWidth, this.shadingRateHeight,
                    Ref(initialRates[0]), this.shadingRateWidth, 1);
                const frequency = Nri_CreateRenderTargetStorageTexture(device, this.queue, this.width, this.height, NriFormat.RG8_UINT,
                    NriTextureState.PixelStorage);
                if (!shadingRate || !frequency) {
                    console.log("Cannot create the shading rate attachments and the frequency content");
                    this.destroyTexture(shadingRate);
                    this.destroyTexture(frequency);
                    return 0;
                }
                const computeSet = Nri_AllocateDescriptorSet(descriptorPool, computeLayout, 0, 0);
                const targets = new Targets(shadingRate, Nri_CreateShadingRateAttachmentView(shadingRate),
                    Nri_CreateStorageTextureView(shadingRate, NriFormat.R8_UINT), frequency,
                    Nri_CreateColorAttachmentView(frequency, NriFormat.RG8_UINT), Nri_CreateStorageTextureView(frequency, NriFormat.RG8_UINT),
                    computeSet);
                this.targets.push(targets);
                if (!computeSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(computeSet, 0, 0, targets.frequencyStorage);
                Nri_UpdateDescriptor(computeSet, 0, 1, targets.shadingRateStorage);
                Nri_UpdateDescriptor(computeSet, 1, 0, paramsView);
            }

            for (let q = 0; q < queuedFrameNum; q++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const constantBufferView = Nri_CreateConstantBufferView(constantBuffer, q * UBO_STRIDE, UBO_STRIDE);
                const renderSets: NriDescriptorSetHandle[] = [];
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), constantBufferView,
                    renderSets));
                if (!constantBufferView) {
                    console.log("Cannot create the constant buffer views");
                    return 0;
                }
                for (let i = 0; i < textureNum; i++) {
                    const renderSet = Nri_AllocateDescriptorSet(descriptorPool, renderLayout, 0, 0);
                    if (!renderSet) {
                        console.log("Cannot create the descriptor sets");
                        return 0;
                    }
                    renderSets.push(renderSet);
                    // Set i shows swap chain texture i's frequency content: the set of the texture
                    // the frame before rendered into (recordScene).
                    const previous = this.targets[i];
                    Nri_UpdateDescriptor(renderSet, 0, 0, constantBufferView);
                    Nri_UpdateDescriptor(renderSet, 1, 0, skysphereTextureView);
                    Nri_UpdateDescriptor(renderSet, 1, 1, sceneTextureView);
                    Nri_UpdateDescriptor(renderSet, 2, 0, sampler);
                    Nri_UpdateDescriptor(renderSet, 2, 1, sampler);
                    Nri_UpdateDescriptor(renderSet, 3, 0, previous.frequencyStorage);
                }
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

        // Both models were loaded.
        modelsLoaded(): boolean {
            if (!this.skysphereMesh) {
                return false;
            }
            return this.sceneMesh ? true : false;
        }

        // A pipeline of scene_vs and scene_ps with variable rate shading, into the color and the
        // frequency content: the sky sphere's (cube false) or the cubes'.
        createPipeline(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle, shaders: string, cube: boolean) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_scene_vs.bin`, "scene_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_scene_ps.bin`, "scene_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "NORMAL", NriFormat.RGB32_SFLOAT, 12);
            Nri_PipelineDescAddVertexAttribute(desc, "TEXCOORD", NriFormat.RG32_SFLOAT, 24);
            Nri_PipelineDescSetCullMode(desc, cube ? NriCullMode.Front : NriCullMode.Back);
            Nri_PipelineDescSetFrontCounterClockwise(desc, 1);
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescAddColor(desc, NriFormat.RG8_UINT, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, cube ? NriCompareOp.Greater : NriCompareOp.None, cube ? 1 : 0, 0);
            Nri_PipelineDescSetShadingRate(desc, 1);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, pipelineLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // The sample's update_compute_pipeline: the compute shader's parameters for the reduced size
        // pass's ratio (the frequency content's and the shading rates' sizes, the largest rate, the
        // rate count, the rates). The GPU must not be using them.
        writeParams() {
            const paramsBuffer = this.paramsBuffer;
            if (!paramsBuffer) {
                return;
            }
            const ratio = this.subpassExtentRatio;
            this.subpassWidth = Math.ceil(this.width / ratio);
            this.subpassHeight = Math.ceil(this.height / ratio);
            let maxRateX: int = 0;
            let maxRateY: int = 0;
            for (let r = 0; r < this.rateCount; r++) {
                maxRateX = Math.max(maxRateX, this.rates[r * 2]);
                maxRateY = Math.max(maxRateY, this.rates[r * 2 + 1]);
            }
            const header: int[] = [this.subpassWidth, this.subpassHeight, this.shadingRateWidth, this.shadingRateHeight,
                maxRateX, maxRateY, this.rateCount, 0];
            const p = this.params;
            for (let i = 0; i < 8; i++) {
                Nri_StoreInt32(Ref(p[i]), header[i]);
            }
            for (let r = 0; r < this.rateCount * 2; r++) {
                Nri_StoreInt32(Ref(p[8 + r]), this.rates[r]);
            }
            Nri_WriteBuffer(paramsBuffer, 0, Ref(p[0]), (8 + this.rateCount * 2) * 4);
            this.paramsRatio = ratio;
        }

        // Waits for the frame that last used this frame's command allocator (and its UBO).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The camera's input (ApiVulkanSample's), the mouse unless the overlay has it; then its
        // movement over the frame's time (Donut's test mode: 1/60 s, as a float).
        handleInput() {
            const overlay = this.imgui && Nri_ImguiWantsMouse() != 0;
            for (let button = 0; button < 3; button++) {
                const pressed = Nri_IsButtonPressed(this.sample, button) != 0;
                if (pressed != this.buttons[button]) {
                    if (!pressed || !overlay) {
                        this.camera.mouseButton(<MouseButton>button, <Action>(pressed ? 1 : 0));
                        this.buttons[button] = pressed;
                    }
                }
            }
            if (!overlay) {
                this.camera.mouseMove(Nri_GetMouseX(this.sample), Nri_GetMouseY(this.sample));
            }
            for (let k = 0; k < 4; k++) {
                const pressed = Nri_IsKeyPressed(this.sample, CAMERA_KEYS[k]) != 0;
                if (pressed != this.keys[k]) {
                    this.camera.key(<Key>CAMERA_KEYS[k], <Action>(pressed ? 1 : 0));
                    this.keys[k] = pressed;
                }
            }
            this.camera.update(this.test ? Math.fround(1.0 / 60.0) : Nri_GetFrameTime(this.sample));
        }

        // The sample's overlay, below the reduced size pass's corner (which the sample draws over its
        // UI).
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, this.subpassHeight + 10.0);
            Nri_ImguiBegin("Options", 1);
            if (Nri_ImguiCollapsingHeader("Settings", 1) != 0) {
                this.enableAttachmentShadingRate = Nri_ImguiCheckbox("Enable attachment shading rate",
                    this.enableAttachmentShadingRate ? 1 : 0) != 0;
                let selection = 0;
                while ((1 << (selection + 1)) <= this.subpassExtentRatio && selection < 4) {
                    selection++;
                }
                selection = Nri_ImguiCombo("Subpass size reduction", selection, SUBPASS_RATIOS);
                this.subpassExtentRatio = 1 << selection;
                this.colorShadingRate = Nri_ImguiCombo("Data visualize", this.colorShadingRate, VISUALIZE_NAMES);
                this.displaySkySphere = Nri_ImguiCheckbox("sky-sphere", this.displaySkySphere ? 1 : 0) != 0;
            }
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The sample's update_uniform_buffers: its projection (clip y negated, as the Donut example
        // gives it) and view, into this frame's slice.
        updateConstants(constantBuffer: NriBufferHandle, offset: int) {
            const projection = perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            const u = this.ubo;
            for (let i = 0; i < 16; i++) {
                u[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                u[UBO_MODELVIEW + i] = view[i];
                u[UBO_SKYSPHERE_MODELVIEW + i] = view[i];
            }
            Nri_StoreInt32(Ref(u[UBO_COLOR_SHADING_RATE]), this.colorShadingRate);
            Nri_WriteBuffer(constantBuffer, offset, Ref(u[0]), UBO_FLOATS * 4);
        }

        // The push constants: an offset and the object's kind.
        setPush(commandBuffer: NriCommandBufferHandle, x: number, y: number, z: number, objectType: int) {
            this.push[0] = x;
            this.push[1] = y;
            this.push[2] = z;
            this.push[3] = 0.0;
            Nri_StoreInt32(Ref(this.push[4]), objectType);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.push[0]), PUSH_SIZE);
        }

        // A mesh's buffers, bound.
        setMesh(commandBuffer: NriCommandBufferHandle, mesh: NriGltfMeshHandle) {
            Nri_CmdSetVertexBuffer(commandBuffer, 0, Nri_GetGltfMeshVertexBuffer(mesh), 0, VERTEX_SIZE);
            Nri_CmdSetIndexBuffer(commandBuffer, Nri_GetGltfMeshIndexBuffer(mesh), 0, NriIndexType.UInt32);
        }

        // The sample's build_command_buffer for one pass (between Nri_CmdBeginRenderingWithShadingRate
        // and Nri_CmdEndRendering), in the viewport width x height at the top left: the sky sphere (if
        // shown) and the three cubes, each draw's shading rate the attachment's (REPLACE: NVRHI's
        // Override) or the draw's 1x1 (KEEP: Passthrough).
        drawScene(commandBuffer: NriCommandBufferHandle, set: NriDescriptorSetHandle, width: int, height: int, useAttachment: boolean) {
            const renderLayout = this.renderLayout;
            const skysphereMesh = this.skysphereMesh;
            const sceneMesh = this.sceneMesh;
            const skyspherePipeline = this.skyspherePipeline;
            const cubePipeline = this.cubePipeline;
            if (!renderLayout || !skysphereMesh || !sceneMesh || !skyspherePipeline || !cubePipeline) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, width, height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, width, height);
            Nri_CmdSetPipelineLayout(commandBuffer, renderLayout);
            const attachmentCombiner = useAttachment ? NriShadingRateCombiner.Replace : NriShadingRateCombiner.Keep;

            if (this.displaySkySphere) {
                Nri_CmdSetPipeline(commandBuffer, skyspherePipeline);
                Nri_CmdSetShadingRate(commandBuffer, NriShadingRate.Rate1x1, NriShadingRateCombiner.Keep, attachmentCombiner);
                Nri_CmdSetDescriptorSet(commandBuffer, 0, set);
                this.setMesh(commandBuffer, skysphereMesh);
                this.setPush(commandBuffer, 0.0, 0.0, 0.0, OBJECT_SKYSPHERE);
                Nri_CmdDrawIndexed(commandBuffer, Nri_GetGltfMeshIndexCount(skysphereMesh), 1, 0, 0, 0);
            }

            Nri_CmdSetPipeline(commandBuffer, cubePipeline);
            Nri_CmdSetShadingRate(commandBuffer, NriShadingRate.Rate1x1, NriShadingRateCombiner.Keep, attachmentCombiner);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, set);
            this.setMesh(commandBuffer, sceneMesh);
            for (let j = 0; j < 3; j++) {
                this.setPush(commandBuffer, MESH_OFFSETS[j * 3], MESH_OFFSETS[j * 3 + 1], MESH_OFFSETS[j * 3 + 2], OBJECT_CUBE);
                Nri_CmdDrawIndexed(commandBuffer, Nri_GetGltfMeshIndexCount(sceneMesh), 1, 0, 0, 0);
            }
        }

        // Clears every frequency content to 0, once: a frame's pixel shader reads the one before's
        // (D3D12 rejects reading a render target before a clear), as the Donut example clears them
        // when it makes them. Left as the pixel shaders' storage textures.
        initializeTargets(commandBuffer: NriCommandBufferHandle) {
            for (const targets of this.targets) {
                Nri_CmdTextureBarrier(commandBuffer, targets.frequency, NriTextureState.PixelStorage, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, targets.frequencyAttachment);
                Nri_CmdClearColorAttachment(commandBuffer, 0, 0.0, 0.0, 0.0, 0.0);
                Nri_CmdEndRendering(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, targets.frequency, NriTextureState.ColorAttachment, NriTextureState.PixelStorage);
            }
            this.targetsInitialized = true;
        }

        // The sample's frame: the full size pass with the shading rate attachment (color and
        // frequency cleared to 0, depth to 0), the reduced size pass at the full rate in the corner
        // (cleared there first), then the compute shader making the next shading rates from the
        // corner's frequency content (between Nri_BeginCommandBuffer and the overlay's pass).
        recordScene(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame, queuedFrameIndex: int,
            swapChainTexture: SwapChainTexture, index: int) {
            const descriptorPool = this.descriptorPool;
            const constantBuffer = this.constantBuffer;
            const depthAttachment = this.depthAttachment;
            const computeLayout = this.computeLayout;
            const computePipeline = this.computePipeline;
            const targets = this.targets[index];
            const computeSet = targets.computeSet;
            if (!descriptorPool || !constantBuffer || !depthAttachment || !computeLayout || !computePipeline || !computeSet) {
                return;
            }
            // The frame before's frequency content (another texture's: before the first frame, or if
            // the swap chain gave the same texture again, the one before this one, as the Donut
            // example takes).
            const textureNum = this.targets.length;
            const previous = this.previousIndex >= 0 && this.previousIndex != index ? this.previousIndex : (index + textureNum - 1) % textureNum;
            const renderSet = queuedFrame.renderSets[previous];
            this.previousIndex = index;
            this.updateConstants(constantBuffer, queuedFrameIndex * UBO_STRIDE);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            if (!this.targetsInitialized) {
                this.initializeTargets(commandBuffer);
            }

            // The full size pass, with the shading rate attachment.
            Nri_CmdTextureBarrier(commandBuffer, targets.frequency, NriTextureState.PixelStorage, NriTextureState.ColorAttachment);
            Nri_CmdBeginRenderingWithShadingRate(commandBuffer, swapChainTexture.colorAttachment, targets.frequencyAttachment,
                depthAttachment, targets.shadingRateAttachment);
            Nri_CmdClearColorAttachment(commandBuffer, 0, 0.0, 0.0, 0.0, 0.0);
            Nri_CmdClearColorAttachment(commandBuffer, 1, 0.0, 0.0, 0.0, 0.0);
            Nri_CmdClearDepth(commandBuffer, 0.0);
            this.drawScene(commandBuffer, renderSet, this.width, this.height, this.enableAttachmentShadingRate);
            Nri_CmdEndRendering(commandBuffer);

            // The reduced size pass, at the full rate, into the corner of the targets.
            const subpassWidth = this.subpassWidth;
            const subpassHeight = this.subpassHeight;
            Nri_CmdBeginRenderingWithShadingRate(commandBuffer, swapChainTexture.colorAttachment, targets.frequencyAttachment,
                depthAttachment, null);
            Nri_CmdClearColorAttachmentRect(commandBuffer, 0, 0, 0, subpassWidth, subpassHeight, 0.0, 0.0, 0.0, 0.0);
            Nri_CmdClearColorAttachmentRect(commandBuffer, 1, 0, 0, subpassWidth, subpassHeight, 0.0, 0.0, 0.0, 0.0);
            Nri_CmdClearDepthRect(commandBuffer, 0, 0, subpassWidth, subpassHeight, 0.0);
            this.drawScene(commandBuffer, renderSet, subpassWidth, subpassHeight, false);
            Nri_CmdEndRendering(commandBuffer);

            // The compute shader: the next shading rates from the reduced pass's frequency content,
            // into the shading rate attachment.
            Nri_CmdTextureBarrier(commandBuffer, targets.frequency, NriTextureState.ColorAttachment, NriTextureState.Storage);
            Nri_CmdTextureBarrier(commandBuffer, targets.shadingRate, NriTextureState.ShadingRateAttachment, NriTextureState.Storage);
            Nri_CmdSetComputePipelineLayout(commandBuffer, computeLayout);
            Nri_CmdSetPipeline(commandBuffer, computePipeline);
            Nri_CmdSetComputeDescriptorSet(commandBuffer, 0, computeSet);
            Nri_CmdDispatch(commandBuffer, Math.floor((this.shadingRateWidth + GROUP_SIZE - 1) / GROUP_SIZE),
                Math.floor((this.shadingRateHeight + GROUP_SIZE - 1) / GROUP_SIZE), 1);
            Nri_CmdTextureBarrier(commandBuffer, targets.shadingRate, NriTextureState.Storage, NriTextureState.ShadingRateAttachment);
            Nri_CmdTextureBarrier(commandBuffer, targets.frequency, NriTextureState.Storage, NriTextureState.PixelStorage);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleInput();
            // A new ratio: new parameters (the sample remakes its targets).
            if (this.paramsRatio != this.subpassExtentRatio) {
                const device = this.device;
                if (device) {
                    Nri_DeviceWaitIdle(device);
                }
                this.writeParams();
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the scene's passes and the compute shader, then the overlay over them.
                Nri_BeginCommandBuffer(commandBuffer);
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                this.recordScene(commandBuffer, queuedFrame, queuedFrameIndex, swapChainTexture, index);
                if (this.imgui) {
                    Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                    Nri_CmdDrawImgui(this.sample, commandBuffer, this.viewFormat);
                    Nri_CmdEndRendering(commandBuffer);
                }

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
                for (const targets of this.targets) {
                    Nri_DestroyDescriptor(targets.shadingRateAttachment);
                    Nri_DestroyDescriptor(targets.shadingRateStorage);
                    Nri_DestroyDescriptor(targets.frequencyAttachment);
                    Nri_DestroyDescriptor(targets.frequencyStorage);
                    Nri_DestroyTexture(targets.shadingRate);
                    Nri_DestroyTexture(targets.frequency);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                this.destroyDescriptor(this.skysphereTextureView);
                this.destroyDescriptor(this.sceneTextureView);
                this.destroyDescriptor(this.sampler);
                this.destroyDescriptor(this.depthAttachment);
                this.destroyDescriptor(this.paramsView);
                this.destroyTexture(this.skysphereTexture);
                this.destroyTexture(this.sceneTexture);
                this.destroyTexture(this.depthTexture);
                this.destroyMesh(this.skysphereMesh);
                this.destroyMesh(this.sceneMesh);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.paramsBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.skyspherePipeline);
                this.destroyPipeline(this.cubePipeline);
                this.destroyPipeline(this.computePipeline);
                const renderLayout = this.renderLayout;
                if (renderLayout) {
                    Nri_DestroyPipelineLayout(renderLayout);
                }
                const computeLayout = this.computeLayout;
                if (computeLayout) {
                    Nri_DestroyPipelineLayout(computeLayout);
                }
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

        destroyBuffer(buffer: NriBufferHandle | null) {
            if (buffer) {
                Nri_DestroyBuffer(buffer);
            }
        }

        destroyMesh(mesh: NriGltfMeshHandle | null) {
            if (mesh) {
                Nri_DestroyGltfMesh(mesh);
            }
        }

        destroyPipeline(pipeline: NriPipelineHandle | null) {
            if (pipeline) {
                Nri_DestroyPipeline(pipeline);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const shadingRate = new FragmentShadingRateDynamic(sample);
        // -visualize <0..2>: 0 the render output, 1 the shading rates, 2 the frequency content;
        // -ratio <1..16>: the reduced size pass's ratio; -noattachment: the full rate everywhere;
        // -nosky: without the sky sphere; -noUI: no overlay.
        Nri_AddExampleOptionWithValues(sample, "-visualize", 1);
        Nri_AddExampleOptionWithValues(sample, "-ratio", 1);
        Nri_AddExampleOption(sample, "-noattachment");
        Nri_AddExampleOption(sample, "-nosky");
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-visualize" && i + 1 < argc) {
                i++;
                shadingRate.colorShadingRate = Math.min(2, Math.max(0, parseInt(Nri_GetArg(argc, argv, i))));
            } else if (arg == "-ratio" && i + 1 < argc) {
                i++;
                shadingRate.subpassExtentRatio = Math.min(16, Math.max(1, parseInt(Nri_GetArg(argc, argv, i))));
            } else if (arg == "-noattachment") {
                shadingRate.enableAttachmentShadingRate = false;
            } else if (arg == "-nosky") {
                shadingRate.displaySkySphere = false;
            } else if (arg == "-noUI") {
                shadingRate.noUI = true;
            }
        }
        return shadingRate.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return FragmentShadingRateDynamicNri.main(argc, argv);
}

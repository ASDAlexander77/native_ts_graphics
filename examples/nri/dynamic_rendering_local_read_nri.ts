/// <reference path="../../core/nri/nri_interop.d.ts" />
import { identity, radians, perspective } from "../../core/matrix";
import { FirstPersonCamera } from "../../core/vulkan_samples_camera";

namespace DynamicRenderingLocalReadNri {
    // dynamic_rendering_local_read, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework
    // instead of Donut and NVRHI: the same shaders (dynamic_rendering_local_read.hlsl's), scenes (read
    // as Donut's loadGltfModel reads them) and glass texture, through the NRI calls
    // core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui for the sample's overlay. This example
    // creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Dynamic Rendering Local Read";

    // The sample's scenes and glass texture (Vulkan-Samples' assets, copied at build time, the KTX
    // texture converted to DDS: see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const MEDIA_DIR = "media/dynamic_rendering_local_read/";
    const OPAQUE_SCENE_PATH = MEDIA_DIR + "subpass_scene_opaque.gltf";
    const TRANSPARENT_SCENE_PATH = MEDIA_DIR + "subpass_scene_transparent.gltf";
    const GLASS_TEXTURE_PATH = MEDIA_DIR + "transparent_glass_rgba.dds";

    // Nri_LoadGltfModel's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_FLOATS = 8;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const NORMAL_OFFSET = 12;
    const TEXCOORD_OFFSET = 24;

    // struct UBO { float4x4 projection, model, view; }, as f32 offsets; a queued frame's each in a
    // 256-byte slice of the constant buffer (D3D12 constant buffer views' alignment).
    const UBO_PROJECTION = 0;
    const UBO_MODEL = 16;
    const UBO_VIEW = 32;
    const UBO_FLOATS = 48;
    const UBO_STRIDE = 256;
    // The push constants (at b1: root constants): float4x4 matrix; float4 color.
    const PUSH_FLOATS = 20;
    const PUSH_REGISTER = 1;
    // struct Light { float4 position; float3 color; float radius; }, 64 of them.
    const LIGHT_FLOATS = 8;
    const LIGHT_COUNT = 64;
    const LIGHT_RANGE = [8.0, 0.6, 8.0];

    // The sample's first person camera at (-3.2, 1, 5.9) (vkb::Camera's position, the view's
    // translation), turned 0.5 degrees around x and 210.05 around y; reversed depth from 0.1 to
    // 256.
    const CAMERA_POSITION = [-3.2, 1.0, 5.9];
    const CAMERA_ROTATION = [0.5, 210.05, 0.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // GLFW's key codes of the camera's keys (W, S, A, D: Donut's Key values).
    const CAMERA_KEYS = [87, 83, 65, 68];

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into, and its descriptor sets: the opaque pass's (its slice of
    // the UBO) and the transparent pass's (the UBO slice, the G-buffer's position and depth, the
    // glass texture and its sampler).
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public uboView: NriDescriptorHandle | null, public opaqueSet: NriDescriptorSetHandle | null,
            public transparentSet: NriDescriptorSetHandle | null) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // A G-buffer texture and its views: rendered into, then read by the composition.
    class GBufferTarget {
        constructor(public texture: NriTextureHandle, public attachment: NriDescriptorHandle,
            public shaderResource: NriDescriptorHandle) {
        }
    }

    // The pixels whose red, green and blue are each within their range (inclusive).
    function countInRange(pixels: int[], rMin: int, rMax: int, gMin: int, gMax: int, bMin: int, bMax: int): int {
        let count = 0;
        for (let i = 0; i < pixels.length; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r >= rMin && r <= rMax && g >= gMin && g <= gMax && b >= bMin && b <= bMax) {
                count++;
            }
        }
        return count;
    }

    // The pixels whose largest and smallest channels are at least spread apart (colors, not grays).
    function countColored(pixels: int[], spread: int): int {
        let count = 0;
        for (let i = 0; i < pixels.length; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            const high = r > g ? (r > b ? r : b) : (g > b ? g : b);
            const low = r < g ? (r < b ? r : b) : (g < b ? g : b);
            if (high - low >= spread) {
                count++;
            }
        }
        return count;
    }

    // count is between min and max hundredths of total pixels; what names them in the failure.
    function share(count: int, total: int, min: number, max: number, what: string): string {
        const percent = 100.0 * count / total;
        console.log(`${what}: ${percent}% (${count} of ${total} pixels)`);
        if (percent < min || percent > max) {
            return `${what}: ${percent}% of the pixels, not ${min}% to ${max}%`;
        }
        return "";
    }

    // -test: checks the last frame, read back, as the Donut example does (the lights seeded with 0):
    // the room lit by the deferred lights (55% to 80% of the frame), its colored glass 10% to 25%,
    // blue 1.5% to 8%.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        const lit = share(total - countInRange(pixels, 0, 20, 0, 20, 0, 20), total, 55.0, 80.0, "Lit");
        if (lit != "") {
            return lit;
        }
        const colored = share(countColored(pixels, 61), total, 10.0, 25.0, "Colored");
        if (colored != "") {
            return colored;
        }
        return share(countInRange(pixels, 0, 89, 0, 119, 121, 255), total, 1.5, 8.0, "Blue glass");
    }

    // A scene's buffers and draws, a node's primitive each, in the framework's order (by mesh, node,
    // primitive): index range, base vertex, push constants (the node's world transform and the
    // material's base color factor). As the Donut example's Scene.
    class Scene {
        vertexBuffer: NriBufferHandle | null = null;
        indexBuffer: NriBufferHandle | null = null;
        firstIndex: int[] = [];
        indexCount: int[] = [];
        baseVertex: int[] = [];
        push: f32[] = [];

        load(device: NriDeviceHandle, queue: NriQueueHandle, path: string) {
            const model = Nri_LoadGltfModel(path);
            if (!model) {
                return false;
            }
            const primitiveCount = Nri_GetGltfModelPrimitiveCount(model);
            const vertices: f32[] = [];
            const indices: int[] = [];
            const firstIndex: int[] = [];
            const baseVertex: int[] = [];
            let meshCount: int = 0;
            for (let p = 0; p < primitiveCount; p++) {
                const vertexCount = Nri_GetGltfModelVertexCount(model, p);
                const indexCount = Nri_GetGltfModelIndexCount(model, p);
                const primitiveVertices: f32[] = [];
                for (let i = 0; i < vertexCount * VERTEX_FLOATS; i++) {
                    primitiveVertices.push(0.0);
                }
                const primitiveIndices: int[] = [];
                for (let i = 0; i < indexCount; i++) {
                    primitiveIndices.push(0);
                }
                Nri_CopyGltfModelVertices(model, p, Ref(primitiveVertices[0]));
                Nri_CopyGltfModelIndices(model, p, Ref(primitiveIndices[0]));
                baseVertex.push(vertices.length / VERTEX_FLOATS);
                firstIndex.push(indices.length);
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v++) {
                    vertices.push(primitiveVertices[v]);
                }
                for (let i = 0; i < indexCount; i++) {
                    indices.push(primitiveIndices[i]);
                }
                meshCount = Math.max(meshCount, Nri_GetGltfModelPrimitiveMesh(model, p) + 1);
            }

            const transform: f32[] = [];
            for (let i = 0; i < 16; i++) {
                transform.push(0.0);
            }
            const color: f32[] = [0.0, 0.0, 0.0, 0.0];
            const nodeCount = Nri_GetGltfModelNodeCount(model);
            for (let mesh = 0; mesh < meshCount; mesh++) {
                for (let node = 0; node < nodeCount; node++) {
                    if (Nri_GetGltfModelNodeMesh(model, node) != mesh) {
                        continue;
                    }
                    Nri_CopyGltfModelNodeTransform(model, node, Ref(transform[0]));
                    for (let p = 0; p < primitiveCount; p++) {
                        if (Nri_GetGltfModelPrimitiveMesh(model, p) != mesh) {
                            continue;
                        }
                        this.firstIndex.push(firstIndex[p]);
                        this.indexCount.push(Nri_GetGltfModelIndexCount(model, p));
                        this.baseVertex.push(baseVertex[p]);
                        Nri_CopyGltfModelBaseColorFactor(model, p, Ref(color[0]));
                        for (let i = 0; i < 16; i++) {
                            this.push.push(transform[i]);
                        }
                        for (let i = 0; i < 4; i++) {
                            this.push.push(color[i]);
                        }
                    }
                }
            }
            Nri_DestroyGltfModel(model);

            this.vertexBuffer = Nri_CreateUploadedBuffer(device, queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            this.indexBuffer = Nri_CreateUploadedBufferFromInts(device, queue, Ref(indices[0]), indices.length * 4, NriBufferUsage.IndexBuffer);
            if (!this.vertexBuffer || !this.indexBuffer) {
                return false;
            }
            return true;
        }

        destroy() {
            const vertexBuffer = this.vertexBuffer;
            if (vertexBuffer) {
                Nri_DestroyBuffer(vertexBuffer);
            }
            const indexBuffer = this.indexBuffer;
            if (indexBuffer) {
                Nri_DestroyBuffer(indexBuffer);
            }
        }
    }

    // Port of Vulkan-Samples' dynamic_rendering_local_read (as examples/dynamic_rendering_local_read.ts
    // ports it) to NRI: deferred shading of a room lit by 64 random point lights, then glass drawn
    // forward over it. The sample does it in one dynamic render pass (VK_KHR_dynamic_rendering_local_read)
    // reading the G-buffer as input attachments; NRI has no local read (nor have D3D's render passes):
    // the G-buffer pass ends, then the composition and the glass are drawn into the swap chain view
    // (sRGB, as Donut's back buffer) with the G-buffer's depth, reading the G-buffer as textures.
    class LocalRead {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private gbuffer: GBufferTarget[] = [];
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private opaqueLayout: NriPipelineLayoutHandle | null = null;
        private compositionLayout: NriPipelineLayoutHandle | null = null;
        private transparentLayout: NriPipelineLayoutHandle | null = null;
        private opaquePipeline: NriPipelineHandle | null = null;
        private compositionPipeline: NriPipelineHandle | null = null;
        private transparentPipeline: NriPipelineHandle | null = null;
        private opaqueScene: Scene = new Scene();
        private transparentScene: Scene = new Scene();
        private glassTexture: NriTextureHandle | null = null;
        private glassView: NriDescriptorHandle | null = null;
        private glassSampler: NriDescriptorHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private lightsBuffer: NriBufferHandle | null = null;
        private lightsView: NriDescriptorHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private compositionSet: NriDescriptorSetHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        private camera: FirstPersonCamera = new FirstPersonCamera(CAMERA_POSITION, CAMERA_ROTATION);
        // The mouse buttons and the camera's keys as the camera last saw them.
        private buttons: boolean[] = [false, false, false];
        private keys: boolean[] = [false, false, false, false];

        // -benchmark: the lights' random engine seeded with 0 (the framework's
        // lock_simulation_speed), as vulkan_samples' --benchmark (and under -test); -noUI: no overlay.
        benchmark: boolean = false;
        noUI: boolean = false;
        // The lights, rewritten when randomized.
        private lights: f32[] = [];
        private lightsDirty: boolean = true;

        // Upload buffers.
        private ubo: f32[] = [];
        private push: f32[] = [];

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

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
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

            // The sample's create_attachments: the G-buffer (position and linear depth, normal,
            // albedo; cleared before every read) and the depth buffer (D32, cleared to 0: reversed).
            const gbufferFormats = [NriFormat.RGBA16_SFLOAT, NriFormat.RGBA16_SFLOAT, NriFormat.RGBA8_UNORM];
            for (let i = 0; i < 3; i++) {
                const texture = Nri_CreateRenderTargetTexture(device, this.queue, this.width, this.height, gbufferFormats[i]);
                if (!texture) {
                    console.log("Cannot create the G-buffer");
                    return 0;
                }
                this.gbuffer.push(new GBufferTarget(texture, Nri_CreateColorAttachmentView(texture, gbufferFormats[i]),
                    Nri_CreateTextureView(texture, gbufferFormats[i])));
            }
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return 0;
            }
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            // The scenes and the glass texture (sRGB), its sampler as the framework's load_texture's:
            // trilinear, repeating, the device's widest anisotropic filtering.
            const loaded = this.opaqueScene.load(device, this.queue, OPAQUE_SCENE_PATH)
                && this.transparentScene.load(device, this.queue, TRANSPARENT_SCENE_PATH);
            const glass = Nri_LoadDdsTexture(device, this.queue, GLASS_TEXTURE_PATH, 1);
            this.glassTexture = glass;
            if (!loaded || !glass) {
                console.log("Cannot load the scenes and the texture: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const glassView = Nri_CreateTextureView(glass, NriFormat.RGBA8_SRGB);
            this.glassView = glassView;
            const glassSampler = Nri_CreateSamplerWithMipFilter(device, NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat,
                Nri_GetMaxSamplerAnisotropy(device));
            this.glassSampler = glassSampler;

            // The lights (a structured buffer the CPU writes), seeded with 0 under -benchmark and
            // -test.
            const lightsBuffer = Nri_CreateHostBufferWithStride(device, LIGHT_COUNT * LIGHT_FLOATS * 4, NriBufferUsage.StructuredBuffer,
                LIGHT_FLOATS * 4);
            this.lightsBuffer = lightsBuffer;
            if (!glassSampler || !lightsBuffer) {
                console.log("Cannot create the sampler and the lights");
                return 0;
            }
            const lightsView = Nri_CreateStructuredBufferView(lightsBuffer, 0);
            this.lightsView = lightsView;
            this.benchmark = this.benchmark || this.test;
            this.randomizeLights();

            // The layouts, one set each (in space 0), as the Donut example's binding layouts: the
            // opaque pass's UBO (b0) and push constants (b1: root constants); the composition's
            // G-buffer (t0 to t2) and lights (t3); the transparent pass's UBO, push constants, the
            // G-buffer's position and depth (t0), the glass texture (t4) and its sampler (s0).
            const stages = NriStage.VertexPixel;
            const opaqueDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(opaqueDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, stages, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRootConstants(opaqueDesc, PUSH_REGISTER, PUSH_FLOATS * 4, stages);
            const opaqueLayout = Nri_CreatePipelineLayoutFromDesc(device, opaqueDesc);
            Nri_DestroyPipelineLayoutDesc(opaqueDesc);
            this.opaqueLayout = opaqueLayout;
            const compositionDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(compositionDesc, 0, 0, 3, NriDescriptorType.Texture, stages, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(compositionDesc, 0, 3, 1, NriDescriptorType.StructuredBuffer, stages, NriRangeFlags.None);
            const compositionLayout = Nri_CreatePipelineLayoutFromDesc(device, compositionDesc);
            Nri_DestroyPipelineLayoutDesc(compositionDesc);
            this.compositionLayout = compositionLayout;
            const transparentDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(transparentDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, stages, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(transparentDesc, 0, 0, 1, NriDescriptorType.Texture, stages, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(transparentDesc, 0, 4, 1, NriDescriptorType.Texture, stages, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(transparentDesc, 0, 0, 1, NriDescriptorType.Sampler, stages, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRootConstants(transparentDesc, PUSH_REGISTER, PUSH_FLOATS * 4, stages);
            const transparentLayout = Nri_CreatePipelineLayoutFromDesc(device, transparentDesc);
            Nri_DestroyPipelineLayoutDesc(transparentDesc);
            this.transparentLayout = transparentLayout;
            if (!opaqueLayout || !compositionLayout || !transparentLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/dynamic_rendering_local_read/${folder}/dynamic_rendering_local_read`;
            this.opaquePipeline = this.createOpaquePipeline(device, opaqueLayout, shaders);
            this.compositionPipeline = this.createCompositionPipeline(device, compositionLayout, shaders);
            this.transparentPipeline = this.createTransparentPipeline(device, transparentLayout, shaders);
            if (!this.opaquePipeline || !this.compositionPipeline || !this.transparentPipeline) {
                console.log("Cannot load the dynamic rendering local read shaders");
                return 0;
            }

            // A queued frame's UBO slice and its opaque and transparent sets; the composition's set.
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * UBO_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = Nri_CreateDescriptorPoolWithBuffers(device, 2 * queuedFrameNum + 1, queuedFrameNum, 2 * queuedFrameNum,
                3 + 2 * queuedFrameNum, 0, 1, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool || !lightsView) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            const compositionSet = Nri_AllocateDescriptorSet(descriptorPool, compositionLayout, 0, 0);
            this.compositionSet = compositionSet;
            if (!compositionSet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }
            for (let i = 0; i < 3; i++) {
                Nri_UpdateDescriptor(compositionSet, 0, i, this.gbuffer[i].shaderResource);
            }
            Nri_UpdateDescriptor(compositionSet, 1, 0, lightsView);
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const uboView = Nri_CreateConstantBufferView(constantBuffer, i * UBO_STRIDE, UBO_STRIDE);
                const opaqueSet = Nri_AllocateDescriptorSet(descriptorPool, opaqueLayout, 0, 0);
                const transparentSet = Nri_AllocateDescriptorSet(descriptorPool, transparentLayout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), uboView, opaqueSet,
                    transparentSet));
                if (!uboView || !opaqueSet || !transparentSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(opaqueSet, 0, 0, uboView);
                Nri_UpdateDescriptor(transparentSet, 0, 0, uboView);
                Nri_UpdateDescriptor(transparentSet, 1, 0, this.gbuffer[0].shaderResource);
                Nri_UpdateDescriptor(transparentSet, 2, 0, glassView);
                Nri_UpdateDescriptor(transparentSet, 3, 0, glassSampler);
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

        // The opaque scene into the G-buffer: positions and normals, back faces culled
        // (counter-clockwise front faces), depth tested (greater: reversed) and written.
        createOpaquePipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, shaders: string) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_opaque_vs.bin`, "opaque_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_opaque_ps.bin`, "opaque_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "NORMAL", NriFormat.RGB32_SFLOAT, NORMAL_OFFSET);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            Nri_PipelineDescSetFrontCounterClockwise(desc, 1);
            Nri_PipelineDescSetColor(desc, NriFormat.RGBA16_SFLOAT, NriColorWrite.RGBA);
            Nri_PipelineDescAddColor(desc, NriFormat.RGBA16_SFLOAT, NriColorWrite.RGBA);
            Nri_PipelineDescAddColor(desc, NriFormat.RGBA8_UNORM, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            return this.finishPipeline(device, layout, desc, loaded);
        }

        // The composition: a full screen triangle, no culling, no depth (in the pass with the
        // depth buffer the glass is drawn in).
        createCompositionPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, shaders: string) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_composition_vs.bin`, "composition_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_composition_ps.bin`, "composition_ps") != 0;
            }
            Nri_PipelineDescSetCullMode(desc, NriCullMode.None);
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.None, 0, 0);
            return this.finishPipeline(device, layout, desc, loaded);
        }

        // The glass: positions and texture coordinates, no culling, depth tested (greater) and
        // written, alpha blended (destination alpha kept).
        createTransparentPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, shaders: string) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_transparent_vs.bin`, "transparent_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_transparent_ps.bin`, "transparent_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "TEXCOORD", NriFormat.RG32_SFLOAT, TEXCOORD_OFFSET);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.None);
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetBlend(desc, NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha, NriBlendOp.Add,
                NriBlendFactor.Zero, NriBlendFactor.One, NriBlendOp.Add);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            return this.finishPipeline(device, layout, desc, loaded);
        }

        finishPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, desc: NriPipelineDescHandle, loaded: boolean) {
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // The sample's update_lights_buffer: 64 lights at random over the room (a new engine each
        // time, seeded randomly, or with 0 under -benchmark). MSVC evaluates the sample's
        // vec4(x, y, z, 1) and vec3(r, g, b) from the last argument: z, y, x and b, g, r.
        randomizeLights() {
            const rng = Nri_CreateRandomEngine(this.benchmark ? 0 : -1);
            this.lights = [];
            for (let l = 0; l < LIGHT_COUNT; l++) {
                const z = Math.fround(Nri_RandomUniformFloat(rng, -1.0, 1.0) * LIGHT_RANGE[2]);
                const y = Math.fround(1.0 + Math.fround(Math.abs(Nri_RandomUniformFloat(rng, -1.0, 1.0)) * LIGHT_RANGE[1]));
                const x = Math.fround(Nri_RandomUniformFloat(rng, -1.0, 1.0) * LIGHT_RANGE[0]);
                const radius = Math.fround(1.0 + Math.fround(Math.abs(Nri_RandomUniformFloat(rng, -1.0, 1.0)) * 3.0));
                const b = Nri_RandomUniformFloat(rng, 0.0, 0.5);
                const g = Nri_RandomUniformFloat(rng, 0.0, 0.5);
                const r = Nri_RandomUniformFloat(rng, 0.0, 0.5);
                this.lights.push(x);
                this.lights.push(y);
                this.lights.push(z);
                this.lights.push(1.0);
                this.lights.push(r * 2.0);
                this.lights.push(g * 2.0);
                this.lights.push(b * 2.0);
                this.lights.push(radius);
            }
            Nri_DestroyRandomEngine(rng);
            this.lightsDirty = true;
        }

        // Writes the lights if they changed: the GPU may still read the old ones (a frame in
        // flight), so it's waited for (only when randomized).
        writeLights() {
            const device = this.device;
            const lightsBuffer = this.lightsBuffer;
            if (!this.lightsDirty || !device || !lightsBuffer) {
                return;
            }
            Nri_DeviceWaitIdle(device);
            Nri_WriteBuffer(lightsBuffer, 0, Ref(this.lights[0]), LIGHT_COUNT * LIGHT_FLOATS * 4);
            this.lightsDirty = false;
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

        // The sample's overlay.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Dynamic Rendering Local Read", 1);
            Nri_ImguiText("Using separate passes (no local read)");
            if (Nri_ImguiButton("Randomize lights") != 0) {
                this.randomizeLights();
            }
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The sample's update_uniform_buffer: its projection (clip y negated, as the Donut example
        // gives it), the scene's model (identity), the view; into this frame's UBO slice.
        writeUbo(constantBuffer: NriBufferHandle, queuedFrameIndex: int) {
            const projection = perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            const model = identity();
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.ubo[UBO_MODEL + i] = model[i];
                this.ubo[UBO_VIEW + i] = view[i];
            }
            Nri_WriteBuffer(constantBuffer, queuedFrameIndex * UBO_STRIDE, Ref(this.ubo[0]), UBO_FLOATS * 4);
        }

        // A scene's draws with a pipeline, their push constants each (the layout and its set bound).
        drawScene(commandBuffer: NriCommandBufferHandle, scene: Scene, pipeline: NriPipelineHandle | null) {
            const vertexBuffer = scene.vertexBuffer;
            const indexBuffer = scene.indexBuffer;
            if (!pipeline || !vertexBuffer || !indexBuffer) {
                return;
            }
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetIndexBuffer(commandBuffer, indexBuffer, 0, NriIndexType.UInt32);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, vertexBuffer, 0, VERTEX_SIZE);
            for (let d = 0; d < scene.indexCount.length; d++) {
                for (let i = 0; i < PUSH_FLOATS; i++) {
                    this.push[i] = scene.push[d * PUSH_FLOATS + i];
                }
                Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.push[0]), PUSH_FLOATS * 4);
                Nri_CmdDrawIndexed(commandBuffer, scene.indexCount[d], 1, scene.firstIndex[d], scene.baseVertex[d], 0);
            }
        }

        // First draw: the G-buffer (cleared to zeros, depth to 0), the G-buffer left for the
        // composition to read.
        recordGBuffer(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const opaqueLayout = this.opaqueLayout;
            const opaqueSet = queuedFrame.opaqueSet;
            const depthAttachment = this.depthAttachment;
            if (!opaqueLayout || !opaqueSet || !depthAttachment) {
                return;
            }
            for (const target of this.gbuffer) {
                Nri_CmdTextureBarrier(commandBuffer, target.texture, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            }
            Nri_CmdBeginRenderingWithThreeColorsAndDepth(commandBuffer, this.gbuffer[0].attachment, this.gbuffer[1].attachment,
                this.gbuffer[2].attachment, depthAttachment);
            for (let i = 0; i < 3; i++) {
                Nri_CmdClearColorAttachment(commandBuffer, i, 0.0, 0.0, 0.0, 0.0);
            }
            Nri_CmdClearDepth(commandBuffer, 0.0);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, opaqueLayout);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, opaqueSet);
            this.drawScene(commandBuffer, this.opaqueScene, this.opaquePipeline);
            Nri_CmdEndRendering(commandBuffer);
            for (const target of this.gbuffer) {
                Nri_CmdTextureBarrier(commandBuffer, target.texture, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
            }
        }

        // Second draw: the deferred composition, reading the G-buffer; third: the glass, forward,
        // against the G-buffer's depth (between Nri_CmdBeginRenderingWithDepth and
        // Nri_CmdEndRendering).
        recordComposition(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const compositionLayout = this.compositionLayout;
            const compositionSet = this.compositionSet;
            const compositionPipeline = this.compositionPipeline;
            const transparentLayout = this.transparentLayout;
            const transparentSet = queuedFrame.transparentSet;
            if (!compositionLayout || !compositionSet || !compositionPipeline || !transparentLayout || !transparentSet) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, compositionLayout);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, compositionSet);
            Nri_CmdSetPipeline(commandBuffer, compositionPipeline);
            Nri_CmdDraw(commandBuffer, 3, 1, 0, 0);
            Nri_CmdSetPipelineLayout(commandBuffer, transparentLayout);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, transparentSet);
            this.drawScene(commandBuffer, this.transparentScene, this.transparentPipeline);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleInput();
            this.writeLights();
            const constantBuffer = this.constantBuffer;
            if (constantBuffer) {
                this.writeUbo(constantBuffer, queuedFrameIndex);
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const depthAttachment = this.depthAttachment;
            const descriptorPool = this.descriptorPool;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the G-buffer; the composition and the glass into the swap chain view
                // (cleared to zeros) with the G-buffer's depth; then the overlay over them.
                Nri_BeginCommandBuffer(commandBuffer);
                if (descriptorPool) {
                    Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
                }
                this.recordGBuffer(commandBuffer, queuedFrame);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                    Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
                    this.recordComposition(commandBuffer, queuedFrame);
                    Nri_CmdEndRendering(commandBuffer);
                }
                // (A pass of its own: the UI's pipeline has no depth attachment.)
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
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
                    this.destroyDescriptor(queuedFrame.uboView);
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
                for (const target of this.gbuffer) {
                    Nri_DestroyDescriptor(target.attachment);
                    Nri_DestroyDescriptor(target.shaderResource);
                    Nri_DestroyTexture(target.texture);
                }
                this.destroyDescriptor(this.depthAttachment);
                this.destroyDescriptor(this.glassView);
                this.destroyDescriptor(this.glassSampler);
                this.destroyDescriptor(this.lightsView);
                this.destroyTexture(this.depthTexture);
                this.destroyTexture(this.glassTexture);
                this.opaqueScene.destroy();
                this.transparentScene.destroy();
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.lightsBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.opaquePipeline);
                this.destroyPipeline(this.compositionPipeline);
                this.destroyPipeline(this.transparentPipeline);
                this.destroyLayout(this.opaqueLayout);
                this.destroyLayout(this.compositionLayout);
                this.destroyLayout(this.transparentLayout);
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
        const localRead = new LocalRead(sample);
        // -benchmark: the lights seeded with 0 (as under -test); -noUI: no overlay.
        Nri_AddExampleOption(sample, "-benchmark");
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-benchmark") {
                localRead.benchmark = true;
            } else if (arg == "-noUI") {
                localRead.noUI = true;
            }
        }
        return localRead.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return DynamicRenderingLocalReadNri.main(argc, argv);
}

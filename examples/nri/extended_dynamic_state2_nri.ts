/// <reference path="../../core/nri/nri_interop.d.ts" />
import { radians, perspective } from "../../core/matrix";
import { comboItems } from "../../core/text_format";
import { LookAtCamera } from "../../core/vulkan_samples_camera";

namespace ExtendedDynamicState2Nri {
    // extended_dynamic_state2, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead
    // of Donut and NVRHI: the same shaders (extended_dynamic_state2.hlsl's), scene and background
    // (read as Donut's loadGltfModel and loadGltfMesh read them) and cube map, through the NRI calls
    // core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui for the sample's overlay. This example
    // creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Extended Dynamic State 2";

    const SCENE_PATH = "media/extended_dynamic_state2/primitives.gltf";
    const BACKGROUND_PATH = "media/extended_dynamic_state2/cube.gltf";
    const ENVMAP_PATH = "media/extended_dynamic_state2/uffizi_rgba16f_cube.dds";

    // The scene's meshes in the framework's order (its nodes breadth first: Sphere_1 holds the
    // others). The geosphere is tessellated, the others drawn by the baseline pipeline; Cube_1 moves
    // against Cube_2 (z-fighting, which depth bias settles).
    const SCENE_ORDER = ["Sphere_1", "Cube_1", "Cube_2", "Geosphere", "Sphere_2", "Sphere_3"];
    const TESSELLATED = "Geosphere";
    const MOVING = "Cube_1";

    // Nri_LoadGltfModel's vertices (and Nri_LoadGltfMesh's): position, normal, texture coordinates.
    const VERTEX_FLOATS = 8;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const NORMAL_OFFSET = 12;

    // The sample's camera: a look-at camera at (2, -4, -10) turned by (-15, 190, 0) degrees, a 60
    // degree vertical field of view, depth reversed (near 256, far 0.1, as the sample passes them).
    const CAMERA_POSITION = [2.0, -4.0, -10.0];
    const CAMERA_ROTATION = [-15.0, 190.0, 0.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // The uniform buffers, a queued frame's each in a 256-byte slice of the constant buffer (D3D12
    // constant buffer views' alignment): UBOCOMM (projection, view: b0), UBOBAS (b1), UBOTESS (b3).
    const COMMON_FLOATS = 32;
    const TESS_FLOATS = 4;
    const CONST_STRIDE = 256;
    const COMMON_SLICE = 0;
    const BASELINE_SLICE = 1;
    const TESS_SLICE = 2;
    const SLICES = 3;
    // UBOBAS: ambient light color, light position, light color, light intensity.
    const BASELINE_CONSTANTS = [
        1.0, 1.0, 1.0, 0.1,
        -3.0, -8.0, 6.0, -1.0,
        1.0, 1.0, 1.0, 1.0,
        50.0, 0.0, 0.0, 0.0,
    ];
    // Push constants (at b2: root constants): the model matrix and the color.
    const NODE_FLOATS = 20;
    const PUSH_REGISTER = 2;

    // The cube drawn as triangle strips restarting at 0xFFFFFFFF: corners of a unit cube (and
    // their normals, the sum of their faces'), scaled by 4 and moved by (15, 2, 0).
    const RESTART_INDICES = [0, 4, 3, 7, -1, 1, 0, 2, 3, -1, 2, 6, 1, 5, -1, 1, 5, 0, 4, -1, 4, 5, 7, 6, -1, 2, 3, 6, 7];
    const RESTART_COLOR = [0.5, 1.0, 1.0, 1.0];

    // The selection effect's alpha and the moving cube's x: the sample steps them every 0.05 seconds.
    const TICK = 0.05;
    const ALPHA_STEP = 0.075;
    const ALPHA_MAX = 0.98;
    const ALPHA_MIN = 0.3;
    const MOVE_DELTA = 0.05;
    const MOVE_STEP = 0.0005;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into, and its descriptor set (its slices of the uniform buffers,
    // the cube map and its sampler) with the slices' views.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public descriptorSet: NriDescriptorSetHandle | null, public commonView: NriDescriptorHandle | null,
            public baselineView: NriDescriptorHandle | null, public tessView: NriDescriptorHandle | null) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // A mesh node of the scene: its primitive's range of the shared buffers, world transform and
    // material color, and the UI's settings for it.
    class SceneNode {
        depthBias: boolean = false;
        rasterizerDiscard: boolean = false;

        constructor(public name: string, public firstIndex: int, public indexCount: int, public baseVertex: int,
            public transform: number[], public color: number[]) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does: the street skybox fills it
    // (95% or more lit: some channel over 20), with the green of the scene's cube in the middle.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const middle = pixels[Math.floor(height / 2) * width + Math.floor(width / 2)];
        if ((middle & 0xFF) > 40 || ((middle >> 8) & 0xFF) < 60 || ((middle >> 16) & 0xFF) > 40) {
            return "the middle isn't the cube's green";
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
        if (lit < 95.0 || lit > 100.0) {
            return `Lit: ${lit}% of the pixels, not 95% to 100%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' extended_dynamic_state2 (as examples/extended_dynamic_state2.ts ports
    // it) to NRI: a few primitives over an environment cube map, each with depth bias and rasterizer
    // discard switched in the UI (two cubes in the same place z-fight until one has depth bias), a
    // cube drawn as triangle strips with primitive restart, and a geosphere tessellated as a
    // wireframe. The sample sets these as dynamic state (VK_EXT_extended_dynamic_state2); NRI has
    // none of it (nor have D3D's pipelines): they're pipelines of their own, as in the Donut example,
    // and rasterizer discard skips the draw (discarding every primitive draws nothing either). Drawn
    // straight into the sRGB swap chain view (Donut's sRGB back buffer), with a D32 depth buffer.
    class ExtendedDynamicState2 {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private pipelineLayout: NriPipelineLayoutHandle | null = null;
        private backgroundPipeline: NriPipelineHandle | null = null;
        private baselinePipeline: NriPipelineHandle | null = null;
        private biasedPipeline: NriPipelineHandle | null = null;
        private restartPipeline: NriPipelineHandle | null = null;
        private tessPipeline: NriPipelineHandle | null = null;
        private vertexBuffer: NriBufferHandle | null = null;
        private indexBuffer: NriBufferHandle | null = null;
        private restartVertexBuffer: NriBufferHandle | null = null;
        private restartIndexBuffer: NriBufferHandle | null = null;
        private background: NriGltfMeshHandle | null = null;
        private envmap: NriTextureHandle | null = null;
        private envmapView: NriDescriptorHandle | null = null;
        private sampler: NriDescriptorHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        private camera: LookAtCamera = new LookAtCamera(CAMERA_POSITION, CAMERA_ROTATION);
        // The mouse buttons as the camera last saw them.
        private buttons: boolean[] = [false, false, false];

        // The sample's settings, from its UI (and -tessellation <factor>, -noselection); -bias
        // <object>, -discard <object>: depth bias or rasterizer discard for an object of the UI's
        // list, once the scene is loaded; -benchmark: 1/60 second per frame; -noUI: no overlay.
        tessellation: boolean = false;
        tessFactor: number = 1.0;
        selectionActive: boolean = true;
        selectedObject: int = 0;
        biasObject: int = -1;
        discardObject: int = -1;
        benchmark: boolean = false;
        noUI: boolean = false;
        // The baseline pipeline's nodes (the UI's objects) and the tessellated ones.
        private baselineNodes: SceneNode[] = [];
        private tessNodes: SceneNode[] = [];
        private nodeNames: string = "";

        // The animations' state (the sample's statics), rounded to float as the sample's are.
        private timePass: number = 0.0;
        private difference: number = 0.0;
        private rising: boolean = true;
        private accumulatedDiff: number = 0.0;
        private alphaRise: boolean = false;
        private previousSelected: int = 0;
        private movingNode: int = -1;
        private movingX: number = 0.0;
        private parentScaleX: number = 0.0;

        // Upload buffers.
        private commonConstants: f32[] = [];
        private baselineConstants: f32[] = [];
        private tessConstants: f32[] = [0.0, 0.0, 0.0, 0.0];
        private nodeConstants: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < COMMON_FLOATS; i++) {
                this.commonConstants.push(0.0);
            }
            for (const constant of BASELINE_CONSTANTS) {
                this.baselineConstants.push(constant);
            }
            for (let i = 0; i < NODE_FLOATS; i++) {
                this.nodeConstants.push(0.0);
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

            // The depth buffer: D32, cleared to 0 (the sample's reversed depth).
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return 0;
            }
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            // The models and the cube map, its sampler as the sample's: trilinear and anisotropic,
            // clamped.
            const loaded = this.loadModels(device);
            const envmap = Nri_LoadDdsTexture(device, this.queue, ENVMAP_PATH, 0);
            this.envmap = envmap;
            if (!loaded || !envmap) {
                console.log("Cannot load the models and the cube map: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const envmapView = Nri_CreateTextureCubeView(envmap, NriFormat.RGBA16_SFLOAT);
            this.envmapView = envmapView;
            const sampler = Nri_CreateSamplerWithMipFilter(device, NriFilter.Linear, NriFilter.Linear, NriAddressMode.ClampToEdge,
                Nri_GetMaxSamplerAnisotropy(device));
            this.sampler = sampler;
            if (!sampler) {
                console.log("Cannot create the sampler");
                return 0;
            }

            // The settings the command line gave for the scene's objects.
            if (this.biasObject >= 0 && this.biasObject < this.baselineNodes.length) {
                this.baselineNodes[this.biasObject].depthBias = true;
            }
            if (this.discardObject >= 0 && this.discardObject < this.baselineNodes.length) {
                this.baselineNodes[this.discardObject].rasterizerDiscard = true;
            }
            this.previousSelected = this.selectedObject;
            this.updateAlphaDirection();

            // The layout: the uniform buffers (b0, b1; b3), the push constants (b2: root constants),
            // the cube map (t0) and its sampler (s0), seen by every stage.
            const stages = NriStage.VertexTessellationPixel;
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 2, NriDescriptorType.ConstantBuffer, stages, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 3, 1, NriDescriptorType.ConstantBuffer, stages, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Texture, stages, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Sampler, stages, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRootConstants(layoutDesc, PUSH_REGISTER, NODE_FLOATS * 4, stages);
            const pipelineLayout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            this.pipelineLayout = pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/extended_dynamic_state2/${folder}/extended_dynamic_state2`;
            this.backgroundPipeline = this.createPipeline(device, pipelineLayout, shaders, 0);
            this.baselinePipeline = this.createPipeline(device, pipelineLayout, shaders, 1);
            this.biasedPipeline = this.createPipeline(device, pipelineLayout, shaders, 2);
            this.restartPipeline = this.createPipeline(device, pipelineLayout, shaders, 3);
            this.tessPipeline = this.createPipeline(device, pipelineLayout, shaders, 4);
            if (!this.backgroundPipeline || !this.baselinePipeline || !this.biasedPipeline || !this.restartPipeline
                || !this.tessPipeline) {
                console.log("Cannot load the extended dynamic state 2 shaders");
                return 0;
            }

            // A queued frame's uniform buffers, in its own descriptor set with the cube map and
            // sampler.
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * SLICES * CONST_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = Nri_CreateDescriptorPool(device, queuedFrameNum, queuedFrameNum, SLICES * queuedFrameNum, queuedFrameNum,
                0, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool) {
                console.log("Cannot create the constant buffers");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const descriptorSet = Nri_AllocateDescriptorSet(descriptorPool, pipelineLayout, 0, 0);
                const commonView = Nri_CreateConstantBufferView(constantBuffer, (SLICES * i + COMMON_SLICE) * CONST_STRIDE, CONST_STRIDE);
                const baselineView = Nri_CreateConstantBufferView(constantBuffer, (SLICES * i + BASELINE_SLICE) * CONST_STRIDE,
                    CONST_STRIDE);
                const tessView = Nri_CreateConstantBufferView(constantBuffer, (SLICES * i + TESS_SLICE) * CONST_STRIDE, CONST_STRIDE);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), descriptorSet,
                    commonView, baselineView, tessView));
                if (!descriptorSet || !commonView || !baselineView || !tessView) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(descriptorSet, 0, 0, commonView);
                Nri_UpdateDescriptor(descriptorSet, 0, 1, baselineView);
                Nri_UpdateDescriptor(descriptorSet, 1, 0, tessView);
                Nri_UpdateDescriptor(descriptorSet, 2, 0, envmapView);
                Nri_UpdateDescriptor(descriptorSet, 3, 0, sampler);
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

        // The sample's pipeline state: depth test (greater: reversed) and write, blending by the
        // source's alpha (the alpha written as is), back faces culled, clockwise front faces; then
        // per kind: 0 the background (positions, counter-clockwise front faces), 1 the baseline
        // (positions and normals), 2 with depth bias (1, slope 1), 3 triangle strips restarting at
        // 0xFFFFFFFF, 4 the tessellation (positions; patches of 3 control points, as a wireframe,
        // front faces culled, counter-clockwise ones).
        createPipeline(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle, shaders: string, kind: int) {
            const prefix = kind == 0 ? "background" : kind == 4 ? "tess" : "baseline";
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_${prefix}_vs.bin`, `${prefix}_vs`) != 0;
            if (loaded && kind == 4) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Hull, `${shaders}_tess_hs.bin`, "tess_hs") != 0;
                if (loaded) {
                    loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Domain, `${shaders}_tess_ds.bin`, "tess_ds") != 0;
                }
            }
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_${prefix}_ps.bin`, `${prefix}_ps`) != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            if (kind >= 1 && kind <= 3) {
                Nri_PipelineDescAddVertexAttribute(desc, "NORMAL", NriFormat.RGB32_SFLOAT, NORMAL_OFFSET);
            }
            Nri_PipelineDescSetCullMode(desc, kind == 4 ? NriCullMode.Front : NriCullMode.Back);
            Nri_PipelineDescSetFrontCounterClockwise(desc, kind == 0 || kind == 4 ? 1 : 0);
            if (kind == 2) {
                Nri_PipelineDescSetDepthBias(desc, 1.0, 0.0, 1.0);
            } else if (kind == 3) {
                Nri_PipelineDescSetTopology(desc, NriTopology.TriangleStrip);
                Nri_PipelineDescSetPrimitiveRestart(desc, NriIndexType.UInt32);
            } else if (kind == 4) {
                Nri_PipelineDescSetTopology(desc, NriTopology.PatchList);
                Nri_PipelineDescSetPatchControlPoints(desc, 3);
                Nri_PipelineDescSetWireframe(desc, 1);
            }
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetBlend(desc, NriBlendFactor.SrcAlpha, NriBlendFactor.OneMinusSrcAlpha, NriBlendOp.Add,
                NriBlendFactor.One, NriBlendFactor.Zero, NriBlendOp.Add);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Greater, 1, 0);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, pipelineLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // The sample's load_assets and model_data_creation: every primitive of the scene in shared
        // buffers, the nodes in the framework's order; the background cube; the restarting cube.
        loadModels(device: NriDeviceHandle) {
            const model = Nri_LoadGltfModel(SCENE_PATH);
            this.background = Nri_LoadGltfMesh(device, this.queue, BACKGROUND_PATH);
            if (!model) {
                return false;
            }
            if (!this.background) {
                Nri_DestroyGltfModel(model);
                return false;
            }

            const primitiveCount = Nri_GetGltfModelPrimitiveCount(model);
            const vertices: f32[] = [];
            const indices: int[] = [];
            const firstIndex: int[] = [];
            const indexCounts: int[] = [];
            const baseVertex: int[] = [];
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
                indexCounts.push(indexCount);
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v++) {
                    vertices.push(primitiveVertices[v]);
                }
                for (let i = 0; i < indexCount; i++) {
                    indices.push(primitiveIndices[i]);
                }
            }

            const transform: f32[] = [];
            for (let i = 0; i < 16; i++) {
                transform.push(0.0);
            }
            const color: f32[] = [0.0, 0.0, 0.0, 0.0];
            const nodeCount = Nri_GetGltfModelNodeCount(model);
            for (let o = 0; o < SCENE_ORDER.length; o++) {
                for (let p = 0; p < primitiveCount; p++) {
                    if (Nri_GetGltfModelMeshName(model, p) != SCENE_ORDER[o]) {
                        continue;
                    }
                    for (let n = 0; n < nodeCount; n++) {
                        if (Nri_GetGltfModelNodeMesh(model, n) != Nri_GetGltfModelPrimitiveMesh(model, p)) {
                            continue;
                        }
                        Nri_CopyGltfModelNodeTransform(model, n, Ref(transform[0]));
                        Nri_CopyGltfModelBaseColorFactor(model, p, Ref(color[0]));
                        const t: number[] = [];
                        for (let i = 0; i < 16; i++) {
                            t.push(transform[i]);
                        }
                        const node = new SceneNode(SCENE_ORDER[o], firstIndex[p], indexCounts[p], baseVertex[p], t,
                            [color[0], color[1], color[2], color[3]]);
                        if (SCENE_ORDER[o] == TESSELLATED) {
                            this.tessNodes.push(node);
                        } else {
                            if (SCENE_ORDER[o] == MOVING) {
                                this.movingNode = this.baselineNodes.length;
                                this.movingX = t[12];
                            } else if (o == 0) {
                                // Sphere_1, the moving cube's parent: its x scale.
                                this.parentScaleX = t[0];
                            }
                            this.baselineNodes.push(node);
                        }
                    }
                }
            }
            Nri_DestroyGltfModel(model);
            const names: string[] = [];
            for (const node of this.baselineNodes) {
                names.push(node.name);
            }
            this.nodeNames = comboItems(names);
            this.vertexBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            this.indexBuffer = Nri_CreateUploadedBufferFromInts(device, this.queue, Ref(indices[0]), indices.length * 4,
                NriBufferUsage.IndexBuffer);

            // The restarting cube: its 8 corners, normals the sum of their faces'.
            const cube: f32[] = [];
            for (let v = 0; v < 8; v++) {
                const x = v == 1 || v == 2 || v == 5 || v == 6 ? 1.0 : 0.0;
                const y = v == 2 || v == 3 || v == 6 || v == 7 ? 1.0 : 0.0;
                const z = v >= 4 ? 1.0 : 0.0;
                cube.push(x * 4.0 + 15.0);
                cube.push(y * 4.0 + 2.0);
                cube.push(z * 4.0);
                const s = 1.0 / Math.sqrt(3.0);
                cube.push((x * 2.0 - 1.0) * s);
                cube.push((y * 2.0 - 1.0) * s);
                cube.push((z * 2.0 - 1.0) * s);
                cube.push(0.0);
                cube.push(0.0);
            }
            let restartIndices = RESTART_INDICES.map((v): int => v);
            this.restartVertexBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(cube[0]), cube.length * 4, NriBufferUsage.VertexBuffer);
            this.restartIndexBuffer = Nri_CreateUploadedBufferFromInts(device, this.queue, Ref(restartIndices[0]), restartIndices.length * 4,
                NriBufferUsage.IndexBuffer);
            if (!this.vertexBuffer || !this.indexBuffer || !this.restartVertexBuffer || !this.restartIndexBuffer) {
                return false;
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocator (and its uniform buffers).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The camera's mouse input, unless the overlay has the mouse.
        handleMouse() {
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
        }

        // The sample's cube_animation: every 0.05 seconds the moving cube steps along x (back and
        // forth by up to 0.05), and the selection effect's alpha steps too. The frame's time: Donut's
        // test mode's (1/60 s, as a float), -benchmark's (the same), or the clock's.
        animate() {
            const delta = Math.fround(this.test || this.benchmark ? 1.0 / 60.0 : Nri_GetFrameTime(this.sample));
            this.timePass = Math.fround(this.timePass + delta);
            if (this.timePass > Math.fround(TICK)) {
                if (this.difference < -Math.fround(MOVE_DELTA)) {
                    this.rising = true;
                } else if (this.difference > Math.fround(MOVE_DELTA)) {
                    this.rising = false;
                }
                if (this.rising) {
                    this.difference = Math.fround(this.difference + Math.fround(MOVE_STEP));
                } else {
                    this.difference = Math.fround(this.difference - Math.fround(MOVE_STEP));
                }
                this.timePass = 0.0;
                // The node's translation is in its parent's space (Sphere_1's, scaled).
                if (this.movingNode >= 0) {
                    this.baselineNodes[this.movingNode].transform[12] = this.movingX + this.parentScaleX * this.difference;
                }
                this.tickAlpha();
            }
        }

        // The sample's get_changed_alpha, at a tick (it consumes the tick as it rebuilds the
        // command buffers): the selected node's alpha steps down to 0.3 and up to 0.98.
        tickAlpha() {
            this.accumulatedDiff = Math.fround(this.accumulatedDiff + Math.fround(this.alphaRise ? ALPHA_STEP : -ALPHA_STEP));
            this.updateAlphaDirection();
        }

        selectedAlpha() {
            return Math.fround(this.baselineNodes[this.selectedObject].color[3] + this.accumulatedDiff);
        }

        updateAlphaDirection() {
            if (this.previousSelected != this.selectedObject) {
                this.accumulatedDiff = 0.0;
                this.previousSelected = this.selectedObject;
            }
            const alpha = this.selectedAlpha();
            if (alpha < Math.fround(ALPHA_MIN)) {
                this.alphaRise = true;
            } else if (alpha > Math.fround(ALPHA_MAX)) {
                this.alphaRise = false;
            }
        }

        // The sample's options.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPos(10.0, 10.0);
            Nri_ImguiBegin("Options", 1);
            if (Nri_ImguiCollapsingHeader("Settings", 1) != 0) {
                this.tessellation = Nri_ImguiCheckbox("Tessellation Enable", this.tessellation ? 1 : 0) != 0;
                // Maximum tessellation factor is set to 4.0
                this.tessFactor = Nri_ImguiSliderFloat("Tessellation Factor", this.tessFactor, 1.0, 4.0);
            }
            if (Nri_ImguiCollapsingHeader("Models", 1) != 0) {
                this.selectionActive = Nri_ImguiCheckbox("Selection effect active", this.selectionActive ? 1 : 0) != 0;
                this.selectedObject = Nri_ImguiCombo("Name", this.selectedObject, this.nodeNames);
                const node = this.baselineNodes[this.selectedObject];
                node.depthBias = Nri_ImguiCheckbox("Depth Bias Enable", node.depthBias ? 1 : 0) != 0;
                node.rasterizerDiscard = Nri_ImguiCheckbox("Rasterizer Discard", node.rasterizerDiscard ? 1 : 0) != 0;
            }
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The sample's update_uniform_buffers: its projection, into Donut's clip space (y negated),
        // and view; the baseline's lights; the tessellation factor (0 when off: factors of 1).
        writeConstants(constantBuffer: NriBufferHandle, queuedFrameIndex: int) {
            const projection = perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            for (let i = 0; i < 16; i++) {
                this.commonConstants[i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.commonConstants[16 + i] = view[i];
            }
            this.tessConstants[0] = this.tessellation ? this.tessFactor : 0.0;
            const base = SLICES * queuedFrameIndex;
            Nri_WriteBuffer(constantBuffer, (base + COMMON_SLICE) * CONST_STRIDE, Ref(this.commonConstants[0]), COMMON_FLOATS * 4);
            Nri_WriteBuffer(constantBuffer, (base + BASELINE_SLICE) * CONST_STRIDE, Ref(this.baselineConstants[0]),
                BASELINE_CONSTANTS.length * 4);
            Nri_WriteBuffer(constantBuffer, (base + TESS_SLICE) * CONST_STRIDE, Ref(this.tessConstants[0]), TESS_FLOATS * 4);
        }

        // A draw of the shared buffers' range with a node's push constants.
        drawNode(commandBuffer: NriCommandBufferHandle, pipeline: NriPipelineHandle | null, node: SceneNode, alpha: number) {
            if (!pipeline) {
                return;
            }
            for (let i = 0; i < 16; i++) {
                this.nodeConstants[i] = node.transform[i];
            }
            for (let i = 0; i < 3; i++) {
                this.nodeConstants[16 + i] = node.color[i];
            }
            this.nodeConstants[19] = alpha;
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.nodeConstants[0]), NODE_FLOATS * 4);
            Nri_CmdDrawIndexed(commandBuffer, node.indexCount, 1, node.firstIndex, node.baseVertex, 0);
        }

        // The background, the baseline scene (each node's depth bias and rasterizer discard, the
        // selected node blinking), the restarting cube, the tessellated scene (between
        // Nri_CmdBeginRenderingWithDepth and Nri_CmdEndRendering). The push constants carry over
        // between draws as the Donut example's do (the background's color, the restarting cube's
        // matrix: the last ones set).
        recordDraw(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const pipelineLayout = this.pipelineLayout;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = queuedFrame.descriptorSet;
            const background = this.background;
            const backgroundPipeline = this.backgroundPipeline;
            const restartPipeline = this.restartPipeline;
            const vertexBuffer = this.vertexBuffer;
            const indexBuffer = this.indexBuffer;
            const restartVertexBuffer = this.restartVertexBuffer;
            const restartIndexBuffer = this.restartIndexBuffer;
            if (!pipelineLayout || !descriptorPool || !descriptorSet || !background || !backgroundPipeline || !restartPipeline
                || !vertexBuffer || !indexBuffer || !restartVertexBuffer || !restartIndexBuffer) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, pipelineLayout);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, descriptorSet);

            // The background.
            for (let i = 0; i < 16; i++) {
                this.nodeConstants[i] = i % 5 == 0 ? 1.0 : 0.0;
            }
            Nri_CmdSetPipeline(commandBuffer, backgroundPipeline);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.nodeConstants[0]), NODE_FLOATS * 4);
            Nri_CmdSetIndexBuffer(commandBuffer, Nri_GetGltfMeshIndexBuffer(background), 0, NriIndexType.UInt32);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, Nri_GetGltfMeshVertexBuffer(background), 0, VERTEX_SIZE);
            Nri_CmdDrawIndexed(commandBuffer, Nri_GetGltfMeshIndexCount(background), 1, 0, 0, 0);

            // The baseline scene.
            this.updateAlphaDirection();
            Nri_CmdSetIndexBuffer(commandBuffer, indexBuffer, 0, NriIndexType.UInt32);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, vertexBuffer, 0, VERTEX_SIZE);
            for (let i = 0; i < this.baselineNodes.length; i++) {
                const node = this.baselineNodes[i];
                if (node.rasterizerDiscard) {
                    continue;
                }
                const alpha = this.selectionActive && i == this.selectedObject ? this.selectedAlpha() : node.color[3];
                this.drawNode(commandBuffer, node.depthBias ? this.biasedPipeline : this.baselinePipeline, node, alpha);
            }

            // The cube of triangle strips with primitive restart.
            for (let i = 0; i < 4; i++) {
                this.nodeConstants[16 + i] = RESTART_COLOR[i];
            }
            Nri_CmdSetPipeline(commandBuffer, restartPipeline);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.nodeConstants[0]), NODE_FLOATS * 4);
            Nri_CmdSetIndexBuffer(commandBuffer, restartIndexBuffer, 0, NriIndexType.UInt32);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, restartVertexBuffer, 0, VERTEX_SIZE);
            Nri_CmdDrawIndexed(commandBuffer, RESTART_INDICES.length, 1, 0, 0, 0);

            // The tessellated scene.
            Nri_CmdSetIndexBuffer(commandBuffer, indexBuffer, 0, NriIndexType.UInt32);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, vertexBuffer, 0, VERTEX_SIZE);
            for (const node of this.tessNodes) {
                this.drawNode(commandBuffer, this.tessPipeline, node, node.color[3]);
            }
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (this.imgui) {
                this.buildUI();
            }
            this.handleMouse();
            this.animate();
            const constantBuffer = this.constantBuffer;
            if (constantBuffer) {
                this.writeConstants(constantBuffer, queuedFrameIndex);
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: color cleared to transparent black, depth to 0 (reversed), the scene; then
                // the overlay over it.
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                    Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
                    Nri_CmdClearDepth(commandBuffer, 0.0);
                    this.recordDraw(commandBuffer, queuedFrame);
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
                    this.destroyDescriptor(queuedFrame.commonView);
                    this.destroyDescriptor(queuedFrame.baselineView);
                    this.destroyDescriptor(queuedFrame.tessView);
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
                this.destroyDescriptor(this.depthAttachment);
                this.destroyDescriptor(this.envmapView);
                this.destroyDescriptor(this.sampler);
                this.destroyTexture(this.depthTexture);
                this.destroyTexture(this.envmap);
                const background = this.background;
                if (background) {
                    Nri_DestroyGltfMesh(background);
                }
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.restartVertexBuffer);
                this.destroyBuffer(this.restartIndexBuffer);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.backgroundPipeline);
                this.destroyPipeline(this.baselinePipeline);
                this.destroyPipeline(this.biasedPipeline);
                this.destroyPipeline(this.restartPipeline);
                this.destroyPipeline(this.tessPipeline);
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    Nri_DestroyPipelineLayout(pipelineLayout);
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

        destroyPipeline(pipeline: NriPipelineHandle | null) {
            if (pipeline) {
                Nri_DestroyPipeline(pipeline);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const extended = new ExtendedDynamicState2(sample);
        // -tessellation <factor>: tessellation on; -bias <object>, -discard <object>: depth bias or
        // rasterizer discard for an object of the UI's list; -noselection: the selection effect off;
        // -benchmark: 1/60 second per frame; -noUI: no overlay.
        Nri_AddExampleOptionWithValues(sample, "-tessellation", 1);
        Nri_AddExampleOptionWithValues(sample, "-bias", 1);
        Nri_AddExampleOptionWithValues(sample, "-discard", 1);
        Nri_AddExampleOption(sample, "-noselection");
        Nri_AddExampleOption(sample, "-benchmark");
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-tessellation" && i + 1 < argc) {
                i++;
                const factor = parseFloat(Nri_GetArg(argc, argv, i));
                if (factor > 0.0) {
                    extended.tessellation = true;
                    extended.tessFactor = Math.min(factor, 4.0);
                }
            } else if (arg == "-bias" && i + 1 < argc) {
                i++;
                extended.biasObject = parseInt(Nri_GetArg(argc, argv, i));
            } else if (arg == "-discard" && i + 1 < argc) {
                i++;
                extended.discardObject = parseInt(Nri_GetArg(argc, argv, i));
            } else if (arg == "-noselection") {
                extended.selectionActive = false;
            } else if (arg == "-benchmark") {
                extended.benchmark = true;
            } else if (arg == "-noUI") {
                extended.noUI = true;
            }
        }
        return extended.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return ExtendedDynamicState2Nri.main(argc, argv);
}

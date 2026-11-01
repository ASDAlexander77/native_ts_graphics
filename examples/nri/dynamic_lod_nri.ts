/// <reference path="../../core/nri/nri_interop.d.ts" />
import { MeshletModel } from "../../core/meshlet_model";
import {
    matrixInverse, matrixMultiply, matrixPerspectiveFovRH, matrixTranslation, matrixTranspose,
    planeNormalize, row, vadd, vsub, XM_PI,
} from "../../core/directx_math";
import { SimpleCamera } from "../../core/simple_camera";

namespace DynamicLodNri {
    // dynamic_lod, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut
    // and NVRHI: the same shaders (dynamic_lod.hlsl's) and models (core/meshlet_model.cpp reads
    // them), through the NRI calls core/nri/nri_interop.d.ts binds. This example creates everything
    // it runs, and does the rendering. SimpleCamera's keys are Donut's Key values (GLFW's key codes),
    // which Nri_IsKeyPressed takes.

    const WINDOW_TITLE = "NRI Example: D3D12 Mesh Shader Dynamic LOD";
    const MEDIA_DIR = "media/dynamic_lod/";
    const LOD_FILES = ["Dragon_LOD0.bin", "Dragon_LOD1.bin", "Dragon_LOD2.bin", "Dragon_LOD3.bin", "Dragon_LOD4.bin", "Dragon_LOD5.bin"];

    // Shared.h.
    const MAX_LOD_LEVELS = 8;
    // The most amplification shader groups a DispatchMesh launches here.
    const MAX_GROUP_DISPATCH_COUNT = 65536;

    // Constants: View, ViewProj, Planes[6], ViewPosition, RecipTanHalfFovy, RenderMode (uint),
    // LODCount (uint); a queued frame's each CONSTANTS_SIZE bytes apart.
    const CONSTANTS_SIZE = 256;
    const CONSTANT_FLOATS = 62;
    const RENDER_MODE_FLOAT = 60;
    const LOD_COUNT_FLOAT = 61;
    // DrawParams, the push constants: InstanceOffset, InstanceCount.
    const DRAW_PARAMS_SIZE = 8;
    // MeshInfo: IndexBytes, MeshletCount, LastMeshletVertCount, LastMeshletPrimCount; one per LOD
    // slot (zeros in the unused ones), MESH_INFO_SIZE bytes apart.
    const MESH_INFO_SIZE = 256;
    // The files' vertex records (position, normal), Meshlet (4 uints); Instance (World,
    // WorldInvTranspose, BoundingSphere).
    const VERTEX_STRIDE = 24;
    const MESHLET_STRIDE = 16;
    const INSTANCE_STRIDE = 144;

    // The render modes Space cycles through: flat, meshlet colors, LOD colors (red LOD 0 to green
    // LOD n). The sample starts with LOD colors.
    const RENDER_MODE_COUNT = 3;
    const RENDER_MODE_LOD = 2;

    // The sample's clear color, (0, 0.2, 0.4).
    const CLEAR_R = 0.0;
    const CLEAR_G = 0.2;
    const CLEAR_B = 0.4;

    // Test mode: the frames rendered, each 1/60 s, at instance level 2 (125 dragons, near ones at
    // fine LODs and far ones at coarse ones).
    const TEST_FRAMES = 3;
    const TEST_LEVEL = 2;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no mesh shaders.
    const TEST_SKIPPED = 77;

    // SimpleCamera's keys; the sample's own (+ and - change the instance level, Space the render
    // mode), acted on when pressed.
    const CAMERA_KEYS = [Key.W, Key.A, Key.S, Key.D, Key.Left, Key.Right, Key.Up, Key.Down];
    const ACTION_KEYS = [Key.Equal, Key.KpAdd, Key.Minus, Key.KpSubtract, Key.Space];

    // The descriptor set's ranges, in the order the layout adds them.
    const RANGE_CONSTANTS = 0;
    const RANGE_MESH_INFO = 1;
    const RANGE_VERTICES = 2;
    const RANGE_MESHLETS = 3;
    const RANGE_UNIQUE_VERTEX_INDICES = 4;
    const RANGE_PRIMITIVE_INDICES = 5;
    const RANGE_INSTANCES = 6;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // A buffer the shaders read and its view.
    class ShaderBuffer {
        constructor(public buffer: NriBufferHandle, public view: NriDescriptorHandle) {
        }
    }

    // A LOD's buffers: vertices, meshlets, unique vertex indices, primitives.
    class Lod {
        constructor(public vertices: ShaderBuffer, public meshlets: ShaderBuffer, public uniqueVertexIndices: ShaderBuffer,
            public primitives: ShaderBuffer) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does, at instance level 2 with
    // LOD colors. The camera starts among the dragons (inside the nearest one); the dragons near it
    // are drawn at the finest LOD (red), the farther ones at coarser LODs (toward green), and the
    // clear color shows between them.
    function checkFrame(pixels: int[], width: int, height: int, instanceCount: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        if (instanceCount != 125) {
            return `${instanceCount} instances, not 125`;
        }
        const background = 0 | (51 << 8) | (102 << 16);
        let clear = 0;
        let reddish = 0;
        let yellowish = 0;
        let greenish = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            if (p == background) {
                clear++;
                continue;
            }
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r > g + 30) {
                reddish++;
            } else if (g > r + 30) {
                greenish++;
            } else if (r > 60 && g > 60 && b < r / 2) {
                yellowish++;
            }
        }
        console.log(`Clear color ${clear}, reddish (finest LOD) ${reddish}, yellowish ${yellowish}, greenish (coarse LODs) ${greenish}`);
        if (clear < 1000) {
            return `the clear color shows in ${clear} pixels only`;
        }
        if (reddish < 20000) {
            return `the near dragons aren't at the finest LOD: ${reddish} reddish pixels`;
        }
        if (greenish < 500) {
            return `the far dragons aren't at coarser LODs: ${greenish} greenish pixels`;
        }
        return "";
    }

    // Port of DirectX-Graphics-Samples' D3D12MeshShaders DynamicLOD (as examples/dynamic_lod.ts
    // ports it) to NRI: a cube of dragons ((2 level + 1)^3 of them; + and - change the level), an
    // amplification shader thread per dragon culling it against the view frustum and picking one of
    // six levels of detail by its size on screen, then a mesh shader group per meshlet and dragon
    // reading that LOD's meshlets from arrays of buffers. Space cycles flat, meshlet and LOD colors.
    // Drawn into the UNORM swap chain texture (the sample's R8G8B8A8_UNORM back buffer) with a
    // D32_FLOAT depth buffer.
    class DynamicLod {
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
        private pipeline: NriPipelineHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        // A queued frame's each (their constants differ).
        private descriptorSets: NriDescriptorSetHandle[] = [];
        private constantBuffer: NriBufferHandle | null = null;
        private constantViews: NriDescriptorHandle[] = [];
        // MeshInfo per LOD slot.
        private meshInfoBuffer: NriBufferHandle | null = null;
        private meshInfoViews: NriDescriptorHandle[] = [];
        private lods: Lod[] = [];
        // Bound to the arrays' unused slots, as the sample's null descriptors: a zeroed raw buffer,
        // meshlet and primitive.
        private placeholders: ShaderBuffer[] = [];
        private instanceBuffer: ShaderBuffer | null = null;
        private instanceCapacity: int = 0;
        private instanceData: f32[] = [];
        private updateInstances: boolean = true;
        private constants: f32[] = [];
        private drawParams: f32[] = [0.0, 0.0];
        private camera: SimpleCamera = new SimpleCamera();
        private radius: number = 0.0;
        private fovY: number = Math.fround(XM_PI / 3.0);
        // The action keys' state at the last frame, for their presses.
        private keysDown: boolean[] = [];
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // -instanceLevel <n>: the instance level (0 by default, as the sample; 2 for -test).
        instanceLevel: int = -1;
        instanceCount: int = 1;
        renderMode: int = RENDER_MODE_LOD;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < CONSTANT_FLOATS; i++) {
                this.constants.push(0.0);
            }
            for (let i = 0; i < ACTION_KEYS.length; i++) {
                this.keysDown.push(false);
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
                const failure = checkFrame(this.readBack(), this.width, this.height, this.instanceCount);
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

            // Swap chain: rendered through UNORM views, as the sample's R8G8B8A8_UNORM back buffer.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, queuedFrameNum + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            this.viewFormat = format;
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(this.swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, format),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }

            // Queued frames
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator)));
            }

            if (Nri_IsFeatureSupported(device, NriFeature.MeshShader) == 0) {
                this.unsupportedReason = "The graphics device has no mesh shaders";
                return 0;
            }

            // The sample's depth buffer: D32, cleared to 1.
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return 0;
            }
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            // The sample's root signature: CBV(b0), RootConstants(b1, 2), a descriptor table of
            // CBV(b2, 8) and SRV(t0, 32) (vertices, meshlets, unique vertex indices, primitives: 8
            // each), SRV(t32). Here one descriptor set (space 0) with the root constants.
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(layoutDesc, 1, DRAW_PARAMS_SIZE, NriStage.AllGraphics);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.AllGraphics, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 2, MAX_LOD_LEVELS, NriDescriptorType.ConstantBuffer, NriStage.AllGraphics,
                NriRangeFlags.Array);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, MAX_LOD_LEVELS, NriDescriptorType.StructuredBuffer, NriStage.AllGraphics,
                NriRangeFlags.Array);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 8, MAX_LOD_LEVELS, NriDescriptorType.StructuredBuffer, NriStage.AllGraphics,
                NriRangeFlags.Array);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 16, MAX_LOD_LEVELS, NriDescriptorType.StructuredBuffer, NriStage.AllGraphics,
                NriRangeFlags.Array);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 24, MAX_LOD_LEVELS, NriDescriptorType.StructuredBuffer, NriStage.AllGraphics,
                NriRangeFlags.Array);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 32, 1, NriDescriptorType.StructuredBuffer, NriStage.AllGraphics, NriRangeFlags.None);
            this.pipelineLayout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The sample's pipeline state: dynamic_lod.hlsl's shaders, as compiled for the Donut
            // example; the default rasterizer state (back faces culled), blend state (opaque) and
            // depth state (less, writes).
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/dynamic_lod/${folder}/dynamic_lod`;
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Task, `${shaders}_main_as.bin`, "main_as") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Mesh, `${shaders}_main_ms.bin`, "main_ms") != 0;
            }
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_main_ps.bin`, "main_ps") != 0;
            }
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            Nri_PipelineDescSetColor(desc, format, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, NriCompareOp.Less, 1, 0);
            if (loaded) {
                this.pipeline = Nri_CreatePipelineFromDesc(device, pipelineLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            if (!this.pipeline) {
                console.log("Cannot load the dynamic LOD shaders");
                return 0;
            }

            // The constants, a queued frame's each; MeshInfo per LOD slot.
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * CONSTANTS_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const meshInfoBuffer = Nri_CreateHostBuffer(device, MAX_LOD_LEVELS * MESH_INFO_SIZE, NriBufferUsage.ConstantBuffer);
            this.meshInfoBuffer = meshInfoBuffer;
            if (!constantBuffer || !meshInfoBuffer) {
                console.log("Cannot create the constant buffers");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const view = Nri_CreateConstantBufferView(constantBuffer, i * CONSTANTS_SIZE, CONSTANTS_SIZE);
                if (!view) {
                    console.log("Cannot create the constant buffer views");
                    return 0;
                }
                this.constantViews.push(view);
            }
            for (let i = 0; i < MAX_LOD_LEVELS; i++) {
                const view = Nri_CreateConstantBufferView(meshInfoBuffer, i * MESH_INFO_SIZE, MESH_INFO_SIZE);
                if (!view) {
                    console.log("Cannot create the constant buffer views");
                    return 0;
                }
                this.meshInfoViews.push(view);
            }

            // The sample's camera: at (0, 75, 150), 150 units a second.
            this.camera.init(0.0, 75.0, 150.0);
            this.camera.setMoveSpeed(150.0);

            if (!this.loadLods(device, meshInfoBuffer)) {
                return 0;
            }

            // The descriptor sets.
            const descriptorPool = Nri_CreateDescriptorPoolWithBuffers(device, queuedFrameNum, 0, (1 + MAX_LOD_LEVELS) * queuedFrameNum, 0, 0,
                (4 * MAX_LOD_LEVELS + 1) * queuedFrameNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!descriptorPool) {
                console.log("Cannot create the descriptor pool");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const set = Nri_AllocateDescriptorSet(descriptorPool, pipelineLayout, 0, 0);
                if (!set) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                this.descriptorSets.push(set);
                this.updateDescriptorSet(set, i);
            }

            // The instances, at the test's level in test mode.
            if (this.instanceLevel < 0) {
                this.instanceLevel = this.test ? TEST_LEVEL : 0;
            }
            if (!this.regenerateInstances()) {
                console.log("Cannot create the instance buffer");
                return 0;
            }

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // A buffer of byteSize bytes of data (ints), structures stride bytes each (4: raw, a
        // ByteAddressBuffer), and its view; null on failure.
        createShaderBuffer(device: NriDeviceHandle, data: int[], byteSize: int, stride: int): ShaderBuffer | null {
            const buffer = Nri_CreateUploadedStructuredBufferFromInts(device, this.queue, Ref(data[0]), byteSize, stride);
            if (!buffer) {
                return null;
            }
            const view = Nri_CreateStructuredBufferView(buffer, 0);
            if (!view) {
                Nri_DestroyBuffer(buffer);
                return null;
            }
            return new ShaderBuffer(buffer, view);
        }

        // Model::LoadFromFile and UploadGpuResources, for each LOD's first mesh: its MeshInfo and
        // buffers for the shaders; then the placeholders.
        loadLods(device: NriDeviceHandle, meshInfoBuffer: NriBufferHandle): boolean {
            const meshInfo: f32[] = [0.0, 0.0, 0.0, 0.0];
            for (let l = 0; l < LOD_FILES.length; l++) {
                const path = MEDIA_DIR + LOD_FILES[l];
                const file = Nri_LoadFile(path);
                if (!file) {
                    console.log(`Cannot load ${path} (the sample's model: build with DIRECTX_GRAPHICS_SAMPLES_DIR set)`);
                    return false;
                }
                const loaded = MeshletModel.load(Nri_GetFileData(file), Nri_GetFileSize(file));
                Nri_DestroyFile(file);
                if (loaded.isNull()) {
                    return false;
                }
                const model = loaded;
                if (model.getVertexBufferStride(0, 0) != VERTEX_STRIDE) {
                    console.log(`${path}: vertices of another layout than the mesh shader's`);
                    model.destroy();
                    return false;
                }
                // The finest LOD's bounding sphere spaces the instances.
                if (l == 0) {
                    const sphere: f32[] = [0.0, 0.0, 0.0, 0.0];
                    model.copyBoundingSphere(-1, Ref(sphere[0]));
                    this.radius = sphere[3];
                }

                const meshletCount = model.getDataCount(0, MeshletModelData.Meshlets);
                const meshlets: int[] = [];
                for (let j = 0; j < meshletCount * 4; j++) {
                    meshlets.push(0);
                }
                model.copyData(0, MeshletModelData.Meshlets, Ref(meshlets[0]));
                Nri_StoreInt32(Ref(meshInfo[0]), model.getIndexSize(0));
                Nri_StoreInt32(Ref(meshInfo[1]), meshletCount);
                Nri_StoreInt32(Ref(meshInfo[2]), meshlets[(meshletCount - 1) * 4]);
                Nri_StoreInt32(Ref(meshInfo[3]), meshlets[(meshletCount - 1) * 4 + 2]);
                Nri_WriteBuffer(meshInfoBuffer, l * MESH_INFO_SIZE, Ref(meshInfo[0]), 16);

                // The vertices (24-byte records) as a raw buffer.
                const vertexSize = model.getVertexBufferSize(0, 0);
                const vertices: int[] = [];
                for (let j = 0; j < vertexSize / 4; j++) {
                    vertices.push(0);
                }
                model.copyVertexBuffer(0, 0, Ref(vertices[0]));
                // The unique vertex indices, rounded up to whole uints, as the sample's buffer.
                const uniqueSize = model.getDataSize(0, MeshletModelData.UniqueVertexIndices);
                const uniqueInts = Math.floor((uniqueSize + 3) / 4);
                const unique: int[] = [];
                for (let j = 0; j < uniqueInts; j++) {
                    unique.push(0);
                }
                model.copyData(0, MeshletModelData.UniqueVertexIndices, Ref(unique[0]));
                const primitiveCount = model.getDataCount(0, MeshletModelData.PrimitiveIndices);
                const primitives: int[] = [];
                for (let j = 0; j < primitiveCount; j++) {
                    primitives.push(0);
                }
                model.copyData(0, MeshletModelData.PrimitiveIndices, Ref(primitives[0]));
                model.destroy();

                const vertexBuffer = this.createShaderBuffer(device, vertices, vertexSize, 4);
                const meshletBuffer = this.createShaderBuffer(device, meshlets, meshletCount * MESHLET_STRIDE, MESHLET_STRIDE);
                const uniqueBuffer = this.createShaderBuffer(device, unique, uniqueInts * 4, 4);
                const primitiveBuffer = this.createShaderBuffer(device, primitives, primitiveCount * 4, 4);
                if (!vertexBuffer || !meshletBuffer || !uniqueBuffer || !primitiveBuffer) {
                    console.log(`${path}: cannot create its buffers`);
                    return false;
                }
                this.lods.push(new Lod(vertexBuffer, meshletBuffer, uniqueBuffer, primitiveBuffer));
            }

            // The unused slots' zeroed MeshInfo, and the placeholders: a raw buffer, a meshlet and a
            // primitive.
            for (let k = 0; k < 4; k++) {
                meshInfo[k] = 0.0;
            }
            for (let l = LOD_FILES.length; l < MAX_LOD_LEVELS; l++) {
                Nri_WriteBuffer(meshInfoBuffer, l * MESH_INFO_SIZE, Ref(meshInfo[0]), 16);
            }
            const zeros: int[] = [0, 0, 0, 0];
            const raw = this.createShaderBuffer(device, zeros, 16, 4);
            const meshlet = this.createShaderBuffer(device, zeros, 16, MESHLET_STRIDE);
            if (!raw || !meshlet) {
                console.log("Cannot create the placeholder buffers");
                return false;
            }
            this.placeholders.push(raw);
            this.placeholders.push(meshlet);
            return true;
        }

        // A queued frame's descriptor set: its constants, the LODs' buffers in the arrays' first
        // slots, placeholders in the rest.
        updateDescriptorSet(set: NriDescriptorSetHandle, queuedFrameIndex: int) {
            Nri_UpdateDescriptor(set, RANGE_CONSTANTS, 0, this.constantViews[queuedFrameIndex]);
            const raw = this.placeholders[0];
            const meshlet = this.placeholders[1];
            for (let i = 0; i < MAX_LOD_LEVELS; i++) {
                Nri_UpdateDescriptor(set, RANGE_MESH_INFO, i, this.meshInfoViews[i]);
                if (i < this.lods.length) {
                    const lod = this.lods[i];
                    Nri_UpdateDescriptor(set, RANGE_VERTICES, i, lod.vertices.view);
                    Nri_UpdateDescriptor(set, RANGE_MESHLETS, i, lod.meshlets.view);
                    Nri_UpdateDescriptor(set, RANGE_UNIQUE_VERTEX_INDICES, i, lod.uniqueVertexIndices.view);
                    Nri_UpdateDescriptor(set, RANGE_PRIMITIVE_INDICES, i, lod.primitives.view);
                } else {
                    Nri_UpdateDescriptor(set, RANGE_VERTICES, i, raw.view);
                    Nri_UpdateDescriptor(set, RANGE_MESHLETS, i, meshlet.view);
                    Nri_UpdateDescriptor(set, RANGE_UNIQUE_VERTEX_INDICES, i, raw.view);
                    Nri_UpdateDescriptor(set, RANGE_PRIMITIVE_INDICES, i, raw.view);
                }
            }
        }

        // RegenerateInstances: the dragons in a cube growing with the level, 1.5 bounding sphere
        // radii apart, each with its bounding sphere (its position, the finest LOD's radius); the
        // instance buffer (CPU-written, read by the GPU) made larger when they don't fit. False if it
        // can't be.
        regenerateInstances(): boolean {
            const device = this.device;
            if (!device) {
                return false;
            }
            this.updateInstances = true;
            const radius = this.radius;
            const spacing = Math.fround(Math.fround(1.0 + 0.5) * radius);
            const width = this.instanceLevel * 2 + 1;
            const extents = Math.fround(spacing * this.instanceLevel);
            this.instanceCount = width * width * width;

            if (this.instanceCount > this.instanceCapacity) {
                Nri_DeviceWaitIdle(device);
                this.destroyInstanceBuffer();
                this.instanceCapacity = this.instanceCount;
                const buffer = Nri_CreateHostBufferWithStride(device, this.instanceCapacity * INSTANCE_STRIDE, NriBufferUsage.StructuredBuffer,
                    INSTANCE_STRIDE);
                if (!buffer) {
                    return false;
                }
                const view = Nri_CreateStructuredBufferView(buffer, 0);
                if (!view) {
                    Nri_DestroyBuffer(buffer);
                    return false;
                }
                this.instanceBuffer = new ShaderBuffer(buffer, view);
                for (const set of this.descriptorSets) {
                    Nri_UpdateDescriptor(set, RANGE_INSTANCES, 0, view);
                }
            }

            const data: f32[] = [];
            for (let i = 0; i < this.instanceCount; i++) {
                const x = Math.fround(Math.fround((i % width) * spacing) - extents);
                const y = Math.fround(Math.fround((Math.floor(i / width) % width) * spacing) - extents);
                const z = Math.fround(Math.fround(Math.floor(i / (width * width)) * spacing) - extents);
                const world = matrixTranslation(x, y, z);
                const worldT = matrixTranspose(world);
                const worldInvTranspose = matrixTranspose(matrixInverse(matrixTranspose(world)));
                for (let k = 0; k < 16; k++) {
                    data.push(worldT[k]);
                }
                for (let k = 0; k < 16; k++) {
                    data.push(worldInvTranspose[k]);
                }
                data.push(x);
                data.push(y);
                data.push(z);
                data.push(radius);
            }
            this.instanceData = data;
            return true;
        }

        destroyInstanceBuffer() {
            const instanceBuffer = this.instanceBuffer;
            if (instanceBuffer) {
                Nri_DestroyDescriptor(instanceBuffer.view);
                Nri_DestroyBuffer(instanceBuffer.buffer);
            }
            this.instanceBuffer = null;
        }

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // OnKeyDown: + and - change the instance level, Space the render mode (when pressed).
        handleKeys() {
            for (let k = 0; k < ACTION_KEYS.length; k++) {
                const key = ACTION_KEYS[k];
                const down = Nri_IsKeyPressed(this.sample, key) != 0;
                const pressed = down && !this.keysDown[k];
                this.keysDown[k] = down;
                if (!pressed) {
                    continue;
                }
                if (key == Key.Equal || key == Key.KpAdd) {
                    this.instanceLevel++;
                    this.regenerateInstances();
                } else if (key == Key.Minus || key == Key.KpSubtract) {
                    if (this.instanceLevel != 0) {
                        this.instanceLevel--;
                        this.regenerateInstances();
                    }
                } else if (key == Key.Space) {
                    this.renderMode = (this.renderMode + 1) % RENDER_MODE_COUNT;
                }
            }
        }

        // OnUpdate: the keys and the camera (1/60 s a frame in test mode, as Donut's test mode); the
        // constants for the frame: the view, the 60 degree perspective (near 1, far 10000), the
        // frustum planes from their product, the camera's position.
        update(constantsOffset: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            if (!this.test) {
                this.handleKeys();
            }
            for (const key of CAMERA_KEYS) {
                this.camera.onKey(key, Nri_IsKeyPressed(this.sample, key) != 0);
            }
            this.camera.update(Math.fround(this.test ? 1.0 / 60.0 : Nri_GetFrameTime(this.sample)));
            Nri_SetWindowTitle(this.sample, `${WINDOW_TITLE} (${this.instanceCount} instances)`);

            const view = this.camera.viewMatrix();
            const proj = matrixPerspectiveFovRH(this.fovY, Math.fround(this.width / this.height), 1.0, 10000.0);
            const viewProj = matrixMultiply(view, proj);
            const vp = matrixTranspose(viewProj);
            const r0 = row(vp, 0);
            const r1 = row(vp, 1);
            const r2 = row(vp, 2);
            const r3 = row(vp, 3);
            const planes = [
                planeNormalize(vadd(r3, r0)), // Left
                planeNormalize(vsub(r3, r0)), // Right
                planeNormalize(vadd(r3, r1)), // Bottom
                planeNormalize(vsub(r3, r1)), // Top
                planeNormalize(r2),           // Near
                planeNormalize(vsub(r3, r2)), // Far
            ];
            const c = this.constants;
            const viewT = matrixTranspose(view);
            const viewProjT = matrixTranspose(viewProj);
            for (let i = 0; i < 16; i++) {
                c[i] = viewT[i];
                c[16 + i] = viewProjT[i];
            }
            for (let p = 0; p < 6; p++) {
                for (let i = 0; i < 4; i++) {
                    c[32 + p * 4 + i] = planes[p][i];
                }
            }
            const viewPosition = row(matrixInverse(view), 3);
            for (let i = 0; i < 3; i++) {
                c[56 + i] = viewPosition[i];
            }
            c[59] = Math.fround(1.0 / Math.fround(Math.tan(Math.fround(this.fovY * 0.5))));
            Nri_StoreInt32(Ref(c[RENDER_MODE_FLOAT]), this.renderMode);
            Nri_StoreInt32(Ref(c[LOD_COUNT_FLOAT]), LOD_FILES.length);
            Nri_WriteBuffer(constantBuffer, constantsOffset, Ref(c[0]), CONSTANT_FLOATS * 4);

            // Only upload instance data if it changed (the GPU done with the old: see
            // regenerateInstances, and the wait here).
            const instanceBuffer = this.instanceBuffer;
            if (this.updateInstances) {
                const device = this.device;
                if (instanceBuffer) {
                    if (device) {
                        Nri_DeviceWaitIdle(device);
                    }
                    Nri_WriteBuffer(instanceBuffer.buffer, 0, Ref(this.instanceData[0]), this.instanceCount * INSTANCE_STRIDE);
                }
                this.updateInstances = false;
            }
        }

        // PopulateCommandList's draws (between Nri_CmdBeginRenderingWithDepth and
        // Nri_CmdEndRendering): an amplification shader group per instance, in batches of at most
        // MAX_GROUP_DISPATCH_COUNT, starting at dispatchCount * i as the sample's.
        recordDraw(commandBuffer: NriCommandBufferHandle, set: NriDescriptorSetHandle) {
            const pipelineLayout = this.pipelineLayout;
            const pipeline = this.pipeline;
            const descriptorPool = this.descriptorPool;
            if (!pipelineLayout || !pipeline || !descriptorPool) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, pipelineLayout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, set);
            const dispatchCount = Math.floor((this.instanceCount + MAX_GROUP_DISPATCH_COUNT - 1) / MAX_GROUP_DISPATCH_COUNT);
            for (let i = 0; i < dispatchCount; i++) {
                const offset = dispatchCount * i;
                let count = this.instanceCount - offset;
                if (count > MAX_GROUP_DISPATCH_COUNT) {
                    count = MAX_GROUP_DISPATCH_COUNT;
                }
                Nri_StoreInt32(Ref(this.drawParams[0]), offset);
                Nri_StoreInt32(Ref(this.drawParams[1]), count);
                Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.drawParams[0]), DRAW_PARAMS_SIZE);
                Nri_CmdDrawMeshTasks(commandBuffer, count, 1, 1);
            }
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.update(queuedFrameIndex * CONSTANTS_SIZE);

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: cleared, the dragons.
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                    Nri_CmdClearColor(commandBuffer, CLEAR_R, CLEAR_G, CLEAR_B, 1.0);
                    Nri_CmdClearDepth(commandBuffer, 1.0);
                    this.recordDraw(commandBuffer, this.descriptorSets[queuedFrameIndex]);
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
                for (const queuedFrame of this.queuedFrames) {
                    Nri_DestroyCommandBuffer(queuedFrame.commandBuffer);
                    Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
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
                for (const view of this.constantViews) {
                    Nri_DestroyDescriptor(view);
                }
                for (const view of this.meshInfoViews) {
                    Nri_DestroyDescriptor(view);
                }
                for (const lod of this.lods) {
                    this.destroyShaderBuffer(lod.vertices);
                    this.destroyShaderBuffer(lod.meshlets);
                    this.destroyShaderBuffer(lod.uniqueVertexIndices);
                    this.destroyShaderBuffer(lod.primitives);
                }
                for (const placeholder of this.placeholders) {
                    this.destroyShaderBuffer(placeholder);
                }
                this.destroyInstanceBuffer();
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.meshInfoBuffer);
                this.destroyBuffer(this.readbackBuffer);
                const depthAttachment = this.depthAttachment;
                if (depthAttachment) {
                    Nri_DestroyDescriptor(depthAttachment);
                }
                const depthTexture = this.depthTexture;
                if (depthTexture) {
                    Nri_DestroyTexture(depthTexture);
                }
                const pipeline = this.pipeline;
                if (pipeline) {
                    Nri_DestroyPipeline(pipeline);
                }
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

        destroyShaderBuffer(shaderBuffer: ShaderBuffer) {
            Nri_DestroyDescriptor(shaderBuffer.view);
            Nri_DestroyBuffer(shaderBuffer.buffer);
        }

        destroyBuffer(buffer: NriBufferHandle | null) {
            if (buffer) {
                Nri_DestroyBuffer(buffer);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const dynamicLod = new DynamicLod(sample);
        // -instanceLevel <n>: start at instance level n (0 by default, as the sample; 2 for -test).
        Nri_AddExampleOptionWithValues(sample, "-instanceLevel", 1);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-instanceLevel" && i + 1 < argc) {
                i++;
                dynamicLod.instanceLevel = parseInt(Nri_GetArg(argc, argv, i));
            }
        }
        return dynamicLod.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return DynamicLodNri.main(argc, argv);
}

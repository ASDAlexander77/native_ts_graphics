/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { MeshletModel } from "../../core/meshlet_model";
import {
    matrixInverse, matrixMultiply, matrixPerspectiveFovRH, matrixTranslation, matrixTranspose,
    planeNormalize, row, vadd, vsub, XM_PI,
} from "../../core/directx_math";
import { SimpleCamera } from "../../core/simple_camera";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriFile, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace DynamicLodNri {
    // dynamic_lod, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut
    // and NVRHI: the same shaders (dynamic_lod.hlsl's) and models (core/meshlet_model.cpp reads
    // them), through the NRI calls core/nri/nri_interop.d.ts binds. This example creates everything
    // it runs, and does the rendering. SimpleCamera's keys are Donut's Key values (GLFW's key codes),
    // which NriSample.isKeyPressed takes.

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

    // A buffer the shaders read and its view.
    class ShaderBuffer {
        constructor(public buffer: NriBuffer, public view: NriDescriptor) {
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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private viewFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private pipelineLayout: NriPipelineLayout | null = null;
        private pipeline: NriPipeline | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        // A queued frame's each (their constants differ).
        private descriptorSets: NriDescriptorSet[] = [];
        private constantBuffer: NriBuffer | null = null;
        private constantViews: NriDescriptor[] = [];
        // MeshInfo per LOD slot.
        private meshInfoBuffer: NriBuffer | null = null;
        private meshInfoViews: NriDescriptor[] = [];
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
        // The swap chain textures' format (the swap chain's).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // -instanceLevel <n>: the instance level (0 by default, as the sample; 2 for -test).
        instanceLevel: int = -1;
        instanceCount: int = 1;
        renderMode: int = RENDER_MODE_LOD;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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
            this.sample.setInitializeCallback(initialize);
            this.sample.setLatencySleepCallback(latencySleep);
            this.sample.setRenderFrameCallback(renderFrame);

            // On a wrapper of its own: the callbacks Nri_RunSample runs may overwrite this.sample.
            let result = new NriSample(this.sample.handle).run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (this.unsupportedReason != "") {
                const test = this.sample.isTest() != 0;
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
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // Swap chain: rendered through UNORM views, as the sample's R8G8B8A8_UNORM back buffer.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, false);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);

            if (device.isFeatureSupported(NriFeature.MeshShader) == 0) {
                this.unsupportedReason = "The graphics device has no mesh shaders";
                return 0;
            }

            // The sample's depth buffer: D32, cleared to 1.
            if (!this.createDepth(device)) {
                return 0;
            }

            // The sample's root signature: CBV(b0), RootConstants(b1, 2), a descriptor table of
            // CBV(b2, 8) and SRV(t0, 32) (vertices, meshlets, unique vertex indices, primitives: 8
            // each), SRV(t32). Here one descriptor set (space 0) with the root constants.
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRootConstants(1, DRAW_PARAMS_SIZE, NriStage.AllGraphics);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.AllGraphics, NriRangeFlags.None);
            layoutDesc.addRange(0, 2, MAX_LOD_LEVELS, NriDescriptorType.ConstantBuffer, NriStage.AllGraphics,
                NriRangeFlags.Array);
            layoutDesc.addRange(0, 0, MAX_LOD_LEVELS, NriDescriptorType.StructuredBuffer, NriStage.AllGraphics,
                NriRangeFlags.Array);
            layoutDesc.addRange(0, 8, MAX_LOD_LEVELS, NriDescriptorType.StructuredBuffer, NriStage.AllGraphics,
                NriRangeFlags.Array);
            layoutDesc.addRange(0, 16, MAX_LOD_LEVELS, NriDescriptorType.StructuredBuffer, NriStage.AllGraphics,
                NriRangeFlags.Array);
            layoutDesc.addRange(0, 24, MAX_LOD_LEVELS, NriDescriptorType.StructuredBuffer, NriStage.AllGraphics,
                NriRangeFlags.Array);
            layoutDesc.addRange(0, 32, 1, NriDescriptorType.StructuredBuffer, NriStage.AllGraphics, NriRangeFlags.None);
            this.pipelineLayout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
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
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Task, `${shaders}_main_as.bin`, "main_as") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Mesh, `${shaders}_main_ms.bin`, "main_ms") != 0;
            }
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_main_ps.bin`, "main_ps") != 0;
            }
            desc.setCullMode(NriCullMode.Back);
            desc.setColor(format, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.Less, 1, 0);
            if (loaded) {
                this.pipeline = device.createPipelineFromDesc(pipelineLayout, desc);
            }
            desc.destroy();
            if (!this.pipeline) {
                console.log("Cannot load the dynamic LOD shaders");
                return 0;
            }

            // The constants, a queued frame's each; MeshInfo per LOD slot.
            const constantBuffer = device.createHostBuffer(queuedFrameNum * CONSTANTS_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const meshInfoBuffer = device.createHostBuffer(MAX_LOD_LEVELS * MESH_INFO_SIZE, NriBufferUsage.ConstantBuffer);
            this.meshInfoBuffer = meshInfoBuffer;
            if (!constantBuffer || !meshInfoBuffer) {
                console.log("Cannot create the constant buffers");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const view = constantBuffer.createConstantView(i * CONSTANTS_SIZE, CONSTANTS_SIZE);
                if (!view) {
                    console.log("Cannot create the constant buffer views");
                    return 0;
                }
                this.constantViews.push(view);
            }
            for (let i = 0; i < MAX_LOD_LEVELS; i++) {
                const view = meshInfoBuffer.createConstantView(i * MESH_INFO_SIZE, MESH_INFO_SIZE);
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
            const descriptorPool = device.createDescriptorPoolWithBuffers(queuedFrameNum, 0, (1 + MAX_LOD_LEVELS) * queuedFrameNum, 0, 0,
                (4 * MAX_LOD_LEVELS + 1) * queuedFrameNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!descriptorPool) {
                console.log("Cannot create the descriptor pool");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const set = descriptorPool.allocateDescriptorSet(pipelineLayout, 0, 0);
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
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // A buffer of byteSize bytes of data (ints), structures stride bytes each (4: raw, a
        // ByteAddressBuffer), and its view; null on failure.
        createShaderBuffer(device: NriDevice, data: int[], byteSize: int, stride: int): ShaderBuffer | null {
            const buffer = device.createUploadedStructuredBufferFromInts(this.queue, Ref(data[0]), byteSize, stride);
            if (!buffer) {
                return null;
            }
            const view = buffer.createStructuredView(0);
            if (!view) {
                buffer.destroy();
                return null;
            }
            return new ShaderBuffer(buffer, view);
        }

        // Model::LoadFromFile and UploadGpuResources, for each LOD's first mesh: its MeshInfo and
        // buffers for the shaders; then the placeholders.
        loadLods(device: NriDevice, meshInfoBuffer: NriBuffer): boolean {
            const meshInfo: f32[] = [0.0, 0.0, 0.0, 0.0];
            for (let l = 0; l < LOD_FILES.length; l++) {
                const path = MEDIA_DIR + LOD_FILES[l];
                const file = NriFile.load(path);
                if (!file) {
                    console.log(`Cannot load ${path} (the sample's model: build with DIRECTX_GRAPHICS_SAMPLES_DIR set)`);
                    return false;
                }
                const loaded = MeshletModel.load(file.getData(), file.getSize());
                file.destroy();
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
                Nri.storeInt32(Ref(meshInfo[0]), model.getIndexSize(0));
                Nri.storeInt32(Ref(meshInfo[1]), meshletCount);
                Nri.storeInt32(Ref(meshInfo[2]), meshlets[(meshletCount - 1) * 4]);
                Nri.storeInt32(Ref(meshInfo[3]), meshlets[(meshletCount - 1) * 4 + 2]);
                meshInfoBuffer.write(l * MESH_INFO_SIZE, Ref(meshInfo[0]), 16);

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
                meshInfoBuffer.write(l * MESH_INFO_SIZE, Ref(meshInfo[0]), 16);
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
        updateDescriptorSet(set: NriDescriptorSet, queuedFrameIndex: int) {
            set.updateDescriptor(RANGE_CONSTANTS, 0, this.constantViews[queuedFrameIndex]);
            const raw = this.placeholders[0];
            const meshlet = this.placeholders[1];
            for (let i = 0; i < MAX_LOD_LEVELS; i++) {
                set.updateDescriptor(RANGE_MESH_INFO, i, this.meshInfoViews[i]);
                if (i < this.lods.length) {
                    const lod = this.lods[i];
                    set.updateDescriptor(RANGE_VERTICES, i, lod.vertices.view);
                    set.updateDescriptor(RANGE_MESHLETS, i, lod.meshlets.view);
                    set.updateDescriptor(RANGE_UNIQUE_VERTEX_INDICES, i, lod.uniqueVertexIndices.view);
                    set.updateDescriptor(RANGE_PRIMITIVE_INDICES, i, lod.primitives.view);
                } else {
                    set.updateDescriptor(RANGE_VERTICES, i, raw.view);
                    set.updateDescriptor(RANGE_MESHLETS, i, meshlet.view);
                    set.updateDescriptor(RANGE_UNIQUE_VERTEX_INDICES, i, raw.view);
                    set.updateDescriptor(RANGE_PRIMITIVE_INDICES, i, raw.view);
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
                device.waitIdle();
                this.destroyInstanceBuffer();
                this.instanceCapacity = this.instanceCount;
                const buffer = device.createHostBufferWithStride(this.instanceCapacity * INSTANCE_STRIDE, NriBufferUsage.StructuredBuffer,
                    INSTANCE_STRIDE);
                if (!buffer) {
                    return false;
                }
                const view = buffer.createStructuredView(0);
                if (!view) {
                    buffer.destroy();
                    return false;
                }
                this.instanceBuffer = new ShaderBuffer(buffer, view);
                for (const set of this.descriptorSets) {
                    set.updateDescriptor(RANGE_INSTANCES, 0, view);
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
                instanceBuffer.view.destroy();
                instanceBuffer.buffer.destroy();
            }
            this.instanceBuffer = null;
        }

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // OnKeyDown: + and - change the instance level, Space the render mode (when pressed).
        handleKeys() {
            for (let k = 0; k < ACTION_KEYS.length; k++) {
                const key = ACTION_KEYS[k];
                const down = this.sample.isKeyPressed(key) != 0;
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
                this.camera.onKey(key, this.sample.isKeyPressed(key) != 0);
            }
            this.camera.update(Math.fround(this.test ? 1.0 / 60.0 : this.sample.getFrameTime()));
            this.sample.setWindowTitle(`${WINDOW_TITLE} (${this.instanceCount} instances)`);

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
            Nri.storeInt32(Ref(c[RENDER_MODE_FLOAT]), this.renderMode);
            Nri.storeInt32(Ref(c[LOD_COUNT_FLOAT]), LOD_FILES.length);
            constantBuffer.write(constantsOffset, Ref(c[0]), CONSTANT_FLOATS * 4);

            // Only upload instance data if it changed (the GPU done with the old: see
            // regenerateInstances, and the wait here).
            const instanceBuffer = this.instanceBuffer;
            if (this.updateInstances) {
                const device = this.device;
                if (instanceBuffer) {
                    if (device) {
                        device.waitIdle();
                    }
                    instanceBuffer.buffer.write(0, Ref(this.instanceData[0]), this.instanceCount * INSTANCE_STRIDE);
                }
                this.updateInstances = false;
            }
        }

        // PopulateCommandList's draws (between NriCommandBuffer.beginRenderingWithDepth and
        // NriCommandBuffer.endRendering): an amplification shader group per instance, in batches of at most
        // MAX_GROUP_DISPATCH_COUNT, starting at dispatchCount * i as the sample's.
        recordDraw(commandBuffer: NriCommandBuffer, set: NriDescriptorSet) {
            const pipelineLayout = this.pipelineLayout;
            const pipeline = this.pipeline;
            const descriptorPool = this.descriptorPool;
            if (!pipelineLayout || !pipeline || !descriptorPool) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(pipelineLayout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setDescriptorSet(0, set);
            const dispatchCount = Math.floor((this.instanceCount + MAX_GROUP_DISPATCH_COUNT - 1) / MAX_GROUP_DISPATCH_COUNT);
            for (let i = 0; i < dispatchCount; i++) {
                const offset = dispatchCount * i;
                let count = this.instanceCount - offset;
                if (count > MAX_GROUP_DISPATCH_COUNT) {
                    count = MAX_GROUP_DISPATCH_COUNT;
                }
                Nri.storeInt32(Ref(this.drawParams[0]), offset);
                Nri.storeInt32(Ref(this.drawParams[1]), count);
                commandBuffer.setRootConstants(0, Ref(this.drawParams[0]), DRAW_PARAMS_SIZE);
                commandBuffer.drawMeshTasks(count, 1, 1);
            }
        }

        // The swap chain's size and formats (its views in the textures' format).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The depth buffer at the swap chain's size.
        createDepth(device: NriDevice): boolean {
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return false;
            }
            this.depthAttachment = depthTexture.createDepthAttachmentView(NriFormat.D32_SFLOAT);
            return true;
        }

        destroyDepth() {
            const depthAttachment = this.depthAttachment;
            if (depthAttachment) {
                depthAttachment.destroy();
            }
            this.depthAttachment = null;
            const depthTexture = this.depthTexture;
            if (depthTexture) {
                depthTexture.destroy();
            }
            this.depthTexture = null;
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain and the depth buffer made
        // again at its size, once the GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            device.waitIdle();
            this.destroyDepth();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.createDepth(device);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.frames.size();
            this.update(queuedFrameIndex * CONSTANTS_SIZE);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: cleared, the dragons.
                commandBuffer.begin();
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
                    commandBuffer.clearColor(CLEAR_R, CLEAR_G, CLEAR_B, 1.0);
                    commandBuffer.clearDepth(1.0);
                    this.recordDraw(commandBuffer, this.descriptorSets[queuedFrameIndex]);
                    commandBuffer.endRendering();
                }

                // The test's last frame: read back
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        commandBuffer.textureBarrier(texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                        commandBuffer.readbackTextureToBuffer(readbackBuffer, this.rowPitch, texture, this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                    }
                }
                commandBuffer.textureBarrier(texture, presentFrom, NriTextureState.Present);
                commandBuffer.end();

                // Submit and present
                this.swapChain.submit(commandBuffer, index);
                this.swapChain.present(index);
            }

            // Signaled after the present, as NRISamples do
            this.frames.signal(frameIndex);
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
                for (const view of this.constantViews) {
                    view.destroy();
                }
                for (const view of this.meshInfoViews) {
                    view.destroy();
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
                    depthAttachment.destroy();
                }
                const depthTexture = this.depthTexture;
                if (depthTexture) {
                    depthTexture.destroy();
                }
                const pipeline = this.pipeline;
                if (pipeline) {
                    pipeline.destroy();
                }
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    pipelineLayout.destroy();
                }
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }

        destroyShaderBuffer(shaderBuffer: ShaderBuffer) {
            shaderBuffer.view.destroy();
            shaderBuffer.buffer.destroy();
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
        const dynamicLod = new DynamicLod(sample);
        // -instanceLevel <n>: start at instance level n (0 by default, as the sample; 2 for -test).
        sample.addExampleOptionWithValues("-instanceLevel", 1);
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-instanceLevel" && i + 1 < argc) {
                i++;
                dynamicLod.instanceLevel = parseInt(Nri.getArg(argc, argv, i));
            }
        }
        return dynamicLod.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return DynamicLodNri.main(argc, argv);
}

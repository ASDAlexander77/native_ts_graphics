/// <reference path="../../core/nri/nri_interop.d.ts" />
import { MeshletModel } from "../../core/meshlet_model";
import {
    matrixInverse, matrixMultiply, matrixPerspectiveFovRH, matrixTranslation, matrixTranspose,
    XM_PI,
} from "../../core/directx_math";
import { SimpleCamera } from "../../core/simple_camera";

namespace MeshletInstancingNri {
    // meshlet_instancing, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (meshlet_instancing.hlsl's, the D3D12MeshShaders
    // MeshletInstancing sample's) and model loader (core/meshlet_model.cpp), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as meshlet_render_nri draws. SimpleCamera's keys are Donut's
    // Key values (GLFW's key codes), which Nri_IsKeyPressed takes.

    const WINDOW_TITLE = "NRI Example: D3D12 Mesh Shader Instancing";
    const MESH_FILE = "media/meshlet_instancing/ToyRobot.bin";

    // Shared.h: what a mesh shader group outputs at most.
    const MAX_VERTS = 64;
    const MAX_PRIMS = 126;
    // The most groups a DispatchMesh launches here (1D).
    const MAX_GROUP_DISPATCH_COUNT = 65536.0;

    // SceneConstantBuffer: View, ViewProj (float4x4 each), DrawMeshlets (uint), 256-byte aligned; a
    // queued frame's each.
    const CONSTANTS_SIZE = 256;
    const CONSTANT_FLOATS = 33;
    const DRAW_MESHLETS_INDEX = 32;
    // The push constants: InstanceCount, InstanceOffset, IndexBytes, MeshletCount, MeshletOffset.
    const PARAMS_SIZE = 20;
    // The mesh shader's vertex records (position, normal), Meshlet (4 uints) and Instance (World,
    // WorldInvTranspose).
    const VERTEX_STRIDE = 24;
    const MESHLET_STRIDE = 16;
    const INSTANCE_STRIDE = 128;

    // The sample's clear color, (0, 0.2, 0.4).
    const CLEAR_R = 0.0;
    const CLEAR_G = 0.2;
    const CLEAR_B = 0.4;

    // Test mode: the frames rendered, each 1/60 s, at instance level 2 (125 robots), so that groups
    // pack several instances of the last meshlets.
    const TEST_FRAMES = 3;
    const TEST_LEVEL = 2;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no mesh shaders.
    const TEST_SKIPPED = 77;

    // SimpleCamera's keys.
    const CAMERA_KEYS = [Key.W, Key.A, Key.S, Key.D, Key.Left, Key.Right, Key.Up, Key.Down];

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

    // A mesh of the model on the GPU: its buffers (vertices, meshlets, unique vertex indices,
    // primitives) and their views, its index size, its meshlet subsets (offset, count pairs) with
    // their last meshlet's pack counts.
    class GpuMesh {
        buffers: NriBufferHandle[] = [];
        views: NriDescriptorHandle[] = [];
        subsets: int[] = [];
        packCounts: int[] = [];

        constructor(public indexSize: int) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does, at instance level 2 (125
    // robots around the camera). They cover most of the frame but not all of it (the clear color
    // shows between them), in meshlet colors: some pixels without red (odd meshlets), some with.
    function checkFrame(pixels: int[], width: int, height: int, instanceCount: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        if (instanceCount != 125) {
            return `${instanceCount} instances, not 125`;
        }
        const background = 0 | (51 << 8) | (102 << 16);
        let covered = 0;
        let noRed = 0;
        let red = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            if (p != background) {
                covered++;
                if ((p & 0xFF) == 0) {
                    noRed++;
                } else {
                    red++;
                }
            }
        }
        const coverage = covered / (width * height);
        console.log(`Coverage ${coverage}, pixels without red ${noRed}, with red ${red}`);
        // The camera is among the robots: they cover most of the frame, the clear color between them.
        if (coverage < 0.5 || coverage > 0.98) {
            return `the robots cover ${coverage} of the frame`;
        }
        if (noRed < covered / 10 || red < covered / 10) {
            return `no meshlet colors: ${noRed} pixels without red, ${red} with`;
        }
        return "";
    }

    // Port of DirectX-Graphics-Samples' D3D12MeshShaders MeshletInstancing (as
    // examples/meshlet_instancing.ts ports it) to NRI: a cube of toy robots ((2 level + 1)^3 of them;
    // + and - change the level) drawn by a mesh shader alone, a group per meshlet and instance but for
    // each subset's last meshlet, of which as many instances as fit share a group; the dispatches are
    // cut into batches of at most 65536 groups. Space switches the meshlet colors. The sample's root
    // signature is the pipeline layout: its constant buffer and buffers root descriptors, its root
    // constants root constants. Drawn straight into the swap chain texture (the sample's
    // R8G8B8A8_UNORM back buffer) with a D32 depth buffer, where the Donut example draws into a color
    // target it blits. The instances are in a buffer the CPU writes, written when they change (after
    // waiting for the GPU, as the sample does when it makes the buffer larger).
    class MeshletInstancing {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private pipelineLayout: NriPipelineLayoutHandle | null = null;
        private pipeline: NriPipelineHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private constantBufferView: NriDescriptorHandle | null = null;
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private meshes: GpuMesh[] = [];
        private instanceBuffer: NriBufferHandle | null = null;
        private instanceView: NriDescriptorHandle | null = null;
        private instanceCapacity: int = 0;
        private width: int = 0;
        private height: int = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        private constants: f32[] = [];
        private params: f32[] = [0.0, 0.0, 0.0, 0.0, 0.0];
        private camera: SimpleCamera = new SimpleCamera();
        private radius: number = 0.0;
        instanceLevel: int = 0;
        instanceCount: int = 1;
        drawMeshlets: boolean = true;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < CONSTANT_FLOATS; i++) {
                this.constants.push(0.0);
            }
            // The sample's camera: at (0, 5, 35), 60 units a second.
            this.camera.init(0.0, 5.0, 35.0);
            this.camera.setMoveSpeed(60.0);
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

            // Swap chain: the sample's R8G8B8A8_UNORM back buffers, rendered into as they are.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, queuedFrameNum + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
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

            // The sample's root signature: CBV(b0), RootConstants(b1, 2), RootConstants(b2, 3),
            // SRV(t0) .. SRV(t4); its root constants one block of push constants.
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(layoutDesc, 1, PARAMS_SIZE, NriStage.AllGraphics);
            Nri_PipelineLayoutDescAddRootDescriptor(layoutDesc, 0, NriDescriptorType.ConstantBuffer, NriStage.AllGraphics);
            for (let t = 0; t < 5; t++) {
                Nri_PipelineLayoutDescAddRootDescriptor(layoutDesc, t, NriDescriptorType.StructuredBuffer, NriStage.AllGraphics);
            }
            this.pipelineLayout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The sample's pipeline state: the default rasterizer state (back faces culled), blend
            // state (opaque) and depth state (less, writes).
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/meshlet_instancing/${folder}/meshlet_instancing`;
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Mesh, `${shaders}_main_ms.bin`, "main_ms") != 0;
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
                console.log("Cannot load the meshlet instancing shaders");
                return 0;
            }

            // The constants, a queued frame's each; the depth buffer.
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * CONSTANTS_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!constantBuffer || !depthTexture) {
                console.log("Cannot create the constant buffer and depth buffer");
                return 0;
            }
            this.constantBufferView = Nri_CreateConstantBufferView(constantBuffer, 0, CONSTANTS_SIZE);
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            if (!this.loadModel(device)) {
                return 0;
            }
            // In test mode, instance level 2.
            if (this.test) {
                this.instanceLevel = TEST_LEVEL;
            }
            if (!this.regenerateInstances(device)) {
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

        // Model::LoadFromFile and UploadGpuResources: each mesh's vertices, meshlets, unique vertex
        // indices and primitives in buffers for the mesh shader (the byte address buffers' structures
        // 4 bytes: raw views), its subsets and their pack counts.
        loadModel(device: NriDeviceHandle): boolean {
            const file = Nri_LoadFile(MESH_FILE);
            if (!file) {
                console.log(`Cannot load ${MESH_FILE} (the sample's model: build with DIRECTX_GRAPHICS_SAMPLES_DIR set)`);
                return false;
            }
            const model = MeshletModel.load(Nri_GetFileData(file), Nri_GetFileSize(file));
            Nri_DestroyFile(file);
            if (model.isNull()) {
                return false;
            }
            const sphere: f32[] = [0.0, 0.0, 0.0, 0.0];
            model.copyBoundingSphere(-1, Ref(sphere[0]));
            this.radius = sphere[3];

            let ok = true;
            const meshCount = model.getMeshCount();
            for (let i = 0; i < meshCount; i++) {
                if (model.getVertexBufferStride(i, 0) != VERTEX_STRIDE) {
                    console.log(`${MESH_FILE}: vertices of another layout than the mesh shader's`);
                    ok = false;
                    break;
                }
                const mesh = new GpuMesh(model.getIndexSize(i));
                this.meshes.push(mesh);
                const meshletCount = model.getDataCount(i, MeshletModelData.Meshlets);
                this.addBuffer(mesh, Nri_CreateUploadedStructuredBufferFromPointer(device, this.queue, model.getVertexBufferData(i, 0),
                    model.getVertexBufferSize(i, 0), 4));
                this.addBuffer(mesh, Nri_CreateUploadedStructuredBufferFromPointer(device, this.queue,
                    model.getData(i, MeshletModelData.Meshlets), meshletCount * MESHLET_STRIDE, MESHLET_STRIDE));
                // The unique vertex indices, rounded up to whole uints, as the sample's buffer.
                const uniqueSize = model.getDataSize(i, MeshletModelData.UniqueVertexIndices);
                const uniqueInts = Math.floor((uniqueSize + 3) / 4);
                const unique: int[] = [];
                for (let j = 0; j < uniqueInts; j++) {
                    unique.push(0);
                }
                model.copyData(i, MeshletModelData.UniqueVertexIndices, Ref(unique[0]));
                this.addBuffer(mesh, Nri_CreateUploadedStructuredBufferFromInts(device, this.queue, Ref(unique[0]), uniqueInts * 4, 4));
                const primitiveCount = model.getDataCount(i, MeshletModelData.PrimitiveIndices);
                this.addBuffer(mesh, Nri_CreateUploadedStructuredBufferFromPointer(device, this.queue,
                    model.getData(i, MeshletModelData.PrimitiveIndices), primitiveCount * 4, 4));
                if (mesh.views.length != 4) {
                    console.log(`Cannot upload ${MESH_FILE}`);
                    ok = false;
                    break;
                }

                const meshlets: int[] = [];
                for (let j = 0; j < meshletCount * 4; j++) {
                    meshlets.push(0);
                }
                model.copyData(i, MeshletModelData.Meshlets, Ref(meshlets[0]));
                const subsetCount = model.getDataCount(i, MeshletModelData.MeshletSubsets);
                for (let j = 0; j < subsetCount * 2; j++) {
                    mesh.subsets.push(0);
                }
                model.copyData(i, MeshletModelData.MeshletSubsets, Ref(mesh.subsets[0]));
                // GetLastMeshletPackCount: how many instances of the subset's last meshlet fit a group.
                for (let s = 0; s < subsetCount; s++) {
                    const last = mesh.subsets[s * 2] + mesh.subsets[s * 2 + 1] - 1;
                    const byVerts = Math.floor(MAX_VERTS / meshlets[last * 4]);
                    const byPrims = Math.floor(MAX_PRIMS / meshlets[last * 4 + 2]);
                    mesh.packCounts.push(byVerts < byPrims ? byVerts : byPrims);
                }
            }
            model.destroy();
            return ok;
        }

        // A mesh's next buffer and its view, if it was made.
        addBuffer(mesh: GpuMesh, buffer: NriBufferHandle | null) {
            if (!buffer) {
                return;
            }
            mesh.buffers.push(buffer);
            const view = Nri_CreateStructuredBufferView(buffer, 0);
            if (view) {
                mesh.views.push(view);
            }
        }

        // RegenerateInstances: the instances in a cube growing with the level, a bounding sphere's
        // diameter apart, written into the instance buffer (made larger when they don't fit) once the
        // GPU is done with it; false if it can't be made.
        regenerateInstances(device: NriDeviceHandle): boolean {
            const spacing = Math.fround(Math.fround(1.0 * this.radius) * 2.0);
            const width = this.instanceLevel * 2 + 1;
            const extents = Math.fround(spacing * this.instanceLevel);
            this.instanceCount = width * width * width;

            Nri_DeviceWaitIdle(device);
            if (this.instanceCount > this.instanceCapacity) {
                this.destroyInstanceBuffer();
                this.instanceCapacity = this.instanceCount;
                const buffer = Nri_CreateHostBufferWithStride(device, this.instanceCapacity * INSTANCE_STRIDE, NriBufferUsage.StructuredBuffer,
                    INSTANCE_STRIDE);
                if (!buffer) {
                    return false;
                }
                this.instanceBuffer = buffer;
                this.instanceView = Nri_CreateStructuredBufferView(buffer, 0);
            }
            const instanceBuffer = this.instanceBuffer;
            if (!instanceBuffer) {
                return false;
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
            }
            Nri_WriteBuffer(instanceBuffer, 0, Ref(data[0]), this.instanceCount * INSTANCE_STRIDE);
            return true;
        }

        destroyInstanceBuffer() {
            const instanceView = this.instanceView;
            if (instanceView) {
                Nri_DestroyDescriptor(instanceView);
            }
            const instanceBuffer = this.instanceBuffer;
            if (instanceBuffer) {
                Nri_DestroyBuffer(instanceBuffer);
            }
            this.instanceView = null;
            this.instanceBuffer = null;
        }

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // OnKeyDown: + and - change the instance level, Space switches the meshlet colors.
        onKeys(device: NriDeviceHandle) {
            if (Nri_IsKeyToggled(this.sample, NriKey.Equal) != 0 || Nri_IsKeyToggled(this.sample, NriKey.KpAdd) != 0) {
                this.instanceLevel++;
                this.regenerateInstances(device);
            }
            if (Nri_IsKeyToggled(this.sample, NriKey.Minus) != 0 || Nri_IsKeyToggled(this.sample, NriKey.KpSubtract) != 0) {
                if (this.instanceLevel != 0) {
                    this.instanceLevel--;
                    this.regenerateInstances(device);
                }
            }
            if (Nri_IsKeyToggled(this.sample, NriKey.Space) != 0) {
                this.drawMeshlets = !this.drawMeshlets;
            }
        }

        // OnUpdate: the keys, the camera (in test mode 1/60 second a frame, as Donut's test mode),
        // then the constants for its view: a 60 degree perspective (near 1, far 10000).
        update(device: NriDeviceHandle, constantsOffset: int, constantBuffer: NriBufferHandle) {
            if (!this.test) {
                this.onKeys(device);
            }
            for (const key of CAMERA_KEYS) {
                this.camera.onKey(key, Nri_IsKeyPressed(this.sample, key) != 0);
            }
            this.camera.update(Math.fround(this.test ? 1.0 / 60.0 : Nri_GetFrameTime(this.sample)));
            Nri_SetWindowTitle(this.sample, `${WINDOW_TITLE} (${this.instanceCount} instances)`);

            const view = this.camera.viewMatrix();
            const proj = matrixPerspectiveFovRH(Math.fround(XM_PI / 3.0), Math.fround(this.width / this.height), 1.0, 10000.0);
            const viewT = matrixTranspose(view);
            const viewProjT = matrixTranspose(matrixMultiply(view, proj));
            for (let i = 0; i < 16; i++) {
                this.constants[i] = viewT[i];
                this.constants[16 + i] = viewProjT[i];
            }
            Nri_StoreInt32(Ref(this.constants[DRAW_MESHLETS_INDEX]), this.drawMeshlets ? 1 : 0);
            Nri_WriteBuffer(constantBuffer, constantsOffset, Ref(this.constants[0]), CONSTANT_FLOATS * 4);
        }

        // PopulateCommandList's draws: per mesh and subset, the instances in batches of at most
        // 65536 groups (between Nri_CmdBeginRendering and Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle, constantsOffset: int) {
            const pipelineLayout = this.pipelineLayout;
            const pipeline = this.pipeline;
            const constantBufferView = this.constantBufferView;
            const instanceView = this.instanceView;
            if (!pipelineLayout || !pipeline || !constantBufferView || !instanceView) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, pipelineLayout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetRootDescriptor(commandBuffer, 0, constantBufferView, constantsOffset);
            Nri_CmdSetRootDescriptor(commandBuffer, 5, instanceView, 0);
            for (const mesh of this.meshes) {
                for (let t = 0; t < 4; t++) {
                    Nri_CmdSetRootDescriptor(commandBuffer, 1 + t, mesh.views[t], 0);
                }
                for (let s = 0; s < mesh.packCounts.length; s++) {
                    const subsetOffset = mesh.subsets[s * 2];
                    const subsetCount = mesh.subsets[s * 2 + 1];
                    const groupsPerInstance = Math.fround((subsetCount - 1) + Math.fround(1.0 / mesh.packCounts[s]));
                    const maxInstancePerBatch: int = Math.floor(Math.fround(MAX_GROUP_DISPATCH_COUNT / groupsPerInstance));
                    const dispatchCount = Math.floor((this.instanceCount + maxInstancePerBatch - 1) / maxInstancePerBatch);
                    for (let j = 0; j < dispatchCount; j++) {
                        const instanceOffset = maxInstancePerBatch * j;
                        let instanceCount = this.instanceCount - instanceOffset;
                        if (instanceCount > maxInstancePerBatch) {
                            instanceCount = maxInstancePerBatch;
                        }
                        Nri_StoreInt32(Ref(this.params[0]), instanceCount);
                        Nri_StoreInt32(Ref(this.params[1]), instanceOffset);
                        Nri_StoreInt32(Ref(this.params[2]), mesh.indexSize);
                        Nri_StoreInt32(Ref(this.params[3]), subsetCount);
                        Nri_StoreInt32(Ref(this.params[4]), subsetOffset);
                        const groupCount: int = Math.ceil(Math.fround(groupsPerInstance * instanceCount));
                        Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.params[0]), PARAMS_SIZE);
                        Nri_CmdDrawMeshTasks(commandBuffer, groupCount, 1, 1);
                    }
                }
            }
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            const constantsOffset = queuedFrameIndex * CONSTANTS_SIZE;
            const device = this.device;
            const constantBuffer = this.constantBuffer;
            const depthAttachment = this.depthAttachment;
            if (!device || !constantBuffer || !depthAttachment) {
                return;
            }
            this.update(device, constantsOffset, constantBuffer);

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: cleared, the robots.
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                Nri_CmdClearColor(commandBuffer, CLEAR_R, CLEAR_G, CLEAR_B, 1.0);
                Nri_CmdClearDepth(commandBuffer, 1.0);
                this.recordDraw(commandBuffer, constantsOffset);
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
                for (const mesh of this.meshes) {
                    for (const view of mesh.views) {
                        Nri_DestroyDescriptor(view);
                    }
                    for (const buffer of mesh.buffers) {
                        Nri_DestroyBuffer(buffer);
                    }
                }
                this.destroyInstanceBuffer();
                const constantBufferView = this.constantBufferView;
                if (constantBufferView) {
                    Nri_DestroyDescriptor(constantBufferView);
                }
                const constantBuffer = this.constantBuffer;
                if (constantBuffer) {
                    Nri_DestroyBuffer(constantBuffer);
                }
                const depthAttachment = this.depthAttachment;
                if (depthAttachment) {
                    Nri_DestroyDescriptor(depthAttachment);
                }
                const depthTexture = this.depthTexture;
                if (depthTexture) {
                    Nri_DestroyTexture(depthTexture);
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
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
    }

    export function main(argc: int, argv: Ref<string>) {
        const meshletInstancing = new MeshletInstancing(Nri_CreateSample());
        return meshletInstancing.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return MeshletInstancingNri.main(argc, argv);
}

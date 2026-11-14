/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { MeshletModel } from "../../core/meshlet_model";
import {
    matrixInverse, matrixMultiply, matrixPerspectiveFovRH, matrixTranslation, matrixTranspose,
    XM_PI,
} from "../../core/directx_math";
import { SimpleCamera } from "../../core/simple_camera";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDevice, NriFile, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace MeshletInstancingNri {
    // meshlet_instancing, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (meshlet_instancing.hlsl's, the D3D12MeshShaders
    // MeshletInstancing sample's) and model loader (core/meshlet_model.cpp), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as meshlet_render_nri draws. SimpleCamera's keys are Donut's
    // Key values (GLFW's key codes), which NriSample.isKeyPressed takes.

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

    // A mesh of the model on the GPU: its buffers (vertices, meshlets, unique vertex indices,
    // primitives) and their views, its index size, its meshlet subsets (offset, count pairs) with
    // their last meshlet's pack counts.
    class GpuMesh {
        buffers: NriBuffer[] = [];
        views: NriDescriptor[] = [];
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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private pipelineLayout: NriPipelineLayout | null = null;
        private pipeline: NriPipeline | null = null;
        private constantBuffer: NriBuffer | null = null;
        private constantBufferView: NriDescriptor | null = null;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private meshes: GpuMesh[] = [];
        private instanceBuffer: NriBuffer | null = null;
        private instanceView: NriDescriptor | null = null;
        private instanceCapacity: int = 0;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;
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
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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

            // Swap chain: the sample's R8G8B8A8_UNORM back buffers, rendered into as they are.
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

            // The sample's root signature: CBV(b0), RootConstants(b1, 2), RootConstants(b2, 3),
            // SRV(t0) .. SRV(t4); its root constants one block of push constants.
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRootConstants(1, PARAMS_SIZE, NriStage.AllGraphics);
            layoutDesc.addRootDescriptor(0, NriDescriptorType.ConstantBuffer, NriStage.AllGraphics);
            for (let t = 0; t < 5; t++) {
                layoutDesc.addRootDescriptor(t, NriDescriptorType.StructuredBuffer, NriStage.AllGraphics);
            }
            this.pipelineLayout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The sample's pipeline state: the default rasterizer state (back faces culled), blend
            // state (opaque) and depth state (less, writes).
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/meshlet_instancing/${folder}/meshlet_instancing`;
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Mesh, `${shaders}_main_ms.bin`, "main_ms") != 0;
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
                console.log("Cannot load the meshlet instancing shaders");
                return 0;
            }

            // The constants, a queued frame's each; the depth buffer.
            const constantBuffer = device.createHostBuffer(queuedFrameNum * CONSTANTS_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const depthCreated = this.createDepth(device);
            if (!constantBuffer || !depthCreated) {
                console.log("Cannot create the constant buffer and depth buffer");
                return 0;
            }
            this.constantBufferView = constantBuffer.createConstantView(0, CONSTANTS_SIZE);

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
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // Model::LoadFromFile and UploadGpuResources: each mesh's vertices, meshlets, unique vertex
        // indices and primitives in buffers for the mesh shader (the byte address buffers' structures
        // 4 bytes: raw views), its subsets and their pack counts.
        loadModel(device: NriDevice): boolean {
            const file = NriFile.load(MESH_FILE);
            if (!file) {
                console.log(`Cannot load ${MESH_FILE} (the sample's model: build with DIRECTX_GRAPHICS_SAMPLES_DIR set)`);
                return false;
            }
            const model = MeshletModel.load(file.getData(), file.getSize());
            file.destroy();
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
                this.addBuffer(mesh, device.createUploadedStructuredBufferFromPointer(this.queue, model.getVertexBufferData(i, 0),
                    model.getVertexBufferSize(i, 0), 4));
                this.addBuffer(mesh, device.createUploadedStructuredBufferFromPointer(this.queue,
                    model.getData(i, MeshletModelData.Meshlets), meshletCount * MESHLET_STRIDE, MESHLET_STRIDE));
                // The unique vertex indices, rounded up to whole uints, as the sample's buffer.
                const uniqueSize = model.getDataSize(i, MeshletModelData.UniqueVertexIndices);
                const uniqueInts = Math.floor((uniqueSize + 3) / 4);
                const unique: int[] = [];
                for (let j = 0; j < uniqueInts; j++) {
                    unique.push(0);
                }
                model.copyData(i, MeshletModelData.UniqueVertexIndices, Ref(unique[0]));
                this.addBuffer(mesh, device.createUploadedStructuredBufferFromInts(this.queue, Ref(unique[0]), uniqueInts * 4, 4));
                const primitiveCount = model.getDataCount(i, MeshletModelData.PrimitiveIndices);
                this.addBuffer(mesh, device.createUploadedStructuredBufferFromPointer(this.queue,
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
        addBuffer(mesh: GpuMesh, buffer: NriBuffer | null) {
            if (!buffer) {
                return;
            }
            mesh.buffers.push(buffer);
            const view = buffer.createStructuredView(0);
            if (view) {
                mesh.views.push(view);
            }
        }

        // RegenerateInstances: the instances in a cube growing with the level, a bounding sphere's
        // diameter apart, written into the instance buffer (made larger when they don't fit) once the
        // GPU is done with it; false if it can't be made.
        regenerateInstances(device: NriDevice): boolean {
            const spacing = Math.fround(Math.fround(1.0 * this.radius) * 2.0);
            const width = this.instanceLevel * 2 + 1;
            const extents = Math.fround(spacing * this.instanceLevel);
            this.instanceCount = width * width * width;

            device.waitIdle();
            if (this.instanceCount > this.instanceCapacity) {
                this.destroyInstanceBuffer();
                this.instanceCapacity = this.instanceCount;
                const buffer = device.createHostBufferWithStride(this.instanceCapacity * INSTANCE_STRIDE, NriBufferUsage.StructuredBuffer,
                    INSTANCE_STRIDE);
                if (!buffer) {
                    return false;
                }
                this.instanceBuffer = buffer;
                this.instanceView = buffer.createStructuredView(0);
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
            instanceBuffer.write(0, Ref(data[0]), this.instanceCount * INSTANCE_STRIDE);
            return true;
        }

        destroyInstanceBuffer() {
            const instanceView = this.instanceView;
            if (instanceView) {
                instanceView.destroy();
            }
            const instanceBuffer = this.instanceBuffer;
            if (instanceBuffer) {
                instanceBuffer.destroy();
            }
            this.instanceView = null;
            this.instanceBuffer = null;
        }

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // OnKeyDown: + and - change the instance level, Space switches the meshlet colors.
        onKeys(device: NriDevice) {
            if (this.sample.isKeyToggled(NriKey.Equal) != 0 || this.sample.isKeyToggled(NriKey.KpAdd) != 0) {
                this.instanceLevel++;
                this.regenerateInstances(device);
            }
            if (this.sample.isKeyToggled(NriKey.Minus) != 0 || this.sample.isKeyToggled(NriKey.KpSubtract) != 0) {
                if (this.instanceLevel != 0) {
                    this.instanceLevel--;
                    this.regenerateInstances(device);
                }
            }
            if (this.sample.isKeyToggled(NriKey.Space) != 0) {
                this.drawMeshlets = !this.drawMeshlets;
            }
        }

        // OnUpdate: the keys, the camera (in test mode 1/60 second a frame, as Donut's test mode),
        // then the constants for its view: a 60 degree perspective (near 1, far 10000).
        update(device: NriDevice, constantsOffset: int, constantBuffer: NriBuffer) {
            if (!this.test) {
                this.onKeys(device);
            }
            for (const key of CAMERA_KEYS) {
                this.camera.onKey(key, this.sample.isKeyPressed(key) != 0);
            }
            this.camera.update(Math.fround(this.test ? 1.0 / 60.0 : this.sample.getFrameTime()));
            this.sample.setWindowTitle(`${WINDOW_TITLE} (${this.instanceCount} instances)`);

            const view = this.camera.viewMatrix();
            const proj = matrixPerspectiveFovRH(Math.fround(XM_PI / 3.0), Math.fround(this.width / this.height), 1.0, 10000.0);
            const viewT = matrixTranspose(view);
            const viewProjT = matrixTranspose(matrixMultiply(view, proj));
            for (let i = 0; i < 16; i++) {
                this.constants[i] = viewT[i];
                this.constants[16 + i] = viewProjT[i];
            }
            Nri.storeInt32(Ref(this.constants[DRAW_MESHLETS_INDEX]), this.drawMeshlets ? 1 : 0);
            constantBuffer.write(constantsOffset, Ref(this.constants[0]), CONSTANT_FLOATS * 4);
        }

        // PopulateCommandList's draws: per mesh and subset, the instances in batches of at most
        // 65536 groups (between NriCommandBuffer.beginRendering and NriCommandBuffer.endRendering).
        recordDraw(commandBuffer: NriCommandBuffer, constantsOffset: int) {
            const pipelineLayout = this.pipelineLayout;
            const pipeline = this.pipeline;
            const constantBufferView = this.constantBufferView;
            const instanceView = this.instanceView;
            if (!pipelineLayout || !pipeline || !constantBufferView || !instanceView) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(pipelineLayout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setRootDescriptor(0, constantBufferView, constantsOffset);
            commandBuffer.setRootDescriptor(5, instanceView, 0);
            for (const mesh of this.meshes) {
                for (let t = 0; t < 4; t++) {
                    commandBuffer.setRootDescriptor(1 + t, mesh.views[t], 0);
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
                        Nri.storeInt32(Ref(this.params[0]), instanceCount);
                        Nri.storeInt32(Ref(this.params[1]), instanceOffset);
                        Nri.storeInt32(Ref(this.params[2]), mesh.indexSize);
                        Nri.storeInt32(Ref(this.params[3]), subsetCount);
                        Nri.storeInt32(Ref(this.params[4]), subsetOffset);
                        const groupCount: int = Math.ceil(Math.fround(groupsPerInstance * instanceCount));
                        commandBuffer.setRootConstants(0, Ref(this.params[0]), PARAMS_SIZE);
                        commandBuffer.drawMeshTasks(groupCount, 1, 1);
                    }
                }
            }
        }

        // The swap chain's size and formats (its views in the textures' format).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
        }

        // The depth buffer at the swap chain's size; false on failure.
        createDepth(device: NriDevice): boolean {
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
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

        // The window was resized (NriSample.useResizableWindow): the swap chain (and what has the window's
        // size) made again at its size, once the GPU is done with the old ones.
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
            const constantsOffset = queuedFrameIndex * CONSTANTS_SIZE;
            const device = this.device;
            const constantBuffer = this.constantBuffer;
            const depthAttachment = this.depthAttachment;
            if (!device || !constantBuffer || !depthAttachment) {
                return;
            }
            this.update(device, constantsOffset, constantBuffer);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: cleared, the robots.
                commandBuffer.begin();
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
                commandBuffer.clearColor(CLEAR_R, CLEAR_G, CLEAR_B, 1.0);
                commandBuffer.clearDepth(1.0);
                this.recordDraw(commandBuffer, constantsOffset);
                commandBuffer.endRendering();

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
                for (const mesh of this.meshes) {
                    for (const view of mesh.views) {
                        view.destroy();
                    }
                    for (const buffer of mesh.buffers) {
                        buffer.destroy();
                    }
                }
                this.destroyInstanceBuffer();
                const constantBufferView = this.constantBufferView;
                if (constantBufferView) {
                    constantBufferView.destroy();
                }
                const constantBuffer = this.constantBuffer;
                if (constantBuffer) {
                    constantBuffer.destroy();
                }
                this.destroyDepth();
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    readbackBuffer.destroy();
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
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const meshletInstancing = new MeshletInstancing(sample);
        return meshletInstancing.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return MeshletInstancingNri.main(argc, argv);
}
